import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  compareVersions,
  eligibility,
  eligibleNodeRelease,
  missingAssets,
  parseVersion,
  resetReleaseCache,
} from '../../src/releases.js';

const REPO = 'Patternity/asterism';

/** The five assets a release must carry to be installable. */
function completeAssets(version: string) {
  return [
    { name: `asterism-node-${version}-linux-amd64.tar.gz` },
    { name: `asterism-runtime-${version}-linux-amd64.tar.gz` },
    { name: 'manifest.json' },
    { name: 'SHA256SUMS' },
    { name: 'SHA256SUMS.runtime' },
  ];
}

function release(tag: string, overrides: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    draft: false,
    // Every Asterism tag is one: the workflow marks a release prerelease when
    // the tag contains a hyphen. Eligibility must not read this field.
    prerelease: true,
    body: `notes for ${tag}`,
    html_url: `https://github.com/${REPO}/releases/tag/${tag}`,
    assets: completeAssets(tag),
    ...overrides,
  };
}

function answers(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response);
}

describe('which releases may be offered', () => {
  it('accepts a full alpha release carrying everything', () => {
    expect(eligibility(release('v0.1.0-alpha.19'))).toEqual({ ok: true });
  });

  /**
   * A release candidate is the road to a release, not one. Production follows
   * releases; rc.8 existing must never move a host.
   */
  it('refuses a release candidate', () => {
    expect(eligibility(release('v0.1.0-alpha.19-rc.8'))).toEqual({
      ok: false,
      because: 'not a full alpha release tag',
    });
  });

  /** `v0.1.0-alpha.9` is a real draft in this repository. */
  it('refuses a draft', () => {
    expect(eligibility(release('v0.1.0-alpha.9', { draft: true }))).toEqual({
      ok: false,
      because: 'draft',
    });
  });

  /**
   * Half the published alphas carry only a Node binary and a checksum file.
   * Installing from one produces a host with a Node and nothing to run — which
   * is exactly what the removed `v0.1.0-alpha.1` default did.
   */
  it('refuses a release with no runtime in it', () => {
    const partial = release('v0.1.0-alpha.17', {
      assets: [
        { name: 'asterism-node-v0.1.0-alpha.17-linux-amd64.tar.gz' },
        { name: 'SHA256SUMS' },
      ],
    });
    expect(eligibility(partial)).toEqual({
      ok: false,
      because: 'missing runtime bundle, manifest, runtime checksums',
    });
  });

  it('names every missing asset, one at a time', () => {
    const all = completeAssets('v1.0.0-alpha.1').map((asset) => asset.name);
    expect(missingAssets(all)).toEqual([]);
    expect(missingAssets(all.filter((name) => name !== 'manifest.json'))).toEqual(['manifest']);
    expect(missingAssets([])).toEqual([
      'Node binary',
      'runtime bundle',
      'manifest',
      'Node checksums',
      'runtime checksums',
    ]);
  });

  it('refuses anything that is not a version at all', () => {
    for (const tag of ['', 'latest', 'v1', 'v1.0', '1.0.0-alpha.1', 'v1.0.0', 'v1.0.0-beta.1']) {
      expect(eligibility(release(tag)).ok, `${tag} must be refused`).toBe(false);
    }
  });
});

describe('versions are compared as numbers, not as text', () => {
  it('parses the fields it needs and refuses the rest', () => {
    expect(parseVersion('v0.1.0-alpha.19')).toEqual([0, 1, 0, 19]);
    expect(parseVersion('v0.1.0-alpha.19-rc.8')).toBeNull();
    expect(parseVersion('v1.2.3')).toBeNull();
  });

  /**
   * The trap: as text, `alpha.9` sorts above `alpha.18`. The published list has
   * both, and one of them is a draft.
   */
  it('puts alpha.18 above alpha.9, where text ordering does not', () => {
    expect('v0.1.0-alpha.9' > 'v0.1.0-alpha.18').toBe(true);
    expect(compareVersions('v0.1.0-alpha.18', 'v0.1.0-alpha.9')).toBeGreaterThan(0);
    expect(compareVersions('v0.1.0-alpha.19', 'v0.1.0-alpha.18')).toBeGreaterThan(0);
    expect(compareVersions('v0.1.0-alpha.18', 'v0.1.0-alpha.18')).toBe(0);
    expect(compareVersions('v0.2.0-alpha.1', 'v0.1.0-alpha.99')).toBeGreaterThan(0);
  });
});

describe('resolving the release to offer', () => {
  beforeEach(() => resetReleaseCache());
  afterEach(() => vi.restoreAllMocks());

  /**
   * Ordered by publication, not by version, and containing every kind of thing
   * that must not be chosen. This is the shape the real API returns.
   */
  it('picks the newest eligible release regardless of the order it arrives in', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      answers([
        release('v0.1.0-alpha.9', { draft: true }),
        release('v0.1.0-alpha.19-rc.8'),
        release('v0.1.0-alpha.18'),
        release('v0.1.0-alpha.19'),
        release('v0.1.0-alpha.17', { assets: [{ name: 'SHA256SUMS' }] }),
      ]),
    );
    const chosen = await eligibleNodeRelease(REPO);
    expect(chosen?.version).toBe('v0.1.0-alpha.19');
    expect(chosen?.notes).toBe('notes for v0.1.0-alpha.19');
    expect(chosen?.url).toContain('v0.1.0-alpha.19');
  });

  it('asks the list, never the endpoint that hides prereleases', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => answers([release('v0.1.0-alpha.18')]));
    await eligibleNodeRelease(REPO);
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain('/releases?');
    // Every tag here is a prerelease, so `/releases/latest` answers 404 forever.
    expect(url).not.toContain('/releases/latest');
  });

  it('offers nothing when every release is ineligible', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      answers([
        release('v0.1.0-alpha.19-rc.8'),
        release('v0.1.0-alpha.9', { draft: true }),
        release('v0.1.0-alpha.17', { assets: [] }),
      ]),
    );
    expect(await eligibleNodeRelease(REPO)).toBeNull();
  });

  /**
   * Every failure is the same to a caller, and none of them may reach a page.
   */
  it('answers null rather than throwing, whatever went wrong', async () => {
    for (const failure of [
      () => Promise.reject(new Error('network down')),
      () => answers({ message: 'rate limit exceeded' }, false),
      () => answers({ not: 'an array' }),
      () => answers(null),
      () => answers([{ tag_name: 42 }]),
    ]) {
      resetReleaseCache();
      vi.spyOn(globalThis, 'fetch').mockImplementation(failure as never);
      await expect(eligibleNodeRelease(REPO)).resolves.toBeNull();
      vi.restoreAllMocks();
    }
  });

  it('asks once and reuses the answer', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => answers([release('v0.1.0-alpha.18')]));
    expect((await eligibleNodeRelease(REPO))?.version).toBe('v0.1.0-alpha.18');
    expect((await eligibleNodeRelease(REPO))?.version).toBe('v0.1.0-alpha.18');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('makes no request at all when the lookup is switched off', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await eligibleNodeRelease('')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
