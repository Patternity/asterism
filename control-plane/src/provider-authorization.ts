/**
 * Relaying a provider device authorization to one browser.
 *
 * The credential belongs to the Node host and never reaches this process. What
 * does reach it is the pair a person needs in a browser — a verification link
 * and a short code they type — and that pair is a temporary secret.
 *
 * So it is held here, in memory, for as long as it is valid and no longer. It is
 * never written to PostgreSQL, never audited, never logged, and never returned
 * to anyone but the organization that asked for it. A device code in a database
 * outlives the ninety seconds it was useful for and becomes something an
 * attacker can look for; a device code in a log line outlives the database.
 *
 * What *is* persisted is the typed state, which is not a secret and is exactly
 * what the console and the run guard need.
 */

/** Every provider authorization state a Node can be in. */
export const PROVIDER_STATES = [
  'unknown',
  'unavailable',
  'required',
  'authorizing',
  'authorized',
  'failed',
] as const;

export type ProviderState = (typeof PROVIDER_STATES)[number];

const STATE_SET = new Set<string>(PROVIDER_STATES);

export function isProviderState(value: unknown): value is ProviderState {
  return typeof value === 'string' && STATE_SET.has(value);
}

/**
 * Whether a run may be dispatched to a Node in this state.
 *
 * `unknown` is permitted deliberately. A Node that predates provider reporting
 * has never said anything about its provider, and refusing every run on it would
 * break working installations to enforce a check they cannot answer. Every Node
 * that does report is held to the real rule.
 */
export function canDispatchRuns(state: ProviderState): boolean {
  return state === 'authorized' || state === 'unknown';
}

/** What a browser is shown while a person approves. */
export interface DeviceAuthorization {
  verificationUri: string;
  userCode: string;
  expiresAt: number;
}

interface Pending extends DeviceAuthorization {
  organizationId: string;
}

/**
 * The device authorizations currently waiting for a person.
 *
 * One per Node, because the Node itself runs one attempt at a time: a second
 * concurrent authorization races the first for the same credential file, and
 * whichever person approved second would silently invalidate the other's code.
 */
export class DeviceAuthorizationRelay {
  private readonly pending = new Map<string, Pending>();

  /** Remember what the Node offered, for the organization that asked. */
  remember(nodeId: string, organizationId: string, device: DeviceAuthorization): void {
    this.pending.set(nodeId, { ...device, organizationId });
  }

  /**
   * What this organization may be shown for this Node, if anything.
   *
   * Scoped and expiring: another organization is answered as though nothing were
   * pending, and an expired code is forgotten rather than displayed, because a
   * code a person types after it expired reads as a product fault.
   */
  take(nodeId: string, organizationId: string, now = Date.now()): DeviceAuthorization | null {
    const found = this.pending.get(nodeId);
    if (!found) return null;
    if (found.expiresAt <= now) {
      this.pending.delete(nodeId);
      return null;
    }
    if (found.organizationId !== organizationId) return null;
    return {
      verificationUri: found.verificationUri,
      userCode: found.userCode,
      expiresAt: found.expiresAt,
    };
  }

  /** Whether an unexpired authorization is waiting, regardless of who asked. */
  isPending(nodeId: string, now = Date.now()): boolean {
    const found = this.pending.get(nodeId);
    if (!found) return false;
    if (found.expiresAt <= now) {
      this.pending.delete(nodeId);
      return false;
    }
    return true;
  }

  forget(nodeId: string): void {
    this.pending.delete(nodeId);
  }

  /** Drop everything that has expired. Cheap, and keeps nothing stale in memory. */
  sweep(now = Date.now()): void {
    for (const [nodeId, found] of this.pending) {
      if (found.expiresAt <= now) this.pending.delete(nodeId);
    }
  }
}

/**
 * Read a Node's `provider.authorize` result into something that can be relayed.
 *
 * Fails closed: a result missing either half is not an authorization, and
 * showing a link without a code — or a code without a link — would leave a
 * person on a page with nothing to type.
 */
export function readDeviceAuthorization(
  result: unknown,
  now = Date.now(),
): DeviceAuthorization | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  const verificationUri = record.verification_uri;
  const userCode = record.user_code;
  const expiresIn = Number(record.expires_in_seconds ?? 0);
  if (typeof verificationUri !== 'string' || !verificationUri.startsWith('https://')) return null;
  if (typeof userCode !== 'string' || userCode.length === 0 || userCode.length > 32) return null;
  if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 3600) return null;
  return { verificationUri, userCode, expiresAt: now + expiresIn * 1000 };
}

/**
 * What a Node's advertisement says about authorizing its provider.
 *
 * A Node that does not advertise it would ignore the command, and offering the
 * control anyway would leave a person pressing a button that does nothing.
 */
export function nodeCanAuthorizeProvider(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== 'object') return false;
  const provider = (capabilities as Record<string, unknown>).provider;
  if (!provider || typeof provider !== 'object') return false;
  return (provider as Record<string, unknown>).device_authorization === true;
}

/** The provider a Node names, for the console to say which one it means. */
export function nodeProviderKind(capabilities: unknown): string | null {
  if (!capabilities || typeof capabilities !== 'object') return null;
  const provider = (capabilities as Record<string, unknown>).provider;
  if (!provider || typeof provider !== 'object') return null;
  const kind = (provider as Record<string, unknown>).kind;
  return typeof kind === 'string' ? kind : null;
}
