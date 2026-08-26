import { createHash, randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword, SESSION_COOKIE } from '../../src/auth.js';
import { buildApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createPool, migrate, rollbackAll, type Pool } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { NodeChannel } from '../../src/node-channel.js';
import { commandFingerprint } from '../../src/protocol.js';
import {
  auditRepo,
  commandsRepo,
  eventsRepo,
  nodesRepo,
  projectsRepo,
  runsRepo,
} from '../../src/repositories.js';
import { runFailureFromEvent } from '../../src/node-channel.js';
import type { Role } from '../../src/tenancy.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://asterism:asterism@127.0.0.1:55432/asterism_cp';
const ORIGIN = 'http://console.test';
const PASSWORD = 'correct horse battery staple';
const OPERATOR_TOKEN = 'test-operator-token-that-is-long-enough-000000';

let pool: Pool;
let app: FastifyInstance;
let config: Config;
let channel: NodeChannel;
let passwordHash: string;

interface LoginSession {
  cookie: string;
  csrf: string;
  userId: string;
}

function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL,
    PUBLIC_BASE_URL: 'http://127.0.0.1:8080',
    ALLOWED_ORIGINS: ORIGIN,
    ASTERISM_OPERATOR_TOKEN: OPERATOR_TOKEN,
    OPERATOR_COMPATIBILITY: 'true',
    ALLOW_PLAINTEXT: 'true',
    LOG_LEVEL: 'fatal',
    ...overrides,
  } as NodeJS.ProcessEnv);
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
  await pool.query(`INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)`, [
    organizationId,
    userId,
    role,
  ]);
  return userId;
}

