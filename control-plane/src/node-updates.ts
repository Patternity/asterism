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
 * **A Node reconnecting on the requested release is not success either.** That
 * rule was the whole contract once, and it is how node-1 came to be recorded as
 * updated while running the alpha.30 binary on the alpha.29 runtime: the new
 * binary reconnected before the updater had verified anything, and then rolled
 * the runtime back.
 *
 * Success needs both halves, tied to this operation. The updater's `complete`
 * must carry evidence for the requested release -- installed binary, runtime
 * tree marker, and every service it held stable -- and the Node must be
 * connected on that release in a session that began after the operation did.
 * Either can arrive first; neither alone completes anything.
 */

import { INSTALLATION_STATES, percentFor, type InstallationState } from './node-installations.js';
import type { UpdateEvidence, UpdateFailureDetail } from './protocol.js';

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
  evidence?: UpdateEvidence | null;
  failureDetail?: UpdateFailureDetail | null;
}

export type ProgressDecision =
  | {
      apply: true;
      stage: UpdateStage;
      percent: number;
      /** Set when this decision is itself a failure the report did not name. */
      failureCode?: string;
      message?: string;
      /** Kept with the operation: what a later success rests on. */
      evidence?: UpdateEvidence;
    }
  | { apply: false; reason: 'already_applied' | 'already_terminal' | 'not_an_update_state' };

export type EvidenceVerdict =
  | { ok: true }
  | { ok: false; failureCode: 'unverified_completion' | 'evidence_mismatch'; message: string };

/**
 * Whether an updater's evidence establishes the requested release.
 *
 * An updater that finishes without evidence is one from before evidence
 * existed. Its installation may be fine; nothing proves it, and an update is
 * not called successful on an unproved installation.
 */
export function checkEvidence(
  requestedVersion: string,
  evidence: UpdateEvidence | null | undefined,
): EvidenceVerdict {
  if (!evidence) {
    return {
      ok: false,
      failureCode: 'unverified_completion',
      message: `the updater finished without proving the installation is ${requestedVersion}`,
    };
  }
  const mismatched = (
    [
      ['target release', evidence.target_release],
      ['Node binary', evidence.node_release],
      ['runtime', evidence.runtime_release],
    ] as const
  ).filter(([, release]) => release !== requestedVersion);
  if (mismatched.length > 0) {
    return {
      ok: false,
      failureCode: 'evidence_mismatch',
      message: mismatched
        .map(([what, release]) => `the ${what} is ${release}, not ${requestedVersion}`)
        .join('; '),
    };
  }
  if (!evidence.services.some((service) => service.role.kind === 'node')) {
    return {
      ok: false,
      failureCode: 'evidence_mismatch',
      message: 'the updater did not verify the Node service',
    };
  }
  return { ok: true };
}

const ROLE_NAME = (role: { kind: string; project_id?: string }) =>
  role.kind === 'project_worker'
    ? `the worker for project ${role.project_id}`
    : role.kind === 'host_hermes'
      ? 'the host Hermes'
      : 'the Node';

function describeServices(services: NonNullable<UpdateFailureDetail['services']>): string {
  return services
    .map(
      (service) =>
        `${ROLE_NAME(service.role)} did not settle (${service.reason}: ${service.last.active_state}, ` +
        `${service.last.main_pid === null ? 'no main process' : `pid ${service.last.main_pid}`}, ` +
        `executable ${service.last.executable})`,
    )
    .join('; ');
}

