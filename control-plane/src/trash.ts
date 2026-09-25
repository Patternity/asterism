/**
 * Trash: a reversible way to put a Node or a project out of sight.
 *
 * Nothing here deletes anything. A tombstone is a time and a person on the row
 * it describes; the resource's identity, workspace, credential assignment,
 * model, runs, events and audit stay where they were, and restoring it clears
 * two columns.
 *
 * **The hierarchy is derived, never copied.** A project is in Trash when its
 * own tombstone is set *or* its Node's is. Trashing a Node writes one row, so
 * restoring that Node cannot restore a project somebody had put in Trash on its
 * own: that project's tombstone was never written by the Node's trash and is
 * never cleared by its restore.
 *
 * **One contract for a project under a trashed Node.** Restoring it is refused
 * with `node_trashed`. Clearing its own tombstone while its Node is still in
 * Trash would leave it exactly as hidden and exactly as stopped as before, and
 * a success that changes nothing a person can see is the misleading kind.
 *
 * **Refusal before mutation.** Moving something to Trash while it is doing
 * work would either end that work silently or leave it running under a label
 * that says it is not. Neither is allowed: the request is refused with one
 * typed code and nothing changes.
 *
 * **Honest worker outcomes.** A worker is stopped or started by its Node, and
 * this process only reports what the Node reported. A Node whose build has no
 * command for it is recorded as `unsupported`, and a runtime the Node does not
 * own as `not_managed` -- never as a stop that nobody performed.
 */

import { nodeCapabilityView } from './node-capabilities.js';
import { TERMINAL_RUN_STATUSES } from './node-channel.js';
import {
  commandsRepo,
  type NodeRecord,
  type ProjectRecord,
  type Queryable,
} from './repositories.js';

/** The worker states a transition is still on its way through. */
const WORKER_TRANSITIONS = new Set(['stopping', 'starting']);

/** Credential states that are a login in flight. */
const CREDENTIAL_LOGINS = new Set(['authorizing', 'reauthorizing']);

/** Update stages an operation is still running in. */
const LIVE_UPDATE_STAGES = ['queued', 'accepted', 'applying', 'awaiting_reconnect'];

/** Provisioning states that are a build still in progress. */
const PROVISIONING_IN_PROGRESS = new Set(['pending', 'provisioning']);

export interface NodeTrashView {
  trashed: boolean;
  trashed_at: string | null;
  trashed_by_user_id: string | null;
}

export interface ProjectTrashView {
  /** The project's own tombstone is set. */
  trashed: boolean;
  /** Its Node is in Trash, which puts it there whatever its own state. */
  inherited: boolean;
  /** Either of the two: this project is out of active views and takes no work. */
  effective: boolean;
  trashed_at: string | null;
  trashed_by_user_id: string | null;
  node_trashed_at: string | null;
  /** What Trash last did to its worker, as its Node reported it. */
  worker: string | null;
  worker_failure: string | null;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function nodeTrashView(
  node: Pick<NodeRecord, 'trashed_at' | 'trashed_by_user_id'>,
): NodeTrashView {
  return {
    trashed: Boolean(node.trashed_at),
    trashed_at: iso(node.trashed_at),
    trashed_by_user_id: node.trashed_by_user_id ?? null,
  };
}

export function projectTrashView(
  project: Pick<
    ProjectRecord,
    'trashed_at' | 'trashed_by_user_id' | 'worker_lifecycle' | 'worker_lifecycle_failure'
  >,
  node: Pick<NodeRecord, 'trashed_at'> | null,
): ProjectTrashView {
  const own = Boolean(project.trashed_at);
  const inherited = Boolean(node?.trashed_at);
  return {
    trashed: own,
    inherited,
    effective: own || inherited,
    trashed_at: iso(project.trashed_at),
    trashed_by_user_id: project.trashed_by_user_id ?? null,
    node_trashed_at: iso(node?.trashed_at),
    worker: project.worker_lifecycle ?? null,
    worker_failure: project.worker_lifecycle_failure ?? null,
  };
}

/** Whether a project takes work, given its own and its Node's tombstone. */
export function projectIsActive(
  project: Pick<ProjectRecord, 'trashed_at'>,
  node: Pick<NodeRecord, 'trashed_at'> | null,
): boolean {
  return !project.trashed_at && !node?.trashed_at;
}

/**
 * The SQLSTATEs the database raises when work is written for something in
 * Trash. Every route checks first; these are what a request that raced the
 * tombstone meets.
 */
const TRASH_SQLSTATES: Readonly<Record<string, TrashRefusal>> = {
  TR001: 'node_trashed',
  TR002: 'project_trashed',
};

export type TrashRefusal = 'node_trashed' | 'project_trashed';

/** The typed refusal a database error stands for, if it is one of these. */
export function trashRefusalOf(error: unknown): TrashRefusal | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? (TRASH_SQLSTATES[code] ?? null) : null;
}

