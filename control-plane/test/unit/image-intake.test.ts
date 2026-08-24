/**
 * What the intake accepts, what it refuses, and what it strips.
 *
 * The fixtures are generated rather than committed: a repository is a bad place
 * for binary blobs, and generating them means each test states the property it
 * depends on instead of trusting an opaque file.
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

import {
  ImageIntakeError,
  MAX_DIMENSION,
  MAX_UPLOAD_BYTES,
  normalizeUploadedImage,
  sanitizeFilename,
} from '../../src/image-intake.js';

async function solid(
  width: number,
  height: number,
  format: 'png' | 'jpeg' | 'webp',
): Promise<Buffer> {
  const image = sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 120, b: 200 } },
  });
  if (format === 'png') return image.png().toBuffer();
  if (format === 'jpeg') return image.jpeg().toBuffer();
  return image.webp().toBuffer();
}

async function failureCode(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    if (error instanceof ImageIntakeError) return error.code;
    throw error;
  }
  throw new Error('expected the intake to refuse this image');
}

describe('accepted formats', () => {
  it('accepts a PNG and reports its real type and size', async () => {
    const result = await normalizeUploadedImage(await solid(64, 48, 'png'), 'image/png');
    expect(result.mediaType).toBe('image/png');
    expect(result.extension).toBe('png');
    expect(result.width).toBe(64);
    expect(result.height).toBe(48);
    expect(result.bytes.byteLength).toBeGreaterThan(0);
  });

  it('accepts a JPEG', async () => {
    const result = await normalizeUploadedImage(await solid(32, 32, 'jpeg'), 'image/jpeg');
    expect(result.mediaType).toBe('image/jpeg');
    expect(result.extension).toBe('jpg');
  });

  it('accepts a WebP', async () => {
    const result = await normalizeUploadedImage(await solid(32, 32, 'webp'), 'image/webp');
    expect(result.mediaType).toBe('image/webp');
    expect(result.extension).toBe('webp');
  });

  it('keeps the stored bytes decodable as the type it reports', async () => {
    const result = await normalizeUploadedImage(await solid(40, 20, 'png'), 'image/png');
    const stored = await sharp(result.bytes).metadata();
    expect(stored.format).toBe('png');
    expect(stored.width).toBe(40);
    expect(stored.height).toBe(20);
  });
});

describe('refused uploads', () => {
  it('refuses an empty file', async () => {
    expect(await failureCode(() => normalizeUploadedImage(Buffer.alloc(0), 'image/png'))).toBe(
      'empty_file',
    );
  });

  it('refuses a file over the per-image limit', async () => {
    const oversized = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 1);
    expect(await failureCode(() => normalizeUploadedImage(oversized, 'image/png'))).toBe(
      'file_too_large',
    );
  });

  it('refuses SVG, which is a document rather than a raster image', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    );
    const code = await failureCode(() => normalizeUploadedImage(svg, 'image/png'));
    expect(['unsupported_media_type', 'media_type_mismatch']).toContain(code);
  });

  it('refuses an animated image', async () => {
    // Two frames stacked into one GIF: whatever the container, more than one
    // page is animation.
    const frames = await sharp({
      create: { width: 8, height: 16, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .gif()
      .toBuffer();
    const code = await failureCode(() => normalizeUploadedImage(frames, 'image/png'));
    expect(['animated_image', 'unsupported_media_type', 'media_type_mismatch']).toContain(code);
  });

  it('refuses a PDF', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\ntrailer\n<< >>\n%%EOF\n');
    const code = await failureCode(() => normalizeUploadedImage(pdf, 'image/png'));
    expect(['unsupported_media_type', 'malformed_image', 'media_type_mismatch']).toContain(code);
  });

  it('refuses malformed bytes that claim to be an image', async () => {
    const rubbish = Buffer.from('this is not an image at all, whatever the header says');
    const code = await failureCode(() => normalizeUploadedImage(rubbish, 'image/png'));
    expect(['malformed_image', 'unsupported_media_type']).toContain(code);
  });

  it('refuses a real image sent under the wrong media type', async () => {
    const png = await solid(16, 16, 'png');
    expect(await failureCode(() => normalizeUploadedImage(png, 'image/jpeg'))).toBe(
      'media_type_mismatch',
    );
  });

  it('refuses a media type it does not support at all', async () => {
    const png = await solid(16, 16, 'png');
    expect(await failureCode(() => normalizeUploadedImage(png, 'image/gif'))).toBe(
      'unsupported_media_type',
    );
  });

  it('refuses an image longer than the maximum side', async () => {
    const wide = await solid(MAX_DIMENSION + 1, 4, 'png');
    expect(await failureCode(() => normalizeUploadedImage(wide, 'image/png'))).toBe(
      'image_too_large',
    );
  });
});

describe('normalization', () => {
  it('removes EXIF and GPS from a photograph', async () => {
    // A JPEG carrying orientation, a description and a GPS fix, exactly as a
    // phone would produce.
    const withExif = await sharp({
      create: { width: 24, height: 24, channels: 3, background: { r: 200, g: 40, b: 40 } },
    })
      .withExif({
        IFD0: { ImageDescription: 'taken at home', Make: 'TestPhone' },
        GPS: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' },
      })
      .jpeg()
      .toBuffer();

    const before = await sharp(withExif).metadata();
    expect(before.exif, 'the fixture must actually carry EXIF').toBeTruthy();

    const result = await normalizeUploadedImage(withExif, 'image/jpeg');
    const after = await sharp(result.bytes).metadata();
    expect(after.exif).toBeUndefined();

    // Belt and braces: the strings must not survive anywhere in the bytes.
    const haystack = result.bytes.toString('latin1');
    expect(haystack).not.toContain('taken at home');
    expect(haystack).not.toContain('TestPhone');
    expect(haystack).not.toContain('GPS');
  });

  it('drops data appended after the end of the image', async () => {
    const png = await solid(16, 16, 'png');
    const smuggled = Buffer.concat([png, Buffer.from('TRAILING-SECRET-PAYLOAD')]);
    const result = await normalizeUploadedImage(smuggled, 'image/png');
    expect(result.bytes.toString('latin1')).not.toContain('TRAILING-SECRET-PAYLOAD');
  });
});

describe('filenames', () => {
  it('keeps an ordinary name', () => {
    expect(sanitizeFilename('holiday photo.png')).toBe('holiday photo.png');
  });

  it('never lets a name become a path', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(sanitizeFilename('C:\\Windows\\system32')).toBe('C:_Windows_system32');
  });

  it('strips control characters that would corrupt a log line', () => {
    expect(sanitizeFilename('a\u0000b\u001fc\u007fd')).toBe('abcd');
  });

  it('treats a name of nothing but junk as absent', () => {
    expect(sanitizeFilename('   ')).toBeNull();
    expect(sanitizeFilename(undefined)).toBeNull();
  });

  it('refuses an unreasonably long name', () => {
    expect(() => sanitizeFilename('x'.repeat(300))).toThrow(ImageIntakeError);
  });
});
