/**
 * The device-authorization result, from a Node through everything that keeps it.
 *
 * The id is safe and must arrive intact; the pair is a secret that exists only
 * in the relay and in the one answer to the browser that asked. Checked where
 * each copy actually lives: the stored command, the audit trail, the Node and
 * audit APIs, and the log lines this process wrote while it all happened.
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
import { TestNode, createNodeKeys } from '../support/test-node.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://asterism:asterism@127.0.0.1:55432/asterism_cp';
const ORIGIN = 'http://console.test';
const PASSWORD = 'correct horse battery staple';

const ID = 'cred-0011aabbccddeeff';
const SECRETS = [
  'RCB8-M9COT',
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
let node: TestNode | null = null;
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

describe('a device authorization result', () => {
  it('keeps the credential id everywhere and the secret pair nowhere it should not be', async () => {
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
    const cookie = (Array.isArray(cookies) ? cookies : [cookies ?? ''])
      .find((value) => value.startsWith(`${SESSION_COOKIE}=`))!
      .split(';')[0]!;
    const headers = {
      cookie,
      origin: ORIGIN,
      'x-csrf-token': loginResponse.json().csrf_token as string,
    };

    const keys = createNodeKeys();
    const nodeId = `node-device-${Date.now()}`;
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
      runtime_release: 'v0.1.0-alpha.29',
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

    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${nodeId}/credentials`,
      headers,
      payload: {
        provider_id: 'openai-codex',
        auth_method: 'device_authorization',
        label: 'Second account',
      },
    });
    expect(started.statusCode, started.body).toBe(202);

    const command = await node.waitForCommand('credentials.authorize');
    // What a Node sends: the id as typed safe metadata, the pair beside it, and
    // -- to prove nothing else rides along -- the forms an older Node or a
    // careless one might add.
    node.completeCommand(command.command_id, {
      verification_uri: 'https://auth.openai.com/codex/device',
      user_code: 'RCB8-M9COT',
      expires_in_seconds: 900,
      safe_metadata: { credential_id: ID, access_token: 'eyJhbGciOiJIUzI1NiJ9.a.b' },
      credential_id: '[redacted]',
      refresh_token: 'rt-secret-value',
      device_code: 'secret-device-code',
      password: 'hunter2',
    });

    const stored = await eventually(
      async () =>
        (
          await pool.query<{ state: string; response_payload: unknown }>(
            'SELECT state, response_payload FROM remote_commands WHERE command_id = $1',
            [command.command_id],
          )
        ).rows[0],
      (row) => row?.state === 'completed',
    );
    expect(stored?.response_payload).toEqual({
      redacted: 'device_authorization',
      safe_metadata: { credential_id: ID },
    });

    // The one place the pair belongs: the relay's answer to the browser that
    // asked. It carries the id now, instead of `[redacted]`.
    const relay = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes/${nodeId}/provider-authorization`,
      headers: { cookie },
    });
    const device = relay.json().device as Record<string, unknown>;
    expect(device.credential_id).toBe(ID);
    expect(device.user_code).toBe('RCB8-M9COT');
    for (const extra of ['refresh_token', 'device_code', 'password', 'access_token']) {
      expect(JSON.stringify(device)).not.toContain(extra);
    }

    // Everywhere else, none of it.
    const everywhereElse: [string, string][] = [];
    const rows = await pool.query<{ row: string }>(
      `SELECT row_to_json(r)::text AS row FROM remote_commands r WHERE node_id = $1
       UNION ALL SELECT row_to_json(a)::text FROM audit_log a`,
      [nodeId],
    );
    for (const { row } of rows.rows) everywhereElse.push(['database', row]);
    for (const url of [`/api/v1/nodes/${nodeId}`, '/api/v1/audit', '/api/v1/nodes']) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie } });
      everywhereElse.push([url, response.body]);
    }
    for (const line of logged) everywhereElse.push(['log', line]);

    expect(everywhereElse.some(([place]) => place === 'log')).toBe(true);
    for (const [place, text] of everywhereElse) {
      for (const secret of SECRETS) {
        expect(text.includes(secret), `${place} exposes ${secret}`).toBe(false);
      }
    }
  });
});
