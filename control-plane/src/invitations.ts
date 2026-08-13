/** Single-use organization invitations. Email delivery is intentionally out of scope. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { hashPassword, normalizeEmail, passwordMatches, type SessionContext } from './auth.js';
import { authorize } from './auth.js';
import type { Pool } from './db.js';
import { withTransaction } from './db.js';
import type { Role } from './tenancy.js';

function digest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface InvitationRecord {
  invitation_id: string;
  organization_id: string;
  normalized_email: string;
  intended_role: Role;
  token_digest: string;
  created_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  invited_by: string;
}

export async function createInvitation(
  pool: Pool,
  actor: SessionContext,
  input: { email: string; role: Role; ttlMs: number; publicBaseUrl: string },
): Promise<{ record: InvitationRecord; invitationUrl: string } | null> {
  if (!authorize(actor, 'invitation.manage') || !actor.organization || !actor.membership) {
    return null;
  }
  if (input.role === 'owner' && !authorize(actor, 'member.grant_owner')) return null;
  const email = normalizeEmail(input.email);
  if (!email || email.length > 320) throw new Error('invalid invitation email');
  const token = randomBytes(32).toString('base64url');
  const invitationId = randomUUID();
  const result = await pool.query<InvitationRecord>(
    `INSERT INTO invitations
       (invitation_id, organization_id, normalized_email, intended_role,
        token_digest, expires_at, invited_by)
     VALUES ($1, $2, $3, $4, $5,
             now() + ($6::bigint || ' milliseconds')::interval, $7)
     RETURNING *`,
    [
      invitationId,
      actor.organization.organization_id,
      email,
      input.role,
      digest(token),
      String(input.ttlMs),
      actor.user.user_id,
    ],
  );
  const record = result.rows[0];
  if (!record) throw new Error('invitation insert returned no row');
  const base = input.publicBaseUrl.replace(/\/$/, '');
  return { record, invitationUrl: `${base}/invite/${token}` };
}

export async function acceptInvitation(
  pool: Pool,
  input: { token: string; displayName: string; password: string },
): Promise<{ userId: string; organizationId: string } | null> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<InvitationRecord>(
      `SELECT * FROM invitations
       WHERE token_digest = $1 AND accepted_at IS NULL AND revoked_at IS NULL
         AND expires_at > now()
       FOR UPDATE`,
      [digest(input.token)],
    );
    const invitation = result.rows[0];
    if (!invitation) return null;

    const existing = await client.query<{
      user_id: string;
      password_hash: string;
      enabled: boolean;
    }>('SELECT user_id, password_hash, enabled FROM users WHERE normalized_email = $1', [
      invitation.normalized_email,
    ]);
    let userId = existing.rows[0]?.user_id;
    if (existing.rows[0]) {
      if (
        !existing.rows[0].enabled ||
        !(await passwordMatches(existing.rows[0].password_hash, input.password))
      ) {
        return null;
      }
    } else {
      if (!input.displayName.trim() || input.displayName.length > 128) return null;
      userId = randomUUID();
      await client.query(
        `INSERT INTO users (user_id, normalized_email, display_name, password_hash)
         VALUES ($1, $2, $3, $4)`,
        [
          userId,
          invitation.normalized_email,
          input.displayName.trim(),
          await hashPassword(input.password),
        ],
      );
    }
    if (!userId) return null;
    const inserted = await client.query(
      `INSERT INTO memberships (organization_id, user_id, role)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [invitation.organization_id, userId, invitation.intended_role],
    );
    if ((inserted.rowCount ?? 0) !== 1) return null;
    await client.query('UPDATE invitations SET accepted_at = now() WHERE invitation_id = $1', [
      invitation.invitation_id,
    ]);
    await client.query(
      `INSERT INTO audit_log
         (action, actor, actor_user_id, target_type, target_id, result, organization_id, detail)
       VALUES ('invitation.accept', $1, $1, 'invitation', $2, 'success', $3, '{}'::jsonb)`,
      [userId, invitation.invitation_id, invitation.organization_id],
    );
    return { userId, organizationId: invitation.organization_id };
  });
}
