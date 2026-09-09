/**
 * What a Node's credentials look like on a page, and when anything may be done
 * to them.
 *
 * The gating is the interesting half and it is why this is a module rather than
 * a few conditions inside a component. Offering "Add credential" is a promise
 * that pressing it will work, and there are three separate ways for that promise
 * to be false: the Node is not here, the Node never said what it supports, or
 * what it said does not include the thing being offered. Each is answered
 * separately below, and each produces a different sentence, because "you cannot
 * do this" without a reason is the kind of message people learn to ignore.
 */

import type { ProviderCapabilityView } from './provider-capabilities';

export interface NodeCredential {
  credential_id: string;
  provider_id: string;
  auth_method: string;
  label: string;
  state: string;
  created_at?: string | null;
  updated_at?: string | null;
}

/** One thing a person could create on this Node right now. */
export interface CredentialOption {
  providerId: string;
  providerName: string;
  authMethod: string;
}

export type AddCredentialState =
  | { kind: 'offered'; options: CredentialOption[] }
  /** Displayable, but not actionable. Each carries its own reason. */
  | { kind: 'unavailable'; reason: string };

/**
 * Whether this Node can be asked for a new credential, and for what.
 *
 * A stale snapshot is deliberately shown and deliberately not actionable: it
 * describes a host that is not here, and starting a login against it would
 * queue a device code nobody could ever approve before it expired.
 */
export function addCredentialState(
  capabilities: ProviderCapabilityView | null | undefined,
  online: boolean,
): AddCredentialState {
  if (!capabilities || capabilities.state === 'unknown') {
    return {
      kind: 'unavailable',
      reason: 'This Node has not reported which providers its runtime supports.',
    };
  }
  if (capabilities.status !== 'ok' || !Array.isArray(capabilities.providers)) {
    return {
      kind: 'unavailable',
      reason: 'This Node reported its providers in a format this console cannot read.',
    };
  }
  if (!online) {
    return {
      kind: 'unavailable',
      reason: 'Credentials are created on the Node itself, so it has to be connected.',
    };
  }

  const options = capabilities.providers
    .filter((provider) => provider.availability === 'available')
    .flatMap((provider) =>
      provider.auth_methods.map((authMethod) => ({
        providerId: provider.id,
        providerName: provider.display_name,
        authMethod,
      })),
    );
  if (options.length === 0) {
    return {
      kind: 'unavailable',
      reason: 'This Node reports no provider its runtime can currently reach.',
    };
  }
  return { kind: 'offered', options };
}

/** How each lifecycle state reads. */
const STATE_LABELS: Readonly<Record<string, string>> = {
  required: 'Needs authorization',
  authorizing: 'Waiting for approval',
  authorized: 'Ready',
  failed: 'Last attempt failed',
  revoked: 'Revoked',
};

export function credentialStateLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}

export function credentialStateTone(state: string): 'ok' | 'warn' | 'fail' {
  if (state === 'authorized') return 'ok';
  if (state === 'failed') return 'fail';
  return 'warn';
}

/**
 * A credential mid-login is the one a device code belongs to. Nothing else can
 * be cancelled, because nothing else has anything in flight.
 */
export function isAwaitingApproval(credential: NodeCredential): boolean {
  return credential.state === 'authorizing';
}

/**
 * A revoked credential is a record, not a thing. Renaming or revoking one again
 * would be acting on something that is already gone.
 */
export function canModify(credential: NodeCredential, online: boolean): boolean {
  return online && credential.state !== 'revoked';
}

/** How long a person has left, in words. */
export function expiresInLabel(expiresAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((expiresAt - now) / 1000));
  if (seconds === 0) return 'expired';
  if (seconds < 60) return `${seconds}s left`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s left`;
}
