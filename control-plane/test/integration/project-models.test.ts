/**
 * Choosing a project's model, through the real route, channel and database.
 *
 * The properties under test fail quietly if they are wrong: a project that
 * reports one model while its worker runs another, a model accepted for a
 * provider the project does not run on, a choice made against a snapshot that
 * no longer holds, a change to one project reaching another, and a Control
 * Plane that has quietly grown a model list of its own.
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
import { PROVISIONING_CAPABILITIES, TestNode, createNodeKeys } from '../support/test-node.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://asterism:asterism@127.0.0.1:55432/asterism_cp';
const ORIGIN = 'http://console.test';
const PASSWORD = 'correct horse battery staple';

const MODEL_CAPABILITIES = {
  ...PROVISIONING_CAPABILITIES,
  projects: {
    ...PROVISIONING_CAPABILITIES.projects,
    credential_assignment: true,
    credential_assignment_command_version: 1,
    model_selection: true,
    model_selection_command_version: 1,
  },
};

/** What a Node reports it can run. Nothing here is known to the Control Plane. */
const REPORTED_MODELS = [
  { id: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol' },
  { id: 'gpt-5.5', display_name: 'GPT-5.5' },
];

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
  return userId;
}

async function login(email: string): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN },
    payload: { email, password: PASSWORD },
  });
  const cookies = response.headers['set-cookie'];
  const session = (Array.isArray(cookies) ? cookies : [cookies ?? '']).find((value) =>
    value.startsWith(`${SESSION_COOKIE}=`),
  )!;
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

async function recordCapabilities(
  nodeId: string,
  providers: Record<string, unknown>[],
  schemaVersion = 2,
) {
  await providerCapabilitiesRepo.record(pool, nodeId, {
    schema_version: schemaVersion,
    runtime_release: 'v0.1.0-alpha.32',
    reported_at: Math.floor(Date.now() / 1000),
    providers,
  });
}

function provider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'openai-codex',
    display_name: 'OpenAI Codex',
    auth_methods: ['device_authorization'],
    availability: 'available',
    models: REPORTED_MODELS,
    ...overrides,
  };
}

