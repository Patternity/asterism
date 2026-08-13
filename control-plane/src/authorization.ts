/** Membership mutation invariants that sit above the role permission matrix. */
import type { Pool } from './db.js';
import { authorize, type SessionContext } from './auth.js';
import type { Role } from './tenancy.js';

export type MembershipChangeResult =
  | { ok: true }
  | { ok: false; status: 403 | 404 | 409; code: string };

async function activeOwnerCount(pool: Pool, organizationId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM memberships
     WHERE organization_id = $1 AND role = 'owner' AND disabled_at IS NULL`,
    [organizationId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function changeMemberRole(
  pool: Pool,
  actor: SessionContext,
  targetUserId: string,
  role: Role,
): Promise<MembershipChangeResult> {
  if (!authorize(actor, 'member.manage') || !actor.organization || !actor.membership) {
    return { ok: false, status: 403, code: 'forbidden' };
  }
  if (role === 'owner' && !authorize(actor, 'member.grant_owner')) {
    return { ok: false, status: 403, code: 'owner_grant_forbidden' };
  }
  const target = await pool.query<{ role: Role; disabled_at: Date | null }>(
    `SELECT role, disabled_at FROM memberships WHERE organization_id = $1 AND user_id = $2`,
    [actor.organization.organization_id, targetUserId],
  );
  const membership = target.rows[0];
  if (!membership) return { ok: false, status: 404, code: 'member_not_found' };
  if (
    membership.role === 'owner' &&
    role !== 'owner' &&
    (await activeOwnerCount(pool, actor.organization.organization_id)) <= 1
  ) {
    return { ok: false, status: 409, code: 'last_owner' };
  }
  await pool.query(
    `UPDATE memberships SET role = $3, updated_at = now()
     WHERE organization_id = $1 AND user_id = $2`,
    [actor.organization.organization_id, targetUserId, role],
  );
  // Privilege changes take effect immediately and rotate all affected sessions.
  await pool.query(
    `UPDATE browser_sessions SET revoked_at = COALESCE(revoked_at, now()),
                                 revocation_reason = 'membership_role_changed'
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [targetUserId],
  );
  return { ok: true };
}

export async function disableMember(
  pool: Pool,
  actor: SessionContext,
  targetUserId: string,
): Promise<MembershipChangeResult> {
  if (!authorize(actor, 'member.manage') || !actor.organization) {
    return { ok: false, status: 403, code: 'forbidden' };
  }
  const target = await pool.query<{ role: Role; disabled_at: Date | null }>(
    `SELECT role, disabled_at FROM memberships WHERE organization_id = $1 AND user_id = $2`,
    [actor.organization.organization_id, targetUserId],
  );
  const membership = target.rows[0];
  if (!membership) return { ok: false, status: 404, code: 'member_not_found' };
  if (
    membership.role === 'owner' &&
    membership.disabled_at === null &&
    (await activeOwnerCount(pool, actor.organization.organization_id)) <= 1
  ) {
    return { ok: false, status: 409, code: 'last_owner' };
  }
  await pool.query(
    `UPDATE memberships SET disabled_at = COALESCE(disabled_at, now()), updated_at = now()
     WHERE organization_id = $1 AND user_id = $2`,
    [actor.organization.organization_id, targetUserId],
  );
  await pool.query(
    `UPDATE browser_sessions SET revoked_at = COALESCE(revoked_at, now()),
                                 revocation_reason = 'membership_disabled'
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [targetUserId],
  );
  return { ok: true };
}
