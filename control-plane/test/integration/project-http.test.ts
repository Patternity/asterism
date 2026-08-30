/**
 * The project routes, exercised the way a browser and a Node reach them.
 *
 * Everything here goes through the real application: real route registration,
 * real session and CSRF middleware, a real WebSocket Node with a real Ed25519
 * handshake, and a real PostgreSQL database. Half of what these routes decide
 * comes from the channel — whether the Node is reachable, what it advertises,
 * whether a command reaches it — and a stub that answers "yes" to all three
 * would prove nothing about any of them.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { hashPassword, SESSION_COOKIE } from '../../src/auth.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createPool, migrate, rollbackAll, type Pool } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { NodeChannel } from '../../src/node-channel.js';
import { nodesRepo } from '../../src/repositories.js';
import { productProjectsRepo } from '../../src/product-repositories.js';
import {
  LEGACY_CAPABILITIES,
  PROVISIONING_CAPABILITIES,
  TestNode,
  createNodeKeys,
} from '../support/test-node.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://asterism:asterism@127.0.0.1:55432/asterism_cp';
const ORIGIN = 'http://console.test';
const PASSWORD = 'correct horse battery staple';

let pool: Pool;
let app: FastifyInstance;
let config: Config;
let channel: NodeChannel;
let passwordHash: string;
let baseUrl: string;

interface Session {
  cookie: string;
  csrf: string;
  userId: string;
}

function testConfig(): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL,
    PUBLIC_BASE_URL: 'http://127.0.0.1:8080',
    ALLOWED_ORIGINS: ORIGIN,
    ALLOW_PLAINTEXT: 'true',
    OPERATOR_COMPATIBILITY: 'false',
    LOG_LEVEL: 'fatal',
  } as NodeJS.ProcessEnv);
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
  expect(response.statusCode).toBe(200);
  const raw = response.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : [raw ?? ''];
  const session = cookies.find((value) => value.startsWith(`${SESSION_COOKIE}=`)) ?? '';
  return {
    cookie: session.split(';')[0]!,
    csrf: response.json().csrf_token as string,
    userId: response.json().user.user_id as string,
  };
}

function write(session: Session) {
  return { cookie: session.cookie, origin: ORIGIN, 'x-csrf-token': session.csrf };
}

/** A Node enrolled in the database and connected through the real channel. */
async function connectNode(
  suffix: string,
  capabilities: Record<string, unknown>,
  organizationId = 'org_bootstrap',
): Promise<TestNode> {
  const keys = createNodeKeys();
  const nodeId = `node-${suffix}`;
  await nodesRepo.create(pool, {
    nodeId,
    displayName: `Node ${suffix}`,
    publicKey: keys.publicKeyBase64,
    fingerprint: keys.fingerprint,
    organizationId,
  });
  const node = await TestNode.connect(baseUrl, nodeId, keys, capabilities);
  // The capability set arrives as its own command; the routes read the stored
  // snapshot, so a test that raced ahead of it would see a Node advertising
  // nothing.
  await node.waitForCommand('capabilities.get');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const stored = await pool.query<{ capabilities: Record<string, unknown> }>(
      'SELECT capabilities FROM nodes WHERE node_id = $1',
      [nodeId],
    );
    if (stored.rows[0]?.capabilities && 'projects' in (stored.rows[0].capabilities ?? {})) break;
    if (capabilities === LEGACY_CAPABILITIES && attempt > 4) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return node;
}

const EMPTY_PROJECT = { name: 'Example project', workspace: { mode: 'empty' } };

