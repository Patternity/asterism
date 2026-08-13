/**
 * HTTP and WebSocket transport.
 *
 * Route handlers parse, delegate, and render. Everything else — enrollment,
 * dispatch, ingestion — lives in the modules they call.
 *
 * Two authentication surfaces, deliberately separate:
 *
 *   * operator endpoints use a temporary single-operator bearer token;
 *   * the Node enrollment endpoint uses a one-time enrollment token;
 *   * the Node channel uses the Ed25519 handshake and no bearer token at all.
 */
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';

import websocketPlugin from '@fastify/websocket';
import cookiePlugin from '@fastify/cookie';
import staticPlugin from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { type Config, describe as describeConfig } from './config.js';
import { type Pool, currentSchemaVersion, withTransaction } from './db.js';
import { enroll } from './enrollment.js';
import type { Logger } from './logger.js';
import { NodeChannel, TERMINAL_RUN_STATUSES } from './node-channel.js';
import { registerProductApi } from './product-api.js';
import {
  productAuditRepo,
  productEventsRepo,
  productNodesRepo,
  productProjectsRepo,
  productRunsRepo,
} from './product-repositories.js';
import { assertDispatchable, commandFingerprint } from './protocol.js';
import {
  auditRepo,
  commandsRepo,
  enrollmentTokensRepo,
  nodesRepo,
  rotationsRepo,
  runsRepo,
} from './repositories.js';
import { BOOTSTRAP_ORGANIZATION_ID } from './tenancy.js';

export interface AppDependencies {
  pool: Pool;
  config: Config;
  log: Logger;
  channel: NodeChannel;
}

