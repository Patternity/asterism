/**
 * Trash, over the real channel and the real database.
 *
 * What is protected here is two things at once. A person must be able to put a
 * Node or a project out of sight and bring it back with nothing lost. And
 * nothing in Trash may take work -- not from a route that forgot to check, not
 * from a page that was open before the tombstone, not from a command queued
 * while the Node was away, and not from a request that raced the tombstone by a
 * millisecond.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { hashPassword, SESSION_COOKIE } from '../../src/auth.js';
import { loadConfig } from '../../src/config.js';
import { createPool, migrate, rollbackAll, type Pool } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { NodeChannel } from '../../src/node-channel.js';
import { nodesRepo, projectsRepo } from '../../src/repositories.js';
import { PROVISIONING_CAPABILITIES, TestNode, createNodeKeys } from '../support/test-node.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://asterism:asterism@127.0.0.1:55432/asterism_cp';
const ORIGIN = 'http://console.test';
const PASSWORD = 'correct horse battery staple';
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A Node that can put a project's worker to sleep and wake it. */
const SUSPENDABLE = {
  ...PROVISIONING_CAPABILITIES,
  projects: {
    ...PROVISIONING_CAPABILITIES.projects,
    suspension: true,
    suspension_command_version: 1,
  },
};

/** A build that predates the command: node-2's situation. */
const LEGACY = { ...PROVISIONING_CAPABILITIES };

let pool: Pool;
let app: FastifyInstance;
let channel: NodeChannel;
let passwordHash: string;
let baseUrl: string;
const open: TestNode[] = [];

interface Session {
  cookie: string;
  csrf: string;
  userId: string;
}

async function owner(): Promise<Session> {
  const userId = randomUUID();
  const email = `owner-${userId}@example.com`;
  await pool.query(
    `INSERT INTO users (user_id, normalized_email, display_name, password_hash)
     VALUES ($1, $2, 'Owner', $3)`,
    [userId, email, passwordHash],
  );
  await pool.query(
    `INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')`,
    ['org_bootstrap', userId],
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN },
    payload: { email, password: PASSWORD },
  });
  const cookies = response.headers['set-cookie'];
  const cookie = (Array.isArray(cookies) ? cookies : [cookies ?? '']).find((value) =>
    value.startsWith(`${SESSION_COOKIE}=`),
  )!;
  return { cookie: cookie.split(';')[0]!, csrf: response.json().csrf_token as string, userId };
}

const write = (session: Session) => ({
  cookie: session.cookie,
  origin: ORIGIN,
  'x-csrf-token': session.csrf,
});

async function post(session: Session, url: string, payload: unknown = {}) {
  return app.inject({ method: 'POST', url, headers: write(session), payload });
}

async function get(session: Session, url: string) {
  return app.inject({ method: 'GET', url, headers: { cookie: session.cookie } });
}

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 100 && !done(value); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  return value;
}

/** A Node row, and optionally a live session for it. */
async function node(
  suffix: string,
  capabilities: Record<string, unknown> = SUSPENDABLE,
  connect = true,
) {
  const keys = createNodeKeys();
  const nodeId = `node-${suffix}-${randomUUID().slice(0, 8)}`;
  await nodesRepo.create(pool, {
    nodeId,
    displayName: `Node ${suffix}`,
    publicKey: keys.publicKeyBase64,
    fingerprint: keys.fingerprint,
    organizationId: 'org_bootstrap',
  });
  await pool.query('UPDATE nodes SET capabilities = $2::jsonb WHERE node_id = $1', [
    nodeId,
    JSON.stringify(capabilities),
  ]);
  if (!connect) return { nodeId, keys, live: null as TestNode | null };
  const live = await TestNode.connect(baseUrl, nodeId, keys, capabilities);
  open.push(live);
  await live.waitForCommand('capabilities.get');
  return { nodeId, keys, live: live as TestNode | null };
}

