#!/usr/bin/env bash
#
# What the pinned Hermes base image actually is.
#
# Printed as shell assignments so every builder derives the same three facts
# from the same single input — the digest pinned in the Dockerfile — instead of
# writing them down alongside it. A digest and a revision recorded independently
# can disagree, and the one that gets believed afterwards is whichever is wrong:
# the first published image of the 0.20.3 upgrade carried `unknown` for both, and
# a readable tag saying `hermes-0.20.0`.
#
#   eval "$(scripts/hermes-base-provenance.sh)"
#
# Refuses rather than guesses. A base image that cannot say which commit built it
# is not something to stamp an artifact with.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"

base=$(grep -oE 'ARG HERMES_BASE_IMAGE=[^[:space:]]+' "$here/docker/Dockerfile.codex" |
    head -1 | cut -d= -f2-)
[ -n "$base" ] || { echo "no HERMES_BASE_IMAGE pin in docker/Dockerfile.codex" >&2; exit 1; }

docker pull -q "$base" >/dev/null ||
    { echo "cannot pull the pinned Hermes base image: $base" >&2; exit 1; }

revision=$(docker image inspect "$base" \
    --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)
case "$revision" in
    ''|unknown|"<no value>")
        echo "the pinned Hermes base image does not record its source revision" >&2
        exit 1 ;;
esac

# The digest of the manifest for the platform this build runs on. The pin is a
# multi-platform index; recording only the index leaves the artifact one
# indirection away from the bytes it was actually built on.
platform_digest=$(docker image inspect "$base" --format '{{index .RepoDigests 0}}' 2>/dev/null || true)
[ -n "$platform_digest" ] || platform_digest="$base"

printf 'HERMES_BASE_IMAGE=%s\n' "$base"
printf 'HERMES_BASE_REVISION=%s\n' "$revision"
printf 'HERMES_BASE_PLATFORM_DIGEST=%s\n' "$platform_digest"
