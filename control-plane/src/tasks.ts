/**
 * Task lifecycle: the one place that decides what may happen to a Task.
 *
 * Everything here is pure. A request arrives from a person, from an executing
 * agent through its Node, or later from an external board; this module answers
 * whether the Task may move, and nothing else in the product is allowed to form
 * its own opinion. Two places deciding the same question is how a product ends
 * up telling two different truths about the same row.
 */

export const TASK_STATES = [
  'backlog',
  'ready',
  'running',
  'waiting_input',
  'review',
  'completed',
  'failed',
  'cancelled',
] as const;

export type TaskState = (typeof TASK_STATES)[number];

const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>(['completed', 'cancelled']);

/**
 * Every action that can be asked for, and who can sensibly ask.
 *
 * `source` is recorded on the request for history and display. It is not
 * authorization: whether a given person may ask at all is answered by the
 * existing project access checks before anything here is consulted.
 */
export const TASK_ACTIONS = [
  // A person's actions.
  'mark_ready',
  'return_to_backlog',
  'start',
  'cancel',
  'complete',
  'request_changes',
  'reopen',
  'answer_input',
  // Facts about execution, observed by the Control Plane from the Runs it owns.
  'run_finished',
  'run_finished_completing',
  'run_failed',
  'run_cancelled',
  // What the executing agent reported through its Node.
  'agent_needs_input',
  'agent_reported_result',
  'agent_reported_failure',
  'request_completion',
] as const;

export type TaskAction = (typeof TASK_ACTIONS)[number];

/**
 * The transition table.
 *
 * Three different things are deliberately kept apart here, and confusing any
 * two of them is the bug this design exists to prevent:
 *
 * 1. **Run completion** — a Run durably ended successfully. A fact about an
 *    execution attempt, produced by the Node and owned by the Control Plane.
 * 2. **An agent completion request** — the executing agent called
 *    `kanban_complete`. A *wish*, recorded against the Task and the Run that
 *    made it, which decides nothing by itself. A person asking to complete a
 *    running task is the same kind of wish and takes the same path.
 * 3. **Accepted Task completion** — the Control Plane settled a completion
 *    request after its Run ended, having checked that it was made about this
 *    execution generation, that the configured policy allows it, and that
 *    nothing is still blocking. Only this moves a Task to `completed`.
 *
 * So `run_finished` has no fixed destination: see `settleFinishedRun`. A
 * successful Run with no valid completion request goes to `review`; with one,
 * and under the default policy, it goes to `completed` without requiring a
 * person. A Run that failed or was cancelled can never produce `completed`, no
 * matter what was requested during it.
 */
const TRANSITIONS: Readonly<Record<TaskAction, Readonly<Record<string, TaskState>>>> = {
  mark_ready: { backlog: 'ready' },
  return_to_backlog: { ready: 'backlog' },
  // Starting from `failed` or `cancelled` is a retry: the Task is the same, and
  // the new Run joins the ones already attached to it.
  start: {
    backlog: 'running',
    ready: 'running',
    waiting_input: 'running',
    failed: 'running',
    cancelled: 'running',
  },
  cancel: {
    backlog: 'cancelled',
    ready: 'cancelled',
    running: 'cancelled',
    waiting_input: 'cancelled',
    review: 'cancelled',
    failed: 'cancelled',
  },
  complete: { review: 'completed' },
  request_changes: { review: 'ready' },
  reopen: { completed: 'ready', cancelled: 'ready', failed: 'ready' },
  answer_input: { waiting_input: 'ready' },

  // Destination decided by `settleFinishedRun`; both outcomes are legal here.
  run_finished: { running: 'review' },
  run_finished_completing: { running: 'completed' },
  run_failed: { running: 'failed' },
  run_cancelled: { running: 'cancelled' },

  agent_needs_input: { running: 'waiting_input' },
  // Asked for while the work is still running: recorded as a pending request
  // and settled when the Run ends. The Task does not move now.
  request_completion: { running: 'running' },
  // An agent's result or failure report arrives while its Run is still in
  // flight. The report is recorded either way; the Task itself waits for the
  // Run to actually end, so a report followed by a crash cannot leave a Task
  // claiming success that never happened.
  agent_reported_result: {},
  agent_reported_failure: {},
};

export const COMPLETION_POLICIES = ['agent_outcome', 'explicit_review'] as const;

export type CompletionPolicy = (typeof COMPLETION_POLICIES)[number];

export function isCompletionPolicy(value: unknown): value is CompletionPolicy {
  return typeof value === 'string' && (COMPLETION_POLICIES as readonly string[]).includes(value);
}

/** A completion somebody asked for while the work was still running. */
export type PendingCompletion = {
  /** Who asked. Recorded for history and display; it authorizes nothing. */
  readonly source: 'user' | 'agent' | 'integration';
  /** The Run that was executing when it was asked for. */
  readonly runId: string;
  /** The execution attempt it was asked about. */
  readonly generation: number;
};

