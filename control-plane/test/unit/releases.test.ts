import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { currentNodeRelease, resetReleaseCache } from '../../src/releases.js';

const REPO = 'Patternity/asterism';

function respond(body: unknown, ok = true) {
  return Promise.resolve({
    ok,
    json: () => Promise.resolve(body),
  } as Response);
}

describe('which Node release is current', () => {
  beforeEach(() => {
    resetReleaseCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * `/releases/latest`, which skips drafts and pre-releases. A release
   * candidate tagged on the way to a release must never tell an operator that
   * their host is behind: production tracks releases, not the road to one.
   */
  it('asks for the release, not for whatever was tagged last', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => respond({ tag_name: 'v0.1.0' }));

    expect(await currentNodeRelease(REPO)).toBe('v0.1.0');
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain('/releases/latest');
    expect(url).not.toContain('per_page');
  });

  /**
   * Today's state: the first release has not been published, so GitHub answers
   * 404. There is no current release for a Node to be on, and saying so is the
   * honest reading — not an error, and not a version.
   */
  it('answers null while no release has been published', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      respond({ message: 'Not Found' }, false),
    );
    expect(await currentNodeRelease(REPO)).toBeNull();
  });

  it('asks once and reuses the answer', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => respond({ tag_name: 'v1.2.3' }));

    expect(await currentNodeRelease(REPO)).toBe('v1.2.3');
    expect(await currentNodeRelease(REPO)).toBe('v1.2.3');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  /**
   * Every failure is the same to a caller, and none of them may reach a page.
   * A Nodes page that will not load because GitHub is slow is worse than one
   * that cannot say what the current release is.
   */
  it('answers null rather than throwing, whatever went wrong', async () => {
    for (const failure of [
      () => Promise.reject(new Error('network down')),
      () => respond({ message: 'rate limit exceeded' }, false),
      () => respond({ tag_name: 42 }),
      () => respond({ no_tag: true }),
      () => respond(null),
    ]) {
      resetReleaseCache();
      vi.spyOn(globalThis, 'fetch').mockImplementation(failure as never);
      await expect(currentNodeRelease(REPO)).resolves.toBeNull();
      vi.restoreAllMocks();
    }
  });

  it('makes no request at all when the lookup is switched off', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await currentNodeRelease('')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
