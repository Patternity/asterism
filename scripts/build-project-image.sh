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

HERMES_BASE_IMAGE="${ASTERISM_HERMES_IMAGE:-nousresearch/hermes-agent@sha256:74021a2e4571a7a1200a5b6c12c030eee579f06ba168d846f1df062d4a4ea99f}"
CODEX_VERSION="${ASTERISM_CODEX_VERSION:-0.147.0}"
IMAGE_TAG="${ASTERISM_PROJECT_IMAGE:-asterism/project-runtime:hermes-0.20.0-codex-${CODEX_VERSION}}"

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

docker build \
    --file "$repo_root/docker/Dockerfile.codex" \
    --build-arg "HERMES_BASE_IMAGE=$HERMES_BASE_IMAGE" \
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
