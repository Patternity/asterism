/**
 * Capability URLs for stored images.
 *
 * The model provider fetches image URLs itself, from its own infrastructure. It
 * has no browser session and no Asterism credential, so a stored image needs a
 * link that authenticates by possession alone.
 *
 * That is a real trade and worth stating plainly: **anyone holding one of these
 * URLs can read that one image.** The design limits the blast radius rather than
 * pretending otherwise — one URL grants one image, nothing else; it is signed
 * with a key used for nothing else; and it stops working the moment the
 * attachment is disabled or removed.
 *
 * The signature covers the attachment id, so editing the id in a URL produces a
 * link that verifies against nothing. Verification is constant-time, because a
 * signature check that leaks its progress through timing is a signature check
 * that can be walked.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** The public route prefix. Deliberately outside `/api`, which is authenticated. */
export const MEDIA_ROUTE_PREFIX = '/_asterism/media/v1';

/**
 * Domain separation.
 *
 * Signing a bare id would let this key's output be meaningful in any other
 * context that ever signs ids with it. The prefix keeps a signature valid only
 * for this purpose.
 */
const SIGNATURE_CONTEXT = 'asterism.media.v1';

export function signAttachment(attachmentId: string, key: string): string {
  return createHmac('sha256', key)
    .update(`${SIGNATURE_CONTEXT}:${attachmentId}`)
    .digest('base64url');
}

export function verifyAttachmentSignature(
  attachmentId: string,
  signature: string,
  key: string,
): boolean {
  if (!key || !signature) return false;
  const expected = Buffer.from(signAttachment(attachmentId, key));
  const provided = Buffer.from(signature);
  // `timingSafeEqual` throws on a length mismatch, which would itself be a
  // timing signal; comparing lengths first keeps the failure uniform.
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

/**
 * The absolute URL handed to the Node, and through it to the model provider.
 *
 * Absolute because the fetcher is a third party with no notion of this
 * deployment's origin. It is built from `PUBLIC_BASE_URL`, so a deployment that
 * changes address changes these links too — which is correct: the old address
 * stops serving them.
 */
export function attachmentCapabilityUrl(
  publicBaseUrl: string,
  attachmentId: string,
  key: string,
): string {
  const base = publicBaseUrl.replace(/\/+$/, '');
  return `${base}${MEDIA_ROUTE_PREFIX}/${attachmentId}/${signAttachment(attachmentId, key)}`;
}

/**
 * Strip a capability from a string that is about to be logged.
 *
 * The signature is the credential, so a log line carrying one hands out the
 * image to whoever reads the log. Kept here beside the code that mints them, so
 * both change together.
 */
export function redactCapabilityUrls(value: string): string {
  const escaped = MEDIA_ROUTE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.replace(new RegExp(`(${escaped}/[^/\\s"']+)/[A-Za-z0-9_-]+`, 'g'), '$1/<redacted>');
}
