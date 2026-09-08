/**
 * Persistence for durable update operations.
 *
 * Every decision this makes comes from `node-updates.ts`, which is pure and
 * tested on its own. What lives here is the writing down: one transaction per
 * report, so an operation and its history can never disagree about how far it
 * got.
 */

import { randomUUID } from 'node:crypto';

import type { InstallationState } from './node-installations.js';
import {
  decideUpdateProgress,
  isTerminalStage,
  resolveReconnect,
  stallVerdict,
  type UpdateStage,
} from './node-updates.js';
import type { Queryable } from './repositories.js';

export interface UpdateOperationRecord {
  operation_id: string;
  organization_id: string;
  node_id: string;
  command_id: string | null;
  requested_version: string;
  previous_version: string | null;
  reported_version: string | null;
  requested_by_user_id: string | null;
  stage: UpdateStage;
  detail_state: string | null;
  percent: number;
  bytes_done: string | number | null;
  bytes_total: string | number | null;
  failure_code: string | null;
  failure_message: string | null;
  last_seq: string | number;
  created_at: Date;
  updated_at: Date;
  stage_changed_at: Date;
  terminal_at: Date | null;
}

export interface UpdateEventRecord {
  operation_id: string;
  seq: string | number;
  stage: UpdateStage;
  detail_state: string | null;
  percent: number;
  bytes_done: string | number | null;
  bytes_total: string | number | null;
  failure_code: string | null;
  detail: Record<string, unknown> | null;
  occurred_at: Date | null;
  recorded_at: Date;
}

const COLUMNS = `operation_id, organization_id, node_id, command_id, requested_version,
                 previous_version, reported_version, requested_by_user_id, stage, detail_state,
                 percent, bytes_done, bytes_total, failure_code, failure_message, last_seq,
                 created_at, updated_at, stage_changed_at, terminal_at`;

/** The stages an operation is still running in. */
const LIVE_STAGES = ['queued', 'accepted', 'applying', 'awaiting_reconnect'];

function asNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : Number(value);
}

