/**
 * Local operator administration primitives.
 *
 * These exist for one situation: an operator can no longer sign in to a
 * Control Plane they own, and there is no password-reset flow to help them.
 * Asterism deliberately ships no email delivery and no public "forgot
 * password" endpoint, so recovery has to happen where the deployment already
 * trusts the person completely — on the host, next to the database.
 *
 * Everything here is therefore reachable only from the CLI in `cli/operator.ts`.
 * There is no HTTP route and no remote protocol command: possession of the
 * server is the authentication, exactly as it is for `admin-create`.
 *
 * The module exposes domain primitives and lets the CLI compose them, so both
 * halves stay testable — the CLI against a real database, these against direct
 * calls. Passwords arrive here already read from a hidden prompt or an explicit
 * stdin pipe; they are hashed with the production hasher and never logged,
 * returned, or written to the audit trail.
 */
import { randomUUID } from 'node:crypto';

import {
  hashPassword,
  MINIMUM_PASSWORD_LENGTH,
  normalizeEmail,
  type OrganizationRecord,
  type UserRecord,
} from './auth.js';
import { type Pool, type PoolClient, withTransaction } from './db.js';
import { BOOTSTRAP_ORGANIZATION_ID, type Role } from './tenancy.js';

/** The audit actor for every operation in this module. */
export const LOCAL_RECOVERY_ACTOR = 'local-recovery';

export const OPERATOR_ROLES: readonly Role[] = ['owner', 'admin', 'developer', 'viewer'];

/**
 * The least privilege that can still open a project chat and send a turn:
 * `project.read`, `run.read`, `run.create`, `run.manage_own`.
 */
export const LEAST_CHAT_ROLE: Role = 'developer';

export type OperatorErrorCode =
  | 'unknown_operator'
  | 'unknown_organization'
  | 'unknown_project'
  | 'duplicate_operator'
  | 'invalid_role'
  | 'invalid_email'
  | 'invalid_display_name'
  | 'weak_password'
  | 'ambiguous_organization';

/** A refusal the CLI can render without guessing at the cause. */
export class OperatorAdminError extends Error {
  readonly code: OperatorErrorCode;

  constructor(code: OperatorErrorCode, message: string) {
    super(message);
    this.name = 'OperatorAdminError';
    this.code = code;
  }
}

export interface OperatorSummary {
  userId: string;
  email: string;
  displayName: string;
  enabled: boolean;
  organizationId: string;
  role?: Role;
  sessionsRevoked?: number;
  projectId?: string;
}

function requireEmail(email: string): string {
  const normalized = normalizeEmail(email);
  if (!normalized || normalized.length > 320 || !normalized.includes('@')) {
    throw new OperatorAdminError('invalid_email', 'a valid email address is required');
  }
  return normalized;
}

function requireDisplayName(displayName: string): string {
  const trimmed = displayName.trim();
  if (!trimmed || trimmed.length > 128) {
    throw new OperatorAdminError(
      'invalid_display_name',
      'display name must be between 1 and 128 characters',
    );
  }
  return trimmed;
}

export function requireRole(role: string): Role {
  if (!OPERATOR_ROLES.includes(role as Role)) {
    throw new OperatorAdminError(
      'invalid_role',
      `role must be one of ${OPERATOR_ROLES.join(', ')}`,
    );
  }
  return role as Role;
}

/**
 * Hash with the production hasher and validation rules.
 *
 * `hashPassword` enforces the same minimum length the product enforces
 * everywhere else; a recovery path that accepted weaker passwords would be a
 * quieter version of the vulnerability it exists to fix.
 */
async function hashOrRefuse(password: string): Promise<string> {
  try {
    return await hashPassword(password);
  } catch {
    throw new OperatorAdminError(
      'weak_password',
      `password must be at least ${MINIMUM_PASSWORD_LENGTH} characters`,
    );
  }
}

/** Resolve an organization by primary key or by slug. */
export async function resolveOrganization(
  db: Pool | PoolClient,
  reference: string,
): Promise<OrganizationRecord> {
  const trimmed = reference.trim();
  if (!trimmed) {
    throw new OperatorAdminError('unknown_organization', 'an organization is required');
  }
  const result = await db.query<OrganizationRecord>(
    'SELECT * FROM organizations WHERE organization_id = $1 OR slug = $1',
    [trimmed],
  );
  const organization = result.rows[0];
  if (!organization) {
    throw new OperatorAdminError('unknown_organization', `no organization matches ${trimmed}`);
  }
  return organization;
}

