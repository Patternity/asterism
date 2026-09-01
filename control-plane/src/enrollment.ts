/**
 * Node enrollment.
 *
 * One transaction does all of it: claim the token with `FOR UPDATE`, validate
 * the key, create the Node, mark the token consumed. Two simultaneous requests
 * carrying the same token therefore enroll **at most one** Node — the second
 * blocks on the row lock, then finds it already consumed.
 */
import { z } from 'zod';

import { type Pool, type PoolClient, withTransaction } from './db.js';
import type { Logger } from './logger.js';
import {
  PROTOCOL_VERSION,
  SUPPORTED_VERSIONS,
  fingerprintOf,
  negotiateVersion,
} from './protocol.js';
import { nodeInstallationsRepo } from './node-installation-repository.js';
import { auditRepo, enrollmentTokensRepo, nodesRepo, rotationsRepo } from './repositories.js';

const EnrollRequestSchema = z.object({
  public_key: z.string().min(1).max(256),
  public_key_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  display_name: z.string().min(1).max(128),
  supported_protocol_versions: z.array(z.number().int()).min(1),
  software_version: z.string().max(64).optional(),
});

export type EnrollOutcome =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; message: string };

export async function enroll(
  pool: Pool,
  input: { token: string; body: unknown; log: Logger },
): Promise<EnrollOutcome> {
  const parsed = EnrollRequestSchema.safeParse(input.body);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      message: `invalid enrollment request: ${parsed.error.message}`,
    };
  }
  const request = parsed.data;

  // The key must actually be a 32-byte Ed25519 key, and the claimed fingerprint
  // must be the one it produces. Trusting the submitted fingerprint would let a
  // caller register a key under someone else's identity string.
  const raw = Buffer.from(request.public_key, 'base64');
  if (raw.length !== 32) {
    return { ok: false, status: 400, message: 'public_key must be a 32-byte Ed25519 key' };
  }
  const fingerprint = fingerprintOf(request.public_key);
  if (fingerprint !== request.public_key_fingerprint) {
    return { ok: false, status: 400, message: 'public_key_fingerprint does not match public_key' };
  }

  const version = negotiateVersion(request.supported_protocol_versions, [...SUPPORTED_VERSIONS]);
  if (version === null) {
    return {
      ok: false,
      status: 409,
      message: `no shared protocol version; this Control Plane supports ${SUPPORTED_VERSIONS.join(', ')}`,
    };
  }

  try {
    return await withTransaction(pool, async (client) => {
      const token = await enrollmentTokensRepo.claim(client, input.token);
      if (!token) {
        await auditRepo.record(client, {
          action: 'node.enroll',
          actor: 'unknown',
          result: 'failure',
          detail: { reason: 'unknown_expired_or_consumed_token' },
        });
        return {
          ok: false as const,
          status: 401,
          message: 'unknown, expired, revoked, or already-consumed enrollment token',
        };
      }

      // A rotation token re-keys one existing Node instead of creating another.
      // It reuses this endpoint deliberately: replacing a key must work when the
      // old key is already compromised or lost, which is exactly when the
      // authenticated channel cannot be trusted to carry the request.
      if (token.purpose === 'rotation') {
        return await rotateIdentity(client, {
          token,
          fingerprint,
          publicKey: request.public_key,
          version,
          log: input.log,
        });
      }

      // An active identity is unique; a duplicate would make `node_id`
      // ambiguous at authentication time.
      const duplicate = await client.query<{ node_id: string }>(
        'SELECT node_id FROM nodes WHERE fingerprint = $1 AND revoked_at IS NULL',
        [fingerprint],
      );
      if (duplicate.rows.length > 0) {
        return {
          ok: false as const,
          status: 409,
          message: 'this public key is already enrolled as an active identity',
        };
      }

      const count = await client.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM nodes',
      );
      const nodeId = `node-${Number(count.rows[0]?.count ?? 0) + 1}`;

      // The name a person typed when they added the Node wins over the name the
      // host reports about itself. `intended_name` exists for exactly this: a
      // server called "Production west" in the console should not come back
      // calling itself by its hostname.
      const displayName = token.intended_name?.trim() || request.display_name;

      const node = await nodesRepo.create(client, {
        nodeId,
        displayName,
        publicKey: request.public_key,
        fingerprint,
        organizationId: token.organization_id,
      });
      await enrollmentTokensRepo.markConsumed(client, token.token_id, node.node_id);
      // If this code came from `Add Node`, the installation it belongs to learns
      // which Node it produced. In the same transaction, so the two cannot
      // disagree; a no-op for a token issued any other way.
      await nodeInstallationsRepo.attachNodeByToken(client, token.token_id, node.node_id);
      await auditRepo.record(client, {
        action: 'node.enroll',
        actor: node.node_id,
        targetType: 'node',
        targetId: node.node_id,
        result: 'success',
        organizationId: token.organization_id,
        detail: {
          fingerprint,
          purpose: token.purpose,
          protocol_version: version,
          display_name: displayName,
        },
      });

      input.log.info('node enrolled', {
        node_id: node.node_id,
        fingerprint,
        purpose: token.purpose,
      });

      return {
        ok: true as const,
        body: {
          node_id: node.node_id,
          protocol_version: version,
          accepted_protocol_versions: SUPPORTED_VERSIONS,
          server_metadata: { control_plane: 'asterism', protocol: PROTOCOL_VERSION },
        },
      };
    });
  } catch (error) {
    input.log.error('enrollment failed', { error: String(error) });
    return { ok: false, status: 500, message: 'enrollment failed' };
  }
}

