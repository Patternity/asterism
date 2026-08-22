/**
 * Image attachments on a chat turn.
 *
 * One type, `image_url`, carrying an ordinary http/https link.
 *
 * **Nothing in Asterism downloads the image.** Proven against the pinned Hermes
 * 0.20.0: the structured content part is forwarded unchanged and the *model
 * provider* fetches the URL. So there is no proxy and no bounded fetcher here —
 * adding one would build a remote-fetching service nothing asked for. The
 * consequence is a privacy property, documented rather than hidden: the URL
 * leaves the VPS, and whoever serves it sees a request from the provider.
 */
export const ATTACHMENT_TYPES = ['image_url'] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

/** Bounds the prompt, the stored payload, and one turn's fetch fan-out. */
export const MAX_ATTACHMENTS = 4;
export const MAX_URL_LENGTH = 2048;
export const MAX_ALT_LENGTH = 200;

export interface Attachment {
  type: AttachmentType;
  url: string;
  alt?: string;
}

export const ATTACHMENTS_UNSUPPORTED = 'attachments_unsupported';
export const INVALID_ATTACHMENT = 'invalid_attachment';

/**
 * Validate one turn's attachments.
 *
 * Returns a message on rejection rather than dropping the attachment: sending a
 * text-only run for a message the operator attached an image to would answer a
 * different question, and they would have no way to tell.
 */
export function validateAttachments(
  value: unknown,
): { ok: true; value: Attachment[] } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, message: 'attachments must be an array' };
  if (value.length > MAX_ATTACHMENTS) {
    return {
      ok: false,
      message: `at most ${MAX_ATTACHMENTS} attachments are allowed on one message`,
    };
  }

  const out: Attachment[] = [];
  for (const [index, raw] of value.entries()) {
    const item = raw as { type?: unknown; url?: unknown; alt?: unknown } | null;
    if (!item || typeof item !== 'object') {
      return { ok: false, message: `attachment ${index} must be an object` };
    }
    if (item.type !== 'image_url') {
      return {
        ok: false,
        message: `unsupported attachment type at ${index}; only "image_url" is supported`,
      };
    }
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    const problem = urlProblem(url);
    if (problem) return { ok: false, message: `attachment ${index}: ${problem}` };

    const alt = typeof item.alt === 'string' ? item.alt.trim() : '';
    if (alt.length > MAX_ALT_LENGTH) {
      return {
        ok: false,
        message: `attachment ${index}: label is longer than ${MAX_ALT_LENGTH} characters`,
      };
    }
    out.push(alt ? { type: 'image_url', url, alt } : { type: 'image_url', url });
  }
  // Order is preserved: it is what the model sees and what the transcript shows.
  return { ok: true, value: out };
}

function urlProblem(url: string): string | null {
  if (!url) return 'a url is required';
  if (url.length > MAX_URL_LENGTH) return `url is longer than ${MAX_URL_LENGTH} characters`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'url must be an absolute http or https url';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'url must use http or https';
  }
  if (!parsed.hostname) return 'url has no host';
  // Credentials here would be stored, journalled, and handed to a third party
  // that fetches the URL.
  if (parsed.username || parsed.password) return 'url must not embed credentials';
  return null;
}

/**
 * A form of the URL safe to log.
 *
 * The query is dropped wholesale: a signed link carries its credential there,
 * and a log line is exactly where such a value escapes notice.
 */
/**
 * Read attachments back out of a stored run metadata blob.
 *
 * This is the reverse of what run creation writes, and it is deliberately
 * forgiving: a row written by an older revision, or hand-edited, should leave
 * the conversation readable rather than failing the whole chat request. Only
 * entries that still describe a supported attachment survive.
 */
export function attachmentsOf(metadata: unknown): Attachment[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const raw = (metadata as Record<string, unknown>).attachments;
  if (!Array.isArray(raw)) return [];
  const attachments: Attachment[] = [];
  for (const item of raw.slice(0, MAX_ATTACHMENTS)) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Record<string, unknown>;
    if (candidate.type !== 'image_url' || typeof candidate.url !== 'string') continue;
    attachments.push({
      type: 'image_url',
      url: candidate.url,
      ...(typeof candidate.alt === 'string' ? { alt: candidate.alt } : {}),
    });
  }
  return attachments;
}

export function redactAttachmentUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const suffix = parsed.search || parsed.hash ? '?<redacted>' : '';
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${suffix}`;
  } catch {
    return '<invalid-url>';
  }
}

/** Attachment types the owning Node advertises, filtered to what we understand. */
export function supportedAttachmentTypes(capabilities: unknown): AttachmentType[] {
  const advertised = (capabilities as { attachments?: { run_attachments?: unknown } } | null)
    ?.attachments?.run_attachments;
  if (!Array.isArray(advertised)) return [];
  return advertised.filter(
    (value): value is AttachmentType =>
      typeof value === 'string' && (ATTACHMENT_TYPES as readonly string[]).includes(value),
  );
}
