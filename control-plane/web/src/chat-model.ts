/**
 * Conversation model.
 *
 * Pure data rules shared by the chat surface and its tests: what a turn is, and
 * which runs belong to one.
 */
import type { RunRecord } from './types';

/** A run in a conversation, with the prompt joined back from its create command. */
export interface ChatRun extends RunRecord {
  submitted_input: string | null;
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
