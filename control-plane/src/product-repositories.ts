/**
 * Tenant-scoped persistence surface for the browser product API.
 *
 * Every method requires an organization id and repeats it in the SQL predicate.
 * A resource identifier from another tenant is therefore indistinguishable from
 * an unknown identifier. Node-protocol repositories remain separate because an
 * authenticated Node is itself the tenant-bound principal on that channel.
 */
import type { Pool, PoolClient } from './db.js';
import type {
  CommandRecord,
  EnrollmentTokenRecord,
  EventRecord,
  NodeRecord,
  ProjectRecord,
  RotationRecord,
  RunRecord,
} from './repositories.js';

type Queryable = Pool | PoolClient;

export const productNodesRepo = {
  async byId(db: Queryable, organizationId: string, nodeId: string): Promise<NodeRecord | null> {
    const result = await db.query<NodeRecord>(
      'SELECT * FROM nodes WHERE organization_id = $1 AND node_id = $2',
      [organizationId, nodeId],
    );
    return result.rows[0] ?? null;
  },
  async list(db: Queryable, organizationId: string): Promise<NodeRecord[]> {
    const result = await db.query<NodeRecord>(
      'SELECT * FROM nodes WHERE organization_id = $1 ORDER BY enrolled_at, node_id',
      [organizationId],
    );
    return result.rows;
  },
};

export const productProjectsRepo = {
  async byId(
    db: Queryable,
    organizationId: string,
    projectId: string,
  ): Promise<ProjectRecord | null> {
    const result = await db.query<ProjectRecord>(
      'SELECT * FROM projects WHERE organization_id = $1 AND project_id = $2',
      [organizationId, projectId],
    );
    return result.rows[0] ?? null;
  },
  async list(db: Queryable, organizationId: string): Promise<ProjectRecord[]> {
    const result = await db.query<ProjectRecord>(
      `SELECT * FROM projects WHERE organization_id = $1
       ORDER BY display_name, project_id`,
      [organizationId],
    );
    return result.rows;
  },

  /**
   * Record a project and the command that builds it, or neither.
   *
   * These two rows are one decision. A project without its command is a row an
   * operator can see and nothing will ever act on; a command without its project
   * is work aimed at something that does not exist. The caller runs this inside
   * a transaction so the pair commits together or not at all.
   *
   * `ready` is deliberately not reachable from here: at this point nothing has
   * been built, and the only thing that may say otherwise is the Node reporting
   * a worker that answered.
   */
  async createWithProvisionCommand(
    db: Queryable,
    input: {
      organizationId: string;
      projectId: string;
      nodeId: string;
      nodeProjectId: string;
      displayName: string;
      slug: string;
      workspaceMode: string;
      repositoryUrl: string | null;
      repositoryBranch: string | null;
      createdByUserId: string;
    },
  ): Promise<ProjectRecord> {
    const result = await db.query<ProjectRecord>(
      `INSERT INTO projects
         (project_id, organization_id, node_id, node_project_id, display_name, slug,
          enabled, available, workspace_mode, repository_url, repository_branch,
          created_by_user_id, provisioning_state, provisioning_generation)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, FALSE, $7, $8, $9, $10, 'pending', 1)
       RETURNING *`,
      [
        input.projectId,
        input.organizationId,
        input.nodeId,
        input.nodeProjectId,
        input.displayName,
        input.slug,
        input.workspaceMode,
        input.repositoryUrl,
        input.repositoryBranch,
        input.createdByUserId,
      ],
    );
    return result.rows[0]!;
  },

  /**
   * Move a project to `provisioning` for one attempt.
   *
   * Guarded by generation so a Node that reconnects and re-announces an older
   * attempt cannot drag a newer one backwards.
   */
  async markProvisioningStarted(
    db: Queryable,
    organizationId: string,
    projectId: string,
    generation: number,
  ): Promise<boolean> {
    const result = await db.query(
      `UPDATE projects
          SET provisioning_state = 'provisioning',
              provisioning_failure = NULL,
              provisioning_failure_message = NULL
        WHERE organization_id = $1 AND project_id = $2
          AND provisioning_generation = $3
          AND provisioning_state IN ('pending', 'provisioning', 'failed')`,
      [organizationId, projectId, generation],
    );
    return (result.rowCount ?? 0) > 0;
  },

  /**
   * The only path to `ready`.
   *
   * Reached solely from a Node success for the attempt currently in flight. A
   * disabled project is excluded: an administrator's decision outranks a result
   * that was already in the air when it was made.
   */
  async markProvisioningReady(
    db: Queryable,
    organizationId: string,
    projectId: string,
    generation: number,
  ): Promise<boolean> {
    const result = await db.query(
      `UPDATE projects
          SET provisioning_state = 'ready',
              available = TRUE,
              provisioning_failure = NULL,
              provisioning_failure_message = NULL
        WHERE organization_id = $1 AND project_id = $2
          AND provisioning_generation = $3
          AND provisioning_state <> 'disabled'`,
      [organizationId, projectId, generation],
    );
    return (result.rowCount ?? 0) > 0;
  },

  /**
   * Record a typed failure for the attempt in flight.
   *
   * `ready` is excluded on purpose: once an attempt has succeeded, a later
   * failure from that same attempt is stale news, and letting it through would
   * take a working project offline.
   */
  async markProvisioningFailed(
    db: Queryable,
    organizationId: string,
    projectId: string,
    generation: number,
    failure: string,
    message: string | null,
  ): Promise<boolean> {
    const result = await db.query(
      `UPDATE projects
          SET provisioning_state = 'failed',
              available = FALSE,
              provisioning_failure = $4,
              provisioning_failure_message = $5
        WHERE organization_id = $1 AND project_id = $2
          AND provisioning_generation = $3
          AND provisioning_state NOT IN ('ready', 'disabled')`,
      [organizationId, projectId, generation, failure, message],
    );
    return (result.rowCount ?? 0) > 0;
  },

  /**
   * Begin a new attempt at a failed project.
   *
   * The generation increments, which is what makes every event from the previous
   * attempt inert: they carry a number that no longer matches.
   */
  async beginRetry(
    db: Queryable,
    organizationId: string,
    projectId: string,
  ): Promise<ProjectRecord | null> {
    const result = await db.query<ProjectRecord>(
      `UPDATE projects
          SET provisioning_generation = provisioning_generation + 1,
              provisioning_state = 'pending',
              provisioning_failure = NULL,
              provisioning_failure_message = NULL
        WHERE organization_id = $1 AND project_id = $2
          AND provisioning_state = 'failed'
        RETURNING *`,
      [organizationId, projectId],
    );
    return result.rows[0] ?? null;
  },
};

