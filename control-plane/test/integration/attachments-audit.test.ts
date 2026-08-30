/**
 * A row that promises bytes the storage does not have.
 *
 * This state is not hypothetical: a deployment pointed at the wrong uploads
 * mount produced four of them, and nothing in the product could say whether the
 * files had been lost or were simply somewhere else. The audit exists to answer
 * that in one command, so the reply below is deliberately about counting first
 * and changing state only when asked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { auditAttachments } from '../../src/cli/attachments-audit.js';
import { createPool, migrate, rollbackAll, type Pool } from '../../src/db.js';
import { createMediaStorage } from '../../src/media-storage.js';
import { BOOTSTRAP_ORGANIZATION_ID } from '../../src/tenancy.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://asterism:asterism@127.0.0.1:55432/asterism_cp';

let pool: Pool;
let uploadDir: string;

const PROJECT = 'audit-project';
const NODE = 'audit-node';

async function seedAttachment(
  attachmentId: string,
  storageKey: string,
  state = 'ready',
): Promise<void> {
  await pool.query(
    `INSERT INTO attachments
       (attachment_id, organization_id, project_id, kind, media_type, byte_size,
        width, height, sha256, storage_key, state)
     VALUES ($1, $2, $3, 'uploaded_image', 'image/png', 11, 1, 1, 'testsha', $4, $5)`,
    [attachmentId, BOOTSTRAP_ORGANIZATION_ID, PROJECT, storageKey, state],
  );
}

beforeAll(async () => {
  pool = createPool(DATABASE_URL, 4);
  // Migrate first: a rollback against a database that was never migrated
  // fails on tables its down steps expect to exist.
  await migrate(pool);
  await rollbackAll(pool);
  await migrate(pool);
  uploadDir = mkdtempSync(join(tmpdir(), 'asterism-audit-'));
  await pool.query(
    `INSERT INTO nodes (node_id, organization_id, display_name, public_key, fingerprint)
     VALUES ($1, $2, 'audit', 'k', 'f')`,
    [NODE, BOOTSTRAP_ORGANIZATION_ID],
  );
  await pool.query(
    `INSERT INTO projects
       (project_id, organization_id, node_id, node_project_id, display_name, enabled, available)
     VALUES ($1, $2, $3, 'p', 'audit', TRUE, TRUE)`,
    [PROJECT, BOOTSTRAP_ORGANIZATION_ID, NODE],
  );
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query('DELETE FROM attachments');
});

describe('attachments whose stored object is missing', () => {
  it('reports an unbacked row without changing it', async () => {
    await seedAttachment('att_gone', 'ab/ab111111111111111111111111111111.png');
    const storage = createMediaStorage(uploadDir);

    const report = await auditAttachments(pool, storage);

    expect(report.mode).toBe('dry-run');
    expect(report.unbacked).toBe(1);
    expect(report.disabled).toBe(0);
    expect(report.attachments[0]).toMatchObject({
      attachment_id: 'att_gone',
      storage_key: 'ab/ab111111111111111111111111111111.png',
      state: 'ready',
    });

    const after = await pool.query('SELECT state FROM attachments WHERE attachment_id = $1', [
      'att_gone',
    ]);
    expect(after.rows[0].state).toBe('ready');
  });

  it('leaves a row alone when its bytes are present', async () => {
    // The case that matters most: files that exist but were unreachable through
    // a wrong mount must never be reported as lost.
    mkdirSync(join(uploadDir, 'cd'), { recursive: true });
    writeFileSync(
      join(uploadDir, 'cd', 'cd222222222222222222222222222222.png'),
      Buffer.from('present'),
    );
    await seedAttachment('att_here', 'cd/cd222222222222222222222222222222.png');

    const report = await auditAttachments(pool, createMediaStorage(uploadDir));

    expect(report.examined).toBe(1);
    expect(report.unbacked).toBe(0);
  });

  it('disables only on apply, and repeating it changes nothing', async () => {
    await seedAttachment('att_gone', 'ab/ab111111111111111111111111111111.png');
    const storage = createMediaStorage(uploadDir);

    const first = await auditAttachments(pool, storage, { apply: true });
    expect(first.disabled).toBe(1);

    // The row is no longer `ready`, so the second pass has nothing to match:
    // running the command twice is not a different operation from running it
    // once.
    const second = await auditAttachments(pool, storage, { apply: true });
    expect(second.unbacked).toBe(0);
    expect(second.disabled).toBe(0);

    const after = await pool.query('SELECT state FROM attachments WHERE attachment_id = $1', [
      'att_gone',
    ]);
    expect(after.rows[0].state).toBe('disabled');
  });

  it('scopes to one attachment when asked', async () => {
    await seedAttachment('att_one', 'ab/ab333333333333333333333333333333.png');
    await seedAttachment('att_two', 'ab/ab444444444444444444444444444444.png');

    const report = await auditAttachments(pool, createMediaStorage(uploadDir), {
      attachment: 'att_one',
    });

    expect(report.examined).toBe(1);
    expect(report.attachments.map((a) => a.attachment_id)).toEqual(['att_one']);
  });

  it('reports nothing for an attachment already disabled', async () => {
    await seedAttachment('att_known', 'ab/ab555555555555555555555555555555.png', 'disabled');

    const report = await auditAttachments(pool, createMediaStorage(uploadDir));

    expect(report.examined).toBe(1);
    expect(report.unbacked).toBe(0);
  });
});
