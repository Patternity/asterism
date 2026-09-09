/**
 * Persistence for the credentials a Node reports.
 *
 * A Node's report is the whole truth about that Node: it lists everything it
 * holds, so a credential missing from a later report is one that is gone. The
 * write is therefore a replacement rather than a merge — merging would keep a
 * revoked credential visible forever, and the row nobody can explain is the one
 * an operator eventually acts on.
 */

import { readCredentials, type ReportedCredential } from './node-credentials.js';
import type { Queryable } from './repositories.js';

export interface CredentialRow {
  node_id: string;
  credential_id: string;
  provider_id: string;
  auth_method: string;
  label: string;
  state: string;
  created_at: Date | null;
  updated_at: Date | null;
  recorded_at: Date;
}

const COLUMNS = `node_id, credential_id, provider_id, auth_method, label, state,
                 created_at, updated_at, recorded_at`;

export const nodeCredentialsRepo = {
  /**
   * Replace what is recorded for this Node with what it just reported.
   *
   * In one transaction the caller supplies, so a console never sees a Node with
   * no credentials halfway through a refresh.
   */
  async replace(
    db: Queryable,
    nodeId: string,
    reported: unknown,
  ): Promise<ReturnType<typeof readCredentials>> {
    const verdict = readCredentials(reported);
    if (verdict.status === 'malformed') return verdict;

    await db.query('DELETE FROM node_provider_credentials WHERE node_id = $1', [nodeId]);
    for (const credential of verdict.credentials) {
      await db.query(
        `INSERT INTO node_provider_credentials
           (node_id, credential_id, provider_id, auth_method, label, state,
            created_at, updated_at, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7), to_timestamp($8), now())`,
        [
          nodeId,
          credential.id,
          credential.provider_id,
          credential.auth_method,
          credential.label,
          credential.state,
          credential.created_at,
          credential.updated_at,
        ],
      );
    }
    return verdict;
  },

  async forNode(db: Queryable, nodeId: string): Promise<CredentialRow[]> {
    const result = await db.query<CredentialRow>(
      `SELECT ${COLUMNS} FROM node_provider_credentials
        WHERE node_id = $1 ORDER BY created_at ASC NULLS LAST, credential_id ASC`,
      [nodeId],
    );
    return result.rows;
  },

  /** Whether this Node has recorded a credential by this id. */
  async exists(db: Queryable, nodeId: string, credentialId: string): Promise<boolean> {
    const result = await db.query(
      'SELECT 1 FROM node_provider_credentials WHERE node_id = $1 AND credential_id = $2',
      [nodeId, credentialId],
    );
    return (result.rowCount ?? 0) > 0;
  },
};

export type { ReportedCredential };
