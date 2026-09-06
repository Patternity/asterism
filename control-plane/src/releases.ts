/**
 * Which Node release is current, so the console can say whether a host is on it.
 *
 * The answer comes from the repository's own releases, because that is where a
 * Node update comes from: `node update` fetches its binary and its runtime
 * bundle from exactly these tags. Anything else — a configured expected
 * version, a value baked into this image — would be a second place to remember
 * to bump, and would be wrong the moment somebody forgot.
 *
 * Two properties matter more than freshness:
 *
 *  * **It never fails a page.** Every error is swallowed into `null`. A Nodes
 *    page that will not load because GitHub is slow is worse than one that
 *    cannot say what the current release is.
 *  * **It never hammers the API.** Unauthenticated calls are limited to 60 an
 *    hour per address, so the answer is cached and refreshed at most once every
 *    `TTL_MS`. A failed lookup is cached too, briefly, so an outage costs one
 *    request rather than one per page load.
 */

/** How long a good answer is reused. */
const TTL_MS = 15 * 60_000;
/** How long a failure is remembered, so an outage is not amplified. */
const FAILURE_TTL_MS = 60_000;
/** Long enough for a normal answer, short enough not to hold a page open. */
const TIMEOUT_MS = 4_000;

interface Cached {
  version: string | null;
  until: number;
}

let cache: Cached | null = null;

/**
 * The current release tag, or `null` if there is not one to name.
 *
 * `/releases/latest` is GitHub's own answer, and it is the right one: it skips
 * drafts and pre-releases, so a release candidate tagged on the way to a
 * release never tells an operator their host is behind. Until the first release
 * is published this answers 404, and `null` is the honest reading of that —
 * there is no current release for a Node to be on yet.
 */
export async function currentNodeRelease(repository: string): Promise<string | null> {
  if (!repository) return null;
  const now = Date.now();
  if (cache && cache.until > now) return cache.version;

  const version = await fetchLatest(repository);
  cache = { version, until: now + (version ? TTL_MS : FAILURE_TTL_MS) };
  return version;
}

async function fetchLatest(repository: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
      signal: controller.signal,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'asterism-control-plane',
      },
    });
    // 404 while no release is published yet, and that is not an error worth
    // distinguishing here: either way there is no tag to name.
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const tag = (body as { tag_name?: unknown } | null)?.tag_name;
    return typeof tag === 'string' && tag.length > 0 && tag.length <= 64 ? tag : null;
  } catch {
    // Unreachable, too slow, rate-limited, or answering something unexpected.
    // All of them mean the same thing to a caller: no answer this time.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Forget what was cached. Tests drive the lookup directly; nothing else needs this. */
export function resetReleaseCache(): void {
  cache = null;
}
