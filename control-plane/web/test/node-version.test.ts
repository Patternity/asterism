import { describe, expect, it } from 'vitest';

import { versionNote } from '../src/node-version';

describe('what a Node version reads beside the current release', () => {
  it('says nothing when the host is on the release', () => {
    expect(versionNote('v0.1.0', 'v0.1.0')).toBeNull();
  });

  it('names the release the host differs from', () => {
    expect(versionNote('v0.1.0-alpha.19-rc.7', 'v0.1.0')).toBe('differs from v0.1.0');
  });

  /**
   * "Differs", not "out of date". A host can legitimately be ahead — a local
   * build reports `v0.1.0` with no tag behind it — and calling that stale is a
   * warning the operator learns to ignore.
   */
  it('does not claim a host is behind', () => {
    expect(versionNote('v9.9.9', 'v0.1.0')).toBe('differs from v0.1.0');
  });

  /**
   * No comparison without both halves. Until the first release is published
   * there is nothing to compare against, and a GitHub outage must not turn
   * every Node red.
   */
  it('makes no comparison when either side is unknown', () => {
    expect(versionNote('v0.1.0', null)).toBeNull();
    expect(versionNote(null, 'v0.1.0')).toBeNull();
    expect(versionNote(null, null)).toBeNull();
    expect(versionNote(undefined, undefined)).toBeNull();
  });
});
