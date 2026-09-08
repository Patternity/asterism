import { describe, expect, it } from 'vitest';

import {
  downloadLabel,
  isLive,
  pollInterval,
  stageLabel,
  stageTone,
  type UpdateOperation,
  type UpdateStage,
} from '../src/update-operation';

function operation(overrides: Partial<UpdateOperation> = {}): UpdateOperation {
  return {
    operation_id: 'op-1',
    requested_version: 'v0.1.0-alpha.22',
    previous_version: 'v0.1.0-alpha.21',
    stage: 'applying',
    percent: 40,
    ...overrides,
  };
}

describe('a page asks again only while something is happening', () => {
  it('polls through every live stage', () => {
    for (const stage of ['queued', 'accepted', 'applying', 'awaiting_reconnect'] as UpdateStage[]) {
      expect(isLive(operation({ stage }))).toBe(true);
      expect(pollInterval(operation({ stage }))).toBeGreaterThan(0);
    }
  });

  /** An operation that ended is a fact. Asking forever is how a forgotten tab
   *  keeps a Control Plane busy for a week. */
  it('stops once it has ended', () => {
    for (const stage of ['succeeded', 'failed', 'timed_out'] as UpdateStage[]) {
      expect(isLive(operation({ stage }))).toBe(false);
      expect(pollInterval(operation({ stage }))).toBe(false);
    }
  });

  it('has nothing to poll when there is no operation', () => {
    expect(isLive(null)).toBe(false);
    expect(pollInterval(undefined)).toBe(false);
  });
});

describe('what each stage says to a person', () => {
  it('names the release in every stage', () => {
    for (const stage of ['queued', 'accepted', 'applying', 'awaiting_reconnect'] as UpdateStage[]) {
      expect(stageLabel(operation({ stage }))).toContain('v0.1.0-alpha.22');
    }
  });

  /**
   * The stage the whole operation exists for. The updater has done everything
   * it can and the answer is not in; a page that said "done" here would make
   * exactly the claim being withheld.
   */
  it('says it is waiting, not that it is done, while awaiting the reconnect', () => {
    const label = stageLabel(operation({ stage: 'awaiting_reconnect', percent: 99 }));
    expect(label).toMatch(/waiting/i);
    expect(label).not.toMatch(/succeeded|complete|done/i);
    expect(stageTone('awaiting_reconnect')).toBe('warn');
  });

  it('reports success against the release the Node actually came back on', () => {
    const label = stageLabel(
      operation({ stage: 'succeeded', reported_version: 'v0.1.0-alpha.22', percent: 100 }),
    );
    expect(label).toContain('v0.1.0-alpha.22');
    expect(stageTone('succeeded')).toBe('ok');
  });

  it('prefers the failure it was given over a generic sentence', () => {
    expect(
      stageLabel(
        operation({
          stage: 'failed',
          failure_code: 'version_mismatch',
          failure_message: 'the Node came back reporting v0.1.0-alpha.21, not v0.1.0-alpha.22',
        }),
      ),
    ).toContain('v0.1.0-alpha.21');
    expect(stageTone('failed')).toBe('fail');
    expect(stageTone('timed_out')).toBe('fail');
  });

  it('says what the installer is doing, not which state it is in', () => {
    const label = stageLabel(operation({ detail_state: 'bundle_downloading' }));
    expect(label).toContain('downloading');
    expect(label).not.toContain('bundle_downloading');
  });
});

describe('bytes are shown only when there is an honest figure', () => {
  it('shows how far a download has got', () => {
    expect(
      downloadLabel(
        operation({
          detail_state: 'bundle_downloading',
          bytes_done: 250_000_000,
          bytes_total: 518_000_000,
        }),
      ),
    ).toBe('250 MB of 518 MB');
  });

  it('shows what arrived when no total is known', () => {
    expect(
      downloadLabel(operation({ detail_state: 'bundle_downloading', bytes_done: 5_000_000 })),
    ).toBe('5 MB');
  });

  it('shows nothing outside a download, and nothing at zero', () => {
    expect(downloadLabel(operation({ detail_state: 'runtime_installing' }))).toBeNull();
    expect(
      downloadLabel(operation({ detail_state: 'bundle_downloading', bytes_done: 0 })),
    ).toBeNull();
  });
});
