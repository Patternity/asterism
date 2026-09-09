/**
 * Persistence for reported provider capabilities.
 *
 * Every judgement comes from `provider-capabilities.ts`, which is pure and holds
 * no provider list. What lives here is the writing down and the reading back,
 * including the two states a row cannot express on its own: a Node that never
 * reported, and a Node whose report is old because it is not connected.
 */

import {
  readSnapshot,
  type ProviderCapability,
  type ProviderSnapshot,
} from './provider-capabilities.js';
import type { Queryable } from './repositories.js';

export interface CapabilityRow {
  node_id: string;
  status: 'ok' | 'unsupported_schema';
  schema_version: number;
  runtime_release: string | null;
  providers: ProviderCapability[] | null;
  reported_at: Date | null;
  recorded_at: Date;
}

/**
 * What the API and the console see.
 *
 * `unknown` is a first-class answer, not an empty list. A Node released before
 * this contract has said nothing about providers, and presenting that as "no
 * providers" would be a confident claim nobody made.
 */
export type CapabilityView =
  | { state: 'unknown' }
  | {
      state: 'reported';
      status: 'ok' | 'unsupported_schema';
      schema_version: number;
      runtime_release: string | null;
      providers: ProviderCapability[] | null;
      reported_at: string | null;
      recorded_at: string;
      /** True when the Node is not connected, so this describes the past. */
      stale: boolean;
    };

const COLUMNS = `node_id, status, schema_version, runtime_release, providers, reported_at, recorded_at`;

export const providerCapabilitiesRepo = {
  /**
   * Record what a Node reported, replacing whatever it said before.
   *
   * Returns the verdict so a caller can log a refusal without re-deriving it.
   * A malformed report writes nothing at all: the previous snapshot, which was
   * at least readable, is better than a row that says nothing.
   */
  async record(
    db: Queryable,
    nodeId: string,
    reported: unknown,
  ): Promise<ReturnType<typeof readSnapshot>> {
    const verdict = readSnapshot(reported);
    if (verdict.status === 'malformed') return verdict;

    const snapshot: ProviderSnapshot | null = verdict.status === 'ok' ? verdict.snapshot : null;
    await db.query(
      `INSERT INTO node_provider_capabilities
         (node_id, status, schema_version, runtime_release, providers, reported_at, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (node_id) DO UPDATE SET
         status = EXCLUDED.status,
         schema_version = EXCLUDED.schema_version,
         runtime_release = EXCLUDED.runtime_release,
         providers = EXCLUDED.providers,
         reported_at = EXCLUDED.reported_at,
         recorded_at = now()`,
      [
        nodeId,
        verdict.status === 'ok' ? 'ok' : 'unsupported_schema',
        verdict.status === 'ok' ? verdict.snapshot.schema_version : verdict.schemaVersion,
        snapshot?.runtime_release ?? null,
        snapshot ? JSON.stringify(snapshot.providers) : null,
        snapshot ? new Date(snapshot.reported_at * 1000) : null,
      ],
    );
    return verdict;
  },

  async byNode(db: Queryable, nodeId: string): Promise<CapabilityRow | null> {
    const result = await db.query<CapabilityRow>(
      `SELECT ${COLUMNS} FROM node_provider_capabilities WHERE node_id = $1`,
      [nodeId],
    );
    return result.rows[0] ?? null;
  },

  /**
   * The view for one Node, given whether it is connected right now.
   *
   * Staleness is not a column. It is a fact about the present — the Node is not
   * here — applied to a record of the past, and computing it at read time is
   * what keeps a row from claiming to be current after the Node goes away.
   */
  async viewFor(db: Queryable, nodeId: string, online: boolean): Promise<CapabilityView> {
    const row = await providerCapabilitiesRepo.byNode(db, nodeId);
    if (!row) return { state: 'unknown' };
    return {
      state: 'reported',
      status: row.status,
      schema_version: row.schema_version,
      runtime_release: row.runtime_release,
      providers: row.providers,
      reported_at: row.reported_at ? row.reported_at.toISOString() : null,
      recorded_at: row.recorded_at.toISOString(),
      stale: !online,
    };
  },
};
