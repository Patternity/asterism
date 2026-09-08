/**
 * An update as a durable operation, separate from the command that starts it.
 *
 * `node.update` reaching `completed` means the Node accepted the request and
 * started its updater. That is all it can honestly mean: the updater replaces
 * and restarts the process holding the command, so nothing that survives to
 * answer knows how it went. This module does not redefine that. It adds the
 * thing the command was standing in for.
 *
 * Two rules carry the whole design, and both are refusals:
 *
 * **The root unit exiting zero is not success.** It means the updater finished
 * running. A host whose binary was replaced and whose runtime was not exits
 * zero exactly as a healthy one does — that is not hypothetical, it is what
 * `v0.1.0-alpha.19` did in production.
 *
 * **Success is the same Node reconnecting on the release that was asked for.**
 * Nothing else is accepted as evidence, which is why `complete` from the
 * updater moves the operation to `awaiting_reconnect` and stops short of 100.
 */

import { INSTALLATION_STATES, percentFor, type InstallationState } from './node-installations.js';

/** The coarse stage a person reads. */
export const UPDATE_STAGES = [
  'queued',
  'accepted',
  'applying',
  'awaiting_reconnect',
  'succeeded',
  'failed',
  'timed_out',
] as const;

export type UpdateStage = (typeof UPDATE_STAGES)[number];

const TERMINAL: ReadonlySet<UpdateStage> = new Set(['succeeded', 'failed', 'timed_out']);

export function isTerminalStage(stage: UpdateStage): boolean {
  return TERMINAL.has(stage);
}

export function isUpdateStage(value: unknown): value is UpdateStage {
  return typeof value === 'string' && (UPDATE_STAGES as readonly string[]).includes(value);
}

const INSTALLATION_STATE_SET: ReadonlySet<string> = new Set(INSTALLATION_STATES);

export function isDetailState(value: unknown): value is InstallationState {
  return typeof value === 'string' && INSTALLATION_STATE_SET.has(value);
}

/**
 * Where the bar stops while the answer is not yet known.
 *
 * The updater has done everything it can and the Node has not come back yet.
 * Filling the bar here would say the update worked, which is exactly the claim
 * this operation exists to stop being made early.
 */
export const AWAITING_RECONNECT_PERCENT = 99;

/**
 * The coarse stage behind a fine-grained updater state.
 *
 * The fine vocabulary is the installer's, unchanged, because an update runs the
 * same lifecycle: fetch, verify, install, configure, start. Reusing it means one
 * progress machine rather than two that drift, and it is why `percentFor` below
 * is the installer's own.
 */
export function stageForState(state: InstallationState): UpdateStage {
  switch (state) {
    case 'failed':
      return 'failed';
    // Not `succeeded`. The updater finished; the Node has not spoken yet.
    case 'complete':
      return 'awaiting_reconnect';
    case 'cancelled':
    case 'expired':
    case 'code_issued':
      // An update has no enrollment code to issue, cancel or expire. A report
      // carrying one is not from an update and is refused rather than mapped
      // onto something plausible.
      return 'failed';
    default:
      return 'applying';
  }
}

/** The percentage for an update report, capped short of done until it is. */
export function percentForUpdate(
  state: InstallationState,
  bytes?: { done?: number | null; total?: number | null },
): number {
  if (state === 'complete') return AWAITING_RECONNECT_PERCENT;
  return Math.min(percentFor(state, bytes), AWAITING_RECONNECT_PERCENT);
}

export interface OperationView {
  stage: UpdateStage;
  percent: number;
  last_seq: number;
  requested_version: string;
}

export interface ProgressReport {
  seq: number;
  state: InstallationState;
  bytesDone?: number | null;
  bytesTotal?: number | null;
  failureCode?: string | null;
}

export type ProgressDecision =
  | { apply: true; stage: UpdateStage; percent: number }
  | { apply: false; reason: 'already_applied' | 'already_terminal' | 'not_an_update_state' };

/**
 * Whether a report moves the operation, and to where.
 *
 * `seq` is the guard that makes redelivery safe. The Node keeps its own journal
 * and replays anything it could not deliver — after a restart it always has
 * some — so the same event arrives more than once by design, and an event at or
 * below the highest one applied is a replay rather than news.
 *
 * Where an installation *rejects* a report that would move the bar backwards,
 * an update clamps it instead. Rejecting would leave `last_seq` behind, and the
 * Node would redeliver that event forever because it never became old news.
 * Clamping keeps the bar monotonic and lets the sequence advance.
 */
