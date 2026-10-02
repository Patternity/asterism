/**
 * The Task lifecycle, from the outside.
 *
 * What must hold: a successful run never completes a task on its own; a stale
 * run cannot overwrite newer state; a refusal says something a person can act
 * on; and the states and actions the product claims to support are the ones the
 * table actually covers.
 */
import { describe, expect, it } from 'vitest';

import {
  BOARD_COLUMNS,
  TASK_ACTIONS,
  TASK_STATES,
  agentReportIsCurrent,
  eventSummary,
  isLive,
  isTaskAction,
  isCompletionPolicy,
  isTaskState,
  settleFinishedRun,
  settleUnsuccessfulRun,
  stateLabel,
  transitionFor,
  type PendingCompletion,
  type TaskAction,
  type TaskState,
} from '../src/tasks';

describe('task transitions', () => {
  it('moves a finished run to review, never straight to completed', () => {
    const verdict = transitionFor('running', 'run_finished');
    expect(verdict).toEqual({ allowed: true, to: 'review' });
  });

  it('completes a reviewed task at once, and routes a running one through a request', () => {
    expect(transitionFor('review', 'complete')).toEqual({ allowed: true, to: 'completed' });
    // A running task is not completed on the spot by anybody, agent or person.
    // The wish is recorded and settled when the Run actually ends.
    expect(transitionFor('running', 'request_completion')).toEqual({
      allowed: true,
      to: 'running',
    });
    for (const from of ['backlog', 'ready', 'waiting_input', 'failed'] as TaskState[]) {
      const verdict = transitionFor(from, 'complete');
      expect(verdict.allowed).toBe(false);
    }
  });

  it('keeps a retry on the same task by allowing a start from a bad ending', () => {
    expect(transitionFor('failed', 'start')).toEqual({ allowed: true, to: 'running' });
    expect(transitionFor('cancelled', 'start')).toEqual({ allowed: true, to: 'running' });
  });

  it('refuses a second start while a run is in flight, and suggests what to do', () => {
    const verdict = transitionFor('running', 'start');
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toMatch(/already running/i);
  });

  it('treats an agent report as recordable without moving the task', () => {
    // The Run, not the report, is what ends a Task. A report that moved the
    // Task would let a crash after the report leave a false success behind.
    expect(transitionFor('running', 'agent_reported_result')).toEqual({
      allowed: true,
      to: 'running',
    });
    expect(transitionFor('running', 'agent_reported_failure')).toEqual({
      allowed: true,
      to: 'running',
    });
  });

  it('sends a task the agent cannot finish to waiting for input', () => {
    expect(transitionFor('running', 'agent_needs_input')).toEqual({
      allowed: true,
      to: 'waiting_input',
    });
    // Answering does not start the work again by itself: something has to ask.
    expect(transitionFor('waiting_input', 'answer_input')).toEqual({ allowed: true, to: 'ready' });
  });

  it('explains a terminal task by name instead of a bare refusal', () => {
    const verdict = transitionFor('completed', 'start');
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toMatch(/completed.*reopen/i);
  });

  it('allows every action from at least one state, so none is unreachable', () => {
    for (const action of TASK_ACTIONS) {
      const reachable = TASK_STATES.some((from) => transitionFor(from, action).allowed);
      expect(reachable, `${action} is never allowed from anywhere`).toBe(true);
    }
  });

  it('never transitions to a state outside the declared set', () => {
    for (const from of TASK_STATES) {
      for (const action of TASK_ACTIONS) {
        const verdict = transitionFor(from, action);
        if (verdict.allowed) expect(TASK_STATES).toContain(verdict.to);
      }
    }
  });

  it('rejects an action it does not know', () => {
    const verdict = transitionFor('ready', 'teleport' as TaskAction);
    expect(verdict.allowed).toBe(false);
  });
});

describe('an agent report is only authoritative for the attempt in flight', () => {
  const base = {
    taskVersion: 7,
    observedVersion: 7,
    currentRunId: 'run-2',
    reportingRunId: 'run-2',
  };

  it('accepts the current run reporting against the current version', () => {
    expect(agentReportIsCurrent(base).allowed).toBe(true);
  });

  it('refuses a superseded run, and says so in words a person can read', () => {
    const verdict = agentReportIsCurrent({ ...base, reportingRunId: 'run-1' });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toMatch(/earlier run/i);
  });

  it('refuses a report formed before a change somebody already made', () => {
    const verdict = agentReportIsCurrent({ ...base, observedVersion: 6 });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toMatch(/changed after/i);
  });

  it('refuses a report when no run is in flight at all', () => {
    const verdict = agentReportIsCurrent({ ...base, currentRunId: null });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toMatch(/no run in flight/i);
  });
});

