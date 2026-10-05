/**
 * The Workdesk bridge, over the real channel and the real database.
 *
 * Two things have to meet for a task to complete on its own: a completion the
 * executing agent asked for, and its Run durably ending. They travel the same
 * socket with no guaranteed order, so each has to work when it is the later
 * one — and neither order may complete the task twice or leave the request
 * waiting forever.
 *
 * The other thing protected here is whose history a refusal lands in. A
 * refusal reason is shown on a task, so a Node must not be able to write one
 * against a project it does not own.
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
import { nodesRepo, projectsRepo } from '../../src/repositories.js';
import { PROVISIONING_CAPABILITIES, TestNode, createNodeKeys } from '../support/test-node.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://asterism:asterism@127.0.0.1:55432/asterism_cp';
const ORIGIN = 'http://console.test';
const PASSWORD = 'correct horse battery staple';

/** A Node that carries structured task reports. */
const REPORTING = {
  ...PROVISIONING_CAPABILITIES,
  workdesk: { structured_reports: true, report_command_version: 1 },
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
  userId: string;
}

async function owner(): Promise<Session> {
  const userId = randomUUID();
  const email = `owner-${userId}@example.com`;
  await pool.query(
    `INSERT INTO users (user_id, normalized_email, display_name, password_hash)
     VALUES ($1, $2, 'Owner', $3)`,
    [userId, email, passwordHash],
  );
  await pool.query(
    `INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')`,
    ['org_bootstrap', userId],
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN },
    payload: { email, password: PASSWORD },
  });
  const cookies = response.headers['set-cookie'];
  const cookie = (Array.isArray(cookies) ? cookies : [cookies ?? '']).find((value) =>
    value.startsWith(`${SESSION_COOKIE}=`),
  )!;
  return { cookie: cookie.split(';')[0]!, csrf: response.json().csrf_token as string, userId };
}

const write = (session: Session) => ({
  cookie: session.cookie,
  origin: ORIGIN,
  'x-csrf-token': session.csrf,
});

const post = (session: Session, url: string, payload: unknown = {}) =>
  app.inject({ method: 'POST', url, headers: write(session), payload });

const get = (session: Session, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: session.cookie } });

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 100 && !done(value); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  return value;
}

async function node(suffix: string, capabilities: Record<string, unknown> = REPORTING) {
  const keys = createNodeKeys();
  const nodeId = `node-${suffix}-${randomUUID().slice(0, 8)}`;
  await nodesRepo.create(pool, {
    nodeId,
    displayName: `Node ${suffix}`,
    publicKey: keys.publicKeyBase64,
    fingerprint: keys.fingerprint,
    organizationId: 'org_bootstrap',
  });
  await pool.query('UPDATE nodes SET capabilities = $2::jsonb WHERE node_id = $1', [
    nodeId,
    JSON.stringify(capabilities),
  ]);
  const live = await TestNode.connect(baseUrl, nodeId, keys, capabilities);
  open.push(live);
  await live.waitForCommand('capabilities.get');
  return { nodeId, live };
}

async function project(nodeId: string, name: string) {
  const nodeProjectId = `local-${name}-${randomUUID().slice(0, 6)}`;
  const created = await projectsRepo.upsert(pool, {
    nodeId,
    nodeProjectId,
    displayName: name,
    enabled: true,
    metadata: { runtime_state: 'ready' },
  });
  await pool.query(
    `UPDATE projects SET credential_id = 'cred-0011aabbccddeeff', model = 'model-a',
            model_selection_state = 'applied' WHERE project_id = $1`,
    [created.project_id],
  );
  // Both identities: the Control Plane's, and the one the Node's own events
  // carry.
  return { projectId: created.project_id, nodeProjectId };
}

/** Create a task and start it, which is what mints its Run. */
async function startedTask(session: Session, projectId: string, live: TestNode) {
  const created = await post(session, `/api/v1/projects/${projectId}/tasks`, {
    title: 'Make it true',
    goal: 'Do the thing and report',
  });
  expect(created.statusCode).toBe(201);
  const taskId = created.json().task.task_id as string;

  const started = await post(session, `/api/v1/tasks/${taskId}/actions`, { action: 'start' });
  expect(started.statusCode).toBe(202);
  const runId = started.json().run_id as string;

  // The Node receives a run carrying its task, and answers it the way a real
  // one does so the run acquires a node run id.
  const command = await live.waitForCommand('runs.create');
  expect(command.payload.task).toMatchObject({ task_id: taskId });
  live.completeCommand(command.command_id, {
    run_id: `node-${runId.slice(0, 8)}`,
    status: 'queued',
  });
  await eventually(
    async () =>
      (
        await pool.query<{ node_run_id: string | null }>(
          'SELECT node_run_id FROM runs WHERE run_id = $1',
          [runId],
        )
      ).rows[0]?.node_run_id,
    (value) => Boolean(value),
  );
  const generation = Number(
    (
      await pool.query<{ generation: number }>('SELECT generation FROM tasks WHERE task_id = $1', [
        taskId,
      ])
    ).rows[0]!.generation,
  );
  return { taskId, runId, generation, nodeRunId: `node-${runId.slice(0, 8)}` };
}

