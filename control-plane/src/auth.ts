/** Product authentication, PostgreSQL sessions, and login throttling. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import argon2 from 'argon2';

import type { Config } from './config.js';
import { type Pool, type PoolClient, withTransaction } from './db.js';
import { permissionsFor, type Permission, roleAllows, type Role } from './tenancy.js';

export const SESSION_COOKIE = 'asterism_session';
export const CSRF_COOKIE = 'asterism_csrf';
export const MINIMUM_PASSWORD_LENGTH = 12;

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
} as const;

export interface UserRecord {
  user_id: string;
  normalized_email: string;
  display_name: string;
  password_hash: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
}

export interface OrganizationRecord {
  organization_id: string;
  slug: string;
  display_name: string;
  enabled: boolean;
  created_at: Date;
}

export interface MembershipRecord {
  organization_id: string;
  user_id: string;
  role: Role;
  created_at: Date;
  updated_at: Date;
  disabled_at: Date | null;
}

interface SessionRecord {
  session_id: string;
  user_id: string;
  token_digest: string;
  csrf_digest: string;
  active_organization_id: string | null;
  created_at: Date;
  last_used_at: Date;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
  revocation_reason: string | null;
  source_address: string | null;
  user_agent: string | null;
}

export interface SessionContext {
  session: SessionRecord;
  user: UserRecord;
  organization: OrganizationRecord | null;
  membership: MembershipRecord | null;
  permissions: Permission[];
}

export interface SessionCredentials {
  token: string;
  csrfToken: string;
  context: SessionContext;
}

export function normalizeEmail(email: string): string {
  return email.trim().normalize('NFKC').toLowerCase();
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    throw new Error(`password must be at least ${MINIMUM_PASSWORD_LENGTH} characters`);
  }
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function passwordMatches(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export async function bootstrapStatus(pool: Pool): Promise<{ required: boolean }> {
  const result = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');
  return { required: Number(result.rows[0]?.count ?? 0) === 0 };
}

export async function createInitialOwner(
  pool: Pool,
  input: { email: string; displayName: string; password: string },
): Promise<{ userId: string; organizationId: string }> {
  const normalizedEmail = normalizeEmail(input.email);
  if (!normalizedEmail || normalizedEmail.length > 320)
    throw new Error('a valid email is required');
  if (!input.displayName.trim() || input.displayName.length > 128) {
    throw new Error('display name must be between 1 and 128 characters');
  }
  const passwordHash = await hashPassword(input.password);

  return withTransaction(pool, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('asterism-bootstrap-owner'))`);
    const locked = await client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM users',
    );
    if (Number(locked.rows[0]?.count ?? 0) !== 0) {
      throw new Error('bootstrap owner already exists');
    }
    const organization = await client.query<OrganizationRecord>(
      `SELECT * FROM organizations WHERE organization_id = 'org_bootstrap'`,
    );
    if (!organization.rows[0]) throw new Error('bootstrap organization is missing');
    const userId = randomUUID();
    await client.query(
      `INSERT INTO users (user_id, normalized_email, display_name, password_hash)
       VALUES ($1, $2, $3, $4)`,
      [userId, normalizedEmail, input.displayName.trim(), passwordHash],
    );
    await client.query(
      `INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [organization.rows[0].organization_id, userId],
    );
    await client.query(
      `INSERT INTO audit_log (action, actor, actor_user_id, target_type, target_id, result,
                              organization_id, detail)
       VALUES ('bootstrap.owner.create', 'bootstrap', $1, 'user', $1, 'success', $2, '{}'::jsonb)`,
      [userId, organization.rows[0].organization_id],
    );
    return { userId, organizationId: organization.rows[0].organization_id };
  });
}

async function recordAttempt(
  db: Pool | PoolClient,
  accountDigest: string,
  sourceDigest: string,
  succeeded: boolean,
): Promise<void> {
  await db.query(
    `INSERT INTO login_attempts (account_digest, source_digest, succeeded) VALUES ($1, $2, $3)`,
    [accountDigest, sourceDigest, succeeded],
  );
}

export async function authenticatePassword(
  pool: Pool,
  config: Config,
  input: { email: string; password: string; sourceAddress: string },
): Promise<UserRecord | null> {
  const email = normalizeEmail(input.email);
  const accountDigest = digest(email);
  const sourceDigest = digest(input.sourceAddress || 'unknown');
  const counts = await pool.query<{ account_count: string; source_count: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE account_digest = $1)::text AS account_count,
       COUNT(*) FILTER (WHERE source_digest = $2)::text AS source_count
     FROM login_attempts
     WHERE attempted_at > now() - ($3::bigint || ' milliseconds')::interval
       AND succeeded = FALSE`,
    [accountDigest, sourceDigest, String(config.loginWindowMs)],
  );
  const blocked =
    Number(counts.rows[0]?.account_count ?? 0) >= config.loginAccountLimit ||
    Number(counts.rows[0]?.source_count ?? 0) >= config.loginSourceLimit;
  if (blocked) {
    await recordAttempt(pool, accountDigest, sourceDigest, false);
    return null;
  }

  const result = await pool.query<UserRecord>('SELECT * FROM users WHERE normalized_email = $1', [
    email,
  ]);
  const user = result.rows[0];
  const valid =
    Boolean(user?.enabled) && (await passwordMatches(user?.password_hash ?? '', input.password));
  await recordAttempt(pool, accountDigest, sourceDigest, valid);
  if (!valid || !user) return null;
  await pool.query('UPDATE users SET last_login_at = now() WHERE user_id = $1', [user.user_id]);
  return user;
}

async function membershipsForUser(
  db: Pool | PoolClient,
  userId: string,
): Promise<(MembershipRecord & OrganizationRecord)[]> {
  const result = await db.query<MembershipRecord & OrganizationRecord>(
    `SELECT m.*, o.slug, o.display_name, o.enabled, o.created_at
     FROM memberships m
     JOIN organizations o ON o.organization_id = m.organization_id
     WHERE m.user_id = $1 AND m.disabled_at IS NULL AND o.enabled = TRUE
     ORDER BY o.display_name, o.organization_id`,
    [userId],
  );
  return result.rows;
}

export async function createSession(
  pool: Pool,
  config: Config,
  input: {
    user: UserRecord;
    sourceAddress: string | null;
    userAgent: string | null;
    activeOrganizationId?: string | null;
  },
): Promise<SessionCredentials> {
  const token = randomToken();
  const csrfToken = randomToken();
  const memberships = await membershipsForUser(pool, input.user.user_id);
  const requestedOrganization = input.activeOrganizationId;
  const activeOrganizationId =
    requestedOrganization !== undefined
      ? memberships.some((item) => item.organization_id === requestedOrganization)
        ? requestedOrganization
        : null
      : memberships.length === 1
        ? (memberships[0]?.organization_id ?? null)
        : null;
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO browser_sessions
       (session_id, user_id, token_digest, csrf_digest, active_organization_id,
        idle_expires_at, absolute_expires_at, source_address, user_agent)
     VALUES ($1, $2, $3, $4, $5,
             now() + ($6::bigint || ' milliseconds')::interval,
             now() + ($7::bigint || ' milliseconds')::interval, $8, $9)`,
    [
      sessionId,
      input.user.user_id,
      digest(token),
      digest(csrfToken),
      activeOrganizationId,
      String(config.sessionIdleTimeoutMs),
      String(config.sessionAbsoluteTimeoutMs),
      input.sourceAddress?.slice(0, 128) ?? null,
      input.userAgent?.slice(0, 512) ?? null,
    ],
  );
  const context = await resolveSession(pool, config, token);
  if (!context) throw new Error('new browser session could not be resolved');
  return { token, csrfToken, context };
}

export async function resolveSession(
  pool: Pool,
  config: Config,
  token: string | undefined,
): Promise<SessionContext | null> {
  if (!token) return null;
  const result = await pool.query<SessionRecord & UserRecord>(
    `SELECT s.*, u.normalized_email, u.display_name, u.password_hash, u.enabled,
            u.updated_at, u.last_login_at
     FROM browser_sessions s
     JOIN users u ON u.user_id = s.user_id
     WHERE s.token_digest = $1 AND s.revoked_at IS NULL`,
    [digest(token)],
  );
  const row = result.rows[0];
  if (!row) return null;
  const expired =
    !row.enabled ||
    row.idle_expires_at.getTime() <= Date.now() ||
    row.absolute_expires_at.getTime() <= Date.now();
  if (expired) {
    await pool.query(
      `UPDATE browser_sessions SET revoked_at = COALESCE(revoked_at, now()),
                                   revocation_reason = COALESCE(revocation_reason, 'expired_or_disabled')
       WHERE session_id = $1`,
      [row.session_id],
    );
    return null;
  }
  await pool.query(
    `UPDATE browser_sessions SET last_used_at = now(),
       idle_expires_at = LEAST(absolute_expires_at,
         now() + ($2::bigint || ' milliseconds')::interval)
     WHERE session_id = $1`,
    [row.session_id, String(config.sessionIdleTimeoutMs)],
  );

  let organization: OrganizationRecord | null = null;
  let membership: MembershipRecord | null = null;
  if (row.active_organization_id) {
    const active = await pool.query<MembershipRecord & OrganizationRecord>(
      `SELECT m.*, o.slug, o.display_name, o.enabled, o.created_at
       FROM memberships m JOIN organizations o USING (organization_id)
       WHERE m.user_id = $1 AND m.organization_id = $2
         AND m.disabled_at IS NULL AND o.enabled = TRUE`,
      [row.user_id, row.active_organization_id],
    );
    const activeRow = active.rows[0];
    if (activeRow) {
      organization = activeRow;
      membership = activeRow;
    }
  }
  return {
    session: row,
    user: row,
    organization,
    membership,
    permissions: membership ? permissionsFor(membership.role) : [],
  };
}

export function csrfMatches(context: SessionContext, provided: string | undefined): boolean {
  if (!provided) return false;
  const actual = Buffer.from(context.session.csrf_digest, 'hex');
  const candidate = Buffer.from(digest(provided), 'hex');
  return actual.length === candidate.length && timingSafeEqual(actual, candidate);
}

export async function rotateCsrf(pool: Pool, sessionId: string): Promise<string> {
  const token = randomToken();
  const result = await pool.query(
    `UPDATE browser_sessions SET csrf_digest = $2 WHERE session_id = $1 AND revoked_at IS NULL`,
    [sessionId, digest(token)],
  );
  if ((result.rowCount ?? 0) !== 1) throw new Error('session is no longer active');
  return token;
}

export function authorize(context: SessionContext, permission: Permission): boolean {
  return Boolean(
    context.organization &&
      context.membership &&
      context.user.enabled &&
      context.organization.enabled &&
      roleAllows(context.membership.role, permission),
  );
}

export async function revokeSession(pool: Pool, sessionId: string, reason: string): Promise<void> {
  await pool.query(
    `UPDATE browser_sessions SET revoked_at = COALESCE(revoked_at, now()), revocation_reason = $2
     WHERE session_id = $1`,
    [sessionId, reason],
  );
}

export async function revokeAllSessions(pool: Pool, userId: string, reason: string): Promise<void> {
  await pool.query(
    `UPDATE browser_sessions SET revoked_at = COALESCE(revoked_at, now()), revocation_reason = $2
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason],
  );
}

export async function changePassword(
  pool: Pool,
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<UserRecord | null> {
  const result = await pool.query<UserRecord>('SELECT * FROM users WHERE user_id = $1', [userId]);
  const user = result.rows[0];
  if (!user || !(await passwordMatches(user.password_hash, currentPassword))) return null;
  const passwordHash = await hashPassword(newPassword);
  await withTransaction(pool, async (client) => {
    await client.query(
      'UPDATE users SET password_hash = $2, updated_at = now() WHERE user_id = $1',
      [userId, passwordHash],
    );
    await client.query(
      `UPDATE browser_sessions SET revoked_at = COALESCE(revoked_at, now()),
                                   revocation_reason = 'password_changed'
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
  });
  return { ...user, password_hash: passwordHash, updated_at: new Date() };
}

export async function selectOrganization(
  pool: Pool,
  sessionId: string,
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE browser_sessions s SET active_organization_id = $3
     FROM memberships m, organizations o
     WHERE s.session_id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL
       AND m.user_id = s.user_id AND m.organization_id = $3 AND m.disabled_at IS NULL
       AND o.organization_id = m.organization_id AND o.enabled = TRUE`,
    [sessionId, userId, organizationId],
  );
  return (result.rowCount ?? 0) === 1;
}

export { membershipsForUser };
