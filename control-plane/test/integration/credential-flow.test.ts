/**
 * Watching a login, and being told how an action ended.
 *
 * Both properties here failed quietly in production. A browser watching a
 * device code made the Control Plane ask the Node for its credential list on
 * every poll; each ask ran the provider CLI on the host, the Node's outbox grew
 * to three hundred undelivered results, and its command queue stopped draining.
 * Meanwhile the console, which only ever saw the `202`, showed a refusal an
 * operator needed to read as nothing happening at all.
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
import { providerCapabilitiesRepo } from '../../src/provider-capabilities-repository.js';
import { nodesRepo } from '../../src/repositories.js';
import { PROVISIONING_CAPABILITIES, TestNode, createNodeKeys } from '../support/test-node.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://asterism:asterism@127.0.0.1:55432/asterism_cp';
const ORIGIN = 'http://console.test';
const PASSWORD = 'correct horse battery staple';

/** A Node that can do everything this feature needs, including being updated. */
const CAPABLE = {
  ...PROVISIONING_CAPABILITIES,
  provider: { kind: 'openai-codex', device_authorization: true },
  updates: { managed: true, command_version: 1 },
};

/** node-2's build: no `updates` at all. */
const OLD_BUILD = {
  ...PROVISIONING_CAPABILITIES,
  provider: { kind: 'openai-codex', device_authorization: true },
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

async function addUser(email: string) {
  const userId = randomUUID();
  await pool.query(
    `INSERT INTO users (user_id, normalized_email, display_name, password_hash)
     VALUES ($1, $2, $3, $4)`,
    [userId, email, email.split('@')[0], passwordHash],
  );
  await pool.query(`INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)`, [
    'org_bootstrap',
    userId,
    'owner',
  ]);
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
  for (let attempt = 0; attempt < 100 && !done(value); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  return value;
}

async function connectNode(
  suffix: string,
  capabilities: Record<string, unknown> = CAPABLE,
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
  await providerCapabilitiesRepo.record(pool, nodeId, {
    schema_version: 2,
    runtime_release: 'v0.1.0-alpha.33',
    reported_at: Math.floor(Date.now() / 1000),
    providers: [
      {
        id: 'openai-codex',
        display_name: 'OpenAI Codex',
        auth_methods: ['device_authorization'],
        availability: 'available',
        models: [{ id: 'model-a', display_name: 'Model A' }],
      },
    ],
  });
  return node;
}

/**
 * Start a login the way the console does, and answer it the way the fixed Node
 * does: the command is answered as soon as the login is running, and the code
 * follows later in its own frame.
 */
async function startLogin(session: Session, node: TestNode, label = 'Work account') {
  const accepted = await app.inject({
    method: 'POST',
    url: `/api/v1/nodes/${node.nodeId}/credentials`,
    headers: write(session),
    payload: { provider_id: 'openai-codex', auth_method: 'device_authorization', label },
  });
  expect(accepted.statusCode).toBe(202);
  const command = await node.waitForCommand('credentials.authorize');
  return { commandId: command.command_id, accepted: accepted.json().command_id as string };
}

function credential(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    provider_id: 'openai-codex',
    auth_method: 'device_authorization',
    label: 'Work account',
    state: 'authorizing',
    storage: 'isolated',
    created_at: 1_757_000_000,
    updated_at: 1_757_000_000,
    ...overrides,
  };
}

/** Commands this Node has not answered yet. */
async function outstanding(nodeId: string) {
  return (
    await pool.query(
      `SELECT 1 FROM remote_commands
        WHERE node_id = $1 AND state NOT IN ('completed','failed','rejected','indeterminate')`,
      [nodeId],
    )
  ).rowCount!;
}

async function commandsOf(nodeId: string, type: string) {
  return Number(
    (
      await pool.query<{ count: string }>(
        'SELECT count(*) FROM remote_commands WHERE node_id = $1 AND command_type = $2',
        [nodeId, type],
      )
    ).rows[0]!.count,
  );
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
  await pool.query('DELETE FROM remote_commands');
  await pool.query('DELETE FROM node_provider_credentials');
  await pool.query('DELETE FROM node_update_operations');
  await pool.query('DELETE FROM memberships WHERE user_id <> $1', [
    '00000000-0000-0000-0000-000000000000',
  ]);
  await pool.query('DELETE FROM users');
});