function completionReport(input: {
  taskId: string;
  runId: string;
  generation: number;
  seq?: number;
}) {
  const seq = input.seq ?? 1;
  return {
    report_id: `card-${input.runId.slice(0, 8)}:event:${seq}`,
    task_id: input.taskId,
    run_id: input.runId,
    generation: input.generation,
    source_seq: seq,
    report: {
      report: 'completion_requested',
      summary: 'Did the thing',
      artifacts: ['/tmp/result.txt'],
    },
  };
}

/** End a run the way the Node does, through a real terminal event. */
async function endRun(
  live: TestNode,
  nodeProjectId: string,
  nodeRunId: string,
  status: string,
  seq = 1,
) {
  live.sendEvent({
    project_id: nodeProjectId,
    run_id: nodeRunId,
    seq,
    event_type: 'asterism.run.terminal',
    payload: { status },
  });
}

const taskRow = async (taskId: string) =>
  (
    await pool.query<{ status: string; version: number; result_summary: string | null }>(
      'SELECT status, version, result_summary FROM tasks WHERE task_id = $1',
      [taskId],
    )
  ).rows[0]!;

const requestRows = async (taskId: string) =>
  (
    await pool.query<{ action: string; outcome: string; outcome_reason: string | null }>(
      `SELECT action, outcome, outcome_reason FROM task_requests
        WHERE task_id = $1 ORDER BY created_at`,
      [taskId],
    )
  ).rows;

const eventSummaries = async (taskId: string) =>
  (
    await pool.query<{ summary: string }>(
      'SELECT summary FROM task_events WHERE task_id = $1 ORDER BY seq',
      [taskId],
    )
  ).rows.map((row) => row.summary);

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
  await rollbackAll(pool);
  await migrate(pool);
  passwordHash = await hashPassword(PASSWORD);
  channel = new NodeChannel(pool, config, createLogger('fatal'));
  channel.start();
  app = await buildApp({ pool, config, log: createLogger('fatal'), channel });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const live of open) await live.close().catch(() => undefined);
  await app?.close();
  await channel?.stop();
  await pool?.end();
});

beforeEach(async () => {
  for (const live of open.splice(0)) await live.close().catch(() => undefined);
});

describe('a completion and its run, arriving in either order', () => {
  it('completes when the report comes first and the run ends after', async () => {
    const session = await owner();
    const host = await node('order-a');
    const { projectId, nodeProjectId } = await project(host.nodeId, 'Order A');
    const task = await startedTask(session, projectId, host.live);

    const report = completionReport(task);
    host.live.sendTaskReport(report);
    expect(await host.live.waitForReportAck(report.report_id)).toBe(true);

    // Held, not applied: the run has not ended.
    expect((await taskRow(task.taskId)).status).toBe('running');
    expect(await requestRows(task.taskId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'complete', outcome: 'pending' })]),
    );

    await endRun(host.live, nodeProjectId, task.nodeRunId, 'completed');

    const settled = await eventually(
      () => taskRow(task.taskId),
      (row) => row.status === 'completed',
    );
    expect(settled.status).toBe('completed');
    expect(settled.result_summary).toBe('Did the thing');
    const requests = await requestRows(task.taskId);
    expect(requests.filter((r) => r.action === 'complete')).toEqual([
      expect.objectContaining({ outcome: 'accepted' }),
    ]);
  });

  it('completes when the run ends first and the report comes after', async () => {
    const session = await owner();
    const host = await node('order-b');
    const { projectId, nodeProjectId } = await project(host.nodeId, 'Order B');
    const task = await startedTask(session, projectId, host.live);

    await endRun(host.live, nodeProjectId, task.nodeRunId, 'completed');
    // Nothing claimed it was done, so it waits for a look.
    await eventually(
      () => taskRow(task.taskId),
      (row) => row.status === 'review',
    );

    // The last `kanban_complete` arrives after the terminal event, which is
    // exactly the row a final board read is there to catch.
    const report = completionReport(task);
    host.live.sendTaskReport(report);
    expect(await host.live.waitForReportAck(report.report_id)).toBe(true);

    const settled = await eventually(
      () => taskRow(task.taskId),
      (row) => row.status === 'completed',
    );
    expect(settled.status).toBe('completed');
    const requests = await requestRows(task.taskId);
    expect(requests.filter((r) => r.action === 'complete')).toEqual([
      expect.objectContaining({ outcome: 'accepted' }),
    ]);
  });

  it('never applies a completion twice, however many times it is delivered', async () => {
    const session = await owner();
    const host = await node('once');
    const { projectId, nodeProjectId } = await project(host.nodeId, 'Once');
    const task = await startedTask(session, projectId, host.live);

    const report = completionReport(task);
    host.live.sendTaskReport(report);
    expect(await host.live.waitForReportAck(report.report_id)).toBe(true);
    await endRun(host.live, nodeProjectId, task.nodeRunId, 'completed');
    const first = await eventually(
      () => taskRow(task.taskId),
      (row) => row.status === 'completed',
    );

    // The Node retransmits because it never saw the acknowledgement. Same
    // identity, so it is recognised rather than applied.
    host.live.sendTaskReport(report);
    host.live.sendTaskReport(report);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const after = await taskRow(task.taskId);
    expect(after.status).toBe('completed');
    // The version is what would move if anything had been applied again.
    expect(after.version).toBe(first.version);
    const completions = (await requestRows(task.taskId)).filter((r) => r.action === 'complete');
    expect(completions).toHaveLength(1);
    const completed = (await eventSummaries(task.taskId)).filter((s) => s === 'Task completed');
    expect(completed).toHaveLength(1);
  });
});

