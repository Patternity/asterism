/**
 * A device code, from a Node through everything that could keep it.
 *
 * The code reaches the browser through one frame and one relay, and nowhere
 * else. The durable command result carries its shape and the safe credential id.
 * Checked where each copy could actually live: the stored command, the audit
 * trail, the Node and audit APIs, and every log line this process wrote.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/app.js';
import { hashPassword, SESSION_COOKIE } from '../../src/auth.js';
import { loadConfig } from '../../src/config.js';
import { createPool, migrate, rollbackAll, type Pool } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { NodeChannel } from '../../src/node-channel.js';
import { providerCapabilitiesRepo } from '../../src/provider-capabilities-repository.js';
import { nodesRepo } from '../../src/repositories.js';
import { TestNode, createNodeKeys, type ReceivedCommand } from '../support/test-node.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://asterism:asterism@127.0.0.1:55432/asterism_cp';
const ORIGIN = 'http://console.test';
const PASSWORD = 'correct horse battery staple';

const ID = 'cred-0011aabbccddeeff';
const CODE = 'RCB8-M9COT';
const LINK = 'https://auth.openai.com/codex/device';
const SECRETS = [
  CODE,
  'auth.openai.com/codex/device',
  'eyJhbGciOiJIUzI1NiJ9',
  'rt-secret-value',
  'secret-device-code',
  'hunter2',
];

let pool: Pool;
let app: FastifyInstance;
let channel: NodeChannel;
let baseUrl: string;
let node: TestNode;
let nodeId: string;
let cookie: string;
let headers: Record<string, string>;
const logged: string[] = [];

beforeAll(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL,
    PUBLIC_BASE_URL: 'http://127.0.0.1:8080',
    ALLOWED_ORIGINS: ORIGIN,
    ALLOW_PLAINTEXT: 'true',
    OPERATOR_COMPATIBILITY: 'false',
    LOG_LEVEL: 'debug',
  } as NodeJS.ProcessEnv);
  pool = createPool(DATABASE_URL, 8);
  await migrate(pool);
  await rollbackAll(pool).catch(() => undefined);
  await migrate(pool);
  // Every line either logger writes, at the most verbose level.
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
  channel = new NodeChannel(pool, config, createLogger('debug'));
  channel.start();
  app = await buildApp({ pool, config, log: createLogger('debug'), channel });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  await pool.query('DELETE FROM audit_log');
  await pool.query('DELETE FROM remote_commands');
  const userId = randomUUID();
  await pool.query(
    `INSERT INTO users (user_id, normalized_email, display_name, password_hash)
     VALUES ($1, 'owner-device@example.com', 'owner', $2)`,
    [userId, await hashPassword(PASSWORD)],
  );
  await pool.query(
    `INSERT INTO memberships (organization_id, user_id, role) VALUES ('org_bootstrap', $1, 'owner')`,
    [userId],
  );
  const loginResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN },
    payload: { email: 'owner-device@example.com', password: PASSWORD },
  });
  const cookies = loginResponse.headers['set-cookie'];
  cookie = (Array.isArray(cookies) ? cookies : [cookies ?? ''])
    .find((value) => value.startsWith(`${SESSION_COOKIE}=`))!
    .split(';')[0]!;
  headers = { cookie, origin: ORIGIN, 'x-csrf-token': loginResponse.json().csrf_token as string };

  const keys = createNodeKeys();
  nodeId = `node-device-${Date.now()}`;
  await nodesRepo.create(pool, {
    nodeId,
    displayName: 'Device node',
    publicKey: keys.publicKeyBase64,
    fingerprint: keys.fingerprint,
    organizationId: 'org_bootstrap',
  });
  node = await TestNode.connect(baseUrl, nodeId, keys, {
    api_version: 1,
    provider: { kind: 'openai-codex', device_authorization: true },
  });
  await node.waitForCommand('capabilities.get');
  await providerCapabilitiesRepo.record(pool, nodeId, {
    schema_version: 1,
    runtime_release: 'v0.1.0-alpha.30',
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
});

afterAll(async () => {
  await node?.close().catch(() => undefined);
  await app?.close();
  await channel?.stop();
  await pool?.end();
  vi.restoreAllMocks();
});

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 80 && !done(value); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  return value;
}

let started = 0;
/** Start a login through the API and return the command the Node received. */
async function startAuthorization(): Promise<ReceivedCommand> {
  // One login at a time: the relay for this Node is cleared between attempts.
  channel.deviceAuthorizations.forget(nodeId);
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/nodes/${nodeId}/credentials`,
    headers,
    payload: {
      provider_id: 'openai-codex',
      auth_method: 'device_authorization',
      label: `Account ${started}`,
    },
  });
  expect(response.statusCode, response.body).toBe(202);
  const command = await node.waitForCommand('credentials.authorize', 5_000, started);
  started += 1;
  return command;
}

async function storedResult(commandId: string): Promise<unknown> {
  const row = await eventually(
    async () =>
      (
        await pool.query<{ state: string; response_payload: unknown }>(
          'SELECT state, response_payload FROM remote_commands WHERE command_id = $1',
          [commandId],
        )
      ).rows[0],
    (value) => value?.state === 'completed',
  );
  return row?.response_payload;
}

async function relay(): Promise<Record<string, unknown> | null> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/nodes/${nodeId}/provider-authorization`,
    headers: { cookie },
  });
  return response.json().device as Record<string, unknown> | null;
}

