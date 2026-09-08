/**
 * How a durable update operation reads on a page.
 *
 * Kept apart from the component so the wording and the polling rule can be
 * tested without rendering anything, and so both are stated once. The rule that
 * matters most is the one about `awaiting_reconnect`: it is the only stage where
 * everything has been done and nothing is yet known, and a page that called it
 * "done" would be making exactly the claim the operation exists to withhold.
 */

export type UpdateStage =
  'queued' | 'accepted' | 'applying' | 'awaiting_reconnect' | 'succeeded' | 'failed' | 'timed_out';

export interface UpdateOperation {
  operation_id: string;
  requested_version: string;
  previous_version?: string | null;
  reported_version?: string | null;
  stage: UpdateStage;
  detail_state?: string | null;
  percent: number;
  bytes_done?: string | number | null;
  bytes_total?: string | number | null;
  failure_code?: string | null;
  failure_message?: string | null;
  created_at?: string;
  updated_at?: string;
  terminal_at?: string | null;
}

const LIVE: ReadonlySet<UpdateStage> = new Set([
  'queued',
  'accepted',
  'applying',
  'awaiting_reconnect',
]);

/** Whether the operation is still going. */
export function isLive(operation: Pick<UpdateOperation, 'stage'> | null | undefined): boolean {
  return operation ? LIVE.has(operation.stage) : false;
}

/**
 * How often to ask again, or `false` to stop.
 *
 * Polled only while something is happening. An operation that ended is a fact,
 * and asking about it forever is how a page nobody closed keeps a Control Plane
 * busy for a week.
 */
export function pollInterval(
  operation: Pick<UpdateOperation, 'stage'> | null | undefined,
): number | false {
  return isLive(operation) ? 3000 : false;
}

/** What the fine-grained state is doing, in words, or nothing. */
function detailLabel(state: string | null | undefined): string | null {
  switch (state) {
    case 'bundle_metadata_fetched':
      return 'reading the release';
    case 'bundle_downloading':
      return 'downloading the runtime';
    case 'bundle_verified':
      return 'checking what arrived';
    case 'prerequisites_installing':
      return 'installing what the runtime needs';
    case 'runtime_installing':
      return 'installing the runtime';
    case 'configuration_writing':
      return 'writing configuration';
    case 'services_starting':
      return 'starting services';
    case 'node_connecting':
    case 'health_verifying':
      return 'checking the Node is well';
    default:
      return null;
  }
}

/** One sentence for a person, never a state name on its own. */
export function stageLabel(operation: UpdateOperation): string {
  switch (operation.stage) {
    case 'queued':
      return `Waiting for the Node to take the update to ${operation.requested_version}`;
    case 'accepted':
      return `The Node accepted ${operation.requested_version} and started its updater`;
    case 'applying': {
      const detail = detailLabel(operation.detail_state);
      return detail
        ? `Installing ${operation.requested_version} — ${detail}`
        : `Installing ${operation.requested_version}`;
    }
    // The whole point, said plainly: the work is done and the answer is not in.
    case 'awaiting_reconnect':
      return `Waiting for the Node to restart and report ${operation.requested_version}`;
    case 'succeeded':
      return `The Node came back on ${operation.reported_version ?? operation.requested_version}`;
    case 'failed':
      return operation.failure_message ?? `The update to ${operation.requested_version} failed`;
    case 'timed_out':
      return (
        operation.failure_message ??
        `The update to ${operation.requested_version} stopped reporting`
      );
  }
}

/** `ok`, `warn` or `fail`, for the badge beside the sentence. */
export function stageTone(stage: UpdateStage): 'ok' | 'warn' | 'fail' {
  if (stage === 'succeeded') return 'ok';
  if (stage === 'failed' || stage === 'timed_out') return 'fail';
  return 'warn';
}

/** Bytes as a person reads them, or nothing when there is no honest figure. */
export function downloadLabel(operation: UpdateOperation): string | null {
  if (operation.detail_state !== 'bundle_downloading') return null;
  const done = Number(operation.bytes_done ?? 0);
  const total = Number(operation.bytes_total ?? 0);
  if (!Number.isFinite(done) || done <= 0) return null;
  const mb = (value: number) => `${Math.round(value / 1_000_000)} MB`;
  return Number.isFinite(total) && total > 0 ? `${mb(done)} of ${mb(total)}` : mb(done);
}
