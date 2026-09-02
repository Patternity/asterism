/**
 * What may be relayed about a provider authorization, and for how long.
 *
 * The device code is the only secret this Control Plane ever holds about a
 * provider, and it holds it in memory for minutes. These assert the rules that
 * keep it there: scoped to the organization that asked, forgotten when it
 * expires, and never derived from a Node result that does not carry both halves.
 */
import { describe, expect, it } from 'vitest';

import {
  DeviceAuthorizationRelay,
  PROVIDER_STATES,
  canDispatchRuns,
  isProviderState,
  nodeCanAuthorizeProvider,
  nodeProviderKind,
  readDeviceAuthorization,
} from '../../src/provider-authorization.js';

const device = {
  verificationUri: 'https://auth.openai.com/codex/device',
  userCode: 'QK7T-9WFD',
  expiresAt: Date.now() + 15 * 60 * 1000,
};

describe('who may see a device code', () => {
  it('shows it to the organization that asked for it', () => {
    const relay = new DeviceAuthorizationRelay();
    relay.remember('node-1', 'org-a', device);
    expect(relay.take('node-1', 'org-a')?.userCode).toBe('QK7T-9WFD');
  });

  it('answers another organization as though nothing were pending', () => {
    const relay = new DeviceAuthorizationRelay();
    relay.remember('node-1', 'org-a', device);
    expect(relay.take('node-1', 'org-b')).toBeNull();
  });

  it('forgets a code that has expired rather than showing it', () => {
    const relay = new DeviceAuthorizationRelay();
    const expired = { ...device, expiresAt: Date.now() - 1 };
    relay.remember('node-1', 'org-a', expired);
    expect(relay.take('node-1', 'org-a')).toBeNull();
    // And it is gone, not merely hidden.
    expect(relay.isPending('node-1')).toBe(false);
  });

  it('knows when an attempt is already waiting, so a second is not started', () => {
    const relay = new DeviceAuthorizationRelay();
    expect(relay.isPending('node-1')).toBe(false);
    relay.remember('node-1', 'org-a', device);
    expect(relay.isPending('node-1')).toBe(true);
    relay.forget('node-1');
    expect(relay.isPending('node-1')).toBe(false);
  });

  it('sweeps expired codes out of memory', () => {
    const relay = new DeviceAuthorizationRelay();
    relay.remember('node-1', 'org-a', { ...device, expiresAt: Date.now() - 1 });
    relay.remember('node-2', 'org-a', device);
    relay.sweep();
    expect(relay.isPending('node-1')).toBe(false);
    expect(relay.isPending('node-2')).toBe(true);
  });
});

describe('reading what a Node offered', () => {
  it('accepts a complete offer', () => {
    const read = readDeviceAuthorization({
      verification_uri: 'https://auth.openai.com/codex/device',
      user_code: 'QK7T-9WFD',
      expires_in_seconds: 900,
    });
    expect(read?.userCode).toBe('QK7T-9WFD');
  });

  it('refuses half an offer rather than showing a page with nothing to type', () => {
    for (const incomplete of [
      {},
      { verification_uri: 'https://auth.openai.com/codex/device' },
      { user_code: 'QK7T-9WFD', expires_in_seconds: 900 },
      { verification_uri: 'https://x/', user_code: '', expires_in_seconds: 900 },
    ]) {
      expect(readDeviceAuthorization(incomplete), JSON.stringify(incomplete)).toBeNull();
    }
  });

  it('refuses a link that is not https', () => {
    expect(
      readDeviceAuthorization({
        verification_uri: 'http://auth.openai.com/codex/device',
        user_code: 'QK7T-9WFD',
        expires_in_seconds: 900,
      }),
    ).toBeNull();
  });

  it('refuses an expiry that is absent, negative or absurd', () => {
    for (const expires of [0, -1, 99999]) {
      expect(
        readDeviceAuthorization({
          verification_uri: 'https://auth.openai.com/codex/device',
          user_code: 'QK7T-9WFD',
          expires_in_seconds: expires,
        }),
        String(expires),
      ).toBeNull();
    }
  });
});

describe('which Nodes may be asked', () => {
  it('recognises a Node that advertises device authorization', () => {
    expect(
      nodeCanAuthorizeProvider({ provider: { kind: 'openai-codex', device_authorization: true } }),
    ).toBe(true);
    expect(nodeProviderKind({ provider: { kind: 'openai-codex' } })).toBe('openai-codex');
  });

  it('refuses to offer the control against a Node that would ignore it', () => {
    for (const capabilities of [null, {}, { provider: {} }, { provider: 'codex' }]) {
      expect(nodeCanAuthorizeProvider(capabilities), JSON.stringify(capabilities)).toBe(false);
    }
  });
});

describe('when a run may be dispatched', () => {
  it('allows only an authorized Node, and one that has never reported', () => {
    expect(canDispatchRuns('authorized')).toBe(true);
    // A Node that predates provider reporting has said nothing; refusing every
    // run on it would break working installations to enforce a check it cannot
    // answer.
    expect(canDispatchRuns('unknown')).toBe(true);
    for (const state of ['unavailable', 'required', 'authorizing', 'failed'] as const) {
      expect(canDispatchRuns(state), state).toBe(false);
    }
  });

  it('treats every state the schema allows', () => {
    for (const state of PROVIDER_STATES) {
      expect(isProviderState(state)).toBe(true);
      expect(typeof canDispatchRuns(state)).toBe('boolean');
    }
    expect(isProviderState('something-else')).toBe(false);
  });
});
