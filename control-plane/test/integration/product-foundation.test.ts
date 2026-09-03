import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { nodeCanAuthorizeProvider } from '../../src/provider-authorization.js';

import {
  createInitialOwner,
  hashPassword,
  resolveSession,
  SESSION_COOKIE,
} from '../../src/auth.js';
import { changeMemberRole, disableMember } from '../../src/authorization.js';
import { buildApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createPool, migrate, rollbackAll, type Pool } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { NodeChannel } from '../../src/node-channel.js';
import {
  productAuditRepo,
  productCommandsRepo,
  productEnrollmentTokensRepo,
  productEventsRepo,
  productNodesRepo,
  productProjectsRepo,
  productRotationsRepo,
  productRunsRepo,
} from '../../src/product-repositories.js';
import {
  auditRepo,
  commandsRepo,
  enrollmentTokensRepo,
  eventsRepo,
  nodesRepo,
  projectsRepo,
  rotationsRepo,
  runsRepo,
} from '../../src/repositories.js';
import { commandFingerprint } from '../../src/protocol.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://asterism:asterism@127.0.0.1:55432/asterism_cp';
const ORIGIN = 'http://console.test';
const PASSWORD = 'correct horse battery staple';

let pool: Pool;
let app: FastifyInstance;
let config: Config;
let channel: NodeChannel;

function loadTestConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL,
    PUBLIC_BASE_URL: 'http://127.0.0.1:8080',
    ALLOWED_ORIGINS: ORIGIN,
    ASTERISM_OPERATOR_TOKEN: 'test-operator-token-that-is-long-enough-000000',
    ALLOW_PLAINTEXT: 'true',
    LOG_LEVEL: 'fatal',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }): string {
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  const pair = value?.split(';')[0];
  if (!pair) throw new Error('response did not set a session cookie');
  return pair;
}

function sessionToken(cookie: string): string {
  return cookie.slice(`${SESSION_COOKIE}=`.length);
}

async function owner(): Promise<string> {
  const created = await createInitialOwner(pool, {
    email: 'OWNER@Example.COM ',
    displayName: 'Initial Owner',
    password: PASSWORD,
  });
  return created.userId;
}

async function login(
  email = 'owner@example.com',
  password = PASSWORD,
): Promise<{ cookie: string; csrf: string; status: number; body: Record<string, unknown> }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN },
    payload: { email, password },
  });
  const body = JSON.parse(response.body) as Record<string, unknown>;
  return {
    cookie: response.statusCode === 200 ? cookieFrom(response) : '',
    csrf: typeof body.csrf_token === 'string' ? body.csrf_token : '',
    status: response.statusCode,
    body,
  };
}

beforeAll(async () => {
  config = loadTestConfig();
  pool = createPool(DATABASE_URL, 5);
  await rollbackAll(pool).catch(() => undefined);
  await migrate(pool);
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
    'TRUNCATE login_attempts, browser_sessions, invitations, memberships, users, ' +
      'run_events, runs, remote_commands, projects, node_sessions, identity_rotations, ' +
      'enrollment_tokens, audit_log, nodes RESTART IDENTITY CASCADE',
  );
  await pool.query(`DELETE FROM organizations WHERE organization_id <> 'org_bootstrap'`);
});

