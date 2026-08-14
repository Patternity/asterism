#!/usr/bin/env bash
#
# Guard the project runtime image build context.
#
# The Docker daemon receives every file in the context, and anything in it can
# end up in a published layer. This refuses to build when the context holds
# something it should not, and when the Hermes base is not digest-pinned.
#
# Deliberately independent of `.dockerignore`: a deny-all ignore file is the
# mechanism, this is the check that the mechanism still holds.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
context="$repo_root/docker"
dockerfile="$context/Dockerfile.codex"

failures=0
pass() { printf '  %-46s PASS  %s\n' "$1" "${2:-}"; }
fail() { printf '  %-46s FAIL  %s\n' "$1" "${2:-}"; failures=$((failures + 1)); }

printf 'Image build context: %s\n\n' "$context"

# ------------------------------------------------------------ context content
# Every file the context is allowed to contain. Anything else is a finding,
# whether or not `.dockerignore` currently excludes it.
allowed=(
    'Dockerfile.codex'
    '.dockerignore'
    'third-party/THIRD_PARTY_NOTICES.md'
    'third-party/LICENSE.Apache-2.0.txt'
)

echo 'Context contents'
unexpected=0
while IFS= read -r relative; do
    permitted=0
    for entry in "${allowed[@]}"; do
        [[ "$relative" == "$entry" ]] && permitted=1 && break
    done
    if [[ "$permitted" -eq 0 ]]; then
        fail 'unexpected file in build context' "$relative"
        unexpected=1
    fi
done < <(cd "$context" && find . -type f -printf '%P\n' | sort)
[[ "$unexpected" -eq 0 ]] && pass 'only expected files present' "${#allowed[@]} allowed entries"

for entry in "${allowed[@]}"; do
    [[ -s "$context/$entry" ]] || fail 'required context file missing' "$entry"
done

echo

# ------------------------------------------------------- forbidden categories
# Explicit classes, named so a failure says what leaked rather than only that
# something did.
echo 'Forbidden categories'
forbidden_found=0
while IFS= read -r relative; do
    case "$relative" in
        .git|.git/*)                       fail 'git metadata in context' "$relative"; forbidden_found=1 ;;
        .asterism|.asterism/*)             fail 'node home in context' "$relative"; forbidden_found=1 ;;
        *auth.json|*identity.key|*.pem|*.key)
                                           fail 'credential file in context' "$relative"; forbidden_found=1 ;;
        .env|.env.*)                       fail 'environment file in context' "$relative"; forbidden_found=1 ;;
        *.db|*.sqlite|*.sqlite3|*.dump)    fail 'database in context' "$relative"; forbidden_found=1 ;;
        *.log)                             fail 'log in context' "$relative"; forbidden_found=1 ;;
        *storageState*|*.har)              fail 'browser state in context' "$relative"; forbidden_found=1 ;;
        *.tar.gz|*.tgz|*.zip)              fail 'archive in context' "$relative"; forbidden_found=1 ;;
        node_modules/*|target/*|dist/*)    fail 'build output in context' "$relative"; forbidden_found=1 ;;
    esac
done < <(cd "$context" && find . -mindepth 1 -printf '%P\n')
[[ "$forbidden_found" -eq 0 ]] && pass 'no credential, state, or build output' 'context is clean'

echo

# ------------------------------------------------------------- reproducibility
echo 'Reproducibility'

base="$(sed -n 's/^ARG HERMES_BASE_IMAGE=//p' "$dockerfile" | head -1)"
if [[ "$base" == *"@sha256:"* ]]; then
    pass 'Hermes base is digest-pinned' "${base##*@}"
else
    fail 'Hermes base is digest-pinned' "mutable reference: ${base:-none}"
fi

codex="$(sed -n 's/^ARG CODEX_VERSION=//p' "$dockerfile" | head -1)"
if [[ "$codex" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    # npm forbids republishing an existing version, so an exact version is an
    # immutable source in the sense this check cares about.
    pass 'Codex CLI pinned to an exact version' "$codex"
else
    fail 'Codex CLI pinned to an exact version' "got '${codex:-none}'"
fi

# A dist-tag would silently change what ships.
if grep -Eq '@openai/codex@(latest|next|beta|alpha)' "$dockerfile"; then
    fail 'no npm dist-tag in the install' 'mutable dist-tag used'
else
    pass 'no npm dist-tag in the install' 'exact version only'
fi

# Anything fetched over the network beyond the pinned npm package would need its
# own checksum, so flag it rather than let it pass unnoticed.
if grep -Eq '^[[:space:]]*(RUN.*)?(curl|wget)[[:space:]]' "$dockerfile"; then
    fail 'no unchecked network download' 'curl/wget present without a checksum gate'
else
    pass 'no unchecked network download' 'only pinned npm install'
fi

echo
if [[ "$failures" -gt 0 ]]; then
    printf 'FAILED: %d build-context problem(s).\n' "$failures"
    exit 1
fi
printf 'PASSED: build context is minimal and reproducible.\n'
