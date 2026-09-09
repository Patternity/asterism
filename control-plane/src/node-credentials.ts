/**
 * What a Node says about the credentials it holds.
 *
 * The same division as provider capabilities, for the same reason. The Node
 * decides which credentials exist, what they are called and what state they are
 * in, because the secret is a file on that host and nothing here can see it.
 * This module owns only the question *is this a report I can read, and is it
 * within bounds*.
 *
 * There is no provider list here and no authentication-method list. A provider
 * id this build has never seen is stored and shown verbatim. The one closed
 * vocabulary is the lifecycle — `required`, `authorizing`, `authorized`,
 * `failed`, `revoked` — which is a shared protocol between the two sides rather
 * than a claim about what a host supports, and the database constraint says the
 * same thing so neither can drift alone.
 *
 * Nothing that arrives here may be a secret. A reported credential carries an
 * id, a provider, a label, a method, a state and two timestamps; anything else
 * is dropped rather than stored, because a field nobody planned for is exactly
 * how a token ends up in a database.
 */

/** Most credentials one Node may report. Matched by the Node. */
export const MAX_CREDENTIALS = 16;

export const MAX_CREDENTIAL_ID_LENGTH = 64;
export const MAX_LABEL_LENGTH = 64;
const MAX_PROVIDER_ID_LENGTH = 64;
const MAX_METHOD_LENGTH = 32;

/**
 * Where a credential stands.
 *
 * A protocol, not a capability: both sides and the database constraint carry
 * this list, and a value in one and not the others is a state somebody renders
 * as a raw identifier.
 */
export const CREDENTIAL_STATES = [
  'required',
  'authorizing',
  'authorized',
  'failed',
  'revoked',
] as const;

export type CredentialState = (typeof CREDENTIAL_STATES)[number];

export function isCredentialState(value: unknown): value is CredentialState {
  return typeof value === 'string' && (CREDENTIAL_STATES as readonly string[]).includes(value);
}

export interface ReportedCredential {
  id: string;
  provider_id: string;
  auth_method: string;
  label: string;
  state: CredentialState;
  created_at: number;
  updated_at: number;
}

export type CredentialsVerdict =
  | { status: 'ok'; credentials: ReportedCredential[] }
  | { status: 'malformed'; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Closed alphabets rather than escaping. These values reach a database key and a
 * URL path segment; refusing is a claim about one string, escaping would be a
 * claim about every consumer of it.
 */
const ID_PATTERN = /^[a-z0-9-]+$/;
const METHOD_PATTERN = /^[a-z0-9_-]+$/;

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

/** Read what a Node reported. Anything unreadable is refused whole. */
export function readCredentials(raw: unknown): CredentialsVerdict {
  if (!Array.isArray(raw)) return { status: 'malformed', reason: 'not a list' };
  if (raw.length > MAX_CREDENTIALS) {
    return { status: 'malformed', reason: `more than ${MAX_CREDENTIALS} credentials` };
  }

  const credentials: ReportedCredential[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry)) return { status: 'malformed', reason: 'a credential is not an object' };

    const id = boundedString(entry.id, MAX_CREDENTIAL_ID_LENGTH);
    if (id === null || !ID_PATTERN.test(id)) {
      return { status: 'malformed', reason: 'a credential id is not usable' };
    }
    if (seen.has(id)) return { status: 'malformed', reason: `credential ${id} appears twice` };
    seen.add(id);

    const providerId = boundedString(entry.provider_id, MAX_PROVIDER_ID_LENGTH);
    if (providerId === null || !ID_PATTERN.test(providerId)) {
      return { status: 'malformed', reason: `the provider for ${id} is not usable` };
    }

    const authMethod = boundedString(entry.auth_method, MAX_METHOD_LENGTH);
    if (authMethod === null || !METHOD_PATTERN.test(authMethod)) {
      return { status: 'malformed', reason: `the auth method for ${id} is not usable` };
    }

    const label = boundedString(entry.label, MAX_LABEL_LENGTH);
    // Control characters would let a label lie about which line it is on.
    if (label === null || /[\p{Cc}]/u.test(label)) {
      return { status: 'malformed', reason: `the label for ${id} is not usable` };
    }

    if (!isCredentialState(entry.state)) {
      return { status: 'malformed', reason: `the state for ${id} is not one this build knows` };
    }

    const createdAt = entry.created_at;
    const updatedAt = entry.updated_at;
    if (
      typeof createdAt !== 'number' ||
      typeof updatedAt !== 'number' ||
      !Number.isFinite(createdAt) ||
      !Number.isFinite(updatedAt) ||
      createdAt < 0 ||
      updatedAt < 0
    ) {
      return { status: 'malformed', reason: `the timestamps for ${id} are not usable` };
    }

    // Built field by field rather than spread, so a field nobody planned for
    // cannot ride along into the database.
    credentials.push({
      id,
      provider_id: providerId,
      auth_method: authMethod,
      label,
      state: entry.state,
      created_at: createdAt,
      updated_at: updatedAt,
    });
  }

  return { status: 'ok', credentials };
}

/** A label a person typed, on its way to a Node. */
export function validateLabel(value: unknown): string | null {
  const label = boundedString(value, MAX_LABEL_LENGTH);
  if (label === null || /[\p{Cc}]/u.test(label)) return null;
  return label;
}

/** A credential id on its way into a URL and a command. */
export function validateCredentialId(value: unknown): string | null {
  const id = boundedString(value, MAX_CREDENTIAL_ID_LENGTH);
  return id !== null && ID_PATTERN.test(id) ? id : null;
}
