/**
 * Adding a Node, from the product side.
 *
 * These run against real PostgreSQL because every property worth asserting here
 * is a property of the storage: that the code is only ever a digest, that one
 * code enrolls at most one host, that a rejection reveals nothing about which
 * codes exist, and that a tenant boundary is enforced in SQL rather than
 * remembered in TypeScript.
 */
import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { hashPassword, SESSION_COOKIE } from '../../src/auth.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createPool, migrate, rollbackAll, type Pool } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { NodeChannel } from '../../src/node-channel.js';
import {
  REDEMPTION_LIMITS,
  nodeInstallationsRepo,
} from '../../src/node-installation-repository.js';
import { enrollmentTokensRepo } from '../../src/repositories.js';
import { createNodeKeys } from '../support/test-node.js';
import type { Role } from '../../src/tenancy.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://asterism:asterism@127.0.0.1:55432/asterism_cp';
const ORIGIN = 'http://console.test';
const PASSWORD = 'correct horse battery staple';

let pool: Pool;
let app: FastifyInstance;
let config: Config;
let channel: NodeChannel;
let passwordHash: string;

interface Session {
  cookie: string;
  csrf: string;
  userId: string;
}

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }): string {
  const raw = response.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const pair = value?.split(';')[0];
  if (!pair?.startsWith(`${SESSION_COOKIE}=`)) throw new Error('session cookie missing');
  return pair;
}

async function addUser(organizationId: string, email: string, role: Role): Promise<string> {
  const userId = randomUUID();
  await pool.query(
    `INSERT INTO users (user_id, normalized_email, display_name, password_hash)
     VALUES ($1, $2, $3, $4)`,
    [userId, email, email.split('@')[0], passwordHash],
  );
  await pool.query('INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)', [
    organizationId,
    userId,
    role,
  ]);
  return userId;
}

async function addOrganization(slug: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    'INSERT INTO organizations (organization_id, slug, display_name) VALUES ($1, $2, $3)',
    [id, slug, slug],
  );
  return id;
}

async function login(email: string): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN },
    payload: { email, password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  return {
    cookie: cookieFrom(response),
    csrf: response.json().csrf_token as string,
    userId: response.json().user.user_id as string,
  };
}

function headers(session: Session, csrf = false): Record<string, string> {
  return {
    cookie: session.cookie,
    ...(csrf ? { origin: ORIGIN, 'x-csrf-token': session.csrf } : {}),
  };
}

async function createInstallation(session: Session, displayName = 'build-box') {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/node-installations',
    headers: headers(session, true),
    payload: { display_name: displayName },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as {
    installation: Record<string, unknown>;
    code: string;
  };
}

async function report(code: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1/node-installations/progress',
    headers: { authorization: `Bearer ${code}` },
    payload: body,
  });
}

beforeAll(async () => {
  config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL,
    PUBLIC_BASE_URL: 'http://127.0.0.1:8080',
    ALLOWED_ORIGINS: ORIGIN,
    ASTERISM_OPERATOR_TOKEN: 'test-operator-token-that-is-long-enough-000000',
    ALLOW_PLAINTEXT: 'true',
    LOG_LEVEL: 'fatal',
  } as NodeJS.ProcessEnv);
  pool = createPool(DATABASE_URL, 6);
  await rollbackAll(pool).catch(() => undefined);
  await migrate(pool);
  passwordHash = await hashPassword(PASSWORD);
  channel = new NodeChannel(pool, config, createLogger('fatal'));
  app = await buildApp({ pool, config, log: createLogger('fatal'), channel });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await channel.stop();
  await pool.end();
});

beforeEach(async () => {
  await pool.query(
    'TRUNCATE node_installation_attempts, node_installation_events, node_installations, ' +
      'login_attempts, browser_sessions, invitations, memberships, users, ' +
      'run_events, runs, remote_commands, projects, node_sessions, identity_rotations, ' +
      'enrollment_tokens, audit_log, nodes RESTART IDENTITY CASCADE',
  );
  await pool.query("DELETE FROM organizations WHERE organization_id <> 'org_bootstrap'");
  await addUser('org_bootstrap', 'owner@example.com', 'owner');
});

