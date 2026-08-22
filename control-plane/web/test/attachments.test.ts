import { describe, expect, it } from 'vitest';

import {
  attachmentLabel,
  attachmentProblem,
  attachmentsOf,
  makeAttachment,
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