export const nodeUpdatesRepo = {
  async create(
    db: Queryable,
    input: {
      organizationId: string;
      nodeId: string;
      commandId: string | null;
      requestedVersion: string;
      previousVersion: string | null;
      requestedByUserId: string | null;
    },
  ): Promise<UpdateOperationRecord> {
    const result = await db.query<UpdateOperationRecord>(
      `INSERT INTO node_update_operations
         (operation_id, organization_id, node_id, command_id, requested_version,
          previous_version, requested_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${COLUMNS}`,
      [
        randomUUID(),
        input.organizationId,
        input.nodeId,
        input.commandId,
        input.requestedVersion,
        input.previousVersion,
        input.requestedByUserId,
      ],
    );
    return result.rows[0]!;
  },

  async byId(db: Queryable, operationId: string): Promise<UpdateOperationRecord | null> {
    const result = await db.query<UpdateOperationRecord>(
      `SELECT ${COLUMNS} FROM node_update_operations WHERE operation_id = $1`,
      [operationId],
    );
    return result.rows[0] ?? null;
  },

  /** The operation still running on this Node, if any. */
  async liveForNode(db: Queryable, nodeId: string): Promise<UpdateOperationRecord | null> {
    const result = await db.query<UpdateOperationRecord>(
      `SELECT ${COLUMNS} FROM node_update_operations
        WHERE node_id = $1 AND stage = ANY($2::text[])
        ORDER BY created_at DESC LIMIT 1`,
      [nodeId, LIVE_STAGES],
    );
    return result.rows[0] ?? null;
  },

  /**
   * The operation the console should show for a Node: the live one, or the last
   * one that ended. A reload after an update finished must still find its
   * result rather than an empty panel.
   */
  async latestForNode(db: Queryable, nodeId: string): Promise<UpdateOperationRecord | null> {
    const result = await db.query<UpdateOperationRecord>(
      `SELECT ${COLUMNS} FROM node_update_operations
        WHERE node_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [nodeId],
    );
    return result.rows[0] ?? null;
  },

  async events(
    db: Queryable,
    operationId: string,
    sinceSeq = 0,
    limit = 500,
  ): Promise<UpdateEventRecord[]> {
    const result = await db.query<UpdateEventRecord>(
      `SELECT operation_id, seq, stage, detail_state, percent, bytes_done, bytes_total,
              failure_code, detail, occurred_at, recorded_at
         FROM node_update_events
        WHERE operation_id = $1 AND seq > $2
        ORDER BY seq ASC LIMIT $3`,
      [operationId, sinceSeq, limit],
    );
    return result.rows;
  },

  /**
   * The Node took the command and started its updater.
   *
   * Deliberately not a success of any kind: it is the moment the operation stops
   * waiting to be picked up and starts waiting to be told how it went.
   */
  async markAccepted(db: Queryable, operationId: string): Promise<void> {
    await db.query(
      `UPDATE node_update_operations
          SET stage = 'accepted', stage_changed_at = now(), updated_at = now()
        WHERE operation_id = $1 AND stage = 'queued'`,
      [operationId],
    );
  },

  /** Record one progress report, or say why it changed nothing. */
  async recordProgress(
    db: Queryable,
    operationId: string,
    report: {
      seq: number;
      state: InstallationState;
      bytesDone?: number | null;
      bytesTotal?: number | null;
      failureCode?: string | null;
      failureMessage?: string | null;
      occurredAt?: Date | null;
      detail?: Record<string, unknown> | null;
    },
  ): Promise<{ applied: boolean; reason?: string; operation: UpdateOperationRecord | null }> {
    // Locked for the length of the decision: two frames for one operation must
    // not both read the same `last_seq` and both decide they are news.
    const locked = await db.query<UpdateOperationRecord>(
      `SELECT ${COLUMNS} FROM node_update_operations WHERE operation_id = $1 FOR UPDATE`,
      [operationId],
    );
    const current = locked.rows[0];
    if (!current) return { applied: false, reason: 'unknown_operation', operation: null };

    const decision = decideUpdateProgress(
      {
        stage: current.stage,
        percent: current.percent,
        last_seq: asNumber(current.last_seq),
        requested_version: current.requested_version,
      },
      report,
    );
    if (!decision.apply) return { applied: false, reason: decision.reason, operation: current };

    const terminal = isTerminalStage(decision.stage);
    const updated = await db.query<UpdateOperationRecord>(
      `UPDATE node_update_operations
          SET stage = $2,
              detail_state = $3,
              percent = $4,
              bytes_done = COALESCE($5, bytes_done),
              bytes_total = COALESCE($6, bytes_total),
              failure_code = COALESCE($7, failure_code),
              failure_message = COALESCE($8, failure_message),
              last_seq = $9,
              stage_changed_at = CASE WHEN stage = $2 THEN stage_changed_at ELSE now() END,
              terminal_at = CASE WHEN $10 THEN now() ELSE terminal_at END,
              updated_at = now()
        WHERE operation_id = $1
       RETURNING ${COLUMNS}`,
      [
        operationId,
        decision.stage,
        report.state,
        decision.percent,
        report.bytesDone ?? null,
        report.bytesTotal ?? null,
        report.failureCode ?? null,
        report.failureMessage ?? null,
        report.seq,
        terminal,
      ],
    );

    await db.query(
      `INSERT INTO node_update_events
         (operation_id, seq, stage, detail_state, percent, bytes_done, bytes_total,
          failure_code, detail, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (operation_id, seq) DO NOTHING`,
      [
        operationId,
        report.seq,
        decision.stage,
        report.state,
        decision.percent,
        report.bytesDone ?? null,
        report.bytesTotal ?? null,
        report.failureCode ?? null,
        report.detail ?? null,
        report.occurredAt ?? null,
      ],
    );

    return { applied: true, operation: updated.rows[0]! };
  },

  /**
   * Settle whatever this Node had in flight, now that it has said what release
   * it is on.
   *
   * The only place an update is ever called successful.
   */
  async resolveOnReconnect(
    db: Queryable,
    nodeId: string,
    reportedVersion: string | null | undefined,
  ): Promise<{ operation: UpdateOperationRecord; outcome: string } | null> {
    const locked = await db.query<UpdateOperationRecord>(
      `SELECT ${COLUMNS} FROM node_update_operations
        WHERE node_id = $1 AND stage = ANY($2::text[])
        ORDER BY created_at DESC LIMIT 1
          FOR UPDATE`,
      [nodeId, LIVE_STAGES],
    );
    const operation = locked.rows[0];
    if (!operation) return null;

    const verdict = resolveReconnect(operation, reportedVersion);
    if (verdict.outcome === 'ignore') return { operation, outcome: verdict.outcome };

    const succeeded = verdict.outcome === 'succeeded';
    const updated = await db.query<UpdateOperationRecord>(
      `UPDATE node_update_operations
          SET stage = $2,
              percent = $3,
              reported_version = $4,
              failure_code = $5,
              failure_message = $6,
              stage_changed_at = now(),
              terminal_at = now(),
              updated_at = now()
        WHERE operation_id = $1
       RETURNING ${COLUMNS}`,
      [
        operation.operation_id,
        succeeded ? 'succeeded' : 'failed',
        succeeded ? 100 : operation.percent,
        reportedVersion ?? null,
        succeeded ? null : verdict.failureCode,
        succeeded ? null : verdict.message,
      ],
    );

    // The terminal state belongs in the history too, so a browser replaying
    // events reaches the same end the operation row shows.
    await db.query(
      `INSERT INTO node_update_events
         (operation_id, seq, stage, detail_state, percent, failure_code, detail)
       VALUES ($1, $2, $3, NULL, $4, $5, $6)
       ON CONFLICT (operation_id, seq) DO NOTHING`,
      [
        operation.operation_id,
        asNumber(operation.last_seq) + 1,
        succeeded ? 'succeeded' : 'failed',
        succeeded ? 100 : operation.percent,
        succeeded ? null : verdict.failureCode,
        { reported_version: reportedVersion ?? null },
      ],
    );
    await db.query(
      `UPDATE node_update_operations SET last_seq = last_seq + 1 WHERE operation_id = $1`,
      [operation.operation_id],
    );

    return { operation: updated.rows[0]!, outcome: verdict.outcome };
  },

  /**
   * End operations that have waited past what their stage allows.
   *
   * A separate pass rather than a check on read, so an operation nobody is
   * looking at still reaches a terminal state and stops holding the one-live-
   * per-Node index against the next update.
   */
  async sweepStalled(db: Queryable, now = new Date()): Promise<UpdateOperationRecord[]> {
    const live = await db.query<UpdateOperationRecord>(
      `SELECT ${COLUMNS} FROM node_update_operations WHERE stage = ANY($1::text[])`,
      [LIVE_STAGES],
    );
    const ended: UpdateOperationRecord[] = [];
    for (const operation of live.rows) {
      const verdict = stallVerdict(operation, now);
      if (!verdict) continue;
      const updated = await db.query<UpdateOperationRecord>(
        `UPDATE node_update_operations
            SET stage = 'timed_out', failure_code = $2, failure_message = $3,
                stage_changed_at = now(), terminal_at = now(), updated_at = now()
          WHERE operation_id = $1 AND stage = $4
         RETURNING ${COLUMNS}`,
        [operation.operation_id, verdict.failureCode, verdict.message, operation.stage],
      );
      if (updated.rows[0]) ended.push(updated.rows[0]);
    }
    return ended;
  },
};