describe('H1 product identity', () => {
  it('bootstraps exactly one normalized Owner with an Argon2id password hash', async () => {
    expect(await app.inject('/api/v1/auth/bootstrap-status').then((r) => r.json())).toEqual({
      required: true,
    });
    const userId = await owner();
    const stored = await pool.query<{
      normalized_email: string;
      password_hash: string;
      role: string;
    }>(
      `SELECT u.normalized_email, u.password_hash, m.role
       FROM users u JOIN memberships m USING (user_id) WHERE u.user_id = $1`,
      [userId],
    );
    expect(stored.rows[0]?.normalized_email).toBe('owner@example.com');
    expect(stored.rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
    expect(stored.rows[0]?.password_hash).not.toContain(PASSWORD);
    expect(stored.rows[0]?.role).toBe('owner');
    await expect(
      createInitialOwner(pool, {
        email: 'second@example.com',
        displayName: 'Second',
        password: PASSWORD,
      }),
    ).rejects.toThrow('bootstrap owner already exists');
  });

  it('enforces Origin, generic login failure, secure cookie properties, and CSRF', async () => {
    await owner();
    const missingOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'owner@example.com', password: PASSWORD },
    });
    expect(missingOrigin.statusCode).toBe(403);

    const unknown = await login('missing@example.com', 'incorrect password');
    const wrong = await login('owner@example.com', 'incorrect password');
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);

    const authenticated = await login();
    expect(authenticated.status).toBe(200);
    const setCookie = authenticated.cookie;
    const rotatedLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ORIGIN, cookie: authenticated.cookie },
      payload: { email: 'owner@example.com', password: PASSWORD },
    });
    const rawSetCookie = rotatedLogin.headers['set-cookie'];
    const activeCookie = cookieFrom(rotatedLogin);
    const activeCsrf = rotatedLogin.json().csrf_token as string;
    expect(String(rawSetCookie)).toContain('HttpOnly');
    expect(String(rawSetCookie)).toContain('SameSite=Lax');
    expect(setCookie).not.toContain(PASSWORD);

    const missingCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { origin: ORIGIN, cookie: activeCookie },
    });
    const wrongCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { origin: ORIGIN, cookie: activeCookie, 'x-csrf-token': 'wrong' },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(wrongCsrf.statusCode).toBe(403);

    const loggedOut = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { origin: ORIGIN, cookie: activeCookie, 'x-csrf-token': activeCsrf },
    });
    expect(loggedOut.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/auth/session',
          headers: { cookie: activeCookie },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('rotates login sessions and revokes every old session after a password change', async () => {
    await owner();
    const first = await login();
    const rotated = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ORIGIN, cookie: first.cookie },
      payload: { email: 'owner@example.com', password: PASSWORD },
    });
    const second = { cookie: cookieFrom(rotated), csrf: rotated.json().csrf_token as string };
    const independent = await login();
    expect(await resolveSession(pool, config, sessionToken(first.cookie))).toBeNull();

    const changed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { origin: ORIGIN, cookie: second.cookie, 'x-csrf-token': second.csrf },
      payload: { current_password: PASSWORD, new_password: 'a newer correct horse password' },
    });
    expect(changed.statusCode).toBe(200);
    const replacementCookie = cookieFrom(changed);
    expect(await resolveSession(pool, config, sessionToken(second.cookie))).toBeNull();
    expect(await resolveSession(pool, config, sessionToken(independent.cookie))).toBeNull();
    expect(await resolveSession(pool, config, sessionToken(replacementCookie))).not.toBeNull();
    expect((await login('owner@example.com', PASSWORD)).status).toBe(401);
    expect((await login('owner@example.com', 'a newer correct horse password')).status).toBe(200);
  });

  it('rate limits failed login by account without changing the generic response', async () => {
    await owner();
    const limitedConfig = loadTestConfig({ LOGIN_ACCOUNT_LIMIT: '2' });
    const limitedChannel = new NodeChannel(pool, limitedConfig, createLogger('fatal'));
    const limitedApp = await buildApp({
      pool,
      config: limitedConfig,
      log: createLogger('fatal'),
      channel: limitedChannel,
    });
    await limitedApp.ready();
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await limitedApp.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: { origin: ORIGIN },
          payload: { email: 'owner@example.com', password: 'wrong password' },
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({
          error: 'login_failed',
          message: 'invalid email or password',
        });
      }
      const blockedCorrectPassword = await limitedApp.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin: ORIGIN },
        payload: { email: 'owner@example.com', password: PASSWORD },
      });
      expect(blockedCorrectPassword.statusCode).toBe(401);
    } finally {
      await limitedApp.close();
      await limitedChannel.stop();
    }
  });

  it('removes access immediately for disabled users and memberships', async () => {
    const userId = await owner();
    const first = await login();
    await pool.query('UPDATE users SET enabled = FALSE WHERE user_id = $1', [userId]);
    expect(await resolveSession(pool, config, sessionToken(first.cookie))).toBeNull();

    await pool.query('UPDATE users SET enabled = TRUE WHERE user_id = $1', [userId]);
    const second = await login();
    await pool.query(
      `UPDATE memberships SET disabled_at = now() WHERE organization_id = 'org_bootstrap' AND user_id = $1`,
      [userId],
    );
    const context = await resolveSession(pool, config, sessionToken(second.cookie));
    expect(context?.organization).toBeNull();
    expect(context?.permissions).toEqual([]);
  });
});