describe('watching a login costs the Node nothing', () => {
  /**
   * The storm, reproduced at the cadence a browser actually polls and for
   * longer than the window the console used to give up after.
   */
  it('polls the code for well over a minute without asking the Node anything', async () => {
    const node = await connectNode('poll');
    await nodeCredentialsRepo.replace(pool, node.nodeId, [credential('cred-login')]);
    await addUser('owner-poll@example.com');
    const session = await login('owner-poll@example.com');

    // A login is started, answered at once, and its code follows a while later
    // -- the shape the Node now has, and the shape that used to be impossible.
    const attempt = await startLogin(session, node);
    node.completeCommand(attempt.commandId, {
      redacted: 'device_authorization',
      delivery: 'transient',
      safe_metadata: { credential_id: 'cred-login' },
    });
    node.sendDeviceAuthorization({
      command_id: attempt.commandId,
      verification_uri: 'https://auth.example.test/device',
      user_code: 'POLL-0001',
      expires_in_seconds: 900,
      safe_metadata: { credential_id: 'cred-login' },
    });
    expect(await node.waitForDeviceAck(attempt.commandId)).toBe(true);

    const before = await commandsOf(node.nodeId, 'credentials.list');
    const outstandingBefore = await outstanding(node.nodeId);
    // 40 polls at the browser's three-second cadence is two minutes of watching.
    for (let poll = 0; poll < 40; poll += 1) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/nodes/${node.nodeId}/provider-authorization`,
        headers: { cookie: session.cookie },
      });
      expect(response.statusCode).toBe(200);
      // The code stays readable for every one of them: it is not handed out
      // once and lost, and no window inside this Control Plane expires it.
      expect(response.json().device?.user_code).toBe('POLL-0001');
    }

    expect(await commandsOf(node.nodeId, 'credentials.list')).toBe(before);
    // And the set of commands still waiting on the Node did not grow: the poll
    // loop adds nothing for a queue or an outbox to hold.
    expect(await outstanding(node.nodeId)).toBeLessThanOrEqual(outstandingBefore);
  });

  /** Several browsers watching one Node share one reconciliation. */
  it('coalesces concurrent refreshes into a single command per Node', async () => {
    const node = await connectNode('coalesce');
    await nodeCredentialsRepo.replace(pool, node.nodeId, [credential('cred-login')]);
    await addUser('owner-coalesce@example.com');
    const session = await login('owner-coalesce@example.com');

    const before = await commandsOf(node.nodeId, 'credentials.list');
    // Eight browsers asking for the Node page at the same moment.
    await Promise.all(
      Array.from({ length: 8 }, () =>
        app.inject({
          method: 'GET',
          url: `/api/v1/nodes/${node.nodeId}`,
          headers: { cookie: session.cookie },
        }),
      ),
    );
    const afterBurst = await commandsOf(node.nodeId, 'credentials.list');
    expect(afterBurst - before).toBeLessThanOrEqual(1);

    // And asking again immediately adds nothing: the interval has not passed.
    for (let again = 0; again < 5; again += 1) {
      await app.inject({
        method: 'GET',
        url: `/api/v1/nodes/${node.nodeId}`,
        headers: { cookie: session.cookie },
      });
    }
    expect(await commandsOf(node.nodeId, 'credentials.list')).toBe(afterBurst);
  });

  it('stops reconciling once nothing is waiting for approval', async () => {
    const node = await connectNode('settled');
    await nodeCredentialsRepo.replace(pool, node.nodeId, [
      credential('cred-done', { state: 'authorized' }),
    ]);
    await addUser('owner-settled@example.com');
    const session = await login('owner-settled@example.com');

    const before = await commandsOf(node.nodeId, 'credentials.list');
    for (let poll = 0; poll < 5; poll += 1) {
      await app.inject({
        method: 'GET',
        url: `/api/v1/nodes/${node.nodeId}`,
        headers: { cookie: session.cookie },
      });
    }
    expect(await commandsOf(node.nodeId, 'credentials.list')).toBe(before);
  });
});

describe('an action says how it ended', () => {
  async function actOn(session: Session, nodeId: string, path: string, body: unknown = {}) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/${path}`,
      headers: write(session),
      payload: body,
    });
    return response;
  }

  async function outcome(session: Session, nodeId: string, commandId: string) {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${nodeId}/commands/${commandId}`,
      headers: { cookie: session.cookie },
    });
    return response;
  }

  it('reports a revoke the Node refused because a project still uses it', async () => {
    const node = await connectNode('in-use');
    await nodeCredentialsRepo.replace(pool, node.nodeId, [
      credential('cred-used', { state: 'authorized' }),
    ]);
    await addUser('owner-inuse@example.com');
    const session = await login('owner-inuse@example.com');

    const accepted = await actOn(session, node.nodeId, 'credentials/cred-used/revoke');
    expect(accepted.statusCode).toBe(202);
    const commandId = accepted.json().command_id as string;

    // Accepted is not done: while the Node is thinking, the answer says so.
    const waiting = await outcome(session, node.nodeId, commandId);
    expect(waiting.json()).toMatchObject({ terminal: false, failure: null });

    const command = await node.waitForCommand('credentials.revoke');
    node.refuseCommand(
      command.command_id,
      'command_failed',
      'credential_revoke_failed: credential_in_use: 1 project(s) use this credential; reassign them first',
    );

    const settled = await eventually(
      async () => (await outcome(session, node.nodeId, commandId)).json(),
      (body) => body.terminal === true,
    );
    expect(settled.failure.code).toBe('credential_in_use');
    expect(settled.failure.message).toMatch(/still used by a project/);
    // The Node's own sentence never reaches the browser.
    expect(JSON.stringify(settled)).not.toContain('reassign them first');
  });

  it('reports a revoke the runtime could not carry out', async () => {
    const node = await connectNode('missing');
    await nodeCredentialsRepo.replace(pool, node.nodeId, [
      credential('cred-gone', { state: 'authorized' }),
    ]);
    await addUser('owner-missing@example.com');
    const session = await login('owner-missing@example.com');

    const accepted = await actOn(session, node.nodeId, 'credentials/cred-gone/revoke');
    const commandId = accepted.json().command_id as string;
    const command = await node.waitForCommand('credentials.revoke');
    node.refuseCommand(
      command.command_id,
      'command_failed',
      'credential_revoke_failed: credential_runtime_missing: the provider runtime refused to remove the credential: No credential matching "Work account". Provider: openai-codex.',
    );

    const settled = await eventually(
      async () => (await outcome(session, node.nodeId, commandId)).json(),
      (body) => body.terminal === true,
    );
    expect(settled.failure.code).toBe('credential_runtime_missing');
    // No provider phrasing, no label, nothing read off the host.
    expect(JSON.stringify(settled)).not.toContain('No credential matching');
  });

  it('reports a second authorization refused while one is already waiting', async () => {
    const node = await connectNode('second');
    await nodeCredentialsRepo.replace(pool, node.nodeId, [credential('cred-first')]);
    await addUser('owner-second@example.com');
    const session = await login('owner-second@example.com');

    const accepted = await actOn(session, node.nodeId, 'credentials', {
      provider_id: 'openai-codex',
      auth_method: 'device_authorization',
      label: 'Second attempt',
    });
    expect(accepted.statusCode).toBe(202);
    const commandId = accepted.json().command_id as string;
    const command = await node.waitForCommand('credentials.authorize');
    node.refuseCommand(
      command.command_id,
      'command_failed',
      'authorization_in_progress: another authorization is already waiting for a browser approval on this Node',
    );

    const settled = await eventually(
      async () => (await outcome(session, node.nodeId, commandId)).json(),
      (body) => body.terminal === true,
    );
    expect(settled.failure.code).toBe('authorization_in_progress');
    expect(settled.failure.message).toMatch(/already waiting for a browser approval/);
  });

  it('answers for this Node only, and says nothing about another’s commands', async () => {
    const mine = await connectNode('mine');
    const theirs = await connectNode('theirs');
    await nodeCredentialsRepo.replace(pool, theirs.nodeId, [
      credential('cred-theirs', { state: 'authorized' }),
    ]);
    await addUser('owner-scope@example.com');
    const session = await login('owner-scope@example.com');

    const accepted = await actOn(session, theirs.nodeId, 'credentials/cred-theirs/revoke');
    const commandId = accepted.json().command_id as string;

    const wrongNode = await outcome(session, mine.nodeId, commandId);
    expect(wrongNode.statusCode).toBe(404);
    expect(wrongNode.json().error).toBe('command_not_found');
  });
});

/** A settled `node.update` in this Node's history, as evidence. */
async function settledUpdate(nodeId: string, state: string, at = new Date()) {
  await pool.query(
    `INSERT INTO remote_commands (command_id, node_id, command_type, request_payload,
                                  payload_digest, state, organization_id, created_at)
     VALUES ($1, $2, 'node.update', '{}'::jsonb, $3, $4, 'org_bootstrap', $5)`,
    [`cmd-${randomUUID()}`, nodeId, `digest-${randomUUID()}`, state, at],
  );
}

describe('a Node that cannot be updated is not offered an update', () => {
  it('refuses the request without writing a command or an operation', async () => {
    const node = await connectNode('old', OLD_BUILD);
    await addUser('owner-old@example.com');
    const session = await login('owner-old@example.com');
    // This Node has been asked before and never answered: node-2's situation.
    await pool.query(
      `INSERT INTO remote_commands (command_id, node_id, command_type, request_payload,
                                    payload_digest, state, organization_id, error_code)
       VALUES ($1, $2, 'node.update', '{}'::jsonb, 'digest-refused', 'indeterminate',
               'org_bootstrap', 'indeterminate')`,
      [`cmd-${randomUUID()}`, node.nodeId],
    );

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${node.nodeId}`,
      headers: { cookie: session.cookie },
    });
    expect(detail.json().node_capabilities).toMatchObject({
      supports_managed_update: false,
      managed_update_available: false,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${node.nodeId}/update`,
      headers: write(session),
      payload: { version: 'v0.1.0-alpha.32' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('managed_update_unsupported');

    // The refused request added nothing: only the one from before remains.
    expect(await commandsOf(node.nodeId, 'node.update')).toBe(1);
    const operations = await pool.query('SELECT 1 FROM node_update_operations WHERE node_id = $1', [
      node.nodeId,
    ]);
    expect(operations.rowCount).toBe(0);
  });

  /**
   * A legacy Node that took an update before is still offered one: this is the
   * single case where history may speak, and the only reason the bridge exists.
   */
  it('keeps offering an update to a legacy Node that took one', async () => {
    const node = await connectNode('accepting', OLD_BUILD);
    await addUser('owner-accepting@example.com');
    const session = await login('owner-accepting@example.com');
    await settledUpdate(node.nodeId, 'completed');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${node.nodeId}`,
      headers: { cookie: session.cookie },
    });
    expect(detail.json().node_capabilities).toMatchObject({
      supports_managed_update: true,
      managed_update_available: true,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${node.nodeId}/update`,
      headers: write(session),
      payload: { version: 'v0.1.0-alpha.33' },
    });
    expect(response.statusCode).toBe(202);
  });

  /**
   * The failure this release closes. A Node nobody has ever asked was offered
   * an update on the strength of never having refused one -- a guess, and the
   * guess that produced an operation against a host that could not take it.
   */
  it('refuses a legacy Node that has never been asked', async () => {
    const node = await connectNode('untried', OLD_BUILD);
    await addUser('owner-untried@example.com');
    const session = await login('owner-untried@example.com');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${node.nodeId}`,
      headers: { cookie: session.cookie },
    });
    expect(detail.json().node_capabilities).toMatchObject({
      supports_managed_update: false,
      managed_update_available: false,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${node.nodeId}/update`,
      headers: write(session),
      payload: { version: 'v0.1.0-alpha.33' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('managed_update_unsupported');
    expect(await commandsOf(node.nodeId, 'node.update')).toBe(0);
    const operations = await pool.query('SELECT 1 FROM node_update_operations WHERE node_id = $1', [
      node.nodeId,
    ]);
    expect(operations.rowCount).toBe(0);
  });

  /** A Node's own word overrules its history, in the direction that refuses. */
  it('refuses a Node that advertises that it does not take updates', async () => {
    const node = await connectNode('declines', {
      ...OLD_BUILD,
      updates: { managed: false, command_version: 1 },
    });
    await addUser('owner-declines@example.com');
    const session = await login('owner-declines@example.com');
    // It took one before the host was reinstalled on a build that refuses them.
    await settledUpdate(node.nodeId, 'completed');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${node.nodeId}`,
      headers: { cookie: session.cookie },
    });
    expect(detail.json().node_capabilities.supports_managed_update).toBe(false);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${node.nodeId}/update`,
      headers: write(session),
      payload: { version: 'v0.1.0-alpha.33' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('managed_update_unsupported');
    expect(await commandsOf(node.nodeId, 'node.update')).toBe(1);
  });

  /** An old success does not survive a newer refusal. */
  it('reads the most recent attempt, not the most flattering one', async () => {
    const node = await connectNode('reinstalled', OLD_BUILD);
    await addUser('owner-reinstalled@example.com');
    const session = await login('owner-reinstalled@example.com');
    await settledUpdate(node.nodeId, 'completed', new Date(Date.now() - 86_400_000));
    await settledUpdate(node.nodeId, 'rejected', new Date());

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${node.nodeId}`,
      headers: { cookie: session.cookie },
    });
    expect(detail.json().node_capabilities.supports_managed_update).toBe(false);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${node.nodeId}/update`,
      headers: write(session),
      payload: { version: 'v0.1.0-alpha.33' },
    });
    expect(response.statusCode).toBe(409);
    expect(await commandsOf(node.nodeId, 'node.update')).toBe(2);
  });

  it('keeps the accepted behaviour for a Node that advertises it', async () => {
    const node = await connectNode('capable');
    await addUser('owner-capable@example.com');
    const session = await login('owner-capable@example.com');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${node.nodeId}`,
      headers: { cookie: session.cookie },
    });
    expect(detail.json().node_capabilities.supports_managed_update).toBe(true);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${node.nodeId}/update`,
      headers: write(session),
      payload: { version: 'v0.1.0-alpha.33' },
    });
    expect(response.statusCode).toBe(202);
    expect(await commandsOf(node.nodeId, 'node.update')).toBe(1);
    const operations = await pool.query('SELECT 1 FROM node_update_operations WHERE node_id = $1', [
      node.nodeId,
    ]);
    expect(operations.rowCount).toBe(1);
  });
});

describe('the device code stays out of everything durable', () => {
  it('appears in no table, no audit row and no command', async () => {
    const node = await connectNode('durable');
    await nodeCredentialsRepo.replace(pool, node.nodeId, [credential('cred-secret')]);
    await addUser('owner-durable@example.com');
    const session = await login('owner-durable@example.com');

    const attempt = await startLogin(session, node, 'Secret account');
    node.completeCommand(attempt.commandId, {
      redacted: 'device_authorization',
      delivery: 'transient',
      safe_metadata: { credential_id: 'cred-secret' },
    });
    node.sendDeviceAuthorization({
      command_id: attempt.commandId,
      verification_uri: 'https://auth.example.test/device',
      user_code: 'SECRET-42',
      expires_in_seconds: 900,
      safe_metadata: { credential_id: 'cred-secret' },
    });
    expect(await node.waitForDeviceAck(attempt.commandId)).toBe(true);
    const shown = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${node.nodeId}/provider-authorization`,
      headers: { cookie: session.cookie },
    });
    expect(shown.json().device.user_code).toBe('SECRET-42');

    const dump = await pool.query<{ row: string }>(
      `SELECT row_to_json(r)::text AS row FROM remote_commands r
        UNION ALL SELECT row_to_json(a)::text FROM audit_log a
        UNION ALL SELECT row_to_json(c)::text FROM node_provider_credentials c`,
    );
    for (const { row } of dump.rows) {
      expect(row).not.toContain('SECRET-42');
      expect(row).not.toContain('auth.example.test');
    }
  });
});
