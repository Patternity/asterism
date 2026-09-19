/**
 * How a command this console started actually ended, in words it may show.
 *
 * A `202` means a command was written down. The Node answers seconds later, and
 * a console that stopped at the acceptance could only guess from a later list
 * refresh -- which is how "that credential is still used by a project" became
 * "nothing happened" for the person who needed to read it.
 *
 * Two rules, and both are refusals:
 *
 * **Nothing the Node wrote is shown as it came.** A Node's failure names a
 * typed code first; anything after it is that host's own sentence, which may
 * hold a path, a profile name or a provider's phrasing. The code is matched
 * against a vocabulary this build knows and turned into a sentence written
 * here. A code this build does not know becomes the general refusal, never the
 * raw text.
 *
 * **A state is terminal or it is not.** A command still on its way is reported
 * as such rather than as a quiet success, so a page keeps watching instead of
 * claiming an answer it does not have.
 */

import { TERMINAL_COMMAND_STATES, type CommandRecord } from './repositories.js';

const TERMINAL = new Set<string>(TERMINAL_COMMAND_STATES);

export function isTerminalCommandState(state: string): boolean {
  return TERMINAL.has(state);
}

/**
 * Failures a Node reports that this build has a sentence for.
 *
 * Everything here is a decision an operator can act on. The messages never name
 * a host path, a profile, a port, a credential locator or a device code.
 */
const FAILURES: Readonly<Record<string, string>> = {
  authorization_in_progress:
    'This Node is already waiting for a browser approval. Cancel that one before starting another.',
  authorization_failed: 'The Node could not start the login.',
  provider_not_supported: 'This Node does not support that provider.',
  provider_unavailable: 'That provider is not available on this Node right now.',
  auth_method_not_supported: 'This Node does not support that way of authorizing.',
  credential_limit_reached: 'This Node already holds as many credentials as it allows.',
  credential_home_unavailable: 'The Node could not prepare storage for a new credential.',
  credential_in_use:
    'That credential is still used by a project. Move the project to another credential first.',
  credential_runtime_missing: 'The Node’s runtime holds nothing for this credential.',
  credential_not_found: 'This Node does not hold that credential.',
  credential_id_invalid: 'That is not a credential this Node would recognise.',
  label_invalid: 'That name cannot be used for a credential.',
  node_offline: 'This Node is not connected, so it could not carry out the action.',
  command_expired: 'The Node did not answer in time, so the action was abandoned.',
  forbidden_command: 'This Node runs a build that does not support that action.',

  // Logging an existing credential in again. Every one of these is a decision
  // an operator can act on, and none of them names a path, a runtime record or
  // anything read from a store.
  credential_not_reauthorizable:
    'That credential cannot be logged in again from here. Add a new one instead.',
  credential_reauthorizing:
    'This credential is being logged in again. Try this once that finishes.',
  credential_reauthorization_required:
    'This credential’s provider access has ended. Authorize it again to use it.',
  credential_revoked: 'That credential was revoked. Add a new one instead.',
  credential_reauthorization_unsupported:
    'This Node runs a build that cannot log a credential in again. Update the Node first.',
  // The swap itself, and the proof that follows it.
  credential_swap_failed:
    'The Node could not put the new credential in place. Nothing changed, and the previous one is still in use.',
  staged_store_record_count:
    'The login produced something this Node will not install. The credential was left as it was.',
  staged_store_wrong_label:
    'The login produced something this Node will not install. The credential was left as it was.',
  staged_store_wrong_provider:
    'The login produced something this Node will not install. The credential was left as it was.',
  staged_store_wrong_auth_method:
    'The login produced something this Node will not install. The credential was left as it was.',
  staged_store_not_usable:
    'The provider refused the new login straight away. The credential was left as it was.',
  staged_store_unreadable:
    'The login produced something this Node could not read. The credential was left as it was.',
  worker_unhealthy:
    'A project using this credential did not come back after the change, so the previous credential was put back.',
  worker_not_restarted:
    'A project using this credential did not restart, so the previous credential was put back.',
  worker_restart_failed:
    'A project using this credential could not be restarted, so the previous credential was put back.',
  project_runs_active:
    'A project using this credential has a run in progress. Wait for it to finish and try again.',
};

export interface CommandFailure {
  /** A code the console switches on. `unknown` when the Node said something new. */
  code: string;
  /** A sentence written here, never the Node's own text. */
  message: string;
}

/** The typed code a Node's failure begins with, if this build knows it. */
function knownCode(message: string): string | null {
  // Codes are leading `snake_case:` tokens, and a Node may wrap one in another
  // (`credential_revoke_failed: credential_in_use: ...`). The innermost one
  // this build knows is the decision; the wrapper only says which command it
  // was, which the caller already knows.
  const tokens = message.match(/[a-z][a-z0-9_]*(?=:)/g) ?? [];
  for (const token of tokens) {
    if (token in FAILURES) return token;
  }
  return null;
}

/**
 * Why a command did not do what was asked, or `null` while it still might.
 *
 * `rejected` and `indeterminate` are failures of their own: the first is a Node
 * refusing the frame, the second an answer that never arrived.
 */
export function commandFailure(command: CommandRecord): CommandFailure | null {
  if (!isTerminalCommandState(command.state) || command.state === 'completed') return null;

  const raw =
    typeof command.error_payload?.message === 'string' ? command.error_payload.message : '';
  const code = knownCode(raw) ?? command.error_code ?? 'command_failed';
  const message =
    FAILURES[code] ??
    (command.state === 'indeterminate'
      ? 'The Node did not report whether it carried this out. Check its state before trying again.'
      : 'The Node could not carry this out.');
  return { code, message };
}
