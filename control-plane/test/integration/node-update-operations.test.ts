import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPool, migrate, rollbackAll, type Pool } from '../../src/db.js';
import { nodeUpdatesRepo } from '../../src/node-update-repository.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://asterism:asterism@127.0.0.1:55432/asterism_cp';
const ORG = 'org_bootstrap';
const NODE = 'node-under-test';
const FROM = 'v0.1.0-alpha.21';
const TO = 'v0.1.0-alpha.22';

let pool: Pool;
let user: string;

beforeAll(async () => {
  pool = createPool(DATABASE_URL);
  await rollbackAll(pool).catch(() => undefined);
  await migrate(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE node_update_operations, nodes, users CASCADE');
  user = `usr_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  await pool.query(
    `INSERT INTO users (user_id, normalized_email, password_hash, display_name)
     VALUES ($1, $2, 'x', 'T')`,
    [user, `${user}@example.com`],
  );
  await pool.query(
    `INSERT INTO nodes (node_id, organization_id, display_name, public_key, fingerprint,
                        identity_generation, software_version)
     VALUES ($1, $2, $1, 'k', 'f', 1, $3)`,
    [NODE, ORG, FROM],
  );
});

async function start() {
  return nodeUpdatesRepo.create(pool, {
    organizationId: ORG,
    nodeId: NODE,
    commandId: null,
    requestedVersion: TO,
    previousVersion: FROM,
    requestedByUserId: user,
  });
}

describe('the operation the command stands in for', () => {
  it('starts queued, knowing what it wants and where it came from', async () => {
    const operation = await start();
    expect(operation.stage).toBe('queued');
    expect(operation.percent).toBe(0);
    expect(operation.requested_version).toBe(TO);
    expect(operation.previous_version).toBe(FROM);
    expect(operation.requested_by_user_id).toBe(user);
    expect(operation.reported_version).toBeNull();
    expect(operation.terminal_at).toBeNull();
  });

  /**
   * The whole point of the separation, asserted rather than described: the
   * command being accepted moves the operation off `queued` and no further.
   */
  it('is not completed by the command being accepted', async () => {
    const operation = await start();
    await nodeUpdatesRepo.markAccepted(pool, operation.operation_id);

    const after = await nodeUpdatesRepo.byId(pool, operation.operation_id);
    expect(after?.stage).toBe('accepted');
    expect(after?.stage).not.toBe('succeeded');
    expect(after?.terminal_at).toBeNull();
    expect(after?.percent).toBeLessThan(100);
  });

  /** A second update while one runs is two updaters racing for one binary. */
  it('allows only one live operation per Node', async () => {
    await start();
    await expect(start()).rejects.toThrow();
  });

  it('lets a new one start once the last has ended', async () => {
    const first = await start();
    await nodeUpdatesRepo.recordProgress(pool, first.operation_id, { seq: 1, state: 'failed' });
    await expect(start()).resolves.toBeTruthy();
  });
});

describe('progress, and what it refuses', () => {
  it('records a report and its history together', async () => {
    const operation = await start();
    const outcome = await nodeUpdatesRepo.recordProgress(pool, operation.operation_id, {
      seq: 1,
      state: 'bundle_downloading',
      bytesDone: 100,
      bytesTotal: 1000,
    });
    expect(outcome.applied).toBe(true);
    expect(outcome.operation?.stage).toBe('applying');

    const events = await nodeUpdatesRepo.events(pool, operation.operation_id);
    expect(events).toHaveLength(1);
    expect(events[0]?.detail_state).toBe('bundle_downloading');
    expect(Number(events[0]?.seq)).toBe(1);
  });

  /** After a restart the Node replays everything unacknowledged. */
  it('discards a replay without disturbing what it already knows', async () => {
    const operation = await start();
    await nodeUpdatesRepo.recordProgress(pool, operation.operation_id, {
      seq: 2,
      state: 'runtime_installing',
    });
    const replay = await nodeUpdatesRepo.recordProgress(pool, operation.operation_id, {
      seq: 2,
      state: 'runtime_installing',
    });
    expect(replay.applied).toBe(false);
    expect(replay.reason).toBe('already_applied');
    expect(await nodeUpdatesRepo.events(pool, operation.operation_id)).toHaveLength(1);
  });

  /**
   * An event belonging to a finished update must not reopen the one running
   * now. The operation id is what separates them, and it is checked here.
   */
  it('never lets an event from an earlier operation move a later one', async () => {
    const first = await start();
    await nodeUpdatesRepo.recordProgress(pool, first.operation_id, { seq: 1, state: 'failed' });
    const second = await start();

    // The stale event names its own operation, which has already ended.
    const stale = await nodeUpdatesRepo.recordProgress(pool, first.operation_id, {
      seq: 9,
      state: 'complete',
    });
    expect(stale.applied).toBe(false);
    expect(stale.reason).toBe('already_terminal');

    const live = await nodeUpdatesRepo.byId(pool, second.operation_id);
    expect(live?.stage).toBe('queued');
    expect(live?.percent).toBe(0);
  });

  it('keeps the bar monotonic across an out-of-order report', async () => {
    const operation = await start();
    await nodeUpdatesRepo.recordProgress(pool, operation.operation_id, {
      seq: 1,
      state: 'configuration_writing',
    });
    const high = (await nodeUpdatesRepo.byId(pool, operation.operation_id))!.percent;
    await nodeUpdatesRepo.recordProgress(pool, operation.operation_id, {
      seq: 2,
      state: 'bundle_metadata_fetched',
    });
    const after = await nodeUpdatesRepo.byId(pool, operation.operation_id);
    expect(after!.percent).toBe(high);
    // Applied all the same, so the Node stops replaying it.
    expect(Number(after!.last_seq)).toBe(2);
  });
});

describe('how an update ends', () => {
  async function reachAwaitingReconnect() {
    const operation = await start();
    await nodeUpdatesRepo.markAccepted(pool, operation.operation_id);
    await nodeUpdatesRepo.recordProgress(pool, operation.operation_id, {
      seq: 1,
      state: 'complete',
    });
    const after = await nodeUpdatesRepo.byId(pool, operation.operation_id);
    expect(after?.stage).toBe('awaiting_reconnect');
    // The updater finishing is not success, and the bar says so.
    expect(after?.percent).toBeLessThan(100);
    return operation;
  }

  it('is successful only when the Node comes back on the release asked for', async () => {
    const operation = await reachAwaitingReconnect();
    const settled = await nodeUpdatesRepo.resolveOnReconnect(pool, NODE, TO);
    expect(settled?.outcome).toBe('succeeded');

    const final = await nodeUpdatesRepo.byId(pool, operation.operation_id);
    expect(final?.stage).toBe('succeeded');
    expect(final?.percent).toBe(100);
    expect(final?.reported_version).toBe(TO);
    expect(final?.terminal_at).not.toBeNull();
  });

  it('surfaces a reconnect on the wrong release rather than passing it', async () => {
    const operation = await reachAwaitingReconnect();
    const settled = await nodeUpdatesRepo.resolveOnReconnect(pool, NODE, FROM);
    expect(settled?.outcome).toBe('failed');

    const final = await nodeUpdatesRepo.byId(pool, operation.operation_id);
    expect(final?.stage).toBe('failed');
    expect(final?.failure_code).toBe('version_mismatch');
    expect(final?.reported_version).toBe(FROM);
    expect(final?.failure_message).toContain(TO);
  });

  /** A momentary disconnect during the work is not a failure. */
  it('ignores a reconnect on the old release while the updater is still working', async () => {
    const operation = await start();
    await nodeUpdatesRepo.recordProgress(pool, operation.operation_id, {
      seq: 1,
      state: 'bundle_downloading',
    });
    const settled = await nodeUpdatesRepo.resolveOnReconnect(pool, NODE, FROM);
    expect(settled?.outcome).toBe('ignore');
    expect((await nodeUpdatesRepo.byId(pool, operation.operation_id))?.stage).toBe('applying');
  });

  it('records an explicit updater failure with its code', async () => {
    const operation = await start();
    await nodeUpdatesRepo.recordProgress(pool, operation.operation_id, {
      seq: 1,
      state: 'bundle_downloading',
    });
    await nodeUpdatesRepo.recordProgress(pool, operation.operation_id, {
      seq: 2,
      state: 'failed',
      failureCode: 'digest_mismatch',
    });
    const final = await nodeUpdatesRepo.byId(pool, operation.operation_id);
    expect(final?.stage).toBe('failed');
    expect(final?.failure_code).toBe('digest_mismatch');
    expect(final?.terminal_at).not.toBeNull();
  });

  it('ends one that stopped reporting, and leaves a live one alone', async () => {
    const operation = await start();
    await nodeUpdatesRepo.recordProgress(pool, operation.operation_id, {
      seq: 1,
      state: 'runtime_installing',
    });
    expect(await nodeUpdatesRepo.sweepStalled(pool)).toHaveLength(0);

    await pool.query(
      `UPDATE node_update_operations SET updated_at = now() - interval '3 hours'
        WHERE operation_id = $1`,
      [operation.operation_id],
    );
    const ended = await nodeUpdatesRepo.sweepStalled(pool);
    expect(ended).toHaveLength(1);
    expect(ended[0]?.stage).toBe('timed_out');
    expect(ended[0]?.failure_code).toBe('no_progress');
  });

  /**
   * The terminal state is in the history too, so a browser replaying events
   * reaches the same end the operation row shows.
   */
  it('writes the ending into the history a page replays', async () => {
    const operation = await reachAwaitingReconnect();
    await nodeUpdatesRepo.resolveOnReconnect(pool, NODE, TO);
    const events = await nodeUpdatesRepo.events(pool, operation.operation_id);
    expect(events.at(-1)?.stage).toBe('succeeded');
    expect(events.at(-1)?.percent).toBe(100);
  });
});

describe('what survives', () => {
  /**
   * A Control Plane restart is a new pool against the same database. The
   * operation is a row, so nothing about it lived in the process that stopped —
   * and a browser reload is the same question asked from the other side.
   */
  it('a Control Plane restart, and a reload afterwards', async () => {
    const operation = await start();
    await nodeUpdatesRepo.recordProgress(pool, operation.operation_id, {
      seq: 1,
      state: 'runtime_installing',
    });

    const restarted = createPool(DATABASE_URL);
    try {
      const seen = await nodeUpdatesRepo.byId(restarted, operation.operation_id);
      expect(seen?.stage).toBe('applying');
      expect(seen?.percent).toBeGreaterThan(0);
      expect(Number(seen?.last_seq)).toBe(1);

      // What the page asks for when it comes back knowing only the Node.
      const latest = await nodeUpdatesRepo.latestForNode(restarted, NODE);
      expect(latest?.operation_id).toBe(operation.operation_id);
      // And the history it replays to redraw itself.
      expect(await nodeUpdatesRepo.events(restarted, operation.operation_id)).toHaveLength(1);
    } finally {
      await restarted.end();
    }
  });

  it('shows the last operation once it has ended, not an empty panel', async () => {
    const operation = await start();
    await nodeUpdatesRepo.recordProgress(pool, operation.operation_id, { seq: 1, state: 'failed' });
    expect(await nodeUpdatesRepo.liveForNode(pool, NODE)).toBeNull();
    expect((await nodeUpdatesRepo.latestForNode(pool, NODE))?.stage).toBe('failed');
  });
});
