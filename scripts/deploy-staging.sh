#!/usr/bin/env bash
# Deploy an exact revision of the Control Plane from an isolated checkout.
#
# This exists because the previous arrangement had no way to answer "what is
# running?". The deployment source and the agent's workspace were one tree, so a
# build picked up whatever happened to be sitting there — on one occasion 1,071
# lines of uncommitted work, and on another an older commit than intended, with
# nothing in either case to say so.
#
# Every check below refuses rather than repairs. A deployment that cannot be
# named by a commit is not worth completing.
#
#   scripts/deploy-staging.sh --revision <sha>
#   scripts/deploy-staging.sh --revision <sha> --checkout /srv/asterism/deployment
set -euo pipefail

CHECKOUT="${ASTERISM_DEPLOY_CHECKOUT:-/srv/asterism/deployment}"
ENV_FILE="${ASTERISM_DEPLOY_ENV:-/etc/asterism/control-plane.production.env}"
REVISION=""
SKIP_BUILD=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --revision) REVISION="${2:?--revision needs a commit}"; shift 2 ;;
    --checkout) CHECKOUT="${2:?--checkout needs a path}"; shift 2 ;;
    --env-file) ENV_FILE="${2:?--env-file needs a path}"; shift 2 ;;
    --no-build) SKIP_BUILD=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { printf 'deploy refused: %s\n' "$*" >&2; exit 1; }

[ -n "$REVISION" ] || die "--revision is required; a deployment must name its commit"
[ -d "$CHECKOUT/.git" ] || die "$CHECKOUT is not a git checkout"
[ -f "$ENV_FILE" ] || die "no production env file at $ENV_FILE"

# The checkout must not be something anyone edits. A deployment built from a
# dirty tree cannot be reproduced from its commit, which is the whole point.
if [ -n "$(git -C "$CHECKOUT" status --porcelain --untracked-files=all)" ]; then
  git -C "$CHECKOUT" status --short --untracked-files=all | sed 's/^/  /' >&2
  die "the deployment checkout has local changes"
fi

git -C "$CHECKOUT" fetch --quiet origin
RESOLVED=$(git -C "$CHECKOUT" rev-parse --verify "${REVISION}^{commit}" 2>/dev/null) ||
  die "cannot resolve revision $REVISION in $CHECKOUT"

git -C "$CHECKOUT" -c advice.detachedHead=false checkout --quiet "$RESOLVED"
HEAD_SHA=$(git -C "$CHECKOUT" rev-parse HEAD)
[ "$HEAD_SHA" = "$RESOLVED" ] || die "checkout is at $HEAD_SHA, not the requested $RESOLVED"

COMPOSE_DIR="$CHECKOUT/control-plane"
BASE="$COMPOSE_DIR/docker-compose.yml"
PROD="$COMPOSE_DIR/docker-compose.production.yml"
[ -f "$PROD" ] || die "no production overlay at $PROD"

compose() {
  docker compose --project-directory "$COMPOSE_DIR" \
    --env-file "$ENV_FILE" -f "$BASE" -f "$PROD" "$@"
}

# Resolve once and audit the result, so what is inspected is what will run.
RENDERED=$(mktemp)
trap 'rm -f "$RENDERED"' EXIT
SOURCE_REVISION="$HEAD_SHA" compose config > "$RENDERED" ||
  die "the production configuration does not resolve"

grep -q 'NODE_ENV: production' "$RENDERED" || die "resolved configuration is not production"
grep -q 'NODE_ENV: development' "$RENDERED" && die "resolved configuration still says development"
grep -qE 'PUBLIC_BASE_URL: https://' "$RENDERED" || die "PUBLIC_BASE_URL is not https"
grep -qE 'PUBLIC_BASE_URL: https?://(127\.0\.0\.1|localhost)' "$RENDERED" &&
  die "PUBLIC_BASE_URL is a loopback address"
grep -q 'target: /var/lib/asterism/control-plane/uploads' "$RENDERED" ||
  die "no uploads mount in the resolved configuration"
grep -q "MEDIA_SIGNING_KEY" "$RENDERED" || die "MEDIA_SIGNING_KEY is not configured"

# Both images or neither: a stale migration image against a new application is
# how a deployment ends up refusing to start on a schema it already shipped.
if [ "$SKIP_BUILD" -eq 0 ]; then
  SOURCE_REVISION="$HEAD_SHA" compose build --quiet migrate control-plane ||
    die "build failed"
fi

for image in control-plane-migrate control-plane-control-plane; do
  stamped=$(docker image inspect "$image" \
    --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)
  [ "$stamped" = "$HEAD_SHA" ] ||
    die "$image was built from ${stamped:-nothing}, not $HEAD_SHA"
done

SOURCE_REVISION="$HEAD_SHA" compose up -d

printf '{"deploy":"ok","revision":"%s","checkout":"%s"}\n' "$HEAD_SHA" "$CHECKOUT"
