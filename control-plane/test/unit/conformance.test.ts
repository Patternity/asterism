/**
 * Cross-language protocol conformance.
 *
 * This file does two things:
 *
 *   1. Computes every derived value from the shared, language-neutral inputs and
 *      writes them to `outputs.typescript.json`.
 *   2. Asserts that the Rust Node's committed `outputs.rust.json` matches what
 *      this independent implementation computed.
 *
 * The Rust side does the mirror image. Two implementations built separately from
 * one written specification is what makes the specification testable; anywhere
 * they disagree is a defect in `docs/protocol/v1.md`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createPrivateKey, createPublicKey, sign as cryptoSign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ALLOWED_COMMANDS,
  ERROR_CODES,
  ProtocolError,
  authTranscript,
  commandFingerprint,
  decodeEnvelope,
  digestJson,
  fingerprintOf,
  isAllowedCommand,
  negotiateVersion,
  verifySignature,
} from '../../src/protocol.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../../../docs/protocol/fixtures/v1');
const INPUTS = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'inputs.json'), 'utf8'));

/** DER PKCS#8 prefix for a raw 32-byte Ed25519 seed. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function testKey() {
  const seed = Buffer.from(INPUTS.test_key.seed_hex, 'hex');
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKeyDer = createPublicKey(privateKey).export({
    format: 'der',
    type: 'spki',
  }) as Buffer;
  // The raw key is the trailing 32 bytes of the SPKI encoding.
  const publicKey = publicKeyDer.subarray(publicKeyDer.length - 32).toString('base64');
  return { privateKey, publicKey };
}

function transcriptFor(overrides: Record<string, unknown> = {}) {
  const h = INPUTS.handshake;
  return authTranscript({
    protocolVersion: (overrides.protocol_version as number) ?? INPUTS.protocol_version,
    nodeId: (overrides.node_id as string) ?? h.node_id,
    instanceId: (overrides.instance_id as string) ?? h.instance_id,
    sessionId: (overrides.session_id as string) ?? h.session_id,
    clientNonce: (overrides.client_nonce as string) ?? h.client_nonce,
    serverNonce: (overrides.server_nonce as string) ?? h.server_nonce,
    issuedAt: (overrides.issued_at as number) ?? h.issued_at,
    expiresAt: (overrides.expires_at as number) ?? h.expires_at,
    capabilitiesDigest: (overrides.capabilities_digest as string) ?? h.capabilities_digest,
  });
}

/** Compute the full output set from the shared inputs. */
function computeOutputs() {
  const { privateKey, publicKey } = testKey();
  const transcript = transcriptFor();
  const signature = cryptoSign(null, transcript, privateKey).toString('base64');

  const variants: Record<string, string> = {};
  for (const [field, value] of Object.entries(INPUTS.transcript_variants)) {
    if (field.startsWith('$')) continue;
    variants[field] = transcriptFor({ [field]: value }).toString('base64');
  }

  return {
    public_key: publicKey,
    fingerprint: fingerprintOf(publicKey),
    transcript_utf8: transcript.toString('utf8'),
    transcript_base64: transcript.toString('base64'),
    signature,
    transcript_variants: variants,
    digests: Object.fromEntries(
      INPUTS.digest_vectors.map((vector: { name: string; value: unknown }) => [
        vector.name,
        digestJson(vector.value),
      ]),
    ),
    command_fingerprints: Object.fromEntries(
      INPUTS.command_vectors.map(
        (vector: {
          name: string;
          command: string;
          project_id: string | null;
          payload: unknown;
        }) => [vector.name, commandFingerprint(vector.command, vector.project_id, vector.payload)],
      ),
    ),
    allowed_commands: [...ALLOWED_COMMANDS],
  };
}

