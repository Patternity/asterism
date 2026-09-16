import { describe, expect, it } from 'vitest';

import { storableResult } from '../../src/node-channel.js';
import { DeviceAuthorizationDeliverySchema, MESSAGE_TYPES } from '../../src/protocol.js';

const ID = 'cred-0011aabbccddeeff';

function delivery(overrides: Record<string, unknown> = {}) {
  return {
    command_id: 'cmd-1',
    verification_uri: 'https://auth.openai.com/codex/device',
    user_code: 'RCB8-M9COT',
    expires_in_seconds: 900,
    safe_metadata: { credential_id: ID },
    ...overrides,
  };
}

describe('the device delivery frame', () => {
  it('has its own message types on both directions', () => {
    expect(MESSAGE_TYPES.clientDeviceAuthorization).toBe('client.device_authorization');
    expect(MESSAGE_TYPES.serverDeviceAuthorizationAck).toBe('server.device_authorization.ack');
  });

  it('accepts exactly the planned fields', () => {
    expect(DeviceAuthorizationDeliverySchema.safeParse(delivery()).success).toBe(true);
    const { safe_metadata: _unused, ...withoutMetadata } = delivery();
    expect(DeviceAuthorizationDeliverySchema.safeParse(withoutMetadata).success).toBe(true);
  });

  /** Fail closed: anything nobody planned for rejects the whole frame. */
  it('refuses an unknown field, a missing half, and values out of bounds', () => {
    for (const bad of [
      delivery({ refresh_token: 'rt-secret-value' }),
      delivery({ device_code: 'secret-device-code' }),
      delivery({ credential_id: ID }),
      delivery({ user_code: undefined }),
      delivery({ verification_uri: '' }),
      delivery({ user_code: 'X'.repeat(33) }),
      delivery({ expires_in_seconds: 0 }),
      delivery({ expires_in_seconds: 3_601 }),
      delivery({ expires_in_seconds: 1.5 }),
      delivery({ command_id: '' }),
      delivery({ safe_metadata: ID }),
      null,
      'RCB8-M9COT',
    ]) {
      expect(DeviceAuthorizationDeliverySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });
});

describe('the durable result of a transient delivery', () => {
  it('is stored as its shape, the credential id and nothing else', () => {
    const stored = storableResult({
      redacted: 'device_authorization',
      delivery: 'transient',
      expires_in_seconds: 900,
      safe_metadata: { credential_id: ID, access_token: 'eyJhbGciOiJIUzI1NiJ9.a.b' },
      refresh_token: 'rt-secret-value',
      anything: { nested: 'secret-device-code' },
    });
    expect(stored).toEqual({
      redacted: 'device_authorization',
      delivery: 'transient',
      expires_in_seconds: 900,
      safe_metadata: { credential_id: ID },
    });
  });

  it('drops an invalid id, an unknown delivery kind and a bogus expiry', () => {
    expect(
      storableResult({
        redacted: 'device_authorization',
        delivery: 'forever',
        expires_in_seconds: '900',
        safe_metadata: { credential_id: '[redacted]' },
      }),
    ).toEqual({ redacted: 'device_authorization' });
  });

  it('still reduces a result carrying the pair to its safe shape', () => {
    const stored = storableResult({
      redacted: 'device_authorization',
      user_code: 'RCB8-M9COT',
      verification_uri: 'https://auth.openai.com/codex/device',
      safe_metadata: { credential_id: ID },
    });
    expect(JSON.stringify(stored)).not.toContain('RCB8-M9COT');
    expect(JSON.stringify(stored)).not.toContain('auth.openai.com');
  });
});
