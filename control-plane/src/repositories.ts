/**
 * PostgreSQL repositories.
 *
 * Every statement is parameterised, every multi-row state change runs inside a
 * transaction supplied by the caller, and nothing here knows about HTTP or
 * WebSockets. Services compose these; route handlers never touch them directly.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from './db.js';
import { BOOTSTRAP_ORGANIZATION_ID } from './tenancy.js';

export type Queryable = Pool | PoolClient;

// ------------------------------------------------------------------ nodes

export interface NodeRecord {
  organization_id: string;
  node_id: string;
  display_name: string;
  public_key: string;
  fingerprint: string;
  identity_generation: number;
  enrolled_at: Date;
  revoked_at: Date | null;
  revocation_reason: string | null;
  last_seen_at: Date | null;
  last_session_id: string | null;
  software_version: string | null;
  protocol_version: number | null;
  instance_id: string | null;
  capabilities: Record<string, unknown>;
  connection_state: string;
  draining: boolean;
  metadata: Record<string, unknown>;
}

export const nodesRepo = {
  async byId(db: Queryable, nodeId: string): Promise<NodeRecord | null> {
    const result = await db.query<NodeRecord>('SELECT * FROM nodes WHERE node_id = $1', [nodeId]);
    return result.rows[0] ?? null;
  },

  async list(db: Queryable): Promise<NodeRecord[]> {
    const result = await db.query<NodeRecord>('SELECT * FROM nodes ORDER BY enrolled_at');
    return result.rows;
  },

  async create(
    db: Queryable,
    input: {
      nodeId: string;
      displayName: string;
      publicKey: string;
      fingerprint: string;
      organizationId?: string;
    },
  ): Promise<NodeRecord> {
    const result = await db.query<NodeRecord>(
      `INSERT INTO nodes (node_id, display_name, public_key, fingerprint, organization_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [
        input.nodeId,
        input.displayName,
        input.publicKey,
        input.fingerprint,
        input.organizationId ?? BOOTSTRAP_ORGANIZATION_ID,
      ],
    );
    if (!result.rows[0]) throw new Error('node insert returned no row');
    return result.rows[0];
  },

  /** Record what the Node reported about itself after authentication. */
  async recordSession(
    db: Queryable,
    nodeId: string,
    input: {
      sessionId: string;
      instanceId: string;
      softwareVersion: string;
      protocolVersion: number;
      capabilities: unknown;
    },
  ): Promise<void> {
    await db.query(
      `UPDATE nodes SET
         last_session_id = $2, instance_id = $3, software_version = $4,
         protocol_version = $5, capabilities = $6::jsonb,
         connection_state = 'online', last_seen_at = now()
       WHERE node_id = $1`,
      [
        nodeId,
        input.sessionId,
        input.instanceId,
        input.softwareVersion,
        input.protocolVersion,
        JSON.stringify(input.capabilities ?? {}),
      ],
    );
  },

  /**
   * Record the capability set the Node reported.
   *
   * Separate from `recordSession` because the handshake only carries a digest;
   * the set itself arrives later, as the result of `capabilities.get`.
   */
  async recordCapabilities(
    db: Queryable,
    nodeId: string,
    capabilities: Record<string, unknown>,
  ): Promise<void> {
    await db.query('UPDATE nodes SET capabilities = $2::jsonb WHERE node_id = $1', [
      nodeId,
      JSON.stringify(capabilities),
    ]);
  },

  async setConnectionState(db: Queryable, nodeId: string, state: string): Promise<void> {
    await db.query(
      'UPDATE nodes SET connection_state = $2, last_seen_at = now() WHERE node_id = $1',
      [nodeId, state],
    );
  },

  async setDraining(db: Queryable, nodeId: string, draining: boolean): Promise<void> {
    await db.query('UPDATE nodes SET draining = $2 WHERE node_id = $1', [nodeId, draining]);
  },

  async touch(db: Queryable, nodeId: string): Promise<void> {
    await db.query('UPDATE nodes SET last_seen_at = now() WHERE node_id = $1', [nodeId]);
  },

  async revoke(db: Queryable, nodeId: string, reason: string): Promise<void> {
    await db.query(
      `UPDATE nodes SET revoked_at = now(), revocation_reason = $2,
              connection_state = 'offline'
       WHERE node_id = $1 AND revoked_at IS NULL`,
      [nodeId, reason],
    );
  },

  /** Atomically replace the active identity and bump the generation. */
  async rotateIdentity(
    db: Queryable,
    nodeId: string,
    publicKey: string,
    fingerprint: string,
  ): Promise<void> {
    await db.query(
      `UPDATE nodes SET public_key = $2, fingerprint = $3,
              identity_generation = identity_generation + 1
       WHERE node_id = $1`,
      [nodeId, publicKey, fingerprint],
    );
  },
};

