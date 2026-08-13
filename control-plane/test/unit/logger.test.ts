import { describe, expect, it } from 'vitest';

import { redact } from '../../src/logger.js';

describe('log redaction', () => {
  it('destroys string values behind secret key names', () => {
    const out = redact({
      access_token: 'abc',
      authorization: 'Bearer xyz',
      client_secret: 's',
      apiKey: 'k',
      keep: 'visible',
    }) as Record<string, unknown>;

    expect(out.access_token).toBe('[redacted]');
    expect(out.authorization).toBe('[redacted]');
    expect(out.client_secret).toBe('[redacted]');
    expect(out.apiKey).toBe('[redacted]');
    expect(out.keep).toBe('visible');
  });

  it('keeps numeric and boolean fields that merely match a secret fragment', () => {
    // Regression: token *counts* and TTLs are telemetry, not credentials.
    const out = redact({
      usage: { input_tokens: 91, output_tokens: 12, total_tokens: 103 },
      enrollment_token_ttl_ms: 900_000,
      token_budget_exhausted: false,
    }) as Record<string, Record<string, unknown>>;

    expect(out.usage).toEqual({ input_tokens: 91, output_tokens: 12, total_tokens: 103 });
    expect(out.enrollment_token_ttl_ms).toBe(900_000);
    expect(out.token_budget_exhausted).toBe(false);
  });

  it('keeps token_id, which correlates records without revealing the token', () => {
    const out = redact({ token_id: 'e3894ed2-01ba-4af7', token: 'the-actual-secret' }) as Record<
      string,
      unknown
    >;

    expect(out.token_id).toBe('e3894ed2-01ba-4af7');
    expect(out.token).toBe('[redacted]');
  });

  it('redacts nested objects and arrays behind a secret key', () => {
    const out = redact({ credentials: { nested: 'value' }, list: [{ password: 'p' }] }) as Record<
      string,
      unknown
    >;

    expect(out.credentials).toBe('[redacted]');
    expect((out.list as Record<string, unknown>[])[0]?.password).toBe('[redacted]');
  });

  it('redacts JWT-shaped values regardless of key name', () => {
    const out = redact({ note: `eyJ${'a'.repeat(40)}` }) as Record<string, unknown>;
    expect(out.note).toBe('[redacted]');
  });

  it('bounds very long strings instead of dropping them', () => {
    const out = redact({ blob: 'x'.repeat(5000) }) as Record<string, string>;
    expect(out.blob).toMatch(/…\[truncated\]$/);
    expect(out.blob.length).toBeLessThan(5000);
  });
});
