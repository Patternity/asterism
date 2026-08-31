/**
 * The distributed contract: asking a Node to build a project, and believing it.
 *
 * The properties under test are the ones that fail quietly if they are wrong.
 * A project that becomes ready without a worker is routed to and then fails
 * every run; a result from an attempt the operator already retried past marks
 * the new attempt ready on the strength of the old one. Both are invisible
 * until someone tries to use the project.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPool, migrate, rollbackAll, type Pool } from '../../src/db.js';
import { nodesRepo, commandsRepo } from '../../src/repositories.js';
import { productProjectsRepo } from '../../src/product-repositories.js';
import { commandFingerprint } from '../../src/protocol.js';
import { PROVISION_COMMAND } from '../../src/project-provisioning.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://asterism:asterism@127.0.0.1:55432/asterism_cp';

let pool: Pool;

beforeAll(async () => {
  pool = createPool(DATABASE_URL, 4);
  await migrate(pool);
  await rollbackAll(pool).catch(() => undefined);
  await migrate(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query('DELETE FROM audit_log');
  await pool.query('DELETE FROM remote_commands');
  await pool.query('DELETE FROM projects');
  await pool.query('DELETE FROM nodes');
});

async function seedNode(suffix: string) {
  return nodesRepo.create(pool, {
    nodeId: `node-${suffix}`,
    displayName: `Node ${suffix}`,
    publicKey: suffix,
    fingerprint: suffix.padEnd(64, 'a').slice(0, 64),
    organizationId: 'org_bootstrap',
  });
}

async function seedProject(nodeId: string, slug: string) {
  return productProjectsRepo.createWithProvisionCommand(pool, {
    organizationId: 'org_bootstrap',
    projectId: `prj_${randomUUID().replace(/-/g, '')}`,
    nodeId,
    nodeProjectId: `np_${slug}`,
    displayName: `Project ${slug}`,
    slug,
    workspaceMode: 'empty',
    repositoryUrl: null,
    repositoryBranch: null,
    createdByUserId: null as unknown as string,
  });
}

describe('a project starts unbuilt', () => {
  it('is created pending at generation one, never ready', async () => {
    const node = await seedNode('a');
    const project = await seedProject(node.node_id, 'first');

    // Nothing has been built at this point, and the row must say so: a project
    // that claimed readiness here would be routed to before a worker exists.
    expect(project.provisioning_state).toBe('pending');
    expect(project.provisioning_generation).toBe(1);
    expect(project.available).toBe(false);
  });

  it('refuses a second project with the same slug in one organization', async () => {
    const node = await seedNode('a');
    await seedProject(node.node_id, 'taken');
    await expect(seedProject(node.node_id, 'taken')).rejects.toThrow();
  });
});

describe('only a current-generation success makes a project ready', () => {
  it('promotes on the attempt in flight', async () => {
    const node = await seedNode('a');
    const project = await seedProject(node.node_id, 'promote');

    const applied = await productProjectsRepo.markProvisioningReady(
      pool,
      'org_bootstrap',
      project.project_id,
      1,
    );
    expect(applied).toBe(true);

    const after = await productProjectsRepo.byId(pool, 'org_bootstrap', project.project_id);
    expect(after?.provisioning_state).toBe('ready');
    expect(after?.available).toBe(true);
  });

  it('ignores a success from an attempt the operator retried past', async () => {
    const node = await seedNode('a');
    const project = await seedProject(node.node_id, 'stale');
    await productProjectsRepo.markProvisioningFailed(
      pool,
      'org_bootstrap',
      project.project_id,
      1,
      'repository_clone_failed',
      'the repository could not be cloned',
    );
    const retried = await productProjectsRepo.beginRetry(pool, 'org_bootstrap', project.project_id);
    expect(retried?.provisioning_generation).toBe(2);

    // The first attempt's Node was still working when the retry started; its
    // success arrives now, carrying generation 1.
    const applied = await productProjectsRepo.markProvisioningReady(
      pool,
      'org_bootstrap',
      project.project_id,
      1,
    );
    expect(applied).toBe(false);

    const after = await productProjectsRepo.byId(pool, 'org_bootstrap', project.project_id);
    expect(after?.provisioning_state).toBe('pending');
  });

  it('is idempotent when the same success arrives twice', async () => {
    const node = await seedNode('a');
    const project = await seedProject(node.node_id, 'twice');

    expect(
      await productProjectsRepo.markProvisioningReady(pool, 'org_bootstrap', project.project_id, 1),
    ).toBe(true);
    expect(
      await productProjectsRepo.markProvisioningReady(pool, 'org_bootstrap', project.project_id, 1),
    ).toBe(true);

    const after = await productProjectsRepo.byId(pool, 'org_bootstrap', project.project_id);
    expect(after?.provisioning_state).toBe('ready');
  });

  it('never promotes a project an administrator disabled while it was building', async () => {
    const node = await seedNode('a');
    const project = await seedProject(node.node_id, 'disabled');
    await pool.query("UPDATE projects SET provisioning_state = 'disabled' WHERE project_id = $1", [
      project.project_id,
    ]);

    const applied = await productProjectsRepo.markProvisioningReady(
      pool,
      'org_bootstrap',
      project.project_id,
      1,
    );
    // An administrator's decision outranks a result that was already in the air
    // when it was made.
    expect(applied).toBe(false);
  });
});

describe('failures', () => {
  it('records a typed failure for the attempt in flight', async () => {
    const node = await seedNode('a');
    const project = await seedProject(node.node_id, 'failing');

    const applied = await productProjectsRepo.markProvisioningFailed(
      pool,
      'org_bootstrap',
      project.project_id,
      1,
      'profile_worker_unhealthy',
      'the project runtime did not become healthy',
    );
    expect(applied).toBe(true);

    const after = await productProjectsRepo.byId(pool, 'org_bootstrap', project.project_id);
    expect(after?.provisioning_state).toBe('failed');
    expect(after?.provisioning_failure).toBe('profile_worker_unhealthy');
    expect(after?.available).toBe(false);
  });

  it('cannot take a ready project offline with a late failure', async () => {
    const node = await seedNode('a');
    const project = await seedProject(node.node_id, 'late');
    await productProjectsRepo.markProvisioningReady(pool, 'org_bootstrap', project.project_id, 1);

    // The same attempt reporting a failure after its success has already been
    // accepted is stale news, and acting on it would take a working project down.
    const applied = await productProjectsRepo.markProvisioningFailed(
      pool,
      'org_bootstrap',
      project.project_id,
      1,
      'profile_worker_unhealthy',
      null,
    );
    expect(applied).toBe(false);

    const after = await productProjectsRepo.byId(pool, 'org_bootstrap', project.project_id);
    expect(after?.provisioning_state).toBe('ready');
  });

  it('ignores a failure aimed at an older attempt', async () => {
    const node = await seedNode('a');
    const project = await seedProject(node.node_id, 'older');
    await productProjectsRepo.markProvisioningFailed(
      pool,
      'org_bootstrap',
      project.project_id,
      1,
      'repository_clone_failed',
      null,
    );
    await productProjectsRepo.beginRetry(pool, 'org_bootstrap', project.project_id);

    const applied = await productProjectsRepo.markProvisioningFailed(
      pool,
      'org_bootstrap',
      project.project_id,
      1,
      'workspace_creation_failed',
      null,
    );
    expect(applied).toBe(false);

    const after = await productProjectsRepo.byId(pool, 'org_bootstrap', project.project_id);
    expect(after?.provisioning_state).toBe('pending');
    expect(after?.provisioning_failure).toBeNull();
  });
});

describe('retry', () => {
  it('only begins from a failed project', async () => {
    const node = await seedNode('a');
    const project = await seedProject(node.node_id, 'retry');

    // Pending: nothing has failed yet, so there is nothing to try again.
    expect(
      await productProjectsRepo.beginRetry(pool, 'org_bootstrap', project.project_id),
    ).toBeNull();

    await productProjectsRepo.markProvisioningReady(pool, 'org_bootstrap', project.project_id, 1);
    expect(
      await productProjectsRepo.beginRetry(pool, 'org_bootstrap', project.project_id),
    ).toBeNull();

    await pool.query(
      "UPDATE projects SET provisioning_state = 'failed', provisioning_failure = 'repository_clone_failed' WHERE project_id = $1",
      [project.project_id],
    );
    const retried = await productProjectsRepo.beginRetry(pool, 'org_bootstrap', project.project_id);
    expect(retried?.provisioning_generation).toBe(2);
    expect(retried?.provisioning_failure).toBeNull();
  });

  it('keeps the previous command as history rather than deleting it', async () => {
    const node = await seedNode('a');
    const project = await seedProject(node.node_id, 'history');
    const payload = { version: 1, project_id: project.project_id, provisioning_generation: 1 };
    const first = await commandsRepo.create(pool, {
      nodeId: node.node_id,
      projectId: project.project_id,
      commandType: PROVISION_COMMAND,
      payload,
      digest: commandFingerprint(PROVISION_COMMAND, project.node_project_id, payload),
    });

    await productProjectsRepo.markProvisioningFailed(
      pool,
      'org_bootstrap',
      project.project_id,
      1,
      'repository_clone_failed',
      null,
    );
    await productProjectsRepo.beginRetry(pool, 'org_bootstrap', project.project_id);

    // The old attempt stays readable: its events are inert because the
    // generation moved, not because the record was destroyed.
    expect(await commandsRepo.byId(pool, first.command_id)).not.toBeNull();
  });
});

describe("a project row never carries the Node's own decisions", () => {
  it('has no column for a path, port, profile or key', async () => {
    const node = await seedNode('a');
    const project = await seedProject(node.node_id, 'sanitized');
    const stored = await productProjectsRepo.byId(pool, 'org_bootstrap', project.project_id);
    const serialized = JSON.stringify(stored);

    for (const forbidden of [
      'workspace_path',
      'hermes_home',
      'hermes_profile',
      'hermes_api_key_ref',
      'runtime_endpoint',
      '/var/lib/asterism',
      '18642',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
