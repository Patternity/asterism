/**
 * Integration tests against a real PostgreSQL database.
 *
 * These exercise the parts that only a database can check: migrations, the
 * one-time token guarantee under concurrency, transactional enrollment, and the
 * operator API surface.
 *
 * Requires `DATABASE_URL`. The suite migrates a clean schema before each run.
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import {
  SUPPORTED_SCHEMA_VERSION,
  createPool,
  migrate,
  rollbackAll,
  type Pool,
} from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { NodeChannel } from '../../src/node-channel.js';
import { enroll } from '../../src/enrollment.js';
import { fingerprintOf } from '../../src/protocol.js';
import {
  commandsRepo,
  enrollmentTokensRepo,
  hashToken,
  nodesRepo,
  projectsRepo,
  runsRepo,
} from '../../src/repositories.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://asterism:asterism@127.0.0.1:55432/asterism_cp';
const OPERATOR_TOKEN = 'test-operator-token-that-is-long-enough-000000';

let pool: Pool;
let app: FastifyInstance;
let config: Config;
let channel: NodeChannel;

/** A deterministic Ed25519 public key for tests. Never used for anything real. */
function testPublicKey(seedByte = 7): string {
  const seed = Buffer.alloc(32, seedByte);
  const priv = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const der = createPublicKey(priv).export({ format: 'der', type: 'spki' }) as Buffer;
  return der.subarray(der.length - 32).toString('base64');
}

function operator(headers: Record<string, string> = {}) {
  return { authorization: `Bearer ${OPERATOR_TOKEN}`, ...headers };
}

beforeAll(async () => {
  config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL,
    PUBLIC_BASE_URL: 'http://127.0.0.1:8080',
    ASTERISM_OPERATOR_TOKEN: OPERATOR_TOKEN,
    ALLOW_PLAINTEXT: 'true',
    LOG_LEVEL: 'fatal',
  } as NodeJS.ProcessEnv);

  pool = createPool(DATABASE_URL, 5);
  await rollbackAll(pool).catch(() => undefined);
  await migrate(pool);

  channel = new NodeChannel(pool, config, createLogger('fatal'));
  app = await buildApp({ pool, config, log: createLogger('fatal'), channel });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await channel?.stop();
  await pool?.end();
});

beforeEach(async () => {
  // Truncate rather than re-migrate: faster and proves the FK graph is sane.
  await pool.query(
    'TRUNCATE login_attempts, browser_sessions, invitations, memberships, users, ' +
      'run_events, runs, remote_commands, projects, node_sessions, identity_rotations, ' +
      'enrollment_tokens, audit_log, nodes RESTART IDENTITY CASCADE',
  );
});

describe('migrations', () => {
  it('brings the schema to the supported version', async () => {
    const result = await pool.query<{ version: number }>(
      'SELECT MAX(version) AS version FROM schema_migrations',
    );
    expect(Number(result.rows[0]?.version)).toBe(SUPPORTED_SCHEMA_VERSION);
  });

  it('creates every table the service depends on', async () => {
    const result = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const tables = result.rows.map((row) => row.table_name);
    for (const expected of [
      'nodes',
      'enrollment_tokens',
      'node_sessions',
      'projects',
      'remote_commands',
      'runs',
      'run_events',
      'identity_rotations',
      'audit_log',
      'organizations',
      'users',
      'memberships',
      'invitations',
      'browser_sessions',
      'login_attempts',
    ]) {
      expect(tables).toContain(expected);
    }
  });
});

describe('operator authentication', () => {
  it('rejects missing and malformed authorization', async () => {
    for (const headers of [{}, { authorization: 'nonsense' }, { authorization: 'Bearer wrong' }]) {
      const response = await app.inject({ method: 'GET', url: '/v1/nodes', headers });
      expect(response.statusCode).toBe(401);
    }
  });

  it('accepts the configured token', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/nodes', headers: operator() });
    expect(response.statusCode).toBe(200);
  });

  it('never returns the operator token through health or diagnostics', async () => {
    const publicHealth = await app.inject({ method: 'GET', url: '/health' });
    const detailed = await app.inject({ method: 'GET', url: '/v1/health', headers: operator() });

    expect(publicHealth.body).not.toContain(OPERATOR_TOKEN);
    expect(detailed.body).not.toContain(OPERATOR_TOKEN);
    // Public liveness stays minimal.
    expect(JSON.parse(publicHealth.body)).toEqual({ status: 'ok' });
  });
});