export function decideUpdateProgress(
  current: OperationView,
  report: ProgressReport,
): ProgressDecision {
  if (!isDetailState(report.state)) return { apply: false, reason: 'not_an_update_state' };
  if (report.seq <= current.last_seq) return { apply: false, reason: 'already_applied' };
  // An operation that already ended did not later un-end. This is what stops a
  // late event from a finished update reopening it.
  if (isTerminalStage(current.stage)) return { apply: false, reason: 'already_terminal' };

  const stage = stageForState(report.state);
  // A failure keeps the bar where it stopped: moving it would suggest progress
  // that did not happen, and zeroing it would hide how far the attempt got.
  if (stage === 'failed') return { apply: true, stage, percent: current.percent };

  const percent = Math.max(
    current.percent,
    percentForUpdate(report.state, {
      done: report.bytesDone,
      total: report.bytesTotal,
    }),
  );
  return { apply: true, stage, percent };
}

export type ReconnectVerdict =
  | { outcome: 'succeeded' }
  | { outcome: 'failed'; failureCode: 'version_mismatch'; message: string }
  | { outcome: 'ignore'; reason: 'already_terminal' | 'still_working' };

/**
 * What a Node reconnecting means for an operation in flight.
 *
 * The only evidence of success there is, and the only place it is decided.
 *
 * A reconnect on the requested release is success from wherever the operation
 * had got to: the events may have been lost and the outcome is not in doubt. A
 * reconnect on any *other* release is only a failure once the updater has
 * finished, because until then it is a Node that dropped its connection for a
 * moment and came back on the version it has not replaced yet. Treating that as
 * a mismatch would fail an update for having a brief network fault.
 */
export function resolveReconnect(
  operation: Pick<OperationView, 'stage' | 'requested_version'>,
  reportedVersion: string | null | undefined,
): ReconnectVerdict {
  if (isTerminalStage(operation.stage)) return { outcome: 'ignore', reason: 'already_terminal' };
  if (reportedVersion && reportedVersion === operation.requested_version) {
    return { outcome: 'succeeded' };
  }
  if (operation.stage !== 'awaiting_reconnect') {
    return { outcome: 'ignore', reason: 'still_working' };
  }
  return {
    outcome: 'failed',
    failureCode: 'version_mismatch',
    message: `the Node came back reporting ${reportedVersion ?? 'no version'}, not ${operation.requested_version}`,
  };
}

/**
 * How long each live stage may sit without news before it is called stalled.
 *
 * Measured from the last time anything moved, not from the start, so a long
 * download is not a stall and a stage that stopped moving is. Generous on
 * purpose: a Node that is briefly unreachable is not a failed update, and the
 * cost of waiting is a stale row while the cost of being hasty is telling an
 * operator their host is broken when it is halfway through a 518 MB download.
 */
export const STAGE_DEADLINE_SECONDS: Readonly<Record<string, number>> = {
  queued: 300,
  accepted: 600,
  applying: 1_200,
  awaiting_reconnect: 900,
};

export interface StallVerdict {
  failureCode: 'not_accepted' | 'no_progress' | 'no_reconnect';
  message: string;
}

/** Whether an operation has waited past what its stage allows. */
export function stallVerdict(
  operation: { stage: UpdateStage; updated_at: Date },
  now: Date,
): StallVerdict | null {
  if (isTerminalStage(operation.stage)) return null;
  const allowed = STAGE_DEADLINE_SECONDS[operation.stage];
  if (allowed === undefined) return null;
  const waited = (now.getTime() - operation.updated_at.getTime()) / 1000;
  if (waited <= allowed) return null;

  switch (operation.stage) {
    case 'queued':
      return {
        failureCode: 'not_accepted',
        message: 'the Node did not accept the update within the time allowed',
      };
    case 'awaiting_reconnect':
      return {
        failureCode: 'no_reconnect',
        message: 'the updater finished but the Node did not come back within the time allowed',
      };
    default:
      return {
        failureCode: 'no_progress',
        message: 'the update stopped reporting progress',
      };
  }
}
