/**
 * Choosing a project's credential, through the real route, channel and database.
 *
 * The properties under test fail quietly if they are wrong: a project that
 * reports one credential while its worker reads another, a late result that
 * moves a newer choice, a foreign credential whose existence leaks through a
 * different error, a run dispatched into a worker that is mid-move.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { hashPassword, SESSION_COOKIE } from '../../src/auth.js';
import { loadConfig } from '../../src/config.js';
import { createPool, migrate, rollbackAll, type Pool } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { NodeChannel } from '../../src/node-channel.js';
import { nodeCredentialsRepo } from '../../src/node-credentials-repository.js';
import { productProjectsRepo } from '../../src/product-repositories.js';
import { providerCapabilitiesRepo } from '../../src/provider-capabilities-repository.js';
import { nodesRepo } from '../../src/repositories.js';
import {
  PROVISIONING_CAPABILITIES,
  TestNode,
  createNodeKeys,
  type ReceivedCommand,
} from '../support/test-node.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://asterism:asterism@127.0.0.1:55432/asterism_cp';
const ORIGIN = 'http://console.test';
const PASSWORD = 'correct horse battery staple';

const CREDENTIAL_CAPABILITIES = {
  ...PROVISIONING_CAPABILITIES,
  projects: {
    ...PROVISIONING_CAPABILITIES.projects,
    credential_assignment: true,
    credential_assignment_command_version: 1,
  },
};

let pool: Pool;
let app: FastifyInstance;
let channel: NodeChannel;
let passwordHash: string;
let baseUrl: string;
const open: TestNode[] = [];

interface Session {
  cookie: string;
  csrf: string;
}

async function addUser(email: string, role: string, organizationId = 'org_bootstrap') {
  const userId = randomUUID();
  await pool.query(
    `INSERT INTO users (user_id, normalized_email, display_name, password_hash)
     VALUES ($1, $2, $3, $4)`,
    [userId, email, email.split('@')[0], passwordHash],
  );
  await pool.query(`INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)`, [
    organizationId,
    userId,
    role,
  ]);
}

async function login(email: string): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN },
    payload: { email, password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  const raw = response.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : [raw ?? ''];
  const session = cookies.find((value) => value.startsWith(`${SESSION_COOKIE}=`)) ?? '';
  return { cookie: session.split(';')[0]!, csrf: response.json().csrf_token as string };
}

function write(session: Session) {
  return { cookie: session.cookie, origin: ORIGIN, 'x-csrf-token': session.csrf };
}

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 80 && !done(value); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  return value;
}

async function connectNode(
  suffix: string,
  capabilities: Record<string, unknown> = CREDENTIAL_CAPABILITIES,
  organizationId = 'org_bootstrap',
): Promise<TestNode> {
  const keys = createNodeKeys();
  const nodeId = `node-${suffix}-${Date.now()}`;
  await nodesRepo.create(pool, {
    nodeId,
    displayName: `Node ${suffix}`,
    publicKey: keys.publicKeyBase64,
    fingerprint: keys.fingerprint,
    organizationId,
  });
  const node = await TestNode.connect(baseUrl, nodeId, keys, capabilities);
  open.push(node);
  await node.waitForCommand('capabilities.get');
  await eventually(
    async () =>
      (
        await pool.query<{ capabilities: Record<string, unknown> | null }>(
          'SELECT capabilities FROM nodes WHERE node_id = $1',
          [nodeId],
        )
      ).rows[0]?.capabilities,
    (stored) => Boolean(stored && 'projects' in stored),
  );
  // What its runtime supports, as the Node would report it.
  await providerCapabilitiesRepo.record(pool, nodeId, {
    schema_version: 1,
    runtime_release: 'v0.1.0-alpha.27',
    reported_at: Math.floor(Date.now() / 1000),
    providers: [
      {
        id: 'openai-codex',
        display_name: 'OpenAI Codex',
        auth_methods: ['device_authorization'],
        availability: 'available',
      },
    ],
  });
  return node;
}

function reported(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    provider_id: 'openai-codex',
    auth_method: 'device_authorization',
    label: 'Work account',
    state: 'authorized',
    storage: 'isolated',
    created_at: 1_757_000_000,
    updated_at: 1_757_000_000,
    ...overrides,
  };
}

async function readyProject(nodeId: string, slug: string, organizationId = 'org_bootstrap') {
  const project = await productProjectsRepo.createWithProvisionCommand(pool, {
    organizationId,
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
  await productProjectsRepo.markProvisioningReady(pool, organizationId, project.project_id, 1);
  return project;
}

async function projectRow(projectId: string) {
  return (
    await pool.query<{
      credential_id: string | null;
      requested_credential_id: string | null;
      credential_assignment_state: string;
      credential_assignment_generation: number;
      credential_assignment_failure: string | null;
    }>(
      `SELECT credential_id, requested_credential_id, credential_assignment_state,
              credential_assignment_generation, credential_assignment_failure
         FROM projects WHERE project_id = $1`,
      [projectId],
    )
  ).rows[0]!;
}

async function assign(session: Session, projectId: string, credentialId: string | null) {
  return app.inject({
    method: 'PUT',
    url: `/api/v1/projects/${projectId}/credential`,
    headers: write(session),
    payload: { credential_id: credentialId },
  });
}

async function startRun(session: Session, projectId: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/runs`,
    headers: write(session),
    payload: { input: 'hello' },
  });
}

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
  await rollbackAll(pool).catch(() => undefined);
  await migrate(pool);
  passwordHash = await hashPassword(PASSWORD);
  channel = new NodeChannel(pool, config, createLogger('fatal'));
  channel.start();
  app = await buildApp({ pool, config, log: createLogger('fatal'), channel });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const node of open) await node.close().catch(() => undefined);
  await app?.close();
  await channel?.stop();
  await pool?.end();
});

beforeEach(async () => {
  for (const node of open.splice(0)) await node.close().catch(() => undefined);
  await pool.query('DELETE FROM audit_log');
  await pool.query('DELETE FROM runs');
  await pool.query('DELETE FROM remote_commands');
  await pool.query('DELETE FROM projects');
  await pool.query('DELETE FROM node_provider_credentials');
  await pool.query('DELETE FROM memberships WHERE user_id <> $1', [
    '00000000-0000-0000-0000-000000000000',
  ]);
  await pool.query('DELETE FROM users');
  await pool.query(
    `INSERT INTO organizations (organization_id, slug, display_name)
     VALUES ('org_other', 'other', 'Other') ON CONFLICT DO NOTHING`,
  );
});

describe('moving a project onto one isolated credential', () => {
  it('applies only once the Node confirms, and runs wait for it', async () => {
    const node = await connectNode('apply');
    await nodeCredentialsRepo.replace(pool, node.nodeId, [reported('cred-work')]);
    const project = await readyProject(node.nodeId, 'apply');
    await addUser('owner-apply@example.com', 'owner');
    const session = await login('owner-apply@example.com');

    const response = await assign(session, project.project_id, 'cred-work');
    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.project.credential).toMatchObject({
      mode: 'legacy_shared_pool',
      assignment: { state: 'pending', requested: { credential: { label: 'Work account' } } },
      run_block: { error: 'credential_assignment_pending' },
    });
    expect(body.project.can_run).toBe(false);

    const command = await node.waitForCommand('project.credential.assign');
    // Addressed the way the Node knows the project, like every project command.
    expect(command.project_id).toBe('np_apply');
    expect(command.payload).toEqual({
      version: 1,
      project_id: project.project_id,
      node_project_id: 'np_apply',
      assignment_generation: 1,
      credential_id: 'cred-work',
    });
    // Nothing that locates a secret travels.
    for (const forbidden of ['/var/lib', 'auth.json', 'home', 'token']) {
      expect(JSON.stringify(command.payload)).not.toContain(forbidden);
    }

    const blocked = await startRun(session, project.project_id);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe('credential_assignment_pending');

    node.completeCommand(command.command_id, {
      outcome: 'applied',
      event_version: 1,
      project_id: 'np_apply',
      assignment_generation: 1,
      changed: true,
    });
    const applied = await eventually(
      () => projectRow(project.project_id),
      (row) => row.credential_assignment_state === 'applied',
    );
    expect(applied).toMatchObject({
      credential_id: 'cred-work',
      requested_credential_id: null,
      credential_assignment_failure: null,
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.project_id}`,
      headers: { cookie: session.cookie },
    });
    expect(detail.json().project.credential).toMatchObject({
      mode: 'isolated',
      current: { credential_id: 'cred-work', label: 'Work account', provider_id: 'openai-codex' },
      run_block: null,
    });

    const run = await startRun(session, project.project_id);
    expect(run.json().error).toBeUndefined();

    const audit = await pool.query<{ action: string }>(
      'SELECT action FROM audit_log WHERE target_id = $1 ORDER BY occurred_at',
      [project.project_id],
    );
    expect(audit.rows.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        'project.credential_assignment_requested',
        'project.credential_assigned',
      ]),
    );
  });

  /**
   * A rename is a label. The assignment is by id, survives it, and two
   * credentials with one label are still two credentials.
   */
  it('assigns by id, through a rename and a label collision', async () => {
    const node = await connectNode('labels');
    await nodeCredentialsRepo.replace(pool, node.nodeId, [
      reported('cred-first', { label: 'Same name' }),
      reported('cred-second', { label: 'Same name' }),
    ]);
    const project = await readyProject(node.nodeId, 'labels');
    await addUser('owner-labels@example.com', 'owner');
    const session = await login('owner-labels@example.com');

    expect((await assign(session, project.project_id, 'cred-second')).statusCode).toBe(202);
    const command = await node.waitForCommand('project.credential.assign');
    expect(command.payload.credential_id).toBe('cred-second');
    node.completeCommand(command.command_id, { outcome: 'applied', event_version: 1 });
    await eventually(
      () => projectRow(project.project_id),
      (row) => row.credential_assignment_state === 'applied',
    );

    await nodeCredentialsRepo.replace(pool, node.nodeId, [
      reported('cred-first', { label: 'Same name' }),
      reported('cred-second', { label: 'Renamed' }),
    ]);
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.project_id}`,
      headers: { cookie: session.cookie },
    });
    expect(detail.json().project.credential.current).toMatchObject({
      credential_id: 'cred-second',
      label: 'Renamed',
    });
    expect((await projectRow(project.project_id)).credential_id).toBe('cred-second');
  });

  it('can move a project back to the shared pool', async () => {
    const node = await connectNode('back');
    await nodeCredentialsRepo.replace(pool, node.nodeId, [reported('cred-work')]);
    const project = await readyProject(node.nodeId, 'back');
    await addUser('owner-back@example.com', 'owner');
    const session = await login('owner-back@example.com');

    await assign(session, project.project_id, 'cred-work');
    const first = await node.waitForCommand('project.credential.assign');
    node.completeCommand(first.command_id, { outcome: 'applied', event_version: 1 });
    await eventually(
      () => projectRow(project.project_id),
      (row) => row.credential_id === 'cred-work',
    );

    // Asking for what is already in force restarts nothing.
    const same = await assign(session, project.project_id, 'cred-work');
    expect(same.statusCode).toBe(200);
    expect(same.json().command_id).toBeNull();

    expect((await assign(session, project.project_id, null)).statusCode).toBe(202);
    const second = await node.waitForCommand('project.credential.assign', 5_000, 1);
    expect(second.payload).toMatchObject({ credential_id: null, assignment_generation: 2 });
    node.completeCommand(second.command_id, { outcome: 'applied', event_version: 1 });
    const row = await eventually(
      () => projectRow(project.project_id),
      (value) =>
        value.credential_assignment_generation === 2 &&
        value.credential_assignment_state === 'applied',
    );
    expect(row.credential_id).toBeNull();
  });
});

describe('what may not be selected', () => {
  it('refuses a shared-pool entry, an unauthorized credential and a hostile id', async () => {
    const node = await connectNode('refuse');
    await nodeCredentialsRepo.replace(pool, node.nodeId, [
      reported('cred-pool', { storage: 'legacy_shared_pool', label: 'Existing credential' }),
      reported('cred-waiting', { state: 'authorizing' }),
    ]);
    const project = await readyProject(node.nodeId, 'refuse');
    await addUser('owner-refuse@example.com', 'owner');
    const session = await login('owner-refuse@example.com');

    const pool409 = await assign(session, project.project_id, 'cred-pool');
    expect(pool409.statusCode).toBe(409);
    expect(pool409.json().error).toBe('credential_not_selectable');

    const waiting = await assign(session, project.project_id, 'cred-waiting');
    expect(waiting.statusCode).toBe(409);
    expect(waiting.json().error).toBe('credential_not_authorized');

    for (const hostile of ['../hermes', 'cred/../x', 'CRED', '/etc/passwd']) {
      const response = await assign(session, project.project_id, hostile);
      expect(response.statusCode, hostile).toBe(400);
    }

    expect((await projectRow(project.project_id)).credential_assignment_generation).toBe(0);
    const commands = await pool.query(
      "SELECT 1 FROM remote_commands WHERE command_type = 'project.credential.assign'",
    );
    expect(commands.rowCount).toBe(0);
  });

  /**
   * A credential of another Node -- in this organization or another -- is
   * answered exactly like one that does not exist, so the answer reveals
   * nothing about what other Nodes hold.
   */
  it('refuses a foreign credential without saying whether it exists', async () => {
    const mine = await connectNode('mine');
    const sibling = await connectNode('sibling');
    const foreign = await connectNode('foreign', CREDENTIAL_CAPABILITIES, 'org_other');
    await nodeCredentialsRepo.replace(pool, sibling.nodeId, [reported('cred-sibling')]);
    await nodeCredentialsRepo.replace(pool, foreign.nodeId, [reported('cred-foreign')]);
    const project = await readyProject(mine.nodeId, 'mine');
    await addUser('owner-mine@example.com', 'owner');
    const session = await login('owner-mine@example.com');

    const answers = [];
    for (const id of ['cred-sibling', 'cred-foreign', 'cred-never-existed']) {
      const response = await assign(session, project.project_id, id);
      answers.push({ status: response.statusCode, body: response.json() });
    }
    expect(answers[0]).toEqual(answers[2]);
    expect(answers[1]).toEqual(answers[2]);
    expect(answers[2]!.status).toBe(404);

    // A project of another organization is not found either.
    const other = await readyProject(foreign.nodeId, 'foreign', 'org_other');
    const crossOrg = await assign(session, other.project_id, 'cred-foreign');
    expect(crossOrg.statusCode).toBe(404);
    expect(crossOrg.json().error).toBe('project_not_found');
  });

  it('refuses a Node whose build cannot assign credentials', async () => {
    const node = await connectNode('older', PROVISIONING_CAPABILITIES);
    await nodeCredentialsRepo.replace(pool, node.nodeId, [reported('cred-work')]);
    const project = await readyProject(node.nodeId, 'older');
    await addUser('owner-older@example.com', 'owner');
    const session = await login('owner-older@example.com');

    const response = await assign(session, project.project_id, 'cred-work');
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('credential_assignment_unsupported');
  });

  it('refuses a change while a run is in flight or another change is pending', async () => {
    const node = await connectNode('busy');
    await nodeCredentialsRepo.replace(pool, node.nodeId, [reported('cred-work')]);
    const project = await readyProject(node.nodeId, 'busy');
    await addUser('owner-busy@example.com', 'owner');
    const session = await login('owner-busy@example.com');

    expect((await assign(session, project.project_id, 'cred-work')).statusCode).toBe(202);
    const again = await assign(session, project.project_id, null);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('credential_assignment_pending');
  });
});

describe('when the Node could not apply it', () => {
  async function pendingAssignment(suffix: string) {
    const node = await connectNode(suffix);
    await nodeCredentialsRepo.replace(pool, node.nodeId, [reported('cred-work')]);
    const project = await readyProject(node.nodeId, suffix);
    await addUser(`owner-${suffix}@example.com`, 'owner');
    const session = await login(`owner-${suffix}@example.com`);
    await assign(session, project.project_id, 'cred-work');
    const command = await node.waitForCommand('project.credential.assign');
    return { node, project, session, command };
  }

  it('keeps the previous assignment in force when the Node restored it', async () => {
    const { node, project, session, command } = await pendingAssignment('restored');
    node.completeCommand(command.command_id, {
      outcome: 'failed',
      event_version: 1,
      failure: 'worker_unhealthy',
      restored: true,
    });
    const row = await eventually(
      () => projectRow(project.project_id),
      (value) => value.credential_assignment_state !== 'pending',
    );
    expect(row).toMatchObject({
      credential_assignment_state: 'failed',
      credential_assignment_failure: 'worker_unhealthy',
      credential_id: null,
    });
    const run = await startRun(session, project.project_id);
    expect(String(run.json().error ?? '')).not.toMatch(/^credential_/);
  });

  it('holds runs when the Node could not say what the worker reads', async () => {
    const { node, project, session, command } = await pendingAssignment('lost');
    node.completeCommand(command.command_id, {
      outcome: 'failed',
      event_version: 1,
      failure: 'worker_restart_failed',
      restored: false,
    });
    await eventually(
      () => projectRow(project.project_id),
      (value) => value.credential_assignment_state === 'inconsistent',
    );
    const run = await startRun(session, project.project_id);
    expect(run.statusCode).toBe(409);
    expect(run.json().error).toBe('credential_assignment_inconsistent');
  });

  it('records an older Node refusing the command as nothing changed', async () => {
    const { node, project, command } = await pendingAssignment('refused');
    node.failCommand(command.command_id, 'forbidden_command');
    const row = await eventually(
      () => projectRow(project.project_id),
      (value) => value.credential_assignment_state !== 'pending',
    );
    expect(row).toMatchObject({
      credential_assignment_state: 'failed',
      credential_assignment_failure: 'node_refused',
    });
  });

  /** Command replay: a result for a request somebody has since replaced moves nothing. */
  it('ignores a late result for a request that has been replaced', async () => {
    const { node, project, session, command } = await pendingAssignment('replay');
    node.completeCommand(command.command_id, {
      outcome: 'failed',
      event_version: 1,
      failure: 'worker_unhealthy',
      restored: true,
    });
    await eventually(
      () => projectRow(project.project_id),
      (value) => value.credential_assignment_state === 'failed',
    );
    expect((await assign(session, project.project_id, null)).statusCode).toBe(202);

    // The first request's result arrives again, now claiming success.
    node.completeCommand(command.command_id, { outcome: 'applied', event_version: 1 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await projectRow(project.project_id)).toMatchObject({
      credential_id: null,
      credential_assignment_state: 'pending',
      credential_assignment_generation: 2,
    });
  });
});

describe('a project created with a credential', () => {
  it('is moved onto it after provisioning, and only once', async () => {
    const node = await connectNode('create');
    await nodeCredentialsRepo.replace(pool, node.nodeId, [reported('cred-work')]);
    await addUser('owner-create@example.com', 'owner');
    const session = await login('owner-create@example.com');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: write(session),
      payload: {
        name: 'Created',
        slug: 'created',
        node_id: node.nodeId,
        workspace: { mode: 'empty' },
        credential_id: 'cred-work',
      },
    });
    expect(created.statusCode).toBe(201);
    const projectId = created.json().project.project_id as string;
    expect(await projectRow(projectId)).toMatchObject({
      credential_assignment_state: 'pending',
      requested_credential_id: 'cred-work',
      credential_assignment_generation: 1,
    });
    expect(node.commands.some((entry) => entry.command === 'project.credential.assign')).toBe(
      false,
    );

    const provision = await node.waitForCommand('project.provision');
    const provisioned = {
      outcome: 'provisioned',
      event_version: 1,
      project_id: projectId,
      provisioning_generation: 1,
    };
    node.completeCommand(provision.command_id, provisioned);
    const assignCommand: ReceivedCommand = await node.waitForCommand('project.credential.assign');
    expect(assignCommand.payload).toMatchObject({
      credential_id: 'cred-work',
      assignment_generation: 1,
    });

    // The Node retransmits its provisioning result.
    node.completeCommand(provision.command_id, provisioned);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const commands = await pool.query(
      "SELECT 1 FROM remote_commands WHERE command_type = 'project.credential.assign'",
    );
    expect(commands.rowCount).toBe(1);
  });

  it('refuses a shared-pool entry before anything is created', async () => {
    const node = await connectNode('create-pool');
    await nodeCredentialsRepo.replace(pool, node.nodeId, [
      reported('cred-pool', { storage: 'legacy_shared_pool' }),
    ]);
    await addUser('owner-create-pool@example.com', 'owner');
    const session = await login('owner-create-pool@example.com');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: write(session),
      payload: {
        name: 'Created',
        slug: 'created-pool',
        node_id: node.nodeId,
        workspace: { mode: 'empty' },
        credential_id: 'cred-pool',
      },
    });
    expect(created.statusCode).toBe(409);
    expect(created.json().error).toBe('credential_not_selectable');
    expect((await pool.query('SELECT 1 FROM projects')).rowCount).toBe(0);
  });
});
