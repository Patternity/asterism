import { describe, expect, it } from 'vitest';

import { redact } from '../../src/logger.js';
import { readSafeMetadata, redactSafeMetadata } from '../../src/safe-metadata.js';
import { storableResult } from '../../src/node-channel.js';

const ID = 'cred-0011aabbccddeeff';

describe('reading safe metadata', () => {
  it('keeps a credential id of exactly the Node shape', () => {
    expect(readSafeMetadata({ credential_id: ID })).toEqual({ credential_id: ID });
  });

  it('drops anything that is not that shape, fail closed', () => {
    for (const bad of [
      { credential_id: 'CRED-0011AABBCCDDEEFF' },
      { credential_id: 'cred-0011' },
      { credential_id: `${ID}0` },
      { credential_id: 'cred-../../etc/passwd' },
      { credential_id: '[redacted]' },
      { credential_id: 12345 },
      { credential_id: { id: ID } },
      { access_token: ID },
    ]) {
      expect(readSafeMetadata(bad), JSON.stringify(bad)).toEqual({});
    }
    for (const bad of [null, undefined, ID, [ID], 7]) {
      expect(readSafeMetadata(bad)).toEqual({});
    }
  });
});

describe('logging safe metadata', () => {
  /** The generic rule is untouched: a top-level id is still judged by its name. */
  it('keeps a validated id and still destroys everything secret beside it', () => {
    const logged = redact({
      credential_id: ID,
      safe_metadata: { credential_id: ID, access_token: 'eyJhbGciOiJIUzI1NiJ9.a.b', note: 'x' },
      user_code: 'RCB8-M9COT',
      refresh_token: 'rt-secret',
      password: 'hunter2',
      authorization: 'Bearer abcdefghijklmnop',
    }) as Record<string, unknown>;
    expect(logged.safe_metadata).toEqual({
      credential_id: ID,
      access_token: '[redacted]',
      note: '[redacted]',
    });
    expect(logged.credential_id).toBe('[redacted]');
    for (const secret of ['refresh_token', 'password', 'authorization']) {
      expect(logged[secret], secret).toBe('[redacted]');
    }
  });

  it('destroys a safe_metadata value that is not an object', () => {
    expect(redactSafeMetadata(ID)).toBe('[redacted]');
    expect((redact({ safe_metadata: [ID] }) as Record<string, unknown>).safe_metadata).toBe(
      '[redacted]',
    );
  });
});

describe('storing a device authorization', () => {
  it('keeps the validated id beside the marker and nothing of the pair', () => {
    const stored = storableResult({
      verification_uri: 'https://auth.openai.com/codex/device',
      user_code: 'RCB8-M9COT',
      expires_in_seconds: 900,
      safe_metadata: { credential_id: ID, device_code: 'secret-device-code' },
    });
    expect(stored).toEqual({
      redacted: 'device_authorization',
      safe_metadata: { credential_id: ID },
    });
    const serialized = JSON.stringify(stored);
    for (const secret of ['RCB8-M9COT', 'auth.openai.com', 'secret-device-code']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('stores no metadata when the id does not validate', () => {
    expect(
      storableResult({
        user_code: 'RCB8-M9COT',
        credential_id: '[redacted]',
        safe_metadata: { credential_id: 'cred-work' },
      }),
    ).toEqual({ redacted: 'device_authorization' });
  });
});
