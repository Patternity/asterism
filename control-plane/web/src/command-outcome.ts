/**
 * Following one command this page started to the end.
 *
 * A `202` means the Control Plane wrote the command down. Whether the Node did
 * it is answered seconds later, and a page that stopped at the acceptance could
 * only guess -- which is how a refusal somebody needed to read ("that
 * credential is still used by a project") looked like nothing happening at all.
 *
 * Nothing here interprets the Node. The Control Plane hands back a typed code
 * and a sentence it wrote itself; this only decides when to stop asking.
 */

/** What the Control Plane says about one command. */
export interface CommandOutcome {
  command_id: string;
  command_type: string;
  state: string;
  terminal: boolean;
  failure: { code: string; message: string } | null;
}

/** An action this page is still waiting on. */
export interface PendingAction {
  commandId: string;
  /** What to call it in a sentence: "revoke", "login", "rename". */
  kind: string;
}

/** How often a command is asked about while it is still on its way. */
export const COMMAND_POLL_MS = 1_500;

/**
 * How long to keep asking before saying so.
 *
 * Generous: a Node that is busy answers late, and calling that a failure would
 * be the same guess this exists to remove. The Control Plane's own command
 * expiry is what ends it for good; this only stops the page asking forever.
 */
export const COMMAND_POLL_TIMEOUT_MS = 180_000;

export function outcomeMessage(kind: string, outcome: CommandOutcome): string | null {
  if (!outcome.terminal) return null;
  if (outcome.failure) return outcome.failure.message;
  return null;
}

/** Whether this page should still be asking about the attempt at a login. */
export function watchAuthorization(input: {
  /** A credential the Node reports as still waiting for approval. */
  awaiting: boolean;
  /** The command that started the login, while it has not ended. */
  starting: boolean;
  /** When the code stops being usable, as the provider declared it. */
  expiresAt: number | null;
  now: number;
}): boolean {
  if (input.starting) return true;
  if (!input.awaiting) return false;
  // A code the provider has declared dead is not worth asking about, and the
  // Node has ended the attempt behind it.
  if (input.expiresAt !== null && input.expiresAt <= input.now) return false;
  return true;
}
