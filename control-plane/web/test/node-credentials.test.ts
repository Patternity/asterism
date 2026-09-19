import { describe, expect, it } from 'vitest';

import {
  addCredentialState,
  blocksRuns,
  canModify,
  canReauthorize,
  credentialStateLabel,
  credentialStateTone,
  expiresInLabel,
  isAwaitingApproval,
  type NodeCredential,
} from '../src/node-credentials';
import type { ProviderCapabilityView } from '../src/provider-capabilities';

function capabilities(overrides: Record<string, unknown> = {}): ProviderCapabilityView {
  return {
    state: 'reported',
    status: 'ok',
    schema_version: 1,
    runtime_release: 'v0.1.0-alpha.24',
    providers: [
      {
        id: 'openai-codex',
        display_name: 'OpenAI Codex',
        auth_methods: ['device_authorization'],
        availability: 'available',
      },
    ],
    reported_at: '2026-09-09T10:00:00.000Z',
    recorded_at: '2026-09-09T10:00:05.000Z',
    stale: false,
    ...overrides,
  } as ProviderCapabilityView;
}

function credential(overrides: Partial<NodeCredential> = {}): NodeCredential {
  return {
    credential_id: 'cred-0011aabb',
    provider_id: 'openai-codex',
    auth_method: 'device_authorization',
    label: 'Existing credential',
    state: 'authorized',
    ...overrides,
  };
}

describe('when a credential may be added', () => {
  it('offers exactly the methods the Node reports as available', () => {
    const state = addCredentialState(capabilities(), true);
    expect(state).toEqual({
      kind: 'offered',
      options: [
        {
          providerId: 'openai-codex',
          providerName: 'OpenAI Codex',
          authMethod: 'device_authorization',
        },
      ],
    });
  });

  /**
   * A Node that never reported is not a Node that supports the one provider
   * that happens to exist. Offering the button would be a promise that pressing
   * it works.
   */
  it('offers nothing for a Node whose capabilities are unknown', () => {
    const state = addCredentialState({ state: 'unknown' }, true);
    expect(state.kind).toBe('unavailable');
    if (state.kind !== 'unavailable') throw new Error('unreachable');
    expect(state.reason).toMatch(/has not reported/);
    expect(addCredentialState(null, true).kind).toBe('unavailable');
  });

  it('offers nothing for a schema it cannot read', () => {
    const state = addCredentialState(
      capabilities({ status: 'unsupported_schema', schema_version: 99, providers: null }),
      true,
    );
    expect(state.kind).toBe('unavailable');
    if (state.kind !== 'unavailable') throw new Error('unreachable');
    expect(state.reason).toMatch(/cannot read/);
  });

  /**
   * The stale case: the snapshot may be shown, and it may not authorize
   * anything. A login queued against a host that is not there would put a code
   * somewhere nobody could approve before it expired.
   */
  it('shows a stale snapshot but will not act on it', () => {
    const state = addCredentialState(capabilities({ stale: true }), false);
    expect(state.kind).toBe('unavailable');
    if (state.kind !== 'unavailable') throw new Error('unreachable');
    expect(state.reason).toMatch(/connected/);
  });

  it('offers nothing when every reported provider is out of reach', () => {
    const state = addCredentialState(
      capabilities({
        providers: [
          {
            id: 'openai-codex',
            display_name: 'OpenAI Codex',
            auth_methods: ['device_authorization'],
            availability: 'unavailable',
            unavailable_reason: 'runtime_missing',
          },
        ],
      }),
      true,
    );
    expect(state.kind).toBe('unavailable');
  });

  /** No list here decides what is offerable — the Node's report does. */
  it('offers a provider and a method this console has never heard of', () => {
    const state = addCredentialState(
      capabilities({
        providers: [
          {
            id: 'acme-llm',
            display_name: 'Acme LLM',
            auth_methods: ['smartcard', 'device_authorization'],
            availability: 'available',
          },
        ],
      }),
      true,
    );
    expect(state.kind).toBe('offered');
    if (state.kind !== 'offered') throw new Error('unreachable');
    expect(state.options).toHaveLength(2);
    expect(state.options[0]?.authMethod).toBe('smartcard');
  });
});