/**
 * Confirm a project exists inside an organization.
 *
 * Access is granted by organization membership — projects have no membership
 * table of their own — so this is a verification step, not a grant. It turns
 * "the operator I made cannot see the project" into a refusal at creation time.
 */
export async function requireProject(
  db: Pool | PoolClient,
  organizationId: string,
  projectId: string,
): Promise<string> {
  const result = await db.query<{ project_id: string }>(
    'SELECT project_id FROM projects WHERE organization_id = $1 AND project_id = $2',
    [organizationId, projectId],
  );
  const project = result.rows[0];
  if (!project) {
    throw new OperatorAdminError(
      'unknown_project',
      `no project ${projectId} in organization ${organizationId}`,
    );
  }
  return project.project_id;
}

export async function findOperator(
  db: Pool | PoolClient,
  email: string,
): Promise<UserRecord | null> {
  const result = await db.query<UserRecord>('SELECT * FROM users WHERE normalized_email = $1', [
    requireEmail(email),
  ]);
  return result.rows[0] ?? null;
}

async function requireOperator(db: Pool | PoolClient, email: string): Promise<UserRecord> {
  const user = await findOperator(db, email);
  if (!user) {
    throw new OperatorAdminError(
      'unknown_operator',
      `no operator matches ${normalizeEmail(email)}`,
    );
  }
  return user;
}

/**
 * The organization an audit row is filed under for an existing operator.
 *
 * `audit_log.organization_id` is not nullable, and an operator may belong to
 * several organizations. One membership is unambiguous; several require the
 * caller to say which, rather than having this pick one silently.
 */
async function auditOrganizationFor(
  client: PoolClient,
  userId: string,
  requested: string | undefined,
): Promise<string> {
  const result = await client.query<{ organization_id: string }>(
    `SELECT organization_id FROM memberships
     WHERE user_id = $1 AND disabled_at IS NULL
     ORDER BY created_at, organization_id`,
    [userId],
  );
  const organizations = result.rows.map((row) => row.organization_id);
  if (requested) {
    if (organizations.length > 0 && !organizations.includes(requested)) {
      throw new OperatorAdminError(
        'unknown_organization',
        `operator is not a member of ${requested}`,
      );
    }
    return requested;
  }
  if (organizations.length > 1) {
    throw new OperatorAdminError(
      'ambiguous_organization',
      'operator belongs to several organizations; pass --organization',
    );
  }
  return organizations[0] ?? BOOTSTRAP_ORGANIZATION_ID;
}

/** Append one audit row. `detail` must never carry a password, hash, or token. */
async function recordAudit(
  client: PoolClient,
  input: {
    action: string;
    userId: string;
    organizationId: string;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log
       (action, actor, actor_user_id, target_type, target_id, result, organization_id, detail)
     VALUES ($1, $2, NULL, 'user', $3, 'success', $4, $5::jsonb)`,
    [
      input.action,
      LOCAL_RECOVERY_ACTOR,
      input.userId,
      input.organizationId,
      JSON.stringify(input.detail),
    ],
  );
}

async function revokeSessionsWithin(
  client: PoolClient,
  userId: string,
  reason: string,
): Promise<number> {
  const result = await client.query(
    `UPDATE browser_sessions SET revoked_at = COALESCE(revoked_at, now()), revocation_reason = $2
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason],
  );
  return result.rowCount ?? 0;
}

export async function createOperator(
  pool: Pool,
  input: {
    email: string;
    displayName: string;
    password: string;
    organization: string;
    role: Role;
    projectId?: string;
  },
): Promise<OperatorSummary> {
  const email = requireEmail(input.email);
  const displayName = requireDisplayName(input.displayName);
  const role = requireRole(input.role);
  const passwordHash = await hashOrRefuse(input.password);

  return withTransaction(pool, async (client) => {
    const organization = await resolveOrganization(client, input.organization);
    const projectId = input.projectId
      ? await requireProject(client, organization.organization_id, input.projectId)
      : undefined;

    const existing = await client.query<{ user_id: string }>(
      'SELECT user_id FROM users WHERE normalized_email = $1',
      [email],
    );
    if (existing.rows[0]) {
      throw new OperatorAdminError('duplicate_operator', `an operator already uses ${email}`);
    }

    const userId = randomUUID();
    await client.query(
      `INSERT INTO users (user_id, normalized_email, display_name, password_hash)
       VALUES ($1, $2, $3, $4)`,
      [userId, email, displayName, passwordHash],
    );
    await client.query(
      `INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)`,
      [organization.organization_id, userId, role],
    );
    await recordAudit(client, {
      action: 'operator.create',
      userId,
      organizationId: organization.organization_id,
      detail: { role, email, ...(projectId ? { project_id: projectId } : {}) },
    });
    return {
      userId,
      email,
      displayName,
      enabled: true,
      organizationId: organization.organization_id,
      role,
      ...(projectId ? { projectId } : {}),
    };
  });
}

