import { describe, expect, it } from 'vitest';

import {
  attachmentLabel,
  attachmentProblem,
  attachmentsOf,
  describeBytes,
  localImageProblem,
  makeAttachment,
  type UploadLimits,
  uploadedAttachmentsOf,
} from '../src/attachments';

describe('composer attachment validation', () => {
  it('accepts an ordinary https image url', () => {
    expect(attachmentProblem('https://example.com/a.png', 0)).toBeNull();
  });

  it('asks for a complete url rather than guessing a scheme', () => {
    expect(attachmentProblem('example.com/a.png', 0)).toMatch(/complete URL/);
  });

  it('refuses a fifth image', () => {
    expect(attachmentProblem('https://example.com/e.png', 4)).toMatch(/At most 4/);
  });

  it('refuses an unsupported scheme', () => {
    expect(attachmentProblem('ftp://example.com/a.png', 0)).toMatch(/http and https/);
    expect(attachmentProblem('data:image/png;base64,AA', 0)).toMatch(/http and https/);
  });

  it('explains why credentials in a URL are refused', () => {
    // The operator needs to know the URL leaves the machine.
    expect(attachmentProblem('https://u:p@example.com/a.png', 0)).toMatch(/model provider/);
  });

  it('refuses an empty url', () => {
    expect(attachmentProblem('   ', 0)).toMatch(/Enter an image URL/);
  });
});

describe('attachment display', () => {
  it('prefers the operator label', () => {
    expect(attachmentLabel(makeAttachment('https://example.com/a.png', 'Chart'))).toBe('Chart');
  });

  it('falls back to the file name when there is no label', () => {
    expect(attachmentLabel(makeAttachment('https://example.com/dir/a.png', ''))).toBe('a.png');
  });

  it('falls back to the host when the path has no file name', () => {
    expect(attachmentLabel(makeAttachment('https://example.com/', ''))).toBe('example.com');
  });
});

describe('attachments recovered from server state', () => {
  it('rebuilds the cards a submitted turn carried', () => {
    const run = {
      request_metadata: { attachments: [{ type: 'image_url', url: 'https://example.com/a.png' }] },
    };
    expect(attachmentsOf(run)).toHaveLength(1);
  });

  it('returns nothing for a turn without attachments', () => {
    expect(attachmentsOf({ request_metadata: {} })).toEqual([]);
    expect(attachmentsOf({ request_metadata: null })).toEqual([]);
    expect(attachmentsOf({})).toEqual([]);
  });

  it('ignores malformed stored entries instead of rendering them', () => {
    const run = {
      request_metadata: {
        attachments: [null, 'x', { type: 'file_url', url: 'u' }, { type: 'image_url' }],
      },
    };
    expect(attachmentsOf(run)).toEqual([]);
  });
});

describe('local image selection', () => {
  const limits: UploadLimits = {
    available: true,
    configured: true,
    max_attachments: 4,
    max_bytes: 10 * 1024 * 1024,
    max_request_bytes: 32 * 1024 * 1024,
    max_dimension: 8192,
    max_pixels: 25_000_000,
    media_types: ['image/png', 'image/jpeg', 'image/webp'],
  };

  const file = (name: string, type: string, size: number): File => {
    const handle = new File([new Uint8Array(Math.min(size, 1024))], name, { type });
    // A real multi-megabyte buffer would make the suite slow for no gain; the
    // check under test reads `size`.
    Object.defineProperty(handle, 'size', { value: size });
    return handle;
  };

  it('accepts a supported image within the limits', () => {
    expect(localImageProblem(file('a.png', 'image/png', 1024), limits)).toBeNull();
  });

  it('refuses an empty file', () => {
    expect(localImageProblem(file('a.png', 'image/png', 0), limits)).toContain('empty');
  });

  it('refuses a file over the per-image limit', () => {
    const problem = localImageProblem(file('big.png', 'image/png', 11 * 1024 * 1024), limits);
    expect(problem).toContain('larger than');
  });

  it('refuses a type the server does not accept', () => {
    expect(localImageProblem(file('x.gif', 'image/gif', 1024), limits)).toContain('not a supported');
  });

  it('lets a type-less file through for the server to judge', () => {
    // Some drag sources provide no type at all. Refusing here would reject a
    // perfectly good PNG that the server would have accepted.
    expect(localImageProblem(file('unknown', '', 1024), limits)).toBeNull();
  });

  it('describes sizes in units a person reads', () => {
    expect(describeBytes(512)).toBe('512 B');
    expect(describeBytes(2048)).toBe('2 KB');
    expect(describeBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('uploaded attachments on a run', () => {
  it('reads the stored images the server joined in', () => {
    const attachment = {
      type: 'uploaded_image' as const,
      attachment_id: 'att_1',
      media_type: 'image/png',
      byte_size: 100,
      width: 10,
      height: 10,
      state: 'ready',
      content_url: '/api/v1/projects/p/attachments/att_1/content',
    };
    expect(uploadedAttachmentsOf({ uploaded_attachments: [attachment] })).toEqual([attachment]);
  });

  it('treats a run without them as having none', () => {
    expect(uploadedAttachmentsOf({})).toEqual([]);
    expect(uploadedAttachmentsOf({ uploaded_attachments: null })).toEqual([]);
  });
});
