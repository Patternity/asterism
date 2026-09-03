#!/usr/bin/env bash
#
# Build the Asterism project image: pinned Hermes + pinned Codex CLI.
#
# The build is reproducible in the sense that matters here: both the base image
# and the Codex CLI version are pinned, and the script records exactly what went
# in. It never mutates a running container.
#
# Usage:
#   scripts/build-project-image.sh [--base <image@sha256:...>] [--codex <version>] [--tag <tag>]

set -euo pipefail

HERMES_BASE_IMAGE="${ASTERISM_HERMES_IMAGE:-nousresearch/hermes-agent@sha256:a39fc11620213e3669a327aff5c6cb1eb2b8a238c6044e33e7ef8885833d89a7}"
CODEX_VERSION="${ASTERISM_CODEX_VERSION:-0.147.0}"
IMAGE_TAG="${ASTERISM_PROJECT_IMAGE:-asterism/project-runtime:hermes-0.20.3-codex-${CODEX_VERSION}}"

while [ "$#" -gt 0 ]; do
    case "$1" in
        --base) HERMES_BASE_IMAGE="$2"; shift 2 ;;
        --codex) CODEX_VERSION="$2"; shift 2 ;;
        --tag) IMAGE_TAG="$2"; shift 2 ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 64 ;;
    esac
done

case "$HERMES_BASE_IMAGE" in
    *@sha256:*) ;;
    *)
        echo "refusing to build from an unpinned base image: $HERMES_BASE_IMAGE" >&2
        echo "pass --base <image@sha256:...> so the project image stays reproducible" >&2
        exit 64
        ;;
esac

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> base image:    $HERMES_BASE_IMAGE"
echo "==> codex version: $CODEX_VERSION"
echo "==> output tag:    $IMAGE_TAG"

# Provenance is read out of the base image, not written down beside it. A digest
# and a revision recorded independently can disagree, and the one an operator
# would believe afterwards is whichever is wrong. The pinned digest is the single
# input; everything else is derived from what it actually resolves to.
docker pull -q "$HERMES_BASE_IMAGE" >/dev/null ||
    { echo "cannot pull the pinned Hermes base image" >&2; exit 1; }
HERMES_BASE_REVISION=$(docker image inspect "$HERMES_BASE_IMAGE" \
    --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)
: "${HERMES_BASE_REVISION:=unknown}"
# The digest of the manifest for this platform, which is what the layers below
# are actually built on. The pin above is a multi-platform index; recording only
# the index would leave the built artifact one indirection away from provenance.
HERMES_BASE_PLATFORM_DIGEST=$(docker image inspect "$HERMES_BASE_IMAGE" \
    --format '{{index .RepoDigests 0}}' 2>/dev/null)
: "${HERMES_BASE_PLATFORM_DIGEST:=unknown}"
echo "==> hermes revision: $HERMES_BASE_REVISION"

docker build \
    --file "$repo_root/docker/Dockerfile.codex" \
    --build-arg "HERMES_BASE_IMAGE=$HERMES_BASE_IMAGE" \
    --build-arg "HERMES_BASE_REVISION=$HERMES_BASE_REVISION" \
    --build-arg "HERMES_BASE_PLATFORM_DIGEST=$HERMES_BASE_PLATFORM_DIGEST" \
    --build-arg "CODEX_VERSION=$CODEX_VERSION" \
    --tag "$IMAGE_TAG" \
    "$repo_root/docker"

echo "==> verifying the Codex CLI as the non-root runtime user"
# 1000:1000 mirrors the HERMES_UID/HERMES_GID the project container runs with.
# The CLI must be usable by the user that will actually spawn `codex app-server`.
docker run --rm --user 1000:1000 --entrypoint codex "$IMAGE_TAG" --version

echo "==> verifying the Hermes entrypoint survived the derived layer"
# Only presence and executability are checked here. Running `hermes version`
# without the persistent data mount fails on an unreadable /opt/data/.env and
# would report a false negative; live Hermes verification belongs to
# `project ensure`, which starts the container with its real bind mounts.
docker run --rm --user 1000:1000 --entrypoint sh "$IMAGE_TAG" \
    -c 'test -x /opt/hermes/.venv/bin/hermes && echo "hermes entrypoint: OK"'

echo
echo "built: $IMAGE_TAG"
echo "record this image reference in the Phase B report."