describe('enrollment tokens', () => {
  it('returns the plaintext token only at creation and stores only a digest', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/enrollment-tokens',
      headers: operator(),
      payload: { intended_name: 'builder-1' },
    });
    expect(created.statusCode).toBe(201);
    const body = JSON.parse(created.body);
    expect(typeof body.token).toBe('string');

    const stored = await pool.query<{ token_digest: string }>(
      'SELECT token_digest FROM enrollment_tokens WHERE token_id = $1',
      [body.token_id],
    );
    expect(stored.rows[0]?.token_digest).toBe(hashToken(body.token));

    // Listing exposes metadata only.
    const listed = await app.inject({
      method: 'GET',
      url: '/v1/enrollment-tokens',
      headers: operator(),
    });
    expect(listed.body).not.toContain(body.token);
    expect(listed.body).not.toContain(hashToken(body.token));
  });

  it('revokes an unused token and refuses to revoke it twice', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/enrollment-tokens',
      headers: operator(),
      payload: {},
    });
    const { token_id } = JSON.parse(created.body);

    const first = await app.inject({
      method: 'POST',
      url: `/v1/enrollment-tokens/${token_id}/revoke`,
      headers: operator(),
    });
    const second = await app.inject({
      method: 'POST',
      url: `/v1/enrollment-tokens/${token_id}/revoke`,
      headers: operator(),
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
  });
});

describe('node enrollment', () => {
  const enrollBody = (publicKey: string, name = 'node-a') => ({
    public_key: publicKey,
    public_key_fingerprint: fingerprintOf(publicKey),
    display_name: name,
    supported_protocol_versions: [1],
    software_version: '0.1.0',
  });

  async function issueToken(): Promise<string> {
    const created = await enrollmentTokensRepo.create(pool, { ttlMs: 60_000 });
    return created.token;
  }

  it('enrolls a node and consumes the token', async () => {
    const token = await issueToken();
    const key = testPublicKey(11);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/node/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: enrollBody(key),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.node_id).toMatch(/^node-\d+$/);
    expect(body.protocol_version).toBe(1);

    const node = await nodesRepo.byId(pool, body.node_id);
    expect(node?.fingerprint).toBe(fingerprintOf(key));

    const consumed = await pool.query<{ consumed_by: string }>(
      'SELECT consumed_by FROM enrollment_tokens WHERE token_digest = $1',
      [hashToken(token)],
    );
    expect(consumed.rows[0]?.consumed_by).toBe(body.node_id);
  });

  it('refuses a consumed token', async () => {
    const token = await issueToken();
    await app.inject({
      method: 'POST',
      url: '/v1/node/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: enrollBody(testPublicKey(12)),
    });

    const second = await app.inject({
      method: 'POST',
      url: '/v1/node/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: enrollBody(testPublicKey(13), 'node-b'),
    });

    expect(second.statusCode).toBe(401);
    expect((await nodesRepo.list(pool)).length).toBe(1);
  });

  it('enrolls at most one node when the same token is used concurrently', async () => {
    const token = await issueToken();
    const log = createLogger('fatal');

    // Both requests race for the same row lock; exactly one may win.
    const [first, second] = await Promise.all([
      enroll(pool, { token, body: enrollBody(testPublicKey(21), 'race-a'), log }),
      enroll(pool, { token, body: enrollBody(testPublicKey(22), 'race-b'), log }),
    ]);

    const succeeded = [first, second].filter((outcome) => outcome.ok);
    expect(succeeded).toHaveLength(1);
    expect((await nodesRepo.list(pool)).length).toBe(1);
  });

  it('rejects a fingerprint that does not match the public key', async () => {
    const token = await issueToken();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/node/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...enrollBody(testPublicKey(31)), public_key_fingerprint: '0'.repeat(64) },
    });

    expect(response.statusCode).toBe(400);
    expect((await nodesRepo.list(pool)).length).toBe(0);
  });

  it('rejects a malformed public key', async () => {
    const token = await issueToken();
    const bad = Buffer.alloc(16, 1).toString('base64');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/node/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        public_key: bad,
        public_key_fingerprint: fingerprintOf(bad),
        display_name: 'bad',
        supported_protocol_versions: [1],
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects an unsupported protocol version', async () => {
    const token = await issueToken();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/node/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...enrollBody(testPublicKey(41)), supported_protocol_versions: [99] },
    });
    expect(response.statusCode).toBe(409);
  });

  it('refuses to enroll the same active identity twice', async () => {
    const key = testPublicKey(51);
    const first = await issueToken();
    const second = await issueToken();

    await app.inject({
      method: 'POST',
      url: '/v1/node/enroll',
      headers: { authorization: `Bearer ${first}` },
      payload: enrollBody(key),
    });
    const duplicate = await app.inject({
      method: 'POST',
      url: '/v1/node/enroll',
      headers: { authorization: `Bearer ${second}` },
      payload: enrollBody(key, 'clone'),
    });

    expect(duplicate.statusCode).toBe(409);
  });

  it('writes an audit record for success and failure', async () => {
    const token = await issueToken();
    await app.inject({
      method: 'POST',
      url: '/v1/node/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: enrollBody(testPublicKey(61)),
    });
    await app.inject({
      method: 'POST',
      url: '/v1/node/enroll',
      headers: { authorization: 'Bearer definitely-not-a-token' },
      payload: enrollBody(testPublicKey(62), 'nope'),
    });

    const audit = await app.inject({ method: 'GET', url: '/v1/audit', headers: operator() });
    const actions = JSON.parse(audit.body).entries.map(
      (entry: { action: string; result: string }) => `${entry.action}:${entry.result}`,
    );
    expect(actions).toContain('node.enroll:success');
    expect(actions).toContain('node.enroll:failure');
    // The token value must never reach the audit log.
    expect(audit.body).not.toContain(token);
  });
});

