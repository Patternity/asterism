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