// ------------------------------------------------------- enrollment tokens

export interface EnrollmentTokenRecord {
  organization_id: string;
  token_id: string;
  token_digest: string;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
  consumed_by: string | null;
  revoked_at: Date | null;
  intended_name: string | null;
  purpose: string;
  created_by: string | null;
  /** Set only for `rotation` tokens: the Node this token may re-key. */
  bound_node_id: string | null;
}

/** SHA-256 of the token. Only the digest is ever stored. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export const enrollmentTokensRepo = {
  async create(
    db: Queryable,
    input: {
      ttlMs: number;
      intendedName?: string;
      purpose?: string;
      createdBy?: string;
      boundNodeId?: string;
      organizationId?: string;
    },
  ): Promise<{ record: EnrollmentTokenRecord; token: string }> {
    const token = generateToken();
    const result = await db.query<EnrollmentTokenRecord>(
      `INSERT INTO enrollment_tokens (token_id, token_digest, expires_at, intended_name,
                                      purpose, created_by, bound_node_id, organization_id)
       VALUES ($1, $2, now() + ($3::bigint || ' milliseconds')::interval, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        randomUUID(),
        hashToken(token),
        String(input.ttlMs),
        input.intendedName ?? null,
        input.purpose ?? 'enrollment',
        input.createdBy ?? 'operator',
        input.boundNodeId ?? null,
        input.organizationId ?? BOOTSTRAP_ORGANIZATION_ID,
      ],
    );
    if (!result.rows[0]) throw new Error('token insert returned no row');
    return { record: result.rows[0], token };
  },

  async list(db: Queryable, organizationId?: string): Promise<EnrollmentTokenRecord[]> {
    const result = organizationId
      ? await db.query<EnrollmentTokenRecord>(
          `SELECT * FROM enrollment_tokens WHERE organization_id = $1
           ORDER BY created_at DESC LIMIT 200`,
          [organizationId],
        )
      : await db.query<EnrollmentTokenRecord>(
          'SELECT * FROM enrollment_tokens ORDER BY created_at DESC LIMIT 200',
        );
    return result.rows;
  },

  async revoke(db: Queryable, tokenId: string, organizationId?: string): Promise<boolean> {
    const result = await db.query(
      `UPDATE enrollment_tokens SET revoked_at = now()
       WHERE token_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL
         AND ($2::text IS NULL OR organization_id = $2)`,
      [tokenId, organizationId ?? null],
    );
    return (result.rowCount ?? 0) > 0;
  },

  /**
   * Claim a token for exclusive use inside the caller's transaction.
   *
   * `FOR UPDATE` plus the `consumed_at IS NULL` predicate is what makes two
   * simultaneous enrollments with the same token enroll at most one Node: the
   * second transaction blocks, then sees the row already consumed.
   */
  async claim(client: PoolClient, token: string): Promise<EnrollmentTokenRecord | null> {
    const result = await client.query<EnrollmentTokenRecord>(
      `SELECT * FROM enrollment_tokens
       WHERE token_digest = $1 AND consumed_at IS NULL AND revoked_at IS NULL
         AND expires_at > now()
       FOR UPDATE`,
      [hashToken(token)],
    );
    return result.rows[0] ?? null;
  },

  async markConsumed(client: PoolClient, tokenId: string, nodeId: string): Promise<void> {
    await client.query(
      'UPDATE enrollment_tokens SET consumed_at = now(), consumed_by = $2 WHERE token_id = $1',
      [tokenId, nodeId],
    );
  },
};

// --------------------------------------------------------------- sessions

