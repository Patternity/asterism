/**
 * How a managed update ends, over the real channel.
 *
 * node-1 was recorded as updated to alpha.30 while running the alpha.30 binary
 * on the alpha.29 runtime. The new binary reconnected before the updater had
 * verified anything; verification then failed and restored the old runtime;
 * the operation had already been called successful on the reconnect.
 *
 * These tests hold the contract that replaced that: success needs the
 * updater's verified evidence for this exact operation *and* a session on the
 * requested release that began after the operation did.
 */
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createPool, migrate, rollbackAll, type Pool } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { NodeChannel } from '../../src/node-channel.js';
import { nodeUpdatesRepo } from '../../src/node-update-repository.js';
import { nodesRepo } from '../../src/repositories.js';
import { TestNode, createNodeKeys, type TestNodeKeys } from '../support/test-node.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://asterism:asterism@127.0.0.1:55432/asterism_cp';
const FROM = 'v0.1.0-alpha.30';
const TO = 'v0.1.0-alpha.31';
const REVISION = '1111111111111111111111111111111111111111';

let pool: Pool;
let app: FastifyInstance;
let channel: NodeChannel;
let baseUrl: string;
const open: TestNode[] = [];

beforeAll(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL,
    PUBLIC_BASE_URL: 'http://127.0.0.1:8080',
    ALLOWED_ORIGINS: 'http://console.test',
    ALLOW_PLAINTEXT: 'true',
    OPERATOR_COMPATIBILITY: 'false',
    LOG_LEVEL: 'error',
  } as NodeJS.ProcessEnv);
  pool = createPool(DATABASE_URL, 8);
  await rollbackAll(pool).catch(() => undefined);
  await migrate(pool);
  channel = new NodeChannel(pool, config, createLogger('error'));
  channel.start();
  app = await buildApp({ pool, config, log: createLogger('error'), channel });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const node of open) await node.close().catch(() => undefined);
  await app.close();
  await channel.stop();
  await pool.end();
});

let counter = 0;
async function registerNode(): Promise<{ nodeId: string; keys: TestNodeKeys }> {
  counter += 1;
  const keys = createNodeKeys();
  const nodeId = `node-update-${Date.now()}-${counter}`;
  await nodesRepo.create(pool, {
    nodeId,
    displayName: 'Update node',
    publicKey: keys.publicKeyBase64,
    fingerprint: keys.fingerprint,
    organizationId: 'org_bootstrap',
  });
  return { nodeId, keys };
}

async function connect(nodeId: string, keys: TestNodeKeys, softwareVersion: string) {
  const node = await TestNode.connect(
    baseUrl,
    nodeId,
    keys,
    { api_version: 1 },
    { softwareVersion },
  );
  open.push(node);
  return node;
}

async function operationFor(nodeId: string, requested = TO) {
  const operation = await nodeUpdatesRepo.create(pool, {
    organizationId: 'org_bootstrap',
    nodeId,
    commandId: null,
    requestedVersion: requested,
    previousVersion: FROM,
    requestedByUserId: null,
  });
  await nodeUpdatesRepo.markAccepted(pool, operation.operation_id);
  return operation;
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    target_release: TO,
    node_release: TO,
    runtime_release: TO,
    runtime_revision: REVISION,
    services: [
      { role: { kind: 'node' }, main_pid: 4100 },
      { role: { kind: 'host_hermes' }, main_pid: 4101 },
      { role: { kind: 'project_worker', project_id: 'prj_2b0179646e394239' }, main_pid: 4102 },
    ],
    ...overrides,
  };
}

async function stageOf(operationId: string) {
  return nodeUpdatesRepo.byId(pool, operationId);
}

async function progress(node: TestNode, payload: Record<string, unknown>) {
  node.sendUpdateProgress({ at: Math.floor(Date.now() / 1000), ...payload });
  return node.waitForUpdateAck(String(payload.operation_id), Number(payload.seq));
}

