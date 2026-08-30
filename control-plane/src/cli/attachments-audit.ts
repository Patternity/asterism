/**
 * Report attachments whose row promises bytes the storage does not have.
 *
 * The console renders an attachment from its row, so a row that says `ready`
 * with nothing behind it produces an image that answers 404 forever, with no
 * way to tell from the outside whether the file was lost or the deployment is
 * simply pointed at the wrong storage. Those two causes want opposite
 * responses, so the first job here is to count them, not to change anything:
 * `--apply` is opt-in and the default is a report.
 *
 * `disabled` is the state the schema already defines for an attachment that
 * must stay referenced but must not be served. Marking a row that way keeps
 * historical runs structurally intact while every read path — authenticated
 * content, provider capability, retry — takes its existing unavailable branch.
 *
 *   node dist/src/cli/attachments-audit.js
 *   node dist/src/cli/attachments-audit.js --apply
 *   node dist/src/cli/attachments-audit.js --project <id> --json
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';

import { createPool } from '../db.js';
import { createMediaStorage, type MediaStorage } from '../media-storage.js';

interface Row {
  attachment_id: string;
  project_id: string;
  state: string;
  storage_key: string;
  byte_size: string | number;
  run_count: string | number;
}

interface Finding {
  attachment_id: string;
  project_id: string;
  state: string;
  storage_key: string;
  byte_size: number;
  runs: number;
  stored: boolean;
}

function parseArguments(argv: string[]): {
  apply: boolean;
  json: boolean;
  project?: string;
  attachment?: string;
} {
  const options: { apply: boolean; json: boolean; project?: string; attachment?: string } = {
    apply: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') options.apply = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--project') options.project = argv[(index += 1)];
    else if (argument === '--attachment') options.attachment = argv[(index += 1)];
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

export interface AuditOptions {
  apply?: boolean;
  project?: string;
  attachment?: string;
}

export interface AuditReport {
  action: 'attachments-audit';
  mode: 'apply' | 'dry-run';
  examined: number;
  unbacked: number;
  disabled: number;
  attachments: {
    attachment_id: string;
    project_id: string;
    storage_key: string;
    byte_size: number;
    runs: number;
    state: string;
  }[];
}

export async function auditAttachments(
  pool: Pick<Pool, 'query'>,
  storage: Pick<MediaStorage, 'read'>,
  options: AuditOptions = {},
): Promise<AuditReport> {
  const result = await pool.query<Row>(
    `SELECT a.attachment_id, a.project_id, a.state, a.storage_key, a.byte_size,
            (SELECT count(*) FROM run_attachments r WHERE r.attachment_id = a.attachment_id)
              AS run_count
       FROM attachments a
      WHERE ($1::text IS NULL OR a.project_id = $1)
        AND ($2::text IS NULL OR a.attachment_id = $2)
      ORDER BY a.created_at`,
    [options.project ?? null, options.attachment ?? null],
  );

  const findings: Finding[] = [];
  for (const row of result.rows) {
    // Presence is proven by reading, not by stat: a key that resolves outside
    // the storage root, or a file the runtime user cannot open, is missing as
    // far as every serving path is concerned.
    let stored = true;
    try {
      await storage.read(row.storage_key);
    } catch {
      stored = false;
    }
    findings.push({
      attachment_id: row.attachment_id,
      project_id: row.project_id,
      state: row.state,
      storage_key: row.storage_key,
      byte_size: Number(row.byte_size),
      runs: Number(row.run_count),
      stored,
    });
  }

  const unbacked = findings.filter((finding) => finding.state === 'ready' && !finding.stored);

  let disabled = 0;
  if (options.apply && unbacked.length > 0) {
    // Idempotent by predicate: a row already disabled is not matched above, so
    // a second pass over the same data changes nothing.
    const update = await pool.query(
      `UPDATE attachments SET state = 'disabled'
        WHERE attachment_id = ANY($1::text[]) AND state = 'ready'`,
      [unbacked.map((finding) => finding.attachment_id)],
    );
    disabled = update.rowCount ?? 0;
  }

  return {
    action: 'attachments-audit',
    mode: options.apply ? 'apply' : 'dry-run',
    examined: findings.length,
    unbacked: unbacked.length,
    disabled,
    attachments: unbacked.map((finding) => ({
      attachment_id: finding.attachment_id,
      project_id: finding.project_id,
      storage_key: finding.storage_key,
      byte_size: finding.byte_size,
      runs: finding.runs,
      state: options.apply ? 'disabled' : finding.state,
    })),
  };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const uploadDir = process.env.UPLOAD_DIR ?? '';
  if (!uploadDir) throw new Error('UPLOAD_DIR is required to check stored objects');

  const options = parseArguments(process.argv.slice(2));
  const storage = createMediaStorage(uploadDir);
  const pool = createPool(databaseUrl, 2);

  try {
    const report = await auditAttachments(pool, storage, options);
    console.log(options.json ? JSON.stringify(report) : JSON.stringify(report, null, 2));
  } finally {
    await pool.end();
  }
}

// Only when run as a command. The audit itself is imported by tests, and a
// module that connects to a database on import cannot be tested.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(JSON.stringify({ action: 'attachments-audit', error: String(error) }));
    process.exitCode = 1;
  });
}
