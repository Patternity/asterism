/**
 * Asterism protocol v1 — independent TypeScript implementation.
 *
 * Written from `docs/protocol/v1.md`, not ported from the Rust Node. That
 * independence is the point: two implementations built from one written
 * specification are what turn the specification into something testable, and
 * any place they disagree is a defect in the specification rather than a
 * difference of opinion.
 *
 * Cross-language fixtures under `docs/protocol/fixtures/v1/` pin the parts that
 * must be byte-identical — above all the canonical authentication transcript.
 */
import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from 'node:crypto';

import { z } from 'zod';

/** Protocol versions this build understands. */
export const SUPPORTED_VERSIONS = [1] as const;
export const PROTOCOL_VERSION = 1;

/** Hard frame ceiling. Larger frames are rejected, never buffered. */
export const MAX_FRAME_BYTES = 1024 * 1024;
/** Hard command payload ceiling. */
export const MAX_COMMAND_PAYLOAD_BYTES = 128 * 1024;

/**
 * Domain separator mixed into every authentication transcript.
 *
 * Without it a signature produced for this protocol could be replayed as a
 * signature for anything else the same key signs.
 */
export const AUTH_DOMAIN = 'asterism-node-auth/v1';

export const MESSAGE_TYPES = {
  clientHello: 'client.hello',
  serverChallenge: 'server.challenge',
  clientAuthenticate: 'client.authenticate',
  serverReady: 'server.ready',
  clientHeartbeat: 'client.heartbeat',
  serverHeartbeatAck: 'server.heartbeat.ack',
  serverCommand: 'server.command',
  clientCommandAccepted: 'client.command.accepted',
  clientCommandResult: 'client.command.result',
  serverCommandResultAck: 'server.command.result.ack',
  clientEvent: 'client.event',
  serverEventAck: 'server.event.ack',
  error: 'error',
} as const;

/** Commands a Node will execute. Anything else is refused. */
export const ALLOWED_COMMANDS = [
  'capabilities.get',
  'projects.list',
  'runs.create',
  'runs.list',
  'runs.get',
  'runs.cancel',
  'runs.retry',
  // Run-scoped approval policy. Operator-initiated through the authenticated
  // channel; nothing the model produces can reach it.
  'runs.approval_policy',
  // Build a project's workspace and its own Hermes home on the owning Node.
  // Carries product identity and sanitized workspace intent only: where any of
  // it lands on the host is the Node's decision and never travels back.
  'project.provision',
  'approvals.resolve',
  'events.subscribe',
  'events.unsubscribe',
  'node.drain',
] as const;

export type AllowedCommand = (typeof ALLOWED_COMMANDS)[number];

export function isAllowedCommand(name: string): name is AllowedCommand {
  return (ALLOWED_COMMANDS as readonly string[]).includes(name);
}

export const ERROR_CODES = {
  malformedFrame: 'malformed_frame',
  frameTooLarge: 'frame_too_large',
  unsupportedVersion: 'unsupported_version',
  unknownMessageType: 'unknown_message_type',
  notAuthenticated: 'not_authenticated',
  authenticationFailed: 'authentication_failed',
  challengeExpired: 'challenge_expired',
  challengeReplayed: 'challenge_replayed',
  unknownNode: 'unknown_node',
  payloadTooLarge: 'payload_too_large',
  unknownCommand: 'unknown_command',
  forbiddenCommand: 'forbidden_command',
  projectNotRegistered: 'project_not_registered',
  duplicatePayloadMismatch: 'duplicate_payload_mismatch',
  commandFailed: 'command_failed',
  internal: 'internal',
  sessionReplaced: 'session_replaced',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class ProtocolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}

// ---------------------------------------------------------------- envelope

/**
 * Envelope schema.
 *
 * `passthrough` on the envelope and payload is deliberate: forward
 * compatibility requires tolerating fields a newer peer added, while the fields
 * we do know are still validated strictly.
 */
export const EnvelopeSchema = z
  .object({
    protocol_version: z.number().int(),
    message_id: z.string().min(1).max(128),
    type: z.string().min(1).max(64),
    timestamp: z.number().int(),
    correlation_id: z.string().min(1).max(128).optional(),
    payload: z.unknown().default({}),
  })
  .passthrough();

export type Envelope = z.infer<typeof EnvelopeSchema>;

