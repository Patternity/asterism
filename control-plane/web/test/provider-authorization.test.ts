import { describe, expect, it } from 'vitest';

import {
  PROVIDER_STATES,
  canAuthorize,
  canRun,
  formatRemaining,
  isProviderState,
  providerExplanation,
  providerLabel,
  remainingSeconds,
} from '../src/provider-authorization';
import { PROVIDER_STATES as SERVER_STATES } from '../../src/provider-authorization';

describe('the states the console knows', () => {
  it('knows exactly the ones the Control Plane can send', () => {
    // Two typed lists describing one protocol drift the moment one side gains a
    // value, and the console would render the new one as a raw identifier.
    expect([...PROVIDER_STATES].sort()).toEqual([...SERVER_STATES].sort());
  });

  it('has a label and an explanation for every one of them', () => {
    for (const state of PROVIDER_STATES) {
      expect(providerLabel(state), state).not.toBe(state);
      expect(providerExplanation(state).length, state).toBeGreaterThan(20);
    }
    expect(isProviderState('brand-new')).toBe(false);
  });
});

describe('what the console lets a person do', () => {
  it('offers authorization only where it would achieve something', () => {
    for (const state of ['required', 'failed', 'unknown'] as const) {
      expect(canAuthorize({ state, supported: true }), state).toBe(true);
    }
    for (const state of ['authorized', 'authorizing', 'unavailable'] as const) {
      expect(canAuthorize({ state, supported: true }), state).toBe(false);
    }
  });

  it('never offers it against a Node that would ignore the command', () => {
    for (const state of PROVIDER_STATES) {
      expect(canAuthorize({ state, supported: false }), state).toBe(false);
    }
  });

  it('agrees with the Control Plane about when a run may be sent', () => {
    expect(canRun('authorized')).toBe(true);
    expect(canRun('unknown')).toBe(true);
    for (const state of ['required', 'authorizing', 'failed', 'unavailable'] as const) {
      expect(canRun(state), state).toBe(false);
    }
  });
});

describe('how long a code is still worth typing', () => {
  it('counts down and then stops', () => {
    const now = Date.parse('2026-09-02T12:00:00Z');
    expect(remainingSeconds('2026-09-02T12:04:32Z', now)).toBe(272);
    expect(remainingSeconds('2026-09-02T11:59:00Z', now)).toBe(0);
    expect(remainingSeconds('not a date', now)).toBe(0);
  });

  it('reads as a clock, and says nothing once it has expired', () => {
    expect(formatRemaining(272)).toBe('4:32');
    expect(formatRemaining(61)).toBe('1:01');
    expect(formatRemaining(0)).toBe('');
  });
});

describe('rendering a value this build does not know', () => {
  it('never throws, because the page it would take carries the fix', () => {
    // The Node page's own Drain and Revoke controls live beside this panel. A
    // status that throws while rendering removes them from the page, which is
    // the moment somebody most needs them.
    expect(() => providerLabel(undefined as never)).not.toThrow();
    expect(providerLabel(undefined as never)).toBe('unknown');
    expect(providerLabel('some_future_state' as never)).toBe('some future state');
    expect(providerExplanation(undefined as never).length).toBeGreaterThan(20);
  });
});