describe('a reconnect alone completes nothing', () => {
  /**
   * The production path, reproduced: the new binary connects on the requested
   * release while the updater is still applying. Before this change the
   * operation became `succeeded` right here.
   */
  it('leaves an applying operation applying when the target binary connects', async () => {
    const { nodeId, keys } = await registerNode();
    const operation = await operationFor(nodeId);
    const old = await connect(nodeId, keys, FROM);
    expect(
      await progress(old, {
        operation_id: operation.operation_id,
        seq: 1,
        state: 'runtime_installing',
      }),
    ).toBe(true);
    await old.close();

    const fresh = await connect(nodeId, keys, TO);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const after = await stageOf(operation.operation_id);
    expect(after?.stage).toBe('applying');
    expect(after?.percent).toBeLessThan(100);

    // The updater then proves the installation, and only now is it done.
    expect(
      await progress(fresh, {
        operation_id: operation.operation_id,
        seq: 2,
        state: 'complete',
        evidence: evidence(),
      }),
    ).toBe(true);
    const done = await stageOf(operation.operation_id);
    expect(done?.stage).toBe('succeeded');
    expect(done?.percent).toBe(100);
    expect(done?.reported_version).toBe(TO);
    expect(done?.evidence?.runtime_release).toBe(TO);
    expect(done?.evidence?.services).toHaveLength(3);

    const audit = await pool.query(
      `SELECT result, detail FROM audit_log WHERE action = 'node.update.result' AND correlation_id = $1`,
      [operation.operation_id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].result).toBe('success');
  });

  /** The state node-1 was left in cannot be described as success. */
  it('fails the target binary over the previous runtime', async () => {
    const { nodeId, keys } = await registerNode();
    const operation = await operationFor(nodeId);
    const node = await connect(nodeId, keys, TO);
    await progress(node, {
      operation_id: operation.operation_id,
      seq: 1,
      state: 'complete',
      evidence: evidence({ runtime_release: FROM }),
    });
    const after = await stageOf(operation.operation_id);
    expect(after?.stage).toBe('failed');
    expect(after?.failure_code).toBe('evidence_mismatch');
    expect(after?.failure_message).toContain(`the runtime is ${FROM}`);
    expect(after?.evidence).toBeNull();
  });

  it('does not accept an updater that finished without evidence', async () => {
    const { nodeId, keys } = await registerNode();
    const operation = await operationFor(nodeId);
    const node = await connect(nodeId, keys, TO);
    await progress(node, { operation_id: operation.operation_id, seq: 1, state: 'complete' });
    const after = await stageOf(operation.operation_id);
    expect(after?.stage).toBe('failed');
    expect(after?.failure_code).toBe('unverified_completion');
  });
});