describe('a run that did not succeed', () => {
  it('refuses the completion asked for during it, and says why', async () => {
    const session = await owner();
    const host = await node('failed');
    const { projectId, nodeProjectId } = await project(host.nodeId, 'Failed');
    const task = await startedTask(session, projectId, host.live);

    const report = completionReport(task);
    host.live.sendTaskReport(report);
    expect(await host.live.waitForReportAck(report.report_id)).toBe(true);

    await endRun(host.live, nodeProjectId, task.nodeRunId, 'failed');

    const settled = await eventually(
      () => taskRow(task.taskId),
      (row) => row.status === 'failed',
    );
    expect(settled.status).toBe('failed');
    const completion = (await requestRows(task.taskId)).find((r) => r.action === 'complete')!;
    expect(completion.outcome).toBe('rejected');
    expect(completion.outcome_reason).toMatch(/failed/i);
  });

  it('refuses it on a cancelled run too', async () => {
    const session = await owner();
    const host = await node('cancelled');
    const { projectId, nodeProjectId } = await project(host.nodeId, 'Cancelled');
    const task = await startedTask(session, projectId, host.live);

    const report = completionReport(task);
    host.live.sendTaskReport(report);
    expect(await host.live.waitForReportAck(report.report_id)).toBe(true);
    await endRun(host.live, nodeProjectId, task.nodeRunId, 'cancelled');

    const settled = await eventually(
      () => taskRow(task.taskId),
      (row) => row.status === 'cancelled',
    );
    expect(settled.status).toBe('cancelled');
    const completion = (await requestRows(task.taskId)).find((r) => r.action === 'complete')!;
    expect(completion.outcome).toBe('rejected');
    expect(completion.outcome_reason).toMatch(/cancelled/i);
  });
});

describe('generation', () => {
  it('refuses a report from a superseded attempt', async () => {
    const session = await owner();
    const host = await node('generation');
    const { projectId } = await project(host.nodeId, 'Generation');
    const task = await startedTask(session, projectId, host.live);

    const stale = {
      ...completionReport(task),
      generation: task.generation - 1,
      report_id: 'card-stale:event:1',
    };
    host.live.sendTaskReport(stale);
    expect(await host.live.waitForReportAck(stale.report_id)).toBe(true);

    const refusal = await eventually(
      async () =>
        (
          await pool.query<{ refusal_reason: string | null; accepted: boolean }>(
            'SELECT refusal_reason, accepted FROM task_reports WHERE report_id = $1',
            [stale.report_id],
          )
        ).rows[0],
      (row) => Boolean(row),
    );
    expect(refusal!.accepted).toBe(false);
    expect(refusal!.refusal_reason).toMatch(/earlier attempt/i);
    // And nothing was requested on the task's behalf.
    expect((await requestRows(task.taskId)).filter((r) => r.action === 'complete')).toHaveLength(0);
  });
});

