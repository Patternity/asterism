/**
 * Image attachments in the composer.
 *
 * Nothing here downloads the image: the preview is an ordinary `<img>` the
 * browser loads, and the model provider fetches the URL when the run executes.
 * A preview that fails to load therefore says nothing about whether the model
 * will see it, which is why a broken thumbnail must never block sending.
 */
export const MAX_ATTACHMENTS = 4;
export const MAX_URL_LENGTH = 2048;
export const MAX_ALT_LENGTH = 200;

export interface Attachment {
  type: 'image_url';
  url: string;
  alt?: string;
}

/** Why a URL cannot be attached, in words the composer can show. */
export function attachmentProblem(url: string, existing: number): string | null {
  const candidate = url.trim();
  if (!candidate) return 'Enter an image URL.';
  if (existing >= MAX_ATTACHMENTS) return `At most ${MAX_ATTACHMENTS} images per message.`;
  if (candidate.length > MAX_URL_LENGTH) return 'That URL is too long.';

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return 'Enter a complete URL, including https://';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'Only http and https URLs can be attached.';
  }
  if (!parsed.hostname) return 'That URL has no host.';
  if (parsed.username || parsed.password) {
    return 'Remove the username and password from the URL — it is sent to the model provider.';
  }
  return null;
}

export function makeAttachment(url: string, alt: string): Attachment {
  const label = alt.trim().slice(0, MAX_ALT_LENGTH);
  return label
    ? { type: 'image_url', url: url.trim(), alt: label }
    : { type: 'image_url', url: url.trim() };
}

/** What to show on a card: the label if there is one, else a short URL. */
export function attachmentLabel(attachment: Attachment): string {
  if (attachment.alt) return attachment.alt;
  try {
    const parsed = new URL(attachment.url);
    const name = parsed.pathname.split('/').filter(Boolean).pop();
    return name || parsed.hostname;
  } catch {
    return attachment.url;
  }
}

/**
 * Attachments recorded on a submitted turn.
 *
 * Read from server state so a reload rebuilds the same cards rather than losing
 * them with component state, and so a replayed event cannot duplicate them.
 */
export function attachmentsOf(run: {
  request_metadata?: Record<string, unknown> | null;
}): Attachment[] {
  const raw = run.request_metadata?.attachments;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is Attachment =>
      Boolean(item) &&
      typeof item === 'object' &&
      (item as Attachment).type === 'image_url' &&
      typeof (item as Attachment).url === 'string',
  );
}

/** Limits the composer enforces before spending an upload on a doomed file. */
export interface UploadLimits {
  available: boolean;
  configured: boolean;
  max_attachments: number;
  max_bytes: number;
  max_request_bytes: number;
  max_dimension: number;
  max_pixels: number;
  media_types: string[];
}

/**
 * An image chosen but not yet sent.
 *
 * It exists only in the browser until the message is submitted. Picking a file
 * and then closing the composer must not leave anything on the server, so the
 * bytes stay here and the object URL is revoked the moment it stops being shown.
 */
export interface LocalImage {
  id: string;
  file: File;
  objectUrl: string;
  alt: string;
}

/** An image the server has stored, as the browser is allowed to see it. */
export interface UploadedAttachment {
  type: 'uploaded_image';
  attachment_id: string;
  alt?: string;
  media_type: string;
  byte_size: number;
  width: number;
  height: number;
  original_filename?: string;
  state: string;
  content_url: string;
}

export function uploadedAttachmentsOf(run: {
  uploaded_attachments?: UploadedAttachment[] | null;
}): UploadedAttachment[] {
  return Array.isArray(run.uploaded_attachments) ? run.uploaded_attachments : [];
}

export function describeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Why a chosen file cannot be sent, or null if it can.
 *
 * Checked in the browser so an obvious refusal is immediate; the server checks
 * again, and its answer is the one that counts.
 */
export function localImageProblem(file: File, limits: UploadLimits): string | null {
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > limits.max_bytes) {
    return `${file.name} is larger than ${describeBytes(limits.max_bytes)}.`;
  }
  if (file.type && !limits.media_types.includes(file.type)) {
    return `${file.name} is not a supported image type (${limits.media_types.join(', ')}).`;
  }
  return null;
}