export function buildEnvelope(type: string, payload: unknown, correlationId?: string): Envelope {
  return {
    protocol_version: PROTOCOL_VERSION,
    message_id: randomUuid(),
    type,
    timestamp: Date.now(),
    ...(correlationId ? { correlation_id: correlationId } : {}),
    payload: payload ?? {},
  };
}

export function encodeEnvelope(envelope: Envelope): string {
  const text = JSON.stringify(envelope);
  if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) {
    throw new ProtocolError(ERROR_CODES.frameTooLarge, 'outgoing frame exceeds the limit');
  }
  return text;
}

/** Parse and validate one inbound frame. */
export function decodeEnvelope(raw: string | Buffer): Envelope {
  const bytes = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(raw, 'utf8');
  if (bytes > MAX_FRAME_BYTES) {
    throw new ProtocolError(
      ERROR_CODES.frameTooLarge,
      `frame of ${bytes} bytes exceeds ${MAX_FRAME_BYTES}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString());
  } catch (error) {
    throw new ProtocolError(
      ERROR_CODES.malformedFrame,
      `frame is not valid JSON: ${(error as Error).message}`,
    );
  }

  const result = EnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    throw new ProtocolError(
      ERROR_CODES.malformedFrame,
      `frame failed validation: ${result.error.issues.map((i) => i.message).join('; ')}`,
    );
  }

  const envelope = result.data;
  if (!(SUPPORTED_VERSIONS as readonly number[]).includes(envelope.protocol_version)) {
    throw new ProtocolError(
      ERROR_CODES.unsupportedVersion,
      `protocol version ${envelope.protocol_version} is not supported`,
    );
  }
  return envelope;
}

export function errorEnvelope(error: ProtocolError, correlationId?: string): Envelope {
  return buildEnvelope(
    MESSAGE_TYPES.error,
    { code: error.code, message: error.message },
    correlationId,
  );
}

// -------------------------------------------------------------- handshake

export const ClientHelloSchema = z
  .object({
    supported_versions: z.array(z.number().int()).min(1),
    node_id: z.string().min(1).max(128),
    instance_id: z.string().min(1).max(128),
    public_key_fingerprint: z.string().regex(/^[0-9a-f]{64}$/, 'fingerprint must be 64 hex chars'),
    client_nonce: z.string().min(1).max(256),
    capabilities_digest: z.string().min(1).max(128),
    software_version: z.string().max(64).default('unknown'),
  })
  .passthrough();

export type ClientHello = z.infer<typeof ClientHelloSchema>;

export const ClientAuthenticateSchema = z
  .object({
    session_id: z.string().min(1).max(128),
    signature: z.string().min(1).max(256),
  })
  .passthrough();

export const RemoteCommandSchema = z
  .object({
    command_id: z.string().min(1).max(128),
    command: z.string().min(1).max(64),
    project_id: z.string().min(1).max(128).nullish(),
    payload: z.unknown().default({}),
  })
  .passthrough();

export const CommandResultSchema = z
  .object({
    command_id: z.string().min(1).max(128),
    state: z.string().min(1).max(32),
    result: z.unknown().nullish(),
    error_code: z.string().max(64).nullish(),
    error_message: z.string().max(4096).nullish(),
    deduplicated: z.boolean().optional(),
  })
  .passthrough();

export const EventDeliverySchema = z
  .object({
    project_id: z.string().min(1).max(128),
    run_id: z.string().min(1).max(128),
    seq: z.number().int().nonnegative(),
    event_type: z.string().min(1).max(128),
    recorded_at: z.number().int().optional(),
    payload: z.unknown().default({}),
  })
  .passthrough();

export const HeartbeatSchema = z
  .object({
    instance_id: z.string().max(128).optional(),
    connection_state: z.string().max(32).optional(),
    registered_projects: z.number().int().nonnegative().optional(),
    active_runs: z.number().int().nonnegative().optional(),
    draining: z.boolean().optional(),
    software_version: z.string().max(64).optional(),
  })
  .passthrough();

/** Highest version both sides support, or null. */
export function negotiateVersion(
  client: readonly number[],
  server: readonly number[] = SUPPORTED_VERSIONS,
): number | null {
  const shared = client.filter((version) => server.includes(version));
  return shared.length === 0 ? null : Math.max(...shared);
}

// ---------------------------------------------------- canonical transcript

export interface AuthTranscriptInput {
  protocolVersion: number;
  nodeId: string;
  instanceId: string;
  sessionId: string;
  clientNonce: string;
  serverNonce: string;
  issuedAt: number;
  expiresAt: number;
  capabilitiesDigest: string;
}

/**
 * Build the canonical authentication transcript.
 *
 * A JSON object with **sorted keys**, no insignificant whitespace, and every
 * value rendered as a string so the encoding cannot depend on numeric
 * formatting. Both implementations must produce identical bytes; the fixtures
 * assert that they do.
 *
 * `JSON.stringify` is given an explicit key list rather than relying on
 * insertion order, so the ordering is a property of this function and not of
 * how the object literal happened to be written.
 */
export function authTranscript(input: AuthTranscriptInput): Buffer {
  const fields: Record<string, string> = {
    capabilities_digest: input.capabilitiesDigest,
    client_nonce: input.clientNonce,
    domain: AUTH_DOMAIN,
    expires_at: String(input.expiresAt),
    instance_id: input.instanceId,
    issued_at: String(input.issuedAt),
    node_id: input.nodeId,
    protocol_version: String(input.protocolVersion),
    server_nonce: input.serverNonce,
    session_id: input.sessionId,
  };
  const orderedKeys = Object.keys(fields).sort();
  return Buffer.from(JSON.stringify(fields, orderedKeys), 'utf8');
}

// ------------------------------------------------------------- primitives

/**
 * Canonical JSON encoding used for every digest in the protocol.
 *
 * Object keys are sorted **recursively** and there is no insignificant
 * whitespace, so two implementations digest the same logical value to the same
 * bytes regardless of the order the fields happened to be written in.
 *
 * This was not spelled out in the first draft of the specification, and the two
 * implementations disagreed as a result: Rust's `serde_json` orders map keys
 * while `JSON.stringify` preserves insertion order. The specification now
 * defines the canonical form; this function implements it.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value ?? null));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalize(source[key]);
    }
    return sorted;
  }
  return value;
}

/** SHA-256 over the canonical JSON encoding, lowercase hex. */
export function digestJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** SHA-256 of raw text, lowercase hex. */
export function digestText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** SHA-256 fingerprint of a base64 Ed25519 public key. */
export function fingerprintOf(publicKeyBase64: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex');
}

/** DER SPKI prefix for a raw 32-byte Ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Verify an Ed25519 signature over `message`.
 *
 * Never throws: malformed key or signature material is a `false`, so a hostile
 * peer cannot turn bad input into an exception path.
 */
export function verifySignature(
  publicKeyBase64: string,
  message: Buffer,
  signatureBase64: string,
): boolean {
  try {
    const rawKey = Buffer.from(publicKeyBase64, 'base64');
    if (rawKey.length !== 32) return false;
    const signature = Buffer.from(signatureBase64, 'base64');
    if (signature.length !== 64) return false;

    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
      format: 'der',
      type: 'spki',
    });
    return cryptoVerify(null, message, key, signature);
  } catch {
    return false;
  }
}

/** Fresh 256-bit nonce, base64. */
export function newNonce(): string {
  return randomBytes(32).toString('base64');
}

export function randomUuid(): string {
  return globalThis.crypto.randomUUID();
}

/** Payload digest for command deduplication: SHA-256 over the defining parts. */
export function commandFingerprint(
  command: string,
  projectId: string | null | undefined,
  payload: unknown,
): string {
  return digestJson({ command, project_id: projectId ?? null, payload: payload ?? {} });
}

/** Validate a command the Control Plane is about to dispatch. */
export function assertDispatchable(command: string, payload: unknown): void {
  if (!isAllowedCommand(command)) {
    throw new ProtocolError(ERROR_CODES.forbiddenCommand, `command ${command} is not permitted`);
  }
  const size = Buffer.byteLength(JSON.stringify(payload ?? {}), 'utf8');
  if (size > MAX_COMMAND_PAYLOAD_BYTES) {
    throw new ProtocolError(
      ERROR_CODES.payloadTooLarge,
      `payload of ${size} bytes exceeds ${MAX_COMMAND_PAYLOAD_BYTES}`,
    );
  }
}
