import { describe, expect, it } from 'vitest';

import { storableResult } from '../../src/node-channel.js';

describe('what a command result may leave behind', () => {
  it('keeps an ordinary result exactly as the Node sent it', () => {
    const result = { projects: [{ project_id: 'prj_1' }], count: 1 };
    expect(storableResult(result)).toEqual(result);
    expect(storableResult(null)).toBeNull();
    expect(storableResult('a string')).toBe('a string');
    expect(storableResult([1, 2])).toEqual([1, 2]);
  });

  it('never writes a device authorization to the database', () => {
    // The relay holds this pair in memory for as long as it is valid and no
    // longer, so that it cannot be found afterwards. A row carrying the same
    // pair defeats that completely: the code outlives the minute it was useful
    // for and sits where anyone with database access can read it. One such row
    // was found in production, holding a code from an authorization that had
    // already expired.
    const stored = storableResult({
      verification_uri: 'https://auth.openai.com/codex/device',
      user_code: 'RCB8-M9COT',
      expires_in_seconds: 900,
    }) as Record<string, unknown>;

    expect(JSON.stringify(stored)).not.toContain('RCB8-M9COT');
    expect(JSON.stringify(stored)).not.toContain('auth.openai.com');
    // The shape of the answer survives, so an operator can still see that the
    // Node replied and with what kind of result.
    expect(stored.redacted).toBe('device_authorization');
  });

  it('redacts on either half, because either half alone is still the secret', () => {
    expect(storableResult({ user_code: 'ABCD-1234' })).toEqual({
      redacted: 'device_authorization',
    });
    expect(storableResult({ verification_uri: 'https://example.test/device' })).toEqual({
      redacted: 'device_authorization',
    });
  });
});