export const sessionsRepo = {
  async open(
    db: Queryable,
    input: { sessionId: string; nodeId: string; remoteAddress: string | null },
  ): Promise<void> {
    await db.query(
      `INSERT INTO node_sessions (session_id, node_id, remote_address) VALUES ($1, $2, $3)`,
      [input.sessionId, input.nodeId, input.remoteAddress],
    );
  },

  async authenticate(
    db: Queryable,
    sessionId: string,
    input: { protocolVersion: number; instanceId: string; capabilitiesDigest: string },
  ): Promise<void> {
    await db.query(
      `UPDATE node_sessions SET authenticated_at = now(), protocol_version = $2,
              instance_id = $3, capabilities_digest = $4
       WHERE session_id = $1`,
      [sessionId, input.protocolVersion, input.instanceId, input.capabilitiesDigest],
    );
  },

  async close(db: Queryable, sessionId: string, reason: string): Promise<void> {
    await db.query(
      `UPDATE node_sessions SET disconnected_at = now(), disconnect_reason = $2
       WHERE session_id = $1 AND disconnected_at IS NULL`,
      [sessionId, reason],
    );
  },

  async heartbeat(db: Queryable, sessionId: string): Promise<void> {
    await db.query('UPDATE node_sessions SET last_heartbeat_at = now() WHERE session_id = $1', [
      sessionId,
    ]);
  },
};

// --------------------------------------------------------------- projects

export interface ProjectRecord {
  organization_id: string;
  project_id: string;
  node_id: string;
  node_project_id: string;
  display_name: string;
  enabled: boolean;
  available: boolean;
  first_seen_at: Date;
  last_seen_at: Date;
  metadata: Record<string, unknown>;
}

