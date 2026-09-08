import { describe, expect, it } from 'vitest';

import {
  AWAITING_RECONNECT_PERCENT,
  decideUpdateProgress,
  isTerminalStage,
  percentForUpdate,
  resolveReconnect,
  stageForState,
  stallVerdict,
  UPDATE_STAGES,
  type OperationView,
  type UpdateStage,
} from '../../src/node-updates.js';

const REQUESTED = 'v0.1.0-alpha.22';

function operation(overrides: Partial<OperationView> = {}): OperationView {
  return {
    stage: 'applying',
    percent: 40,
    last_seq: 5,
    requested_version: REQUESTED,
    ...overrides,
  };
}

describe('what the updater says maps onto what a person reads', () => {
  it('treats the installer vocabulary as work in progress', () => {
    for (const state of [
      'bundle_metadata_fetched',
      'bundle_downloading',
      'bundle_verified',
      'runtime_installing',
      'configuration_writing',
      'services_starting',
      'health_verifying',
    ] as const) {
      expect(stageForState(state)).toBe('applying');
    }
  });

  /**
   * The rule the whole operation exists for. `complete` from the updater means
   * the updater finished, and nothing more: the binary could be replaced and the
   * runtime beneath it untouched, which is exactly what `v0.1.0-alpha.19` did.
   */
  it('never lets the updater finishing mean the update succeeded', () => {
    expect(stageForState('complete')).toBe('awaiting_reconnect');
    expect(stageForState('complete')).not.toBe('succeeded');
    expect(percentForUpdate('complete')).toBe(AWAITING_RECONNECT_PERCENT);
    expect(percentForUpdate('complete')).toBeLessThan(100);
  });

  /** No report from a Node can reach 100. Only the reconnect does. */
  it('caps every report short of done', () => {
    for (const state of UPDATE_STAGES) {
      void state;
    }
    expect(percentForUpdate('health_verifying')).toBeLessThanOrEqual(AWAITING_RECONNECT_PERCENT);
    expect(percentForUpdate('bundle_downloading', { done: 10, total: 10 })).toBeLessThanOrEqual(
      AWAITING_RECONNECT_PERCENT,
    );
  });

  it('interpolates a download by real bytes', () => {
    const early = percentForUpdate('bundle_downloading', { done: 1, total: 100 });
    const late = percentForUpdate('bundle_downloading', { done: 90, total: 100 });
    expect(late).toBeGreaterThan(early);
  });

  it('refuses states that belong to an enrollment rather than an update', () => {
    for (const state of ['code_issued', 'cancelled', 'expired'] as const) {
      expect(stageForState(state)).toBe('failed');
    }
  });
});

describe('progress only ever moves forward', () => {
  /**
   * The Node replays from a local journal until the Control Plane says it has
   * the event, so after a restart every event is a duplicate of something.
   */
  it('discards an event it has already applied', () => {
    expect(decideUpdateProgress(operation(), { seq: 5, state: 'runtime_installing' })).toEqual({
      apply: false,
      reason: 'already_applied',
    });
    expect(decideUpdateProgress(operation(), { seq: 1, state: 'runtime_installing' })).toEqual({
      apply: false,
      reason: 'already_applied',
    });
  });

  it('accepts the next one', () => {
    const decision = decideUpdateProgress(operation(), { seq: 6, state: 'runtime_installing' });
    expect(decision.apply).toBe(true);
  });

  /**
   * Clamped rather than rejected. Rejecting would leave `last_seq` behind and
   * the Node would redeliver that event forever, because it never became old
   * news.
   */
  it('clamps a report that would move the bar backwards instead of dropping it', () => {
    const decision = decideUpdateProgress(operation({ percent: 80 }), {
      seq: 6,
      state: 'bundle_metadata_fetched',
    });
    expect(decision).toEqual({ apply: true, stage: 'applying', percent: 80 });
  });

  it('keeps the bar where it stopped when the updater fails', () => {
    const decision = decideUpdateProgress(operation({ percent: 62 }), {
      seq: 6,
      state: 'failed',
      failureCode: 'download_failed',
    });
    expect(decision).toEqual({ apply: true, stage: 'failed', percent: 62 });
  });

  /** An operation that ended did not later un-end. */
  it('refuses to reopen an operation that already finished', () => {
    for (const stage of ['succeeded', 'failed', 'timed_out'] as UpdateStage[]) {
      expect(isTerminalStage(stage)).toBe(true);
      expect(
        decideUpdateProgress(operation({ stage, last_seq: 1 }), {
          seq: 99,
          state: 'runtime_installing',
        }),
      ).toEqual({ apply: false, reason: 'already_terminal' });
    }
  });

  it('refuses a state it does not know', () => {
    expect(decideUpdateProgress(operation(), { seq: 9, state: 'rm -rf /' as never })).toEqual({
      apply: false,
      reason: 'not_an_update_state',
    });
  });
});