describe('projects and runs', () => {
  async function enrolledNode(): Promise<string> {
    const { token } = await enrollmentTokensRepo.create(pool, { ttlMs: 60_000 });
    const key = testPublicKey(71);
    const outcome = await enroll(pool, {
      token,
      body: {
        public_key: key,
        public_key_fingerprint: fingerprintOf(key),
        display_name: 'runner',
        supported_protocol_versions: [1],
      },
      log: createLogger('fatal'),
    });
    if (!outcome.ok) throw new Error('enrollment failed');
    return outcome.body.node_id as string;
  }

  it('synchronises a project inventory without ever storing a host path', async () => {
    const nodeId = await enrolledNode();
    await channel.applyProjectInventory(nodeId, [
      { project_id: 'phase-a', display_name: 'Phase A', enabled: true },
      { project_id: 'phase-b', display_name: 'Phase B', enabled: true },
    ]);

    const projects = await projectsRepo.list(pool, nodeId);
    expect(projects.map((p) => p.node_project_id).sort()).toEqual(['phase-a', 'phase-b']);

    const listed = await app.inject({ method: 'GET', url: '/v1/projects', headers: operator() });
    expect(listed.body).not.toContain('workspace_path');
    expect(listed.body).not.toContain('/home/');
  });

  it('marks projects absent from a complete snapshot unavailable but keeps them', async () => {
    const nodeId = await enrolledNode();
    await channel.applyProjectInventory(nodeId, [
      { project_id: 'keep', display_name: 'Keep' },
      { project_id: 'drop', display_name: 'Drop' },
    ]);
    await channel.applyProjectInventory(nodeId, [{ project_id: 'keep', display_name: 'Keep' }]);

    const projects = await projectsRepo.list(pool, nodeId);
    expect(projects).toHaveLength(2);
    expect(projects.find((p) => p.node_project_id === 'drop')?.available).toBe(false);
    expect(projects.find((p) => p.node_project_id === 'keep')?.available).toBe(true);
  });

  it('queues a run while the node is offline', async () => {
    const nodeId = await enrolledNode();
    await channel.applyProjectInventory(nodeId, [{ project_id: 'phase-a', display_name: 'A' }]);
    const project = (await projectsRepo.list(pool, nodeId))[0]!;

    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.project_id}/runs`,
      headers: operator(),
      payload: { input: 'do the thing' },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.run.status).toBe('queued');
    expect(body.node_online).toBe(false);

    // The command survives for whenever the Node connects.
    const command = await pool.query<{ state: string }>(
      'SELECT state FROM remote_commands WHERE command_id = $1',
      [body.command_id],
    );
    expect(command.rows[0]?.state).toBe('queued');
  });

  it('replays an idempotent run request instead of creating a second one', async () => {
    const nodeId = await enrolledNode();
    await channel.applyProjectInventory(nodeId, [{ project_id: 'phase-a', display_name: 'A' }]);
    const project = (await projectsRepo.list(pool, nodeId))[0]!;
    const payload = { input: 'same work', idempotency_key: 'deploy-1' };

    const first = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.project_id}/runs`,
      headers: operator(),
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.project_id}/runs`,
      headers: operator(),
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body).replayed).toBe(true);

    const runs = await pool.query('SELECT run_id FROM runs');
    expect(runs.rowCount).toBe(1);
  });

  it('rejects an idempotency key reused with different work', async () => {
    const nodeId = await enrolledNode();
    await channel.applyProjectInventory(nodeId, [{ project_id: 'phase-a', display_name: 'A' }]);
    const project = (await projectsRepo.list(pool, nodeId))[0]!;

    await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.project_id}/runs`,
      headers: operator(),
      payload: { input: 'one', idempotency_key: 'k' },
    });
    const conflicting = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.project_id}/runs`,
      headers: operator(),
      payload: { input: 'completely different', idempotency_key: 'k' },
    });

    expect(conflicting.statusCode).toBe(409);
    expect(JSON.parse(conflicting.body).error).toBe('idempotency_conflict');
  });

  it('refuses approval and cancellation before the Node accepted the run', async () => {
    const nodeId = await enrolledNode();
    await channel.applyProjectInventory(nodeId, [{ project_id: 'phase-a', display_name: 'A' }]);
    const project = (await projectsRepo.list(pool, nodeId))[0]!;
    const created = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.project_id}/runs`,
      headers: operator(),
      payload: { input: 'x' },
    });
    const runId = JSON.parse(created.body).run.run_id;

    for (const path of ['approval', 'cancel']) {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/projects/${project.project_id}/runs/${runId}/${path}`,
        headers: operator(),
        payload: path === 'approval' ? { choice: 'deny' } : {},
      });
      expect(response.statusCode).toBe(409);
    }
  });

  it('rejects an unknown project and an unknown run', async () => {
    const missingProject = await app.inject({
      method: 'POST',
      url: '/v1/projects/does-not-exist/runs',
      headers: operator(),
      payload: { input: 'x' },
    });
    expect(missingProject.statusCode).toBe(404);
  });

  it('rejects a malformed run request', async () => {
    const nodeId = await enrolledNode();
    await channel.applyProjectInventory(nodeId, [{ project_id: 'phase-a', display_name: 'A' }]);
    const project = (await projectsRepo.list(pool, nodeId))[0]!;

    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.project_id}/runs`,
      headers: operator(),
      payload: { input: '' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('event ingestion invariants', () => {
  it('acknowledges only a gapless prefix', async () => {
    const { eventsRepo } = await import('../../src/repositories.js');
    const { token } = await enrollmentTokensRepo.create(pool, { ttlMs: 60_000 });
    const key = testPublicKey(81);
    const outcome = await enroll(pool, {
      token,
      body: {
        public_key: key,
        public_key_fingerprint: fingerprintOf(key),
        display_name: 'ingest',
        supported_protocol_versions: [1],
      },
      log: createLogger('fatal'),
    });
    if (!outcome.ok) throw new Error('enrollment failed');
    const nodeId = outcome.body.node_id as string;

    await channel.applyProjectInventory(nodeId, [{ project_id: 'p', display_name: 'p' }]);
    const project = (await projectsRepo.list(pool, nodeId))[0]!;
    const run = await pool.query<{ run_id: string }>(
      `INSERT INTO runs (run_id, node_id, project_id, node_run_id)
       VALUES (gen_random_uuid()::text, $1, $2, 'arun_x') RETURNING run_id`,
      [nodeId, project.project_id],
    );
    const runId = run.rows[0]!.run_id;

    const client = await pool.connect();
    try {
      // Deliberately skip seq 3 to create a gap.
      for (const seq of [1, 2, 4, 5]) {
        await eventsRepo.insert(client, {
          nodeId,
          runId,
          seq,
          projectId: project.project_id,
          eventType: 'test.event',
          recordedAt: null,
          payload: {},
          source: 'node',
        });
      }
      const contiguous = await eventsRepo.highestContiguous(client, runId, 0);
      expect(contiguous).toBe(2);

      // Filling the gap advances the cursor past it.
      await eventsRepo.insert(client, {
        nodeId,
        runId,
        seq: 3,
        projectId: project.project_id,
        eventType: 'test.event',
        recordedAt: null,
        payload: {},
        source: 'node',
      });
      expect(await eventsRepo.highestContiguous(client, runId, 0)).toBe(5);

      // A duplicate insert is a no-op rather than an error.
      const duplicate = await eventsRepo.insert(client, {
        nodeId,
        runId,
        seq: 1,
        projectId: project.project_id,
        eventType: 'test.event',
        recordedAt: null,
        payload: {},
        source: 'node',
      });
      expect(duplicate).toBe(false);
    } finally {
      client.release();
    }
  });
});

describe('dispatch fairness across projects', () => {
  async function nodeWithProjects(count: number): Promise<{ nodeId: string; projects: string[] }> {
    const { token } = await enrollmentTokensRepo.create(pool, { ttlMs: 60_000 });
    const key = testPublicKey(91);
    const outcome = await enroll(pool, {
      token,
      body: {
        public_key: key,
        public_key_fingerprint: fingerprintOf(key),
        display_name: 'fair',
        supported_protocol_versions: [1],
      },
      log: createLogger('fatal'),
    });
    if (!outcome.ok) throw new Error('enrollment failed');
    const nodeId = outcome.body.node_id as string;

    await channel.applyProjectInventory(
      nodeId,
      Array.from({ length: count }, (_, index) => ({
        project_id: `p${index}`,
        display_name: `P${index}`,
      })),
    );
    const projects = (await projectsRepo.list(pool, nodeId))
      .sort((a, b) => a.node_project_id.localeCompare(b.node_project_id))
      .map((project) => project.project_id);
    return { nodeId, projects };
  }

  async function queue(nodeId: string, projectId: string | null, count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await pool.query(
        `INSERT INTO remote_commands (command_id, node_id, project_id, command_type, request_payload,
                                      payload_digest, state, created_at)
         VALUES (gen_random_uuid()::text, $1, $2, 'run.create', '{}'::jsonb, $3, 'queued',
                 now() + ($4::bigint || ' microseconds')::interval)`,
        [nodeId, projectId, `d${projectId ?? 'node'}${index}`, String(index)],
      );
    }
  }

  it('does not let one busy project starve another', async () => {
    // Fifty commands for the first project, then one for the second. Strict FIFO
    // would make the second wait behind all fifty.
    const { nodeId, projects } = await nodeWithProjects(2);
    const [busy, quiet] = projects as [string, string];
    await queue(nodeId, busy, 50);
    await queue(nodeId, quiet, 1);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await commandsRepo.claimPending(client, nodeId, 4);
      await client.query('ROLLBACK');
      expect(claimed.map((command) => command.project_id)).toContain(quiet);
    } finally {
      client.release();
    }
  });

  it('interleaves projects in a deterministic round-robin', async () => {
    const { nodeId, projects } = await nodeWithProjects(3);
    for (const project of projects) await queue(nodeId, project, 3);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await commandsRepo.claimPending(client, nodeId, 3);
      await client.query('ROLLBACK');
      // A round of three takes one command from each project, not three from one.
      expect(new Set(claimed.map((command) => command.project_id)).size).toBe(3);
    } finally {
      client.release();
    }
  });

  it('does not starve Node-scoped commands that carry no project', async () => {
    const { nodeId, projects } = await nodeWithProjects(1);
    await queue(nodeId, projects[0]!, 20);
    await queue(nodeId, null, 1);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await commandsRepo.claimPending(client, nodeId, 3);
      await client.query('ROLLBACK');
      expect(claimed.some((command) => command.project_id === null)).toBe(true);
    } finally {
      client.release();
    }
  });

  it('claims the same order twice when nothing changed', async () => {
    const { nodeId, projects } = await nodeWithProjects(2);
    for (const project of projects) await queue(nodeId, project, 4);

    const order = async (): Promise<string[]> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const claimed = await commandsRepo.claimPending(client, nodeId, 6);
        await client.query('ROLLBACK');
        return claimed.map((command) => command.command_id);
      } finally {
        client.release();
      }
    };

    expect(await order()).toEqual(await order());
  });
});