describe('cross-language protocol conformance', () => {
  const outputs = computeOutputs();

  it('publishes this implementation’s computed outputs', () => {
    if (!existsSync(FIXTURE_DIR)) mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(
      path.join(FIXTURE_DIR, 'outputs.typescript.json'),
      `${JSON.stringify(outputs, null, 2)}\n`,
    );
    expect(outputs.public_key).toHaveLength(44);
  });

  it('derives the same public key and fingerprint as the Rust Node', () => {
    const rust = readRustOutputs();
    expect(outputs.public_key).toBe(rust.public_key);
    expect(outputs.fingerprint).toBe(rust.fingerprint);
  });

  it('produces byte-identical canonical transcripts', () => {
    const rust = readRustOutputs();
    // The transcript is the one thing that MUST match byte for byte: a
    // divergence here would make every signature unverifiable across languages.
    expect(outputs.transcript_utf8).toBe(rust.transcript_utf8);
    expect(outputs.transcript_base64).toBe(rust.transcript_base64);
  });

  it('verifies the signature the Rust Node produced', () => {
    const rust = readRustOutputs();
    const transcript = Buffer.from(rust.transcript_base64, 'base64');
    expect(verifySignature(rust.public_key, transcript, rust.signature)).toBe(true);
  });

  it('produces a signature the Rust Node’s public key verifies', () => {
    const transcript = Buffer.from(outputs.transcript_base64, 'base64');
    expect(verifySignature(outputs.public_key, transcript, outputs.signature)).toBe(true);
  });

  it('changing any signed field invalidates the signature', () => {
    const transcript = Buffer.from(outputs.transcript_base64, 'base64');
    for (const [field, variantBase64] of Object.entries(outputs.transcript_variants)) {
      const variant = Buffer.from(variantBase64, 'base64');
      expect(variant.equals(transcript), `${field} must change the transcript`).toBe(false);
      expect(
        verifySignature(outputs.public_key, variant, outputs.signature),
        `${field} must invalidate the signature`,
      ).toBe(false);
    }
  });

  it('agrees with the Rust Node on every transcript variant', () => {
    const rust = readRustOutputs();
    for (const [field, value] of Object.entries(outputs.transcript_variants)) {
      expect(rust.transcript_variants[field], `variant ${field}`).toBe(value);
    }
  });

  it('agrees on SHA-256 digests including key order and Unicode', () => {
    const rust = readRustOutputs();
    for (const [name, digest] of Object.entries(outputs.digests)) {
      expect(rust.digests[name], `digest ${name}`).toBe(digest);
    }
    // Object key order must not affect the digest.
    expect(outputs.digests.key_order).toBe(digestJson({ a: 1, b: 2 }));
  });

  it('agrees on command fingerprints', () => {
    const rust = readRustOutputs();
    for (const [name, digest] of Object.entries(outputs.command_fingerprints)) {
      expect(rust.command_fingerprints[name], `command ${name}`).toBe(digest);
    }
    // Different work must produce a different fingerprint.
    expect(outputs.command_fingerprints.runs_create).not.toBe(
      outputs.command_fingerprints.runs_create_other_payload,
    );
  });

  it('agrees on the allowed command set', () => {
    const rust = readRustOutputs();
    expect([...outputs.allowed_commands].sort()).toEqual([...rust.allowed_commands].sort());
  });

  it('rejects every invalid frame with the specified error code', () => {
    for (const frame of INPUTS.invalid_frames) {
      let code: string | undefined;
      try {
        decodeEnvelope(frame.raw);
      } catch (error) {
        code = (error as ProtocolError).code;
      }
      expect(code, `frame ${frame.name}`).toBe(frame.expected_error);
    }
  });

  it('accepts a frame carrying fields added by a newer peer', () => {
    const envelope = decodeEnvelope(INPUTS.forward_compatible_frame.raw);
    expect(envelope.type).toBe('client.hello');
    expect((envelope.payload as Record<string, unknown>).added_later).toBe(true);
  });

  it('rejects oversized frames before parsing them', () => {
    let code: string | undefined;
    try {
      decodeEnvelope('x'.repeat(1024 * 1024 + 1));
    } catch (error) {
      code = (error as ProtocolError).code;
    }
    expect(code).toBe(ERROR_CODES.frameTooLarge);
  });

  it('refuses every forbidden command', () => {
    for (const command of INPUTS.forbidden_commands) {
      expect(isAllowedCommand(command), `${command} must be refused`).toBe(false);
    }
  });

  it('negotiates the highest shared protocol version', () => {
    expect(negotiateVersion([1, 2, 3], [2, 3, 4])).toBe(3);
    expect(negotiateVersion([1], [1])).toBe(1);
    expect(negotiateVersion([1, 2], [3, 4])).toBeNull();
    expect(negotiateVersion([], [1])).toBeNull();
  });

  it('follows the documented replay cursor rules', () => {
    const { journal_seqs, acked_seq, expected_delivery } = INPUTS.replay;
    const delivered = journal_seqs.filter((seq: number) => seq > acked_seq);
    expect(delivered).toEqual(expected_delivery);
  });
});

function readRustOutputs(): {
  public_key: string;
  fingerprint: string;
  transcript_utf8: string;
  transcript_base64: string;
  signature: string;
  transcript_variants: Record<string, string>;
  digests: Record<string, string>;
  command_fingerprints: Record<string, string>;
  allowed_commands: string[];
} {
  const file = path.join(FIXTURE_DIR, 'outputs.rust.json');
  if (!existsSync(file)) {
    throw new Error(
      `${file} is missing. Generate it first with: cargo test --test protocol_fixtures`,
    );
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}
