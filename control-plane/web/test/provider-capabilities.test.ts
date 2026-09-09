import { describe, expect, it } from 'vitest';

import {
  authMethodLabel,
  panelState,
  reportedAtLabel,
  unavailableLabel,
  type ProviderCapabilityView,
  type ReportedProvider,
} from '../src/provider-capabilities';

function provider(overrides: Partial<ReportedProvider> = {}): ReportedProvider {
  return {
    id: 'openai-codex',
    display_name: 'OpenAI Codex',
    auth_methods: ['device_authorization'],
    availability: 'available',
    ...overrides,
  };
}

function reported(overrides: Record<string, unknown> = {}): ProviderCapabilityView {
  return {
    state: 'reported',
    status: 'ok',
    schema_version: 1,
    runtime_release: 'v0.1.0-alpha.23',
    providers: [provider()],
    reported_at: '2026-09-09T10:00:00.000Z',
    recorded_at: '2026-09-09T10:00:05.000Z',
    stale: false,
    ...overrides,
  } as ProviderCapabilityView;
}

describe('what the panel decides to show', () => {
  it('shows the providers a Node reported', () => {
    const state = panelState(reported());
    expect(state).toEqual({ kind: 'providers', providers: [provider()], stale: false });
  });

  it('carries staleness through, so a record of the past is never shown as now', () => {
    const state = panelState(reported({ stale: true }));
    expect(state.kind).toBe('providers');
    if (state.kind !== 'providers') throw new Error('unreachable');
    expect(state.stale).toBe(true);
    // Still readable: offline is not the same as unknown.
    expect(state.providers[0]?.id).toBe('openai-codex');
  });

  /**
   * A release older than the contract said nothing. Rendering that as an empty
   * catalogue would be a claim nobody made — and in particular must not be read
   * as supporting the one provider that happens to exist today.
   */
  it('a Node that never reported is unknown, not empty', () => {
    expect(panelState({ state: 'unknown' })).toEqual({ kind: 'unknown' });
    expect(panelState(null)).toEqual({ kind: 'unknown' });
    expect(panelState(undefined)).toEqual({ kind: 'unknown' });
  });

  /**
   * The refusal that keeps an unknown version from becoming a supported
   * provider: the payload is not reached at all.
   */
  it('a schema it cannot read exposes no providers', () => {
    const state = panelState(
      reported({
        status: 'unsupported_schema',
        schema_version: 99,
        providers: null,
      }),
    );
    expect(state).toEqual({ kind: 'unsupported_schema', schemaVersion: 99 });
    expect(state).not.toHaveProperty('providers');
  });

  /** Same refusal when the shape is wrong in a way the status did not catch. */
  it('treats a missing provider list as unreadable rather than as none', () => {
    const state = panelState(reported({ providers: null }));
    expect(state.kind).toBe('unsupported_schema');
  });

  it('an empty list is a claim, and is shown as one', () => {
    const state = panelState(reported({ providers: [] }));
    expect(state).toEqual({ kind: 'providers', providers: [], stale: false });
  });
});

describe('how a provider reads', () => {
  it('labels the methods it knows and passes through the ones it does not', () => {
    expect(authMethodLabel('device_authorization')).toBe('Browser approval');
    expect(authMethodLabel('api_key')).toBe('API key');
    // No list here decides what a Node may support, so an unknown token is
    // shown rather than dropped.
    expect(authMethodLabel('smartcard')).toBe('smartcard');
  });

  it('says nothing extra about a provider that is available', () => {
    expect(unavailableLabel(provider())).toBeNull();
  });

  it('explains why a provider is out of reach when it can', () => {
    expect(
      unavailableLabel(
        provider({ availability: 'unavailable', unavailable_reason: 'runtime_missing' }),
      ),
    ).toContain('not installed');
  });

  it('still says unavailable when the reason means nothing here', () => {
    expect(
      unavailableLabel(provider({ availability: 'unavailable', unavailable_reason: 'sunspots' })),
    ).toBe('Unavailable');
    expect(unavailableLabel(provider({ availability: 'unavailable' }))).toBe('Unavailable');
  });
});

describe('when the Node observed it', () => {
  it('prefers what the Node said over when it arrived', () => {
    expect(reportedAtLabel(reported())).toBe(new Date('2026-09-09T10:00:00.000Z').toLocaleString());
  });

  it('falls back to arrival when the Node named no time', () => {
    expect(reportedAtLabel(reported({ reported_at: null }))).toBe(
      new Date('2026-09-09T10:00:05.000Z').toLocaleString(),
    );
  });

  it('has nothing to say about a Node that never reported', () => {
    expect(reportedAtLabel({ state: 'unknown' })).toBeNull();
  });
});
