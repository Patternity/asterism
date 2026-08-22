#!/usr/bin/env bash
# Validate the production Compose stack before it is deployed.
#
# Two things happen here. Compose itself resolves the overlay, which proves the
# files are valid and that every required variable is supplied — a missing one
# stops here rather than at `up -d`. The resolved result is then audited for the
# deployment invariants that Compose has no opinion about: the environment must
# say production, TLS-terminated origins must be https, the database must not be
# published, and the API must stay behind the reverse proxy.
#
# The placeholder values below exist so this can run in CI with no secrets at
# all. They are interpolation inputs, not configuration: a real deployment
# passes its own env files instead.
#
#   scripts/check-production-config.sh                     # CI, placeholders
#   scripts/check-production-config.sh --env-file .env \
#       --env-file /etc/asterism/control-plane.production.env
set -euo pipefail

cd "$(dirname "$0")/../control-plane"

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose is required" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  # No env files given: resolve with placeholders so the shape can be checked
  # without any real value being present.
  export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-placeholder-for-configuration-check}"
  export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://control-plane.example.test}"
  export ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://control-plane.example.test}"
  export TRUST_PROXY="${TRUST_PROXY:-127.0.0.1}"
  # Non-secret bootstrap metadata for the tools profile. Compose interpolates
  # every service, profiles included, so these must resolve to something.
  export OWNER_EMAIL="${OWNER_EMAIL:-owner@example.test}"
  export OWNER_DISPLAY_NAME="${OWNER_DISPLAY_NAME:-Configuration Check}"
fi

resolved=$(docker compose \
  -f docker-compose.yml \
  -f docker-compose.production.yml \
  "$@" \
  config --format json)

printf '%s' "$resolved" | npx tsx src/cli/check-production-config.ts
