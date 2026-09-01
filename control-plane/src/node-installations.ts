/**
 * Installing a Node, as something the product can show.
 *
 * The rules here are deliberately pure: which stages exist, what fraction of the
 * work each one represents, and which updates may be applied to an attempt. The
 * routes and the repository are thin over this, so the parts a person actually
 * sees — a percentage that only moves forward, a stage that cannot be spelled
 * wrong, a stale retry that cannot overwrite a newer one — are decided in one
 * place and tested without a database.
 */

/** Every stage an installation can be in. Typed, never matched as English. */
export const INSTALLATION_STATES = [
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
] as const;

export type InstallationState = (typeof INSTALLATION_STATES)[number];

const STATE_SET = new Set<string>(INSTALLATION_STATES);

export function isInstallationState(value: unknown): value is InstallationState {
  return typeof value === 'string' && STATE_SET.has(value);
}

/** Nothing follows these. */
const TERMINAL: ReadonlySet<InstallationState> = new Set([
  'complete',
  'failed',
  'cancelled',
  'expired',
]);

export function isTerminal(state: InstallationState): boolean {
  return TERMINAL.has(state);
}

/**
 * Where each stage sits on the bar.
 *
 * Weighted by how long the stage actually takes, not by how many stages there
 * are: the download is over half of a first installation and gets over half the
 * bar, while writing a unit file is instant and gets almost none. A bar that
 * moved a fourteenth per stage would sit at 30% through the part that takes
 * minutes and then leap to 100%.
 */
const STAGE_PERCENT: Record<InstallationState, number> = {
  code_issued: 0,
  bootstrap_downloaded: 2,
  bundle_metadata_fetched: 5,
  // Interpolated across DOWNLOAD_SPAN by real bytes; this is its floor.
  bundle_downloading: 5,
  bundle_verified: 65,
  plan_prepared: 67,
  prerequisites_installing: 70,
  runtime_installing: 72,
  configuration_writing: 84,
  identity_enrolling: 88,
  services_starting: 92,
  node_connecting: 95,
  health_verifying: 97,
  complete: 100,
  // A failure keeps the bar where it stopped. Moving it would suggest progress
  // that did not happen; zeroing it would hide how far the attempt got.
  failed: 0,
  cancelled: 0,
  expired: 0,
};

const DOWNLOAD_START = STAGE_PERCENT.bundle_downloading;
const DOWNLOAD_END = STAGE_PERCENT.bundle_verified;

/**
 * The percentage for a report.
 *
 * `complete` is the only way to reach 100, and callers only send it once the
 * Node is online — so the bar filling means the thing is usable, not that the
 * last message arrived.
 */
export function percentFor(
  state: InstallationState,
  bytes?: { done?: number | null; total?: number | null },
): number {
  if (state !== 'bundle_downloading') return STAGE_PERCENT[state];

  const done = bytes?.done ?? null;
  const total = bytes?.total ?? null;
  // Without a known total there is no honest fraction, so the bar holds at the
  // stage floor and the byte counter carries the information instead.
  if (done === null || total === null || total <= 0 || done < 0) return DOWNLOAD_START;

  const fraction = Math.min(done / total, 1);
  return Math.round(DOWNLOAD_START + fraction * (DOWNLOAD_END - DOWNLOAD_START));
}

/** Why an installation stopped. Typed so the console can offer the right action. */
export const FAILURE_CODES = [
  'unsupported_os',
  'unsupported_architecture',
  'insufficient_disk',
  'download_failed',
  'digest_mismatch',
  'signature_invalid',
  'unsupported_bundle_schema',
  'prerequisites_failed',
  'runtime_install_failed',
  'enrollment_rejected',
  'service_start_failed',
  'health_check_failed',
  'interrupted',
  'internal_error',
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

const FAILURE_SET = new Set<string>(FAILURE_CODES);

export function isFailureCode(value: unknown): value is FailureCode {
  return typeof value === 'string' && FAILURE_SET.has(value);
}

/**
 * Whether trying again could plausibly work.
 *
 * A host with the wrong architecture will never install; a download that died
 * halfway probably will. The console offers a retry for one and an explanation
 * for the other.
 */
const PERMANENT: ReadonlySet<FailureCode> = new Set([
  'unsupported_os',
  'unsupported_architecture',
  'unsupported_bundle_schema',
]);

export function isRetryable(code: FailureCode): boolean {
  return !PERMANENT.has(code);
}

export interface AttemptView {
  state: InstallationState;
  generation: number;
  percent: number;
}

export interface ProgressReport {
  state: InstallationState;
  generation: number;
  bytesDone?: number | null;
  bytesTotal?: number | null;
  failureCode?: FailureCode | null;
}

export type ProgressDecision =
  | { apply: true; percent: number }
  | { apply: false; reason: 'stale_generation' | 'already_terminal' | 'would_move_backwards' };

/**
 * Whether one report may be applied to an attempt.
 *
 * Three things are refused, and each of them is something a real installer does.
 * A retry that started over reports generation 2 while a straggler from
 * generation 1 is still in flight — the straggler is dropped rather than
 * rewinding the page. A duplicate SSE delivery repeats a percentage already
 * passed — dropped, so the bar never stutters backwards. And nothing at all
 * follows a terminal state, because an attempt that failed did not later
 * un-fail.
 */
export function decideProgress(current: AttemptView, report: ProgressReport): ProgressDecision {
  if (report.generation < current.generation) return { apply: false, reason: 'stale_generation' };
  if (isTerminal(current.state) && report.generation === current.generation) {
    return { apply: false, reason: 'already_terminal' };
  }

  const percent = percentFor(report.state, {
    done: report.bytesDone,
    total: report.bytesTotal,
  });

  // A new generation starts its own bar and may legitimately begin below the
  // one before it.
  if (report.generation > current.generation) return { apply: true, percent };

  // Terminal states carry their own percentage rule, so they are never held
  // back by the monotonic guard.
  if (isTerminal(report.state)) return { apply: true, percent };

  if (percent < current.percent) return { apply: false, reason: 'would_move_backwards' };
  return { apply: true, percent };
}

/**
 * What a failed attempt shows instead of a percentage.
 *
 * The bar stays where it stopped, which is why `decideProgress` returns the
 * failure's own percent and the caller keeps the previous one.
 */
export function percentAfterFailure(current: AttemptView): number {
  return current.percent;
}
