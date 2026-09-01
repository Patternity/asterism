import { describe, expect, it } from 'vitest';

import {
  FAILURE_CODES,
  INSTALLATION_STATES,
  type AttemptView,
  decideProgress,
  isFailureCode,
  isInstallationState,
  isRetryable,
  isTerminal,
  percentFor,
} from '../../src/node-installations.js';

const attempt = (over: Partial<AttemptView> = {}): AttemptView => ({
  state: 'code_issued',
  generation: 1,
  percent: 0,
  ...over,
});

describe('installation stages', () => {
  it('are typed values rather than free text', () => {
    expect(isInstallationState('bundle_downloading')).toBe(true);
    // The whole point of typing them: a stage cannot be spelled wrong, and the
    // console switches on a value instead of matching an English sentence.
    expect(isInstallationState('Downloading bundle...')).toBe(false);
    expect(isInstallationState('almost_there')).toBe(false);
    expect(isInstallationState(42)).toBe(false);
  });

  it('cover every stage the flow needs', () => {
    for (const required of [
      'code_issued',
      'bootstrap_downloaded',
      'bundle_metadata_fetched',
      'bundle_downloading',
      'bundle_verified',
      'plan_prepared',
      'prerequisites_installing',
      'runtime_installing',
      'configuration_writing',
      'identity_enrolling',
      'services_starting',
      'node_connecting',
      'health_verifying',
      'complete',
      'failed',
      'cancelled',
      'expired',
    ]) {
      expect(INSTALLATION_STATES).toContain(required);
    }
  });

  it('names exactly four endings', () => {
    const terminal = INSTALLATION_STATES.filter(isTerminal);
    expect(terminal).toEqual(['complete', 'failed', 'cancelled', 'expired']);
  });
});

