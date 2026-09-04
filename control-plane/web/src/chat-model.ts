/**
 * Conversation model.
 *
 * Pure data rules shared by the chat surface and its tests: what a turn is, and
 * which runs belong to one.
 */
import type { RunRecord } from './types';

/** A run in a conversation, with the prompt joined back from its create command. */
export interface ChatRun extends RunRecord {
  /**
   * The run's approval policy as the server computed it, from the whole
   * journal. The console's own event window cannot be trusted for this: it
   * resumes from a cursor and so loses the one event that sets it.
   */
  approval_policy?: string | null;
  approval_policy_actor?: string | null;
  approval_policy_changed_at?: string | null;
  /**
   * Stored images for this turn, joined in by the server.
   *
   * Deliberately separate from the URL attachments in `request_metadata`: these
   * are rows the Control Plane owns, and their browser-facing form never
   * carries the capability URL the model provider fetches with.
   */
  uploaded_attachments?: import('./attachments').UploadedAttachment[];
  submitted_input: string | null;
  /**
   * The finished reply, assembled by the server from the whole journal.
   *
   * Present for the same reason `approval_policy` is: the console's event
   * window cannot be trusted to hold it. A run that works before it answers
   * puts both `run.completed` and every delta past the end of the page the
   * console fetches, and the reply then rendered as "No assistant output."
   * Absent against a Control Plane that predates this, which is why the view
   * still falls back to assembling the text from events.
   */
  assistant_output?: string | null;
}

/**
 * The reply to render for an attempt.
 *
 * The server's copy first. It is assembled from the whole journal, whereas the
 * browser holds however much of it was fetched — and a run that worked before
 * it answered leaves both `run.completed` and every delta past the end of one
 * page, which rendered as "No assistant output." for a reply that was stored
 * in full. `fromEvents` remains the fallback so a Control Plane that predates
 * the server-side copy still shows a reply.
 */
export function replyText(
  run: { assistant_output?: string | null },
  fromEvents: () => string,
): string {
  if (typeof run.assistant_output === 'string' && run.assistant_output !== '') {
    return run.assistant_output;
  }
  return fromEvents();
}

const TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'lost',
  'rejected',
]);

const ACTIVE_STATUSES = new Set(['queued', 'running', 'waiting_for_approval', 'recovering']);

export const isTerminal = (run: RunRecord) => TERMINAL_STATUSES.has(run.status);
export const isActive = (run: RunRecord) => ACTIVE_STATUSES.has(run.status);

/** One conversational turn: the message the user sent, and every attempt at it. */
export interface ChatTurn {
  primary: ChatRun;
  attempts: ChatRun[];
}

/**
 * Group runs into turns.
 *
 * A run without `retry_of_run_id` opens a turn. A retry attaches to the turn of
 * the run it repeats, following the chain so a retry of a retry still belongs to
 * the original message rather than starting a new one.
 */
export function groupTurns(runs: ChatRun[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  const turnOfRun = new Map<string, ChatTurn>();

  for (const run of runs) {
    if (!run.retry_of_run_id) {
      const turn: ChatTurn = { primary: run, attempts: [run] };
      turns.push(turn);
      turnOfRun.set(run.run_id, turn);
      continue;
    }
    const parent = turnOfRun.get(run.retry_of_run_id);
    if (parent) {
      parent.attempts.push(run);
      turnOfRun.set(run.run_id, parent);
    } else {
      // The run it repeats is outside the loaded window; show it standalone
      // rather than dropping an execution nobody would otherwise see.
      const turn: ChatTurn = { primary: run, attempts: [run] };
      turns.push(turn);
      turnOfRun.set(run.run_id, turn);
    }
  }
  return turns;
}
