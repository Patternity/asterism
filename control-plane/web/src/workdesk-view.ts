/**
 * What the Workdesk shows, decided without touching the DOM.
 *
 * The server answers what a task *is*; this decides how it reads and which
 * controls are worth offering. Nothing here guesses at a transition the server
 * would refuse: the offered set is the same set the lifecycle allows, so a
 * button that appears is a button that works.
 */

export type TaskStatus =
  | 'backlog'
  | 'ready'
  | 'running'
  | 'waiting_input'
  | 'review'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type BoardTask = {
  task_id: string;
  title: string;
  goal: string;
  status: TaskStatus;
  status_label: string;
  version: number;
  current_run_id: string | null;
  blocked_reason: string | null;
  updated_at: string;
};

export type StructuredReports = {
  supported: boolean;
  available: boolean;
  explanation: string | null;
};

export type PlanStep = {
  step_id: string;
  position: number;
  title: string;
  state: 'pending' | 'in_progress' | 'done' | 'skipped';
};

export type TaskEvent = {
  seq: string;
  run_id: string | null;
  event_type: string;
  summary: string;
  detail: Record<string, unknown>;
  agent_reported: boolean;
  recorded_at: string;
};

export type TaskRun = {
  run_id: string;
  status: string;
  created_at: string;
  finished_at: string | null;
  error_message: string | null;
  retry_of_run_id: string | null;
};

export type InputRequest = {
  input_request_id: string;
  prompt: string;
  kind: string;
  run_id: string | null;
};

export type TaskDetail = BoardTask & {
  project_id: string;
  generation: number;
  completion_policy: 'agent_outcome' | 'explicit_review';
  current_step_id: string | null;
  result: { summary: string | null; artifacts: unknown[]; metadata: Record<string, unknown> };
  plan: PlanStep[];
  runs: TaskRun[];
  events: TaskEvent[];
  input_request: InputRequest | null;
  pending_completion: { source: string; runId: string; generation: number } | null;
  structured_reports: StructuredReports;
};

/** The board's columns, in the order work moves through them. */
export const BOARD_ORDER: readonly TaskStatus[] = [
  'backlog',
  'ready',
  'running',
  'waiting_input',
  'review',
  'completed',
  'failed',
  'cancelled',
];

export function groupByStatus(tasks: readonly BoardTask[]): Map<TaskStatus, BoardTask[]> {
  const grouped = new Map<TaskStatus, BoardTask[]>();
  for (const status of BOARD_ORDER) grouped.set(status, []);
  for (const task of tasks) {
    const column = grouped.get(task.status);
    // A status this build has never heard of is dropped rather than shown in a
    // column it does not belong to.
    if (column) column.push(task);
  }
  return grouped;
}

export function statusTone(status: TaskStatus): 'ok' | 'warn' | 'fail' | 'muted' {
  switch (status) {
    case 'completed':
      return 'ok';
    case 'running':
    case 'review':
      return 'warn';
    case 'waiting_input':
      return 'warn';
    case 'failed':
      return 'fail';
    case 'cancelled':
      return 'muted';
    default:
      return 'muted';
  }
}

export type TaskAction =
  | 'mark_ready'
  | 'return_to_backlog'
  | 'start'
  | 'cancel'
  | 'complete'
  | 'request_changes'
  | 'reopen';

/**
 * Which actions to offer for a task in this state.
 *
 * Mirrors the lifecycle's own table. Offering more would produce buttons the
 * server refuses; offering fewer would hide the way forward.
 */
export function offeredActions(
  status: TaskStatus,
): readonly { action: TaskAction; label: string }[] {
  switch (status) {
    case 'backlog':
      return [
        { action: 'start', label: 'Start' },
        { action: 'mark_ready', label: 'Mark ready' },
        { action: 'cancel', label: 'Cancel' },
      ];
    case 'ready':
      return [
        { action: 'start', label: 'Start' },
        { action: 'return_to_backlog', label: 'Back to backlog' },
        { action: 'cancel', label: 'Cancel' },
      ];
    case 'running':
      // Completion asked for here is a request that waits for the run to end,
      // which is why the label says so rather than promising it is done.
      return [
        { action: 'complete', label: 'Request completion' },
        { action: 'cancel', label: 'Cancel' },
      ];
    case 'waiting_input':
      return [{ action: 'cancel', label: 'Cancel' }];
    case 'review':
      return [
        { action: 'complete', label: 'Complete' },
        { action: 'request_changes', label: 'Request changes' },
        { action: 'cancel', label: 'Cancel' },
      ];
    case 'failed':
      return [
        { action: 'start', label: 'Retry' },
        { action: 'reopen', label: 'Reopen' },
        { action: 'cancel', label: 'Cancel' },
      ];
    case 'cancelled':
      return [
        { action: 'start', label: 'Start again' },
        { action: 'reopen', label: 'Reopen' },
      ];
    case 'completed':
      return [{ action: 'reopen', label: 'Reopen' }];
  }
}

/**
 * How a task's activity reads, and who said it.
 *
 * An event the agent reported about itself is labelled as such. The product
 * never presents an agent's claim about its own activity as something Asterism
 * observed, because the two are worth different amounts.
 */
export function activityAttribution(event: TaskEvent): 'observed' | 'agent' {
  return event.agent_reported ? 'agent' : 'observed';
}

/** What to say about a plan that has not arrived. */
export function planAbsenceReason(detail: {
  plan: readonly PlanStep[];
  status: TaskStatus;
  structured_reports: StructuredReports;
}): string | null {
  if (detail.plan.length > 0) return null;
  if (!detail.structured_reports.supported) {
    return 'No plan: this project’s Node cannot report one.';
  }
  if (detail.status === 'backlog' || detail.status === 'ready') {
    return 'No plan yet. The agent reports one once the task starts.';
  }
  return 'No plan reported for this task.';
}

/**
 * Why a completed-looking task is still waiting.
 *
 * A person who asked for completion and sees the task still running is owed
 * the reason, which is that the run has not ended yet.
 */
export function pendingCompletionNote(detail: TaskDetail): string | null {
  if (!detail.pending_completion) return null;
  const who = detail.pending_completion.source === 'agent' ? 'The agent' : 'Somebody';
  return `${who} asked for this task to be completed. It is held until the run finishes, and is then checked before it applies.`;
}
