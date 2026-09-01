#!/usr/bin/env bash
#
# Tests for the bootstrap script.
#
# The bootstrap is what a person pipes into a root shell, so the behaviour worth
# proving is what it refuses. These run the real script against a release served
# from a local directory over file://, with a stand-in binary, so nothing here
# needs a network or a real release.
#
# The script's first act is to require root. That is not bypassed for the tests:
# unprivileged, this asserts exactly that refusal, and the privileged CI job runs
# the rest. A test-only escape hatch in a script people run as root would be a
# worse thing to have than a partially-covered test run.

set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BOOTSTRAP="$HERE/bootstrap.sh"
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n     %s\n' "$1" "${2:-}"; }

contains() {
    local name="$1" needle="$2" haystack="$3"
    case "$haystack" in
        *"$needle"*) pass "$name" ;;
        *) fail "$name" "missing '$needle' in: $haystack" ;;
    esac
}

check() {
    local name="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then pass "$name"
    else fail "$name" "expected '$expected', got '$actual'"; fi
}

VERSION=v0.0.0-test
NAME="asterism-node-${VERSION}-linux-amd64"

# A release directory holding an archive whose only member is a stand-in Node.
# The stand-in reports the arguments it was given and exits with a distinctive
# code, which is how the handover and the exit code are checked at all.
make_release() {
    local dir="$1" exit_code="${2:-0}"
    mkdir -p "$dir/$VERSION" "$dir/build/$NAME"
    cat > "$dir/build/$NAME/asterism-node" <<STANDIN
#!/bin/sh
printf 'stand-in received: %s\n' "\$*"
exit $exit_code
STANDIN
    chmod +x "$dir/build/$NAME/asterism-node"
    tar -C "$dir/build" -czf "$dir/$VERSION/${NAME}.tar.gz" "$NAME"
    ( cd "$dir/$VERSION" && sha256sum "${NAME}.tar.gz" > SHA256SUMS )
}

run_bootstrap() {
    local dir="$1"
    ASTERISM_VERSION="$VERSION" \
    ASTERISM_RELEASE_BASE="file://$dir" \
        sh "$BOOTSTRAP" 2>&1
}

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

printf '\nbootstrap\n'

if [ "$(id -u)" != 0 ]; then
    make_release "$WORK/release"
    output=$(run_bootstrap "$WORK/release")
    contains "refuses to run unprivileged" "run this with sudo" "$output"
    printf '\n  %d passed, %d failed (privileged cases need root)\n' "$PASS" "$FAIL"
    [ "$FAIL" -eq 0 ] || exit 1
    exit 0
fi

# A release that is exactly what it says it is.
make_release "$WORK/good" 0
output=$(run_bootstrap "$WORK/good"); status=$?
check "a verified release is handed over to" 0 "$status"
contains "the Node is asked to install" "stand-in received: node install" "$output"

# The Node's exit code is the script's exit code.
make_release "$WORK/refusing" 6
run_bootstrap "$WORK/refusing" >/dev/null; status=$?
check "the Node's exit code is passed through" 6 "$status"

# An archive that does not match its published checksum.
make_release "$WORK/tampered" 0
printf 'extra' >> "$WORK/tampered/$VERSION/${NAME}.tar.gz"
output=$(run_bootstrap "$WORK/tampered"); status=$?
check "a tampered archive is refused" 1 "$status"
contains "and says why" "does not match its published checksum" "$output"

# A checksum file that says nothing about this archive. A missing entry must not
# read as a passing check.
make_release "$WORK/unlisted" 0
printf '%s  something-else.tar.gz\n' "$(printf 0 | sha256sum | cut -d' ' -f1)" \
    > "$WORK/unlisted/$VERSION/SHA256SUMS"
output=$(run_bootstrap "$WORK/unlisted"); status=$?
check "an unlisted archive is refused" 1 "$status"
contains "and says the checksum is missing" "does not publish a checksum" "$output"

# Nothing is left in /var/tmp afterwards.
before=$(find /var/tmp -maxdepth 1 -name 'asterism-bootstrap.*' 2>/dev/null | wc -l)
make_release "$WORK/clean" 0
run_bootstrap "$WORK/clean" >/dev/null
after=$(find /var/tmp -maxdepth 1 -name 'asterism-bootstrap.*' 2>/dev/null | wc -l)
check "the staged release is removed" "$before" "$after"

printf '\n  %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