export const productCommandsRepo = {
  async byId(
    db: Queryable,
    organizationId: string,
    commandId: string,
  ): Promise<CommandRecord | null> {
    const result = await db.query<CommandRecord>(
      'SELECT * FROM remote_commands WHERE organization_id = $1 AND command_id = $2',
      [organizationId, commandId],
    );
    return result.rows[0] ?? null;
  },
};

export const productRunsRepo = {
  async byId(db: Queryable, organizationId: string, runId: string): Promise<RunRecord | null> {
    const result = await db.query<RunRecord>(
      'SELECT * FROM runs WHERE organization_id = $1 AND run_id = $2',
      [organizationId, runId],
    );
    return result.rows[0] ?? null;
  },
  /**
   * The conversation currently exposed on a project page.
   *
   * Ownership rule: **a project's active conversation is the session of its most
   * recent run that carries one.** No session table, no client-held identity —
   * the runs themselves are the durable record, so any authorized browser
   * recovers the same conversation, and a reload cannot lose it.
   *
   * Returns `null` for a project that has never had a chat run.
   */
  async activeSessionId(
    db: Queryable,
    organizationId: string,
    projectId: string,
  ): Promise<string | null> {
    const result = await db.query<{ session_id: string }>(
      `SELECT session_id FROM runs
       WHERE organization_id = $1 AND project_id = $2 AND session_id IS NOT NULL
       ORDER BY created_at DESC, run_id DESC
       LIMIT 1`,
      [organizationId, projectId],
    );
    return result.rows[0]?.session_id ?? null;
  },

  /**
   * One conversation, oldest first, with the submitted prompt attached.
   *
   * The prompt text is not duplicated onto the run: it already lives durably in
   * the `runs.create` command payload, so it is joined back rather than stored
   * twice. Ordering is `(created_at, run_id)` so it is total and stable even
   * when two runs share a timestamp.
   */
  async sessionRuns(
    db: Queryable,
    organizationId: string,
    projectId: string,
    sessionId: string,
    limit: number,
  ): Promise<(RunRecord & { submitted_input: string | null })[]> {
    const result = await db.query<RunRecord & { submitted_input: string | null }>(
      `SELECT r.*, c.request_payload ->> 'input' AS submitted_input
       FROM runs r
       LEFT JOIN remote_commands c ON c.command_id = r.create_command_id
       WHERE r.organization_id = $1 AND r.project_id = $2 AND r.session_id = $3
       ORDER BY r.created_at, r.run_id
       LIMIT $4`,
      [organizationId, projectId, sessionId, limit],
    );
    return result.rows;
  },

  async replacementFor(
    db: Queryable,
    organizationId: string,
    runId: string,
  ): Promise<string | null> {
    const result = await db.query<{ run_id: string }>(
      `SELECT run_id FROM runs
       WHERE organization_id = $1 AND retry_of_run_id = $2
       ORDER BY created_at, run_id LIMIT 1`,
      [organizationId, runId],
    );
    return result.rows[0]?.run_id ?? null;
  },
  async list(
    db: Queryable,
    organizationId: string,
    limit: number,
    before?: { createdAt: Date; runId: string },
  ): Promise<RunRecord[]> {
    const result = await db.query<RunRecord>(
      `SELECT * FROM runs
       WHERE organization_id = $1
         AND ($3::timestamptz IS NULL OR (created_at, run_id) < ($3, $4))
       ORDER BY created_at DESC, run_id DESC LIMIT $2`,
      [organizationId, limit, before?.createdAt ?? null, before?.runId ?? null],
    );
    return result.rows;
  },
};

