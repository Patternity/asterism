/**
 * Turning a multipart chat submission into stored images.
 *
 * The upload happens as part of sending the message, not when the file is
 * picked. Picking a file and then closing the composer is an ordinary thing to
 * do, and a server-side upload at selection time would leave a file nobody ever
 * referenced — with no owner, no run, and nothing to clean it up. Until the
 * user actually sends, the bytes stay in their browser.
 *
 * Everything here is written so the route handler can sequence it: read the
 * parts, refuse early on anything cheap to check, store, and — if the run does
 * not become durable — undo. Storage happens before the transaction because
 * files are not transactional; `discard` is how they rejoin the rollback.
 */
import type { FastifyRequest } from 'fastify';

import { attachmentsRepo, type AttachmentRow } from './attachment-repository.js';
import type { Pool, PoolClient } from './db.js';
import {
  ImageIntakeError,
  MAX_FILENAME_LENGTH,
  normalizeUploadedImage,
  sanitizeFilename,
} from './image-intake.js';
import type { MediaStorage } from './media-storage.js';

/** The JSON part carries everything the non-multipart endpoint accepts. */
export const RUN_REQUEST_PART = 'request';
export const IMAGE_PART = 'images';

export interface UploadedFile {
  buffer: Buffer;
  filename: string | null;
  declaredMediaType: string;
  /** Per-image alt text, matched to the file by position. */
  alt: string | null;
}

export interface MultipartRunRequest {
  body: unknown;
  files: UploadedFile[];
}

export class MultipartError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MultipartError';
    this.code = code;
  }
}

/**
 * Read one multipart run submission into memory.
 *
 * Images are bounded and small by policy, so buffering is simpler and safer
 * than streaming to a temporary path that then needs its own cleanup. The
 * multipart plugin enforces the byte ceilings; exceeding one throws before the
 * whole body has been read.
 */
export async function readMultipartRunRequest(
  request: FastifyRequest,
  maxFiles: number,
): Promise<MultipartRunRequest> {
  let body: unknown;
  const files: UploadedFile[] = [];
  const alts = new Map<number, string>();

  let parts;
  try {
    parts = request.parts();
  } catch {
    throw new MultipartError('invalid_request', 'the request is not valid multipart form data');
  }

  try {
    for await (const part of parts) {
      if (part.type === 'file') {
        if (part.fieldname !== IMAGE_PART) {
          // Draining is required: an unconsumed file part stalls the stream.
          await part.toBuffer();
          throw new MultipartError('invalid_request', `unexpected file field "${part.fieldname}"`);
        }
        if (files.length >= maxFiles) {
          await part.toBuffer();
          throw new MultipartError(
            'too_many_attachments',
            `at most ${maxFiles} images are allowed on one message`,
          );
        }
        files.push({
          buffer: await part.toBuffer(),
          filename: sanitizeFilename(part.filename),
          declaredMediaType: part.mimetype,
          alt: null,
        });
        continue;
      }

      if (part.fieldname === RUN_REQUEST_PART) {
        // A field labelled `application/json` is parsed by the plugin, so the
        // value arrives as an object; a field sent without a content type
        // arrives as a string. Both are legitimate ways to send this part.
        if (part.value !== null && typeof part.value === 'object') {
          body = part.value;
          continue;
        }
        try {
          body = JSON.parse(String(part.value));
        } catch {
          throw new MultipartError('invalid_request', 'the request part is not valid JSON');
        }
        continue;
      }

      // `alt.0`, `alt.1`, … keep a label with its image without depending on
      // part ordering, which a client is not obliged to guarantee.
      const altMatch = /^alt\.(\d+)$/.exec(part.fieldname);
      if (altMatch) {
        const index = Number(altMatch[1]);
        if (Number.isInteger(index) && index >= 0 && index < maxFiles) {
          alts.set(index, String(part.value));
        }
      }
    }
  } catch (error) {
    if (error instanceof MultipartError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/request file too large|reached files limit|field.*too large/i.test(message)) {
      throw new MultipartError('file_too_large', 'the upload exceeds the size limit');
    }
    throw new MultipartError('invalid_request', 'the multipart request could not be read');
  }

  if (body === undefined) {
    throw new MultipartError('invalid_request', `a "${RUN_REQUEST_PART}" JSON part is required`);
  }
  for (const [index, alt] of alts) {
    const file = files[index];
    if (!file) continue;
    const trimmed = alt.trim();
    if (trimmed.length > MAX_FILENAME_LENGTH) {
      throw new MultipartError('invalid_request', 'an image label is too long');
    }
    file.alt = trimmed || null;
  }

  return { body, files };
}

export interface StoredUpload {
  row: AttachmentRow;
  alt: string | null;
}

export interface PersistedUploads {
  stored: StoredUpload[];
  /**
   * Undo everything this call created.
   *
   * Called when the run does not become durable. Failures here are swallowed on
   * purpose: the caller is already returning an error, and a cleanup problem
   * must not replace the real reason with a confusing one. The residue is an
   * unreferenced file, not a broken run.
   */
  discard(): Promise<void>;
}

/**
 * Normalize, store, and record every uploaded image.
 *
 * Runs before the run transaction, and on any failure removes what it already
 * wrote — including for the images that had succeeded. A partially stored
 * message would otherwise leave files owned by a run that never existed.
 */
export async function persistUploadedImages(
  pool: Pool,
  storage: MediaStorage,
  files: UploadedFile[],
  owner: { organizationId: string; projectId: string; userId: string },
): Promise<PersistedUploads> {
  const stored: StoredUpload[] = [];

  const discard = async (): Promise<void> => {
    await Promise.all(
      stored.map(async (item) => {
        await storage.remove(item.row.storage_key).catch(() => undefined);
      }),
    );
    await attachmentsRepo
      .remove(
        pool,
        stored.map((item) => item.row.attachment_id),
      )
      .catch(() => undefined);
  };

  try {
    for (const file of files) {
      const normalized = await normalizeUploadedImage(file.buffer, file.declaredMediaType);
      const object = await storage.put(normalized.bytes, normalized.extension);
      const row = await attachmentsRepo.create(pool, {
        organizationId: owner.organizationId,
        projectId: owner.projectId,
        createdByUserId: owner.userId,
        originalFilename: file.filename,
        mediaType: normalized.mediaType,
        byteSize: object.byteSize,
        width: normalized.width,
        height: normalized.height,
        sha256: object.sha256,
        storageKey: object.storageKey,
      });
      stored.push({ row, alt: file.alt });
    }
  } catch (error) {
    await discard();
    throw error;
  }

  return { stored, discard };
}

export function intakeErrorResponse(error: unknown): { code: string; message: string } | null {
  if (error instanceof ImageIntakeError) return { code: error.code, message: error.message };
  if (error instanceof MultipartError) return { code: error.code, message: error.message };
  return null;
}

export async function linkUploads(
  client: PoolClient,
  runId: string,
  uploads: StoredUpload[],
  startPosition: number,
): Promise<void> {
  await attachmentsRepo.link(
    client,
    runId,
    uploads.map((item, index) => ({
      attachmentId: item.row.attachment_id,
      position: startPosition + index,
      alt: item.alt,
    })),
  );
}