describe('who may add a Node', () => {
  it('lets a member with node.manage open an installation', async () => {
    const session = await login('owner@example.com');
    const { installation, code } = await createInstallation(session);
    expect(installation.state).toBe('code_issued');
    expect(installation.percent).toBe(0);
    expect(code).toBeTypeOf('string');
  });

  it('refuses a viewer', async () => {
    await addUser('org_bootstrap', 'viewer@example.com', 'viewer');
    const session = await login('viewer@example.com');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/node-installations',
      headers: headers(session, true),
      payload: { display_name: 'nope' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('needs no operator token anywhere in the flow', async () => {
    const session = await login('owner@example.com');
    const { code } = await createInstallation(session);
    // The installer authenticates with the code alone.
    const progress = await report(code, { state: 'bootstrap_downloaded', generation: 1 });
    expect(progress.statusCode).toBe(202);
  });
});

describe('the code itself', () => {
  it('is stored only as a digest', async () => {
    const session = await login('owner@example.com');
    const { code } = await createInstallation(session);

    const stored = await pool.query<{ token_digest: string }>(
      'SELECT token_digest FROM enrollment_tokens',
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.token_digest).not.toContain(code);

    // Nowhere else either: not in the installation row, not in the audit trail.
    const anywhere = await pool.query<{ found: string }>(
      `SELECT count(*)::text AS found FROM node_installations
        WHERE installation_id LIKE $1 OR display_name LIKE $1`,
      [`%${code}%`],
    );
    expect(anywhere.rows[0]?.found).toBe('0');
    const audit = await pool.query<{ detail: unknown }>('SELECT detail FROM audit_log');
    expect(JSON.stringify(audit.rows)).not.toContain(code);
  });

  it('is never returned again after it is issued', async () => {
    const session = await login('owner@example.com');
    const { installation, code } = await createInstallation(session);
    const id = installation.installation_id as string;

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/node-installations/${id}`,
      headers: headers(session),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).not.toContain(code);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/node-installations',
      headers: headers(session),
    });
    expect(list.body).not.toContain(code);
  });

  it('stops working once the installation is cancelled', async () => {
    const session = await login('owner@example.com');
    const { installation, code } = await createInstallation(session);
    const id = installation.installation_id as string;

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/node-installations/${id}/cancel`,
      headers: headers(session, true),
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().installation.state).toBe('cancelled');

    expect((await report(code, { state: 'bootstrap_downloaded', generation: 1 })).statusCode).toBe(
      401,
    );
    expect((await report(code, { state: 'bundle_downloading', generation: 1 })).statusCode).toBe(
      401,
    );
  });

  it('stops working once it has expired', async () => {
    const session = await login('owner@example.com');
    const { code } = await createInstallation(session);
    await pool.query("UPDATE enrollment_tokens SET expires_at = now() - interval '1 minute'");
    await pool.query("UPDATE node_installations SET expires_at = now() - interval '1 minute'");
    expect((await report(code, { state: 'bootstrap_downloaded', generation: 1 })).statusCode).toBe(
      401,
    );
  });

  it('fails the same way whether it is wrong, revoked or expired', async () => {
    const session = await login('owner@example.com');
    const { installation, code } = await createInstallation(session);

    const unknown = await report('not-a-real-code', {
      state: 'bootstrap_downloaded',
      generation: 1,
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/node-installations/${installation.installation_id as string}/cancel`,
      headers: headers(session, true),
    });
    const revoked = await report(code, { state: 'bootstrap_downloaded', generation: 1 });

    // Identical status and identical body: the endpoint is not an oracle for
    // which codes exist.
    expect(unknown.statusCode).toBe(revoked.statusCode);
    expect(unknown.body).toBe(revoked.body);
  });
});

describe('tenant isolation', () => {
  it('hides an installation belonging to another organization', async () => {
    const owner = await login('owner@example.com');
    const { installation } = await createInstallation(owner);
    const id = installation.installation_id as string;

    const otherOrg = await addOrganization('other-tenant');
    await addUser(otherOrg, 'other@example.com', 'owner');
    const other = await login('other@example.com');

    for (const url of [
      `/api/v1/node-installations/${id}`,
      `/api/v1/node-installations/${id}/events/stream`,
    ]) {
      const response = await app.inject({ method: 'GET', url, headers: headers(other) });
      expect(response.statusCode).toBe(404);
    }
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/v1/node-installations/${id}/cancel`,
      headers: headers(other, true),
    });
    expect(cancel.statusCode).toBe(409);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/node-installations',
      headers: headers(other),
    });
    expect(list.json().installations).toHaveLength(0);
  });
});

