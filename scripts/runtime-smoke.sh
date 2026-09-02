#!/bin/sh
#
# Does this runtime start on this machine?
#
# Run inside a bare container of each supported platform, against a bundle that
# has just been built. Everything a checksum, a manifest and an unpack can tell
# you was already true of a bundle that could not start on Debian 11 — so this
# asks the only question they cannot, by starting the thing.
#
#   runtime-smoke.sh <bundle.tar.gz>
#
# A separate file rather than a string inside a workflow: the embedded version
# was three levels of nested quoting and failed with "exit code 2" — a shell
# syntax error — on three platforms at once, which says nothing about any of
# them. This can be run by hand, on any machine, before it is trusted.
set -eu

BUNDLE=${1:?usage: runtime-smoke.sh <bundle.tar.gz>}

echo "  host: $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")"
echo "  libc: $(ldd --version 2>/dev/null | sed -n 1p)"

# What the installer supplies on a real host. Without it this would be testing
# the container image's package set rather than the bundle: the Codex CLI ships a
# Node.js that links libatomic, which no bare image carries.
if ! ldconfig -p 2>/dev/null | grep -q 'libatomic\.so\.1'; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null 2>&1 || true
    apt-get install -y -qq libatomic1 >/dev/null 2>&1 || true
fi

# Packed from /opt, so its members are `asterism/...`. Extracting anywhere else
# would put the tree somewhere none of its own absolute paths point.
mkdir -p /opt
tar -C /opt -xzf "$BUNDLE"

# Hermes itself, bounded. A hand-picked list of imports is not the test:
# `sqlite3`, `ssl` and `hashlib` all load on a host where this runtime cannot
# start, and the dependency that actually failed — `cryptography`, reached
# through Hermes' own module graph — was on nobody's list.
echo "  starting Hermes"
timeout 120 /opt/asterism/hermes/.venv/bin/hermes --help > /dev/null

echo "  sqlite: $(/opt/asterism/hermes/.venv/bin/python -c 'import sqlite3; print(sqlite3.__name__, sqlite3.sqlite_version)')"

# And the binary a project's runs actually reach for, which links its own
# Node.js and is extracted from a container image rather than resolved as a
# wheel — so its floor is set by something this build does not choose.
echo "  codex:  $(timeout 60 /opt/asterism/codex/bin/codex --version)"

echo "  this runtime starts here"
