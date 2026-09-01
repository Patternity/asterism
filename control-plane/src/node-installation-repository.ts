/**
 * Durable installation attempts.
 *
 * Every read is scoped by organization in SQL rather than filtered afterwards in
 * TypeScript, for the same reason the attachment rows are: an installation id is
 * an opaque handle, and a handle that leaks across a tenant boundary is a bug
 * that no amount of later filtering makes safe.
 *
 * The connection code never appears here. It is an `enrollment_tokens` row —
 * digest-only, expiring, single-use, organization-bound — and this module holds
 * its id. Lookups by code hash the candidate and compare digests, so a code is
 * never stored, logged or returned after the moment it is created.
 */
import { createHash, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from './db.js';
import { withTransaction } from './db.js';
import {
  type FailureCode,
  type InstallationState,
  decideProgress,
  isRetryable,
  isTerminal,
} from './node-installations.js';
import { type Queryable, enrollmentTokensRepo, generateToken, hashToken } from './repositories.js';

export interface InstallationRecord {
  installation_id: string;
  organization_id: string;
  display_name: string;
  token_id: string | null;
  node_id: string | null;
  state: InstallationState;
  generation: number;
  percent: number;
  bytes_done: string | null;
  bytes_total: string | null;
  failure_code: FailureCode | null;
  failure_message: string | null;
  retryable: boolean | null;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
  completed_at: Date | null;
  cancelled_at: Date | null;
}

export interface InstallationEventRecord {
  installation_id: string;
  seq: string;
  generation: number;
  state: InstallationState;
  percent: number;
  bytes_done: string | null;
  bytes_total: string | null;
  failure_code: FailureCode | null;
  detail: unknown;
  recorded_at: Date;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** How many failed redemptions a single code, or a single source, may make. */
export const REDEMPTION_LIMITS = {
  windowMs: 10 * 60 * 1000,
  perCode: 5,
  perSource: 20,
} as const;

export const nodeInstallationsRepo = {
  /**
   * Open an installation and mint the code that attaches to it.
   *
   * The code is returned exactly once, to the browser that asked for it. It is
   * not stored, and no later read can recover it.
   */
  async create(
    pool: Pool,
    input: {
      organizationId: string;
      displayName: string;
      createdByUserId: string;
      ttlMs: number;
    },
  ): Promise<{ record: InstallationRecord; code: string }> {
    return withTransaction(pool, async (client) => {
      const { record: token, token: code } = await enrollmentTokensRepo.create(client, {
        ttlMs: input.ttlMs,
        intendedName: input.displayName,
        organizationId: input.organizationId,
        createdBy: input.createdByUserId,
      });

      const result = await client.query<InstallationRecord>(
        `INSERT INTO node_installations
           (installation_id, organization_id, display_name, token_id, created_by_user_id,
            expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          randomUUID(),
          input.organizationId,
          input.displayName,
          token.token_id,
          input.createdByUserId,
          token.expires_at,
        ],
      );
      const record = result.rows[0];
      if (!record) throw new Error('installation insert returned no row');
      return { record, code };
    });
  },

  async byId(
    db: Queryable,
    organizationId: string,
    installationId: string,
  ): Promise<InstallationRecord | null> {
    const result = await db.query<InstallationRecord>(
      `SELECT * FROM node_installations
        WHERE organization_id = $1 AND installation_id = $2`,
      [organizationId, installationId],
    );
    return result.rows[0] ?? null;
  },

  async list(db: Queryable, organizationId: string): Promise<InstallationRecord[]> {
    const result = await db.query<InstallationRecord>(
      `SELECT * FROM node_installations
        WHERE organization_id = $1
        ORDER BY created_at DESC
        LIMIT 100`,
      [organizationId],
    );
    return result.rows;
  },

  /**
   * Stop an installation that has not finished.
   *
   * The code is revoked in the same transaction, so cancelling in the browser
   * genuinely takes the capability away rather than only hiding the row.
   */
  async cancel(
    pool: Pool,
    organizationId: string,
    installationId: string,
  ): Promise<InstallationRecord | null> {
    return withTransaction(pool, async (client) => {
      const current = await client.query<InstallationRecord>(
        `SELECT * FROM node_installations
          WHERE organization_id = $1 AND installation_id = $2
          FOR UPDATE`,
        [organizationId, installationId],
      );
      const record = current.rows[0];
      if (!record || isTerminal(record.state)) return null;

      if (record.token_id) {
        await enrollmentTokensRepo.revoke(client, record.token_id, organizationId);
      }
      const updated = await client.query<InstallationRecord>(
        `UPDATE node_installations
            SET state = 'cancelled', cancelled_at = now(), updated_at = now()
          WHERE installation_id = $1
        RETURNING *`,
        [installationId],
      );
      const settled = updated.rows[0] ?? null;
      if (settled) await appendEvent(client, settled, null);
      return settled;
    });
  },

  /**
   * Find the installation a code belongs to, refusing to be used as an oracle.
   *
   * Every rejection — unknown, expired, revoked, already used, rate limited —
   * returns the same `null`. A caller learns whether the code it holds works and
   * nothing else, so the endpoint cannot be walked to discover which codes
   * exist.
   */
  async resolveByCode(
    pool: Pool,
    code: string,
    sourceAddress: string,
  ): Promise<InstallationRecord | null> {
    const codeDigest = digest(code);
    const sourceDigest = digest(sourceAddress || 'unknown');

    const counts = await pool.query<{ code_count: string; source_count: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE code_digest = $1)::text AS code_count,
         COUNT(*) FILTER (WHERE source_digest = $2)::text AS source_count
       FROM node_installation_attempts
       WHERE attempted_at > now() - ($3::bigint || ' milliseconds')::interval
         AND succeeded = FALSE`,
      [codeDigest, sourceDigest, String(REDEMPTION_LIMITS.windowMs)],
    );
    const blocked =
      Number(counts.rows[0]?.code_count ?? 0) >= REDEMPTION_LIMITS.perCode ||
      Number(counts.rows[0]?.source_count ?? 0) >= REDEMPTION_LIMITS.perSource;
    if (blocked) {
      await recordAttempt(pool, codeDigest, sourceDigest, false);
      return null;
    }

    const result = await pool.query<InstallationRecord>(
      `SELECT i.* FROM node_installations i
         JOIN enrollment_tokens t ON t.token_id = i.token_id
        WHERE t.token_digest = $1
          AND t.revoked_at IS NULL
          AND t.expires_at > now()
          AND i.expires_at > now()
          AND i.cancelled_at IS NULL
          AND i.state NOT IN ('complete', 'failed', 'cancelled', 'expired')`,
      [hashToken(code)],
    );
    const record = result.rows[0] ?? null;
    await recordAttempt(pool, codeDigest, sourceDigest, Boolean(record));
    return record;
  },

  /**
   * Apply one progress report.
   *
   * The decision of whether it may be applied is made by the pure model, under
   * `FOR UPDATE`, so two reports arriving together cannot both read the same
   * "current" percentage and both decide they move it forward.
   */
  async recordProgress(
    pool: Pool,
    installationId: string,
    report: {
      state: InstallationState;
      generation: number;
      bytesDone?: number | null;
      bytesTotal?: number | null;
      failureCode?: FailureCode | null;
      detail?: Record<string, unknown> | null;
    },
  ): Promise<{ record: InstallationRecord; applied: boolean; reason?: string }> {
    return withTransaction(pool, async (client) => {
      const current = await client.query<InstallationRecord>(
        'SELECT * FROM node_installations WHERE installation_id = $1 FOR UPDATE',
        [installationId],
      );
      const record = current.rows[0];
      if (!record) throw new Error('unknown installation');

      const decision = decideProgress(
        { state: record.state, generation: record.generation, percent: record.percent },
        report,
      );
      if (!decision.apply) return { record, applied: false, reason: decision.reason };

      // A failure leaves the bar where the attempt stopped: moving it would
      // claim progress that did not happen, and zeroing it would hide how far
      // the attempt got before it broke.
      const percent = report.state === 'failed' ? record.percent : decision.percent;

      const updated = await client.query<InstallationRecord>(
        `UPDATE node_installations
            SET state = $2,
                generation = GREATEST(generation, $3),
                percent = $4,
                bytes_done = $5,
                bytes_total = $6,
                failure_code = $7,
                retryable = $8,
                completed_at = CASE WHEN $2 = 'complete' THEN now() ELSE completed_at END,
                updated_at = now()
          WHERE installation_id = $1
        RETURNING *`,
        [
          installationId,
          report.state,
          report.generation,
          percent,
          report.bytesDone ?? null,
          report.bytesTotal ?? null,
          report.failureCode ?? null,
          report.failureCode ? isRetryable(report.failureCode) : null,
        ],
      );
      const settled = updated.rows[0];
      if (!settled) throw new Error('installation update returned no row');
      await appendEvent(client, settled, report.detail ?? null);
      return { record: settled, applied: true };
    });
  },

  /** Attach the Node identity once enrollment has produced one. */
  async attachNode(db: Queryable, installationId: string, nodeId: string): Promise<void> {
    await db.query(
      'UPDATE node_installations SET node_id = $2, updated_at = now() WHERE installation_id = $1',
      [installationId, nodeId],
    );
  },

  /**
   * Link the installation whose code was just redeemed to the Node it made.
   *
   * Takes a `Queryable` so it runs inside the enrolment transaction: an
   * installation naming a Node the transaction went on to roll back would be
   * worse than one naming none. Without this the console has a completed
   * installation it cannot turn into a link to the Node, which is where the
   * person goes next.
   */
  async attachNodeByToken(db: Queryable, tokenId: string, nodeId: string): Promise<void> {
    await db.query(
      `UPDATE node_installations
          SET node_id = $2, updated_at = now()
        WHERE token_id = $1 AND node_id IS NULL`,
      [tokenId, nodeId],
    );
  },

  async eventsSince(
    db: Queryable,
    installationId: string,
    sinceSeq: number,
    limit = 500,
  ): Promise<InstallationEventRecord[]> {
    const result = await db.query<InstallationEventRecord>(
      `SELECT * FROM node_installation_events
        WHERE installation_id = $1 AND seq > $2
        ORDER BY seq ASC
        LIMIT $3`,
      [installationId, String(sinceSeq), limit],
    );
    return result.rows;
  },

  /**
   * Retire installations whose code has run out of time.
   *
   * An expired attempt is a fact rather than an absence: the browser shows why
   * it stopped, and the capability is gone either way because the token carries
   * its own expiry.
   */
  async expireOverdue(pool: Pool): Promise<number> {
    const result = await pool.query<{ installation_id: string }>(
      `UPDATE node_installations
          SET state = 'expired', updated_at = now()
        WHERE expires_at <= now()
          AND state NOT IN ('complete', 'failed', 'cancelled', 'expired')
      RETURNING installation_id`,
    );
    return result.rowCount ?? 0;
  },
};

/**
 * Append one row to the installation's history.
 *
 * The sequence is allocated from the rows already there rather than from a
 * counter on the attempt, so a replayed or duplicated delivery cannot leave a
 * gap that a resuming browser would wait for forever.
 */
async function appendEvent(
  client: PoolClient,
  record: InstallationRecord,
  detail: Record<string, unknown> | null,
): Promise<void> {
  await client.query(
    `INSERT INTO node_installation_events
       (installation_id, seq, generation, state, percent, bytes_done, bytes_total,
        failure_code, detail)
     VALUES ($1,
             COALESCE((SELECT MAX(seq) FROM node_installation_events WHERE installation_id = $1), 0) + 1,
             $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      record.installation_id,
      record.generation,
      record.state,
      record.percent,
      record.bytes_done,
      record.bytes_total,
      record.failure_code,
      JSON.stringify(detail),
    ],
  );
}

async function recordAttempt(
  db: Queryable,
  codeDigest: string,
  sourceDigest: string,
  succeeded: boolean,
): Promise<void> {
  await db.query(
    `INSERT INTO node_installation_attempts (code_digest, source_digest, succeeded)
     VALUES ($1, $2, $3)`,
    [codeDigest, sourceDigest, succeeded],
  );
}

export { generateToken };
