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

/**
 * The release a Node should be offered, or nothing.
 *
 * Derived from the same comparison the note beside the version uses, so the
 * button and the note can never disagree about whether an update is worth
 * offering. A button that is always there invites a pointless update; one
 * offered without a version to name would have to guess what "latest" meant a
 * moment ago, which is why the console sends the release it is showing.
 */
export function updateTarget(
  reported: string | null | undefined,
  current: string | null | undefined,
): string | null {
  return versionNote(reported, current) ? (current ?? null) : null;
}