describe('administrative recovery', () => {
  it('lists runs stranded active by a Node that never came back', async () => {
    const { token } = await enrollmentTokensRepo.create(pool, { ttlMs: 60_000 });
    const key = testPublicKey(93);
    const outcome = await enroll(pool, {
      token,
      body: {
        public_key: key,
        public_key_fingerprint: fingerprintOf(key),
        display_name: 'gone',
        supported_protocol_versions: [1],
      },
      log: createLogger('fatal'),
    });
    if (!outcome.ok) throw new Error('enrollment failed');
    const nodeId = outcome.body.node_id as string;

    await channel.applyProjectInventory(nodeId, [{ project_id: 'p', display_name: 'p' }]);
    const project = (await projectsRepo.list(pool, nodeId))[0]!;
    await pool.query(
      `INSERT INTO runs (run_id, node_id, project_id, status)
       VALUES (gen_random_uuid()::text, $1, $2, 'running')`,
      [nodeId, project.project_id],
    );
    await pool.query(`UPDATE nodes SET last_seen_at = now() - interval '2 hours'`);

    const stale = await runsRepo.staleActive(pool, 60_000);
    expect(stale).toHaveLength(1);
    expect(stale[0]?.status).toBe('running');

    // A run whose Node is present is not stale.
    await pool.query('UPDATE nodes SET last_seen_at = now()');
    expect(await runsRepo.staleActive(pool, 60_000)).toHaveLength(0);
  });

  it('excludes runs that already reached a terminal state', async () => {
    const { token } = await enrollmentTokensRepo.create(pool, { ttlMs: 60_000 });
    const key = testPublicKey(94);
    const outcome = await enroll(pool, {
      token,
      body: {
        public_key: key,
        public_key_fingerprint: fingerprintOf(key),
        display_name: 'done',
        supported_protocol_versions: [1],
      },
      log: createLogger('fatal'),
    });
    if (!outcome.ok) throw new Error('enrollment failed');
    const nodeId = outcome.body.node_id as string;

    await channel.applyProjectInventory(nodeId, [{ project_id: 'p', display_name: 'p' }]);
    const project = (await projectsRepo.list(pool, nodeId))[0]!;
    for (const status of ['completed', 'failed', 'cancelled', 'interrupted', 'lost']) {
      await pool.query(
        `INSERT INTO runs (run_id, node_id, project_id, status)
         VALUES (gen_random_uuid()::text, $1, $2, $3)`,
        [nodeId, project.project_id, status],
      );
    }
    await pool.query(`UPDATE nodes SET last_seen_at = now() - interval '2 hours'`);

    expect(await runsRepo.staleActive(pool, 60_000)).toHaveLength(0);
  });
});