describe('rate limiting redemption', () => {
  it('stops a code being guessed', async () => {
    const session = await login('owner@example.com');
    await createInstallation(session);

    // Every one of these is wrong, and they all look the same from outside.
    for (let attempt = 0; attempt < REDEMPTION_LIMITS.perCode + 2; attempt += 1) {
      const response = await report('wrong-code-same-every-time', {
        state: 'bootstrap_downloaded',
        generation: 1,
      });
      expect(response.statusCode).toBe(401);
    }

    const attempts = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM node_installation_attempts WHERE succeeded = FALSE',
    );
    expect(Number(attempts.rows[0]?.count)).toBeGreaterThanOrEqual(REDEMPTION_LIMITS.perCode);

    // And the attempt table holds digests, never codes.
    const digests = await pool.query<{ code_digest: string }>(
      'SELECT code_digest FROM node_installation_attempts',
    );
    for (const row of digests.rows) {
      expect(row.code_digest).not.toContain('wrong-code-same-every-time');
      expect(row.code_digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('refuses a code that has spent its own budget, even when it is correct', async () => {
    const session = await login('owner@example.com');
    const { code } = await createInstallation(session);

    // Same wrong code, from many addresses, so the source budget stays clear
    // and only the per-code budget is spent.
    for (let attempt = 0; attempt < REDEMPTION_LIMITS.perCode; attempt += 1) {
      const blocked = await nodeInstallationsRepo.resolveByCode(
        pool,
        code,
        `198.51.100.${attempt}`,
      );
      expect(blocked).not.toBeNull();
      await pool.query(
        'UPDATE node_installation_attempts SET succeeded = FALSE WHERE succeeded = TRUE',
      );
    }

    // The budget is spent, so the right code is refused too. That is the point:
    // a limiter that exempted valid codes would not limit guessing at all,
    // because a guesser cannot tell which of its guesses was valid.
    expect(await nodeInstallationsRepo.resolveByCode(pool, code, '198.51.100.200')).toBeNull();
  });

  it('counts a source as well as a code', async () => {
    const session = await login('owner@example.com');
    await createInstallation(session);

    for (let attempt = 0; attempt < REDEMPTION_LIMITS.perSource; attempt += 1) {
      // Every guess is a different code, so only the source budget accumulates.
      await nodeInstallationsRepo.resolveByCode(pool, `guess-${attempt}`, '203.0.113.7');
    }

    const failures = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM node_installation_attempts
        WHERE succeeded = FALSE`,
    );
    expect(Number(failures.rows[0]?.count)).toBeGreaterThanOrEqual(REDEMPTION_LIMITS.perSource);
    // Walking the code space from one address stops working before it can get
    // anywhere near the size of the space.
    expect(await nodeInstallationsRepo.resolveByCode(pool, 'guess-next', '203.0.113.7')).toBeNull();
  });
});

describe('progress', () => {
  it('advances through the stages and records real bytes', async () => {
    const session = await login('owner@example.com');
    const { installation, code } = await createInstallation(session);
    const id = installation.installation_id as string;

    await report(code, { state: 'bootstrap_downloaded', generation: 1 });
    await report(code, {
      state: 'bundle_downloading',
      generation: 1,
      bytes_done: 0,
      bytes_total: 550_000_000,
    });
    const half = await report(code, {
      state: 'bundle_downloading',
      generation: 1,
      bytes_done: 275_000_000,
      bytes_total: 550_000_000,
    });
    expect(half.json().percent).toBe(35);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/node-installations/${id}`,
      headers: headers(session),
    });
    const view = detail.json().installation;
    expect(view.state).toBe('bundle_downloading');
    expect(view.bytes_done).toBe(275_000_000);
    expect(view.bytes_total).toBe(550_000_000);
    expect(view.percent).toBe(35);
  });

  it('reaches 100 only when the Node is actually up', async () => {
    const session = await login('owner@example.com');
    const { installation, code } = await createInstallation(session);
    const id = installation.installation_id as string;

    for (const state of [
      'bootstrap_downloaded',
      'bundle_metadata_fetched',
      'bundle_verified',
      'plan_prepared',
      'prerequisites_installing',
      'runtime_installing',
      'configuration_writing',
      'identity_enrolling',
      'services_starting',
      'node_connecting',
      'health_verifying',
    ]) {
      const response = await report(code, { state, generation: 1 });
      expect(response.json().percent).toBeLessThan(100);
    }

    const complete = await report(code, { state: 'complete', generation: 1 });
    expect(complete.json().percent).toBe(100);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/node-installations/${id}`,
      headers: headers(session),
    });
    expect(detail.json().installation.completed_at).not.toBeNull();
  });

  it('drops a report from a superseded attempt', async () => {
    const session = await login('owner@example.com');
    const { code } = await createInstallation(session);

    await report(code, { state: 'runtime_installing', generation: 2 });
    const stale = await report(code, { state: 'health_verifying', generation: 1 });
    expect(stale.json().applied).toBe(false);
    expect(stale.json().reason).toBe('stale_generation');
    expect(stale.json().state).toBe('runtime_installing');
  });

  it('never moves the bar backwards on a duplicate delivery', async () => {
    const session = await login('owner@example.com');
    const { code } = await createInstallation(session);

    await report(code, { state: 'services_starting', generation: 1 });
    const replay = await report(code, { state: 'bundle_verified', generation: 1 });
    expect(replay.json().applied).toBe(false);
    expect(replay.json().reason).toBe('would_move_backwards');
    expect(replay.json().percent).toBe(92);
  });

  it('keeps the bar where a failure stopped it', async () => {
    const session = await login('owner@example.com');
    const { installation, code } = await createInstallation(session);

    await report(code, {
      state: 'bundle_downloading',
      generation: 1,
      bytes_done: 110_000_000,
      bytes_total: 550_000_000,
    });
    await report(code, {
      state: 'failed',
      generation: 1,
      failure_code: 'digest_mismatch',
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/node-installations/${installation.installation_id as string}`,
      headers: headers(session),
    });
    const view = detail.json().installation;
    expect(view.state).toBe('failed');
    expect(view.failure_code).toBe('digest_mismatch');
    expect(view.retryable).toBe(true);
    expect(view.percent).toBe(17);
  });

  it('marks a permanent failure as not worth retrying', async () => {
    const session = await login('owner@example.com');
    const { installation, code } = await createInstallation(session);
    await report(code, {
      state: 'failed',
      generation: 1,
      failure_code: 'unsupported_architecture',
    });
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/node-installations/${installation.installation_id as string}`,
      headers: headers(session),
    });
    expect(detail.json().installation.retryable).toBe(false);
  });

  it('refuses a stage or failure it does not recognise', async () => {
    const session = await login('owner@example.com');
    const { code } = await createInstallation(session);
    expect((await report(code, { state: 'almost_done', generation: 1 })).statusCode).toBe(401);
    expect(
      (await report(code, { state: 'failed', generation: 1, failure_code: 'oops' })).statusCode,
    ).toBe(401);
  });

  it('keeps an append-only history a reload can replay', async () => {
    const session = await login('owner@example.com');
    const { installation, code } = await createInstallation(session);
    const id = installation.installation_id as string;

    await report(code, { state: 'bootstrap_downloaded', generation: 1 });
    await report(code, { state: 'bundle_metadata_fetched', generation: 1 });
    await report(code, { state: 'bundle_verified', generation: 1 });

    const all = await nodeInstallationsRepo.eventsSince(pool, id, 0);
    expect(all.map((event) => event.state)).toEqual([
      'bootstrap_downloaded',
      'bundle_metadata_fetched',
      'bundle_verified',
    ]);
    // Sequence numbers are dense and increasing, which is what lets a resuming
    // browser ask for "everything after 2" and know it missed nothing.
    expect(all.map((event) => Number(event.seq))).toEqual([1, 2, 3]);

    const resumed = await nodeInstallationsRepo.eventsSince(pool, id, 2);
    expect(resumed.map((event) => event.state)).toEqual(['bundle_verified']);
  });

  it('records nothing about the host in its history', async () => {
    const session = await login('owner@example.com');
    const { installation, code } = await createInstallation(session);

    await report(code, {
      state: 'runtime_installing',
      generation: 1,
      // An installer that tried to send these would find them ignored: the
      // route reads a fixed set of fields and nothing else.
      workspace_path: '/var/lib/asterism/projects/secret',
      hermes_port: 18700,
      unit: 'asterism-hermes@x.service',
    });

    const events = await nodeInstallationsRepo.eventsSince(
      pool,
      installation.installation_id as string,
      0,
    );
    const rendered = JSON.stringify(events);
    for (const forbidden of ['/var/lib/asterism', '18700', 'asterism-hermes@']) {
      expect(rendered).not.toContain(forbidden);
    }
  });
});

describe('what the code produces', () => {
  it('gives the Node the name a person typed, not the one the host reports', async () => {
    const session = await login('owner@example.com');
    const { code } = await createInstallation(session, 'Production west');
    const keys = createNodeKeys();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/node/enroll',
      headers: { authorization: `Bearer ${code}` },
      payload: {
        public_key: keys.publicKeyBase64,
        public_key_fingerprint: keys.fingerprint,
        // What a host calls itself, which is usually its hostname and is not
        // what the person naming the server in the console meant.
        display_name: 'ip-10-0-4-17',
        supported_protocol_versions: [1],
      },
    });

    expect(response.statusCode).toBe(200);
    const nodeId = (response.json() as { node_id: string }).node_id;
    const stored = await pool.query<{ display_name: string }>(
      'SELECT display_name FROM nodes WHERE node_id = $1',
      [nodeId],
    );
    expect(stored.rows[0]?.display_name).toBe('Production west');
  });

  it('records which Node the installation produced', async () => {
    const session = await login('owner@example.com');
    const created = await createInstallation(session, 'Linked host');
    const installationId = created.installation.installation_id as string;
    const keys = createNodeKeys();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/node/enroll',
      headers: { authorization: `Bearer ${created.code}` },
      payload: {
        public_key: keys.publicKeyBase64,
        public_key_fingerprint: keys.fingerprint,
        display_name: 'whatever-the-host-says',
        supported_protocol_versions: [1],
      },
    });
    expect(response.statusCode).toBe(200);
    const nodeId = (response.json() as { node_id: string }).node_id;

    // Without this the console has a finished installation it cannot turn into a
    // link to the Node, which is exactly where the person goes next.
    const record = await nodeInstallationsRepo.byId(pool, 'org_bootstrap', installationId);
    expect(record?.node_id).toBe(nodeId);
  });

  it('leaves a token issued outside the product flow linked to nothing', async () => {
    // `attachNodeByToken` must be a no-op for an operator-issued token: there is
    // no installation behind it, and inventing one would be worse than none.
    const keys = createNodeKeys();
    const issued = await enrollmentTokensRepo.create(pool, {
      ttlMs: 60_000,
      organizationId: 'org_bootstrap',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/node/enroll',
      headers: { authorization: `Bearer ${issued.token}` },
      payload: {
        public_key: keys.publicKeyBase64,
        public_key_fingerprint: keys.fingerprint,
        display_name: 'operator-issued',
        supported_protocol_versions: [1],
      },
    });
    expect(response.statusCode).toBe(200);
    const stored = await pool.query<{ display_name: string }>(
      'SELECT display_name FROM nodes WHERE node_id = $1',
      [(response.json() as { node_id: string }).node_id],
    );
    // No intended name, so the host's own name stands.
    expect(stored.rows[0]?.display_name).toBe('operator-issued');
  });
});

describe('audit', () => {
  it('records creation and cancellation without the capability', async () => {
    const session = await login('owner@example.com');
    const { installation, code } = await createInstallation(session);
    await app.inject({
      method: 'POST',
      url: `/api/v1/node-installations/${installation.installation_id as string}/cancel`,
      headers: headers(session, true),
    });

    const audit = await pool.query<{ action: string; detail: unknown }>(
      "SELECT action, detail FROM audit_log WHERE action LIKE 'node_installation.%' ORDER BY action",
    );
    expect(audit.rows.map((row) => row.action)).toEqual([
      'node_installation.cancel',
      'node_installation.create',
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain(code);
  });
});

describe('expiry sweeping', () => {
  it('retires an installation whose code ran out of time', async () => {
    const session = await login('owner@example.com');
    const { installation } = await createInstallation(session);
    await pool.query("UPDATE node_installations SET expires_at = now() - interval '1 minute'");

    expect(await nodeInstallationsRepo.expireOverdue(pool)).toBe(1);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/node-installations/${installation.installation_id as string}`,
      headers: headers(session),
    });
    expect(detail.json().installation.state).toBe('expired');

    // Sweeping again is a no-op rather than a second transition.
    expect(await nodeInstallationsRepo.expireOverdue(pool)).toBe(0);
  });
});