describe('evidence belongs to one attempt', () => {
  /**
   * A session on the requested release that began before the operation is a
   * process the update was meant to replace. Its evidence waits for the Node to
   * come back in a session of this attempt.
   */
  it('does not complete through a session older than the operation', async () => {
    const { nodeId, keys } = await registerNode();
    const earlier = await connect(nodeId, keys, TO);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const operation = await operationFor(nodeId);

    await progress(earlier, {
      operation_id: operation.operation_id,
      seq: 1,
      state: 'complete',
      evidence: evidence(),
    });
    expect((await stageOf(operation.operation_id))?.stage).toBe('awaiting_reconnect');

    await earlier.close();
    await connect(nodeId, keys, TO);
    await expect
      .poll(async () => (await stageOf(operation.operation_id))?.stage, { timeout: 3_000 })
      .toBe('succeeded');
  });

  it('fails verified evidence followed by a reconnect on another release', async () => {
    const { nodeId, keys } = await registerNode();
    const operation = await operationFor(nodeId);
    const old = await connect(nodeId, keys, FROM);
    await progress(old, {
      operation_id: operation.operation_id,
      seq: 1,
      state: 'complete',
      evidence: evidence(),
    });
    expect((await stageOf(operation.operation_id))?.stage).toBe('awaiting_reconnect');
    await old.close();
    await connect(nodeId, keys, FROM);
    await expect
      .poll(async () => (await stageOf(operation.operation_id))?.failure_code, { timeout: 3_000 })
      .toBe('version_mismatch');
  });

  /** An event names its operation; it moves that one and no other. */
  it('never lets progress from another attempt complete the current one', async () => {
    const { nodeId, keys } = await registerNode();
    const earlier = await operationFor(nodeId, 'v0.1.0-alpha.29');
    await nodeUpdatesRepo.recordProgress(pool, earlier.operation_id, {
      seq: 1,
      state: 'failed',
      failureCode: 'download_failed',
    });
    const current = await operationFor(nodeId);
    const node = await connect(nodeId, keys, TO);

    // A late, stale `complete` for the earlier attempt, carrying evidence that
    // would satisfy the current one.
    await progress(node, {
      operation_id: earlier.operation_id,
      seq: 2,
      state: 'complete',
      evidence: evidence(),
    });
    expect((await stageOf(earlier.operation_id))?.stage).toBe('failed');
    expect((await stageOf(current.operation_id))?.stage).toBe('accepted');

    // Evidence for another release, delivered for the current attempt.
    await progress(node, {
      operation_id: current.operation_id,
      seq: 1,
      state: 'complete',
      evidence: evidence({
        target_release: 'v0.1.0-alpha.29',
        node_release: 'v0.1.0-alpha.29',
        runtime_release: 'v0.1.0-alpha.29',
      }),
    });
    expect((await stageOf(current.operation_id))?.failure_code).toBe('evidence_mismatch');
  });

  it('never lets one Node move another Node’s operation', async () => {
    const mine = await registerNode();
    const theirs = await registerNode();
    const operation = await operationFor(theirs.nodeId);
    const node = await connect(mine.nodeId, mine.keys, TO);
    await progress(node, {
      operation_id: operation.operation_id,
      seq: 1,
      state: 'complete',
      evidence: evidence(),
    });
    expect((await stageOf(operation.operation_id))?.stage).toBe('accepted');
  });
});

describe('a failed verification says what failed and what was restored', () => {
  it('keeps the worker, its state and the rollback outcome', async () => {
    const { nodeId, keys } = await registerNode();
    const operation = await operationFor(nodeId);
    const node = await connect(nodeId, keys, FROM);
    const detail = {
      check: 'services',
      services: [
        {
          role: { kind: 'project_worker', project_id: 'prj_2b0179646e394239' },
          reason: 'not_active',
          last: { active_state: 'activating', main_pid: null, executable: 'no_process' },
        },
      ],
      rollback: 'restored',
    };
    await progress(node, {
      operation_id: operation.operation_id,
      seq: 1,
      state: 'failed',
      failure_code: 'services_not_converged',
      failure_detail: detail,
    });
    const after = await stageOf(operation.operation_id);
    expect(after?.stage).toBe('failed');
    expect(after?.failure_code).toBe('services_not_converged');
    expect(after?.failure_detail).toEqual(detail);
    expect(after?.failure_message).toContain('prj_2b0179646e394239');
    expect(after?.failure_message).toContain('activating');
    expect(after?.failure_message).toContain('previous installation was restored and verified');

    // A reconnect afterwards, on any release, does not reopen it.
    await node.close();
    await connect(nodeId, keys, TO);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await stageOf(operation.operation_id))?.stage).toBe('failed');
  });

  /** Fail-closed: a report the Control Plane cannot read is not acknowledged. */
  it('refuses malformed evidence and detail without moving anything', async () => {
    const { nodeId, keys } = await registerNode();
    const operation = await operationFor(nodeId);
    const node = await connect(nodeId, keys, TO);
    for (const [seq, extra] of [
      [1, { evidence: evidence({ unexpected: true }) }],
      [2, { evidence: evidence({ runtime_release: '/opt/asterism' }) }],
      [
        3,
        {
          evidence: evidence({
            services: [{ role: { kind: 'project_worker', project_id: '../etc' }, main_pid: 1 }],
          }),
        },
      ],
      [4, { failure_detail: { check: 'services', rollback: 'restored', path: '/opt' } }],
    ] as const) {
      node.sendUpdateProgress({
        operation_id: operation.operation_id,
        seq,
        state: 'complete',
        ...extra,
      });
      expect(await node.waitForUpdateAck(operation.operation_id, seq, 400)).toBe(false);
    }
    expect((await stageOf(operation.operation_id))?.stage).toBe('accepted');
  });
});