export const productEventsRepo = {
  async since(
    db: Queryable,
    organizationId: string,
    runId: string,
    afterSeq: number,
    limit: number,
  ): Promise<EventRecord[]> {
    const result = await db.query<EventRecord>(
      `SELECT e.* FROM run_events e
       JOIN runs r ON r.run_id = e.run_id
       WHERE r.organization_id = $1 AND e.run_id = $2 AND e.seq > $3
       ORDER BY e.seq LIMIT $4`,
      [organizationId, runId, afterSeq, limit],
    );
    return result.rows;
  },
};

export const productEnrollmentTokensRepo = {
  async byId(
    db: Queryable,
    organizationId: string,
    tokenId: string,
  ): Promise<EnrollmentTokenRecord | null> {
    const result = await db.query<EnrollmentTokenRecord>(
      `SELECT * FROM enrollment_tokens WHERE organization_id = $1 AND token_id = $2`,
      [organizationId, tokenId],
    );
    return result.rows[0] ?? null;
  },
};

export const productRotationsRepo = {
  async listForNode(
    db: Queryable,
    organizationId: string,
    nodeId: string,
  ): Promise<RotationRecord[]> {
    const result = await db.query<RotationRecord>(
      `SELECT r.* FROM identity_rotations r
       JOIN nodes n ON n.node_id = r.node_id
       WHERE n.organization_id = $1 AND r.node_id = $2
       ORDER BY r.created_at DESC LIMIT 100`,
      [organizationId, nodeId],
    );
    return result.rows;
  },
};

export const productAuditRepo = {
  async recent(
    db: Queryable,
    organizationId: string,
    limit: number,
  ): Promise<Record<string, unknown>[]> {
    const result = await db.query<Record<string, unknown>>(
      `SELECT * FROM audit_log WHERE organization_id = $1
       ORDER BY occurred_at DESC, audit_id DESC LIMIT $2`,
      [organizationId, limit],
    );
    return result.rows;
  },
};

/**
 * Each run's effective approval policy, read from the whole journal.
 *
 * The console cannot work this out for itself. Its event stream resumes from a
 * stored cursor so a reconnect does not re-render text the reader has already
 * seen — which means the early events are deliberately not re-delivered. The
 * policy is set once, usually at sequence 1, so it is exactly the kind of state
 * that window loses while later, repeating events keep arriving. Reconstructing
 * it in the browser therefore reported `manual` on a run that had been bypassing
 * approvals for minutes.
 *
 * The server has no such gap, so it answers the question instead.
 */
export const runPolicyRepo = {
  async forRuns(
    db: Queryable,
    runIds: string[],
  ): Promise<Map<string, { policy: string; actor: string | null; changed_at: Date | null }>> {
    const policies = new Map<
      string,
      { policy: string; actor: string | null; changed_at: Date | null }
    >();
    if (runIds.length === 0) return policies;
    const result = await db.query<{
      run_id: string;
      policy: string;
      actor: string | null;
      changed_at: Date | null;
    }>(
      `SELECT DISTINCT ON (run_id)
              run_id,
              payload ->> 'policy' AS policy,
              payload ->> 'actor' AS actor,
              COALESCE(recorded_at, ingested_at) AS changed_at
       FROM run_events
       WHERE run_id = ANY($1::text[])
         AND event_type = 'run.approval_policy.changed'
         AND payload ->> 'policy' IS NOT NULL
       ORDER BY run_id, seq DESC`,
      [runIds],
    );
    for (const row of result.rows) {
      policies.set(row.run_id, {
        policy: row.policy,
        actor: row.actor,
        changed_at: row.changed_at,
      });
    }
    return policies;
  },
};
