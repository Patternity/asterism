/**
 * What a Node says its runtime supports, and how much of that this Control
 * Plane is willing to believe.
 *
 * The division is deliberate and it is the whole point of this module. The Node
 * decides *which* providers exist, because only the Node can: support means its
 * installed runtime can reach one, Asterism has code that drives the
 * authorization, and a run through it works. None of that is visible from here.
 *
 * So there is no provider list in this file, and there must never be one. What
 * this module owns is narrower and different in kind: **is this report a shape I
 * can read, and is it within bounds.** A schema version, some lengths, some
 * counts. A provider id it has never seen is stored and shown verbatim; a
 * provider id it recognises gets no special treatment. Adding a list here would
 * recreate the thing the architecture exists to avoid — two places deciding what
 * a host supports, disagreeing, and the one that is wrong being the one with the
 * UI.
 *
 * The report is authenticated but not trusted. The channel proves which Node is
 * speaking; it proves nothing about what the Node says. Everything below treats
 * the payload as hostile input that happens to have a return address.
 */

/**
 * The one shape this build can read.
 *
 * A number, not a set of feature flags, because there is no partial reading of a
 * shape you do not have. A Node reporting anything else is shown as unreadable —
 * never as a Node with no providers, which is a different and reassuring lie.
 */
export const SUPPORTED_SCHEMA_VERSION = 1;

/** Bounds, matched by the Node. A Rust test reads these very lines. */
export const MAX_PROVIDERS = 8;
export const MAX_AUTH_METHODS = 4;
export const MAX_ID_LENGTH = 64;
export const MAX_DISPLAY_NAME_LENGTH = 64;

/** Longest a release string may be, matching the column that stores it. */
const MAX_RELEASE_LENGTH = 64;

/** Longest an opaque token may be — an auth method, an availability reason. */
const MAX_TOKEN_LENGTH = 32;

export const AVAILABILITY = ['available', 'unavailable'] as const;
export type Availability = (typeof AVAILABILITY)[number];

export interface ProviderCapability {
  id: string;
  display_name: string;
  /**
   * Opaque bounded tokens, on purpose.
   *
   * A list of permitted methods here would be the provider allowlist again in a
   * smaller hat: a Node that gained a method this build had not heard of would
   * have its honest report rejected, and the fix would be a Control Plane
   * deploy. The console labels the ones it knows and shows the rest as they
   * came. Nothing acts on them in this phase.
   */
  auth_methods: string[];
  availability: Availability;
  unavailable_reason?: string;
}

export interface ProviderSnapshot {
  schema_version: number;
  runtime_release: string;
  reported_at: number;
  providers: ProviderCapability[];
}

export type SnapshotVerdict =
  | { status: 'ok'; snapshot: ProviderSnapshot }
  /** A shape this build cannot read. Stored, shown as such, never interpreted. */
  | { status: 'unsupported_schema'; schemaVersion: number }
  /** Not a report at all. Nothing is stored. */
  | { status: 'malformed'; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > max) return null;
  return value;
}

/**
 * Ids reach a URL and a database key, so the alphabet is closed rather than
 * escaped. Escaping is a claim about every consumer; refusing is a claim about
 * one string.
 */
const ID_PATTERN = /^[a-z0-9-]+$/;

/** A token that is safe to render and store, whatever it turns out to mean. */
const TOKEN_PATTERN = /^[a-z0-9_-]+$/;

/**
 * Read a Node's report.
 *
 * The order matters. Schema compatibility is decided *before* anything is
 * interpreted, because interpreting a shape you do not have is how an unknown
 * version silently becomes a supported provider.
 */
export function readSnapshot(raw: unknown): SnapshotVerdict {
  if (!isRecord(raw)) return { status: 'malformed', reason: 'not an object' };

  const schemaVersion = raw.schema_version;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    return { status: 'malformed', reason: 'no usable schema version' };
  }
  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return { status: 'unsupported_schema', schemaVersion };
  }

  const runtimeRelease = boundedString(raw.runtime_release, MAX_RELEASE_LENGTH);
  if (runtimeRelease === null) return { status: 'malformed', reason: 'no usable runtime release' };

  const reportedAt = raw.reported_at;
  if (typeof reportedAt !== 'number' || !Number.isFinite(reportedAt) || reportedAt < 0) {
    return { status: 'malformed', reason: 'no usable timestamp' };
  }

  if (!Array.isArray(raw.providers))
    return { status: 'malformed', reason: 'providers is not a list' };
  if (raw.providers.length > MAX_PROVIDERS) {
    return { status: 'malformed', reason: `more than ${MAX_PROVIDERS} providers` };
  }

  const providers: ProviderCapability[] = [];
  const seen = new Set<string>();
  for (const entry of raw.providers) {
    if (!isRecord(entry)) return { status: 'malformed', reason: 'a provider is not an object' };

    const id = boundedString(entry.id, MAX_ID_LENGTH);
    if (id === null || !ID_PATTERN.test(id)) {
      return { status: 'malformed', reason: 'a provider id is not usable' };
    }
    // Two rows for one id would make "which is current" depend on read order.
    if (seen.has(id)) return { status: 'malformed', reason: `provider ${id} appears twice` };
    seen.add(id);

    const displayName = boundedString(entry.display_name, MAX_DISPLAY_NAME_LENGTH);
    if (displayName === null) {
      return { status: 'malformed', reason: `no usable display name for ${id}` };
    }

    if (!Array.isArray(entry.auth_methods)) {
      return { status: 'malformed', reason: `auth methods for ${id} are not a list` };
    }
    if (entry.auth_methods.length === 0 || entry.auth_methods.length > MAX_AUTH_METHODS) {
      return { status: 'malformed', reason: `${id} offers an unusable number of auth methods` };
    }
    const authMethods: string[] = [];
    for (const method of entry.auth_methods) {
      const token = boundedString(method, MAX_TOKEN_LENGTH);
      if (token === null || !TOKEN_PATTERN.test(token)) {
        return { status: 'malformed', reason: `an auth method for ${id} is not usable` };
      }
      authMethods.push(token);
    }

    const availability = entry.availability;
    if (
      typeof availability !== 'string' ||
      !(AVAILABILITY as readonly string[]).includes(availability)
    ) {
      return { status: 'malformed', reason: `availability for ${id} is not one this build knows` };
    }

    let unavailableReason: string | undefined;
    if (entry.unavailable_reason !== undefined && entry.unavailable_reason !== null) {
      const token = boundedString(entry.unavailable_reason, MAX_TOKEN_LENGTH);
      if (token === null || !TOKEN_PATTERN.test(token)) {
        return { status: 'malformed', reason: `the reason given for ${id} is not usable` };
      }
      unavailableReason = token;
    }

    providers.push({
      id,
      display_name: displayName,
      auth_methods: authMethods,
      availability: availability as Availability,
      ...(unavailableReason ? { unavailable_reason: unavailableReason } : {}),
    });
  }

  return {
    status: 'ok',
    snapshot: {
      schema_version: schemaVersion,
      runtime_release: runtimeRelease,
      reported_at: reportedAt,
      providers,
    },
  };
}

/**
 * Pull the report out of a Node's capability payload, if it made one.
 *
 * `null` means the Node never said — a release that predates this contract.
 * That is not the same as a Node that reported no providers, and the difference
 * is preserved all the way to the page: one is unknown, the other is a claim.
 */
export function snapshotFromCapabilities(capabilities: unknown): unknown | null {
  if (!isRecord(capabilities)) return null;
  const reported = capabilities.provider_capabilities;
  return reported === undefined || reported === null ? null : reported;
}