describe('H1 organization invariants', () => {
  it('assigns compatibility records to the explicit bootstrap organization', async () => {
    await pool.query(
      `INSERT INTO nodes (node_id, display_name, public_key, fingerprint)
       VALUES ('legacy-node', 'Legacy', 'key', repeat('a', 64))`,
    );
    const node = await pool.query<{ organization_id: string }>(
      `SELECT organization_id FROM nodes WHERE node_id = 'legacy-node'`,
    );
    expect(node.rows[0]?.organization_id).toBe('org_bootstrap');
  });

  it('requires explicit organization selection when a user has several memberships', async () => {
    const userId = await owner();
    const organizationId = randomUUID();
    await pool.query(
      `INSERT INTO organizations (organization_id, slug, display_name) VALUES ($1, 'second', 'Second')`,
      [organizationId],
    );
    await pool.query(
      `INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'viewer')`,
      [organizationId, userId],
    );
    const authenticated = await login();
    expect(authenticated.body.active_organization).toBeNull();
    const selected = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations/select',
      headers: {
        origin: ORIGIN,
        cookie: authenticated.cookie,
        'x-csrf-token': authenticated.csrf,
      },
      payload: { organization_id: organizationId },
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json().active_organization.organization_id).toBe(organizationId);
    expect(await resolveSession(pool, config, sessionToken(authenticated.cookie))).toBeNull();
  });

  it('prevents Admin Owner grants and protects the last Owner', async () => {
    const ownerId = await owner();
    const adminId = randomUUID();
    await pool.query(
      `INSERT INTO users (user_id, normalized_email, display_name, password_hash)
       VALUES ($1, 'admin@example.com', 'Admin', $2)`,
      [adminId, await hashPassword(PASSWORD)],
    );
    await pool.query(
      `INSERT INTO memberships (organization_id, user_id, role)
       VALUES ('org_bootstrap', $1, 'admin')`,
      [adminId],
    );
    const adminLogin = await login('admin@example.com');
    const adminContext = await resolveSession(pool, config, sessionToken(adminLogin.cookie));
    if (!adminContext) throw new Error('admin session missing');
    expect(await changeMemberRole(pool, adminContext, adminId, 'owner')).toEqual({
      ok: false,
      status: 403,
      code: 'owner_grant_forbidden',
    });
    expect(await disableMember(pool, adminContext, ownerId)).toEqual({
      ok: false,
      status: 409,
      code: 'last_owner',
    });

    const ownerLogin = await login();
    const ownerContext = await resolveSession(pool, config, sessionToken(ownerLogin.cookie));
    if (!ownerContext) throw new Error('owner session missing');
    expect(await changeMemberRole(pool, ownerContext, adminId, 'owner')).toEqual({ ok: true });
  });

  it('returns no cross-tenant resource through every product repository', async () => {
    const secondOrganizationId = randomUUID();
    await pool.query(
      `INSERT INTO organizations (organization_id, slug, display_name)
       VALUES ($1, 'isolated', 'Overlapping Name')`,
      [secondOrganizationId],
    );
    const firstNode = await nodesRepo.create(pool, {
      nodeId: 'tenant-a-node',
      displayName: 'Overlapping Name',
      publicKey: 'a',
      fingerprint: 'a'.repeat(64),
      organizationId: 'org_bootstrap',
    });
    const secondNode = await nodesRepo.create(pool, {
      nodeId: 'tenant-b-node',
      displayName: 'Overlapping Name',
      publicKey: 'b',
      fingerprint: 'b'.repeat(64),
      organizationId: secondOrganizationId,
    });
    const firstProject = await projectsRepo.upsert(pool, {
      nodeId: firstNode.node_id,
      nodeProjectId: 'same-project-name',
      displayName: 'Overlapping Name',
      enabled: true,
      metadata: {},
    });
    const secondProject = await projectsRepo.upsert(pool, {
      nodeId: secondNode.node_id,
      nodeProjectId: 'same-project-name',
      displayName: 'Overlapping Name',
      enabled: true,
      metadata: {},
    });
    const payload = { input: 'safe metadata' };
    const firstCommand = await commandsRepo.create(pool, {
      nodeId: firstNode.node_id,
      projectId: firstProject.project_id,
      commandType: 'runs.create',
      payload,
      digest: commandFingerprint('runs.create', 'same-project-name', payload),
    });
    const secondCommand = await commandsRepo.create(pool, {
      nodeId: secondNode.node_id,
      projectId: secondProject.project_id,
      commandType: 'runs.create',
      payload,
      digest: commandFingerprint('runs.create', 'same-project-name', payload),
    });
    const firstRun = await runsRepo.create(pool, {
      nodeId: firstNode.node_id,
      projectId: firstProject.project_id,
      metadata: {},
      createCommandId: firstCommand.command_id,
    });
    const secondRun = await runsRepo.create(pool, {
      nodeId: secondNode.node_id,
      projectId: secondProject.project_id,
      metadata: {},
      createCommandId: secondCommand.command_id,
    });
    await pool.query(`UPDATE runs SET node_run_id = run_id WHERE run_id IN ($1, $2)`, [
      firstRun.run_id,
      secondRun.run_id,
    ]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await eventsRepo.insert(client, {
        nodeId: secondNode.node_id,
        runId: secondRun.run_id,
        seq: 1,
        projectId: secondProject.node_project_id,
        eventType: 'message.delta',
        recordedAt: Date.now(),
        payload: { text: 'tenant-b' },
        source: 'test',
      });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const secondToken = await enrollmentTokensRepo.create(pool, {
      ttlMs: 60_000,
      organizationId: secondOrganizationId,
    });
    const secondRotation = await rotationsRepo.open(pool, {
      nodeId: secondNode.node_id,
      oldFingerprint: secondNode.fingerprint,
      proposedPublicKey: 'new',
      proposedFingerprint: 'c'.repeat(64),
      challengeNonce: 'nonce',
      ttlMs: 60_000,
    });
    await auditRepo.record(pool, {
      action: 'tenant-b.action',
      actor: 'test',
      result: 'success',
      organizationId: secondOrganizationId,
    });

    expect(await productNodesRepo.byId(pool, 'org_bootstrap', secondNode.node_id)).toBeNull();
    expect(
      await productProjectsRepo.byId(pool, 'org_bootstrap', secondProject.project_id),
    ).toBeNull();
    expect(
      await productCommandsRepo.byId(pool, 'org_bootstrap', secondCommand.command_id),
    ).toBeNull();
    expect(await productRunsRepo.byId(pool, 'org_bootstrap', secondRun.run_id)).toBeNull();
    expect(await productEventsRepo.since(pool, 'org_bootstrap', secondRun.run_id, 0, 100)).toEqual(
      [],
    );
    expect(
      await productEnrollmentTokensRepo.byId(pool, 'org_bootstrap', secondToken.record.token_id),
    ).toBeNull();
    expect(
      await productRotationsRepo.listForNode(pool, 'org_bootstrap', secondNode.node_id),
    ).toEqual([]);
    expect(await productAuditRepo.recent(pool, 'org_bootstrap', 100)).toEqual([]);

    expect((await productNodesRepo.list(pool, 'org_bootstrap')).map((row) => row.node_id)).toEqual([
      firstNode.node_id,
    ]);
    expect(
      (await productRunsRepo.list(pool, 'org_bootstrap', 100)).map((row) => row.run_id),
    ).toEqual([firstRun.run_id]);
    expect(secondRotation.node_id).toBe(secondNode.node_id);
  });
});

