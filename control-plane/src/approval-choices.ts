/**
 * Approval choices this deployment accepts.
 *
 * `always` is deliberately excluded. Hermes turns that answer into a permanent
 * `command_allowlist` entry which suppresses every future approval in the
 * matched command category — `recursive delete` included — and Asterism has no
 * surface that shows or revokes such a rule. Offering it would hand out an
 * irreversible grant with no way back, so it is refused rather than silently
 * downgraded: an operator who asked for a standing rule must learn they did not
 * get one.
 *
 * Local operators can inspect and clear existing rules with
 * `asterism-node project approvals show|revoke|clear`.
 */
export const APPROVAL_CHOICES = ['once', 'session', 'deny'] as const;

export type ApprovalChoice = (typeof APPROVAL_CHOICES)[number];

/** Typed refusal for a persistent approval request. */
export const PERSISTENT_APPROVAL_NOT_SUPPORTED = 'persistent_approval_not_supported';

export const PERSISTENT_APPROVAL_MESSAGE =
  'Persistent approvals are unavailable: Hermes would record this as a permanent ' +
  'command_allowlist rule that Asterism cannot yet display or revoke. Use "once" or "session".';

/** True when a caller explicitly asked for the unsupported persistent grant. */
export function isPersistentApprovalRequest(choice: unknown): boolean {
  return choice === 'always';
}
