#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$repo_root"
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build

cd "$repo_root/control-plane"
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm audit

cd "$repo_root/control-plane/web"
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
env \
  -u LIVE_BASE_URL \
  -u LIVE_OWNER_EMAIL \
  -u LIVE_OWNER_PASSWORD \
  -u LIVE_HERMES_CONTAINER \
  -u LIVE_INTERRUPTED_RUN_ID \
  -u LIVE_REPLAY_RUN_ID \
  -u LIVE_REPLAY_EXPECTED_TEXT \
  -u LIVE_SESSION_STATE \
  npm run test:e2e
npm audit

if [[ "${PHASE_H_LIVE:-0}" == "1" ]]; then
  required_live_variables=(
    LIVE_BASE_URL
    LIVE_OWNER_EMAIL
    LIVE_OWNER_PASSWORD
    LIVE_HERMES_CONTAINER
    LIVE_REPLAY_RUN_ID
    LIVE_REPLAY_EXPECTED_TEXT
    LIVE_SESSION_STATE
    LIVE_NODE_VERDICTS_FILE
  )
  for variable in "${required_live_variables[@]}"; do
    if [[ -z "${!variable:-}" ]]; then
      echo "Phase H live acceptance requires $variable." >&2
      exit 1
    fi
  done

  if [[ ! -r "$LIVE_SESSION_STATE" ]]; then
    echo "Phase H live acceptance cannot read LIVE_SESSION_STATE." >&2
    exit 1
  fi
  if [[ ! -r "$LIVE_NODE_VERDICTS_FILE" ]]; then
    echo "Phase H live acceptance cannot read LIVE_NODE_VERDICTS_FILE." >&2
    exit 1
  fi

  live_log="$(mktemp -t asterism-phase-h-live.XXXXXX)"
  trap 'rm -f "$live_log"' EXIT
  npx playwright test test/e2e/live.spec.ts --project=chromium --reporter=line | tee "$live_log"

  required_browser_verdicts=(
    approval_request_observed
    approval_denied_not_executed
    approval_approved_executed_once
    cancellation_confirmed
    single_flight_released
    retry_link_verified
    control_plane_restarted
    browser_history_preserved
    event_replay_gapless
  )
  for verdict in "${required_browser_verdicts[@]}"; do
    if ! grep -Fq "\"verdict\":\"$verdict\"" "$live_log"; then
      echo "Phase H live acceptance is missing browser verdict: $verdict" >&2
      exit 1
    fi
  done
  if ! grep -Eq '[[:space:]]7 passed' "$live_log"; then
    echo "Phase H live acceptance did not complete all seven browser scenarios." >&2
    exit 1
  fi

  required_node_verdicts=(node_reconnected node_identity_preserved)
  for verdict in "${required_node_verdicts[@]}"; do
    if ! grep -Fq "\"verdict\":\"$verdict\"" "$LIVE_NODE_VERDICTS_FILE"; then
      echo "Phase H live acceptance is missing Node verdict: $verdict" >&2
      exit 1
    fi
  done

  echo 'Phase H live acceptance: 7 browser scenarios and 11 required verdicts passed.'
fi