describe('how a credential reads and what may be done to it', () => {
  it('names every lifecycle state in words', () => {
    expect(credentialStateLabel('authorized')).toBe('Ready');
    expect(credentialStateLabel('authorizing')).toBe('Waiting for approval');
    expect(credentialStateLabel('required')).toBe('Needs authorization');
    expect(credentialStateLabel('failed')).toBe('Last attempt failed');
    expect(credentialStateLabel('revoked')).toBe('Revoked');
    // A state from a newer Node is shown rather than dropped.
    expect(credentialStateLabel('rotating')).toBe('rotating');
  });

  it('colours ready, failed and everything in between', () => {
    expect(credentialStateTone('authorized')).toBe('ok');
    expect(credentialStateTone('failed')).toBe('fail');
    expect(credentialStateTone('authorizing')).toBe('warn');
    expect(credentialStateTone('revoked')).toBe('warn');
  });

  it('knows which credential a device code belongs to', () => {
    expect(isAwaitingApproval(credential({ state: 'authorizing' }))).toBe(true);
    expect(isAwaitingApproval(credential())).toBe(false);
  });

  /** A revoked credential is a record, not a thing to act on. */
  it('will not modify a revoked credential, or any credential while offline', () => {
    expect(canModify(credential(), true)).toBe(true);
    expect(canModify(credential({ state: 'revoked' }), true)).toBe(false);
    expect(canModify(credential(), false)).toBe(false);
  });
});

describe('how long a person has to approve', () => {
  it('counts down in minutes and seconds', () => {
    const now = Date.now();
    expect(expiresInLabel(now + 905_000, now)).toBe('15m 5s left');
    expect(expiresInLabel(now + 42_000, now)).toBe('42s left');
  });

  /** A spent code reads as spent rather than as a negative number. */
  it('says expired rather than counting past zero', () => {
    const now = Date.now();
    expect(expiresInLabel(now - 1000, now)).toBe('expired');
    expect(expiresInLabel(now, now)).toBe('expired');
  });
});

/**
 * Logging an existing credential in again.
 *
 * The two unusable states are the interesting part. A provider that ended a
 * grant said something; a runtime holding no record said nothing at all. Both
 * are fixed by the same action, and a person deciding whether the problem is
 * their account or this host has to be able to tell them apart.
 */
describe('a credential that needs logging in again', () => {
  const credential = (overrides: Partial<NodeCredential> = {}): NodeCredential => ({
    credential_id: 'cred-0011aabbccddeeff',
    provider_id: 'openai-codex',
    auth_method: 'device_authorization',
    label: 'Work account',
    state: 'authorized',
    storage: 'isolated',
    ...overrides,
  });

  it('reads the two absences as different things', () => {
    expect(credentialStateLabel('reauthorization_required')).toBe('Provider access ended');
    expect(credentialStateLabel('runtime_missing')).toBe('Not held by this Node');
    expect(credentialStateLabel('reauthorizing')).toBe('Waiting for approval');
    // An ended grant is a failure a person must act on; an absent record is not
    // yet one.
    expect(credentialStateTone('reauthorization_required')).toBe('fail');
    expect(credentialStateTone('runtime_missing')).toBe('warn');
  });

  it('is offered for every state it can recover from', () => {
    for (const state of [
      'authorized',
      'reauthorization_required',
      'runtime_missing',
      'required',
      'failed',
    ]) {
      expect(canReauthorize(credential({ state }), true, true)).toBe(true);
    }
  });

  it('is not offered where it could not work', () => {
    // Taken away on purpose.
    expect(canReauthorize(credential({ state: 'revoked' }), true, true)).toBe(false);
    // Already waiting for somebody's browser.
    expect(canReauthorize(credential({ state: 'reauthorizing' }), true, true)).toBe(false);
    // The Node is not here to hand a code back.
    expect(canReauthorize(credential(), false, true)).toBe(false);
    // The Node's build has no command for it.
    expect(canReauthorize(credential(), true, false)).toBe(false);
    // A shared pool entry is not addressable, so there is nothing to replace.
    expect(canReauthorize(credential({ storage: 'legacy_shared_pool' }), true, true)).toBe(false);
  });

  it('knows when work is blocked for everything reading it', () => {
    expect(blocksRuns(credential({ state: 'reauthorizing' }))).toBe(true);
    expect(blocksRuns(credential({ state: 'reauthorization_required' }))).toBe(true);
    expect(blocksRuns(credential({ state: 'runtime_missing' }))).toBe(true);
    expect(blocksRuns(credential())).toBe(false);
    expect(blocksRuns(credential({ state: 'revoked' }))).toBe(false);
  });

  /** A login out for a replacement is one a person can cancel, like any other. */
  it('counts a replacement as an attempt awaiting approval', () => {
    expect(isAwaitingApproval(credential({ state: 'reauthorizing' }))).toBe(true);
    expect(isAwaitingApproval(credential({ state: 'authorizing' }))).toBe(true);
    expect(isAwaitingApproval(credential())).toBe(false);
  });
});