describe('whose history a refusal lands in', () => {
  it('writes nothing at all when the reporting Node does not own the task', async () => {
    const session = await owner();
    const host = await node('owner');
    const stranger = await node('stranger');
    const { projectId, nodeProjectId } = await project(host.nodeId, 'Owned');
    const task = await startedTask(session, projectId, host.live);

    const before = await eventSummaries(task.taskId);

    // The stranger reports about somebody else's task. A refusal reason is
    // shown on a task, so being allowed to record one here would let a foreign
    // Node write sentences into this project's history.
    const forged = {
      ...completionReport(task),
      report_id: 'card-forged:event:1',
    };
    stranger.live.sendTaskReport(forged);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Not remembered, not refused in writing, not applied.
    const remembered = await pool.query('SELECT 1 FROM task_reports WHERE report_id = $1', [
      forged.report_id,
    ]);
    expect(remembered.rowCount).toBe(0);
    expect(await eventSummaries(task.taskId)).toEqual(before);
    expect((await requestRows(task.taskId)).filter((r) => r.action === 'complete')).toHaveLength(0);
    expect((await taskRow(task.taskId)).status).toBe('running');

    // And the task is unharmed: its own Node can still finish it.
    const honest = completionReport(task);
    host.live.sendTaskReport(honest);
    expect(await host.live.waitForReportAck(honest.report_id)).toBe(true);
    await endRun(host.live, nodeProjectId, task.nodeRunId, 'completed');
    await eventually(
      () => taskRow(task.taskId),
      (row) => row.status === 'completed',
    );
  });

  it('records a refusal from the owning Node, because that is its own history', async () => {
    const session = await owner();
    const host = await node('own-refusal');
    const { projectId } = await project(host.nodeId, 'Own refusal');
    const task = await startedTask(session, projectId, host.live);

    // A run that is not this task's: the Node owns the task, so the refusal
    // belongs on it and is worth keeping.
    const wrongRun = {
      ...completionReport(task),
      run_id: randomUUID(),
      report_id: 'card-x:event:9',
    };
    host.live.sendTaskReport(wrongRun);
    expect(await host.live.waitForReportAck(wrongRun.report_id)).toBe(true);

    const stored = await eventually(
      async () =>
        (
          await pool.query<{ refusal_reason: string | null }>(
            'SELECT refusal_reason FROM task_reports WHERE report_id = $1',
            [wrongRun.report_id],
          )
        ).rows[0],
      (row) => Boolean(row?.refusal_reason),
    );
    expect(stored!.refusal_reason).toMatch(/does not belong to this task/i);
  });
});

describe('what a person sees', () => {
  it('shows a blocked task as waiting for input, actor-neutral', async () => {
    const session = await owner();
    const host = await node('blocked');
    const { projectId } = await project(host.nodeId, 'Blocked');
    const task = await startedTask(session, projectId, host.live);

    host.live.sendTaskReport({
      report_id: 'card-b:event:1',
      task_id: task.taskId,
      run_id: task.runId,
      generation: task.generation,
      source_seq: 1,
      report: { report: 'blocked', reason: 'Which repository should I use?', kind: 'needs_input' },
    });
    expect(await host.live.waitForReportAck('card-b:event:1')).toBe(true);

    const waiting = await eventually(
      () => taskRow(task.taskId),
      (row) => row.status === 'waiting_input',
    );
    expect(waiting.status).toBe('waiting_input');

    const page = await get(session, `/api/v1/tasks/${task.taskId}`);
    expect(page.statusCode).toBe(200);
    const body = page.json().task;
    expect(body.status_label).toBe('Waiting for input');
    expect(body.input_request.prompt).toBe('Which repository should I use?');
    expect(body.input_request.kind).toBe('needs_input');
    // The bridge is live on this Node, so nothing is explained away.
    expect(body.structured_reports).toMatchObject({ supported: true, available: true });
  });

  it('attributes a reported plan to the agent', async () => {
    const session = await owner();
    const host = await node('plan');
    const { projectId } = await project(host.nodeId, 'Plan');
    const task = await startedTask(session, projectId, host.live);

    host.live.sendTaskReport({
      report_id: 'card-p:event:1',
      task_id: task.taskId,
      run_id: task.runId,
      generation: task.generation,
      source_seq: 1,
      report: { report: 'plan', steps: ['Read the code', 'Change it', 'Prove it'] },
    });
    expect(await host.live.waitForReportAck('card-p:event:1')).toBe(true);

    const page = await eventually(
      async () => (await get(session, `/api/v1/tasks/${task.taskId}`)).json().task,
      (body) => body.plan.length === 3,
    );
    expect(page.plan.map((step: { title: string }) => step.title)).toEqual([
      'Read the code',
      'Change it',
      'Prove it',
    ]);
    const planEvent = page.events.find(
      (event: { event_type: string }) => event.event_type === 'plan.updated',
    );
    expect(planEvent.agent_reported).toBe(true);
  });
});