export const projectsRepo = {
  async byId(db: Queryable, projectId: string): Promise<ProjectRecord | null> {
    const result = await db.query<ProjectRecord>('SELECT * FROM projects WHERE project_id = $1', [
      projectId,
    ]);
    return result.rows[0] ?? null;
  },

  async list(db: Queryable, nodeId?: string): Promise<ProjectRecord[]> {
    const result = nodeId
      ? await db.query<ProjectRecord>(
          'SELECT * FROM projects WHERE node_id = $1 ORDER BY node_project_id',
          [nodeId],
        )
      : await db.query<ProjectRecord>('SELECT * FROM projects ORDER BY node_id, node_project_id');
    return result.rows;
  },

  async upsert(
    db: Queryable,
    input: {
      nodeId: string;
      nodeProjectId: string;
      displayName: string;
      enabled: boolean;
      metadata: unknown;
    },
  ): Promise<ProjectRecord> {
    const result = await db.query<ProjectRecord>(
      `INSERT INTO projects (project_id, node_id, node_project_id, display_name, enabled,
                             available, metadata, organization_id)
       VALUES ($1, $2, $3, $4, $5, TRUE, $6::jsonb,
               (SELECT organization_id FROM nodes WHERE node_id = $2))
       ON CONFLICT (node_id, node_project_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         enabled = EXCLUDED.enabled,
         available = TRUE,
         last_seen_at = now(),
         metadata = EXCLUDED.metadata
       RETURNING *`,
      [
        randomUUID(),
        input.nodeId,
        input.nodeProjectId,
        input.displayName,
        input.enabled,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    if (!result.rows[0]) throw new Error('project upsert returned no row');
    return result.rows[0];
  },

  /**
   * Mark projects absent from a **complete** inventory snapshot as unavailable.
   *
   * History is preserved: the row and its runs stay, only availability changes.
   */
  async markAbsentUnavailable(
    db: Queryable,
    nodeId: string,
    presentNodeProjectIds: string[],
  ): Promise<number> {
    const result = await db.query(
      `UPDATE projects SET available = FALSE
       WHERE node_id = $1 AND NOT (node_project_id = ANY($2::text[])) AND available = TRUE`,
      [nodeId, presentNodeProjectIds],
    );
    return result.rowCount ?? 0;
  },
};

// --------------------------------------------------------------- commands

export interface CommandRecord {
  organization_id: string;
  command_id: string;
  node_id: string;
  project_id: string | null;
  command_type: string;
  request_payload: Record<string, unknown>;
  payload_digest: string;
  state: string;
  created_at: Date;
  dispatched_at: Date | null;
  acknowledged_at: Date | null;
  completed_at: Date | null;
  response_payload: Record<string, unknown> | null;
  error_code: string | null;
  error_payload: Record<string, unknown> | null;
  dispatch_count: number;
  correlation_id: string | null;
  idempotency_key: string | null;
}

/** Command states that will never change again. */
export const TERMINAL_COMMAND_STATES = ['completed', 'failed', 'rejected', 'indeterminate'];

export const commandsRepo = {
  async create(
    db: Queryable,
    input: {
      nodeId: string;
      projectId: string | null;
      commandType: string;
      payload: unknown;
      digest: string;
      correlationId?: string;
      idempotencyKey?: string;
    },
  ): Promise<CommandRecord> {
    const result = await db.query<CommandRecord>(
      `INSERT INTO remote_commands (command_id, node_id, project_id, command_type,
                                    request_payload, payload_digest, correlation_id,
                                    idempotency_key, organization_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8,
               (SELECT organization_id FROM nodes WHERE node_id = $2)) RETURNING *`,
      [
        randomUUID(),
        input.nodeId,
        input.projectId,
        input.commandType,
        JSON.stringify(input.payload ?? {}),
        input.digest,
        input.correlationId ?? null,
        input.idempotencyKey ?? null,
      ],
    );
    if (!result.rows[0]) throw new Error('command insert returned no row');
    return result.rows[0];
  },

  async byId(db: Queryable, commandId: string): Promise<CommandRecord | null> {
    const result = await db.query<CommandRecord>(
      'SELECT * FROM remote_commands WHERE command_id = $1',
      [commandId],
    );
    return result.rows[0] ?? null;
  },

  async byIdempotencyKey(
    db: Queryable,
    nodeId: string,
    key: string,
  ): Promise<CommandRecord | null> {
    const result = await db.query<CommandRecord>(
      'SELECT * FROM remote_commands WHERE node_id = $1 AND idempotency_key = $2',
      [nodeId, key],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Claim pending commands for one Node.
   *
   * `FOR UPDATE SKIP LOCKED` keeps the schema usable by more than one Control
   * Plane process later without changing anything here.
   */
  /**
   * Claim queued commands for one Node, fairly across its projects.
   *
   * Strict `ORDER BY created_at` starves projects: fifty commands queued for one
   * project delay every other project behind all fifty. Instead each project's
   * queue is ranked independently and the ranks are interleaved, so a dispatch
   * round takes each project's oldest command before any project's second.
   *
   * The ordering is fully deterministic — `(rank, created_at, command_id)` — so
   * two Control Plane instances claiming concurrently agree on priority, and
   * `FOR UPDATE SKIP LOCKED` keeps them from claiming the same row.
   *
   * Commands with no project (Node-scoped, e.g. `projects.list`) share a single
   * queue under a fixed key, which keeps them from being starved either.
   */
  async claimPending(client: PoolClient, nodeId: string, limit: number): Promise<CommandRecord[]> {
    const result = await client.query<CommandRecord>(
      `SELECT * FROM remote_commands
       WHERE command_id IN (
         SELECT command_id FROM (
           SELECT command_id,
                  created_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY COALESCE(project_id::text, '')
                    ORDER BY created_at, command_id
                  ) AS project_rank
           FROM remote_commands
           WHERE node_id = $1 AND state = 'queued'
         ) ranked
         ORDER BY project_rank, created_at, command_id
         LIMIT $2
       )
       ORDER BY created_at, command_id
       FOR UPDATE SKIP LOCKED`,
      [nodeId, limit],
    );
    return result.rows;
  },

  async markDispatched(db: Queryable, commandId: string): Promise<void> {
    await db.query(
      `UPDATE remote_commands SET state = 'dispatched', dispatched_at = now(),
              dispatch_count = dispatch_count + 1
       WHERE command_id = $1`,
      [commandId],
    );
  },

  async markAccepted(db: Queryable, commandId: string): Promise<void> {
    await db.query(
      `UPDATE remote_commands SET state = 'accepted', acknowledged_at = now()
       WHERE command_id = $1 AND state IN ('queued', 'dispatched')`,
      [commandId],
    );
  },

  /**
   * Record a terminal outcome idempotently.
   *
   * A retransmitted result must not overwrite an already-recorded one, so the
   * update only applies while the command is still open.
   */
  async complete(
    db: Queryable,
    commandId: string,
    input: {
      state: string;
      response: unknown;
      errorCode: string | null;
      errorPayload: unknown;
    },
  ): Promise<CommandRecord | null> {
    const result = await db.query<CommandRecord>(
      `UPDATE remote_commands SET
         state = $2, completed_at = now(), response_payload = $3::jsonb,
         error_code = $4, error_payload = $5::jsonb
       WHERE command_id = $1 AND state NOT IN ('completed', 'failed', 'rejected', 'indeterminate')
       RETURNING *`,
      [
        commandId,
        input.state,
        JSON.stringify(input.response ?? null),
        input.errorCode,
        JSON.stringify(input.errorPayload ?? null),
      ],
    );
    return result.rows[0] ?? null;
  },

  /** Commands dispatched long ago that never reached a terminal state. */
  async staleDispatched(db: Queryable, olderThanMs: number): Promise<CommandRecord[]> {
    const result = await db.query<CommandRecord>(
      `SELECT * FROM remote_commands
       WHERE state IN ('dispatched', 'accepted')
         AND dispatched_at < now() - ($1::bigint || ' milliseconds')::interval`,
      [String(olderThanMs)],
    );
    return result.rows;
  },

  async markIndeterminate(db: Queryable, commandId: string, reason: string): Promise<void> {
    await db.query(
      `UPDATE remote_commands SET state = 'indeterminate', completed_at = now(),
              error_code = 'indeterminate', error_payload = $2::jsonb
       WHERE command_id = $1 AND state IN ('dispatched', 'accepted')`,
      [commandId, JSON.stringify({ reason })],
    );
  },

  async countQueued(db: Queryable): Promise<number> {
    const result = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM remote_commands WHERE state = 'queued'`,
    );
    return Number(result.rows[0]?.count ?? 0);
  },
};

// ------------------------------------------------------------------- runs

export interface RunRecord {
  organization_id: string;
  created_by_user_id: string | null;
  run_id: string;
  node_id: string;
  project_id: string;
  node_run_id: string | null;
  status: string;
  request_metadata: Record<string, unknown>;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  terminal_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  retry_of_run_id: string | null;
  /** Conversation this run belongs to. `null` for runs created before chat. */
  session_id: string | null;
  last_event_seq: string | number;
  acked_event_seq: string | number;
  create_command_id: string | null;
  subscribed: boolean;
}

export const runsRepo = {
  async create(
    db: Queryable,
    input: {
      nodeId: string;
      projectId: string;
      metadata: unknown;
      createCommandId: string;
      retryOfRunId?: string;
      createdByUserId?: string;
      /** Conversation this run belongs to. `null` for non-chat runs. */
      sessionId?: string | null;
    },
  ): Promise<RunRecord> {
    const result = await db.query<RunRecord>(
      `INSERT INTO runs (run_id, node_id, project_id, request_metadata, create_command_id,
                         retry_of_run_id, organization_id, created_by_user_id, session_id)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6,
               (SELECT organization_id FROM projects WHERE project_id = $3), $7, $8) RETURNING *`,
      [
        randomUUID(),
        input.nodeId,
        input.projectId,
        JSON.stringify(input.metadata ?? {}),
        input.createCommandId,
        input.retryOfRunId ?? null,
        input.createdByUserId ?? null,
        input.sessionId ?? null,
      ],
    );
    if (!result.rows[0]) throw new Error('run insert returned no row');
    return result.rows[0];
  },

  async byId(db: Queryable, runId: string): Promise<RunRecord | null> {
    const result = await db.query<RunRecord>('SELECT * FROM runs WHERE run_id = $1', [runId]);
    return result.rows[0] ?? null;
  },

  async byNodeRunId(db: Queryable, nodeId: string, nodeRunId: string): Promise<RunRecord | null> {
    const result = await db.query<RunRecord>(
      'SELECT * FROM runs WHERE node_id = $1 AND node_run_id = $2',
      [nodeId, nodeRunId],
    );
    return result.rows[0] ?? null;
  },

  async listByProject(
    db: Queryable,
    projectId: string,
    limit: number,
    organizationId?: string,
  ): Promise<RunRecord[]> {
    const result = await db.query<RunRecord>(
      `SELECT * FROM runs WHERE project_id = $1
         AND ($3::text IS NULL OR organization_id = $3)
       ORDER BY created_at DESC LIMIT $2`,
      [projectId, limit, organizationId ?? null],
    );
    return result.rows;
  },

  async attachNodeRun(db: Queryable, runId: string, nodeRunId: string): Promise<void> {
    await db.query(
      `UPDATE runs SET node_run_id = $2, status = 'running', started_at = COALESCE(started_at, now())
       WHERE run_id = $1`,
      [runId, nodeRunId],
    );
  },

  /**
   * Runs whose Node has been offline longer than `staleMs` and that the Control
   * Plane still shows as active.
   *
   * A run only ends when its Node says so. If the Node never comes back, nothing
   * ever says so, and the run is reported active forever — so an operator needs a
   * way to see these and close them explicitly.
   */
  async staleActive(
    db: Queryable,
    staleMs: number,
    organizationId?: string,
  ): Promise<(RunRecord & { last_seen_at: Date | null })[]> {
    const result = await db.query<RunRecord & { last_seen_at: Date | null }>(
      `SELECT r.*, n.last_seen_at
       FROM runs r
       JOIN nodes n ON n.node_id = r.node_id
       WHERE ($2::text IS NULL OR r.organization_id = $2)
         AND r.status NOT IN ('completed', 'failed', 'cancelled', 'interrupted', 'lost')
         AND (n.last_seen_at IS NULL OR n.last_seen_at < now() - make_interval(secs => $1))
       ORDER BY r.created_at`,
      [staleMs / 1000, organizationId ?? null],
    );
    return result.rows;
  },

  async setStatus(
    db: Queryable,
    runId: string,
    status: string,
    extra: { terminalReason?: string; errorCode?: string; errorMessage?: string } = {},
  ): Promise<void> {
    const terminal = ['completed', 'failed', 'cancelled', 'interrupted', 'lost'].includes(status);
    await db.query(
      `UPDATE runs SET status = $2,
              finished_at = CASE WHEN $3 THEN COALESCE(finished_at, now()) ELSE finished_at END,
              terminal_reason = COALESCE($4, terminal_reason),
              error_code = COALESCE($5, error_code),
              error_message = COALESCE($6, error_message)
       WHERE run_id = $1`,
      [
        runId,
        status,
        terminal,
        extra.terminalReason ?? null,
        extra.errorCode ?? null,
        extra.errorMessage ?? null,
      ],
    );
  },

  async setSubscribed(db: Queryable, runId: string, subscribed: boolean): Promise<void> {
    await db.query('UPDATE runs SET subscribed = $2 WHERE run_id = $1', [runId, subscribed]);
  },

  async subscribedRuns(db: Queryable, nodeId: string): Promise<RunRecord[]> {
    const result = await db.query<RunRecord>(
      'SELECT * FROM runs WHERE node_id = $1 AND subscribed = TRUE ORDER BY created_at',
      [nodeId],
    );
    return result.rows;
  },
};

// ------------------------------------------------------------------ events

export interface EventRecord {
  node_id: string;
  run_id: string;
  seq: string | number;
  project_id: string;
  event_type: string;
  recorded_at: Date | null;
  payload: Record<string, unknown>;
  source: string | null;
  ingested_at: Date;
}

export const eventsRepo = {
  /**
   * Insert one event, ignoring a duplicate.
   *
   * The unique `(node_id, run_id, seq)` constraint turns at-least-once delivery
   * into an idempotent write, so a replayed batch costs nothing.
   */
  async insert(
    client: PoolClient,
    input: {
      nodeId: string;
      runId: string;
      seq: number;
      projectId: string;
      eventType: string;
      recordedAt: number | null;
      payload: unknown;
      source: string | null;
    },
  ): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO run_events (node_id, run_id, seq, project_id, event_type, recorded_at,
                               payload, source)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6::double precision / 1000), $7::jsonb, $8)
       ON CONFLICT (node_id, run_id, seq) DO NOTHING`,
      [
        input.nodeId,
        input.runId,
        input.seq,
        input.projectId,
        input.eventType,
        input.recordedAt,
        JSON.stringify(input.payload ?? {}),
        input.source,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  },

  /**
   * Highest contiguous sequence stored for a run, starting after `from`.
   *
   * Only a gapless prefix may be acknowledged: acknowledging past a gap would
   * tell the Node to stop resending events that were never stored.
   */
  async highestContiguous(db: Queryable, runId: string, from: number): Promise<number> {
    const result = await db.query<{ seq: string }>(
      'SELECT seq::text AS seq FROM run_events WHERE run_id = $1 AND seq > $2 ORDER BY seq',
      [runId, from],
    );
    let cursor = from;
    for (const row of result.rows) {
      const seq = Number(row.seq);
      if (seq !== cursor + 1) break;
      cursor = seq;
    }
    return cursor;
  },

  async since(
    db: Queryable,
    runId: string,
    afterSeq: number,
    limit: number,
  ): Promise<EventRecord[]> {
    const result = await db.query<EventRecord>(
      `SELECT * FROM run_events WHERE run_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
      [runId, afterSeq, limit],
    );
    return result.rows;
  },

  async setAckedSeq(db: Queryable, runId: string, seq: number): Promise<void> {
    await db.query(
      'UPDATE runs SET acked_event_seq = GREATEST(acked_event_seq, $2), last_event_seq = GREATEST(last_event_seq, $2) WHERE run_id = $1',
      [runId, seq],
    );
  },

  async countIngested(db: Queryable): Promise<number> {
    const result = await db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM run_events',
    );
    return Number(result.rows[0]?.count ?? 0);
  },
};

// ------------------------------------------------------------------ audit

export const auditRepo = {
  async record(
    db: Queryable,
    input: {
      action: string;
      actor: string;
      targetType?: string;
      targetId?: string;
      result: string;
      correlationId?: string;
      detail?: Record<string, unknown>;
      organizationId?: string;
      actorUserId?: string;
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO audit_log (action, actor, target_type, target_id, result, correlation_id,
                              detail, organization_id, actor_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
      [
        input.action,
        input.actor,
        input.targetType ?? null,
        input.targetId ?? null,
        input.result,
        input.correlationId ?? null,
        JSON.stringify(input.detail ?? {}),
        input.organizationId ?? BOOTSTRAP_ORGANIZATION_ID,
        input.actorUserId ?? null,
      ],
    );
  },

  async recent(db: Queryable, limit: number): Promise<Record<string, unknown>[]> {
    const result = await db.query<Record<string, unknown>>(
      'SELECT * FROM audit_log ORDER BY occurred_at DESC LIMIT $1',
      [limit],
    );
    return result.rows;
  },
};

// ------------------------------------------------------- identity rotation

export interface RotationRecord {
  rotation_id: string;
  node_id: string;
  old_fingerprint: string;
  proposed_public_key: string;
  proposed_fingerprint: string;
  state: string;
  challenge_nonce: string | null;
  created_at: Date;
  expires_at: Date;
  completed_at: Date | null;
  revoked_at: Date | null;
  metadata: Record<string, unknown>;
}

export const rotationsRepo = {
  async open(
    db: Queryable,
    input: {
      nodeId: string;
      oldFingerprint: string;
      oldPublicKey?: string;
      proposedPublicKey: string;
      proposedFingerprint: string;
      challengeNonce: string;
      ttlMs: number;
    },
  ): Promise<RotationRecord> {
    const result = await db.query<RotationRecord>(
      `INSERT INTO identity_rotations (rotation_id, node_id, old_fingerprint, old_public_key,
                                       proposed_public_key, proposed_fingerprint,
                                       challenge_nonce, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8::bigint || ' milliseconds')::interval)
       RETURNING *`,
      [
        randomUUID(),
        input.nodeId,
        input.oldFingerprint,
        input.oldPublicKey ?? null,
        input.proposedPublicKey,
        input.proposedFingerprint,
        input.challengeNonce,
        String(input.ttlMs),
      ],
    );
    if (!result.rows[0]) throw new Error('rotation insert returned no row');
    return result.rows[0];
  },

  async pending(db: Queryable, rotationId: string): Promise<RotationRecord | null> {
    const result = await db.query<RotationRecord>(
      `SELECT * FROM identity_rotations
       WHERE rotation_id = $1 AND state = 'pending' AND expires_at > now()`,
      [rotationId],
    );
    return result.rows[0] ?? null;
  },

  async listForNode(db: Queryable, nodeId: string): Promise<RotationRecord[]> {
    const result = await db.query<RotationRecord>(
      'SELECT * FROM identity_rotations WHERE node_id = $1 ORDER BY created_at DESC LIMIT 100',
      [nodeId],
    );
    return result.rows;
  },

  async setState(db: Queryable, rotationId: string, state: string): Promise<void> {
    await db.query(
      `UPDATE identity_rotations SET state = $2,
              completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END
       WHERE rotation_id = $1`,
      [rotationId, state],
    );
  },
};
