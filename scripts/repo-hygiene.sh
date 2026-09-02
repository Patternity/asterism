#!/usr/bin/env bash
#
# Repository hygiene scan.
#
# Fails if credentials, runtime state, build output, or oversized artifacts have
# reached Git. Deterministic, offline, and repository-owned on purpose: nothing
# here uploads repository contents to a third-party service.
#
# Reports paths and classifications. It never prints a discovered secret value.
#
# Usage:
#   scripts/repo-hygiene.sh           # scan tracked files at HEAD
#   scripts/repo-hygiene.sh --staged  # scan the current index, for pre-commit
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

mode="tracked"
if [[ "${1:-}" == "--staged" ]]; then
    mode="staged"
fi

if [[ "$mode" == "staged" ]]; then
    mapfile -t files < <(git diff --cached --name-only --diff-filter=ACMR)
else
    mapfile -t files < <(git ls-files)
fi

failures=0
note() { printf '  %-22s %s\n' "$1" "$2"; }
fail() { failures=$((failures + 1)); note "$@"; }

printf 'Repository hygiene scan (%s): %d file(s)\n\n' "$mode" "${#files[@]}"

# ---------------------------------------------------------------- forbidden paths
# Runtime state and credential stores that must never be tracked. Matched on the
# whole path so a legitimately named source file cannot trip them by accident.
forbidden_patterns=(
    '(^|/)\.asterism(/|$)'
    '(^|/)\.env$'
    '(^|/)\.env\.(?!example$)[^/]+$'
    '(^|/)auth\.json$'
    '(^|/)identity\.key$'
    '\.(pem|pfx|p12)$'
    '(^|/)id_(rsa|ecdsa|ed25519)([^/]*)$'
    '\.(db|sqlite|sqlite3)(-wal|-shm)?$'
    '\.(dump|pgdump)$'
    '\.sql\.gz$'
    '\.log$'
    '(^|/)node_modules(/|$)'
    '(^|/)target(/|$)'
    '(^|/)dist(/|$)'
    '(^|/)coverage(/|$)'
    '(^|/)test-results(/|$)'
    '(^|/)playwright-report(/|$)'
    '(^|/)storageState[^/]*\.json$'
    '\.(tar\.gz|tgz|zip|har|trace\.zip)$'
)

echo 'Forbidden paths'
found_forbidden=0
for pattern in "${forbidden_patterns[@]}"; do
    while IFS= read -r match; do
        [[ -z "$match" ]] && continue
        fail 'FORBIDDEN_PATH' "$match"
        found_forbidden=1
    done < <(printf '%s\n' "${files[@]}" | grep -Piv '(^|/)\.gitignore$' | grep -Pi -- "$pattern" || true)
done
[[ "$found_forbidden" -eq 0 ]] && note 'OK' 'no runtime state, credential file, or build output tracked'
echo

# --------------------------------------------------------------- oversized files
# A source repository has no business carrying multi-megabyte blobs. The limit is
# generous enough for lockfiles and small fixtures.
echo 'Oversized files'
limit_bytes=$((2 * 1024 * 1024))
found_large=0
for file in "${files[@]}"; do
    [[ -f "$file" ]] || continue
    size=$(wc -c <"$file")
    if [[ "$size" -gt "$limit_bytes" ]]; then
        fail 'OVERSIZED_FILE' "$file ($((size / 1024)) KiB)"
        found_large=1
    fi
done
[[ "$found_large" -eq 0 ]] && note 'OK' "no tracked file exceeds $((limit_bytes / 1024)) KiB"
echo

# ------------------------------------------------------------- credential shapes
# Value-shaped detection for credentials that arrive without a telling filename.
# Matches are reported by classification and path only.
echo 'Credential shapes'
python3 - "$mode" "${files[@]}" <<'PYTHON'
import re
import sys

mode = sys.argv[1]
paths = sys.argv[2:]

PATTERNS = [
    ('OPENAI_API_KEY',      re.compile(rb'\bsk-(?!ant-|or-)[A-Za-z0-9]{24,}')),
    ('ANTHROPIC_API_KEY',   re.compile(rb'\bsk-ant-[A-Za-z0-9_-]{24,}')),
    ('OPENROUTER_API_KEY',  re.compile(rb'\bsk-or-v1-[A-Za-z0-9]{24,}')),
    ('GITHUB_TOKEN',        re.compile(rb'\bgh[pousr]_[A-Za-z0-9]{30,}')),
    ('AWS_ACCESS_KEY',      re.compile(rb'\bAKIA[0-9A-Z]{16}\b')),
    ('SLACK_TOKEN',         re.compile(rb'\bxox[baprs]-[A-Za-z0-9-]{20,}')),
    ('JWT_LIKE',            re.compile(rb'\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}')),
    ('PEM_PRIVATE_KEY',     re.compile(rb'-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----')),
    ('OAUTH_REFRESH_TOKEN', re.compile(rb'"refresh_token"\s*:\s*"[^"]{20,}"')),
    ('OAUTH_ACCESS_TOKEN',  re.compile(rb'"access_token"\s*:\s*"[^"]{20,}"')),
    ('SESSION_COOKIE',      re.compile(rb'asterism_session=[A-Za-z0-9._-]{20,}')),
]