async function connectNode(
  suffix: string,
  capabilities: Record<string, unknown> = MODEL_CAPABILITIES,
  providers: Record<string, unknown>[] = [provider()],
): Promise<TestNode> {
  const keys = createNodeKeys();
  const nodeId = `node-${suffix}-${Date.now()}`;
  await nodesRepo.create(pool, {
    nodeId,
    displayName: `Node ${suffix}`,
    publicKey: keys.publicKeyBase64,
    fingerprint: keys.fingerprint,
    organizationId: 'org_bootstrap',
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
  await recordCapabilities(nodeId, providers);
  return node;
}

function reportedCredential(id: string, overrides: Record<string, unknown> = {}) {
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

/** A built project already running on one isolated credential. */
async function projectOnCredential(nodeId: string, slug: string, credentialId: string | null) {
  const project = await productProjectsRepo.createWithProvisionCommand(pool, {
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
  await productProjectsRepo.markProvisioningReady(pool, 'org_bootstrap', project.project_id, 1);
  if (credentialId) {
    await pool.query(
      `UPDATE projects SET credential_id = $2, credential_assignment_state = 'applied'
        WHERE project_id = $1`,
      [project.project_id, credentialId],
    );
  }
  return project;
}

async function projectRow(projectId: string) {
  return (
    await pool.query<{
      model: string | null;
      requested_model: string | null;
      model_selection_state: string;
      model_selection_generation: number;
      model_selection_failure: string | null;
    }>(
      `SELECT model, requested_model, model_selection_state, model_selection_generation,
              model_selection_failure
         FROM projects WHERE project_id = $1`,
      [projectId],
    )
  ).rows[0]!;
}

async function choose(session: Session, projectId: string, model: unknown) {
  return app.inject({
    method: 'PUT',
    url: `/api/v1/projects/${projectId}/model`,
    headers: write(session),
    payload: { model },
  });
}

async function projectView(session: Session, projectId: string) {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/projects/${projectId}`,
    headers: { cookie: session.cookie },
  });
  return response.json().project;
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
});

describe('choosing the model a project runs', () => {
  it('applies only once the Node confirms, and a run records what it ran on', async () => {
    const node = await connectNode('apply');
    await nodeCredentialsRepo.replace(pool, node.nodeId, [reportedCredential('cred-work')]);
    const project = await projectOnCredential(node.nodeId, 'apply', 'cred-work');
    await addUser('owner-model@example.com', 'owner');
    const session = await login('owner-model@example.com');

    // Before any choice: the project says so, and offers what its Node reported.
    const before = await projectView(session, project.project_id);
    expect(before.model).toMatchObject({
      selected: null,
      state: 'legacy_default',
      provider_id: 'openai-codex',
      blocked: null,
      run_block: null,
    });
    expect(before.model.available).toEqual(REPORTED_MODELS);

    const response = await choose(session, project.project_id, 'gpt-5.6-sol');
    expect(response.statusCode).toBe(202);
    expect(response.json().project.model).toMatchObject({
      selected: null,
      requested: 'gpt-5.6-sol',
      state: 'pending',
      run_block: { error: 'model_selection_pending' },
    });
    expect(response.json().project.can_run).toBe(false);

    const command = await node.waitForCommand('project.model.select');
    expect(command.project_id).toBe('np_apply');
    expect(command.payload).toEqual({
      version: 1,
      project_id: project.project_id,
      node_project_id: 'np_apply',
      selection_generation: 1,
      model: 'gpt-5.6-sol',
    });
    // Nothing that locates a secret or a host travels with it.
    for (const forbidden of ['/var/lib', 'auth.json', 'token', 'credential']) {
      expect(JSON.stringify(command.payload)).not.toContain(forbidden);
    }

    // A run may not start while nothing knows what the worker would run.
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.project_id}/runs`,
      headers: write(session),
      payload: { input: 'hello' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe('model_selection_pending');

    node.completeCommand(command.command_id, {
      outcome: 'applied',
      event_version: 1,
      project_id: 'np_apply',
      selection_generation: 1,
      provider_id: 'openai-codex',
      model: 'gpt-5.6-sol',
      changed: true,
    });
    const applied = await eventually(
      () => projectRow(project.project_id),
      (row) => row.model_selection_state === 'applied',
    );
    expect(applied).toMatchObject({
      model: 'gpt-5.6-sol',
      requested_model: null,
      model_selection_failure: null,
    });

    const after = await projectView(session, project.project_id);
    expect(after.model).toMatchObject({
      selected: 'gpt-5.6-sol',
      state: 'applied',
      run_block: null,
    });

    // The run records what the Node says it is executing on.
    const run = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.project_id}/runs`,
      headers: write(session),
      payload: { input: 'hello' },
    });
    expect(run.json().error).toBeUndefined();
    const runId = run.json().run.run_id as string;
    const created = await node.waitForCommand('runs.create');
    node.completeCommand(created.command_id, {
      run_id: 'arun_node_1',
      status: 'queued',
      model: 'gpt-5.6-sol',
    });
    const recorded = await eventually(
      async () =>
        (
          await pool.query<{ model: string | null }>('SELECT model FROM runs WHERE run_id = $1', [
            runId,
          ])
        ).rows[0]!,
      (row) => row.model !== null,
    );
    expect(recorded.model).toBe('gpt-5.6-sol');

    const audit = await pool.query<{ action: string }>(
      'SELECT action FROM audit_log WHERE target_id = $1 ORDER BY occurred_at',
      [project.project_id],
    );
    expect(audit.rows.map((row) => row.action)).toEqual(
      expect.arrayContaining(['project.model_selection_requested', 'project.model_selected']),
    );
  });

  /**
   * The Control Plane has no model list of its own. A Node reporting a provider
   * and a model nobody has ever heard of is believed, and the choice works.
   */
  it('carries a provider and a model it has never heard of', async () => {
    const node = await connectNode('synthetic', MODEL_CAPABILITIES, [
      provider({
        id: 'acme-llm',
        display_name: 'ACME',
        models: [{ id: 'quokka-9.2:fast', display_name: 'Quokka 9.2 Fast' }],
      }),
    ]);
    await nodeCredentialsRepo.replace(pool, node.nodeId, [
      reportedCredential('cred-acme', { provider_id: 'acme-llm' }),
    ]);
    const project = await projectOnCredential(node.nodeId, 'synthetic', 'cred-acme');
    await addUser('owner-synth@example.com', 'owner');
    const session = await login('owner-synth@example.com');

    const view = await projectView(session, project.project_id);
    expect(view.model.available).toEqual([
      { id: 'quokka-9.2:fast', display_name: 'Quokka 9.2 Fast' },
    ]);

    const response = await choose(session, project.project_id, 'quokka-9.2:fast');
    expect(response.statusCode).toBe(202);
    const command = await node.waitForCommand('project.model.select');
    expect(command.payload).toMatchObject({ model: 'quokka-9.2:fast' });
  });

  it('changes one project without touching another', async () => {
    const node = await connectNode('isolation');
    await nodeCredentialsRepo.replace(pool, node.nodeId, [reportedCredential('cred-work')]);
    const alpha = await projectOnCredential(node.nodeId, 'alpha', 'cred-work');
    const beta = await projectOnCredential(node.nodeId, 'beta', 'cred-work');
    await addUser('owner-iso@example.com', 'owner');
    const session = await login('owner-iso@example.com');

    await choose(session, beta.project_id, 'gpt-5.5');
    const betaCommand = await node.waitForCommand('project.model.select');
    node.completeCommand(betaCommand.command_id, {
      outcome: 'applied',
      event_version: 1,
      selection_generation: 1,
      model: 'gpt-5.5',
      changed: true,
    });
    await eventually(
      () => projectRow(beta.project_id),
      (row) => row.model_selection_state === 'applied',
    );

    await choose(session, alpha.project_id, 'gpt-5.6-sol');
    // The second selection command: the first belongs to the other project.
    const alphaCommand = await node.waitForCommand('project.model.select', 5_000, 1);
    expect(alphaCommand.project_id).toBe('np_alpha');
    node.completeCommand(alphaCommand.command_id, {
      outcome: 'applied',
      event_version: 1,
      selection_generation: 1,
      model: 'gpt-5.6-sol',
      changed: true,
    });
    await eventually(
      () => projectRow(alpha.project_id),
      (row) => row.model_selection_state === 'applied',
    );

    expect(await projectRow(alpha.project_id)).toMatchObject({ model: 'gpt-5.6-sol' });
    expect(await projectRow(beta.project_id)).toMatchObject({
      model: 'gpt-5.5',
      model_selection_state: 'applied',
    });
    // And its credential is where it was.
    const betaCredential = await pool.query<{ credential_id: string | null }>(
      'SELECT credential_id FROM projects WHERE project_id = $1',
      [beta.project_id],
    );
    expect(betaCredential.rows[0]?.credential_id).toBe('cred-work');
  });
});

describe('what may not be chosen', () => {
  it('refuses a model the Node did not report for that credential’s provider', async () => {
    const node = await connectNode('wrong-provider', MODEL_CAPABILITIES, [
      provider(),
      provider({
        id: 'other-llm',
        display_name: 'Other',
        models: [{ id: 'other-1', display_name: 'Other One' }],
      }),
    ]);
    await nodeCredentialsRepo.replace(pool, node.nodeId, [reportedCredential('cred-work')]);
    const project = await projectOnCredential(node.nodeId, 'wrong', 'cred-work');
    await addUser('owner-wrong@example.com', 'owner');
    const session = await login('owner-wrong@example.com');

    // A real model, reported by this very Node, but on another provider.
    const foreign = await choose(session, project.project_id, 'other-1');
    expect(foreign.statusCode).toBe(409);
    expect(foreign.json().error).toBe('model_not_reported');

    const unknown = await choose(session, project.project_id, 'gpt-9.9');
    expect(unknown.json().error).toBe('model_not_reported');

    const hostile = await choose(session, project.project_id, '../../etc/passwd');
    expect(hostile.statusCode).toBe(400);
    expect(hostile.json().error).toBe('invalid_model');

    expect(await projectRow(project.project_id)).toMatchObject({
      model: null,
      model_selection_state: 'legacy_default',
    });
    expect(
      (
        await pool.query('SELECT 1 FROM remote_commands WHERE command_type = $1', [
          'project.model.select',
        ])
      ).rowCount,
    ).toBe(0);
  });

  it('refuses a project that runs on no credential of its own', async () => {
    const node = await connectNode('pool');
    const project = await projectOnCredential(node.nodeId, 'pool', null);
    await addUser('owner-pool@example.com', 'owner');
    const session = await login('owner-pool@example.com');

    const response = await choose(session, project.project_id, 'gpt-5.6-sol');
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('credential_not_assigned');

    const view = await projectView(session, project.project_id);
    expect(view.model.blocked?.error).toBe('credential_not_assigned');
    expect(view.model.available).toEqual([]);
  });

  it('refuses a stale, unknown or unsupported capability report', async () => {
    const node = await connectNode('stale');
    await nodeCredentialsRepo.replace(pool, node.nodeId, [reportedCredential('cred-work')]);
    const project = await projectOnCredential(node.nodeId, 'stale', 'cred-work');
    await addUser('owner-stale@example.com', 'owner');
    const session = await login('owner-stale@example.com');

    // Offline: the last report describes the past, and nothing may be chosen
    // against it.
    await node.close();
    await eventually(
      async () => channel.isOnline(node.nodeId),
      (online) => online === false,
    );
    const offline = await choose(session, project.project_id, 'gpt-5.6-sol');
    expect(offline.statusCode).toBe(409);
    expect(['node_offline', 'capabilities_stale']).toContain(offline.json().error);
    const offlineView = await projectView(session, project.project_id);
    expect(offlineView.model.available).toEqual([]);
    expect(offlineView.model.blocked).not.toBeNull();

    // A shape this build cannot read is its own state, distinct from a Node
    // that reported no models at all.
    await providerCapabilitiesRepo.record(pool, node.nodeId, {
      schema_version: 99,
      runtime_release: 'v9',
      reported_at: Math.floor(Date.now() / 1000),
      providers: [],
    });
    const stored = await providerCapabilitiesRepo.byNode(pool, node.nodeId);
    expect(stored?.status).toBe('unsupported_schema');

    // And a Node that never reported at all.
    await pool.query('DELETE FROM node_provider_capabilities WHERE node_id = $1', [node.nodeId]);
    const unknown = await choose(session, project.project_id, 'gpt-5.6-sol');
    expect(unknown.statusCode).toBe(409);
    expect(['node_offline', 'capabilities_unknown']).toContain(unknown.json().error);
  });

  it('refuses a Node whose build cannot choose a model', async () => {
    const node = await connectNode('old-build', {
      ...PROVISIONING_CAPABILITIES,
      projects: {
        ...PROVISIONING_CAPABILITIES.projects,
        credential_assignment: true,
        credential_assignment_command_version: 1,
      },
    });
    await nodeCredentialsRepo.replace(pool, node.nodeId, [reportedCredential('cred-work')]);
    const project = await projectOnCredential(node.nodeId, 'old', 'cred-work');
    await addUser('owner-old@example.com', 'owner');
    const session = await login('owner-old@example.com');

    const response = await choose(session, project.project_id, 'gpt-5.6-sol');
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('model_selection_unsupported');
  });

  it('refuses a change while a run is in flight or another change is pending', async () => {
    const node = await connectNode('busy');
    await nodeCredentialsRepo.replace(pool, node.nodeId, [reportedCredential('cred-work')]);
    const project = await projectOnCredential(node.nodeId, 'busy', 'cred-work');
    await addUser('owner-busy@example.com', 'owner');
    const session = await login('owner-busy@example.com');

    await choose(session, project.project_id, 'gpt-5.6-sol');
    await node.waitForCommand('project.model.select');
    const again = await choose(session, project.project_id, 'gpt-5.5');
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('model_selection_pending');
  });
});

describe('when the Node could not apply it', () => {
  async function pendingProject(suffix: string) {
    const node = await connectNode(suffix);
    await nodeCredentialsRepo.replace(pool, node.nodeId, [reportedCredential('cred-work')]);
    const project = await projectOnCredential(node.nodeId, suffix, 'cred-work');
    await addUser(`owner-${suffix}@example.com`, 'owner');
    const session = await login(`owner-${suffix}@example.com`);
    await choose(session, project.project_id, 'gpt-5.6-sol');
    const command = await node.waitForCommand('project.model.select');
    return { node, project, session, command };
  }

  it('leaves the project on what it was running when the Node restored it', async () => {
    const { node, project, session, command } = await pendingProject('restored');
    node.completeCommand(command.command_id, {
      outcome: 'failed',
      event_version: 1,
      selection_generation: 1,
      failure: 'worker_unhealthy',
      restored: true,
    });
    const settled = await eventually(
      () => projectRow(project.project_id),
      (row) => row.model_selection_state !== 'pending',
    );
    // It had never chosen, so it is back to running the runtime's default --
    // not to a model it never had.
    expect(settled).toMatchObject({
      model: null,
      requested_model: null,
      model_selection_state: 'legacy_default',
      model_selection_failure: 'worker_unhealthy',
    });
    const view = await projectView(session, project.project_id);
    expect(view.model.run_block).toBeNull();
    expect(view.can_run).toBe(true);
  });

  it('holds runs when the Node could not say what the worker runs', async () => {
    const { node, project, session, command } = await pendingProject('inconsistent');
    node.completeCommand(command.command_id, {
      outcome: 'failed',
      event_version: 1,
      selection_generation: 1,
      failure: 'worker_not_restarted',
      restored: false,
    });
    const settled = await eventually(
      () => projectRow(project.project_id),
      (row) => row.model_selection_state !== 'pending',
    );
    expect(settled.model_selection_state).toBe('inconsistent');

    const run = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.project_id}/runs`,
      headers: write(session),
      payload: { input: 'hello' },
    });
    expect(run.statusCode).toBe(409);
    expect(run.json().error).toBe('model_selection_inconsistent');
  });

  it('records an unknown failure code as a refusal rather than storing it', async () => {
    const { node, project, command } = await pendingProject('unknown-code');
    node.completeCommand(command.command_id, {
      outcome: 'failed',
      event_version: 1,
      selection_generation: 1,
      failure: 'something-a-newer-node-invented',
      restored: true,
    });
    const settled = await eventually(
      () => projectRow(project.project_id),
      (row) => row.model_selection_state !== 'pending',
    );
    expect(settled.model_selection_failure).toBe('node_refused');
  });

  it('ignores a late result for a request that has been replaced', async () => {
    const { node, project, session, command } = await pendingProject('late');
    node.completeCommand(command.command_id, {
      outcome: 'failed',
      event_version: 1,
      selection_generation: 1,
      failure: 'worker_unhealthy',
      restored: true,
    });
    await eventually(
      () => projectRow(project.project_id),
      (row) => row.model_selection_state !== 'pending',
    );

    await choose(session, project.project_id, 'gpt-5.5');
    const second = await node.waitForCommand('project.model.select', 5_000, 1);
    expect(second.payload).toMatchObject({ selection_generation: 2, model: 'gpt-5.5' });

    // The Node answers the *first* request again, after it was replaced. The
    // request it belongs to is read from the command this process sent, so it
    // carries generation 1 and matches nothing.
    node.completeCommand(command.command_id, {
      outcome: 'applied',
      event_version: 1,
      selection_generation: 1,
      model: 'gpt-5.6-sol',
      changed: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const row = await projectRow(project.project_id);
    expect(row.model).toBeNull();
    expect(row.model_selection_state).toBe('pending');
    expect(row.requested_model).toBe('gpt-5.5');
  });
});

describe('a project created with a model', () => {
  it('is moved onto it after its credential, and only once', async () => {
    const node = await connectNode('created');
    await nodeCredentialsRepo.replace(pool, node.nodeId, [reportedCredential('cred-work')]);
    await addUser('owner-created@example.com', 'owner');
    const session = await login('owner-created@example.com');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: write(session),
      payload: {
        name: 'Created with a model',
        slug: 'created-model',
        node_id: node.nodeId,
        workspace: { mode: 'empty' },
        credential_id: 'cred-work',
        model: 'gpt-5.6-sol',
      },
    });
    expect(created.statusCode).toBe(201);
    const projectId = created.json().project.project_id as string;
    expect(await projectRow(projectId)).toMatchObject({
      requested_model: 'gpt-5.6-sol',
      model_selection_state: 'pending',
      model: null,
    });

    const provision = await node.waitForCommand('project.provision');
    node.completeCommand(provision.command_id, {
      outcome: 'provisioned',
      event_version: 1,
      project_id: projectId,
      provisioning_generation: 1,
    });

    // The credential first: the provider a model belongs to comes from it.
    const assign = await node.waitForCommand('project.credential.assign');
    node.completeCommand(assign.command_id, {
      outcome: 'applied',
      event_version: 1,
      assignment_generation: 1,
      changed: true,
    });

    const select = await node.waitForCommand('project.model.select');
    expect(select.payload).toMatchObject({ model: 'gpt-5.6-sol', selection_generation: 1 });
    node.completeCommand(select.command_id, {
      outcome: 'applied',
      event_version: 1,
      selection_generation: 1,
      model: 'gpt-5.6-sol',
      changed: true,
    });
    const applied = await eventually(
      () => projectRow(projectId),
      (row) => row.model_selection_state === 'applied',
    );
    expect(applied.model).toBe('gpt-5.6-sol');

    const commands = await pool.query<{ count: string }>(
      `SELECT count(*) FROM remote_commands WHERE command_type = 'project.model.select'`,
    );
    expect(Number(commands.rows[0]!.count)).toBe(1);
  });

  it('refuses a model before anything is created', async () => {
    const node = await connectNode('refused-create');
    await nodeCredentialsRepo.replace(pool, node.nodeId, [reportedCredential('cred-work')]);
    await addUser('owner-refuse@example.com', 'owner');
    const session = await login('owner-refuse@example.com');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: write(session),
      payload: {
        name: 'Refused',
        slug: 'refused-model',
        node_id: node.nodeId,
        workspace: { mode: 'empty' },
        credential_id: 'cred-work',
        model: 'gpt-9.9-nonexistent',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('model_not_reported');
    expect((await pool.query('SELECT 1 FROM projects')).rowCount).toBe(0);
  });

  /**
   * An external project -- one the Node serves but does not manage -- is not
   * brought under model control by anything here. It never gets a model, and
   * the page says why rather than offering a choice that cannot be applied.
   */
  it('leaves a legacy project on its Node’s default', async () => {
    const node = await connectNode('legacy');
    const project = await projectOnCredential(node.nodeId, 'legacy', null);
    await addUser('owner-legacy@example.com', 'owner');
    const session = await login('owner-legacy@example.com');

    const view = await projectView(session, project.project_id);
    expect(view.model).toMatchObject({ selected: null, state: 'legacy_default', run_block: null });
    expect(view.can_run).toBe(true);
    expect(await projectRow(project.project_id)).toMatchObject({
      model: null,
      model_selection_state: 'legacy_default',
      model_selection_generation: 0,
    });
  });
});