/** What settling a finished Run decided, and the sentence explaining it. */
export type Settlement = {
  readonly to: Extract<TaskState, 'completed' | 'review'>;
  readonly action: Extract<TaskAction, 'run_finished' | 'run_finished_completing'>;
  /** Why it landed there, in the words a person reads on the task. */
  readonly reason: string;
  /**
   * What to do with the pending completion request, if there was one. A request
   * that did not produce completion is never left pending: it is answered, so
   * nobody is left waiting on something that has already been decided.
   */
  readonly requestOutcome: 'accepted' | 'rejected' | null;
};

/**
 * Decide where a Task goes when its Run durably completes successfully.
 *
 * This is the only path to `completed` from execution, and every reason it can
 * refuse is a reason a person can read. It is called with facts the Control
 * Plane owns — never with anything the agent asserted about itself.
 */
export function settleFinishedRun(input: {
  /** The Run that just ended successfully. */
  readonly runId: string;
  /** The Task's current execution generation. */
  readonly generation: number;
  readonly policy: CompletionPolicy;
  readonly pending: PendingCompletion | null;
  /**
   * Input requests still unanswered. A task cannot be finished while something
   * it asked for has not arrived, whoever was going to supply it.
   */
  readonly unresolvedInputRequests: number;
}): Settlement {
  const { pending } = input;

  if (!pending) {
    return {
      to: 'review',
      action: 'run_finished',
      reason:
        'The run finished and nothing claimed the task was done, so it is waiting for a look.',
      requestOutcome: null,
    };
  }

  // Stale in either sense: asked about a different attempt, or about an
  // execution that has since been superseded by a later one.
  if (pending.runId !== input.runId || pending.generation !== input.generation) {
    return {
      to: 'review',
      action: 'run_finished',
      reason:
        'A completion was asked for during an earlier attempt, so it was not applied to this one. The result is waiting for a look.',
      requestOutcome: 'rejected',
    };
  }

  if (input.unresolvedInputRequests > 0) {
    return {
      to: 'review',
      action: 'run_finished',
      reason:
        'Completion was asked for while the task was still waiting on input, so it was not applied. The result is waiting for a look.',
      requestOutcome: 'rejected',
    };
  }

  if (input.policy === 'explicit_review') {
    return {
      to: 'review',
      action: 'run_finished',
      reason:
        'This task is set to be reviewed before it is completed, so the result is waiting for a look.',
      requestOutcome: 'rejected',
    };
  }

  return {
    to: 'completed',
    action: 'run_finished_completing',
    reason: 'The run finished and the completion asked for during it was accepted.',
    requestOutcome: 'accepted',
  };
}

/**
 * A Run that ended badly answers any completion asked for during it with a
 * refusal. Nothing requested during a failed attempt may produce `completed`.
 */
export function settleUnsuccessfulRun(input: {
  readonly outcome: 'failed' | 'cancelled';
  readonly pending: PendingCompletion | null;
}): {
  readonly to: Extract<TaskState, 'failed' | 'cancelled'>;
  readonly action: Extract<TaskAction, 'run_failed' | 'run_cancelled'>;
  readonly requestOutcome: 'rejected' | null;
  readonly requestReason: string | null;
} {
  const failed = input.outcome === 'failed';
  return {
    to: failed ? 'failed' : 'cancelled',
    action: failed ? 'run_failed' : 'run_cancelled',
    requestOutcome: input.pending ? 'rejected' : null,
    requestReason: input.pending
      ? `The run ${failed ? 'failed' : 'was cancelled'}, so the completion asked for during it was not applied.`
      : null,
  };
}

export type TransitionVerdict =
  | { readonly allowed: true; readonly to: TaskState }
  /** `reason` is written to be shown to a person, not logged and forgotten. */
  | { readonly allowed: false; readonly reason: string };

/**
 * May this Task take this action from where it now stands?
 *
 * An action with no state change of its own — an agent's report — is allowed
 * without moving the Task, so the caller records it and leaves the state alone.
 */
export function transitionFor(from: TaskState, action: TaskAction): TransitionVerdict {
  const table = TRANSITIONS[action];
  if (!table) return { allowed: false, reason: `${action} is not an action this product knows.` };

  const to = table[from];
  if (to) return { allowed: true, to };

  // An action that never moves a Task is still a legitimate thing to record.
  if (Object.keys(table).length === 0) return { allowed: true, to: from };

  return { allowed: false, reason: refusalFor(from, action) };
}