# Files that legitimately contain credential-shaped literals, with the reason.
# Each is a fixture or a detector test, never a live credential.
ALLOWED = {
    'src/redact.rs': 'unit tests for the redactor must contain secret-shaped literals',
    'control-plane/src/logger.ts': 'redaction patterns',
    'control-plane/src/protocol.ts': 'key-encoding constants',
    'control-plane/test/unit/logger.test.ts': 'redaction tests',
    'scripts/repo-hygiene.sh': 'this scanner',
}

findings = []
for path in paths:
    try:
        with open(path, 'rb') as handle:
            blob = handle.read()
    except (OSError, IsADirectoryError):
        continue
    for label, pattern in PATTERNS:
        if pattern.search(blob):
            if path in ALLOWED:
                print('  %-22s %s (%s)' % ('ALLOWED_FIXTURE', path, ALLOWED[path]))
            else:
                findings.append((label, path))

if findings:
    for label, path in findings:
        print('  %-22s %s' % ('SECRET_SHAPE', path))
    sys.exit(1)

print('  %-22s %s' % ('OK', 'no credential-shaped value in tracked content'))
PYTHON
shape_status=$?
echo

if [[ "$shape_status" -ne 0 ]]; then
    failures=$((failures + 1))
fi

# ------------------------------------------------------------------- lockfiles
# Reproducible builds depend on these. Losing one is a defect, not a cleanup.
# This is an assertion about the *whole* repository, so it is enforced only in
# `tracked` mode, which is what CI runs. In `--staged` mode a lockfile may
# legitimately not be in the tree yet, so its absence is reported without
# failing.
echo 'Required lockfiles'
resulting_tree="$( { git ls-files; printf '%s\n' "${files[@]}"; } | sort -u )"
for lockfile in Cargo.lock control-plane/package-lock.json control-plane/web/package-lock.json; do
    if grep -qxF "$lockfile" <<<"$resulting_tree"; then
        note 'TRACKED' "$lockfile"
    elif [[ "$mode" == "tracked" ]]; then
        fail 'MISSING_LOCKFILE' "$lockfile"
    else
        note 'NOT_YET_IN_TREE' "$lockfile"
    fi
done
echo

# --------------------------------------------------- one protocol, two typed lists
# The Control Plane and the console each carry a list of provider-authorization
# states, and a value added to one and not the other is a state the console
# renders as a raw identifier. Checked here rather than in either test suite,
# because this is the only place that has both: the console's own suite cannot
# reach across the workspace boundary without breaking the production image,
# whose web stage copies only that directory.
echo 'Provider states agree across the protocol'
states_of() {
    sed -n "/^export const PROVIDER_STATES/,/as const/p" "$1" \
        | grep -oE "'[a-z_]+'" | tr -d "'" | sort
}
server_states=control-plane/src/provider-authorization.ts
console_states=control-plane/web/src/provider-authorization.ts
if [[ -f "$server_states" && -f "$console_states" ]]; then
    if diff -q <(states_of "$server_states") <(states_of "$console_states") >/dev/null; then
        note 'AGREE' "$(states_of "$server_states" | tr '\n' ' ')"
    else
        fail 'PROVIDER_STATES_DIVERGED' \
            "$(diff <(states_of "$server_states") <(states_of "$console_states") | tr '\n' ' ')"
    fi
else
    note 'ABSENT' 'no provider state lists to compare'
fi
echo

# The runtime tree is handed back to root before anything starts running from
# it. A service account that can rewrite the binaries it executes as a service
# can escalate through its own runtime, and the window this closes is real: the
# virtualenv has to be *built* by that account, so `$HERMES_DIR` is genuinely
# its for part of the install.
#
# The invariant is an ordering, which no unit test sees: the handback must come
# after the last step that writes to `$OPT_DIR` and before the units start. A
# refactor that moves either one is silent otherwise -- the install still
# succeeds, and the tree is simply left writable.
echo 'The runtime is handed back to root before it is run'
installer=scripts/install.sh
if [[ -f "$installer" ]]; then
    flow=$(sed -n '/^main() {/,/^}/p' "$installer" | grep -oE '^ +[a-z_]+$' | tr -d ' ')
    # `|| true`: this file runs under `set -e`, and an assignment from a command
    # substitution takes that substitution's status. A name that is simply absent
    # is one of the things being checked for -- letting grep's "no match" end the
    # script would report that absence as a crash with no message, and skip every
    # check after it.
    line_of() { grep -nx "$1" <<< "$flow" | cut -d: -f1 || true; }
    handback=$(line_of secure_runtime_ownership)
    starts=$(line_of start_services)
    units=$(line_of write_units)
    if [[ -z "$handback" ]]; then
        fail 'OWNERSHIP_HANDBACK_MISSING' 'install.sh never gives $OPT_DIR back to root'
    elif [[ -z "$starts" || -z "$units" ]]; then
        note 'SKIPPED' 'the install flow no longer names write_units/start_services'
    elif (( handback > units && handback < starts )); then
        note 'ORDERED' "handback sits between write_units and start_services"
    else
        fail 'OWNERSHIP_HANDBACK_MISORDERED' \
            "secure_runtime_ownership must run after write_units and before start_services"
    fi
else
    note 'ABSENT' 'no installer to check'
fi
echo

if [[ "$failures" -gt 0 ]]; then
    printf 'FAILED: %d hygiene problem(s).\n' "$failures"
    exit 1
fi

printf 'PASSED: repository hygiene is clean.\n'
