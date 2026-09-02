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

# The version the build pins and the installer refuses to go below. Overridable
# so this stays runnable against an older bundle by hand, which is how the
# rc.5 failure was reproduced.
SQLITE_EXPECTED=${SQLITE_EXPECTED:-3.53.4}

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

# The other half of "does this runtime work here", and the half that fails
# quietly. A runtime can start perfectly and still be reading its databases
# through the interpreter's own SQLite: the shim is a .pth plus a module, and a
# wheel that failed to build leaves both absent with nothing in the logs. The
# host that prompted this was serving every Hermes database in `delete` mode
# because its SQLite was 3.50.4 -- inside the WAL-reset bug's range -- and
# nothing on it reported a problem.
#
# So this asks the interpreter Hermes actually runs: which driver, which
# version, and does a database opened by it stay in WAL.
echo "  checking the SQLite Hermes will use"
/opt/asterism/hermes/.venv/bin/python - "$SQLITE_EXPECTED" <<'PY'
import os, sqlite3, sys, tempfile

expected = sys.argv[1]
print(f"  sqlite: {sqlite3.__name__} {sqlite3.sqlite_version}")

if sqlite3.__name__ != "pysqlite3":
    raise SystemExit(
        f"  the runtime reads databases through {sqlite3.__name__}, not the bundled"
        " pysqlite3 -- the SQLite shim is missing from this bundle"
    )
if sqlite3.sqlite_version != expected:
    raise SystemExit(f"  expected SQLite {expected}, got {sqlite3.sqlite_version}")

path = os.path.join(tempfile.mkdtemp(), "probe.db")
conn = sqlite3.connect(path)
mode = conn.execute("pragma journal_mode=wal").fetchone()[0]
conn.execute("create table t(x)")
conn.execute("insert into t values (1)")
conn.commit()
# Read it back through a second connection: the mode is stored in the file, and
# the bug this pins away from is one where it does not stay there.
persisted = sqlite3.connect(path).execute("pragma journal_mode").fetchone()[0]
conn.close()
if mode != "wal" or persisted != "wal":
    raise SystemExit(f"  journal mode did not hold: set {mode}, reopened as {persisted}")
conn = sqlite3.connect(path)
conn.execute("create virtual table fts using fts5(body)")
conn.close()
print("  wal holds across reopen, and fts5 works")
PY

# And the binary a project's runs actually reach for, which links its own
# Node.js and is extracted from a container image rather than resolved as a
# wheel — so its floor is set by something this build does not choose.
echo "  codex:  $(timeout 60 /opt/asterism/codex/bin/codex --version)"

echo "  this runtime starts here"