async function project(nodeId: string, name: string) {
  const created = await projectsRepo.upsert(pool, {
    nodeId,
    nodeProjectId: `local-${name}-${randomUUID().slice(0, 6)}`,
    displayName: name,
    enabled: true,
    metadata: { runtime_state: 'ready' },
  });
  // What a project on its credential and model looks like, so a trash and a
  // restore can be shown not to move either.
  await pool.query(
    `UPDATE projects SET credential_id = 'cred-0011aabbccddeeff', model = 'model-a',
            model_selection_state = 'applied' WHERE project_id = $1`,
    [created.project_id],
  );
  return (await projectsRepo.byId(pool, created.project_id))!;
}

async function run(projectId: string, nodeId: string, status: string) {
  const runId = randomUUID();
  await pool.query(
    `INSERT INTO runs (run_id, node_id, project_id, status, organization_id)
     VALUES ($1, $2, $3, $4, 'org_bootstrap')`,
    [runId, nodeId, projectId, status],
  );
  return runId;
}

const row = async (projectId: string) => (await projectsRepo.byId(pool, projectId))!;
const nodeRow = async (nodeId: string) => (await nodesRepo.byId(pool, nodeId))!;

async function count(sql: string, params: unknown[]): Promise<number> {
  return Number(
    (await pool.query<{ n: string }>(`SELECT count(*) AS n FROM (${sql}) q`, params)).rows[0]!.n,
  );
}

const commandsOf = (nodeId: string, type: string) =>
  count(`SELECT 1 FROM remote_commands WHERE node_id = $1 AND command_type = $2`, [nodeId, type]);

beforeAll(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL,
    PUBLIC_BASE_URL: 'http://127.0.0.1:8080',
    ALLOWED_ORIGINS: ORIGIN,
    ALLOW_PLAINTEXT: 'true',
    OPERATOR_COMPATIBILITY: 'false',
    LOG_LEVEL: 'fatal',
  } as NodeJS.ProcessEnv);
  pool = createPool(DATABASE_URL, 8);
  await migrate(pool);
  await rollbackAll(pool);
  await migrate(pool);
  passwordHash = await hashPassword(PASSWORD);
  channel = new NodeChannel(pool, config, createLogger('fatal'));
  channel.start();
  app = await buildApp({ pool, config, log: createLogger('fatal'), channel });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const live of open) await live.close().catch(() => undefined);
  await app?.close();
  await channel?.stop();
  await pool?.end();
});

beforeEach(async () => {
  for (const live of open.splice(0)) await live.close().catch(() => undefined);
});

// ------------------------------------------------------------------ projects

