import { describe, expect, it } from 'vitest';

import { updateTarget, versionNote } from '../src/node-version';

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

describe('which release a Node is offered', () => {
  it('offers the release when the host is not on it', () => {
    expect(updateTarget('v0.1.0-alpha.19-rc.7', 'v0.1.0')).toBe('v0.1.0');
  });

  it('offers nothing when the host is already on it', () => {
    expect(updateTarget('v0.1.0', 'v0.1.0')).toBeNull();
  });

  /**
   * Until the first release is published, and whenever the lookup cannot
   * answer, there is no release to move to — and a button with no version to
   * name would have to guess one.
   */
  it('offers nothing when there is no release to name', () => {
    expect(updateTarget('v0.1.0', null)).toBeNull();
    expect(updateTarget(null, 'v0.1.0')).toBeNull();
    expect(updateTarget(undefined, undefined)).toBeNull();
  });

  it('never disagrees with the note beside the version', () => {
    for (const [reported, current] of [
      ['v0.1.0', 'v0.1.0'],
      ['v0.1.0', 'v0.2.0'],
      ['v0.1.0', null],
      [null, 'v0.1.0'],
    ] as [string | null, string | null][]) {
      const offered = updateTarget(reported, current) !== null;
      const noted = versionNote(reported, current) !== null;
      expect(offered, `${reported} vs ${current}`).toBe(noted);
    }
  });
});
