import { describe, expect, it } from 'vitest';

import {
  MAX_ATTACHMENTS,
  redactAttachmentUrl,
  supportedAttachmentTypes,
  validateAttachments,
} from '../../src/attachments.js';

const image = (url: string, alt?: string) =>
  alt ? { type: 'image_url', url, alt } : { type: 'image_url', url };

describe('attachment validation', () => {
  it('accepts a message with no attachments', () => {
    for (const value of [undefined, null, []]) {
      const result = validateAttachments(value);
      expect(result.ok && result.value).toEqual([]);
    }
  });

  it('accepts one image with its label', () => {
    const result = validateAttachments([image('https://example.com/a.png', 'chart')]);
    expect(result.ok && result.value).toEqual([
      { type: 'image_url', url: 'https://example.com/a.png', alt: 'chart' },
    ]);
  });

  it('accepts four images and preserves their order', () => {
    const urls = [0, 1, 2, 3].map((i) => `https://example.com/${i}.png`);
    const result = validateAttachments(urls.map((u) => image(u)));
    expect(result.ok && result.value.map((a) => a.url)).toEqual(urls);
  });

  it('refuses a fifth image', () => {
    const items = [0, 1, 2, 3, 4].map((i) => image(`https://example.com/${i}.png`));
    const result = validateAttachments(items);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain(`at most ${MAX_ATTACHMENTS}`);
  });

  it('refuses a malformed url', () => {
    for (const url of ['not-a-url', 'example.com/a.png', 'https://']) {
      expect(validateAttachments([image(url)]).ok).toBe(false);
    }
  });

  it('refuses an unsupported scheme', () => {
    for (const url of [
      'ftp://example.com/a.png',
      'file:///etc/passwd',
      'data:image/png;base64,AA',
    ]) {
      const result = validateAttachments([image(url)]);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.message).toMatch(/http|absolute/);
    }
  });

  it('refuses a url carrying credentials', () => {
    const result = validateAttachments([image('https://user:token@example.com/a.png')]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('credentials');
  });

  it('refuses an unsupported attachment type rather than ignoring it', () => {
    const result = validateAttachments([{ type: 'file_url', url: 'https://example.com/a.pdf' }]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('unsupported attachment type');
  });

  it('refuses an over-long label', () => {
    expect(validateAttachments([image('https://example.com/a.png', 'x'.repeat(201))]).ok).toBe(
      false,
    );
  });
});

describe('attachment url redaction', () => {
  it('drops the query, which is where a signed link hides its credential', () => {
    expect(redactAttachmentUrl('https://cdn.example.com/a.png?sig=abcd&exp=9')).toBe(
      'https://cdn.example.com/a.png?<redacted>',
    );
  });

  it('leaves a plain url readable', () => {
    expect(redactAttachmentUrl('https://example.com/a.png')).toBe('https://example.com/a.png');
  });

  it('never echoes something unparseable back', () => {
    expect(redactAttachmentUrl('not-a-url')).toBe('<invalid-url>');
  });
});

describe('attachment capability', () => {
  it('reads the types the Node advertises', () => {
    expect(supportedAttachmentTypes({ attachments: { run_attachments: ['image_url'] } })).toEqual([
      'image_url',
    ]);
  });

  it('treats a Node that advertises nothing as unsupported', () => {
    expect(supportedAttachmentTypes({ approvals: {} })).toEqual([]);
    expect(supportedAttachmentTypes(null)).toEqual([]);
  });

  it('filters an unknown future attachment type', () => {
    // A type this Control Plane does not understand must not reach a client
    // that might offer a control for it.
    expect(
      supportedAttachmentTypes({ attachments: { run_attachments: ['image_url', 'video_url'] } }),
    ).toEqual(['image_url']);
  });
});
