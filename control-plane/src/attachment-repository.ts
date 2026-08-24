/**
 * Stored-attachment rows.
 *
 * Every read is scoped by organization and project in SQL, not filtered
 * afterwards in TypeScript. An attachment id is an opaque handle a caller may
 * have obtained anywhere, so the query itself has to be the authorization
 * boundary — a `WHERE` clause cannot be forgotten the way a later `if` can.
 */
import { randomUUID } from 'node:crypto';

import type { Queryable } from './repositories.js';

export interface AttachmentRow {
  attachment_id: string;
  organization_id: string;
  project_id: string;
  created_by_user_id: string | null;
  kind: string;
  original_filename: string | null;
  media_type: string;
  byte_size: string | number;
  width: number;
  height: number;
  sha256: string;
  storage_key: string;
  state: string;
  created_at: Date;
}

export interface RunAttachmentRow extends AttachmentRow {
  run_id: string;
  position: number;
  alt: string | null;
}

function attachmentId(): string {
  return `att_${randomUUID().replace(/-/g, '')}`;
}

export const attachmentsRepo = {
  async create(
    db: Queryable,
    input: {
      organizationId: string;
      projectId: string;
      createdByUserId: string;
      originalFilename: string | null;
      mediaType: string;
      byteSize: number;
      width: number;
      height: number;
      sha256: string;
      storageKey: string;
    },
  ): Promise<AttachmentRow> {
    const result = await db.query<AttachmentRow>(
      `INSERT INTO attachments
         (attachment_id, organization_id, project_id, created_by_user_id, kind,
          original_filename, media_type, byte_size, width, height, sha256, storage_key)
       VALUES ($1, $2, $3, $4, 'uploaded_image', $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        attachmentId(),
        input.organizationId,
        input.projectId,
        input.createdByUserId,
        input.originalFilename,
        input.mediaType,
        input.byteSize,
        input.width,
        input.height,
        input.sha256,
        input.storageKey,
      ],
    );
    return result.rows[0]!;
  },

  /**
   * One attachment, readable only from inside its own organization and project.
   *
   * A disabled attachment is deliberately still returned: the caller decides
   * whether that means "hidden" or "gone", and the public media route needs to
   * answer identically for both.
   */
  async byId(
    db: Queryable,
    organizationId: string,
    projectId: string,
    attachmentIdValue: string,
  ): Promise<AttachmentRow | null> {
    const result = await db.query<AttachmentRow>(
      `SELECT * FROM attachments
       WHERE attachment_id = $1 AND organization_id = $2 AND project_id = $3`,
      [attachmentIdValue, organizationId, projectId],
    );
    return result.rows[0] ?? null;
  },

  /**
   * One attachment by id alone, for the public capability route.
   *
   * That route has no session and therefore no organization to scope by: the
   * signature is the authorization, and it covers this id specifically.
   */
  async byIdUnscoped(db: Queryable, attachmentIdValue: string): Promise<AttachmentRow | null> {
    const result = await db.query<AttachmentRow>(
      'SELECT * FROM attachments WHERE attachment_id = $1',
      [attachmentIdValue],
    );
    return result.rows[0] ?? null;
  },

  async link(
    db: Queryable,
    runId: string,
    entries: { attachmentId: string; position: number; alt: string | null }[],
  ): Promise<void> {
    for (const entry of entries) {
      await db.query(
        `INSERT INTO run_attachments (run_id, attachment_id, position, alt)
         VALUES ($1, $2, $3, $4)`,
        [runId, entry.attachmentId, entry.position, entry.alt],
      );
    }
  },

  /** One run's stored attachments, in the order the model saw them. */
  async forRun(db: Queryable, runId: string): Promise<RunAttachmentRow[]> {
    const result = await db.query<RunAttachmentRow>(
      `SELECT a.*, ra.run_id, ra.position, ra.alt
       FROM run_attachments ra
       JOIN attachments a ON a.attachment_id = ra.attachment_id
       WHERE ra.run_id = $1
       ORDER BY ra.position`,
      [runId],
    );
    return result.rows;
  },

  /**
   * The same, for several runs at once.
   *
   * The chat endpoint renders a whole conversation; asking per run would make
   * the query count grow with the transcript.
   */
  async forRuns(db: Queryable, runIds: string[]): Promise<Map<string, RunAttachmentRow[]>> {
    const grouped = new Map<string, RunAttachmentRow[]>();
    if (runIds.length === 0) return grouped;
    const result = await db.query<RunAttachmentRow>(
      `SELECT a.*, ra.run_id, ra.position, ra.alt
       FROM run_attachments ra
       JOIN attachments a ON a.attachment_id = ra.attachment_id
       WHERE ra.run_id = ANY($1::text[])
       ORDER BY ra.run_id, ra.position`,
      [runIds],
    );
    for (const row of result.rows) {
      const existing = grouped.get(row.run_id);
      if (existing) existing.push(row);
      else grouped.set(row.run_id, [row]);
    }
    return grouped;
  },

  async remove(db: Queryable, attachmentIds: string[]): Promise<void> {
    if (attachmentIds.length === 0) return;
    await db.query('DELETE FROM attachments WHERE attachment_id = ANY($1::text[])', [
      attachmentIds,
    ]);
  },
};

/**
 * What the browser is allowed to know about a stored attachment.
 *
 * Never the storage key, never the capability URL, never the signature. The
 * content URL here is the authenticated one, which requires the viewer's own
 * session — the provider's link and the browser's link are different doors to
 * the same image, and only one of them may be rendered.
 */
export function browserAttachment(
  row: RunAttachmentRow,
): Record<string, string | number | null | undefined> {
  return {
    type: 'uploaded_image',
    attachment_id: row.attachment_id,
    alt: row.alt ?? undefined,
    media_type: row.media_type,
    byte_size: Number(row.byte_size),
    width: row.width,
    height: row.height,
    original_filename: row.original_filename ?? undefined,
    state: row.state,
    content_url: `/api/v1/projects/${row.project_id}/attachments/${row.attachment_id}/content`,
  };
}
