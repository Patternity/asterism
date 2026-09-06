/**
 * How a Node's version reads beside the release that is current.
 *
 * "Differs", not "out of date". A host can legitimately be ahead — a build from
 * a working tree reports `v0.1.0` with no tag behind it — and calling that
 * stale would be a warning the operator learns to ignore, which is worse than
 * no warning at all.
 *
 * When either half is unknown no comparison is made. Until the first release is
 * published there is nothing to compare against, and a GitHub outage must not
 * turn every Node red.
 */
export function versionNote(
  reported: string | null | undefined,
  current: string | null | undefined,
): string | null {
  if (!reported || !current) return null;
  return reported === current ? null : `differs from ${current}`;
}