/**
 * Replace an operator's password.
 *
 * Sessions are revoked by default. A password is normally reset because the old
 * one is untrusted, and a live cookie would outlive the reset; `keepSessions`
 * exists for the rarer case of an operator rotating their own credential.
 */
export async function setOperatorPassword(
  pool: Pool,
  input: {
    email: string;
    password: string;
    keepSessions?: boolean;
    organization?: string;
  },
): Promise<OperatorSummary> {
  const passwordHash = await hashOrRefuse(input.password);

  return withTransaction(pool, async (client) => {
    const user = await requireOperator(client, input.email);
    const organizationId = await auditOrganizationFor(client, user.user_id, input.organization);
    await client.query(
      'UPDATE users SET password_hash = $2, updated_at = now() WHERE user_id = $1',
      [user.user_id, passwordHash],
    );
    const sessionsRevoked = input.keepSessions
      ? 0
      : await revokeSessionsWithin(client, user.user_id, 'local_recovery_password_reset');
    await recordAudit(client, {
      action: 'operator.set_password',
      userId: user.user_id,
      organizationId,
      detail: {
        email: user.normalized_email,
        sessions_revoked: sessionsRevoked,
        sessions_kept: Boolean(input.keepSessions),
      },
    });
    return {
      userId: user.user_id,
      email: user.normalized_email,
      displayName: user.display_name,
      enabled: user.enabled,
      organizationId,
      sessionsRevoked,
    };
  });
}

/**
 * Enable or disable an operator.
 *
 * Disabling also revokes live sessions. `resolveSession` already refuses a
 * disabled user on the next request, so this is belt and braces — but it makes
 * the revocation explicit in the audit trail instead of implicit in a check.
 */
export async function setOperatorEnabled(
  pool: Pool,
  input: { email: string; enabled: boolean; organization?: string },
): Promise<OperatorSummary> {
  return withTransaction(pool, async (client) => {
    const user = await requireOperator(client, input.email);
    const organizationId = await auditOrganizationFor(client, user.user_id, input.organization);
    await client.query('UPDATE users SET enabled = $2, updated_at = now() WHERE user_id = $1', [
      user.user_id,
      input.enabled,
    ]);
    const sessionsRevoked = input.enabled
      ? 0
      : await revokeSessionsWithin(client, user.user_id, 'local_recovery_disabled');
    await recordAudit(client, {
      action: input.enabled ? 'operator.enable' : 'operator.disable',
      userId: user.user_id,
      organizationId,
      detail: { email: user.normalized_email, sessions_revoked: sessionsRevoked },
    });
    return {
      userId: user.user_id,
      email: user.normalized_email,
      displayName: user.display_name,
      enabled: input.enabled,
      organizationId,
      sessionsRevoked,
    };
  });
}

export async function revokeOperatorSessions(
  pool: Pool,
  input: { email: string; organization?: string },
): Promise<OperatorSummary> {
  return withTransaction(pool, async (client) => {
    const user = await requireOperator(client, input.email);
    const organizationId = await auditOrganizationFor(client, user.user_id, input.organization);
    const sessionsRevoked = await revokeSessionsWithin(
      client,
      user.user_id,
      'local_recovery_revoked',
    );
    await recordAudit(client, {
      action: 'operator.revoke_sessions',
      userId: user.user_id,
      organizationId,
      detail: { email: user.normalized_email, sessions_revoked: sessionsRevoked },
    });
    return {
      userId: user.user_id,
      email: user.normalized_email,
      displayName: user.display_name,
      enabled: user.enabled,
      organizationId,
      sessionsRevoked,
    };
  });
}
