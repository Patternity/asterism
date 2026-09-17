import { describe, expect, it } from 'vitest';

import {
  AWAITING_RECONNECT_PERCENT,
  checkEvidence,
  decideUpdateProgress,
  describeFailure,
  isTerminalStage,
  percentForUpdate,
  resolveCompletion,
  resolveReconnect,
  stageForState,
  stallVerdict,
  UPDATE_STAGES,
  type OperationView,
  type UpdateStage,
} from '../../src/node-updates.js';

const REQUESTED = 'v0.1.0-alpha.22';
const CREATED = new Date('2026-09-17T10:00:00Z');

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    target_release: REQUESTED,
    node_release: REQUESTED,
    runtime_release: REQUESTED,
    runtime_revision: 'abc123',
    services: [
      { role: { kind: 'node' as const }, main_pid: 10 },
      { role: { kind: 'project_worker' as const, project_id: 'prj-a' }, main_pid: 11 },
    ],
    ...overrides,
  };
}

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

describe('success needs verified evidence and a Node back on the release', () => {
  const verified = {
    stage: 'awaiting_reconnect' as UpdateStage,
    requested_version: REQUESTED,
    evidence: evidence(),
  };

  /**
   * The false success on node-1: the target binary reconnected while the
   * updater was still working, and that alone ended the operation. Now it is
   * still working, from every stage before verified evidence.
   */
  it('never completes on a reconnect alone, from any stage', () => {
    for (const stage of ['queued', 'accepted', 'applying'] as UpdateStage[]) {
      expect(
        resolveReconnect({ stage, requested_version: REQUESTED, evidence: null }, REQUESTED),
      ).toEqual({ outcome: 'ignore', reason: 'still_working' });
    }
    expect(
      resolveReconnect(
        { stage: 'awaiting_reconnect', requested_version: REQUESTED, evidence: null },
        REQUESTED,
      ),
    ).toEqual({ outcome: 'ignore', reason: 'still_working' });
  });

  it('completes on the requested release once the evidence is in', () => {
    expect(resolveReconnect(verified, REQUESTED)).toEqual({ outcome: 'succeeded' });
  });

  /** A reconnect on another release, once verified evidence is in, is a mismatch. */
  it('calls a different release a mismatch and names both', () => {
    const verdict = resolveReconnect(verified, 'v0.1.0-alpha.21');
    expect(verdict.outcome).toBe('failed');
    if (verdict.outcome !== 'failed') throw new Error('unreachable');
    expect(verdict.failureCode).toBe('version_mismatch');
    expect(verdict.message).toContain('v0.1.0-alpha.21');
    expect(verdict.message).toContain(REQUESTED);
  });

  it('ignores a blip before the updater has finished', () => {
    for (const stage of ['queued', 'accepted', 'applying'] as UpdateStage[]) {
      expect(
        resolveReconnect(
          { stage, requested_version: REQUESTED, evidence: null },
          'v0.1.0-alpha.21',
        ),
      ).toEqual({ outcome: 'ignore', reason: 'still_working' });
    }
  });

  it('leaves an operation that already ended alone', () => {
    expect(
      resolveReconnect(
        { stage: 'succeeded', requested_version: REQUESTED, evidence: evidence() },
        REQUESTED,
      ),
    ).toEqual({ outcome: 'ignore', reason: 'already_terminal' });
  });

  it('does not accept a missing version as a match', () => {
    expect(resolveReconnect(verified, null).outcome).toBe('failed');
  });

  it('completes through the current session only when it began after the operation', () => {
    const view = { ...verified, created_at: CREATED };
    const after = new Date(CREATED.getTime() + 1);
    const before = new Date(CREATED.getTime() - 1);
    expect(resolveCompletion(view, { softwareVersion: REQUESTED, authenticatedAt: after })).toEqual(
      { outcome: 'succeeded' },
    );
    expect(
      resolveCompletion(view, { softwareVersion: REQUESTED, authenticatedAt: before }).outcome,
    ).toBe('ignore');
    expect(
      resolveCompletion(view, { softwareVersion: 'v0.1.0-alpha.21', authenticatedAt: after })
        .outcome,
    ).toBe('ignore');
    expect(resolveCompletion(view, null).outcome).toBe('ignore');
    expect(
      resolveCompletion(
        { ...view, evidence: null },
        { softwareVersion: REQUESTED, authenticatedAt: after },
      ).outcome,
    ).toBe('ignore');
  });
});

describe('what the evidence has to say', () => {
  it('accepts evidence for the requested release that covers the Node', () => {
    expect(checkEvidence(REQUESTED, evidence())).toEqual({ ok: true });
  });

  it('refuses an updater that proved nothing', () => {
    expect(checkEvidence(REQUESTED, null)).toMatchObject({
      ok: false,
      failureCode: 'unverified_completion',
    });
  });

  /** The state node-1 was left in: target binary, previous runtime. */
  it('refuses the target binary over the previous runtime', () => {
    const verdict = checkEvidence(REQUESTED, evidence({ runtime_release: 'v0.1.0-alpha.21' }));
    expect(verdict).toMatchObject({ ok: false, failureCode: 'evidence_mismatch' });
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.message).toContain('runtime is v0.1.0-alpha.21');
  });

  it('refuses evidence that did not verify the Node service', () => {
    expect(
      checkEvidence(
        REQUESTED,
        evidence({ services: [{ role: { kind: 'host_hermes' }, main_pid: 3 }] }),
      ),
    ).toMatchObject({ ok: false, failureCode: 'evidence_mismatch' });
  });

  it('turns complete without evidence into a failure and keeps verified evidence', () => {
    expect(
      decideUpdateProgress(operation({ percent: 90 }), { seq: 6, state: 'complete' }),
    ).toMatchObject({ apply: true, stage: 'failed', failureCode: 'unverified_completion' });
    expect(
      decideUpdateProgress(operation({ percent: 90 }), {
        seq: 6,
        state: 'complete',
        evidence: evidence(),
      }),
    ).toEqual({
      apply: true,
      stage: 'awaiting_reconnect',
      percent: AWAITING_RECONNECT_PERCENT,
      evidence: evidence(),
    });
  });

  it('describes a failure from typed fields only', () => {
    const said = describeFailure({
      check: 'services',
      services: [
        {
          role: { kind: 'project_worker', project_id: 'prj-a' },
          reason: 'wrong_executable',
          last: { active_state: 'active', main_pid: 44, executable: 'previous' },
        },
      ],
      rollback: 'incomplete',
      rollback_services: [
        {
          role: { kind: 'node' },
          reason: 'not_active',
          last: { active_state: 'failed', main_pid: null, executable: 'no_process' },
        },
      ],
    });
    expect(said).toContain('the worker for project prj-a did not settle');
    expect(said).toContain('executable previous');
    expect(said).toContain('could not be fully restored');
    expect(said).toContain('the Node did not settle');
    expect(
      describeFailure({
        check: 'runtime_release',
        found_runtime_release: 'v0.1.0-alpha.21',
        rollback: 'restored',
      }),
    ).toBe(
      'the live runtime was v0.1.0-alpha.21, not the requested release; the previous installation was restored and verified',
    );
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
