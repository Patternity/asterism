import { describe, expect, it } from 'vitest';

import {
  liveStatusFromEvent,
  runFailureFromEvent,
  terminalStatusFromEvent,
} from '../../src/node-channel.js';

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

describe('failure reason from Node events', () => {
  // The exact payload Hermes sent when the Codex quota ran out. The prose is
  // the whole point: without it the console shows a bare "failed".
  it('takes the prose Hermes puts in `error` on run.failed', () => {
    expect(
      runFailureFromEvent('run.failed', {
        event: 'run.failed',
        error:
          '⚠️ Provider authentication failed: Codex provider quota exhausted (429); retry after 5932s. Credentials are still valid.',
        run_id: 'run_1a1ba26c46464730bf530593f9c5a55c',
      }),
    ).toEqual({
      errorMessage:
        '⚠️ Provider authentication failed: Codex provider quota exhausted (429); retry after 5932s. Credentials are still valid.',
    });
  });

  // A Node-side refusal spells it the other way round, so the two cannot share
  // one field-reading rule.
  it('reads a Node refusal as a slug plus its prose', () => {
    expect(
      runFailureFromEvent('asterism.run.terminal', {
        status: 'failed',
        error: 'run_conflict',
        message: 'project asterism-control-plane already has an active run',
      }),
    ).toEqual({
      errorCode: 'run_conflict',
      errorMessage: 'project asterism-control-plane already has an active run',
    });
  });

  it('finds nothing in a terminal event that carries only a status', () => {
    expect(
      runFailureFromEvent('asterism.run.terminal', { status: 'failed', hermes_status: 'failed' }),
    ).toBeNull();
    expect(runFailureFromEvent('asterism.run.terminal', { status: 'completed' })).toBeNull();
  });

  it('ignores events that are not about a run ending', () => {
    expect(runFailureFromEvent('message.delta', { error: 'not a failure' })).toBeNull();
    expect(runFailureFromEvent('tool.completed', { message: 'done' })).toBeNull();
  });

  it('treats blank and non-string values as no reason at all', () => {
    expect(runFailureFromEvent('run.failed', { error: '   ' })).toBeNull();
    expect(runFailureFromEvent('run.failed', { error: 42 })).toBeNull();
    expect(runFailureFromEvent('run.failed', {})).toBeNull();
    expect(runFailureFromEvent('run.failed', null)).toBeNull();
  });

  // The column is bounded by the wire schema; an over-long reason must be
  // trimmed rather than fail the whole event ingestion.
  it('bounds the reason to what the schema allows', () => {
    const failure = runFailureFromEvent('run.failed', { error: 'x'.repeat(5000) });
    expect(failure?.errorMessage).toHaveLength(4096);
  });
});
