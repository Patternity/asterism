/**
 * Deciding what an uploaded file actually is, and making it safe to store.
 *
 * Nothing the browser says about a file is believed. The extension is a string
 * the user chose, the MIME type is a string the browser guessed, and neither
 * survives contact with a file that was renamed. The format is determined by
 * decoding the bytes, and a submitted type that disagrees with them is a
 * rejection rather than a correction — a mismatch is either a confused client
 * or a deliberate one, and neither should be silently accommodated.
 *
 * Every accepted image is re-encoded rather than stored as received. That is
 * what removes EXIF, GPS coordinates, comments, embedded thumbnails and colour
 * profiles: a photograph carries the place it was taken, and this feature would
 * otherwise publish that to a capability URL along with the pixels. Re-encoding
 * also flattens animation and drops any trailing data smuggled after the image.
 */
import sharp, { type Metadata } from 'sharp';

/** What a browser may offer and what the model provider can read. */
export const SUPPORTED_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type SupportedMediaType = (typeof SUPPORTED_MEDIA_TYPES)[number];

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const MAX_DIMENSION = 8192;
export const MAX_PIXELS = 25_000_000;
export const MAX_FILENAME_LENGTH = 255;

/** sharp's format names for what we accept, and what each is stored as. */
const FORMAT_TO_MEDIA_TYPE: Record<string, SupportedMediaType> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const MEDIA_TYPE_TO_EXTENSION: Record<SupportedMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export type IntakeErrorCode =
  | 'empty_file'
  | 'file_too_large'
  | 'unsupported_media_type'
  | 'media_type_mismatch'
  | 'malformed_image'
  | 'animated_image'
  | 'image_too_large'
  | 'too_many_pixels'
  | 'filename_too_long';

export class ImageIntakeError extends Error {
  readonly code: IntakeErrorCode;

  constructor(code: IntakeErrorCode, message: string) {
    super(message);
    this.name = 'ImageIntakeError';
    this.code = code;
  }
}

export interface NormalizedImage {
  bytes: Buffer;
  mediaType: SupportedMediaType;
  extension: string;
  width: number;
  height: number;
}

export function isSupportedMediaType(value: string): value is SupportedMediaType {
  return (SUPPORTED_MEDIA_TYPES as readonly string[]).includes(value);
}

export function sanitizeFilename(value: string | undefined): string | null {
  if (!value) return null;
  // Kept for display only — it never reaches a filesystem path — so the work
  // here is stripping what would corrupt a log line or a rendered label.
  const cleaned = [...value]
    .filter((character) => character >= ' ' && character !== '\u007f')
    .join('')
    .replace(/[\\/]/g, '_')
    .trim();
  if (!cleaned) return null;
  if (cleaned.length > MAX_FILENAME_LENGTH) {
    throw new ImageIntakeError(
      'filename_too_long',
      `filename is longer than ${MAX_FILENAME_LENGTH} characters`,
    );
  }
  return cleaned;
}

/**
 * Decode, check, and re-encode one uploaded image.
 *
 * `declaredMediaType` is what the browser claimed. It is checked against what
 * the bytes turn out to be, never used in place of them.
 */
export async function normalizeUploadedImage(
  bytes: Buffer,
  declaredMediaType: string,
): Promise<NormalizedImage> {
  if (bytes.byteLength === 0) {
    throw new ImageIntakeError('empty_file', 'the file is empty');
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new ImageIntakeError(
      'file_too_large',
      `each image must be ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB or smaller`,
    );
  }
  if (!isSupportedMediaType(declaredMediaType)) {
    throw new ImageIntakeError(
      'unsupported_media_type',
      `only ${SUPPORTED_MEDIA_TYPES.join(', ')} are supported`,
    );
  }

  // `limitInputPixels` refuses a decompression bomb before it is decoded rather
  // than after: the point of the pixel cap is to avoid allocating the buffer.
  const image = sharp(bytes, { animated: false, limitInputPixels: MAX_PIXELS });

  let metadata: Metadata;
  try {
    metadata = await image.metadata();
  } catch {
    throw new ImageIntakeError('malformed_image', 'the file is not a readable image');
  }

  const actual = metadata.format ? FORMAT_TO_MEDIA_TYPE[metadata.format] : undefined;
  if (!actual) {
    // SVG, GIF, HEIC, PDF and everything else land here. Naming the detected
    // format would be friendlier, but it also confirms to a prober exactly what
    // the decoder recognised.
    throw new ImageIntakeError(
      'unsupported_media_type',
      `only ${SUPPORTED_MEDIA_TYPES.join(', ')} are supported`,
    );
  }
  if (actual !== declaredMediaType) {
    throw new ImageIntakeError(
      'media_type_mismatch',
      `the file is ${actual}, not the ${declaredMediaType} it was sent as`,
    );
  }
  // A multi-page or multi-frame image is animation or a document, whatever its
  // container claims. Neither belongs in a single still attachment.
  if ((metadata.pages ?? 1) > 1) {
    throw new ImageIntakeError('animated_image', 'animated images are not supported');
  }

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width <= 0 || height <= 0) {
    throw new ImageIntakeError('malformed_image', 'the image has no usable dimensions');
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new ImageIntakeError(
      'image_too_large',
      `each side must be ${MAX_DIMENSION} pixels or fewer`,
    );
  }
  if (width * height > MAX_PIXELS) {
    throw new ImageIntakeError(
      'too_many_pixels',
      `the image must be ${MAX_PIXELS / 1_000_000} megapixels or fewer`,
    );
  }

  // Re-encode to the same format the bytes already are, so nothing is silently
  // converted; the point is the discarded metadata, not a format change.
  // `withMetadata` is deliberately not called: its absence is what drops EXIF.
  const pipeline = sharp(bytes, { animated: false, limitInputPixels: MAX_PIXELS });
  let normalized: Buffer;
  try {
    normalized =
      actual === 'image/png'
        ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
        : actual === 'image/jpeg'
          ? await pipeline.jpeg({ quality: 90, mozjpeg: true }).toBuffer()
          : await pipeline.webp({ quality: 90 }).toBuffer();
  } catch {
    throw new ImageIntakeError('malformed_image', 'the image could not be processed');
  }

  if (normalized.byteLength === 0) {
    throw new ImageIntakeError('malformed_image', 'the image could not be processed');
  }

  return {
    bytes: normalized,
    mediaType: actual,
    extension: MEDIA_TYPE_TO_EXTENSION[actual],
    width,
    height,
  };
}