describe('what a reconnection may not forget', () => {
  it('keeps the capabilities a Node advertised, and adds the handshake digest', async () => {
    // The handshake carries only a digest, and writing it over the column left
    // `{digest: ...}` behind until `capabilities.get` came back. Anything that
    // read capabilities in that window saw a Node that could do nothing --
    // including the code deciding whether to ask a Node about its provider,
    // which reads them in exactly that window and so never once asked.
    await nodesRepo.create(pool, {
      nodeId: 'reconnecting-node',
      displayName: 'Reconnecting',
      publicKey: 'r',
      fingerprint: 'r'.repeat(64),
      organizationId: 'org_bootstrap',
    });

    await nodesRepo.recordCapabilities(pool, 'reconnecting-node', {
      provider: { kind: 'codex-cli', device_authorization: true },
      runtime_kinds: ['hermes-loop'],
    });

    await nodesRepo.recordSession(pool, 'reconnecting-node', {
      sessionId: 'sess-second',
      instanceId: 'instance-2',
      softwareVersion: '0.1.0',
      protocolVersion: 1,
      capabilities: { digest: 'sha256:whatever' },
    });

    const after = await nodesRepo.byId(pool, 'reconnecting-node');
    expect(nodeCanAuthorizeProvider(after?.capabilities)).toBe(true);
    expect((after?.capabilities as Record<string, unknown>).runtime_kinds).toEqual([
      'hermes-loop',
    ]);
    // And the digest is still recorded, because that is what the handshake had
    // to say.
    expect((after?.capabilities as Record<string, unknown>).digest).toBe('sha256:whatever');
  });
});
