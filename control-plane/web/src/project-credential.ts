/**
 * Which credential a project runs on, as a form offers it and a page states it.
 *
 * A project reads either its Node's shared credential pool -- what every
 * project did before this choice existed -- or exactly one isolated credential
 * of that same Node. The shared pool is offered as the one thing it is: a pool.
 * Its entries are never listed one by one, because the runtime cannot be told
 * to use one of them, and a list that suggested otherwise would be a promise
 * the Node cannot keep.
 */

import type { NodeCredential } from './node-credentials';
import type { ProviderCapabilityView } from './provider-capabilities';
import type { ProjectCredentialRef, ProjectCredentialView } from './types';

/** The select value that stands for the shared pool. Never a credential id. */
export const SHARED_POOL = '';

export const SHARED_POOL_LABEL = 'Shared credential pool (legacy)';

export interface CredentialChoice {
  value: string;
  label: string;
  disabled: boolean;
  /** Why it cannot be chosen, when it cannot. */
  reason: string | null;
}

function providers(capabilities: ProviderCapabilityView | null | undefined) {
  return capabilities?.state === 'reported' && Array.isArray(capabilities.providers)
    ? capabilities.providers
    : [];
}

/** A provider's own name when the Node reported one, its id otherwise. */
export function providerName(
  capabilities: ProviderCapabilityView | null | undefined,
  providerId: string | null,
): string {
  if (!providerId) return 'unknown provider';
  return (
    providers(capabilities).find((entry) => entry.id === providerId)?.display_name ?? providerId
  );
}

/**
 * Everything a project on this Node could be pointed at, in order.
 *
 * `sharedPoolReady` is whether the Node's shared pool holds a credential at
 * all; without one a project on it could never run, so it is shown and not
 * offered.
 */
export function credentialChoices(
  credentials: NodeCredential[],
  capabilities: ProviderCapabilityView | null | undefined,
  sharedPoolReady: boolean,
): CredentialChoice[] {
  const choices: CredentialChoice[] = [
    {
      value: SHARED_POOL,
      label: SHARED_POOL_LABEL,
      disabled: !sharedPoolReady,
      reason: sharedPoolReady ? null : 'this Node has no shared credential',
    },
  ];
  const reported = providers(capabilities);
  const stale = capabilities?.state === 'reported' && capabilities.stale;
  for (const credential of credentials) {
    if (credential.storage !== 'isolated' || credential.state === 'revoked') continue;
    const provider = reported.find((entry) => entry.id === credential.provider_id);
    let reason: string | null = null;
    if (credential.state !== 'authorized') reason = 'needs authorization';
    else if (!provider || provider.availability !== 'available') {
      reason = 'provider unavailable on this Node';
    } else if (stale) reason = 'Node is not connected';
    choices.push({
      value: credential.credential_id,
      label: `${credential.label} (${providerName(capabilities, credential.provider_id)})`,
      disabled: reason !== null,
      reason,
    });
  }
  return choices;
}

/** The choice a form starts on: the shared pool when it works, else the first that does. */
export function defaultChoice(choices: CredentialChoice[]): string {
  const shared = choices.find((choice) => choice.value === SHARED_POOL);
  if (shared && !shared.disabled) return SHARED_POOL;
  return choices.find((choice) => !choice.disabled)?.value ?? SHARED_POOL;
}

/** What goes in a request: an id, or null for the shared pool. */
export function credentialPayload(value: string): string | null {
  return value === SHARED_POOL ? null : value;
}

/** How one credential reads in a sentence. */
export function credentialName(
  ref: ProjectCredentialRef | null,
  capabilities?: ProviderCapabilityView | null,
): string {
  if (!ref) return SHARED_POOL_LABEL;
  const label = ref.label ?? 'A credential this Node no longer reports';
  return `${label} (${providerName(capabilities, ref.provider_id)})`;
}

const FAILURES: Readonly<Record<string, string>> = {
  credential_not_found: 'the Node does not hold that credential',
  credential_not_isolated: 'that credential is in the shared pool',
  credential_not_authorized: 'the credential is not authorized',
  credential_provider_unavailable: "the credential's provider is unavailable",
  credential_home_missing: "the credential's storage is missing on the Node",
  credential_unavailable: 'the credential holds nothing; authorize it again',
  credential_unreadable: "the credential's storage cannot be read by the runtime",
  credential_link_invalid: 'the runtime could not be pointed at the credential',
  credential_link_occupied: "the project's runtime holds a credential file of its own",
  credential_assignment_in_progress: 'another change was already in progress',
  project_not_ready: 'the project was not ready',
  project_runs_active: 'a run was in progress',
  worker_restart_failed: "the project's runtime could not be restarted",
  worker_unhealthy: "the project's runtime did not come up on that credential",
  worker_not_restarted: "the project's runtime did not restart",
  node_refused: 'the Node refused the change',
};

export function assignmentFailureMessage(code: string | null): string {
  return (code && FAILURES[code]) || 'the Node could not apply it';
}

/** One sentence about a change in flight or one that did not take, or null. */
export function assignmentSummary(
  view: ProjectCredentialView,
  capabilities?: ProviderCapabilityView | null,
): string | null {
  const requested = view.assignment.requested;
  const target = requested ? credentialName(requested.credential, capabilities) : null;
  switch (view.assignment.state) {
    case 'pending':
      return `Switching to ${target}. Runs can start once the Node confirms it.`;
    case 'failed':
      return `The switch to ${target} did not take: ${assignmentFailureMessage(
        view.assignment.failure,
      )}. This project still uses ${credentialName(view.current, capabilities)}.`;
    case 'inconsistent':
      return `The switch to ${target} did not take (${assignmentFailureMessage(
        view.assignment.failure,
      )}), and the Node could not confirm what the project uses now. Choose its credential again before running.`;
    default:
      return null;
  }
}
