/**
 * Identifiers a Node declares safe to keep, and nothing else.
 *
 * The Node's redactor destroys any field whose name looks like a secret, which
 * is right for `access_token` and wrong for an opaque `credential_id`. Rather
 * than excuse a name, the Node sends such identifiers under one reserved key,
 * `safe_metadata`, and every consumer here re-validates each entry against a
 * closed list of identifiers with exact grammars -- the mirror of the Node's
 * `redact::SafeIdentifier`. An unknown name, a value of the wrong shape, or
 * anything that is not a plain string is not metadata: it is dropped when read
 * and destroyed when logged. Fail closed.
 */

export const SAFE_METADATA_KEY = 'safe_metadata';

/** The closed list, with the exact shape each identifier must have. */
const GRAMMARS: Readonly<Record<string, RegExp>> = {
  // `cred-` and sixteen lowercase hex digits: every id a Node generates or derives.
  credential_id: /^cred-[0-9a-f]{16}$/,
};

export interface SafeMetadata {
  credential_id?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValid(key: string, value: unknown): value is string {
  const grammar = Object.prototype.hasOwnProperty.call(GRAMMARS, key) ? GRAMMARS[key] : undefined;
  return grammar !== undefined && typeof value === 'string' && grammar.test(value);
}

/** Only the identifiers that validate. Everything else is simply absent. */
export function readSafeMetadata(value: unknown): SafeMetadata {
  if (!isRecord(value)) return {};
  const out: SafeMetadata = {};
  if (isValid('credential_id', value.credential_id)) out.credential_id = value.credential_id;
  return out;
}

/**
 * What a log or stored copy may keep of a `safe_metadata` value: validated
 * identifiers unchanged, every other entry replaced, and anything that is not
 * an object replaced whole.
 */
export function redactSafeMetadata(value: unknown): unknown {
  if (!isRecord(value)) return '[redacted]';
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = isValid(key, child) ? child : '[redacted]';
  }
  return out;
}