describe('what a person reads', () => {
  it('labels every state without leaking the stored value', () => {
    for (const state of TASK_STATES) {
      const label = stateLabel(state);
      expect(label).not.toContain('_');
      expect(label.length).toBeGreaterThan(0);
    }
    // Actor-neutral: the input may be owed by another system, not by the reader.
    expect(stateLabel('waiting_input')).toBe('Waiting for input');
    expect(stateLabel('waiting_input')).not.toMatch(/\byou\b/i);
  });

  it('puts every state on the board exactly once', () => {
    expect([...BOARD_COLUMNS].sort()).toEqual([...TASK_STATES].sort());
    expect(new Set(BOARD_COLUMNS).size).toBe(BOARD_COLUMNS.length);
  });

  it('treats only a running task as live', () => {
    for (const state of TASK_STATES) expect(isLive(state)).toBe(state === 'running');
  });

  it('names a tool it was actually told about, and stays vague when it was not', () => {
    expect(eventSummary({ eventType: 'tool.started', detail: { tool: 'terminal' } })).toBe(
      'Running a tool: terminal',
    );
    expect(eventSummary({ eventType: 'tool.started' })).toBe('Running a tool');
  });

  it('attributes what the agent said about itself to the agent', () => {
    expect(
      eventSummary({ eventType: 'activity.reported', detail: { activity: 'editing files' } }),
    ).toMatch(/^Agent reported:/);
  });

  it('carries a run failure reason into the sentence a person sees', () => {
    expect(eventSummary({ eventType: 'run.failed', detail: { reason: 'HTTP 401' } })).toBe(
      'Run failed: HTTP 401',
    );
  });

  it('falls back to the event name rather than inventing a sentence', () => {
    expect(eventSummary({ eventType: 'something.new' })).toBe('something.new');
  });
});

describe('guards', () => {
  it('recognises its own states and actions and nothing else', () => {
    expect(isTaskState('review')).toBe(true);
    expect(isTaskState('in_review')).toBe(false);
    expect(isTaskAction('start')).toBe(true);
    expect(isTaskAction('launch')).toBe(false);
  });
});

describe('settling a run that finished successfully', () => {
  const base = {
    runId: 'run-2',
    generation: 3,
    policy: 'agent_outcome' as const,
    unresolvedInputRequests: 0,
  };
  const pending: PendingCompletion = { source: 'agent', runId: 'run-2', generation: 3 };

  it('completes without a person when a valid outcome was asked for', () => {
    const settled = settleFinishedRun({ ...base, pending });
    expect(settled.to).toBe('completed');
    expect(settled.action).toBe('run_finished_completing');
    expect(settled.requestOutcome).toBe('accepted');
  });

  it('treats a person asking the same way as the agent asking', () => {
    const byUser: PendingCompletion = { ...pending, source: 'user' };
    expect(settleFinishedRun({ ...base, pending: byUser }).to).toBe('completed');
  });

  it('reviews a run nobody claimed was done', () => {
    const settled = settleFinishedRun({ ...base, pending: null });
    expect(settled.to).toBe('review');
    expect(settled.requestOutcome).toBeNull();
    expect(settled.reason).toMatch(/nothing claimed/i);
  });

  it('refuses a request made during an earlier run of the same task', () => {
    const settled = settleFinishedRun({ ...base, pending: { ...pending, runId: 'run-1' } });
    expect(settled.to).toBe('review');
    expect(settled.requestOutcome).toBe('rejected');
    expect(settled.reason).toMatch(/earlier attempt/i);
  });

  it('refuses a request from a superseded generation even on the same run id', () => {
    // A Run id can be reused by a replay; the generation is what says which
    // attempt was meant, so both are checked and neither alone is trusted.
    const settled = settleFinishedRun({ ...base, pending: { ...pending, generation: 2 } });
    expect(settled.to).toBe('review');
    expect(settled.requestOutcome).toBe('rejected');
  });

  it('refuses completion while something it asked for is still unanswered', () => {
    const settled = settleFinishedRun({ ...base, pending, unresolvedInputRequests: 1 });
    expect(settled.to).toBe('review');
    expect(settled.requestOutcome).toBe('rejected');
    expect(settled.reason).toMatch(/waiting on input/i);
  });

  it('reviews instead of completing when the task is set to be reviewed', () => {
    const settled = settleFinishedRun({ ...base, pending, policy: 'explicit_review' });
    expect(settled.to).toBe('review');
    expect(settled.requestOutcome).toBe('rejected');
    expect(settled.reason).toMatch(/set to be reviewed/i);
  });

  it('never leaves a request pending once the run has been settled', () => {
    for (const policy of ['agent_outcome', 'explicit_review'] as const) {
      for (const p of [pending, { ...pending, runId: 'run-1' }]) {
        expect(settleFinishedRun({ ...base, policy, pending: p }).requestOutcome).not.toBeNull();
      }
    }
  });
});

describe('settling a run that ended badly', () => {
  const pending: PendingCompletion = { source: 'agent', runId: 'run-2', generation: 3 };

  it('cannot produce completion, whatever was asked for during it', () => {
    for (const outcome of ['failed', 'cancelled'] as const) {
      const settled = settleUnsuccessfulRun({ outcome, pending });
      expect(settled.to).toBe(outcome);
      expect(settled.requestOutcome).toBe('rejected');
      expect(settled.requestReason).toMatch(outcome === 'failed' ? /failed/i : /cancelled/i);
    }
  });

  it('has nothing to answer when nobody asked', () => {
    const settled = settleUnsuccessfulRun({ outcome: 'failed', pending: null });
    expect(settled.requestOutcome).toBeNull();
    expect(settled.requestReason).toBeNull();
  });
});

describe('completion policy', () => {
  it('knows its two settings and refuses anything else', () => {
    expect(isCompletionPolicy('agent_outcome')).toBe(true);
    expect(isCompletionPolicy('explicit_review')).toBe(true);
    expect(isCompletionPolicy('auto')).toBe(false);
  });
});
