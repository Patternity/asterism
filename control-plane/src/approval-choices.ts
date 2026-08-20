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

/**
 * Approval policies a run can be under.
 *
 * `allow_all_for_run` answers every approval that run emits with `once`. It is
 * scoped to exactly one run: it ends when the run does, a retry starts back at
 * `manual`, and nothing is written to Hermes' persistent allowlist. That is
 * what distinguishes it from the `always` grant this deployment refuses.
 */
export const RUN_APPROVAL_POLICIES = ['manual', 'allow_all_for_run'] as const;

export type RunApprovalPolicy = (typeof RUN_APPROVAL_POLICIES)[number];

/** True when the Node advertises run-scoped approval policy support. */
export function supportsRunApprovalPolicy(capabilities: unknown): boolean {
  const approvals = (capabilities as { approvals?: { run_approval_policy?: unknown } } | null)
    ?.approvals;
  return (
    Array.isArray(approvals?.run_approval_policy) &&
    approvals.run_approval_policy.includes('allow_all_for_run')
  );
}