/** Constant-time bearer comparison. */
function bearerMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const { pool, config, log, channel } = deps;

  const app = Fastify({
    logger: false,
    // Forwarded headers are honoured only when a proxy is explicitly declared.
    trustProxy: config.trustProxy,
    bodyLimit: config.maxCommandPayloadBytes,
  });

  await app.register(websocketPlugin, {
    options: { maxPayload: config.maxFrameBytes },
  });
  await app.register(cookiePlugin);

  // Browser security is enforced at the HTTP boundary. Node enrollment and the
  // WebSocket protocol retain their independent authentication surfaces.
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin === 'string' && config.allowedOrigins.includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Vary', 'Origin');
    }
    const isProductMutation =
      request.url.startsWith('/api/v1/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (
      isProductMutation &&
      (typeof origin !== 'string' || !config.allowedOrigins.includes(origin))
    ) {
      return reply
        .code(403)
        .send({ error: 'origin_forbidden', message: 'trusted Origin required' });
    }
    if (request.method === 'OPTIONS' && request.url.startsWith('/api/v1/')) {
      if (typeof origin !== 'string' || !config.allowedOrigins.includes(origin)) {
        return reply.code(403).send({ error: 'origin_forbidden' });
      }
      reply.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, Last-Event-ID');
      return reply.code(204).send();
    }
    const isCompatibilityRequest =
      request.url.startsWith('/v1/') &&
      !request.url.startsWith('/v1/node/') &&
      request.url !== '/v1/node-channel';
    if (config.operatorCompatibility && isCompatibilityRequest) {
      const header = request.headers.authorization;
      if (
        typeof header === 'string' &&
        header.startsWith('Bearer ') &&
        bearerMatches(header.slice('Bearer '.length), config.operatorToken)
      ) {
        reply.header('Deprecation', 'true');
        reply.header('Sunset', 'Phase H compatibility mode');
        await auditRepo.record(pool, {
          action: 'operator_compatibility.use',
          actor: 'operator',
          targetType: 'http_route',
          targetId: request.routeOptions.url ?? request.url.split('?')[0],
          result: 'success',
          organizationId: BOOTSTRAP_ORGANIZATION_ID,
          detail: { method: request.method },
        });
        log.warn('deprecated operator compatibility API used', {
          method: request.method,
          path: request.url.split('?')[0],
        });
      }
    }
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
    );
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    return payload;
  });

  await registerProductApi(app, { pool, config, channel });

  /** Operator guard. Returns false and answers the request when unauthorized. */
  const requireOperator = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (!config.operatorCompatibility) {
      void reply.code(404).send({ error: 'not_found' });
      return false;
    }
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      void reply
        .code(401)
        .send({ error: 'unauthorized', message: 'operator bearer token required' });
      return false;
    }
    if (!bearerMatches(header.slice('Bearer '.length), config.operatorToken)) {
      void reply.code(401).send({ error: 'unauthorized', message: 'invalid operator token' });
      return false;
    }
    return true;
  };

  // ------------------------------------------------------------- health

  /** Public liveness. Deliberately minimal: no versions, no counts, no config. */
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/v1/health', async (request, reply) => {
    if (!requireOperator(request, reply)) return reply;
    const metrics = channel.snapshot();
    return {
      status: 'ok',
      schema_version: await currentSchemaVersion(pool),
      queued_commands: Number(
        (
          await pool.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM remote_commands
             WHERE organization_id = $1 AND state = 'queued'`,
            [BOOTSTRAP_ORGANIZATION_ID],
          )
        ).rows[0]?.count ?? 0,
      ),
      ingested_events: Number(
        (
          await pool.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM run_events e JOIN runs r USING (run_id)
             WHERE r.organization_id = $1`,
            [BOOTSTRAP_ORGANIZATION_ID],
          )
        ).rows[0]?.count ?? 0,
      ),
      channel: metrics,
      config: describeConfig(config),
    };
  });

  // -------------------------------------------------- enrollment tokens

  const CreateTokenSchema = z.object({
    intended_name: z.string().max(128).optional(),
    purpose: z.enum(['enrollment', 'recovery']).optional(),
    ttl_ms: z
      .number()
      .int()
      .positive()
      .max(7 * 24 * 60 * 60 * 1000)
      .optional(),
  });

  app.post('/v1/enrollment-tokens', async (request, reply) => {
    if (!requireOperator(request, reply)) return reply;
    const parsed = CreateTokenSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', message: parsed.error.message });
    }

    const created = await enrollmentTokensRepo.create(pool, {
      ttlMs: parsed.data.ttl_ms ?? config.enrollmentTokenTtlMs,
      intendedName: parsed.data.intended_name,
      purpose: parsed.data.purpose,
      organizationId: BOOTSTRAP_ORGANIZATION_ID,
    });
    await auditRepo.record(pool, {
      action: 'enrollment_token.create',
      actor: 'operator',
      targetType: 'enrollment_token',
      targetId: created.record.token_id,
      result: 'success',
      detail: { purpose: created.record.purpose, intended_name: created.record.intended_name },
    });

    // The only time the plaintext token is ever returned.
    return reply.code(201).send({
      token_id: created.record.token_id,
      token: created.token,
      expires_at: created.record.expires_at,
      purpose: created.record.purpose,
    });
  });

  app.get('/v1/enrollment-tokens', async (request, reply) => {
    if (!requireOperator(request, reply)) return reply;
    const tokens = await enrollmentTokensRepo.list(pool, BOOTSTRAP_ORGANIZATION_ID);
    // Metadata only: the digest never leaves the database.
    return {
      tokens: tokens.map((token) => ({
        token_id: token.token_id,
        created_at: token.created_at,
        expires_at: token.expires_at,
        consumed_at: token.consumed_at,
        consumed_by: token.consumed_by,
        revoked_at: token.revoked_at,
        intended_name: token.intended_name,
        purpose: token.purpose,
      })),
    };
  });

  app.post<{ Params: { id: string } }>(
    '/v1/enrollment-tokens/:id/revoke',
    async (request, reply) => {
      if (!requireOperator(request, reply)) return reply;
      const revoked = await enrollmentTokensRepo.revoke(
        pool,
        request.params.id,
        BOOTSTRAP_ORGANIZATION_ID,
      );
      await auditRepo.record(pool, {
        action: 'enrollment_token.revoke',
        actor: 'operator',
        targetType: 'enrollment_token',
        targetId: request.params.id,
        result: revoked ? 'success' : 'not_applicable',
      });
      if (!revoked) {
        return reply.code(409).send({
          error: 'token_not_revocable',
          message: 'token is consumed, revoked, or unknown',
        });
      }
      return { revoked: true };
    },
  );

  // ------------------------------------------------------ node enrollment

  app.post('/v1/node/enroll', async (request, reply) => {
    const header = request.headers.authorization;
    const token =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length).trim()
        : '';
    if (!token) {
      return reply.code(401).send({ message: 'enrollment token required' });
    }

    const outcome = await enroll(pool, { token, body: request.body, log });
    if (!outcome.ok) {
      return reply.code(outcome.status).send({ message: outcome.message });
    }

    // A rotation invalidates the live session: it was authenticated with the key
    // that was just superseded. Dropping it forces a handshake under the new
    // key, so a stolen old key cannot keep an already-open session alive.
    if (outcome.body.rotated === true && typeof outcome.body.node_id === 'string') {
      await channel.disconnect(outcome.body.node_id, 'identity_rotated');
    }
    return reply.code(200).send(outcome.body);
  });

  // -------------------------------------------------------- node channel

  /**
   * The Node dials this path. `/v1/node/session` is what the protocol
   * specification names and what the Rust Node builds from its base URL;
   * `/v1/node-channel` is accepted as an alias.
   */
  for (const path of ['/v1/node/session', '/v1/node-channel']) {
    app.get(path, { websocket: true }, (socket, request) => {
      const remote = config.trustProxy
        ? ((request.headers['x-forwarded-for'] as string | undefined) ?? request.ip)
        : request.ip;
      void channel.handleConnection(socket, remote ?? null);
    });
  }

  // -------------------------------------------------------- nodes/projects

  app.get('/v1/nodes', async (request, reply) => {
    if (!requireOperator(request, reply)) return reply;
    const nodes = await productNodesRepo.list(pool, BOOTSTRAP_ORGANIZATION_ID);
    return { nodes: nodes.map((node) => renderNode(node, channel)) };
  });

  app.get<{ Params: { nodeId: string } }>('/v1/nodes/:nodeId', async (request, reply) => {
    if (!requireOperator(request, reply)) return reply;
    const node = await productNodesRepo.byId(
      pool,
      BOOTSTRAP_ORGANIZATION_ID,
      request.params.nodeId,
    );
    if (!node) return reply.code(404).send({ error: 'node_not_found' });
    return { node: renderNode(node, channel) };
  });

  app.get<{ Params: { nodeId: string } }>('/v1/nodes/:nodeId/projects', async (request, reply) => {
    if (!requireOperator(request, reply)) return reply;
    const node = await productNodesRepo.byId(
      pool,
      BOOTSTRAP_ORGANIZATION_ID,
      request.params.nodeId,
    );
    if (!node) return reply.code(404).send({ error: 'node_not_found' });
    return {
      projects: (await productProjectsRepo.list(pool, BOOTSTRAP_ORGANIZATION_ID)).filter(
        (project) => project.node_id === request.params.nodeId,
      ),
    };
  });

  app.post<{ Params: { nodeId: string }; Body: { reason?: string } }>(
    '/v1/nodes/:nodeId/revoke',
    async (request, reply) => {
      if (!requireOperator(request, reply)) return reply;
      const node = await productNodesRepo.byId(
        pool,
        BOOTSTRAP_ORGANIZATION_ID,
        request.params.nodeId,
      );
      if (!node) return reply.code(404).send({ error: 'node_not_found' });
      const reason = request.body?.reason ?? 'operator revocation';
      await nodesRepo.revoke(pool, request.params.nodeId, reason);
      await auditRepo.record(pool, {
        action: 'node.revoke',
        actor: 'operator',
        targetType: 'node',
        targetId: request.params.nodeId,
        result: 'success',
        detail: { reason },
      });
      await channel.disconnect(request.params.nodeId, 'node_revoked');
      return { revoked: true };
    },
  );

  app.get('/v1/projects', async (request, reply) => {
    if (!requireOperator(request, reply)) return reply;
    return { projects: await productProjectsRepo.list(pool, BOOTSTRAP_ORGANIZATION_ID) };
  });

  app.get<{ Params: { projectId: string } }>('/v1/projects/:projectId', async (request, reply) => {
    if (!requireOperator(request, reply)) return reply;
    const project = await productProjectsRepo.byId(
      pool,
      BOOTSTRAP_ORGANIZATION_ID,
      request.params.projectId,
    );
    if (!project) return reply.code(404).send({ error: 'project_not_found' });
    return { project };
  });

  // ---------------------------------------------------------------- runs

  const CreateRunSchema = z.object({
    input: z.string().min(1),
    session_id: z.string().max(128).optional(),
    instructions: z.string().max(64_000).optional(),
    idempotency_key: z.string().max(128).optional(),
  });

  app.post<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/runs',
    async (request, reply) => {
      if (!requireOperator(request, reply)) return reply;
      const parsed = CreateRunSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', message: parsed.error.message });
      }
      const project = await productProjectsRepo.byId(
        pool,
        BOOTSTRAP_ORGANIZATION_ID,
        request.params.projectId,
      );
      if (!project) return reply.code(404).send({ error: 'project_not_found' });

      const payload = {
        input: parsed.data.input,
        session_id: parsed.data.session_id ?? null,
        instructions: parsed.data.instructions ?? null,
        // The Node deduplicates on its own key too, so a lost response cannot
        // create a second run.
        idempotency_key: parsed.data.idempotency_key ?? null,
      };

      try {
        assertDispatchable('runs.create', payload);
      } catch (error) {
        return reply.code(422).send({ error: 'invalid_command', message: String(error) });
      }

      // Reusing an idempotency key returns the original run rather than
      // creating a second command.
      if (parsed.data.idempotency_key) {
        const existing = await commandsRepo.byIdempotencyKey(
          pool,
          project.node_id,
          parsed.data.idempotency_key,
        );
        if (existing) {
          const digest = commandFingerprint('runs.create', project.node_project_id, payload);
          if (existing.payload_digest !== digest) {
            return reply.code(409).send({
              error: 'idempotency_conflict',
              message: 'this idempotency key was used with a different request',
            });
          }
          const run = await findRunByCommand(pool, existing.command_id, BOOTSTRAP_ORGANIZATION_ID);
          return reply.code(200).send({ run, command_id: existing.command_id, replayed: true });
        }
      }

      const created = await withTransaction(pool, async (client) => {
        const command = await commandsRepo.create(client, {
          nodeId: project.node_id,
          projectId: project.project_id,
          commandType: 'runs.create',
          payload,
          digest: commandFingerprint('runs.create', project.node_project_id, payload),
          idempotencyKey: parsed.data.idempotency_key,
        });
        const run = await runsRepo.create(client, {
          nodeId: project.node_id,
          projectId: project.project_id,
          metadata: { input_length: parsed.data.input.length, session_id: payload.session_id },
          createCommandId: command.command_id,
        });
        await auditRepo.record(client, {
          action: 'run.create',
          actor: 'operator',
          targetType: 'run',
          targetId: run.run_id,
          result: 'success',
          correlationId: command.command_id,
        });
        return { command, run };
      });

      return reply.code(201).send({
        run: created.run,
        command_id: created.command.command_id,
        // A queued run is normal while the Node is offline.
        node_online: channel.isOnline(project.node_id),
      });
    },
  );

  app.get<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/runs',
    async (request, reply) => {
      if (!requireOperator(request, reply)) return reply;
      const project = await productProjectsRepo.byId(
        pool,
        BOOTSTRAP_ORGANIZATION_ID,
        request.params.projectId,
      );
      if (!project) return reply.code(404).send({ error: 'project_not_found' });
      return {
        runs: await runsRepo.listByProject(
          pool,
          request.params.projectId,
          100,
          BOOTSTRAP_ORGANIZATION_ID,
        ),
      };
    },
  );

  app.get<{ Params: { projectId: string; runId: string } }>(
    '/v1/projects/:projectId/runs/:runId',
    async (request, reply) => {
      if (!requireOperator(request, reply)) return reply;
      const run = await loadRun(
        pool,
        request.params.projectId,
        request.params.runId,
        BOOTSTRAP_ORGANIZATION_ID,
      );
      if (!run) return reply.code(404).send({ error: 'run_not_found' });
      return { run };
    },
  );

  app.get<{
    Params: { projectId: string; runId: string };
    Querystring: { since_seq?: string; limit?: string };
  }>('/v1/projects/:projectId/runs/:runId/events', async (request, reply) => {
    if (!requireOperator(request, reply)) return reply;
    const run = await loadRun(
      pool,
      request.params.projectId,
      request.params.runId,
      BOOTSTRAP_ORGANIZATION_ID,
    );
    if (!run) return reply.code(404).send({ error: 'run_not_found' });

    const since = Number(request.query.since_seq ?? 0);
    if (!Number.isInteger(since) || since < 0) {
      return reply.code(400).send({ error: 'invalid_cursor' });
    }
    const limit = Math.min(Number(request.query.limit ?? config.eventBatchSize), 1000);
    const events = await productEventsRepo.since(
      pool,
      BOOTSTRAP_ORGANIZATION_ID,
      run.run_id,
      since,
      limit,
    );
    return { run_id: run.run_id, since_seq: since, events };
  });

  /**
   * Operator SSE.
   *
   * Replays from PostgreSQL, so a slow operator client never delays
   * acknowledgements to the Node — the two paths are completely decoupled.
   * `Last-Event-ID` carries the Node event `seq`.
   */
  app.get<{
    Params: { projectId: string; runId: string };
    Querystring: { since_seq?: string };
  }>('/v1/projects/:projectId/runs/:runId/events/stream', async (request, reply) => {
    if (!requireOperator(request, reply)) return reply;
    const run = await loadRun(
      pool,
      request.params.projectId,
      request.params.runId,
      BOOTSTRAP_ORGANIZATION_ID,
    );
    if (!run) return reply.code(404).send({ error: 'run_not_found' });

    const headerCursor = request.headers['last-event-id'];
    const cursor = Number(
      (typeof headerCursor === 'string' ? headerCursor : undefined) ?? request.query.since_seq ?? 0,
    );
    if (!Number.isInteger(cursor) || cursor < 0) {
      return reply.code(400).send({ error: 'invalid_cursor' });
    }

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    let position = cursor;
    let closed = false;
    request.raw.on('close', () => {
      closed = true;
    });

    while (!closed) {
      const batch = await productEventsRepo.since(
        pool,
        BOOTSTRAP_ORGANIZATION_ID,
        run.run_id,
        position,
        config.eventBatchSize,
      );
      for (const event of batch) {
        const seq = Number(event.seq);
        reply.raw.write(
          `id: ${seq}\nevent: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
        position = seq;
      }

      const current = await productRunsRepo.byId(pool, BOOTSTRAP_ORGANIZATION_ID, run.run_id);
      const terminal = ['completed', 'failed', 'cancelled', 'interrupted', 'lost'].includes(
        current?.status ?? '',
      );
      if (terminal && batch.length === 0) {
        reply.raw.write(`: run terminal (${current?.status})\n\n`);
        break;
      }
      if (batch.length === 0) {
        reply.raw.write(': heartbeat\n\n');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    reply.raw.end();
    return reply;
  });

  // Approval, cancellation, retry all become durable commands.
  const simpleCommand = (
    path: string,
    commandType: string,
    build: (body: Record<string, unknown>, nodeRunId: string) => Record<string, unknown>,
    schema: z.ZodTypeAny,
  ) => {
    app.post<{ Params: { projectId: string; runId: string } }>(path, async (request, reply) => {
      if (!requireOperator(request, reply)) return reply;
      const parsed = schema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', message: parsed.error.message });
      }
      const run = await loadRun(
        pool,
        request.params.projectId,
        request.params.runId,
        BOOTSTRAP_ORGANIZATION_ID,
      );
      if (!run) return reply.code(404).send({ error: 'run_not_found' });
      if (!run.node_run_id) {
        return reply
          .code(409)
          .send({ error: 'run_not_started', message: 'the Node has not accepted this run yet' });
      }
      const project = await productProjectsRepo.byId(
        pool,
        BOOTSTRAP_ORGANIZATION_ID,
        run.project_id,
      );
      if (!project) return reply.code(404).send({ error: 'project_not_found' });

      const payload = build(parsed.data as Record<string, unknown>, run.node_run_id);
      const command = await commandsRepo.create(pool, {
        nodeId: run.node_id,
        projectId: run.project_id,
        commandType,
        payload,
        digest: commandFingerprint(commandType, project.node_project_id, payload),
      });
      await auditRepo.record(pool, {
        action: commandType,
        actor: 'operator',
        targetType: 'run',
        targetId: run.run_id,
        result: 'accepted',
        correlationId: command.command_id,
      });
      return reply.code(202).send({ command_id: command.command_id, run_id: run.run_id });
    });
  };

  simpleCommand(
    '/v1/projects/:projectId/runs/:runId/approval',
    'approvals.resolve',
    (body, nodeRunId) => ({ run_id: nodeRunId, choice: body.choice }),
    z.object({ choice: z.enum(['once', 'session', 'always', 'deny']) }),
  );
  simpleCommand(
    '/v1/projects/:projectId/runs/:runId/cancel',
    'runs.cancel',
    (_body, nodeRunId) => ({ run_id: nodeRunId }),
    z.object({}).passthrough(),
  );
  simpleCommand(
    '/v1/projects/:projectId/runs/:runId/retry',
    'runs.retry',
    (_body, nodeRunId) => ({ run_id: nodeRunId }),
    z.object({}).passthrough(),
  );

  /**
   * Runs the Control Plane still shows as active whose Node has gone silent.
   *
   * A run ends only when its Node says so. If the Node never returns, nothing
   * ever says so — an operator needs to see these and close them deliberately
   * rather than have the Control Plane guess an outcome it did not observe.
   */
  app.get('/v1/runs/stranded', async (request, reply) => {
    if (!requireOperator(request, reply)) return reply;
    const query = request.query as { stale_ms?: string };
    const staleMs = Number(query.stale_ms ?? 300_000);
    if (!Number.isFinite(staleMs) || staleMs < 0) {
      return reply.code(400).send({ error: 'invalid_request', message: 'stale_ms must be >= 0' });
    }

    const runs = await runsRepo.staleActive(pool, staleMs, BOOTSTRAP_ORGANIZATION_ID);
    return {
      stale_ms: staleMs,
      runs: runs.map((run) => ({
        run_id: run.run_id,
        node_id: run.node_id,
        project_id: run.project_id,
        status: run.status,
        created_at: run.created_at,
        node_last_seen_at: run.last_seen_at,
        node_online: channel.isOnline(run.node_id),
      })),
    };
  });

  /**
   * Administratively close a stranded run.
   *
   * Deliberately never automatic. The outcome is recorded as `lost` with an
   * explicit operator reason, because the Control Plane genuinely does not know
   * what the run did — claiming `failed` or `cancelled` would assert more than
   * it observed. Refused while the Node is online: ask the Node instead.
   */
  app.post('/v1/runs/:runId/force-close', async (request, reply) => {
    if (!requireOperator(request, reply)) return reply;
    const { runId } = request.params as { runId: string };
    const body = (request.body ?? {}) as { reason?: string };
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : '';
    if (!reason) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', message: 'an explicit reason is required' });
    }

    return withTransaction(pool, async (client) => {
      const run = await productRunsRepo.byId(client, BOOTSTRAP_ORGANIZATION_ID, runId);
      if (!run) return reply.code(404).send({ error: 'not_found', message: 'unknown run' });
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        return reply
          .code(409)
          .send({ error: 'already_terminal', message: `run is already ${run.status}` });
      }
      if (channel.isOnline(run.node_id)) {
        return reply.code(409).send({
          error: 'node_online',
          message: 'the Node is connected; cancel the run through it instead of forcing it closed',
        });
      }

      await runsRepo.setStatus(client, runId, 'lost', {
        terminalReason: 'operator_force_close',
        errorCode: 'operator_force_close',
        errorMessage: reason,
      });
      await runsRepo.setSubscribed(client, runId, false);
      await auditRepo.record(client, {
        action: 'run.force_close',
        actor: 'operator',
        targetType: 'run',
        targetId: runId,
        result: 'success',
        detail: { reason, previous_status: run.status, node_id: run.node_id },
      });

      log.warn('run force-closed by operator', {
        run_id: runId,
        node_id: run.node_id,
        previous_status: run.status,
      });
      return { run_id: runId, status: 'lost', terminal_reason: 'operator_force_close' };
    });
  });

  /**
   * Issue a rotation token for one enrolled Node.
   *
   * Bound to that Node, single-use, and short-lived. Rotation deliberately does
   * not travel over the authenticated channel: the case that matters most is a
   * key that is already compromised or lost, when that channel is exactly what
   * cannot be trusted.
   */
  app.post('/v1/nodes/:nodeId/rotation-token', async (request, reply) => {
    if (!requireOperator(request, reply)) return reply;
    const { nodeId } = request.params as { nodeId: string };

    return withTransaction(pool, async (client) => {
      const node = await productNodesRepo.byId(client, BOOTSTRAP_ORGANIZATION_ID, nodeId);
      if (!node) return reply.code(404).send({ error: 'not_found', message: 'unknown node' });
      if (node.revoked_at) {
        return reply
          .code(409)
          .send({ error: 'revoked', message: 'a revoked identity cannot be rotated; re-enroll' });
      }

      const { record, token } = await enrollmentTokensRepo.create(client, {
        ttlMs: config.enrollmentTokenTtlMs,
        purpose: 'rotation',
        boundNodeId: nodeId,
        intendedName: node.display_name,
        organizationId: BOOTSTRAP_ORGANIZATION_ID,
      });
      await auditRepo.record(client, {
        action: 'node.rotation_token.issue',
        actor: 'operator',
        targetType: 'node',
        targetId: nodeId,
        result: 'success',
        detail: { token_id: record.token_id, current_fingerprint: node.fingerprint },
      });

      // The only time the plaintext token exists outside the caller's memory.
      return reply.code(201).send({
        token_id: record.token_id,
        token,
        node_id: nodeId,
        expires_at: record.expires_at,
        current_fingerprint: node.fingerprint,
        identity_generation: node.identity_generation,
      });
    });
  });

  /** Rotation history for one Node. Keys only, never private material. */
  app.get('/v1/nodes/:nodeId/rotations', async (request, reply) => {
    if (!requireOperator(request, reply)) return reply;
    const { nodeId } = request.params as { nodeId: string };
    const node = await productNodesRepo.byId(pool, BOOTSTRAP_ORGANIZATION_ID, nodeId);
    if (!node) return reply.code(404).send({ error: 'not_found', message: 'unknown node' });

    const rotations = await rotationsRepo.listForNode(pool, nodeId);
    return {
      node_id: nodeId,
      identity_generation: node.identity_generation,
      current_fingerprint: node.fingerprint,
      rotations: rotations.map((rotation) => ({
        rotation_id: rotation.rotation_id,
        state: rotation.state,
        old_fingerprint: rotation.old_fingerprint,
        new_fingerprint: rotation.proposed_fingerprint,
        created_at: rotation.created_at,
        completed_at: rotation.completed_at,
      })),
    };
  });

  app.get('/v1/audit', async (request, reply) => {
    if (!requireOperator(request, reply)) return reply;
    return { entries: await productAuditRepo.recent(pool, BOOTSTRAP_ORGANIZATION_ID, 100) };
  });

  if (config.staticRoot) {
    await app.register(staticPlugin, {
      root: path.resolve(config.staticRoot),
      cacheControl: true,
      immutable: true,
      maxAge: '1y',
    });
    app.setNotFoundHandler(async (request, reply) => {
      const pathname = request.url.split('?')[0] ?? request.url;
      const isApiPath =
        pathname === '/health' || pathname.startsWith('/api/') || pathname.startsWith('/v1/');
      const acceptsHtml = request.headers.accept?.includes('text/html') ?? false;
      if (request.method !== 'GET' || isApiPath || !acceptsHtml) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply
        .header('Cache-Control', 'no-cache')
        .type('text/html; charset=utf-8')
        .sendFile('index.html');
    });
  }

  return app;
}

function renderNode(
  node: Awaited<ReturnType<typeof nodesRepo.byId>>,
  channel: NodeChannel,
): Record<string, unknown> {
  if (!node) return {};
  return {
    node_id: node.node_id,
    display_name: node.display_name,
    fingerprint: node.fingerprint,
    identity_generation: node.identity_generation,
    enrolled_at: node.enrolled_at,
    revoked_at: node.revoked_at,
    last_seen_at: node.last_seen_at,
    software_version: node.software_version,
    protocol_version: node.protocol_version,
    draining: node.draining,
    // The live socket is the authority on "online"; the column can lag a crash.
    connection_state: node.revoked_at
      ? 'revoked'
      : channel.isOnline(node.node_id)
        ? node.draining
          ? 'draining'
          : 'online'
        : 'offline',
  };
}

async function loadRun(pool: Pool, projectId: string, runId: string, organizationId: string) {
  const run = await productRunsRepo.byId(pool, organizationId, runId);
  if (!run || run.project_id !== projectId) return null;
  return run;
}

async function findRunByCommand(pool: Pool, commandId: string, organizationId: string) {
  const result = await pool.query(
    'SELECT * FROM runs WHERE organization_id = $1 AND create_command_id = $2',
    [organizationId, commandId],
  );
  return result.rows[0] ?? null;
}
