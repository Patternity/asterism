/**
 * What the Workdesk shows, decided without a browser.
 *
 * What must hold: the offered controls are the ones the lifecycle allows, an
 * agent's claim about itself is attributed to the agent, and a missing bridge
 * is explained rather than shown as an empty plan nobody can account for.
 */
import { describe, expect, it } from 'vitest';

import {
  BOARD_ORDER,
  activityAttribution,
  groupByStatus,
  offeredActions,
  pendingCompletionNote,
  planAbsenceReason,
  statusTone,
  type BoardTask,
  type TaskDetail,
  type TaskStatus,
} from '../src/workdesk-view';

function task(status: TaskStatus, id: string = status): BoardTask {
  return {
    task_id: id,
    title: `task ${id}`,
    goal: '',
    status,
    status_label: status,
    version: 1,
    current_run_id: null,
    blocked_reason: null,
    updated_at: '2026-10-04T00:00:00.000Z',
  };
}

function detail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    ...task('running', 'tsk_1'),
    project_id: 'prj_1',
    generation: 1,
    completion_policy: 'agent_outcome',
    current_step_id: null,
    result: { summary: null, artifacts: [], metadata: {} },
    plan: [],
    runs: [],
    events: [],
    input_request: null,
    pending_completion: null,
    structured_reports: { supported: true, available: true, explanation: null },
    ...overrides,
  };
}

describe('the board', () => {
  it('puts every task in its own column and keeps the columns in order', () => {
    const grouped = groupByStatus(BOARD_ORDER.map((status) => task(status)));
    expect([...grouped.keys()]).toEqual([...BOARD_ORDER]);
    for (const status of BOARD_ORDER) {
      expect(grouped.get(status)?.map((t) => t.status)).toEqual([status]);
    }
  });

  it('drops a status this build has never heard of rather than misfiling it', () => {
    const grouped = groupByStatus([task('archived' as TaskStatus, 'odd')]);
    const total = [...grouped.values()].reduce((sum, column) => sum + column.length, 0);
    expect(total).toBe(0);
  });

  it('tells a failure apart from a completion at a glance', () => {
    expect(statusTone('completed')).toBe('ok');
    expect(statusTone('failed')).toBe('fail');
    expect(statusTone('running')).toBe('warn');
  });
});

describe('the controls offered', () => {
  it('never offers completion on a task nobody has looked at yet', () => {
    for (const status of ['backlog', 'ready'] as TaskStatus[]) {
      expect(offeredActions(status).map((o) => o.action)).not.toContain('complete');
    }
  });

  it('calls completion on a running task a request, because that is what it is', () => {
    const running = offeredActions('running');
    const complete = running.find((o) => o.action === 'complete');
    expect(complete?.label).toMatch(/request/i);
  });

  it('calls completion on a reviewed task what it is', () => {
    expect(offeredActions('review').find((o) => o.action === 'complete')?.label).toBe('Complete');
  });

  it('offers a retry on a failed task and nothing on a cancelled one that implies progress', () => {
    expect(offeredActions('failed').map((o) => o.action)).toContain('start');
    expect(offeredActions('cancelled').map((o) => o.action)).not.toContain('complete');
  });

  it('offers something from every state, so a task is never a dead end', () => {
    for (const status of BOARD_ORDER) {
      expect(offeredActions(status).length, status).toBeGreaterThan(0);
    }
  });

  it('offers no start on a task that is already running', () => {
    expect(offeredActions('running').map((o) => o.action)).not.toContain('start');
  });
});

describe('attribution', () => {
  it('marks what the agent said about itself as the agent saying it', () => {
    const base = {
      seq: '1',
      run_id: 'run-1',
      detail: {},
      recorded_at: '2026-10-04T00:00:00.000Z',
    };
    expect(
      activityAttribution({
        ...base,
        event_type: 'activity.reported',
        summary: 'x',
        agent_reported: true,
      }),
    ).toBe('agent');
    expect(
      activityAttribution({
        ...base,
        event_type: 'tool.started',
        summary: 'x',
        agent_reported: false,
      }),
    ).toBe('observed');
  });
});

describe('a Node without the bridge', () => {
  const legacy = { supported: false, available: false, explanation: 'no reports from this Node' };

  it('explains a missing plan by naming the Node, not by blaming the task', () => {
    const note = planAbsenceReason(detail({ structured_reports: legacy }));
    expect(note).toMatch(/cannot report/i);
  });

  it('says a plan is still coming on a Node that does have the bridge', () => {
    const note = planAbsenceReason(detail({ status: 'ready' }));
    expect(note).toMatch(/once the task starts/i);
  });

  it('says nothing about an absent plan when a plan is present', () => {
    const note = planAbsenceReason(
      detail({ plan: [{ step_id: 's1', position: 1, title: 'do it', state: 'pending' }] }),
    );
    expect(note).toBeNull();
  });
});

describe('a completion that is waiting', () => {
  it('says who asked and that it is held until the run ends', () => {
    const note = pendingCompletionNote(
      detail({ pending_completion: { source: 'agent', runId: 'run-1', generation: 1 } }),
    );
    expect(note).toMatch(/^The agent asked/);
    expect(note).toMatch(/held until the run finishes/i);
    // It must not read as already done: that is the misunderstanding this
    // whole deferred path exists to prevent. The sentence may say "to be
    // completed", which is the request; what it may not say is that it is.
    expect(note).not.toMatch(/has been completed|is completed|now completed/i);
    expect(note).toMatch(/is then checked before it applies/i);
  });

  it('says nothing when nobody asked', () => {
    expect(pendingCompletionNote(detail())).toBeNull();
  });
});