async function login(email: string): Promise<LoginSession> {
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

function headers(session: LoginSession, csrf = false): Record<string, string> {
  return {
    cookie: session.cookie,
    ...(csrf ? { origin: ORIGIN, 'x-csrf-token': session.csrf } : {}),
  };
}

async function addOrganization(slug: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO organizations (organization_id, slug, display_name) VALUES ($1, $2, $3)`,
    [id, slug, 'Overlapping Name'],
  );
  return id;
}

async function addProjectFixture(organizationId: string, suffix: string) {
  const node = await nodesRepo.create(pool, {
    nodeId: `node-${suffix}`,
    displayName: 'Overlapping Name',
    publicKey: suffix,
    fingerprint: suffix.padEnd(64, suffix[0] ?? 'a').slice(0, 64),
    organizationId,
  });
  const project = await projectsRepo.upsert(pool, {
    nodeId: node.node_id,
    nodeProjectId: `project-${suffix}`,
    displayName: 'Overlapping Name',
    enabled: true,
    metadata: { runtime_state: 'ready' },
  });
  return { node, project };
}

async function addRunFixture(
  fixture: Awaited<ReturnType<typeof addProjectFixture>>,
  creatorUserId: string,
  status = 'running',
) {
  const payload = { input: 'fixture' };
  const command = await commandsRepo.create(pool, {
    nodeId: fixture.node.node_id,
    projectId: fixture.project.project_id,
    commandType: 'runs.create',
    payload,
    digest: commandFingerprint('runs.create', fixture.project.node_project_id, payload),
  });
  const run = await runsRepo.create(pool, {
    nodeId: fixture.node.node_id,
    projectId: fixture.project.project_id,
    metadata: { input_length: 7 },
    createCommandId: command.command_id,
    createdByUserId: creatorUserId,
  });
  await pool.query(
    `UPDATE runs SET node_run_id = $2, status = $3,
       finished_at = CASE WHEN $3 IN ('interrupted','lost','failed','completed','cancelled') THEN now() END
     WHERE run_id = $1`,
    [run.run_id, `arun-${run.run_id}`, status],
  );
  return (await runsRepo.byId(pool, run.run_id))!;
}

beforeAll(async () => {
  config = testConfig();
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
    'TRUNCATE login_attempts, browser_sessions, invitations, memberships, users, ' +
      'run_events, runs, remote_commands, projects, node_sessions, identity_rotations, ' +
      'enrollment_tokens, audit_log, nodes RESTART IDENTITY CASCADE',
  );
  await pool.query(`DELETE FROM organizations WHERE organization_id <> 'org_bootstrap'`);
  await addUser('org_bootstrap', 'owner@example.com', 'owner');
});

describe('H2 invitations and members', () => {
  it('returns an invitation once, stores only its digest, and accepts it once', async () => {
    const owner = await login('owner@example.com');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: headers(owner, true),
      payload: { email: 'New.User@Example.COM ', role: 'developer' },
    });
    expect(created.statusCode).toBe(201);
    const invitationUrl = created.json().invitation_url as string;
    const token = invitationUrl.split('/').at(-1)!;
    const stored = await pool.query<{ token_digest: string }>(
      'SELECT token_digest FROM invitations WHERE invitation_id = $1',
      [created.json().invitation_id],
    );
    expect(stored.rows[0]?.token_digest).toBe(createHash('sha256').update(token).digest('hex'));
    expect(stored.rows[0]?.token_digest).not.toBe(token);
    const audit = await pool.query('SELECT detail::text FROM audit_log');
    expect(JSON.stringify(audit.rows)).not.toContain(token);

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      headers: { origin: ORIGIN },
      payload: { token, display_name: 'New User', password: PASSWORD },
    });
    const replayed = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      headers: { origin: ORIGIN },
      payload: { token, display_name: 'New User', password: PASSWORD },
    });
    expect(accepted.statusCode).toBe(201);
    expect(replayed.statusCode).toBe(400);
    expect((await login('new.user@example.com')).userId).toBeTruthy();
  });

  it('allows Admin invitations but not Owner grants', async () => {
    await addUser('org_bootstrap', 'admin@example.com', 'admin');
    const admin = await login('admin@example.com');
    const ownerInvite = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: headers(admin, true),
      payload: { email: 'owner2@example.com', role: 'owner' },
    });
    const developerInvite = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: headers(admin, true),
      payload: { email: 'developer@example.com', role: 'developer' },
    });
    expect(ownerInvite.statusCode).toBe(403);
    expect(developerInvite.statusCode).toBe(201);
  });
});

describe('H2 tenant product API', () => {
  it('returns 404 for cross-tenant reads, mutations, SSE, members, and invitations', async () => {
    const firstOwner = await login('owner@example.com');
    const secondOrganization = await addOrganization('second');
    const secondOwnerId = await addUser(secondOrganization, 'second-owner@example.com', 'owner');
    const firstFixture = await addProjectFixture('org_bootstrap', 'a');
    const secondFixture = await addProjectFixture(secondOrganization, 'b');
    const secondRun = await addRunFixture(secondFixture, secondOwnerId, 'waiting_for_approval');
    const secondInvitation = await pool.query<{ invitation_id: string }>(
      `INSERT INTO invitations
         (invitation_id, organization_id, normalized_email, intended_role,
          token_digest, expires_at, invited_by)
       VALUES ($1, $2, 'hidden@example.com', 'viewer', $3, now() + interval '1 hour', $4)
       RETURNING invitation_id`,
      [randomUUID(), secondOrganization, 'f'.repeat(64), secondOwnerId],
    );

    const reads = [
      `/api/v1/nodes/${secondFixture.node.node_id}`,
      `/api/v1/nodes/${secondFixture.node.node_id}/rotations`,
      `/api/v1/projects/${secondFixture.project.project_id}`,
      `/api/v1/runs/${secondRun.run_id}`,
      `/api/v1/runs/${secondRun.run_id}/events`,
      `/api/v1/runs/${secondRun.run_id}/events/stream`,
    ];
    for (const url of reads) {
      const response = await app.inject({ method: 'GET', url, headers: headers(firstOwner) });
      expect(response.statusCode, url).toBe(404);
    }

    const mutations = [
      { url: `/api/v1/nodes/${secondFixture.node.node_id}/drain`, payload: {} },
      { url: `/api/v1/nodes/${secondFixture.node.node_id}/revoke`, payload: { reason: 'test' } },
      { url: `/api/v1/nodes/${secondFixture.node.node_id}/rotation-token`, payload: {} },
      { url: `/api/v1/runs/${secondRun.run_id}/approval`, payload: { choice: 'deny' } },
      { url: `/api/v1/runs/${secondRun.run_id}/cancel`, payload: {} },
      { url: `/api/v1/runs/${secondRun.run_id}/retry`, payload: {} },
    ];
    for (const mutation of mutations) {
      const response = await app.inject({
        method: 'POST',
        url: mutation.url,
        headers: headers(firstOwner, true),
        payload: mutation.payload,
      });
      expect(response.statusCode, mutation.url).toBe(404);
    }
    const member = await app.inject({
      method: 'DELETE',
      url: `/api/v1/members/${secondOwnerId}`,
      headers: headers(firstOwner, true),
    });
    const invitation = await app.inject({
      method: 'DELETE',
      url: `/api/v1/invitations/${secondInvitation.rows[0]?.invitation_id}`,
      headers: headers(firstOwner, true),
    });
    expect(member.statusCode).toBe(404);
    expect(invitation.statusCode).toBe(404);
    expect(
      (await app.inject({ url: '/api/v1/nodes', headers: headers(firstOwner) })).json().nodes,
    ).toHaveLength(1);
    expect(firstFixture.node.organization_id).toBe('org_bootstrap');
  });

  it('enforces Viewer read-only and Developer ownership for run mutations', async () => {
    const viewerId = await addUser('org_bootstrap', 'viewer@example.com', 'viewer');
    const developerId = await addUser('org_bootstrap', 'developer@example.com', 'developer');
    const otherDeveloperId = await addUser('org_bootstrap', 'other@example.com', 'developer');
    const fixture = await addProjectFixture('org_bootstrap', 'roles');
    const viewer = await login('viewer@example.com');
    const developer = await login('developer@example.com');
    const ownRun = await addRunFixture(fixture, developerId, 'running');
    const otherRun = await addRunFixture(fixture, otherDeveloperId, 'running');

    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/projects/${fixture.project.project_id}/runs`,
          headers: headers(viewer, true),
          payload: { input: 'no' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/runs/${otherRun.run_id}/cancel`,
          headers: headers(developer, true),
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    const ownCancel = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${ownRun.run_id}/cancel`,
      headers: headers(developer, true),
      payload: {},
    });
    expect(ownCancel.statusCode).toBe(202);
    expect(viewerId).toBeTruthy();
  });

  it('preserves run idempotency and queues approval, cancellation, and linked retry commands', async () => {
    const owner = await login('owner@example.com');
    const fixture = await addProjectFixture('org_bootstrap', 'commands');
    const request = {
      method: 'POST' as const,
      url: `/api/v1/projects/${fixture.project.project_id}/runs`,
      headers: headers(owner, true),
      payload: { input: 'Perform the task', idempotency_key: 'same-request' },
    };
    const created = await app.inject(request);
    const replayed = await app.inject(request);
    expect(created.statusCode).toBe(201);
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json().replayed).toBe(true);
    expect(created.json().run.created_by_user_id).toBe(owner.userId);

    const runId = created.json().run.run_id as string;
    await pool.query(
      `UPDATE runs SET node_run_id = 'arun-product', status = 'waiting_for_approval' WHERE run_id = $1`,
      [runId],
    );
    const approval = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${runId}/approval`,
      headers: headers(owner, true),
      payload: { choice: 'deny' },
    });
    expect(approval.statusCode).toBe(202);
    await pool.query(
      `UPDATE runs SET status = 'interrupted', finished_at = now() WHERE run_id = $1`,
      [runId],
    );
    const retry = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${runId}/retry`,
      headers: headers(owner, true),
      payload: {},
    });
    expect(retry.statusCode).toBe(202);
    expect(retry.json().run.retry_of_run_id).toBe(runId);
    const types = await pool.query<{ command_type: string }>(
      `SELECT command_type FROM remote_commands WHERE organization_id = 'org_bootstrap'`,
    );
    expect(types.rows.map((row) => row.command_type)).toEqual(
      expect.arrayContaining(['runs.create', 'approvals.resolve', 'runs.retry']),
    );
  });

  it('replays terminal SSE strictly after Last-Event-ID', async () => {
    const owner = await login('owner@example.com');
    const fixture = await addProjectFixture('org_bootstrap', 'sse');
    const run = await addRunFixture(fixture, owner.userId, 'completed');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const seq of [1, 2, 3]) {
        await eventsRepo.insert(client, {
          nodeId: fixture.node.node_id,
          runId: run.run_id,
          seq,
          projectId: fixture.project.node_project_id,
          eventType: 'message.delta',
          recordedAt: Date.now(),
          payload: { text: String(seq) },
          source: 'test',
        });
      }
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const streamed = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${run.run_id}/events/stream`,
      headers: { ...headers(owner), 'last-event-id': '1' },
    });
    expect(streamed.statusCode).toBe(200);
    expect(streamed.body).not.toContain('id: 1\n');
    expect(streamed.body).toContain('id: 2\n');
    expect(streamed.body).toContain('id: 3\n');
  });

  it('scopes and audits compatibility mode and hides it when disabled', async () => {
    const secondOrganization = await addOrganization('compat-other');
    await addProjectFixture('org_bootstrap', 'compat-a');
    await addProjectFixture(secondOrganization, 'compat-b');
    const response = await app.inject({
      method: 'GET',
      url: '/v1/nodes',
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().nodes).toHaveLength(1);
    expect(response.headers.deprecation).toBe('true');
    const audit = await pool.query<{ organization_id: string }>(
      `SELECT organization_id FROM audit_log WHERE action = 'operator_compatibility.use'`,
    );
    expect(audit.rows).toEqual([{ organization_id: 'org_bootstrap' }]);

    const disabledConfig = testConfig({ OPERATOR_COMPATIBILITY: 'false' });
    const disabledChannel = new NodeChannel(pool, disabledConfig, createLogger('fatal'));
    const disabled = await buildApp({
      pool,
      config: disabledConfig,
      log: createLogger('fatal'),
      channel: disabledChannel,
    });
    await disabled.ready();
    try {
      expect(
        (
          await disabled.inject({
            method: 'GET',
            url: '/v1/nodes',
            headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await disabled.close();
      await disabledChannel.stop();
    }
  });

  it('filters tenant audit deterministically without returning another organization', async () => {
    const owner = await login('owner@example.com');
    const secondOrganization = await addOrganization('audit-other');
    await auditRepo.record(pool, {
      action: 'visible.action',
      actor: owner.userId,
      actorUserId: owner.userId,
      targetType: 'run',
      targetId: 'visible',
      result: 'success',
      correlationId: 'visible-correlation',
      organizationId: 'org_bootstrap',
    });
    await auditRepo.record(pool, {
      action: 'hidden.action',
      actor: 'hidden',
      result: 'success',
      organizationId: secondOrganization,
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/audit?action=visible.action&correlation_id=visible-correlation&limit=1',
      headers: headers(owner),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().entries).toHaveLength(1);
    expect(response.body).toContain('visible.action');
    expect(response.body).not.toContain('hidden.action');
  });
});

describe('project chat sessions', () => {
  /** Send a chat message the way the composer does. */
  async function sendMessage(
    session: LoginSession,
    projectId: string,
    input: string,
    sessionId: string,
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/runs`,
      headers: { origin: ORIGIN, cookie: session.cookie, 'x-csrf-token': session.csrf },
      payload: { input, session_id: sessionId, idempotency_key: randomUUID() },
    });
  }

  function chat(session: LoginSession, projectId: string) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/chat`,
      headers: { origin: ORIGIN, cookie: session.cookie },
    });
  }

  it('persists session_id as a first-class column, not only in metadata', async () => {
    const owner = await login('owner@example.com');
    const fixture = await addProjectFixture('org_bootstrap', 'chatcol');
    const sessionId = randomUUID();

    const created = await sendMessage(owner, fixture.project.project_id, 'first', sessionId);
    expect(created.statusCode).toBe(201);
    expect(created.json().run.session_id).toBe(sessionId);

    const stored = await pool.query<{ session_id: string; meta: string | null }>(
      `SELECT session_id, request_metadata ->> 'session_id' AS meta FROM runs WHERE run_id = $1`,
      [created.json().run.run_id],
    );
    expect(stored.rows[0]?.session_id).toBe(sessionId);
    // The metadata copy stays for clients and rows that predate the column.
    expect(stored.rows[0]?.meta).toBe(sessionId);
  });

  it('reuses one session across messages and returns them chronologically', async () => {
    const owner = await login('owner@example.com');
    const fixture = await addProjectFixture('org_bootstrap', 'chatorder');
    const sessionId = randomUUID();

    const first = await sendMessage(owner, fixture.project.project_id, 'turn one', sessionId);
    const second = await sendMessage(owner, fixture.project.project_id, 'turn two', sessionId);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);

    const response = await chat(owner, fixture.project.project_id);
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      session_id: string;
      runs: { run_id: string; session_id: string; submitted_input: string }[];
    };

    expect(body.session_id).toBe(sessionId);
    expect(body.runs).toHaveLength(2);
    expect(body.runs.map((run) => run.run_id)).toEqual([
      first.json().run.run_id,
      second.json().run.run_id,
    ]);
    // The prompt is joined back from the create command, not duplicated on the run.
    expect(body.runs.map((run) => run.submitted_input)).toEqual(['turn one', 'turn two']);
    expect(new Set(body.runs.map((run) => run.session_id))).toEqual(new Set([sessionId]));
  });

  it('resolves the active conversation as the newest run carrying a session', async () => {
    const owner = await login('owner@example.com');
    const fixture = await addProjectFixture('org_bootstrap', 'chatactive');

    // A project nobody has chatted with has no conversation yet.
    const empty = await chat(owner, fixture.project.project_id);
    expect(empty.json().session_id).toBeNull();
    expect(empty.json().runs).toEqual([]);

    const older = randomUUID();
    const newer = randomUUID();
    await sendMessage(owner, fixture.project.project_id, 'older', older);
    await sendMessage(owner, fixture.project.project_id, 'newer', newer);

    const resolved = await chat(owner, fixture.project.project_id);
    expect(resolved.json().session_id).toBe(newer);
    // Only the active conversation is returned, not every session ever used.
    expect(resolved.json().runs).toHaveLength(1);
  });

  it('keeps legacy runs without a session visible and out of the conversation', async () => {
    const owner = await login('owner@example.com');
    const fixture = await addProjectFixture('org_bootstrap', 'chatlegacy');
    const legacy = await addRunFixture(fixture, owner.userId, 'completed');
    expect(legacy.session_id).toBeNull();

    const sessionId = randomUUID();
    await sendMessage(owner, fixture.project.project_id, 'chat message', sessionId);

    const body = (await chat(owner, fixture.project.project_id)).json() as {
      runs: { run_id: string }[];
    };
    expect(body.runs.map((run) => run.run_id)).not.toContain(legacy.run_id);

    // The legacy run remains addressable through the ordinary run views.
    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/runs?project_id=${fixture.project.project_id}`,
      headers: { origin: ORIGIN, cookie: owner.cookie },
    });
    expect(listed.json().runs.map((run: { run_id: string }) => run.run_id)).toContain(
      legacy.run_id,
    );
  });

  it('keeps a retry in the same conversation as the turn it repeats', async () => {
    const owner = await login('owner@example.com');
    const fixture = await addProjectFixture('org_bootstrap', 'chatretry');
    const sessionId = randomUUID();

    const created = await sendMessage(owner, fixture.project.project_id, 'do work', sessionId);
    const originalId = created.json().run.run_id as string;
    // Only an interrupted or lost run may be retried.
    await pool.query(
      `UPDATE runs SET node_run_id = 'arun_chat', status = 'interrupted', finished_at = now()
       WHERE run_id = $1`,
      [originalId],
    );

    const retried = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${originalId}/retry`,
      headers: { origin: ORIGIN, cookie: owner.cookie, 'x-csrf-token': owner.csrf },
    });
    // Retry is accepted for dispatch rather than created synchronously.
    expect(retried.statusCode).toBe(202);
    const replacement = retried.json().run as {
      run_id: string;
      session_id: string;
      retry_of_run_id: string;
    };

    expect(replacement.run_id).not.toBe(originalId);
    expect(replacement.retry_of_run_id).toBe(originalId);
    expect(replacement.session_id).toBe(sessionId);

    // Two runs, one conversational turn: the retry is another attempt, not a
    // second user message.
    const body = (await chat(owner, fixture.project.project_id)).json() as {
      runs: { run_id: string; retry_of_run_id: string | null }[];
    };
    expect(body.runs).toHaveLength(2);
    expect(body.runs.filter((run) => run.retry_of_run_id === null)).toHaveLength(1);
  });

  it('refuses a session identifier the schema does not accept', async () => {
    const owner = await login('owner@example.com');
    const fixture = await addProjectFixture('org_bootstrap', 'chatinvalid');
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${fixture.project.project_id}/runs`,
      headers: { origin: ORIGIN, cookie: owner.cookie, 'x-csrf-token': owner.csrf },
      payload: { input: 'x', session_id: 'x'.repeat(129) },
    });
    expect(response.statusCode).toBe(400);
  });

  it('never returns another organization or project conversation', async () => {
    const owner = await login('owner@example.com');
    const otherOrg = await addOrganization('chat-foreign');
    const foreign = await addProjectFixture(otherOrg, 'chatforeign');
    const mine = await addProjectFixture('org_bootstrap', 'chatmine');

    // A foreign project is not visible at all.
    const crossTenant = await chat(owner, foreign.project.project_id);
    expect(crossTenant.statusCode).toBe(404);

    // A sibling project's conversation does not leak into this one.
    const sibling = await addProjectFixture('org_bootstrap', 'chatsibling');
    await sendMessage(owner, sibling.project.project_id, 'sibling talk', randomUUID());
    const isolated = await chat(owner, mine.project.project_id);
    expect(isolated.json().session_id).toBeNull();
    expect(isolated.json().runs).toEqual([]);
  });

  it('requires run.read to open a conversation', async () => {
    const fixture = await addProjectFixture('org_bootstrap', 'chatperm');
    const anonymous = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fixture.project.project_id}/chat`,
      headers: { origin: ORIGIN },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('a failed run keeps the reason it failed', () => {
  // Hermes sends the explanation on `run.failed` and then ends the run with a
  // separate event that carries only a status. Replayed here in that order,
  // through the same two repository calls the ingestion makes, because the
  // order is what makes this easy to get wrong: a later write that did not
  // preserve the reason would leave the console with nothing to show.
  it('records the reason before the run ends, and does not lose it when it does', async () => {
    const owner = await addUser('org_bootstrap', 'reason-owner@example.com', 'owner');
    const fixture = await addProjectFixture('org_bootstrap', 'r');
    const run = await addRunFixture(fixture, owner);

    const failed = runFailureFromEvent('run.failed', {
      event: 'run.failed',
      error: '⚠️ Provider authentication failed: Codex provider quota exhausted (429).',
    });
    expect(failed).not.toBeNull();
    await runsRepo.recordFailure(pool, run.run_id, failed!);

    const midway = await runsRepo.byId(pool, run.run_id);
    expect(midway?.error_message).toContain('quota exhausted');
    expect(midway?.status).toBe('running');

    await runsRepo.setStatus(pool, run.run_id, 'failed', {});

    const ended = await runsRepo.byId(pool, run.run_id);
    expect(ended?.status).toBe('failed');
    expect(ended?.error_message).toContain('quota exhausted');
    expect(ended?.finished_at).not.toBeNull();
  });

  // A Node-side refusal arrives already attached to the terminal event, so it
  // travels with the status change instead.
  it('takes a reason that arrives with the terminal event', async () => {
    const owner = await addUser('org_bootstrap', 'conflict-owner@example.com', 'owner');
    const fixture = await addProjectFixture('org_bootstrap', 'c');
    const run = await addRunFixture(fixture, owner);

    const failure = runFailureFromEvent('asterism.run.terminal', {
      status: 'failed',
      error: 'run_conflict',
      message: 'project already has an active run',
    });
    await runsRepo.setStatus(pool, run.run_id, 'failed', failure ?? {});

    const ended = await runsRepo.byId(pool, run.run_id);
    expect(ended?.error_code).toBe('run_conflict');
    expect(ended?.error_message).toBe('project already has an active run');
  });

  it('leaves a run that simply completed with no reason attached', async () => {
    const owner = await addUser('org_bootstrap', 'clean-owner@example.com', 'owner');
    const fixture = await addProjectFixture('org_bootstrap', 'n');
    const run = await addRunFixture(fixture, owner);

    expect(runFailureFromEvent('asterism.run.terminal', { status: 'completed' })).toBeNull();
    await runsRepo.setStatus(pool, run.run_id, 'completed', {});

    const ended = await runsRepo.byId(pool, run.run_id);
    expect(ended?.status).toBe('completed');
    expect(ended?.error_message).toBeNull();
    expect(ended?.error_code).toBeNull();
  });
});
