/**
 * Which release a Node may be pointed at.
 *
 * Two facts make this harder than asking GitHub for the latest release, and
 * both were found the expensive way.
 *
 * **Every Asterism tag is a prerelease.** The release workflow marks a release
 * prerelease when its tag contains a hyphen, and every tag this project has ever
 * published does — `v0.1.0-alpha.19` included. `/releases/latest` skips
 * prereleases, so it answers 404 forever and would go on doing so after the
 * release everybody is waiting for is published. The list endpoint is used
 * instead, and eligibility is decided here rather than borrowed from a flag
 * that means something else.
 *
 * **The list is not ordered by version.** It is ordered by publication, and the
 * versions themselves sort wrong as text: `alpha.9` is lexicographically
 * greater than `alpha.18`. Comparison is numeric, field by field.
 *
 * What counts as eligible is deliberately narrow, because the answer is handed
 * to an operator as a command to run on a server:
 *
 *  * a full alpha release, never a release candidate — an RC is the road to a
 *    release, not one, and production does not follow the road;
 *  * not a draft — `v0.1.0-alpha.9` is one, and it is also the tag that naive
 *    text ordering would pick;
 *  * carrying the complete asset set. Half the published alphas have only a
 *    Node binary and a checksum file: no runtime bundle, no manifest. Installing
 *    from one of those produces a host with a Node and nothing to run.
 */

/** How long a good answer is reused. */
const TTL_MS = 15 * 60_000;
/** How long a failure is remembered, so an outage is not amplified. */
const FAILURE_TTL_MS = 60_000;
/** Long enough for a normal answer, short enough not to hold a page open. */
const TIMEOUT_MS = 5_000;

/** A full alpha release: `v1.2.3-alpha.4`, and nothing else. */
const ELIGIBLE_TAG = /^v(\d+)\.(\d+)\.(\d+)-alpha\.(\d+)$/;

/**
 * What a release must carry to be installable.
 *
 * Matched by shape rather than by exact name: three of the five embed the
 * version, and a list of literals would have to be rewritten for every release.
 */
const REQUIRED_ASSETS: readonly { readonly what: string; readonly matches: RegExp }[] = [
  { what: 'Node binary', matches: /^asterism-node-.+-linux-amd64\.tar\.gz$/ },
  { what: 'runtime bundle', matches: /^asterism-runtime-.+-linux-amd64\.tar\.gz$/ },
  { what: 'manifest', matches: /^manifest\.json$/ },
  { what: 'Node checksums', matches: /^SHA256SUMS$/ },
  { what: 'runtime checksums', matches: /^SHA256SUMS\.runtime$/ },
];

export interface EligibleRelease {
  /** The tag, exactly as it must be passed to the installer. */
  version: string;
  /** The release notes, for somebody deciding whether to move a host. */
  notes: string;
  /** Where a person reads it in full. */
  url: string;
}

interface Cached {
  release: EligibleRelease | null;
  until: number;
}

let cache: Cached | null = null;

/** Version fields, most significant first, or `null` if this is not one. */
export function parseVersion(tag: string): number[] | null {
  const match = ELIGIBLE_TAG.exec(tag);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
}

/** Numeric, field by field. Text ordering puts `alpha.9` above `alpha.18`. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let i = 0; i < left.length; i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Which of the required assets a release is missing, if any. */
export function missingAssets(names: readonly string[]): string[] {
  return REQUIRED_ASSETS.filter((asset) => !names.some((name) => asset.matches.test(name))).map(
    (asset) => asset.what,
  );
}

interface ReleaseSummary {
  tag_name?: unknown;
  draft?: unknown;
  body?: unknown;
  html_url?: unknown;
  assets?: unknown;
}

/** Whether one release from the API may be offered, and why not when it may not. */
export function eligibility(
  release: ReleaseSummary,
): { ok: true } | { ok: false; because: string } {
  const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
  if (!parseVersion(tag)) {
    return { ok: false, because: 'not a full alpha release tag' };
  }
  if (release.draft === true) return { ok: false, because: 'draft' };
  const names = Array.isArray(release.assets)
    ? release.assets
        .map((asset) => (asset as { name?: unknown }).name)
        .filter((name): name is string => typeof name === 'string')
    : [];
  const missing = missingAssets(names);
  if (missing.length > 0) return { ok: false, because: `missing ${missing.join(', ')}` };
  return { ok: true };
}

/**
 * The release a Node may be pointed at, or `null` if there is not one.
 *
 * Never throws and never fails a page: an outage, a rate limit or an answer of
 * an unexpected shape all mean the same thing to a caller, which is that the
 * question cannot be answered right now.
 */
export async function eligibleNodeRelease(repository: string): Promise<EligibleRelease | null> {
  if (!repository) return null;
  const now = Date.now();
  if (cache && cache.until > now) return cache.release;

  const release = await fetchEligible(repository);
  cache = { release, until: now + (release ? TTL_MS : FAILURE_TTL_MS) };
  return release;
}

async function fetchEligible(repository: string): Promise<EligibleRelease | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // One page of a hundred. Releases are ordered by publication, so the newest
    // eligible one is near the front; a project that has published more than a
    // hundred releases since its last full alpha has a larger problem than this.
    const response = await fetch(
      `https://api.github.com/repos/${repository}/releases?per_page=100`,
      {
        signal: controller.signal,
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'asterism-control-plane',
        },
      },
    );
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!Array.isArray(body)) return null;

    let best: EligibleRelease | null = null;
    for (const entry of body as ReleaseSummary[]) {
      if (!eligibility(entry).ok) continue;
      const version = entry.tag_name as string;
      if (best !== null && compareVersions(version, best.version) <= 0) continue;
      best = {
        version,
        notes: typeof entry.body === 'string' ? entry.body.trim() : '',
        url: typeof entry.html_url === 'string' ? entry.html_url : '',
      };
    }
    return best;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Forget what was cached. Tests drive the lookup directly; nothing else needs this. */
export function resetReleaseCache(): void {
  cache = null;
}