export const TRASH_MESSAGES: Readonly<Record<TrashRefusal, string>> = {
  node_trashed: 'This Node is in Trash. Restore it before doing anything with it.',
  project_trashed: 'This project is in Trash. Restore it before doing anything with it.',
};

// ------------------------------------------------------------------ blockers

/** Why a project may not go to Trash right now, or null. */
export async function projectTrashBlocker(
  db: Queryable,
  project: ProjectRecord,
): Promise<string | null> {
  const running = await db.query(
    `SELECT 1 FROM runs WHERE project_id = $1 AND NOT (status = ANY($2::text[])) LIMIT 1`,
    [project.project_id, [...TERMINAL_RUN_STATUSES]],
  );
  // A run waiting for an approval is not terminal, so it lands here too: a
  // person being asked a question is work in progress.
  if ((running.rowCount ?? 0) > 0) return 'project_runs_active';
  if (PROVISIONING_IN_PROGRESS.has(project.provisioning_state)) {
    return 'project_provisioning_in_progress';
  }
  if (project.credential_assignment_state === 'pending') {
    return 'credential_assignment_in_progress';
  }
  if (project.model_selection_state === 'pending') return 'model_selection_in_progress';
  if (project.worker_lifecycle && WORKER_TRANSITIONS.has(project.worker_lifecycle)) {
    return 'project_lifecycle_in_progress';
  }
  if (project.credential_id) {
    const credential = await db.query<{ state: string }>(
      `SELECT state FROM node_provider_credentials WHERE node_id = $1 AND credential_id = $2`,
      [project.node_id, project.credential_id],
    );
    const state = credential.rows[0]?.state;
    if (state && CREDENTIAL_LOGINS.has(state)) return 'credential_authorization_in_progress';
  }
  return null;
}

/** Why a Node may not go to Trash right now, or null. */
export async function nodeTrashBlocker(db: Queryable, node: NodeRecord): Promise<string | null> {
  const update = await db.query(
    `SELECT 1 FROM node_update_operations WHERE node_id = $1 AND stage = ANY($2::text[]) LIMIT 1`,
    [node.node_id, LIVE_UPDATE_STAGES],
  );
  if ((update.rowCount ?? 0) > 0) return 'update_in_progress';
  if (node.provider_state === 'authorizing') return 'credential_authorization_in_progress';
  const logins = await db.query(
    `SELECT 1 FROM node_provider_credentials WHERE node_id = $1 AND state = ANY($2::text[]) LIMIT 1`,
    [node.node_id, [...CREDENTIAL_LOGINS]],
  );
  if ((logins.rowCount ?? 0) > 0) return 'credential_authorization_in_progress';

  // Only the projects still awake. One already in Trash on its own has no work
  // by construction, and its worker being put to sleep is not something the
  // Node's trash interrupts: that command is the one the gate lets through.
  // Counting it would leave an offline Node with a trashed project impossible
  // to put in Trash until it came back.
  const projects = await db.query<ProjectRecord>(
    `SELECT * FROM projects WHERE node_id = $1 AND trashed_at IS NULL ORDER BY project_id`,
    [node.node_id],
  );
  for (const project of projects.rows) {
    const blocker = await projectTrashBlocker(db, project);
    if (blocker) return blocker;
  }
  return null;
}

export const BLOCKER_MESSAGES: Readonly<Record<string, string>> = {
  project_runs_active:
    'A run is still in progress or waiting for an approval. Let it finish, or cancel it, first.',
  project_provisioning_in_progress: 'This project is still being built. Wait for it to finish.',
  credential_assignment_in_progress:
    'A credential change is being applied to this project. Wait for it to finish.',
  model_selection_in_progress:
    'A model change is being applied to this project. Wait for it to finish.',
  project_lifecycle_in_progress:
    'This project is still being moved in or out of Trash. Wait for that to finish.',
  credential_authorization_in_progress:
    'A credential login is waiting for a browser approval. Finish or cancel it first.',
  update_in_progress: 'This Node is being updated. Wait for the update to finish.',
};

// ---------------------------------------------------------------- mutations

/** Lock a project row for a lifecycle decision, or null if it is not there. */
export async function lockProject(
  db: Queryable,
  organizationId: string,
  projectId: string,
): Promise<ProjectRecord | null> {
  const result = await db.query<ProjectRecord>(
    `SELECT * FROM projects WHERE organization_id = $1 AND project_id = $2 FOR UPDATE`,
    [organizationId, projectId],
  );
  return result.rows[0] ?? null;
}

