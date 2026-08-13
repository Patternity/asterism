import { describe, expect, it } from 'vitest';

import { liveStatusFromEvent, terminalStatusFromEvent } from '../../src/node-channel.js';

describe('run termination from Node events', () => {
  it('ends a run on the Nodeterminal event', () => {
    expect(terminalStatusFromEvent('asterism.run.terminal', { status: 'completed' })).toBe(
      'completed',
    );
    expect(terminalStatusFromEvent('asterism.run.terminal', { status: 'failed' })).toBe('failed');
  });

  it('ends a run when reconciliation reports a terminal outcome', () => {
    // Regression: a Node that reconciled a run to `interrupted` left the
    // Control Plane reporting `running` forever, because only
    // `asterism.run.terminal` was recognised.
    for (const status of ['interrupted', 'lost', 'cancelled', 'failed', 'rejected']) {
      expect(terminalStatusFromEvent('asterism.reconciled', { new_status: status })).toBe(status);
    }
  });

  it('does not end a run when reconciliation returns it to a live state', () => {
    for (const status of ['running', 'waiting_for_approval', 'recovering', 'queued']) {
      expect(terminalStatusFromEvent('asterism.reconciled', { new_status: status })).toBeNull();
    }
  });

  it('ignores events that carry no status', () => {
    expect(terminalStatusFromEvent('asterism.run.terminal', {})).toBeNull();
    expect(terminalStatusFromEvent('asterism.reconciled', {})).toBeNull();
    expect(terminalStatusFromEvent('message.delta', { status: 'completed' })).toBeNull();
    expect(terminalStatusFromEvent('asterism.reconciled', null)).toBeNull();
    expect(terminalStatusFromEvent('asterism.run.terminal', { status: 7 })).toBeNull();
  });
});

describe('liveStatusFromEvent', () => {
  it('parks a run only for a real approval request', () => {
    expect(liveStatusFromEvent('approval.request')).toBe('waiting_for_approval');
    expect(liveStatusFromEvent('message.delta')).toBeNull();
    expect(liveStatusFromEvent('tool.started')).toBeNull();
  });
});