/**
 * Replace an enrolled Node's key, preserving its `node_id`.
 *
 * The generation counter is what makes a rotation observable: an operator can
 * tell "the same Node with a new key" from "a different Node", and every session
 * recorded before the bump is attributable to the superseded key.
 */
async function rotateIdentity(
  client: PoolClient,
  input: {
    token: {
      token_id: string;
      bound_node_id: string | null;
      purpose: string;
      organization_id: string;
    };
    fingerprint: string;
    publicKey: string;
    version: number;
    log: Logger;
  },
): Promise<EnrollOutcome> {
  const nodeId = input.token.bound_node_id;
  if (!nodeId) {
    // Guarded by a CHECK constraint too; this is the belt to that suspenders.
    return { ok: false, status: 409, message: 'rotation token is not bound to a Node' };
  }

  const node = await nodesRepo.byId(client, nodeId);
  if (!node || node.revoked_at) {
    return { ok: false, status: 409, message: 'the bound Node is unknown or revoked' };
  }
  if (node.fingerprint === input.fingerprint) {
    return {
      ok: false,
      status: 409,
      message: 'the proposed key is the one already in use; rotation must change the key',
    };
  }

  // The new key must not collide with another active identity.
  const collision = await client.query<{ node_id: string }>(
    'SELECT node_id FROM nodes WHERE fingerprint = $1 AND revoked_at IS NULL AND node_id <> $2',
    [input.fingerprint, nodeId],
  );
  if (collision.rows.length > 0) {
    return { ok: false, status: 409, message: 'the proposed key is already an active identity' };
  }

  const rotation = await rotationsRepo.open(client, {
    nodeId,
    oldFingerprint: node.fingerprint,
    oldPublicKey: node.public_key,
    proposedPublicKey: input.publicKey,
    proposedFingerprint: input.fingerprint,
    challengeNonce: '',
    ttlMs: 60_000,
  });
  await nodesRepo.rotateIdentity(client, nodeId, input.publicKey, input.fingerprint);
  await rotationsRepo.setState(client, rotation.rotation_id, 'completed');
  await enrollmentTokensRepo.markConsumed(client, input.token.token_id, nodeId);
  await auditRepo.record(client, {
    action: 'node.rotate_identity',
    actor: nodeId,
    targetType: 'node',
    targetId: nodeId,
    result: 'success',
    organizationId: input.token.organization_id,
    detail: {
      rotation_id: rotation.rotation_id,
      old_fingerprint: node.fingerprint,
      new_fingerprint: input.fingerprint,
      identity_generation: node.identity_generation + 1,
    },
  });

  input.log.warn('node identity rotated', {
    node_id: nodeId,
    old_fingerprint: node.fingerprint,
    new_fingerprint: input.fingerprint,
  });

  return {
    ok: true,
    body: {
      node_id: nodeId,
      rotated: true,
      identity_generation: node.identity_generation + 1,
      protocol_version: input.version,
      accepted_protocol_versions: SUPPORTED_VERSIONS,
      server_metadata: { control_plane: 'asterism', protocol: PROTOCOL_VERSION },
    },
  };
}