beforeAll(async () => {
  config = testConfig();
  pool = createPool(DATABASE_URL, 8);
  await migrate(pool);
  await rollbackAll(pool).catch(() => undefined);
  await migrate(pool);
  passwordHash = await hashPassword(PASSWORD);
  channel = new NodeChannel(pool, config, createLogger('fatal'));
  channel.start();
  app = await buildApp({ pool, config, log: createLogger('fatal'), channel });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `ws://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app?.close();
  await channel?.stop();
  await pool?.end();
});

beforeEach(async () => {
  await pool.query('DELETE FROM audit_log');
  await pool.query('DELETE FROM remote_commands');
  await pool.query('DELETE FROM projects');
  await pool.query('DELETE FROM memberships WHERE user_id <> $1', [
    '00000000-0000-0000-0000-000000000000',
  ]);
  await pool.query('DELETE FROM users');
});

describe('creating a project through the real route', () => {
  it('persists the project and its command together, and never as ready', async () => {
    const node = await connectNode(`create-${Date.now()}`, PROVISIONING_CAPABILITIES);
    const owner = await addUser('owner-create@example.com', 'owner');
    const session = await login('owner-create@example.com');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: write(session),
      payload: { ...EMPTY_PROJECT, slug: 'example-project', node_id: node.nodeId },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.project.provisioning.state).toBe('pending');
    expect(body.project.provisioning.generation).toBe(1);
    expect(body.project.can_run).toBe(false);

    // The response is the sanitized shape, not the row: the row carries columns
    // the product API has no business exposing. `hermes_home` is deliberately
    // absent from this list — it is the advertised runtime *kind*, a product
    // fact, not the Node's HERMES_HOME path.
    const serialized = JSON.stringify(body);
    for (const forbidden of [
      'workspace_path',
      'hermes_profile',
      'hermes_api_key_ref',
      'runtime_endpoint',
      '/var/lib',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    const stored = await pool.query(
      'SELECT provisioning_state, provisioning_generation FROM projects WHERE slug = $1',
      ['example-project'],
    );
    expect(stored.rows[0].provisioning_state).toBe('pending');

    const command = await pool.query(
      `SELECT node_id, command_type, request_payload FROM remote_commands WHERE command_type = 'project.provision'`,
    );
    expect(command.rows).toHaveLength(1);
    expect(command.rows[0].node_id).toBe(node.nodeId);
    // Nothing about the host travels in the command: the Node decides all of it.
    const payload = JSON.stringify(command.rows[0].request_payload);
    for (const forbidden of ['/var/lib', 'hermes_home', 'api_key', 'port']) {
      expect(payload).not.toContain(forbidden);
    }

    const audit = await pool.query(
      `SELECT action FROM audit_log WHERE target_id = $1 ORDER BY occurred_at`,
      [body.project.project_id],
    );
    expect(audit.rows.map((row) => row.action)).toContain('project.provision_requested');
    expect(owner).toBeTruthy();
    await node.close();
  });

  it('refuses a Node that is not connected, leaving nothing behind', async () => {
    // Enrolled but never connected: online is decided by the same session
    // registry the routes read, so there is nothing to stub.
    const keys = createNodeKeys();
    await nodesRepo.create(pool, {
      nodeId: 'node-absent',
      displayName: 'Absent',
      publicKey: keys.publicKeyBase64,
      fingerprint: keys.fingerprint,
      organizationId: 'org_bootstrap',
    });
    await addUser('owner-offline@example.com', 'owner');
    const session = await login('owner-offline@example.com');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: write(session),
      payload: { ...EMPTY_PROJECT, slug: 'offline-project', node_id: 'node-absent' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('node_offline');
    const projects = await pool.query('SELECT 1 FROM projects');
    const commands = await pool.query('SELECT 1 FROM remote_commands');
    expect(projects.rowCount).toBe(0);
    expect(commands.rowCount).toBe(0);
  });

  it('refuses a Node whose build advertises no project provisioning', async () => {
    const node = await connectNode(`legacy-${Date.now()}`, LEGACY_CAPABILITIES);
    await addUser('owner-legacy@example.com', 'owner');
    const session = await login('owner-legacy@example.com');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: write(session),
      payload: { ...EMPTY_PROJECT, slug: 'legacy-project', node_id: node.nodeId },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('node_capability_unavailable');
    expect((await pool.query('SELECT 1 FROM projects')).rowCount).toBe(0);
    await node.close();
  });

  it('refuses a repository URL carrying a credential', async () => {
    const node = await connectNode(`cred-${Date.now()}`, PROVISIONING_CAPABILITIES);
    await addUser('owner-cred@example.com', 'owner');
    const session = await login('owner-cred@example.com');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: write(session),
      payload: {
        name: 'With credentials',
        slug: 'with-credentials',
        node_id: node.nodeId,
        workspace: {
          mode: 'clone',
          repository_url: 'https://user:secret@example.com/org/repo.git',
        },
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('repository_credentials_embedded');
    expect((await pool.query('SELECT 1 FROM projects')).rowCount).toBe(0);
    await node.close();
  });

  it('refuses a duplicate slug without leaving an orphan command', async () => {
    const node = await connectNode(`dup-${Date.now()}`, PROVISIONING_CAPABILITIES);
    await addUser('owner-dup@example.com', 'owner');
    const session = await login('owner-dup@example.com');
    const payload = { ...EMPTY_PROJECT, slug: 'taken-slug', node_id: node.nodeId };

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/projects',
          headers: write(session),
          payload,
        })
      ).statusCode,
    ).toBe(201);
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: write(session),
      payload,
    });

    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('project_slug_conflict');
    // One project, one command: the rollback took the command with it.
    expect((await pool.query('SELECT 1 FROM projects')).rowCount).toBe(1);
    expect(
      (await pool.query(`SELECT 1 FROM remote_commands WHERE command_type = 'project.provision'`))
        .rowCount,
    ).toBe(1);
    await node.close();
  });

  it('refuses a caller without project.manage', async () => {
    const node = await connectNode(`role-${Date.now()}`, PROVISIONING_CAPABILITIES);
    await addUser('viewer@example.com', 'viewer');
    const session = await login('viewer@example.com');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: write(session),
      payload: { ...EMPTY_PROJECT, slug: 'viewer-project', node_id: node.nodeId },
    });

    expect(response.statusCode).toBe(403);
    expect((await pool.query('SELECT 1 FROM projects')).rowCount).toBe(0);
    await node.close();
  });
});

describe('reading a project through the real route', () => {
  it('returns the sanitized shape and no local runtime detail', async () => {
    const node = await connectNode(`get-${Date.now()}`, PROVISIONING_CAPABILITIES);
    await addUser('owner-get@example.com', 'owner');
    const session = await login('owner-get@example.com');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: write(session),
      payload: { ...EMPTY_PROJECT, slug: 'readable', node_id: node.nodeId },
    });
    const projectId = created.json().project.project_id;

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}`,
      headers: { cookie: session.cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.project.slug).toBe('readable');
    expect(body.project.provisioning.state).toBe('pending');

    // Asserted on the actual response body, not on the helper's return value.
    // `hermes_home` is the advertised runtime kind and belongs here; what must
    // not appear is anything naming a place on the host.
    const serialized = response.body;
    for (const forbidden of [
      'workspace_path',
      'hermes_profile',
      'hermes_endpoint',
      'hermes_api_key_ref',
      'runtime_endpoint',
      'systemd_unit',
      '/var/lib',
      '18642',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    await node.close();
  });

  it('renders a failed project with its retryability', async () => {
    const node = await connectNode(`fail-${Date.now()}`, PROVISIONING_CAPABILITIES);
    await addUser('owner-fail@example.com', 'owner');
    const session = await login('owner-fail@example.com');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: write(session),
      payload: { ...EMPTY_PROJECT, slug: 'failing', node_id: node.nodeId },
    });
    const projectId = created.json().project.project_id;
    await productProjectsRepo.markProvisioningFailed(
      pool,
      'org_bootstrap',
      projectId,
      1,
      'repository_clone_failed',
      'the repository could not be cloned',
    );

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}`,
      headers: { cookie: session.cookie },
    });

    const provisioning = response.json().project.provisioning;
    expect(provisioning.state).toBe('failed');
    expect(provisioning.failure).toBe('repository_clone_failed');
    expect(provisioning.retryable).toBe(true);
    expect(response.json().project.can_run).toBe(false);
    await node.close();
  });
});

describe('retrying through the real route', () => {
  it('increments the generation and issues a new command, keeping the old one', async () => {
    const node = await connectNode(`retry-${Date.now()}`, PROVISIONING_CAPABILITIES);
    await addUser('owner-retry@example.com', 'owner');
    const session = await login('owner-retry@example.com');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: write(session),
      payload: { ...EMPTY_PROJECT, slug: 'retryable', node_id: node.nodeId },
    });
    const projectId = created.json().project.project_id;
    await productProjectsRepo.markProvisioningFailed(
      pool,
      'org_bootstrap',
      projectId,
      1,
      'repository_clone_failed',
      null,
    );

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/provisioning/retry`,
      headers: write(session),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().project.provisioning.generation).toBe(2);

    const commands = await pool.query(
      `SELECT command_id FROM remote_commands WHERE command_type = 'project.provision' ORDER BY created_at`,
    );
    // The first attempt stays readable: its result is inert because the
    // generation moved, not because the record was destroyed.
    expect(commands.rowCount).toBe(2);
    await node.close();
  });

  it('refuses a project that has not failed', async () => {
    const node = await connectNode(`noretry-${Date.now()}`, PROVISIONING_CAPABILITIES);
    await addUser('owner-noretry@example.com', 'owner');
    const session = await login('owner-noretry@example.com');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: write(session),
      payload: { ...EMPTY_PROJECT, slug: 'pending-still', node_id: node.nodeId },
    });
    const projectId = created.json().project.project_id;

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/provisioning/retry`,
      headers: write(session),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('project_not_retryable');
    await node.close();
  });

  it('refuses a failure that retrying cannot change', async () => {
    const node = await connectNode(`hopeless-${Date.now()}`, PROVISIONING_CAPABILITIES);
    await addUser('owner-hopeless@example.com', 'owner');
    const session = await login('owner-hopeless@example.com');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: write(session),
      payload: { ...EMPTY_PROJECT, slug: 'hopeless', node_id: node.nodeId },
    });
    const projectId = created.json().project.project_id;
    await productProjectsRepo.markProvisioningFailed(
      pool,
      'org_bootstrap',
      projectId,
      1,
      'node_capability_unavailable',
      null,
    );

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/provisioning/retry`,
      headers: write(session),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('project_failure_not_retryable');
    await node.close();
  });
});

describe('a run cannot be created before the project is built', () => {
  it('refuses a pending project through the real route', async () => {
    const node = await connectNode(`guard-${Date.now()}`, PROVISIONING_CAPABILITIES);
    await addUser('owner-guard@example.com', 'owner');
    const session = await login('owner-guard@example.com');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: write(session),
      payload: { ...EMPTY_PROJECT, slug: 'unbuilt', node_id: node.nodeId },
    });
    const projectId = created.json().project.project_id;

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/runs`,
      headers: write(session),
      payload: { input: 'do something' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('project_pending');
    // No command was issued for a project with nowhere to run.
    expect(
      (await pool.query(`SELECT 1 FROM remote_commands WHERE command_type = 'runs.create'`))
        .rowCount,
    ).toBe(0);
    await node.close();
  });
});