describe('a project in Trash', () => {
  it('leaves every active view, sits under its Node in Trash, and keeps everything', async () => {
    const session = await owner();
    const host = await node('proj');
    const kept = await project(host.nodeId, 'Kept');
    const trashed = await project(host.nodeId, 'Trashed');
    const history = await run(trashed.project_id, host.nodeId, 'completed');

    const response = await post(session, `/api/v1/projects/${trashed.project_id}/trash`);
    expect(response.statusCode).toBe(200);
    expect(response.json().outcome).toBe('trashed');
    expect(response.json().project.trash).toMatchObject({
      trashed: true,
      inherited: false,
      effective: true,
      worker: 'stopping',
    });

    // Its worker is put to sleep by its Node, and believed only when it says so.
    const suspend = await host.live!.waitForCommand('project.suspend');
    host.live!.completeCommand(suspend.command_id, { suspended: true, worker: 'stopped' });
    await eventually(
      () => row(trashed.project_id),
      (p) => p.worker_lifecycle === 'stopped',
    );

    // Gone from every ordinary view.
    const projects = (await get(session, '/api/v1/projects')).json().projects as {
      project_id: string;
    }[];
    expect(projects.map((p) => p.project_id)).toContain(kept.project_id);
    expect(projects.map((p) => p.project_id)).not.toContain(trashed.project_id);
    const runs = (await get(session, '/api/v1/runs')).json().runs as { run_id: string }[];
    expect(runs.map((r) => r.run_id)).not.toContain(history);
    const detail = (await get(session, `/api/v1/nodes/${host.nodeId}`)).json();
    expect(detail.projects.map((p: { project_id: string }) => p.project_id)).not.toContain(
      trashed.project_id,
    );

    // In Trash, under its Node, which is shown only as its context.
    const tree = (await get(session, '/api/v1/trash')).json().nodes as {
      node_id: string;
      role: string;
      projects: { project_id: string; trash: { trashed: boolean; inherited: boolean } }[];
    }[];
    const branch = tree.find((entry) => entry.node_id === host.nodeId)!;
    expect(branch.role).toBe('context');
    expect(branch.projects).toEqual([
      expect.objectContaining({
        project_id: trashed.project_id,
        trash: expect.objectContaining({ trashed: true, inherited: false }),
      }),
    ]);

    // Everything it had is where it was, and still readable by id.
    const after = await row(trashed.project_id);
    expect(after.credential_id).toBe('cred-0011aabbccddeeff');
    expect(after.model).toBe('model-a');
    expect(after.node_project_id).toBe(trashed.node_project_id);
    expect((await get(session, `/api/v1/runs/${history}`)).statusCode).toBe(200);
    expect(
      (await get(session, `/api/v1/projects/${trashed.project_id}`)).json().project.trash.trashed,
    ).toBe(true);
    expect(
      await count(`SELECT 1 FROM audit_log WHERE action = 'project.trash' AND target_id = $1`, [
        trashed.project_id,
      ]),
    ).toBe(1);
  });

  it('refuses new work before anything durable exists', async () => {
    const session = await owner();
    const host = await node('refuse');
    const target = await project(host.nodeId, 'Refused');
    await post(session, `/api/v1/projects/${target.project_id}/trash`);
    const runsBefore = await count(`SELECT 1 FROM runs WHERE project_id = $1`, [target.project_id]);
    const commandsBefore = await count(
      `SELECT 1 FROM remote_commands WHERE project_id = $1 AND command_type <> 'project.suspend'`,
      [target.project_id],
    );

    for (const [method, url, payload] of [
      ['POST', `/api/v1/projects/${target.project_id}/runs`, { input: 'hello' }],
      ['PUT', `/api/v1/projects/${target.project_id}/model`, { model: 'model-a' }],
      ['PUT', `/api/v1/projects/${target.project_id}/credential`, { credential_id: null }],
    ] as const) {
      const response = await app.inject({ method, url, headers: write(session), payload });
      expect(response.statusCode, `${method} ${url}`).toBe(409);
      expect(response.json().error).toBe('project_trashed');
    }
    expect(await count(`SELECT 1 FROM runs WHERE project_id = $1`, [target.project_id])).toBe(
      runsBefore,
    );
    expect(
      await count(
        `SELECT 1 FROM remote_commands WHERE project_id = $1 AND command_type <> 'project.suspend'`,
        [target.project_id],
      ),
    ).toBe(commandsBefore);
  });

  it('is refused while a run is in progress, and nothing changes', async () => {
    const session = await owner();
    const host = await node('busy');
    const target = await project(host.nodeId, 'Busy');
    await run(target.project_id, host.nodeId, 'waiting_for_approval');

    const response = await post(session, `/api/v1/projects/${target.project_id}/trash`);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('project_runs_active');
    const after = await row(target.project_id);
    expect(after.trashed_at).toBeNull();
    expect(after.worker_lifecycle).toBeNull();
    expect(await commandsOf(host.nodeId, 'project.suspend')).toBe(0);
    expect(await count(`SELECT 1 FROM audit_log WHERE target_id = $1`, [target.project_id])).toBe(
      0,
    );
  });

  it('returns to operation only once its worker is proven serving', async () => {
    const session = await owner();
    const host = await node('restore');
    const target = await project(host.nodeId, 'Back');
    await post(session, `/api/v1/projects/${target.project_id}/trash`);
    host.live!.completeCommand((await host.live!.waitForCommand('project.suspend')).command_id, {
      worker: 'stopped',
    });
    await eventually(
      () => row(target.project_id),
      (p) => p.worker_lifecycle === 'stopped',
    );

    const restored = await post(session, `/api/v1/projects/${target.project_id}/restore`);
    expect(restored.statusCode).toBe(200);
    expect(restored.json().outcome).toBe('restored');
    // Restored, and honest that the worker is still on its way.
    expect(restored.json().project.trash).toMatchObject({ effective: false, worker: 'starting' });

    const resume = await host.live!.waitForCommand('project.resume');
    host.live!.completeCommand(resume.command_id, { worker: 'running' });
    await eventually(
      () => row(target.project_id),
      (p) => p.worker_lifecycle === 'running',
    );

    const after = await row(target.project_id);
    expect(after.trashed_at).toBeNull();
    expect(after.credential_id).toBe('cred-0011aabbccddeeff');
    expect(after.model).toBe('model-a');
    const projects = (await get(session, '/api/v1/projects')).json().projects as {
      project_id: string;
    }[];
    expect(projects.map((p) => p.project_id)).toContain(target.project_id);
    expect(
      await count(`SELECT 1 FROM audit_log WHERE action = 'project.restore' AND target_id = $1`, [
        target.project_id,
      ]),
    ).toBe(1);
  });

  it('reports a worker that would not stop, and stays in Trash', async () => {
    const session = await owner();
    const host = await node('stubborn');
    const target = await project(host.nodeId, 'Stubborn');
    await post(session, `/api/v1/projects/${target.project_id}/trash`);
    host.live!.refuseCommand(
      (await host.live!.waitForCommand('project.suspend')).command_id,
      'command_failed',
      'worker_stop_failed: the worker did not reach the state asked for',
    );
    const after = await eventually(
      () => row(target.project_id),
      (p) => p.worker_lifecycle === 'stop_failed',
    );
    expect(after.worker_lifecycle).toBe('stop_failed');
    expect(after.trashed_at).not.toBeNull();
  });

  it('reports a worker that would not wake, and lets the restore be asked again', async () => {
    const session = await owner();
    const host = await node('sleepy');
    const target = await project(host.nodeId, 'Sleepy');
    await post(session, `/api/v1/projects/${target.project_id}/trash`);
    host.live!.completeCommand((await host.live!.waitForCommand('project.suspend')).command_id, {
      worker: 'stopped',
    });
    await post(session, `/api/v1/projects/${target.project_id}/restore`);
    host.live!.refuseCommand(
      (await host.live!.waitForCommand('project.resume')).command_id,
      'command_failed',
      'worker_unhealthy: the worker did not reach the state asked for',
    );
    await eventually(
      () => row(target.project_id),
      (p) => p.worker_lifecycle === 'start_failed',
    );

    const again = await post(session, `/api/v1/projects/${target.project_id}/restore`);
    expect(again.json().outcome).toBe('retried');
    await host.live!.waitForCommand('project.resume', 5_000, 1);
  });

  it('treats a repeated trash or restore as the same answer', async () => {
    const session = await owner();
    const host = await node('repeat');
    const target = await project(host.nodeId, 'Twice');
    expect(
      (await post(session, `/api/v1/projects/${target.project_id}/trash`)).json().outcome,
    ).toBe('trashed');
    const first = (await row(target.project_id)).trashed_at;
    expect(
      (await post(session, `/api/v1/projects/${target.project_id}/trash`)).json().outcome,
    ).toBe('unchanged');
    expect((await row(target.project_id)).trashed_at).toEqual(first);
    expect(await commandsOf(host.nodeId, 'project.suspend')).toBe(1);

    expect(
      (await post(session, `/api/v1/projects/${target.project_id}/restore`)).json().outcome,
    ).toBe('restored');
    expect(
      (await post(session, `/api/v1/projects/${target.project_id}/restore`)).json().outcome,
    ).toBe('unchanged');
    expect(await count(`SELECT 1 FROM audit_log WHERE target_id = $1`, [target.project_id])).toBe(
      2,
    );
  });

  it('says a runtime its Node does not own was left alone', async () => {
    const session = await owner();
    const host = await node('external');
    const target = await project(host.nodeId, 'Outside');
    await post(session, `/api/v1/projects/${target.project_id}/trash`);
    host.live!.completeCommand((await host.live!.waitForCommand('project.suspend')).command_id, {
      worker: 'not_managed',
    });
    await eventually(
      () => row(target.project_id),
      (p) => p.worker_lifecycle === 'not_managed',
    );
  });

  it('asks a legacy Node nothing and claims nothing about its host', async () => {
    const session = await owner();
    const host = await node('legacy', LEGACY);
    const target = await project(host.nodeId, 'Old');
    const response = await post(session, `/api/v1/projects/${target.project_id}/trash`);
    expect(response.json().project.trash.worker).toBe('unsupported');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await commandsOf(host.nodeId, 'project.suspend')).toBe(0);
    // The tombstone still keeps work away.
    const refused = await post(session, `/api/v1/projects/${target.project_id}/runs`, {
      input: 'x',
    });
    expect(refused.json().error).toBe('project_trashed');
  });

  it("queues an offline Node's worker change and says it is on its way", async () => {
    const session = await owner();
    const host = await node('away', SUSPENDABLE, false);
    const target = await project(host.nodeId, 'Away');
    const response = await post(session, `/api/v1/projects/${target.project_id}/trash`);
    expect(response.json().project.trash.worker).toBe('stopping');

    const live = await TestNode.connect(baseUrl, host.nodeId, host.keys, SUSPENDABLE);
    open.push(live);
    const suspend = await live.waitForCommand('project.suspend');
    live.completeCommand(suspend.command_id, { worker: 'stopped' });
    await eventually(
      () => row(target.project_id),
      (p) => p.worker_lifecycle === 'stopped',
    );
  });
});

