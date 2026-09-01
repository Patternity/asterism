/** Browser-facing product API foundation. Node protocol routes remain separate. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  authenticatePassword,
  bootstrapStatus,
  changePassword,
  CSRF_COOKIE,
  createSession,
  csrfMatches,
  membershipsForUser,
  resolveSession,
  revokeAllSessions,
  revokeSession,
  rotateCsrf,
  SESSION_COOKIE,
  selectOrganization,
  type SessionContext,
} from './auth.js';
import {
  ATTACHMENTS_UNSUPPORTED,
  attachmentsOf,
  INVALID_ATTACHMENT,
  MAX_ATTACHMENTS,
  validateAttachments,
} from './attachments.js';
import { nodeCapabilityView } from './node-capabilities.js';
import multipart from '@fastify/multipart';
import { attachmentsRepo, browserAttachment } from './attachment-repository.js';
import {
  MAX_DIMENSION,
  MAX_PIXELS,
  MAX_REQUEST_BYTES,
  MAX_UPLOAD_BYTES,
  SUPPORTED_MEDIA_TYPES,
} from './image-intake.js';
import {
  attachmentCapabilityUrl,
  MEDIA_ROUTE_PREFIX,
  verifyAttachmentSignature,
} from './media-capability.js';
import { createMediaStorage } from './media-storage.js';
import {
  intakeErrorResponse,
  linkUploads,
  persistUploadedImages,
  readMultipartRunRequest,
  type StoredUpload,
} from './run-uploads.js';
import {
  APPROVAL_CHOICES,
  RUN_APPROVAL_POLICIES,
  PERSISTENT_APPROVAL_MESSAGE,
  PERSISTENT_APPROVAL_NOT_SUPPORTED,
  isPersistentApprovalRequest,
} from './approval-choices.js';
import { changeMemberRole, disableMember } from './authorization.js';
import type { Config } from './config.js';
import { type Pool, withTransaction } from './db.js';
import { acceptInvitation, createInvitation } from './invitations.js';
import { NodeChannel, TERMINAL_RUN_STATUSES } from './node-channel.js';
import {
  productEventsRepo,
  runPolicyRepo,
  productNodesRepo,
  productProjectsRepo,
  productRotationsRepo,
  productRunsRepo,
} from './product-repositories.js';
import { randomUUID } from 'node:crypto';

import { assertDispatchable, commandFingerprint } from './protocol.js';
import {
  PROVISION_COMMAND,
  PROVISION_COMMAND_VERSION,
  canCreateRuns,
  isRetryable,
  validateBranch,
  validateName,
  validateRepositoryUrl,
  validateSlug,
} from './project-provisioning.js';
import {
  auditRepo,
  commandsRepo,
  enrollmentTokensRepo,
  nodesRepo,
  runsRepo,
  type ProjectRecord,
} from './repositories.js';
import { authorize } from './auth.js';
import type { Permission } from './tenancy.js';
import { type InstallationRecord, nodeInstallationsRepo } from './node-installation-repository.js';
import { isTerminal } from './node-installations.js';

interface ProductApiDependencies {
  pool: Pool;
  config: Config;
  channel: NodeChannel;
}

const LoginSchema = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(4096),
});

const PasswordChangeSchema = z.object({
  current_password: z.string().min(1).max(4096),
  new_password: z.string().min(12).max(4096),
});

const SelectOrganizationSchema = z.object({
  organization_id: z.string().uuid().or(z.literal('org_bootstrap')),
});

function cookieOptions(config: Config) {
  return {
    path: '/',
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'lax' as const,
    maxAge: Math.floor(config.sessionAbsoluteTimeoutMs / 1000),
  };
}

function csrfCookieOptions(config: Config) {
  return {
    path: '/',
    httpOnly: false,
    secure: config.nodeEnv === 'production',
    sameSite: 'lax' as const,
    maxAge: Math.floor(config.sessionAbsoluteTimeoutMs / 1000),
  };
}

function setBrowserCredentials(
  reply: FastifyReply,
  config: Config,
  token: string,
  csrfToken: string,
): void {
  reply.setCookie(SESSION_COOKIE, token, cookieOptions(config));
  reply.setCookie(CSRF_COOKIE, csrfToken, csrfCookieOptions(config));
}

function sourceAddress(request: FastifyRequest, config: Config): string {
  if (!config.trustProxy) return request.ip;
  const forwarded = request.headers['x-forwarded-for'];
  return typeof forwarded === 'string'
    ? (forwarded.split(',')[0]?.trim() ?? request.ip)
    : request.ip;
}

function renderContext(context: SessionContext) {
  return {
    user: {
      user_id: context.user.user_id,
      email: context.user.normalized_email,
      display_name: context.user.display_name,
    },
    active_organization: context.organization
      ? {
          organization_id: context.organization.organization_id,
          slug: context.organization.slug,
          display_name: context.organization.display_name,
          role: context.membership?.role,
        }
      : null,
    permissions: context.permissions,
    session: {
      created_at: context.session.created_at,
      idle_expires_at: context.session.idle_expires_at,
      absolute_expires_at: context.session.absolute_expires_at,
    },
  };
}

export async function registerProductApi(
  app: FastifyInstance,
  deps: ProductApiDependencies,
): Promise<void> {
  const { pool, config, channel } = deps;

  // One storage backend for the process. A deployment without UPLOAD_DIR gets
  // the disabled implementation, which refuses rather than pretending.
  const storage = createMediaStorage(config.uploadDir);
  const uploadsConfigured = Boolean(config.uploadDir);

  // Registered unconditionally so a JSON-only deployment still answers a
  // multipart request with a typed refusal instead of a parser error.
  await app.register(multipart, {
    limits: {
      fileSize: MAX_UPLOAD_BYTES,
      files: MAX_ATTACHMENTS,
      fields: 16,
      fieldSize: 512 * 1024,
    },
  });

  const contextFor = async (request: FastifyRequest): Promise<SessionContext | null> =>
    resolveSession(pool, config, request.cookies[SESSION_COOKIE]);

  const requireSession = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<SessionContext | null> => {
    const context = await contextFor(request);
    if (!context) {
      await reply.code(401).send({ error: 'unauthenticated', message: 'authentication required' });
      return null;
    }
    return context;
  };

  const requireCsrf = async (
    request: FastifyRequest,
    reply: FastifyReply,
    context: SessionContext,
  ): Promise<boolean> => {
    const provided = request.headers['x-csrf-token'];
    if (typeof provided !== 'string' || !csrfMatches(context, provided)) {
      await reply.code(403).send({ error: 'csrf_failed', message: 'valid CSRF token required' });
      return false;
    }
    return true;
  };

  const requirePermission = async (
    request: FastifyRequest,
    reply: FastifyReply,
    permission: Permission,
    csrf = false,
  ): Promise<SessionContext | null> => {
    const context = await requireSession(request, reply);
    if (!context) return null;
    if (!context.organization || !context.membership) {
      await reply.code(409).send({
        error: 'organization_required',
        message: 'select an active organization',
      });
      return null;
    }
    if (!authorize(context, permission)) {
      await reply.code(403).send({ error: 'forbidden', message: 'permission denied' });
      return null;
    }
    if (csrf && !(await requireCsrf(request, reply, context))) return null;
    return context;
  };

  app.get('/api/v1/auth/bootstrap-status', async () => bootstrapStatus(pool));

  app.post('/api/v1/auth/login', async (request, reply) => {
    const parsed = LoginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', message: 'invalid login request' });
    }
    const user = await authenticatePassword(pool, config, {
      email: parsed.data.email,
      password: parsed.data.password,
      sourceAddress: sourceAddress(request, config),
    });
    if (!user) {
      return reply.code(401).send({ error: 'login_failed', message: 'invalid email or password' });
    }
    const existing = await contextFor(request);
    if (existing) await revokeSession(pool, existing.session.session_id, 'login_rotated');
    const created = await createSession(pool, config, {
      user,
      sourceAddress: sourceAddress(request, config),
      userAgent: request.headers['user-agent'] ?? null,
    });
    setBrowserCredentials(reply, config, created.token, created.csrfToken);
    return reply.send({ ...renderContext(created.context), csrf_token: created.csrfToken });
  });

  app.get('/api/v1/auth/session', async (request, reply) => {
    const context = await requireSession(request, reply);
    if (!context) return reply;
    return renderContext(context);
  });

  // Deliberately not behind `requireCsrf`. This is the only way back for a
  // session whose CSRF cookie was lost, and gating the cure behind the disease
  // left such a session readable but unwritable for its full lifetime — unable
  // even to log out, because that is a POST too.
  //
  // Safe to leave open: the session cookie is SameSite=lax, so another site
  // cannot make the browser send it on a POST, and CORS keeps the minted token
  // out of a cross-origin reader. Anyone able to reach this endpoint with a
  // live session can already issue writes directly.
  app.post('/api/v1/auth/csrf', async (request, reply) => {
    const context = await requireSession(request, reply);
    if (!context) return reply;
    const csrfToken = await rotateCsrf(pool, context.session.session_id);
    reply.setCookie(CSRF_COOKIE, csrfToken, csrfCookieOptions(config));
    return { csrf_token: csrfToken };
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const context = await requireSession(request, reply);
    if (!context) return reply;
    if (!(await requireCsrf(request, reply, context))) return reply;
    await revokeSession(pool, context.session.session_id, 'logout');
    reply.clearCookie(SESSION_COOKIE, cookieOptions(config));
    reply.clearCookie(CSRF_COOKIE, csrfCookieOptions(config));
    return { logged_out: true };
  });

  app.post('/api/v1/auth/logout-all', async (request, reply) => {
    const context = await requireSession(request, reply);
    if (!context) return reply;
    if (!(await requireCsrf(request, reply, context))) return reply;
    await revokeAllSessions(pool, context.user.user_id, 'logout_all');
    reply.clearCookie(SESSION_COOKIE, cookieOptions(config));
    reply.clearCookie(CSRF_COOKIE, csrfCookieOptions(config));
    return { logged_out: true };
  });

  app.post('/api/v1/auth/password', async (request, reply) => {
    const context = await requireSession(request, reply);
    if (!context) return reply;
    if (!(await requireCsrf(request, reply, context))) return reply;
    const parsed = PasswordChangeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', message: 'invalid password change' });
    }
    const user = await changePassword(
      pool,
      context.user.user_id,
      parsed.data.current_password,
      parsed.data.new_password,
    );
    if (!user) {
      return reply
        .code(401)
        .send({ error: 'password_change_failed', message: 'password change failed' });
    }
    const created = await createSession(pool, config, {
      user,
      sourceAddress: sourceAddress(request, config),
      userAgent: request.headers['user-agent'] ?? null,
      activeOrganizationId: context.organization?.organization_id ?? null,
    });
    setBrowserCredentials(reply, config, created.token, created.csrfToken);
    return reply.send({ changed: true, csrf_token: created.csrfToken });
  });

  app.get('/api/v1/organizations', async (request, reply) => {
    const context = await requireSession(request, reply);
    if (!context) return reply;
    const memberships = await membershipsForUser(pool, context.user.user_id);
    return {
      organizations: memberships.map((item) => ({
        organization_id: item.organization_id,
        slug: item.slug,
        display_name: item.display_name,
        role: item.role,
      })),
    };
  });

  app.post('/api/v1/organizations/select', async (request, reply) => {
    const context = await requireSession(request, reply);
    if (!context) return reply;
    if (!(await requireCsrf(request, reply, context))) return reply;
    const parsed = SelectOrganizationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const selected = await selectOrganization(
      pool,
      context.session.session_id,
      context.user.user_id,
      parsed.data.organization_id,
    );
    if (!selected) return reply.code(404).send({ error: 'organization_not_found' });
    await revokeSession(pool, context.session.session_id, 'organization_changed');
    const created = await createSession(pool, config, {
      user: context.user,
      sourceAddress: sourceAddress(request, config),
      userAgent: request.headers['user-agent'] ?? null,
      activeOrganizationId: parsed.data.organization_id,
    });
    setBrowserCredentials(reply, config, created.token, created.csrfToken);
    return reply.send({ ...renderContext(created.context), csrf_token: created.csrfToken });
  });

  // ------------------------------------------------ organizations and members

  app.get('/api/v1/organization', async (request, reply) => {
    const context = await requirePermission(request, reply, 'organization.read');
    if (!context?.organization || !context.membership) return reply;
    return {
      organization: {
        organization_id: context.organization.organization_id,
        slug: context.organization.slug,
        display_name: context.organization.display_name,
        role: context.membership.role,
        permissions: context.permissions,
      },
    };
  });

  app.get('/api/v1/members', async (request, reply) => {
    const context = await requirePermission(request, reply, 'member.read');
    if (!context?.organization) return reply;
    const result = await pool.query(
      `SELECT u.user_id, u.normalized_email AS email, u.display_name, u.enabled,
              m.role, m.created_at, m.updated_at, m.disabled_at
       FROM memberships m JOIN users u ON u.user_id = m.user_id
       WHERE m.organization_id = $1 ORDER BY u.display_name, u.user_id`,
      [context.organization.organization_id],
    );
    return { members: result.rows };
  });

  app.patch('/api/v1/members/:userId', async (request, reply) => {
    const context = await requirePermission(request, reply, 'member.manage', true);
    if (!context) return reply;
    const parsed = z
      .object({ role: z.enum(['owner', 'admin', 'developer', 'viewer']) })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const result = await changeMemberRole(
      pool,
      context,
      (request.params as { userId: string }).userId,
      parsed.data.role,
    );
    if (!result.ok) return reply.code(result.status).send({ error: result.code });
    await auditRepo.record(pool, {
      action: 'member.role.update',
      actor: context.user.user_id,
      actorUserId: context.user.user_id,
      targetType: 'user',
      targetId: (request.params as { userId: string }).userId,
      result: 'success',
      organizationId: context.organization?.organization_id,
      detail: { role: parsed.data.role },
    });
    return { updated: true };
  });

  app.delete('/api/v1/members/:userId', async (request, reply) => {
    const context = await requirePermission(request, reply, 'member.manage', true);
    if (!context) return reply;
    const targetId = (request.params as { userId: string }).userId;
    const result = await disableMember(pool, context, targetId);
    if (!result.ok) return reply.code(result.status).send({ error: result.code });
    await auditRepo.record(pool, {
      action: 'member.disable',
      actor: context.user.user_id,
      actorUserId: context.user.user_id,
      targetType: 'user',
      targetId,
      result: 'success',
      organizationId: context.organization?.organization_id,
    });
    return { disabled: true };
  });

  app.get('/api/v1/invitations', async (request, reply) => {
    const context = await requirePermission(request, reply, 'member.read');
    if (!context?.organization) return reply;
    const result = await pool.query(
      `SELECT invitation_id, normalized_email AS email, intended_role, created_at,
              expires_at, accepted_at, revoked_at, invited_by
       FROM invitations WHERE organization_id = $1
       ORDER BY created_at DESC, invitation_id DESC LIMIT 200`,
      [context.organization.organization_id],
    );
    return { invitations: result.rows };
  });

  app.post('/api/v1/invitations', async (request, reply) => {
    const context = await requirePermission(request, reply, 'invitation.manage', true);
    if (!context) return reply;
    const parsed = z
      .object({
        email: z.string().min(1).max(320),
        role: z.enum(['owner', 'admin', 'developer', 'viewer']),
        ttl_ms: z
          .number()
          .int()
          .positive()
          .max(7 * 24 * 60 * 60 * 1000)
          .optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      const created = await createInvitation(pool, context, {
        email: parsed.data.email,
        role: parsed.data.role,
        ttlMs: parsed.data.ttl_ms ?? 24 * 60 * 60 * 1000,
        publicBaseUrl: config.publicBaseUrl,
      });
      if (!created) return reply.code(403).send({ error: 'forbidden' });
      await auditRepo.record(pool, {
        action: 'invitation.create',
        actor: context.user.user_id,
        actorUserId: context.user.user_id,
        targetType: 'invitation',
        targetId: created.record.invitation_id,
        result: 'success',
        organizationId: context.organization?.organization_id,
        detail: { email: created.record.normalized_email, role: created.record.intended_role },
      });
      return reply.code(201).send({
        invitation_id: created.record.invitation_id,
        invitation_url: created.invitationUrl,
        expires_at: created.record.expires_at,
      });
    } catch (error) {
      if (String(error).includes('invitations_one_open_per_email')) {
        return reply.code(409).send({ error: 'invitation_exists' });
      }
      throw error;
    }
  });

  app.delete('/api/v1/invitations/:invitationId', async (request, reply) => {
    const context = await requirePermission(request, reply, 'invitation.manage', true);
    if (!context?.organization) return reply;
    const invitationId = (request.params as { invitationId: string }).invitationId;
    const result = await pool.query(
      `UPDATE invitations SET revoked_at = now()
       WHERE organization_id = $1 AND invitation_id = $2
         AND accepted_at IS NULL AND revoked_at IS NULL`,
      [context.organization.organization_id, invitationId],
    );
    if ((result.rowCount ?? 0) !== 1)
      return reply.code(404).send({ error: 'invitation_not_found' });
    await auditRepo.record(pool, {
      action: 'invitation.revoke',
      actor: context.user.user_id,
      actorUserId: context.user.user_id,
      targetType: 'invitation',
      targetId: invitationId,
      result: 'success',
      organizationId: context.organization.organization_id,
    });
    return { revoked: true };
  });

  app.post('/api/v1/invitations/accept', async (request, reply) => {
    const parsed = z
      .object({
        token: z.string().min(32).max(256),
        display_name: z.string().min(1).max(128),
        password: z.string().min(12).max(4096),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invitation_invalid' });
    const accepted = await acceptInvitation(pool, {
      token: parsed.data.token,
      displayName: parsed.data.display_name,
      password: parsed.data.password,
    });
    if (!accepted) {
      return reply
        .code(400)
        .send({ error: 'invitation_invalid', message: 'invitation cannot be accepted' });
    }
    return reply.code(201).send({ accepted: true });
  });

  // ------------------------------------------------------ Nodes and projects

  app.get('/api/v1/overview', async (request, reply) => {
    const context = await requirePermission(request, reply, 'project.read');
    if (!context?.organization) return reply;
    const organizationId = context.organization.organization_id;
    const counts = await pool.query<{
      online_nodes: string;
      offline_nodes: string;
      stale_nodes: string;
      draining_nodes: string;
      enabled_projects: string;
      active_runs: string;
      waiting_approvals: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM nodes WHERE organization_id = $1 AND connection_state = 'online' AND draining = FALSE)::text AS online_nodes,
         (SELECT COUNT(*) FROM nodes WHERE organization_id = $1 AND connection_state = 'offline')::text AS offline_nodes,
         (SELECT COUNT(*) FROM nodes WHERE organization_id = $1 AND connection_state = 'stale')::text AS stale_nodes,
         (SELECT COUNT(*) FROM nodes WHERE organization_id = $1 AND draining = TRUE)::text AS draining_nodes,
         (SELECT COUNT(*) FROM projects WHERE organization_id = $1 AND enabled = TRUE)::text AS enabled_projects,
         (SELECT COUNT(*) FROM runs WHERE organization_id = $1 AND status NOT IN ('completed','failed','cancelled','interrupted','lost'))::text AS active_runs,
         (SELECT COUNT(*) FROM runs WHERE organization_id = $1 AND status = 'waiting_for_approval')::text AS waiting_approvals`,
      [organizationId],
    );
    const recent = await pool.query(
      `SELECT * FROM runs WHERE organization_id = $1
         AND status IN ('failed', 'interrupted', 'lost')
       ORDER BY finished_at DESC NULLS LAST, run_id DESC LIMIT 10`,
      [organizationId],
    );
    const row = counts.rows[0];
    return {
      counts: {
        online_nodes: Number(row?.online_nodes ?? 0),
        offline_nodes: Number(row?.offline_nodes ?? 0),
        stale_nodes: Number(row?.stale_nodes ?? 0),
        draining_nodes: Number(row?.draining_nodes ?? 0),
        enabled_projects: Number(row?.enabled_projects ?? 0),
        active_runs: Number(row?.active_runs ?? 0),
        waiting_approvals: Number(row?.waiting_approvals ?? 0),
      },
      recent_problem_runs: recent.rows,
      control_plane: { status: 'ok' },
    };
  });

  const renderNode = (node: Awaited<ReturnType<typeof productNodesRepo.byId>>) =>
    node
      ? {
          node_id: node.node_id,
          display_name: node.display_name,
          connection_state: node.revoked_at
            ? 'revoked'
            : channel.isOnline(node.node_id)
              ? node.draining
                ? 'draining'
                : 'online'
              : 'offline',
          last_seen_at: node.last_seen_at,
          software_version: node.software_version,
          protocol_version: node.protocol_version,
          identity_generation: node.identity_generation,
          fingerprint: node.fingerprint,
          capabilities: node.capabilities,
          // The sanitized view, so a client decides from named booleans rather
          // than reading a Node's raw advertisement and guessing at it.
          node_capabilities: nodeCapabilityView(node),
          draining: node.draining,
          revoked_at: node.revoked_at,
        }
      : null;

  app.get('/api/v1/nodes', async (request, reply) => {
    const context = await requirePermission(request, reply, 'node.read');
    if (!context?.organization) return reply;
    const nodes = await productNodesRepo.list(pool, context.organization.organization_id);
    return { nodes: nodes.map(renderNode) };
  });

  app.get('/api/v1/nodes/:nodeId', async (request, reply) => {
    const context = await requirePermission(request, reply, 'node.read');
    if (!context?.organization) return reply;
    const nodeId = (request.params as { nodeId: string }).nodeId;
    const node = await productNodesRepo.byId(pool, context.organization.organization_id, nodeId);
    if (!node) return reply.code(404).send({ error: 'node_not_found' });
    const projects = (
      await productProjectsRepo.list(pool, context.organization.organization_id)
    ).filter((project) => project.node_id === nodeId);
    return { node: renderNode(node), projects };
  });

  app.post('/api/v1/enrollment-tokens', async (request, reply) => {
    const context = await requirePermission(request, reply, 'node.manage', true);
    if (!context?.organization) return reply;
    const parsed = z
      .object({
        intended_name: z.string().max(128).optional(),
        purpose: z.enum(['enrollment', 'recovery']).default('enrollment'),
        ttl_ms: z
          .number()
          .int()
          .positive()
          .max(7 * 24 * 60 * 60 * 1000)
          .optional(),
      })
      .safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const created = await enrollmentTokensRepo.create(pool, {
      ttlMs: parsed.data.ttl_ms ?? config.enrollmentTokenTtlMs,
      intendedName: parsed.data.intended_name,
      purpose: parsed.data.purpose,
      createdBy: context.user.user_id,
      organizationId: context.organization.organization_id,
    });
    await auditRepo.record(pool, {
      action: 'enrollment_token.create',
      actor: context.user.user_id,
      actorUserId: context.user.user_id,
      targetType: 'enrollment_token',
      targetId: created.record.token_id,
      result: 'success',
      organizationId: context.organization.organization_id,
      detail: { purpose: created.record.purpose },
    });
    return reply.code(201).send({
      token_id: created.record.token_id,
      token: created.token,
      purpose: created.record.purpose,
      expires_at: created.record.expires_at,
    });
  });

  const nodeCommand = async (
    request: FastifyRequest,
    reply: FastifyReply,
    commandType: string,
    action: string,
  ) => {
    const context = await requirePermission(request, reply, 'node.manage', true);
    if (!context?.organization) return reply;
    const nodeId = (request.params as { nodeId: string }).nodeId;
    const node = await productNodesRepo.byId(pool, context.organization.organization_id, nodeId);
    if (!node) return reply.code(404).send({ error: 'node_not_found' });
    const command = await commandsRepo.create(pool, {
      nodeId,
      projectId: null,
      commandType,
      payload: {},
      digest: commandFingerprint(commandType, null, {}),
    });
    await auditRepo.record(pool, {
      action,
      actor: context.user.user_id,
      actorUserId: context.user.user_id,
      targetType: 'node',
      targetId: nodeId,
      result: 'accepted',
      correlationId: command.command_id,
      organizationId: context.organization.organization_id,
    });
    return reply.code(202).send({ command_id: command.command_id, node_id: nodeId });
  };

  app.post('/api/v1/nodes/:nodeId/drain', async (request, reply) =>
    nodeCommand(request, reply, 'node.drain', 'node.drain'),
  );

  app.post('/api/v1/nodes/:nodeId/resume', async (request, reply) => {
    const context = await requirePermission(request, reply, 'node.manage', true);
    if (!context?.organization) return reply;
    const nodeId = (request.params as { nodeId: string }).nodeId;
    const node = await productNodesRepo.byId(pool, context.organization.organization_id, nodeId);
    if (!node) return reply.code(404).send({ error: 'node_not_found' });
    return reply.code(409).send({
      error: 'resume_not_supported',
      message: 'protocol v1 Node drain is cleared only by a supervised daemon restart',
    });
  });

  app.post('/api/v1/nodes/:nodeId/revoke', async (request, reply) => {
    const context = await requirePermission(request, reply, 'node.manage', true);
    if (!context?.organization) return reply;
    const nodeId = (request.params as { nodeId: string }).nodeId;
    const node = await productNodesRepo.byId(pool, context.organization.organization_id, nodeId);
    if (!node) return reply.code(404).send({ error: 'node_not_found' });
    const reason = z.object({ reason: z.string().min(1).max(500) }).safeParse(request.body);
    if (!reason.success) return reply.code(400).send({ error: 'invalid_request' });
    await nodesRepo.revoke(pool, nodeId, reason.data.reason);
    await channel.disconnect(nodeId, 'node_revoked');
    await auditRepo.record(pool, {
      action: 'node.revoke',
      actor: context.user.user_id,
      actorUserId: context.user.user_id,
      targetType: 'node',
      targetId: nodeId,
      result: 'success',
      organizationId: context.organization.organization_id,
      detail: { reason: reason.data.reason },
    });
    return { revoked: true };
  });

  app.post('/api/v1/nodes/:nodeId/rotation-token', async (request, reply) => {
    const context = await requirePermission(request, reply, 'node.manage', true);
    if (!context?.organization) return reply;
    const nodeId = (request.params as { nodeId: string }).nodeId;
    const node = await productNodesRepo.byId(pool, context.organization.organization_id, nodeId);
    if (!node) return reply.code(404).send({ error: 'node_not_found' });
    if (node.revoked_at) return reply.code(409).send({ error: 'node_revoked' });
    const created = await enrollmentTokensRepo.create(pool, {
      ttlMs: config.enrollmentTokenTtlMs,
      intendedName: node.display_name,
      purpose: 'rotation',
      boundNodeId: node.node_id,
      createdBy: context.user.user_id,
      organizationId: context.organization.organization_id,
    });
    await auditRepo.record(pool, {
      action: 'node.rotation_token.issue',
      actor: context.user.user_id,
      actorUserId: context.user.user_id,
      targetType: 'node',
      targetId: nodeId,
      result: 'success',
      organizationId: context.organization.organization_id,
      detail: { token_id: created.record.token_id },
    });
    return reply.code(201).send({
      token_id: created.record.token_id,
      token: created.token,
      node_id: nodeId,
      expires_at: created.record.expires_at,
    });
  });

  app.get('/api/v1/nodes/:nodeId/rotations', async (request, reply) => {
    const context = await requirePermission(request, reply, 'node.read');
    if (!context?.organization) return reply;
    const nodeId = (request.params as { nodeId: string }).nodeId;
    const node = await productNodesRepo.byId(pool, context.organization.organization_id, nodeId);
    if (!node) return reply.code(404).send({ error: 'node_not_found' });
    return {
      rotations: await productRotationsRepo.listForNode(
        pool,
        context.organization.organization_id,
        nodeId,
      ),
    };
  });

  /**
   * What a browser may see of an installation.
   *
   * The connection code is absent because it exists exactly once, in the reply
   * that created it. So is the token row it belongs to, and so is anything the
   * host decided: no paths, no ports, no unit names. What is left is a stage, a
   * percentage and two byte counts — enough to watch, and nothing to leak.
   */
  const renderInstallation = (record: InstallationRecord) => ({
    installation_id: record.installation_id,
    display_name: record.display_name,
    state: record.state,
    generation: record.generation,
    percent: record.percent,
    bytes_done: record.bytes_done === null ? null : Number(record.bytes_done),
    bytes_total: record.bytes_total === null ? null : Number(record.bytes_total),
    failure_code: record.failure_code,
    retryable: record.retryable,
    node_id: record.node_id,
    created_at: record.created_at,
    updated_at: record.updated_at,
    expires_at: record.expires_at,
    completed_at: record.completed_at,
    cancelled_at: record.cancelled_at,
  });

  app.post('/api/v1/node-installations', async (request, reply) => {
    const context = await requirePermission(request, reply, 'node.manage', true);
    if (!context?.organization) return reply;

    const body = (request.body ?? {}) as Record<string, unknown>;
    const displayName =
      typeof body.display_name === 'string' && body.display_name.trim()
        ? body.display_name.trim().slice(0, 120)
        : 'New Node';

    const { record, code } = await nodeInstallationsRepo.create(pool, {
      organizationId: context.organization.organization_id,
      displayName,
      createdByUserId: context.user.user_id,
      ttlMs: config.enrollmentTokenTtlMs,
    });

    await auditRepo.record(pool, {
      action: 'node_installation.create',
      actor: context.user.user_id,
      targetType: 'node_installation',
      targetId: record.installation_id,
      result: 'success',
      organizationId: context.organization.organization_id,
      // The code is not here, and neither is its digest: an audit row is read in
      // more places than the one that authenticates.
      detail: { display_name: displayName },
    });

    // The only time this code is ever returned.
    return reply.code(201).send({ installation: renderInstallation(record), code });
  });

  app.get('/api/v1/node-installations', async (request, reply) => {
    const context = await requirePermission(request, reply, 'node.manage');
    if (!context?.organization) return reply;
    const records = await nodeInstallationsRepo.list(pool, context.organization.organization_id);
    return { installations: records.map(renderInstallation) };
  });

  app.get('/api/v1/node-installations/:installationId', async (request, reply) => {
    const context = await requirePermission(request, reply, 'node.manage');
    if (!context?.organization) return reply;
    const { installationId } = request.params as { installationId: string };
    const record = await nodeInstallationsRepo.byId(
      pool,
      context.organization.organization_id,
      installationId,
    );
    if (!record) return reply.code(404).send({ error: 'installation_not_found' });
    return { installation: renderInstallation(record) };
  });

  app.post('/api/v1/node-installations/:installationId/cancel', async (request, reply) => {
    const context = await requirePermission(request, reply, 'node.manage', true);
    if (!context?.organization) return reply;
    const { installationId } = request.params as { installationId: string };
    const record = await nodeInstallationsRepo.cancel(
      pool,
      context.organization.organization_id,
      installationId,
    );
    if (!record) {
      return reply.code(409).send({
        error: 'not_cancellable',
        message: 'this installation is unknown or has already finished',
      });
    }
    await auditRepo.record(pool, {
      action: 'node_installation.cancel',
      actor: context.user.user_id,
      targetType: 'node_installation',
      targetId: installationId,
      result: 'success',
      organizationId: context.organization.organization_id,
    });
    return { installation: renderInstallation(record) };
  });

  app.get('/api/v1/node-installations/:installationId/events/stream', async (request, reply) => {
    const context = await requirePermission(request, reply, 'node.manage');
    if (!context?.organization) return reply;
    const organizationId = context.organization.organization_id;
    const { installationId } = request.params as { installationId: string };
    const record = await nodeInstallationsRepo.byId(pool, organizationId, installationId);
    if (!record) return reply.code(404).send({ error: 'installation_not_found' });

    // Resuming after a reload is the same mechanism run events already use: the
    // browser says what it last saw and receives only what followed.
    const query = request.query as { since_seq?: string };
    const header = request.headers['last-event-id'];
    const cursor = Number((typeof header === 'string' ? header : query.since_seq) ?? 0);
    if (!Number.isInteger(cursor) || cursor < 0) {
      return reply.code(400).send({ error: 'invalid_cursor' });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
    });
    let position = cursor;
    let closed = false;
    reply.raw.on('close', () => {
      closed = true;
    });
    while (!closed) {
      const liveContext = await contextFor(request);
      if (
        !liveContext?.organization ||
        liveContext.organization.organization_id !== organizationId
      ) {
        break;
      }
      const batch = await nodeInstallationsRepo.eventsSince(pool, installationId, position);
      for (const event of batch) {
        position = Number(event.seq);
        reply.raw.write(
          `id: ${position}\nevent: installation.progress\ndata: ${JSON.stringify({
            seq: position,
            generation: event.generation,
            state: event.state,
            percent: event.percent,
            bytes_done: event.bytes_done === null ? null : Number(event.bytes_done),
            bytes_total: event.bytes_total === null ? null : Number(event.bytes_total),
            failure_code: event.failure_code,
            recorded_at: event.recorded_at,
          })}\n\n`,
        );
      }
      const current = await nodeInstallationsRepo.byId(pool, organizationId, installationId);
      if (current && isTerminal(current.state) && batch.length === 0) break;
      if (batch.length === 0) {
        reply.raw.write(': heartbeat\n\n');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    reply.raw.end();
    return reply;
  });

  app.get('/api/v1/projects', async (request, reply) => {
    const context = await requirePermission(request, reply, 'project.read');
    if (!context?.organization) return reply;
    return {
      projects: await productProjectsRepo.list(pool, context.organization.organization_id),
    };
  });

  /**
   * What a project reader is allowed to see.
   *
   * Everything the Node decides — where the workspace lives, which Hermes home
   * serves it, which port its worker listens on, which key opens it — is absent
   * by construction rather than by filtering: none of it is in this row.
   */
  const renderProject = (
    project: ProjectRecord,
    node: Awaited<ReturnType<typeof productNodesRepo.byId>>,
  ) => {
    const state = project.provisioning_state ?? 'ready';
    const failure = project.provisioning_failure ?? null;
    const online = channel.isOnline(project.node_id);
    return {
      project_id: project.project_id,
      name: project.display_name,
      slug: project.slug ?? null,
      node_id: project.node_id,
      enabled: project.enabled,
      available: project.available,
      workspace: project.workspace_mode
        ? {
            mode: project.workspace_mode,
            repository_url: project.repository_url ?? null,
            branch: project.repository_branch ?? null,
          }
        : null,
      provisioning: {
        state,
        generation: project.provisioning_generation ?? 0,
        failure,
        // The message is the Node's own sanitized text, never raw git stderr.
        failure_message: project.provisioning_failure_message ?? null,
        retryable: state === 'failed' && isRetryable(failure),
      },
      // Readiness is not enough on its own: a ready project whose Node is
      // unreachable still cannot start anything.
      can_run: project.enabled && canCreateRuns(state) && online,
      node_online: online,
      node_capabilities: nodeCapabilityView(node),
    };
  };

  /**
   * Create a project and the command that builds it.
   *
   * The two are one decision, so they commit together. Everything checked before
   * the transaction is checked because a failure afterwards would leave a
   * project an operator can see and nothing will ever act on.
   */
  app.post('/api/v1/projects', async (request, reply) => {
    const context = await requirePermission(request, reply, 'project.manage', true);
    if (!context?.organization) return reply;

    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = validateName(body.name);
    if (!name.ok) return reply.code(400).send({ error: 'invalid_project_name' });
    const slug = validateSlug(body.slug);
    if (!slug.ok) return reply.code(400).send({ error: 'invalid_project_slug' });

    const nodeId = typeof body.node_id === 'string' ? body.node_id : '';
    const node = await productNodesRepo.byId(pool, context.organization.organization_id, nodeId);
    // The same answer for a Node in another organization and a Node that does
    // not exist: which of the two it is, is not this caller's business.
    if (!node) return reply.code(404).send({ error: 'node_not_found' });

    const capabilities = nodeCapabilityView(node);
    if (!channel.isOnline(nodeId)) {
      // Refused before anything durable exists. Provisioning is a conversation,
      // and a project whose first act is queued against an unreachable Node
      // would sit pending with nothing to explain it.
      return reply.code(409).send({ error: 'node_offline' });
    }
    if (!capabilities.supports_project_provisioning) {
      return reply.code(409).send({ error: 'node_capability_unavailable' });
    }

    const workspace = (body.workspace ?? {}) as Record<string, unknown>;
    const mode = typeof workspace.mode === 'string' ? workspace.mode : '';
    if (!capabilities.workspace_modes.includes(mode)) {
      return reply.code(422).send({ error: 'workspace_mode_unsupported' });
    }

    let repositoryUrl: string | null = null;
    let branch: string | null = null;
    if (mode === 'clone') {
      const url = validateRepositoryUrl(workspace.repository_url);
      if (!url.ok) return reply.code(422).send({ error: url.reason });
      repositoryUrl = url.url;
      if (workspace.branch !== undefined && workspace.branch !== null) {
        const parsed = validateBranch(workspace.branch);
        if (!parsed.ok) return reply.code(422).send({ error: 'repository_branch_invalid' });
        branch = parsed.branch;
      }
    }

    const projectId = `prj_${randomUUID().replace(/-/g, '')}`;
    // The Node addresses its own inventory by this id; it is opaque and derived
    // from nothing an operator typed, so renaming a project later cannot move
    // its workspace or its Hermes home.
    const nodeProjectId = projectId;

    try {
      const created = await withTransaction(pool, async (client) => {
        const project = await productProjectsRepo.createWithProvisionCommand(client, {
          organizationId: context.organization!.organization_id,
          projectId,
          nodeId,
          nodeProjectId,
          displayName: name.name,
          slug: slug.slug,
          workspaceMode: mode,
          repositoryUrl,
          repositoryBranch: branch,
          createdByUserId: context.user.user_id,
        });

        const payload = {
          version: PROVISION_COMMAND_VERSION,
          organization_id: context.organization!.organization_id,
          project_id: projectId,
          node_project_id: nodeProjectId,
          provisioning_generation: 1,
          workspace_mode: mode,
          // Absent rather than null for an empty project. A null is still a
          // field: a reader cannot tell "no repository was asked for" from
          // "a repository was asked for and it was nothing".
          ...(repositoryUrl === null ? {} : { repository_url: repositoryUrl }),
          ...(branch === null ? {} : { branch }),
        };
        const command = await commandsRepo.create(client, {
          nodeId,
          projectId,
          commandType: PROVISION_COMMAND,
          payload,
          digest: commandFingerprint(PROVISION_COMMAND, nodeProjectId, payload),
        });

        await auditRepo.record(client, {
          action: 'project.provision_requested',
          actor: context.user.user_id,
          actorUserId: context.user.user_id,
          targetType: 'project',
          targetId: projectId,
          result: 'success',
          organizationId: context.organization!.organization_id,
          correlationId: command.command_id,
          detail: {
            node_id: nodeId,
            workspace_mode: mode,
            provisioning_generation: 1,
          },
        });

        return { project, command };
      });

      return reply.code(201).send({
        project: renderProject(created.project, node),
        command_id: created.command.command_id,
      });
    } catch (error) {
      // The slug index is the authority on uniqueness; checking first and then
      // inserting would leave a window where two requests both saw it free.
      if (String(error).includes('projects_org_slug')) {
        return reply.code(409).send({ error: 'project_slug_conflict' });
      }
      throw error;
    }
  });

  /**
   * Start another attempt at a project whose provisioning failed.
   *
   * The generation increments, which is what makes every event still in flight
   * from the previous attempt inert: they carry a number that no longer matches.
   */
  app.post('/api/v1/projects/:projectId/provisioning/retry', async (request, reply) => {
    const context = await requirePermission(request, reply, 'project.manage', true);
    if (!context?.organization) return reply;
    const projectId = (request.params as { projectId: string }).projectId;

    const existing = await productProjectsRepo.byId(
      pool,
      context.organization.organization_id,
      projectId,
    );
    if (!existing) return reply.code(404).send({ error: 'project_not_found' });
    if (existing.provisioning_state !== 'failed') {
      return reply.code(409).send({ error: 'project_not_retryable' });
    }
    if (!isRetryable(existing.provisioning_failure ?? null)) {
      // A conflicting slug or a refused capability fails identically forever;
      // offering the button again would teach an operator to click uselessly.
      return reply.code(409).send({ error: 'project_failure_not_retryable' });
    }
    const node = await productNodesRepo.byId(
      pool,
      context.organization.organization_id,
      existing.node_id,
    );
    if (!node) return reply.code(404).send({ error: 'node_not_found' });
    if (!channel.isOnline(existing.node_id)) {
      return reply.code(409).send({ error: 'node_offline' });
    }

    const retried = await withTransaction(pool, async (client) => {
      const project = await productProjectsRepo.beginRetry(
        client,
        context.organization!.organization_id,
        projectId,
      );
      if (!project) return null;

      const payload = {
        version: PROVISION_COMMAND_VERSION,
        organization_id: context.organization!.organization_id,
        project_id: projectId,
        node_project_id: project.node_project_id,
        provisioning_generation: project.provisioning_generation,
        workspace_mode: project.workspace_mode,
        ...(project.repository_url === null ? {} : { repository_url: project.repository_url }),
        ...(project.repository_branch === null ? {} : { branch: project.repository_branch }),
      };
      const command = await commandsRepo.create(client, {
        nodeId: project.node_id,
        projectId,
        commandType: PROVISION_COMMAND,
        payload,
        digest: commandFingerprint(PROVISION_COMMAND, project.node_project_id, payload),
      });
      await auditRepo.record(client, {
        action: 'project.provision_retry_requested',
        actor: context.user.user_id,
        actorUserId: context.user.user_id,
        targetType: 'project',
        targetId: projectId,
        result: 'success',
        organizationId: context.organization!.organization_id,
        correlationId: command.command_id,
        detail: {
          node_id: project.node_id,
          provisioning_generation: project.provisioning_generation,
          previous_failure: existing.provisioning_failure,
        },
      });
      return { project, command };
    });

    if (!retried) return reply.code(409).send({ error: 'project_not_retryable' });
    return {
      project: renderProject(retried.project, node),
      command_id: retried.command.command_id,
    };
  });

  app.get('/api/v1/projects/:projectId', async (request, reply) => {
    const context = await requirePermission(request, reply, 'project.read');
    if (!context?.organization) return reply;
    const projectId = (request.params as { projectId: string }).projectId;
    const project = await productProjectsRepo.byId(
      pool,
      context.organization.organization_id,
      projectId,
    );
    if (!project) return reply.code(404).send({ error: 'project_not_found' });
    const runs = await pool.query(
      `SELECT * FROM runs WHERE organization_id = $1 AND project_id = $2
       ORDER BY created_at DESC, run_id DESC LIMIT 20`,
      [context.organization.organization_id, projectId],
    );
    const node = await productNodesRepo.byId(
      pool,
      context.organization.organization_id,
      project.node_id,
    );
    return {
      // The same sanitized shape creation and retry return. The raw row carries
      // columns the product API has no business exposing, and returning it once
      // makes every future column a decision nobody made.
      project: renderProject(project, node),
      node,
      // Derived from the owning Node's authenticated advertisement, sanitized
      // to names and values this Control Plane understands. The console decides
      // what to render from this and nothing else.
      node_capabilities: nodeCapabilityView(node),
      active_run:
        runs.rows.find((run) => !TERMINAL_RUN_STATUSES.has((run as { status: string }).status)) ??
        null,
      recent_runs: runs.rows,
    };
  });

  // -------------------------------------------------------------------- runs

  const CreateRunSchema = z.object({
    input: z.string().min(1).max(512_000),
    session_id: z.string().max(128).optional(),
    instructions: z.string().max(64_000).optional(),
    idempotency_key: z.string().min(1).max(128).optional(),
    // Absent means `manual`, which is what every existing client sends.
    approval_policy: z.enum(RUN_APPROVAL_POLICIES).optional(),
    // Shape-checked here; contents validated below so the refusal can say why.
    attachments: z
      .array(z.unknown())
      .max(MAX_ATTACHMENTS + 1)
      .optional(),
  });

  app.post('/api/v1/projects/:projectId/runs', async (request, reply) => {
    const context = await requirePermission(request, reply, 'run.create', true);
    if (!context?.organization) return reply;

    // Two shapes, one meaning. A multipart submission carries the same JSON
    // request the plain endpoint takes, plus the images; existing clients that
    // send JSON are untouched.
    let rawBody: unknown = request.body;
    let uploadedFiles: Awaited<ReturnType<typeof readMultipartRunRequest>>['files'] = [];
    if (request.isMultipart()) {
      if (!uploadsConfigured) {
        return reply.code(422).send({
          error: 'uploads_unavailable',
          message: 'This Control Plane is not configured to store uploaded images.',
        });
      }
      try {
        const multipartRequest = await readMultipartRunRequest(request, MAX_ATTACHMENTS);
        rawBody = multipartRequest.body;
        uploadedFiles = multipartRequest.files;
      } catch (error) {
        const typed = intakeErrorResponse(error);
        if (typed) return reply.code(422).send({ error: typed.code, message: typed.message });
        throw error;
      }
    }

    const parsed = CreateRunSchema.safeParse(rawBody);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const projectId = (request.params as { projectId: string }).projectId;
    const project = await productProjectsRepo.byId(
      pool,
      context.organization.organization_id,
      projectId,
    );
    if (!project) return reply.code(404).send({ error: 'project_not_found' });

    // A project whose runtime has not been built has nowhere to run. The Node
    // refuses such a project too, but discovering that after a durable command
    // exists means an operator watches a run fail for a reason the console
    // already knew. Legacy projects migrated as `ready` pass here unchanged.
    if (!project.enabled) {
      return reply.code(409).send({ error: 'project_disabled' });
    }
    if (!canCreateRuns(project.provisioning_state ?? 'ready')) {
      const state = project.provisioning_state ?? 'ready';
      const typed =
        state === 'failed'
          ? 'project_provision_failed'
          : state === 'disabled'
            ? 'project_disabled'
            : state === 'provisioning'
              ? 'project_provisioning'
              : 'project_pending';
      return reply.code(409).send({ error: typed });
    }

    // Attachments are refused, never stripped: a text-only run for a message
    // the operator attached an image to answers a different question.
    const attachments = validateAttachments(parsed.data.attachments);
    if (!attachments.ok) {
      return reply.code(422).send({ error: INVALID_ATTACHMENT, message: attachments.message });
    }
    // Uploaded and linked images share one budget: four images on a turn is
    // four, however they arrived.
    const totalAttachments = attachments.value.length + uploadedFiles.length;
    if (totalAttachments > MAX_ATTACHMENTS) {
      return reply.code(422).send({
        error: 'too_many_attachments',
        message: `at most ${MAX_ATTACHMENTS} images are allowed on one message`,
      });
    }

    if (totalAttachments > 0) {
      const node = await productNodesRepo.byId(
        pool,
        context.organization.organization_id,
        project.node_id,
      );
      const view = nodeCapabilityView(node);
      if (!view.image_attachments_available) {
        // Checked before a single byte is written: an offline Node means this
        // message cannot be sent, and storing its images first would leave
        // files belonging to a run that never happened.
        return reply.code(422).send({
          error: ATTACHMENTS_UNSUPPORTED,
          message:
            view.supports_run_approval_policy || view.capabilities_known
              ? "This project's Node cannot carry image attachments, or is currently offline."
              : "This project's Node has not reported its capabilities yet.",
        });
      }
    }

    if (uploadedFiles.length > 0 && !(await storage.healthy())) {
      return reply.code(503).send({
        error: 'storage_unavailable',
        message: 'Image storage is not writable right now, so the message was not sent.',
      });
    }

    // Bytes are stored before the run transaction because files are not
    // transactional. `discard` is what rejoins them to the rollback.
    let uploads: StoredUpload[] = [];
    let discardUploads: () => Promise<void> = async () => undefined;
    if (uploadedFiles.length > 0) {
      try {
        const persisted = await persistUploadedImages(pool, storage, uploadedFiles, {
          organizationId: context.organization.organization_id,
          projectId: project.project_id,
          userId: context.user.user_id,
        });
        uploads = persisted.stored;
        discardUploads = persisted.discard;
      } catch (error) {
        const typed = intakeErrorResponse(error);
        if (typed) return reply.code(422).send({ error: typed.code, message: typed.message });
        throw error;
      }
    }

    // What the Node receives. An uploaded image becomes an ordinary `image_url`
    // pointing at its capability URL: the Node, Hermes and the provider all keep
    // seeing the one attachment type that already works, and nothing downstream
    // learns that this image happens to be stored here.
    const nodeAttachments = [
      ...attachments.value,
      ...uploads.map((upload) => ({
        type: 'image_url' as const,
        url: attachmentCapabilityUrl(
          config.publicBaseUrl,
          upload.row.attachment_id,
          config.mediaSigningKey,
        ),
        ...(upload.alt ? { alt: upload.alt } : {}),
      })),
    ];

    const payload = {
      input: parsed.data.input,
      session_id: parsed.data.session_id ?? null,
      instructions: parsed.data.instructions ?? null,
      idempotency_key: parsed.data.idempotency_key ?? null,
      ...(nodeAttachments.length > 0 ? { attachments: nodeAttachments } : {}),
      // Forwarded only when asked for, so the command fingerprint of an
      // ordinary run is unchanged and older Nodes see the payload they expect.
      ...(parsed.data.approval_policy
        ? { approval_policy: parsed.data.approval_policy, actor: context.user.user_id }
        : {}),
    };
    try {
      assertDispatchable('runs.create', payload);
    } catch {
      return reply.code(422).send({ error: 'invalid_command' });
    }
    const digest = commandFingerprint('runs.create', project.node_project_id, payload);
    if (parsed.data.idempotency_key) {
      const existing = await commandsRepo.byIdempotencyKey(
        pool,
        project.node_id,
        parsed.data.idempotency_key,
      );
      if (existing) {
        // A replay returns the original run, so anything stored for this
        // attempt belongs to no run at all.
        await discardUploads();
        if (existing.payload_digest !== digest) {
          return reply.code(409).send({ error: 'idempotency_conflict' });
        }
        const run = await pool.query(
          `SELECT * FROM runs WHERE organization_id = $1 AND create_command_id = $2`,
          [context.organization.organization_id, existing.command_id],
        );
        return { run: run.rows[0], command_id: existing.command_id, replayed: true };
      }
    }
    let created;
    try {
      created = await withTransaction(pool, async (client) => {
        const command = await commandsRepo.create(client, {
          nodeId: project.node_id,
          projectId: project.project_id,
          commandType: 'runs.create',
          payload,
          digest,
          idempotencyKey: parsed.data.idempotency_key,
        });
        const run = await runsRepo.create(client, {
          nodeId: project.node_id,
          projectId: project.project_id,
          // The metadata copy is kept for compatibility with rows and clients that
          // predate the column; the column is what queries and ordering rely on.
          //
          // Attachments are recorded here as well, and this is the only place the
          // browser can learn about them again. The command payload carrying them
          // to the Node is not part of the conversation the console reconstructs
          // after a reload, so without this copy an attached image would render
          // once and then vanish on refresh.
          // Only the linked URL attachments are recorded here. Uploaded images
          // live in `run_attachments`, because this blob is what the console
          // reads back — and it must never learn the capability URL that the
          // provider fetches with.
          metadata: {
            input_length: parsed.data.input.length,
            session_id: payload.session_id,
            ...(attachments.value.length > 0 ? { attachments: attachments.value } : {}),
          },
          sessionId: payload.session_id,
          createCommandId: command.command_id,
          createdByUserId: context.user.user_id,
        });
        // The link rows are what make a retry able to reuse these bytes, and what
        // gives the transcript a stable order.
        await linkUploads(client, run.run_id, uploads, attachments.value.length);
        await auditRepo.record(client, {
          action: 'run.create',
          actor: context.user.user_id,
          actorUserId: context.user.user_id,
          targetType: 'run',
          targetId: run.run_id,
          result: 'success',
          correlationId: command.command_id,
          organizationId: context.organization?.organization_id,
        });
        return { command, run };
      });
    } catch (error) {
      // The run never became durable, so its images belong to nothing. The
      // transaction has already rolled its rows back; this removes the files.
      await discardUploads();
      throw error;
    }
    return reply.code(201).send({
      run: created.run,
      command_id: created.command.command_id,
      node_online: channel.isOnline(project.node_id),
    });
  });

  /**
   * One project's active conversation.
   *
   * Chat is the interaction surface; a run stays the unit of execution. This
   * returns the conversation identity plus its runs in order, so a browser can
   * reconstruct the whole thread after a reload without holding any of it
   * locally. When the project has never been chatted with, `session_id` is null
   * and the caller mints one for its first message.
   */
  app.get('/api/v1/projects/:projectId/chat', async (request, reply) => {
    const context = await requirePermission(request, reply, 'run.read');
    if (!context?.organization) return reply;
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(500).default(200) })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_request' });

    const projectId = (request.params as { projectId: string }).projectId;
    const project = await productProjectsRepo.byId(
      pool,
      context.organization.organization_id,
      projectId,
    );
    if (!project) return reply.code(404).send({ error: 'project_not_found' });

    const sessionId = await productRunsRepo.activeSessionId(
      pool,
      context.organization.organization_id,
      project.project_id,
    );
    const runs = sessionId
      ? await productRunsRepo.sessionRuns(
          pool,
          context.organization.organization_id,
          project.project_id,
          sessionId,
          query.data.limit,
        )
      : [];

    // The console polls this endpoint, so capability state refreshes on its own
    // after a Node reconnects — no browser restart, and no separate request
    // whose staleness could disagree with the conversation it sits beside.
    const node = await productNodesRepo.byId(
      pool,
      context.organization.organization_id,
      project.node_id,
    );

    // Uploaded images are joined in from their own table rather than read out
    // of run metadata, which deliberately does not contain them.
    const runIds = runs.map((run: { run_id: string }) => run.run_id);
    const uploadedByRun = await attachmentsRepo.forRuns(pool, runIds);
    // The approval policy is answered here rather than reconstructed in the
    // browser: the console's event stream resumes from a stored cursor and so
    // never re-delivers the early events, and the policy is set exactly once —
    // usually at sequence 1.
    const policyByRun = await runPolicyRepo.forRuns(pool, runIds);

    return {
      session_id: sessionId,
      runs: runs.map((run: { run_id: string }) => {
        const uploaded = uploadedByRun.get(run.run_id) ?? [];
        const policy = policyByRun.get(run.run_id);
        return {
          ...run,
          ...(uploaded.length > 0 ? { uploaded_attachments: uploaded.map(browserAttachment) } : {}),
          ...(policy
            ? {
                approval_policy: policy.policy,
                approval_policy_actor: policy.actor,
                approval_policy_changed_at: policy.changed_at,
              }
            : {}),
        };
      }),
      node_capabilities: nodeCapabilityView(node),
      // What the composer may offer, and the exact limits it should enforce
      // before wasting an upload on a file the server will refuse.
      uploads: {
        available: uploadsConfigured && nodeCapabilityView(node).image_attachments_available,
        configured: uploadsConfigured,
        max_attachments: MAX_ATTACHMENTS,
        max_bytes: MAX_UPLOAD_BYTES,
        max_request_bytes: MAX_REQUEST_BYTES,
        max_dimension: MAX_DIMENSION,
        max_pixels: MAX_PIXELS,
        media_types: SUPPORTED_MEDIA_TYPES,
      },
    };
  });

  /**
   * One stored image, for the browser that is allowed to see it.
   *
   * Separate from the capability URL on purpose. The provider's link
   * authenticates by possession because it has no other option; a browser has a
   * session, so it uses it — and never receives the capability at all.
   */
  app.get(
    '/api/v1/projects/:projectId/attachments/:attachmentId/content',
    async (request, reply) => {
      const context = await requirePermission(request, reply, 'run.read');
      if (!context?.organization) return reply;
      const { projectId, attachmentId } = request.params as {
        projectId: string;
        attachmentId: string;
      };
      const row = await attachmentsRepo.byId(
        pool,
        context.organization.organization_id,
        projectId,
        attachmentId,
      );
      // One answer for absent, disabled, and belonging to someone else: the
      // difference is not this caller's business.
      if (!row || row.state !== 'ready') {
        return reply.code(404).send({ error: 'attachment_not_found' });
      }
      let bytes: Buffer;
      try {
        bytes = await storage.read(row.storage_key);
      } catch {
        return reply.code(404).send({ error: 'attachment_not_found' });
      }
      return reply
        .header('Content-Type', row.media_type)
        .header('Content-Length', String(bytes.byteLength))
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, no-store')
        .send(bytes);
    },
  );

  app.get('/api/v1/projects/:projectId/attachments/:attachmentId', async (request, reply) => {
    const context = await requirePermission(request, reply, 'run.read');
    if (!context?.organization) return reply;
    const { projectId, attachmentId } = request.params as {
      projectId: string;
      attachmentId: string;
    };
    const row = await attachmentsRepo.byId(
      pool,
      context.organization.organization_id,
      projectId,
      attachmentId,
    );
    if (!row || row.state !== 'ready') {
      return reply.code(404).send({ error: 'attachment_not_found' });
    }
    return browserAttachment({ ...row, run_id: '', position: 0, alt: null });
  });

  /**
   * The capability route the model provider fetches images with.
   *
   * Unauthenticated by necessity: the provider has no session and no Asterism
   * credential. The signature in the path is the entire authorization, it
   * covers this one attachment id, and it is checked in constant time.
   *
   * Every failure — bad signature, unknown id, disabled attachment, missing
   * file — answers identically. A fetcher has no legitimate use for the
   * difference, and a prober would use it to enumerate.
   */
  const respondNotFound = (reply: FastifyReply): FastifyReply =>
    reply
      .code(404)
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .type('text/plain')
      .send('not found');

  const serveCapability = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    const { attachmentId, signature } = request.params as {
      attachmentId: string;
      signature: string;
    };
    if (!config.mediaSigningKey) return respondNotFound(reply);
    if (!verifyAttachmentSignature(attachmentId, signature, config.mediaSigningKey)) {
      return respondNotFound(reply);
    }
    const row = await attachmentsRepo.byIdUnscoped(pool, attachmentId);
    if (!row || row.state !== 'ready') return respondNotFound(reply);

    let bytes: Buffer;
    try {
      bytes = await storage.read(row.storage_key);
    } catch {
      return respondNotFound(reply);
    }

    return reply
      .header('Content-Type', row.media_type)
      .header('Content-Length', String(bytes.byteLength))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store')
      .send(bytes);
  };

  // Fastify derives HEAD from GET, which answers a fetcher probing for type and
  // size with the same headers and no body. Declaring it separately would
  // collide with that.
  app.get(`${MEDIA_ROUTE_PREFIX}/:attachmentId/:signature`, serveCapability);

  app.get('/api/v1/runs', async (request, reply) => {
    const context = await requirePermission(request, reply, 'run.read');
    if (!context?.organization) return reply;
    const query = z
      .object({
        project_id: z.string().optional(),
        status: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
        before_id: z.string().optional(),
      })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_request' });
    const result = await pool.query(
      `SELECT * FROM runs WHERE organization_id = $1
         AND ($2::text IS NULL OR project_id = $2)
         AND ($3::text IS NULL OR status = $3)
         AND ($4::text IS NULL OR run_id < $4)
       ORDER BY created_at DESC, run_id DESC LIMIT $5`,
      [
        context.organization.organization_id,
        query.data.project_id ?? null,
        query.data.status ?? null,
        query.data.before_id ?? null,
        query.data.limit,
      ],
    );
    return { runs: result.rows };
  });

  app.get('/api/v1/runs/:runId', async (request, reply) => {
    const context = await requirePermission(request, reply, 'run.read');
    if (!context?.organization) return reply;
    const run = await productRunsRepo.byId(
      pool,
      context.organization.organization_id,
      (request.params as { runId: string }).runId,
    );
    if (!run) return reply.code(404).send({ error: 'run_not_found' });
    return {
      run: {
        ...run,
        replacement_run_id: await productRunsRepo.replacementFor(
          pool,
          context.organization.organization_id,
          run.run_id,
        ),
      },
    };
  });

  app.get('/api/v1/runs/:runId/events', async (request, reply) => {
    const context = await requirePermission(request, reply, 'run.read');
    if (!context?.organization) return reply;
    const runId = (request.params as { runId: string }).runId;
    const run = await productRunsRepo.byId(pool, context.organization.organization_id, runId);
    if (!run) return reply.code(404).send({ error: 'run_not_found' });
    const query = z
      .object({
        since_seq: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(1000).default(config.eventBatchSize),
      })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_cursor' });
    return {
      run_id: runId,
      since_seq: query.data.since_seq,
      events: await productEventsRepo.since(
        pool,
        context.organization.organization_id,
        runId,
        query.data.since_seq,
        query.data.limit,
      ),
    };
  });

  app.get('/api/v1/runs/:runId/events/stream', async (request, reply) => {
    const context = await requirePermission(request, reply, 'run.read');
    if (!context?.organization) return reply;
    const organizationId = context.organization.organization_id;
    const runId = (request.params as { runId: string }).runId;
    const run = await productRunsRepo.byId(pool, organizationId, runId);
    if (!run) return reply.code(404).send({ error: 'run_not_found' });
    const query = request.query as { since_seq?: string };
    const header = request.headers['last-event-id'];
    const cursor = Number((typeof header === 'string' ? header : query.since_seq) ?? 0);
    if (!Number.isInteger(cursor) || cursor < 0) {
      return reply.code(400).send({ error: 'invalid_cursor' });
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
    });
    let position = cursor;
    let closed = false;
    // The response closing is the disconnect signal for a hijacked SSE stream.
    reply.raw.on('close', () => {
      closed = true;
    });
    while (!closed) {
      const liveContext = await contextFor(request);
      if (
        !liveContext?.organization ||
        liveContext.organization.organization_id !== organizationId
      ) {
        break;
      }
      const batch = await productEventsRepo.since(
        pool,
        organizationId,
        runId,
        position,
        config.eventBatchSize,
      );
      for (const event of batch) {
        position = Number(event.seq);
        reply.raw.write(
          `id: ${position}\nevent: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
      }
      const current = await productRunsRepo.byId(pool, organizationId, runId);
      if (current && TERMINAL_RUN_STATUSES.has(current.status) && batch.length === 0) break;
      if (batch.length === 0) {
        reply.raw.write(': heartbeat\n\n');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    reply.raw.end();
    return reply;
  });

  const canManageRun = (context: SessionContext, run: { created_by_user_id: string | null }) =>
    authorize(context, 'run.manage_any') ||
    (authorize(context, 'run.manage_own') && run.created_by_user_id === context.user.user_id);

  const queueRunCommand = async (
    request: FastifyRequest,
    reply: FastifyReply,
    commandType: 'approvals.resolve' | 'runs.cancel' | 'runs.approval_policy',
    allowedStatuses: string[],
    buildPayload: (nodeRunId: string, body: unknown) => Record<string, unknown>,
    authenticatedContext?: SessionContext,
  ) => {
    const context =
      authenticatedContext ?? (await requirePermission(request, reply, 'run.manage_own', true));
    if (!context?.organization) return reply;
    const runId = (request.params as { runId: string }).runId;
    const run = await productRunsRepo.byId(pool, context.organization.organization_id, runId);
    if (!run) return reply.code(404).send({ error: 'run_not_found' });
    if (!canManageRun(context, run)) return reply.code(404).send({ error: 'run_not_found' });
    if (!run.node_run_id || !allowedStatuses.includes(run.status)) {
      return reply.code(409).send({ error: 'run_not_eligible' });
    }
    const project = await productProjectsRepo.byId(
      pool,
      context.organization.organization_id,
      run.project_id,
    );
    if (!project) return reply.code(404).send({ error: 'run_not_found' });
    const payload = buildPayload(run.node_run_id, request.body);
    const command = await commandsRepo.create(pool, {
      nodeId: run.node_id,
      projectId: run.project_id,
      commandType,
      payload,
      digest: commandFingerprint(commandType, project.node_project_id, payload),
    });
    await auditRepo.record(pool, {
      action: commandType,
      actor: context.user.user_id,
      actorUserId: context.user.user_id,
      targetType: 'run',
      targetId: runId,
      result: 'accepted',
      correlationId: command.command_id,
      organizationId: context.organization.organization_id,
    });
    return reply.code(202).send({ command_id: command.command_id, run_id: runId });
  };

  /**
   * Change one run's approval policy.
   *
   * Operator-only, through the same permission and ownership checks as any
   * other run command. Nothing the model emits reaches here: a run's input is
   * text handed to Hermes, and Hermes has no path back into this API.
   */
  app.post('/api/v1/runs/:runId/approval-policy', async (request, reply) => {
    const context = await requirePermission(request, reply, 'run.manage_own', true);
    if (!context) return reply;
    const parsed = z.object({ policy: z.enum(RUN_APPROVAL_POLICIES) }).safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: `policy must be one of ${RUN_APPROVAL_POLICIES.join(', ')}`,
      });
    }
    await auditRepo.record(pool, {
      action: 'run.approval_policy.requested',
      actor: context.user.user_id,
      targetType: 'run',
      targetId: (request.params as { runId: string }).runId,
      result: 'accepted',
      organizationId: context.organization?.organization_id,
    });
    return queueRunCommand(
      request,
      reply,
      'runs.approval_policy',
      // A terminal run's approvals can no longer be answered, so its policy is
      // not allowed to change afterwards.
      ['queued', 'starting', 'running', 'waiting_for_approval', 'recovering'],
      (nodeRunId) => ({
        run_id: nodeRunId,
        policy: parsed.data.policy,
        actor: context.user.user_id,
      }),
      context,
    );
  });

  app.post('/api/v1/runs/:runId/approval', async (request, reply) => {
    const context = await requirePermission(request, reply, 'run.manage_own', true);
    if (!context) return reply;
    // Named before the generic schema failure so the caller learns the choice
    // is refused on purpose, not merely misspelled.
    if (isPersistentApprovalRequest((request.body as { choice?: unknown } | null)?.choice)) {
      await auditRepo.record(pool, {
        action: 'approval.persistent_rejected',
        actor: context.user.user_id,
        targetType: 'run',
        targetId: (request.params as { runId: string }).runId,
        result: 'rejected',
        organizationId: context.organization?.organization_id,
      });
      return reply.code(422).send({
        error: PERSISTENT_APPROVAL_NOT_SUPPORTED,
        message: PERSISTENT_APPROVAL_MESSAGE,
      });
    }
    const parsed = z.object({ choice: z.enum(APPROVAL_CHOICES) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    return queueRunCommand(
      request,
      reply,
      'approvals.resolve',
      ['waiting_for_approval'],
      (nodeRunId) => ({ run_id: nodeRunId, choice: parsed.data.choice }),
      context,
    );
  });

  app.post('/api/v1/runs/:runId/cancel', async (request, reply) =>
    queueRunCommand(
      request,
      reply,
      'runs.cancel',
      ['starting', 'running', 'waiting_for_approval', 'recovering', 'cancelled'],
      (nodeRunId) => ({ run_id: nodeRunId }),
    ),
  );

  app.post('/api/v1/runs/:runId/retry', async (request, reply) => {
    const context = await requirePermission(request, reply, 'run.manage_own', true);
    if (!context?.organization) return reply;
    const runId = (request.params as { runId: string }).runId;
    const run = await productRunsRepo.byId(pool, context.organization.organization_id, runId);
    if (!run || !canManageRun(context, run)) {
      return reply.code(404).send({ error: 'run_not_found' });
    }
    if (!run.node_run_id || !['interrupted', 'lost'].includes(run.status)) {
      return reply.code(409).send({ error: 'run_not_retryable' });
    }
    const project = await productProjectsRepo.byId(
      pool,
      context.organization.organization_id,
      run.project_id,
    );
    if (!project) return reply.code(404).send({ error: 'run_not_found' });
    const payload = { run_id: run.node_run_id };
    const retriedAttachments = attachmentsOf(run.request_metadata);
    // Uploaded images are reused, not re-uploaded: the replacement points at the
    // same rows and therefore the same bytes and the same capability URL. The
    // Node re-sends its own stored request, so nothing needs to be rebuilt.
    const retriedUploads = await attachmentsRepo.forRun(pool, run.run_id);
    const created = await withTransaction(pool, async (client) => {
      const command = await commandsRepo.create(client, {
        nodeId: run.node_id,
        projectId: run.project_id,
        commandType: 'runs.retry',
        payload,
        digest: commandFingerprint('runs.retry', project.node_project_id, payload),
      });
      const replacement = await runsRepo.create(client, {
        nodeId: run.node_id,
        projectId: run.project_id,
        // A retry is another attempt at the same turn, so it belongs to the same
        // conversation. Losing the session here would orphan the attempt from
        // the chat even though the Node keeps talking to the same Hermes session.
        // A retry is another attempt at the same turn, so it shows the same
        // attachments. The Node re-sends the original structured attachment
        // from its own copy of the request; this keeps the console's view of
        // the replacement run honest about what was sent.
        metadata: {
          retry_of_run_id: run.run_id,
          session_id: run.session_id,
          ...(retriedAttachments.length > 0 ? { attachments: retriedAttachments } : {}),
        },
        sessionId: run.session_id,
        createCommandId: command.command_id,
        retryOfRunId: run.run_id,
        createdByUserId: context.user.user_id,
      });
      await attachmentsRepo.link(
        client,
        replacement.run_id,
        retriedUploads.map((item) => ({
          attachmentId: item.attachment_id,
          position: item.position,
          alt: item.alt,
        })),
      );
      await auditRepo.record(client, {
        action: 'runs.retry',
        actor: context.user.user_id,
        actorUserId: context.user.user_id,
        targetType: 'run',
        targetId: replacement.run_id,
        result: 'accepted',
        correlationId: command.command_id,
        organizationId: context.organization?.organization_id,
        detail: { retry_of_run_id: run.run_id },
      });
      return { command, replacement };
    });
    return reply.code(202).send({
      command_id: created.command.command_id,
      run: created.replacement,
    });
  });

  // ------------------------------------------------------------------- audit

  app.get('/api/v1/audit', async (request, reply) => {
    const context = await requirePermission(request, reply, 'audit.read');
    if (!context?.organization) return reply;
    const query = z
      .object({
        actor: z.string().optional(),
        action: z.string().optional(),
        target_type: z.string().optional(),
        target_id: z.string().optional(),
        result: z.string().optional(),
        correlation_id: z.string().optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        before_id: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_request' });
    const result = await pool.query(
      `SELECT * FROM audit_log WHERE organization_id = $1
         AND ($2::text IS NULL OR actor = $2)
         AND ($3::text IS NULL OR action = $3)
         AND ($4::text IS NULL OR target_type = $4)
         AND ($5::text IS NULL OR target_id = $5)
         AND ($6::text IS NULL OR result = $6)
         AND ($7::text IS NULL OR correlation_id = $7)
         AND ($8::timestamptz IS NULL OR occurred_at >= $8)
         AND ($9::timestamptz IS NULL OR occurred_at <= $9)
         AND ($10::bigint IS NULL OR audit_id < $10)
       ORDER BY occurred_at DESC, audit_id DESC LIMIT $11`,
      [
        context.organization.organization_id,
        query.data.actor ?? null,
        query.data.action ?? null,
        query.data.target_type ?? null,
        query.data.target_id ?? null,
        query.data.result ?? null,
        query.data.correlation_id ?? null,
        query.data.from ?? null,
        query.data.to ?? null,
        query.data.before_id ?? null,
        query.data.limit,
      ],
    );
    return { entries: result.rows };
  });
}
