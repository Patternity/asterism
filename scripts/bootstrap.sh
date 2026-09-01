#!/bin/sh
#
# Connect this server to Asterism.
#
#   curl -fsSL https://raw.githubusercontent.com/Patternity/asterism/master/scripts/bootstrap.sh | sudo sh
#
# or, to read it before running it, which is the better habit:
#
#   curl -fsSLO https://raw.githubusercontent.com/Patternity/asterism/master/scripts/bootstrap.sh
#   less bootstrap.sh
#   sudo sh bootstrap.sh
#
# This does four things and nothing else: work out the platform, download the
# pinned Node release, check it against the published checksums, and hand over to
# it. Everything an installation actually involves is done by that binary, where
# it is typed, tested and reviewable — not here, in a script people pipe into a
# root shell.
#
# It never asks for the connection code. The Node prompts for it on the terminal
# with echo off, which is also why stdin being a pipe here does not matter.
set -eu

REPO=${ASTERISM_REPO:-Patternity/asterism}
VERSION=${ASTERISM_VERSION:-v0.1.0-alpha.1}
RELEASE_BASE=${ASTERISM_RELEASE_BASE:-https://github.com/${REPO}/releases/download}

die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run this with sudo: installing a Node writes system files"

case "$(uname -s)" in
    Linux) ;;
    *) die "Asterism Nodes run on Linux; this is $(uname -s)" ;;
esac

case "$(uname -m)" in
    x86_64|amd64) ARCH=amd64 ;;
    *) die "Asterism has no Node release for $(uname -m) yet" ;;
esac

for tool in curl tar sha256sum; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is required and is not installed"
done

NAME="asterism-node-${VERSION}-linux-${ARCH}"
URL="${RELEASE_BASE}/${VERSION}"

# Staged under /var/tmp rather than /tmp: on a small server /tmp is often a
# tmpfs, and this is the one place the script chooses where bytes land.
WORK=$(mktemp -d /var/tmp/asterism-bootstrap.XXXXXX)
trap 'rm -rf "$WORK"' EXIT INT TERM

printf '==> downloading Asterism Node %s\n' "$VERSION"
curl -fsSL --retry 3 -o "$WORK/${NAME}.tar.gz" "${URL}/${NAME}.tar.gz" ||
    die "cannot download the Node release $VERSION"
curl -fsSL --retry 3 -o "$WORK/SHA256SUMS" "${URL}/SHA256SUMS" ||
    die "cannot download the release checksums"

printf '==> verifying it\n'
# Only the line for this file, so an unrelated entry cannot pass the check and a
# missing entry cannot be mistaken for a passing one.
EXPECTED=$(awk -v n="${NAME}.tar.gz" '$2 == n || $2 == "*"n {print $1; exit}' "$WORK/SHA256SUMS")
[ -n "$EXPECTED" ] || die "the release does not publish a checksum for ${NAME}.tar.gz"
ACTUAL=$(sha256sum "$WORK/${NAME}.tar.gz" | cut -d' ' -f1)
[ "$EXPECTED" = "$ACTUAL" ] || die "the download does not match its published checksum; refusing to run it"

tar -C "$WORK" -xzf "$WORK/${NAME}.tar.gz" || die "the release archive could not be extracted"
BIN="$WORK/${NAME}/asterism-node"
[ -x "$BIN" ] || die "the release archive does not contain the Node binary"

printf '==> installing\n'
# Run rather than exec'd, so the trap above can remove the staged release. The
# exit code is passed through unchanged: whatever started this sees the Node's
# real outcome and not the success of a wrapper.
STATUS=0
"$BIN" node install "$@" || STATUS=$?
exit "$STATUS"
