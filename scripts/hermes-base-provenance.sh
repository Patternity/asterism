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

# The digest of the manifest for the platform this build runs on.
#
# Not `RepoDigests`: that reports the reference the image was pulled by, so
# pulling the pin gives the pin back. The first image built this way carried the
# index digest under a label named `platform-digest` — a field whose name and
# value disagreed, which is worse than not recording it.
#
# `docker manifest inspect` reads the index from the registry and names the
# per-platform manifests inside it.
arch=$(docker version --format '{{.Server.Arch}}' 2>/dev/null || echo amd64)
platform_digest=$(docker manifest inspect "$base" 2>/dev/null | python3 -c "
import json, sys
want = sys.argv[1]
try:
    doc = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
for m in doc.get('manifests', []):
    p = m.get('platform', {})
    if p.get('os') == 'linux' and p.get('architecture') == want:
        print('%s@%s' % (sys.argv[2].split('@')[0], m['digest']))
        break
" "$arch" "$base" 2>/dev/null || true)

# A single-platform image has no index to resolve; its own digest is the answer.
if [ -z "$platform_digest" ]; then
    platform_digest=$(docker image inspect "$base" --format '{{index .RepoDigests 0}}' 2>/dev/null || true)
fi
[ -n "$platform_digest" ] || platform_digest="$base"

printf 'HERMES_BASE_IMAGE=%s\n' "$base"
printf 'HERMES_BASE_REVISION=%s\n' "$revision"
printf 'HERMES_BASE_PLATFORM_DIGEST=%s\n' "$platform_digest"