/** A sentence for a person, built only from typed fields. */
export function describeFailure(detail: UpdateFailureDetail): string {
  const cause = (() => {
    switch (detail.check) {
      case 'services':
        return detail.services?.length
          ? describeServices(detail.services)
          : 'a service could not be restarted';
      case 'node_binary':
        return 'the installed Node binary was not the requested release';
      case 'runtime_release':
        return `the live runtime was ${detail.found_runtime_release ?? 'unmarked'}, not the requested release`;
      case 'health':
        return 'the Node did not answer on the new installation';
      case 'install':
        return 'the release could not be installed';
    }
  })();
  const rollback = (() => {
    switch (detail.rollback) {
      case 'restored':
        return 'the previous installation was restored and verified';
      case 'incomplete': {
        const services = detail.rollback_services?.length
          ? `: ${describeServices(detail.rollback_services)}`
          : '';
        return `the previous installation could not be fully restored and this host needs attention${services}`;
      }
      case 'not_attempted':
        return null;
    }
  })();
  return rollback ? `${cause}; ${rollback}` : cause;
}

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
  if (stage === 'failed') {
    return {
      apply: true,
      stage,
      percent: current.percent,
      ...(report.failureDetail ? { message: describeFailure(report.failureDetail) } : {}),
    };
  }

  // The updater finished. That is only worth waiting on if it proved what it
  // installed; otherwise the operation ends here, unproved.
  if (report.state === 'complete') {
    const verdict = checkEvidence(current.requested_version, report.evidence);
    if (!verdict.ok) {
      return {
        apply: true,
        stage: 'failed',
        percent: current.percent,
        failureCode: verdict.failureCode,
        message: verdict.message,
      };
    }
    return {
      apply: true,
      stage: 'awaiting_reconnect',
      percent: Math.max(current.percent, AWAITING_RECONNECT_PERCENT),
      evidence: report.evidence!,
    };
  }

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
  | { outcome: 'ignore'; reason: 'already_terminal' | 'still_working' | 'not_this_attempt' };

/** What the Control Plane knows about an operation when deciding its end. */
export interface SettlementView {
  stage: UpdateStage;
  requested_version: string;
  created_at: Date;
  /** Present only once a verified `complete` for this operation was applied. */
  evidence: UpdateEvidence | null;
}

/** The session a Node is connected on right now. */
export interface SessionView {
  softwareVersion: string | null | undefined;
  authenticatedAt: Date;
}

/**
 * Whether verified evidence, just recorded, completes the operation given the
 * session the Node is connected on.
 *
 * The session must be on the requested release *and* have begun after the
 * operation was created: a same-release session from before the update is a
 * process the update was supposed to replace, not the one it produced.
 */
export function resolveCompletion(
  operation: SettlementView,
  session: SessionView | null,
): { outcome: 'succeeded' } | { outcome: 'ignore'; reason: string } {
  if (isTerminalStage(operation.stage)) return { outcome: 'ignore', reason: 'already_terminal' };
  if (operation.stage !== 'awaiting_reconnect' || !operation.evidence) {
    return { outcome: 'ignore', reason: 'still_working' };
  }
  if (!session) return { outcome: 'ignore', reason: 'not_connected' };
  if (session.softwareVersion !== operation.requested_version) {
    return { outcome: 'ignore', reason: 'not_on_the_requested_release' };
  }
  if (session.authenticatedAt.getTime() < operation.created_at.getTime()) {
    return { outcome: 'ignore', reason: 'not_this_attempt' };
  }
  return { outcome: 'succeeded' };
}

/**
 * What a Node reconnecting means for an operation in flight.
 *
 * A reconnect alone never completes anything. Until the updater has recorded
 * verified evidence for this operation the operation is still working, whatever
 * release the Node says it is on -- the new binary connects before the updater
 * has checked the runtime, the workers, or anything else, and it connects just
 * the same if that check later fails and puts the previous installation back.
 *
 * Once the evidence is in, a reconnect on the requested release completes the
 * operation and a reconnect on any other release is a mismatch.
 */
export function resolveReconnect(
  operation: Pick<SettlementView, 'stage' | 'requested_version' | 'evidence'>,
  reportedVersion: string | null | undefined,
): ReconnectVerdict {
  if (isTerminalStage(operation.stage)) return { outcome: 'ignore', reason: 'already_terminal' };
  if (operation.stage !== 'awaiting_reconnect' || !operation.evidence) {
    return { outcome: 'ignore', reason: 'still_working' };
  }
  if (reportedVersion && reportedVersion === operation.requested_version) {
    return { outcome: 'succeeded' };
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