/** Why an action cannot be taken, in the words the console shows. */
function refusalFor(from: TaskState, action: TaskAction): string {
  if (TERMINAL_STATES.has(from)) {
    return `This task is ${stateLabel(from).toLowerCase()}. Reopen it first if there is more to do.`;
  }
  if (action === 'complete') {
    return 'Only a task waiting in review can be completed, so that somebody has looked at the result.';
  }
  if (action === 'start') {
    return from === 'running'
      ? 'This task is already running. Wait for the current run to finish, or cancel it.'
      : `A task in ${stateLabel(from).toLowerCase()} cannot be started from here.`;
  }
  if (action === 'answer_input') {
    return 'This task is not waiting for an answer.';
  }
  return `A task in ${stateLabel(from).toLowerCase()} cannot take that action.`;
}

/** What a person reads instead of the stored value. */
export function stateLabel(state: TaskState): string {
  switch (state) {
    case 'backlog':
      return 'Backlog';
    case 'ready':
      return 'Ready';
    case 'running':
      return 'Running';
    case 'waiting_input':
      // Actor-neutral on purpose: what is missing is external input, which may
      // come from another system rather than from the person reading this.
      return 'Waiting for input';
    case 'review':
      return 'Ready for review';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
  }
}

/** The board's columns, in the order work moves through them. */
export const BOARD_COLUMNS: readonly TaskState[] = [
  'backlog',
  'ready',
  'running',
  'waiting_input',
  'review',
  'completed',
  'failed',
  'cancelled',
];

export function isTaskState(value: unknown): value is TaskState {
  return typeof value === 'string' && (TASK_STATES as readonly string[]).includes(value);
}

export function isTaskAction(value: unknown): value is TaskAction {
  return typeof value === 'string' && (TASK_ACTIONS as readonly string[]).includes(value);
}

/**
 * Whether a Task in this state is waiting on a machine rather than a person.
 * The board uses it to decide what to poll; nothing else should infer it.
 */
export function isLive(state: TaskState): boolean {
  return state === 'running';
}

/**
 * A report from an agent is only authoritative for the attempt that is actually
 * running, and only if it is not describing a Task that has since moved on.
 *
 * Both halves matter. The run check stops a superseded attempt that woke up
 * late; the version check stops a report that was formed before a change a
 * person has already made.
 */
export function agentReportIsCurrent(input: {
  readonly taskVersion: number;
  readonly observedVersion: number;
  readonly currentRunId: string | null;
  readonly reportingRunId: string;
}): TransitionVerdict {
  if (input.currentRunId === null) {
    return {
      allowed: false,
      reason: 'This task has no run in flight, so there is nothing to report against.',
    };
  }
  if (input.currentRunId !== input.reportingRunId) {
    return {
      allowed: false,
      reason: 'That report came from an earlier run of this task, which has been superseded.',
    };
  }
  if (input.observedVersion !== input.taskVersion) {
    return {
      allowed: false,
      reason: 'The task changed after that report was made, so it was not applied.',
    };
  }
  return { allowed: true, to: 'running' };
}

/**
 * Plain language for a confirmed lifecycle event.
 *
 * Only facts reach this function. A tool's name is real, so it is named; what
 * the agent said about its own activity is passed through with
 * `agentReported` so the console can attribute it rather than present it as
 * something Asterism observed.
 */
export function eventSummary(input: {
  readonly eventType: string;
  readonly detail?: Readonly<Record<string, unknown>> | undefined;
}): string {
  const detail = input.detail ?? {};
  const named = (key: string): string | null => {
    const value = detail[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  };

  switch (input.eventType) {
    case 'run.started':
      return 'Run started';
    case 'plan.updated':
      return 'Plan updated';
    case 'step.started': {
      const title = named('step_title');
      return title ? `Started: ${title}` : 'Started the next step';
    }
    case 'tool.started': {
      const tool = named('tool');
      // Without the tool's real name this would be a guess, and a guess about
      // what a machine is doing to someone's project is worse than silence.
      return tool ? `Running a tool: ${tool}` : 'Running a tool';
    }
    case 'approval.waiting':
      return 'Waiting for approval';
    case 'input.requested':
      return 'Waiting for input';
    case 'activity.reported': {
      const activity = named('activity');
      return activity ? `Agent reported: ${activity}` : 'Agent reported its activity';
    }
    case 'run.failed': {
      const reason = named('reason');
      return reason ? `Run failed: ${reason}` : 'Run failed';
    }
    case 'run.cancelled':
      return 'Run cancelled';
    case 'result.ready':
      return 'Result ready for review';
    case 'completion.requested': {
      const who = named('source');
      return who === 'agent' ? 'Agent asked for the task to be completed' : 'Completion requested';
    }
    case 'completion.accepted':
      return 'Completion accepted';
    case 'completion.rejected': {
      const reason = named('reason');
      return reason ? `Completion not applied: ${reason}` : 'Completion not applied';
    }
    case 'task.completed':
      return 'Task completed';
    case 'task.cancelled':
      return 'Task cancelled';
    case 'task.reopened':
      return 'Task reopened';
    case 'changes.requested':
      return 'Changes requested';
    default:
      return input.eventType;
  }
}