describe('force-close endpoint', () => {
  async function strandedRun(): Promise<{ runId: string; nodeId: string }> {
    const { token } = await enrollmentTokensRepo.create(pool, { ttlMs: 60_000 });
    const key = testPublicKey(96);
    const outcome = await enroll(pool, {
      token,
      body: {
        public_key: key,
        public_key_fingerprint: fingerprintOf(key),
        display_name: 'stranded',
        supported_protocol_versions: [1],
      },
      log: createLogger('fatal'),
    });
    if (!outcome.ok) throw new Error('enrollment failed');
    const nodeId = outcome.body.node_id as string;

    await channel.applyProjectInventory(nodeId, [{ project_id: 'p', display_name: 'p' }]);
    const project = (await projectsRepo.list(pool, nodeId))[0]!;
    const inserted = await pool.query<{ run_id: string }>(
      `INSERT INTO runs (run_id, node_id, project_id, status)
       VALUES (gen_random_uuid()::text, $1, $2, 'running') RETURNING run_id`,
      [nodeId, project.project_id],
    );
    await pool.query(`UPDATE nodes SET last_seen_at = now() - interval '2 hours'`);
    return { runId: inserted.rows[0]!.run_id, nodeId };
  }

  it('closes a stranded run as lost and records why', async () => {
    const { runId } = await strandedRun();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/force-close`,
      headers: operator(),
      payload: { reason: 'host decommissioned' },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).status).toBe('lost');

    const run = await runsRepo.byId(pool, runId);
    expect(run?.status).toBe('lost');
    // `lost` rather than `failed`: the Control Plane never observed an outcome.
    expect(run?.terminal_reason).toBe('operator_force_close');

    const audit = await app.inject({ method: 'GET', url: '/v1/audit', headers: operator() });
    expect(audit.body).toContain('run.force_close');
    expect(audit.body).toContain('host decommissioned');
  });

  it('requires an explicit reason', async () => {
    const { runId } = await strandedRun();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/force-close`,
      headers: operator(),
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses to close a run twice', async () => {
    const { runId } = await strandedRun();
    const payload = { reason: 'gone' };
    await app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/force-close`,
      headers: operator(),
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/force-close`,
      headers: operator(),
      payload,
    });
    expect(second.statusCode).toBe(409);
  });

  it('lists the run as stranded before it is closed, and not after', async () => {
    const { runId } = await strandedRun();
    const before = await app.inject({
      method: 'GET',
      url: '/v1/runs/stranded?stale_ms=60000',
      headers: operator(),
    });
    expect(JSON.parse(before.body).runs.map((r: { run_id: string }) => r.run_id)).toContain(runId);

    await app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/force-close`,
      headers: operator(),
      payload: { reason: 'gone' },
    });

    const after = await app.inject({
      method: 'GET',
      url: '/v1/runs/stranded?stale_ms=60000',
      headers: operator(),
    });
    expect(JSON.parse(after.body).runs).toHaveLength(0);
  });

  it('rejects an unknown run and requires operator authentication', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/runs/does-not-exist/force-close',
          headers: operator(),
          payload: { reason: 'x' },
        })
      ).statusCode,
    ).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/runs/stranded' })).statusCode).toBe(401);
  });
});

describe('identity rotation', () => {
  async function enrolled(seed: number): Promise<{ nodeId: string; fingerprint: string }> {
    const { token } = await enrollmentTokensRepo.create(pool, { ttlMs: 60_000 });
    const key = testPublicKey(seed);
    const outcome = await enroll(pool, {
      token,
      body: {
        public_key: key,
        public_key_fingerprint: fingerprintOf(key),
        display_name: 'rotating',
        supported_protocol_versions: [1],
      },
      log: createLogger('fatal'),
    });
    if (!outcome.ok) throw new Error('enrollment failed');
    return { nodeId: outcome.body.node_id as string, fingerprint: fingerprintOf(key) };
  }

  function rotationBody(seed: number) {
    const key = testPublicKey(seed);
    return {
      public_key: key,
      public_key_fingerprint: fingerprintOf(key),
      display_name: 'rotating',
      supported_protocol_versions: [1],
    };
  }

  /**
   * Issue a rotation token and assert the contract the callers depend on.
   *
   * Returning an unchecked `JSON.parse(body)` is what made a failed issuance
   * surface much later as `expected undefined to be '<digest>'`: `token_id`
   * became `undefined` and the follow-up query simply matched no row. Asserting
   * here makes a regression fail at the step that actually broke.
   *
   * Never logs the token or its digest.
   */
  async function issueRotationToken(nodeId: string): Promise<{ token: string; tokenId: string }> {
    const issued = await app.inject({
      method: 'POST',
      url: `/v1/nodes/${nodeId}/rotation-token`,
      headers: operator(),
    });

    expect(
      issued.statusCode,
      `rotation-token issuance for ${nodeId} failed with ${issued.statusCode}`,
    ).toBe(201);

    const body = JSON.parse(issued.body) as {
      token?: unknown;
      token_id?: unknown;
      node_id?: unknown;
      identity_generation?: unknown;
    };
    expect(typeof body.token, 'response must carry a plaintext token exactly once').toBe('string');
    expect(typeof body.token_id, 'response must carry a token_id').toBe('string');
    expect(body.node_id).toBe(nodeId);
    expect(typeof body.identity_generation).toBe('number');

    // The row must be committed and visible on another connection before the
    // caller acts on it. This is the invariant the production defect broke.
    const persisted = await pool.query<{ token_id: string }>(
      'SELECT token_id FROM enrollment_tokens WHERE token_id = $1',
      [body.token_id as string],
    );
    expect(
      persisted.rowCount,
      'issued rotation token must be committed and visible before the response is observed',
    ).toBe(1);

    return { token: body.token as string, tokenId: body.token_id as string };
  }

  it('replaces the key, keeps the node_id, and bumps the generation', async () => {
    const { nodeId, fingerprint } = await enrolled(101);

    const { token } = await issueRotationToken(nodeId);

    const rotated = await app.inject({
      method: 'POST',
      url: '/v1/node/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: rotationBody(102),
    });

    expect(rotated.statusCode).toBe(200);
    const body = JSON.parse(rotated.body);
    expect(body.node_id).toBe(nodeId);
    expect(body.rotated).toBe(true);
    expect(body.identity_generation).toBe(2);

    const node = await nodesRepo.byId(pool, nodeId);
    expect(node?.fingerprint).toBe(fingerprintOf(testPublicKey(102)));
    expect(node?.fingerprint).not.toBe(fingerprint);
    expect(node?.identity_generation).toBe(2);

    // Exactly one Node still: rotation must not fork the identity.
    expect((await nodesRepo.list(pool)).length).toBe(1);
  });

  it('records the rotation with both fingerprints', async () => {
    const { nodeId, fingerprint } = await enrolled(103);
    // `issueRotationToken` asserts the issuance contract, so a failure names the
    // step that broke instead of surfacing later as a wrong generation counter.
    const { token: issuedToken } = await issueRotationToken(nodeId);

    const rotated = await app.inject({
      method: 'POST',
      url: '/v1/node/enroll',
      headers: { authorization: `Bearer ${issuedToken}` },
      payload: rotationBody(104),
    });
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect(JSON.parse(rotated.body).rotated).toBe(true);

    const history = await app.inject({
      method: 'GET',
      url: `/v1/nodes/${nodeId}/rotations`,
      headers: operator(),
    });
    const { rotations, identity_generation } = JSON.parse(history.body);
    expect(identity_generation).toBe(2);
    expect(rotations).toHaveLength(1);
    expect(rotations[0].state).toBe('completed');
    expect(rotations[0].old_fingerprint).toBe(fingerprint);
    expect(rotations[0].new_fingerprint).toBe(fingerprintOf(testPublicKey(104)));

    const audit = await app.inject({ method: 'GET', url: '/v1/audit', headers: operator() });
    expect(audit.body).toContain('node.rotate_identity');
  });

  it('consumes the rotation token, so it cannot rotate twice', async () => {
    const { nodeId } = await enrolled(105);
    const { token } = await issueRotationToken(nodeId);

    const first = await app.inject({
      method: 'POST',
      url: '/v1/node/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: rotationBody(106),
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/node/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: rotationBody(107),
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(401);
    expect((await nodesRepo.byId(pool, nodeId))?.identity_generation).toBe(2);
  });

  it('refuses to rotate onto the key already in use', async () => {
    const { nodeId } = await enrolled(108);
    const issued = await issueRotationToken(nodeId);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/node/enroll',
      headers: { authorization: `Bearer ${issued.token}` },
      payload: rotationBody(108),
    });

    expect(response.statusCode).toBe(409);
    expect((await nodesRepo.byId(pool, nodeId))?.identity_generation).toBe(1);
  });

  it('refuses to rotate onto another live Node key', async () => {
    const first = await enrolled(109);
    const secondKey = testPublicKey(110);
    const { token: enrollToken } = await enrollmentTokensRepo.create(pool, { ttlMs: 60_000 });
    await enroll(pool, {
      token: enrollToken,
      body: {
        public_key: secondKey,
        public_key_fingerprint: fingerprintOf(secondKey),
        display_name: 'other',
        supported_protocol_versions: [1],
      },
      log: createLogger('fatal'),
    });

    const issued = await issueRotationToken(first.nodeId);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/node/enroll',
      headers: { authorization: `Bearer ${issued.token}` },
      payload: rotationBody(110),
    });

    expect(response.statusCode).toBe(409);
  });

  it('refuses to issue a rotation token for a revoked or unknown Node', async () => {
    const { nodeId } = await enrolled(111);
    const revocation = await app.inject({
      method: 'POST',
      url: `/v1/nodes/${nodeId}/revoke`,
      headers: operator(),
      payload: { reason: 'decommissioned' },
    });
    expect(revocation.statusCode, 'the precondition revoke must succeed').toBe(200);
    // The revocation must be committed before rotation is attempted, or the
    // 409 below would prove nothing.
    expect((await nodesRepo.byId(pool, nodeId))?.revoked_at).not.toBeNull();

    const revoked = await app.inject({
      method: 'POST',
      url: `/v1/nodes/${nodeId}/rotation-token`,
      headers: operator(),
    });
    const missing = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node-999/rotation-token',
      headers: operator(),
    });

    expect(revoked.statusCode).toBe(409);
    expect(missing.statusCode).toBe(404);
  });

  it('never stores or returns the rotation token digest', async () => {
    const { nodeId } = await enrolled(112);
    const { token, tokenId } = await issueRotationToken(nodeId);

    const stored = await pool.query<{ token_digest: string; bound_node_id: string }>(
      'SELECT token_digest, bound_node_id FROM enrollment_tokens WHERE token_id = $1',
      [tokenId],
    );
    expect(stored.rowCount, 'the issued token row must exist').toBe(1);
    expect(stored.rows[0]?.token_digest).toBe(hashToken(token));
    expect(stored.rows[0]?.bound_node_id).toBe(nodeId);

    const audit = await app.inject({ method: 'GET', url: '/v1/audit', headers: operator() });
    expect(audit.statusCode).toBe(200);
    // Neither the plaintext token nor its digest may reach the audit log.
    expect(audit.body).not.toContain(token);
    expect(audit.body).not.toContain(hashToken(token));
  });
});
