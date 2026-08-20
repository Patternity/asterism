import { describe, expect, it } from 'vitest';

import { supportedChoices } from '../src/approval-choices';

/**
 * Hermes offers `always`, which becomes a permanent allowlist rule Asterism
 * cannot display or revoke. The durable event keeps whatever Hermes sent — it
 * is evidence — but the console must never render a button the API refuses.
 */
describe('approval choice rendering', () => {
  it('drops the persistent grant Hermes offers', () => {
    expect(supportedChoices(['once', 'session', 'always', 'deny'])).toEqual([
      'once',
      'session',
      'deny',
    ]);
  });

  it('keeps the reversible choices in the order Hermes sent them', () => {
    expect(supportedChoices(['deny', 'once'])).toEqual(['deny', 'once']);
  });

  it('renders no buttons when only a persistent grant was offered', () => {
    // Substituting "once" here would approve something Hermes never offered.
    expect(supportedChoices(['always'])).toEqual([]);
  });

  it('ignores malformed payloads instead of rendering them', () => {
    expect(supportedChoices(undefined)).toEqual([]);
    expect(supportedChoices('always')).toEqual([]);
    expect(supportedChoices([1, null, 'once'])).toEqual(['once']);
  });
});