/** Lock a Node row for a lifecycle decision, or null if it is not there. */
export async function lockNode(
  db: Queryable,
  organizationId: string,
  nodeId: string,
): Promise<NodeRecord | null> {
  const result = await db.query<NodeRecord>(
    `SELECT * FROM nodes WHERE organization_id = $1 AND node_id = $2 FOR UPDATE`,
    [organizationId, nodeId],
  );
  return result.rows[0] ?? null;
}

export async function setProjectTombstone(
  db: Queryable,
  projectId: string,
  userId: string | null,
): Promise<ProjectRecord> {
  const result = await db.query<ProjectRecord>(
    `UPDATE projects SET trashed_at = now(), trashed_by_user_id = $2
      WHERE project_id = $1 RETURNING *`,
    [projectId, userId],
  );
  return result.rows[0]!;
}

export async function clearProjectTombstone(
  db: Queryable,
  projectId: string,
): Promise<ProjectRecord> {
  const result = await db.query<ProjectRecord>(
    `UPDATE projects SET trashed_at = NULL, trashed_by_user_id = NULL
      WHERE project_id = $1 RETURNING *`,
    [projectId],
  );
  return result.rows[0]!;
}

export async function setNodeTombstone(
  db: Queryable,
  nodeId: string,
  userId: string | null,
): Promise<NodeRecord> {
  const result = await db.query<NodeRecord>(
    `UPDATE nodes SET trashed_at = now(), trashed_by_user_id = $2 WHERE node_id = $1 RETURNING *`,
    [nodeId, userId],
  );
  return result.rows[0]!;
}

export async function clearNodeTombstone(db: Queryable, nodeId: string): Promise<NodeRecord> {
  const result = await db.query<NodeRecord>(
    `UPDATE nodes SET trashed_at = NULL, trashed_by_user_id = NULL WHERE node_id = $1 RETURNING *`,
    [nodeId],
  );
  return result.rows[0]!;
}

/**
 * Ask a project's Node to put its worker to sleep, or wake it.
 *
 * Only a Node that advertises the command is asked. One that does not is
 * recorded as `unsupported`: the tombstone is still what keeps work away, and
 * nothing is said to have happened on a host where nothing did. An offline
 * Node's command waits in its queue, and the state says it is on its way.
 */
export async function requestWorkerTransition(
  db: Queryable,
  project: ProjectRecord,
  node: NodeRecord,
  direction: 'suspend' | 'resume',
): Promise<ProjectRecord> {
  if (!nodeCapabilityView(node).supports_project_suspension) {
    const result = await db.query<ProjectRecord>(
      `UPDATE projects SET worker_lifecycle = 'unsupported', worker_lifecycle_command_id = NULL,
              worker_lifecycle_failure = NULL
        WHERE project_id = $1 RETURNING *`,
      [project.project_id],
    );
    return result.rows[0]!;
  }
  const commandType = direction === 'suspend' ? 'project.suspend' : 'project.resume';
  const command = await commandsRepo.create(db, {
    nodeId: node.node_id,
    projectId: project.project_id,
    commandType,
    payload: { version: 1 },
    digest: `${commandType}:${project.project_id}:${Date.now()}`,
  });
  const result = await db.query<ProjectRecord>(
    `UPDATE projects SET worker_lifecycle = $2, worker_lifecycle_command_id = $3,
            worker_lifecycle_failure = NULL
      WHERE project_id = $1 RETURNING *`,
    [project.project_id, direction === 'suspend' ? 'stopping' : 'starting', command.command_id],
  );
  return result.rows[0]!;
}

/**
 * Record what a Node reported for a worker transition.
 *
 * Applied only to the transition that is still expected: a late answer to a
 * suspension that a restore has since replaced must not put a woken worker's
 * project back to `stopped`.
 */
export async function recordWorkerTransition(
  db: Queryable,
  commandId: string,
  commandType: string,
  outcome: { completed: boolean; worker?: unknown; failure?: string | null },
): Promise<void> {
  const suspend = commandType === 'project.suspend';
  let state: string;
  if (outcome.completed) {
    const reported = typeof outcome.worker === 'string' ? outcome.worker : null;
    state = reported === 'not_managed' ? 'not_managed' : suspend ? 'stopped' : 'running';
    // A Node that answered something else is not believed about it.
    if (reported && !['stopped', 'running', 'not_managed'].includes(reported)) {
      state = suspend ? 'stop_failed' : 'start_failed';
    }
  } else {
    state = suspend ? 'stop_failed' : 'start_failed';
  }
  await db.query(
    `UPDATE projects SET worker_lifecycle = $2, worker_lifecycle_failure = $3
      WHERE worker_lifecycle_command_id = $1`,
    [commandId, state, outcome.completed ? null : (outcome.failure ?? 'command_failed')],
  );
}