// --------------------------------------------------------------------- Nodes

describe('a Node in Trash', () => {
  it('takes its whole branch out of sight without rewriting any child', async () => {
    const session = await owner();
    const host = await node('branch');
    const child = await project(host.nodeId, 'Child');
    const independent = await project(host.nodeId, 'Independent');
    await post(session, `/api/v1/projects/${independent.project_id}/trash`);
    host.live!.completeCommand((await host.live!.waitForCommand('project.suspend')).command_id, {
      worker: 'stopped',
    });
    const independentTombstone = (await row(independent.project_id)).trashed_at;

    const response = await post(session, `/api/v1/nodes/${host.nodeId}/trash`);
    expect(response.statusCode).toBe(200);
    expect(response.json().outcome).toBe('trashed');

    // One more suspension -- for the child that was still awake -- and no more.
    const second = await host.live!.waitForCommand('project.suspend', 5_000, 1);
    expect(second.project_id).toBe(child.node_project_id);
    host.live!.completeCommand(second.command_id, { worker: 'stopped' });

    // The child's own row is untouched; it is in Trash only through its Node.
    expect((await row(child.project_id)).trashed_at).toBeNull();
    // And it takes no work for that reason, named as that reason.
    const refused = await post(session, `/api/v1/projects/${child.project_id}/runs`, {
      input: 'x',
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('node_trashed');
    expect(
      (await get(session, `/api/v1/projects/${child.project_id}`)).json().project.can_run,
    ).toBe(false);
    expect((await row(independent.project_id)).trashed_at).toEqual(independentTombstone);

    const nodes = (await get(session, '/api/v1/nodes')).json().nodes as { node_id: string }[];
    expect(nodes.map((n) => n.node_id)).not.toContain(host.nodeId);
    const projects = (await get(session, '/api/v1/projects')).json().projects as {
      project_id: string;
    }[];
    expect(projects.map((p) => p.project_id)).not.toContain(child.project_id);

    const tree = (await get(session, '/api/v1/trash')).json().nodes as {
      node_id: string;
      role: string;
      projects: { project_id: string; trash: { trashed: boolean; inherited: boolean } }[];
    }[];
    const branch = tree.find((entry) => entry.node_id === host.nodeId)!;
    expect(branch.role).toBe('trashed');
    const byId = Object.fromEntries(branch.projects.map((p) => [p.project_id, p.trash]));
    expect(byId[child.project_id]).toMatchObject({ trashed: false, inherited: true });
    expect(byId[independent.project_id]).toMatchObject({ trashed: true, inherited: true });
  });

  it('restores only what was not put in Trash on its own', async () => {
    const session = await owner();
    const host = await node('restore-branch');
    const child = await project(host.nodeId, 'Child');
    const independent = await project(host.nodeId, 'Independent');
    await post(session, `/api/v1/projects/${independent.project_id}/trash`);
    // Trashed while the independent child's worker is still being put to
    // sleep: that is not work the Node's trash interrupts.
    expect((await post(session, `/api/v1/nodes/${host.nodeId}/trash`)).json().outcome).toBe(
      'trashed',
    );

    const response = await post(session, `/api/v1/nodes/${host.nodeId}/restore`);
    expect(response.json()).toMatchObject({
      outcome: 'restored',
      projects_restored: 1,
      projects_kept_in_trash: 1,
    });

    const resume = await host.live!.waitForCommand('project.resume');
    expect(resume.project_id).toBe(child.node_project_id);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await commandsOf(host.nodeId, 'project.resume')).toBe(1);

    expect((await row(independent.project_id)).trashed_at).not.toBeNull();
    const projects = (await get(session, '/api/v1/projects')).json().projects as {
      project_id: string;
    }[];
    expect(projects.map((p) => p.project_id)).toContain(child.project_id);
    expect(projects.map((p) => p.project_id)).not.toContain(independent.project_id);
  });

  it('refuses to restore a project on its own while its Node is in Trash', async () => {
    const session = await owner();
    const host = await node('locked');
    const target = await project(host.nodeId, 'Locked');
    await post(session, `/api/v1/projects/${target.project_id}/trash`);
    expect((await post(session, `/api/v1/nodes/${host.nodeId}/trash`)).json().outcome).toBe(
      'trashed',
    );
    const tombstone = (await row(target.project_id)).trashed_at;

    const response = await post(session, `/api/v1/projects/${target.project_id}/restore`);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('node_trashed');
    expect((await row(target.project_id)).trashed_at).toEqual(tombstone);
  });

  it('is refused while an update is in progress, and nothing changes', async () => {
    const session = await owner();
    const host = await node('updating');
    await pool.query(
      `INSERT INTO node_update_operations (operation_id, organization_id, node_id, requested_version, stage)
       VALUES ($1, 'org_bootstrap', $2, 'v9', 'applying')`,
      [randomUUID(), host.nodeId],
    );
    const response = await post(session, `/api/v1/nodes/${host.nodeId}/trash`);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('update_in_progress');
    expect((await nodeRow(host.nodeId)).trashed_at).toBeNull();
  });

  it('is refused while any project on it is running', async () => {
    const session = await owner();
    const host = await node('running');
    const target = await project(host.nodeId, 'Working');
    await run(target.project_id, host.nodeId, 'running');
    const response = await post(session, `/api/v1/nodes/${host.nodeId}/trash`);
    expect(response.json().error).toBe('project_runs_active');
    expect((await nodeRow(host.nodeId)).trashed_at).toBeNull();
    expect(await commandsOf(host.nodeId, 'project.suspend')).toBe(0);
  });

  it('refuses every Node route and dispatches nothing queued before it', async () => {
    const session = await owner();
    const host = await node('closed');
    // Queued while the Node was busy, before anybody trashed it.
    await pool.query(
      `INSERT INTO remote_commands (command_id, node_id, command_type, request_payload, payload_digest,
                                    state, organization_id)
       VALUES ($1, $2, 'node.drain', '{}'::jsonb, 'd', 'queued', 'org_bootstrap')`,
      [`cmd-${randomUUID()}`, host.nodeId],
    );
    // Held back from dispatch until the tombstone is in place.
    await pool.query(`UPDATE nodes SET trashed_at = now() WHERE node_id = $1`, [host.nodeId]);

    const refused = await post(session, `/api/v1/nodes/${host.nodeId}/drain`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('node_trashed');

    const rejected = await eventually(
      () =>
        count(
          `SELECT 1 FROM remote_commands WHERE node_id = $1 AND command_type = 'node.drain'
            AND state = 'rejected' AND error_code = 'node_trashed'`,
          [host.nodeId],
        ),
      (n) => n === 1,
    );
    expect(rejected).toBe(1);
    expect(host.live!.commands.some((c) => c.command === 'node.drain')).toBe(false);
  });

  it('keeps identity, enrollment and history across trash and restore', async () => {
    const session = await owner();
    const host = await node('identity');
    const target = await project(host.nodeId, 'History');
    const history = await run(target.project_id, host.nodeId, 'completed');
    const before = await nodeRow(host.nodeId);

    await post(session, `/api/v1/nodes/${host.nodeId}/trash`);
    await post(session, `/api/v1/nodes/${host.nodeId}/restore`);

    const after = await nodeRow(host.nodeId);
    for (const field of [
      'fingerprint',
      'public_key',
      'identity_generation',
      'owner_user_id',
    ] as const) {
      expect(after[field]).toEqual(before[field]);
    }
    expect(after.enrolled_at).toEqual(before.enrolled_at);
    expect(after.revoked_at).toBeNull();
    expect(await count(`SELECT 1 FROM runs WHERE run_id = $1`, [history])).toBe(1);
    expect(
      await count(
        `SELECT 1 FROM audit_log WHERE target_id = $1 AND action IN ('node.trash','node.restore')`,
        [host.nodeId],
      ),
    ).toBe(2);
  });

  it('asks a Node in Trash nothing when it reconnects', async () => {
    const session = await owner();
    const host = await node('reconnect');
    await post(session, `/api/v1/nodes/${host.nodeId}/trash`);
    await host.live!.close();
    const before = await count(
      `SELECT 1 FROM remote_commands WHERE node_id = $1 AND command_type <> 'project.suspend'`,
      [host.nodeId],
    );

    const again = await TestNode.connect(baseUrl, host.nodeId, host.keys, SUSPENDABLE);
    open.push(again);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(
      await count(
        `SELECT 1 FROM remote_commands WHERE node_id = $1 AND command_type <> 'project.suspend'`,
        [host.nodeId],
      ),
    ).toBe(before);
    expect(again.commands.filter((c) => c.command !== 'project.suspend')).toEqual([]);

    // Restored, it is asked again at once.
    await post(session, `/api/v1/nodes/${host.nodeId}/restore`);
    await again.waitForCommand('projects.list');
  });
});

// ------------------------------------------------------- the database's gate

describe('the database refuses work for anything in Trash', () => {
  it('whatever path the write took, except putting a worker to sleep', async () => {
    const host = await node('gate', SUSPENDABLE, false);
    const target = await project(host.nodeId, 'Gate');
    await pool.query(`UPDATE projects SET trashed_at = now() WHERE project_id = $1`, [
      target.project_id,
    ]);

    await expect(run(target.project_id, host.nodeId, 'queued')).rejects.toMatchObject({
      code: 'TR002',
    });
    const insert = (type: string, projectId: string | null) =>
      pool.query(
        `INSERT INTO remote_commands (command_id, node_id, project_id, command_type, request_payload,
                                      payload_digest, organization_id)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, 'd', 'org_bootstrap')`,
        [`cmd-${randomUUID()}`, host.nodeId, projectId, type],
      );
    await expect(insert('runs.create', target.project_id)).rejects.toMatchObject({ code: 'TR002' });
    await expect(insert('project.suspend', target.project_id)).resolves.toBeDefined();

    await pool.query(`UPDATE nodes SET trashed_at = now() WHERE node_id = $1`, [host.nodeId]);
    await expect(insert('capabilities.get', null)).rejects.toMatchObject({ code: 'TR001' });
  });

  /**
   * A run and a trash racing each other, many times. Whichever wins, the
   * outcome is never both: a project in Trash with a run that is not finished.
   */
  it('never lets a run and a trash both win', async () => {
    const session = await owner();
    const host = await node('race');
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const target = await project(host.nodeId, `Race ${attempt}`);
      await Promise.allSettled([
        post(session, `/api/v1/projects/${target.project_id}/trash`),
        run(target.project_id, host.nodeId, 'queued'),
      ]);
      const after = await row(target.project_id);
      const live = await count(
        `SELECT 1 FROM runs WHERE project_id = $1 AND status NOT IN ('completed','failed','cancelled','interrupted','lost')`,
        [target.project_id],
      );
      expect(Boolean(after.trashed_at) && live > 0, `attempt ${attempt}`).toBe(false);
    }
  });

  it('holds across a Control Plane restart', async () => {
    const host = await node('restart', SUSPENDABLE, false);
    const target = await project(host.nodeId, 'Restart');
    await pool.query(`UPDATE projects SET trashed_at = now() WHERE project_id = $1`, [
      target.project_id,
    ]);
    const restarted = createPool(DATABASE_URL, 2);
    try {
      await expect(
        restarted.query(
          `INSERT INTO runs (run_id, node_id, project_id, status, organization_id)
           VALUES ($1, $2, $3, 'queued', 'org_bootstrap')`,
          [randomUUID(), host.nodeId, target.project_id],
        ),
      ).rejects.toMatchObject({ code: 'TR002' });
    } finally {
      await restarted.end();
    }
  });
});

describe('leaving Trash behind', () => {
  /**
   * The down migration, applied to a database holding tombstones and undone
   * again inside one transaction, so the rest of the suite never notices.
   */
  it('drops the tombstones and keeps every row they were on', async () => {
    const session = await owner();
    const host = await node('down', SUSPENDABLE, false);
    const target = await project(host.nodeId, 'Down');
    await pool.query(
      `UPDATE projects SET trashed_at = now(), trashed_by_user_id = $2 WHERE project_id = $1`,
      [target.project_id, session.userId],
    );
    await pool.query(`UPDATE nodes SET trashed_at = now() WHERE node_id = $1`, [host.nodeId]);

    const down = await readFile(
      path.join(HERE, '../../migrations/019_hierarchical_trash.down.sql'),
      'utf8',
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(down);
      const columns = await client.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name IN ('nodes','projects') AND column_name LIKE 'trashed%'`,
      );
      expect(columns.rowCount).toBe(0);
      // The rows the tombstones were on are all still here.
      expect(
        (await client.query(`SELECT 1 FROM projects WHERE project_id = $1`, [target.project_id]))
          .rowCount,
      ).toBe(1);
      expect(
        (await client.query(`SELECT 1 FROM nodes WHERE node_id = $1`, [host.nodeId])).rowCount,
      ).toBe(1);
      // And work can be written again, because nothing marks it hidden.
      await client.query(
        `INSERT INTO runs (run_id, node_id, project_id, status, organization_id)
         VALUES ($1, $2, $3, 'completed', 'org_bootstrap')`,
        [randomUUID(), host.nodeId, target.project_id],
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    // Rolled back: the schema and the tombstones are exactly as they were.
    expect((await row(target.project_id)).trashed_at).not.toBeNull();
  });
});

/**
 * A run that failed is how a Node discovers a credential's grant has ended.
 *
 * The Node writes that down; nothing asked it afterwards, so the console went
 * on describing a dead credential as ready. A person then picked it for a
 * project and watched the next run fail for a reason the page had denied.
 */
describe('a failed run makes this Control Plane ask what the Node still holds', () => {
  async function runWithNodeId(nodeId: string, projectId: string) {
    const runId = randomUUID();
    await pool.query(
      `INSERT INTO runs (run_id, node_id, project_id, status, node_run_id, subscribed, organization_id)
       VALUES ($1, $2, $3, 'running', $4, TRUE, 'org_bootstrap')`,
      [runId, nodeId, projectId, `node-run-${runId.slice(0, 8)}`],
    );
    return (
      await pool.query<{ node_run_id: string }>('SELECT node_run_id FROM runs WHERE run_id = $1', [
        runId,
      ])
    ).rows[0]!.node_run_id;
  }

  it('asks once when a run ends badly, and not when one ends well', async () => {
    const host = await node('runfail');
    const target = await project(host.nodeId, 'Failing');
    const before = await commandsOf(host.nodeId, 'credentials.list');

    const nodeRunId = await runWithNodeId(host.nodeId, target.project_id);
    host.live!.sendEvent({
      project_id: target.node_project_id,
      run_id: nodeRunId,
      seq: 1,
      event_type: 'asterism.run.terminal',
      payload: { status: 'failed' },
    });

    const asked = await eventually(
      () => commandsOf(host.nodeId, 'credentials.list'),
      (n) => n > before,
    );
    expect(asked).toBe(before + 1);

    // Bounded: a second failure inside the interval costs nothing more.
    const second = await runWithNodeId(host.nodeId, target.project_id);
    host.live!.sendEvent({
      project_id: target.node_project_id,
      run_id: second,
      seq: 1,
      event_type: 'asterism.run.terminal',
      payload: { status: 'failed' },
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await commandsOf(host.nodeId, 'credentials.list')).toBe(asked);
  });
});