describe('percentage', () => {
  it('never reaches 100 before the installation is complete', () => {
    for (const state of INSTALLATION_STATES) {
      if (state === 'complete') continue;
      expect(percentFor(state, { done: 10 ** 12, total: 10 ** 12 })).toBeLessThan(100);
    }
    expect(percentFor('complete')).toBe(100);
  });

  it('rises through the download in step with real bytes', () => {
    const total = 550 * 1024 * 1024;
    const at = (done: number) => percentFor('bundle_downloading', { done, total });

    expect(at(0)).toBe(5);
    expect(at(total / 2)).toBe(35);
    expect(at(total)).toBe(65);
    // Monotonic across the whole range, not just at the ends.
    let previous = -1;
    for (let step = 0; step <= 100; step += 1) {
      const value = at((total * step) / 100);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('holds at the stage floor when the total is unknown', () => {
    // A fraction of an unknown total is not information. The byte counter still
    // shows movement; the bar declines to invent any.
    expect(percentFor('bundle_downloading', { done: 1024, total: null })).toBe(5);
    expect(percentFor('bundle_downloading', { done: 1024, total: 0 })).toBe(5);
    expect(percentFor('bundle_downloading')).toBe(5);
  });

  it('never exceeds the share the download owns, even if a server overstates it', () => {
    const total = 1000;
    expect(percentFor('bundle_downloading', { done: 5000, total })).toBe(65);
  });

  it('orders the stages by the work they represent', () => {
    const ordered: Array<(typeof INSTALLATION_STATES)[number]> = [
      'code_issued',
      'bootstrap_downloaded',
      'bundle_metadata_fetched',
      'bundle_downloading',
      'bundle_verified',
      'plan_prepared',
      'prerequisites_installing',
      'runtime_installing',
      'configuration_writing',
      'identity_enrolling',
      'services_starting',
      'node_connecting',
      'health_verifying',
      'complete',
    ];
    let previous = -1;
    for (const state of ordered) {
      const value = percentFor(state);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
    // The download really is the bulk of a first installation.
    expect(percentFor('bundle_verified') - percentFor('bundle_downloading')).toBeGreaterThan(50);
  });
});

describe('applying a progress report', () => {
  it('accepts ordinary forward movement', () => {
    const decision = decideProgress(attempt({ state: 'plan_prepared', percent: 67 }), {
      state: 'prerequisites_installing',
      generation: 1,
    });
    expect(decision).toEqual({ apply: true, percent: 70 });
  });

  it('drops a report from an attempt that has been superseded', () => {
    // A retry began; a straggler from the previous attempt is still in flight.
    const decision = decideProgress(attempt({ generation: 2, percent: 5 }), {
      state: 'health_verifying',
      generation: 1,
    });
    expect(decision).toEqual({ apply: false, reason: 'stale_generation' });
  });

  it('lets a new generation start its own bar lower than the old one', () => {
    // A retry begins at the beginning. Holding it to the previous attempt's
    // percentage would show a bar that never moves while real work happens.
    const decision = decideProgress(
      attempt({ state: 'runtime_installing', generation: 1, percent: 72 }),
      { state: 'bootstrap_downloaded', generation: 2 },
    );
    expect(decision).toEqual({ apply: true, percent: 2 });
  });

  it('refuses to move the bar backwards on a duplicate delivery', () => {
    const decision = decideProgress(attempt({ state: 'services_starting', percent: 92 }), {
      state: 'runtime_installing',
      generation: 1,
    });
    expect(decision).toEqual({ apply: false, reason: 'would_move_backwards' });
  });

  it('treats a repeated identical report as harmless', () => {
    const decision = decideProgress(attempt({ state: 'services_starting', percent: 92 }), {
      state: 'services_starting',
      generation: 1,
    });
    expect(decision).toEqual({ apply: true, percent: 92 });
  });

  it('lets the download bar advance by bytes within one stage', () => {
    const first = decideProgress(attempt({ state: 'bundle_downloading', percent: 5 }), {
      state: 'bundle_downloading',
      generation: 1,
      bytesDone: 275 * 1024 * 1024,
      bytesTotal: 550 * 1024 * 1024,
    });
    expect(first).toEqual({ apply: true, percent: 35 });
  });

  it('adds nothing after an ending', () => {
    for (const ending of ['complete', 'failed', 'cancelled', 'expired'] as const) {
      const decision = decideProgress(attempt({ state: ending, percent: 100 }), {
        state: 'health_verifying',
        generation: 1,
      });
      expect(decision).toEqual({ apply: false, reason: 'already_terminal' });
    }
  });

  it('allows a failure to be recorded from anywhere', () => {
    const decision = decideProgress(attempt({ state: 'bundle_downloading', percent: 40 }), {
      state: 'failed',
      generation: 1,
      failureCode: 'digest_mismatch',
    });
    expect(decision.apply).toBe(true);
  });

  it('allows a fresh attempt after a terminal one', () => {
    const decision = decideProgress(attempt({ state: 'failed', generation: 1, percent: 40 }), {
      state: 'code_issued',
      generation: 2,
    });
    expect(decision.apply).toBe(true);
  });
});

describe('failures', () => {
  it('are typed', () => {
    expect(isFailureCode('digest_mismatch')).toBe(true);
    expect(isFailureCode('something went wrong')).toBe(false);
  });

  it('separate what a retry could fix from what it could not', () => {
    for (const permanent of [
      'unsupported_os',
      'unsupported_architecture',
      'unsupported_bundle_schema',
    ] as const) {
      expect(isRetryable(permanent)).toBe(false);
    }
    for (const transient of ['download_failed', 'health_check_failed', 'interrupted'] as const) {
      expect(isRetryable(transient)).toBe(true);
    }
  });

  it('name every failure the installer can reach', () => {
    for (const required of [
      'unsupported_os',
      'unsupported_architecture',
      'insufficient_disk',
      'download_failed',
      'digest_mismatch',
      'signature_invalid',
      'enrollment_rejected',
      'health_check_failed',
    ]) {
      expect(FAILURE_CODES).toContain(required);
    }
  });
});