describe('success is the Node coming back on the release that was asked for', () => {
  it('accepts exactly the requested release, from wherever it had got to', () => {
    for (const stage of ['accepted', 'applying', 'awaiting_reconnect'] as UpdateStage[]) {
      expect(resolveReconnect({ stage, requested_version: REQUESTED }, REQUESTED)).toEqual({
        outcome: 'succeeded',
      });
    }
  });

  /** A reconnect on another release, once the updater is done, is a mismatch. */
  it('calls a different release a mismatch and names both', () => {
    const verdict = resolveReconnect(
      { stage: 'awaiting_reconnect', requested_version: REQUESTED },
      'v0.1.0-alpha.21',
    );
    expect(verdict.outcome).toBe('failed');
    if (verdict.outcome !== 'failed') throw new Error('unreachable');
    expect(verdict.failureCode).toBe('version_mismatch');
    expect(verdict.message).toContain('v0.1.0-alpha.21');
    expect(verdict.message).toContain(REQUESTED);
  });

  /**
   * A Node that drops its connection for a moment and comes back on the version
   * it has not replaced yet is not a failed update. Failing one for a brief
   * network fault would be worse than waiting.
   */
  it('ignores a blip before the updater has finished', () => {
    for (const stage of ['queued', 'accepted', 'applying'] as UpdateStage[]) {
      expect(resolveReconnect({ stage, requested_version: REQUESTED }, 'v0.1.0-alpha.21')).toEqual({
        outcome: 'ignore',
        reason: 'still_working',
      });
    }
  });

  it('leaves an operation that already ended alone', () => {
    expect(
      resolveReconnect({ stage: 'succeeded', requested_version: REQUESTED }, REQUESTED),
    ).toEqual({ outcome: 'ignore', reason: 'already_terminal' });
  });

  it('does not accept a missing version as a match', () => {
    const verdict = resolveReconnect(
      { stage: 'awaiting_reconnect', requested_version: REQUESTED },
      null,
    );
    expect(verdict.outcome).toBe('failed');
  });
});

describe('an operation that stops reporting is ended, not left live', () => {
  const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000);
  const now = new Date();

  it('says nothing while a stage is still within its time', () => {
    expect(stallVerdict({ stage: 'applying', updated_at: at(60) }, now)).toBeNull();
    expect(stallVerdict({ stage: 'awaiting_reconnect', updated_at: at(60) }, now)).toBeNull();
  });

  it('names why each stage ran out', () => {
    expect(stallVerdict({ stage: 'queued', updated_at: at(10_000) }, now)?.failureCode).toBe(
      'not_accepted',
    );
    expect(stallVerdict({ stage: 'applying', updated_at: at(10_000) }, now)?.failureCode).toBe(
      'no_progress',
    );
    expect(
      stallVerdict({ stage: 'awaiting_reconnect', updated_at: at(10_000) }, now)?.failureCode,
    ).toBe('no_reconnect');
  });

  /** A long download is not a stall: any report resets the clock. */
  it('measures from the last thing that moved, not from the start', () => {
    expect(stallVerdict({ stage: 'applying', updated_at: at(30) }, now)).toBeNull();
  });

  it('never re-ends an operation that already ended', () => {
    for (const stage of ['succeeded', 'failed', 'timed_out'] as UpdateStage[]) {
      expect(stallVerdict({ stage, updated_at: at(100_000) }, now)).toBeNull();
    }
  });
});