function delivery(commandId: string, overrides: Record<string, unknown> = {}) {
  return {
    command_id: commandId,
    verification_uri: LINK,
    user_code: CODE,
    expires_in_seconds: 900,
    safe_metadata: { credential_id: ID },
    ...overrides,
  };
}

describe('a device code delivered as its own frame', () => {
  it('reaches the relay with the credential id, is confirmed, and is stored nowhere', async () => {
    const command = await startAuthorization();
    // The durable answer as a Node sends it -- plus what a careless Node might
    // add, to prove it is not stored either.
    node.completeCommand(command.command_id, {
      redacted: 'device_authorization',
      delivery: 'transient',
      expires_in_seconds: 900,
      safe_metadata: { credential_id: ID, access_token: 'eyJhbGciOiJIUzI1NiJ9.a.b' },
      refresh_token: 'rt-secret-value',
      password: 'hunter2',
    });
    node.sendDeviceAuthorization(delivery(command.command_id));

    expect(await node.waitForDeviceAck(command.command_id)).toBe(true);
    expect(await storedResult(command.command_id)).toEqual({
      redacted: 'device_authorization',
      delivery: 'transient',
      expires_in_seconds: 900,
      safe_metadata: { credential_id: ID },
    });

    const device = await relay();
    expect(device?.credential_id).toBe(ID);
    expect(device?.user_code).toBe(CODE);
    expect(device?.verification_uri).toBe(LINK);

    // Consumed: the same delivery again is a replay, refused without a second
    // confirmation.
    node.sendDeviceAuthorization(delivery(command.command_id, { user_code: 'ZZZZ-9999' }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(node.deviceAcks.filter((id) => id === command.command_id)).toHaveLength(1);
    expect((await relay())?.user_code).toBe(CODE);
  });

  it('refuses malformed, unknown, foreign and expired deliveries without confirming them', async () => {
    const command = await startAuthorization();
    node.completeCommand(command.command_id, {
      redacted: 'device_authorization',
      delivery: 'transient',
      safe_metadata: { credential_id: ID },
    });
    await storedResult(command.command_id);

    const refused: [string, unknown][] = [
      ['an unplanned field', delivery(command.command_id, { refresh_token: 'rt-secret-value' })],
      ['a device code field', delivery(command.command_id, { device_code: 'secret-device-code' })],
      [
        'a plain http link',
        delivery(command.command_id, { verification_uri: 'http://auth.openai.com/codex/device' }),
      ],
      [
        'no code',
        { command_id: command.command_id, verification_uri: LINK, expires_in_seconds: 900 },
      ],
      ['an expiry out of range', delivery(command.command_id, { expires_in_seconds: 86_400 })],
      ['a command that does not exist', delivery('00000000-0000-0000-0000-000000000000')],
      [
        'a command of another kind',
        delivery((await node.waitForCommand('capabilities.get')).command_id),
      ],
      ['not an object', 'RCB8-M9COT'],
    ];
    for (const [, payload] of refused) node.sendDeviceAuthorization(payload);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(node.deviceAcks).not.toContain(command.command_id);
    expect(await relay()).toBeNull();

    // A delivery for a command older than any code could live.
    const old = await startAuthorization();
    node.completeCommand(old.command_id, {
      redacted: 'device_authorization',
      delivery: 'transient',
    });
    await storedResult(old.command_id);
    await pool.query(
      `UPDATE remote_commands SET created_at = now() - interval '1 hour' WHERE command_id = $1`,
      [old.command_id],
    );
    node.sendDeviceAuthorization(delivery(old.command_id));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(node.deviceAcks).not.toContain(old.command_id);
    expect(await relay()).toBeNull();
  });

  /** A Node that predates the frame still delivers through its result, stored nowhere. */
  it('still relays the code from an older Node without storing it', async () => {
    const command = await startAuthorization();
    node.completeCommand(command.command_id, {
      verification_uri: LINK,
      user_code: CODE,
      expires_in_seconds: 900,
      safe_metadata: { credential_id: ID },
      device_code: 'secret-device-code',
    });
    expect(await storedResult(command.command_id)).toEqual({
      redacted: 'device_authorization',
      safe_metadata: { credential_id: ID },
    });
    const device = await eventually(relay, (value) => value !== null);
    expect(device?.user_code).toBe(CODE);
    expect(device?.credential_id).toBe(ID);
  });

  it('left nothing secret in the database, the APIs or the logs', async () => {
    const places: [string, string][] = [];
    const rows = await pool.query<{ row: string }>(
      `SELECT row_to_json(r)::text AS row FROM remote_commands r WHERE node_id = $1
       UNION ALL SELECT row_to_json(a)::text FROM audit_log a`,
      [nodeId],
    );
    for (const { row } of rows.rows) places.push(['database', row]);
    for (const url of [`/api/v1/nodes/${nodeId}`, '/api/v1/audit', '/api/v1/nodes']) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie } });
      places.push([url, response.body]);
    }
    for (const line of logged) places.push(['log', line]);

    expect(places.some(([place]) => place === 'log')).toBe(true);
    expect(places.some(([place]) => place === 'database')).toBe(true);
    for (const [place, text] of places) {
      for (const secret of SECRETS) {
        expect(text.includes(secret), `${place} exposes ${secret}`).toBe(false);
      }
    }
  });
});
