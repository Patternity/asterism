#!/usr/bin/env bash
#
# Build the Asterism runtime as one verifiable archive.
#
# What a host actually needs is Hermes, the Codex CLI, the pinned interpreter and
# the SQLite that is past the WAL-reset bug. Today every host downloads a 1.03 GB
# runtime image to obtain them, extracts what it wants and throws the rest away —
# a full OS userland and the layers that built it. The result of that extraction
# is 1.9 GB installed and 0.55 GB compressed, so the image costs roughly twice
# what it delivers.
#
# This performs that extraction once, in CI, from a named revision. It does not
# reimplement it: the runtime is defined by `install.sh`, and this sources that
# file and calls the same functions a host would, so the bundle cannot drift from
# what the supported installer produces.
#
#   scripts/build-runtime-bundle.sh <output-directory> <version>
#
# Needs root, Docker and the service account, and it installs the runtime at its
# real path on the machine it runs on — which is why it belongs on a disposable
# runner rather than anywhere that matters, and refuses to run where something is
# already installed.
set -Eeuo pipefail

# A long build that exits without saying where it stopped is not diagnosable
# from a log tail, and this one runs mostly inside functions sourced from the
# installer. `set -E` carries the trap into them, so the last line printed is
# always the command that actually failed.
trap 'printf "\n==> failed at %s:%s: %s\n" "${BASH_SOURCE[0]}" "$LINENO" "$BASH_COMMAND" >&2' ERR

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
OUT=${1:?usage: build-runtime-bundle.sh <output-directory> <version>}
VERSION=${2:?usage: build-runtime-bundle.sh <output-directory> <version>}

mkdir -p "$OUT"

# Built at the real path, not under a staging prefix.
#
# A Python virtualenv is not relocatable: `pyvenv.cfg` and every console script
# record absolute paths, so an environment built at `/tmp/tmp.XXXX/opt/asterism`
# carries that path in the shebang of `bin/hermes` and fails on a host with "bad
# interpreter". Building where the runtime actually lives is the only way to
# produce an archive that works when it is unpacked there.
#
# That means this genuinely installs on the machine it runs on, which is why it
# belongs on a disposable runner and refuses to run anywhere something is
# already installed.
if [ -e /opt/asterism ]; then
    echo "/opt/asterism already exists; this builds at the real path and would replace it" >&2
    echo "run it on a disposable machine with nothing installed" >&2
    exit 1
fi

# Sourced rather than run: `ASTERISM_INSTALL_LIB_ONLY` defines every function and
# every pinned constant without performing an installation. The constants are
# then read from the same place the build used them, so the manifest cannot
# describe a version the bundle does not contain.
export ASTERISM_INSTALL_LIB_ONLY=1
export ASTERISM_USER="${ASTERISM_USER:-asterism}"
# shellcheck source=scripts/install.sh
. "$HERE/install.sh"
ASTERISM_GROUP=$ASTERISM_USER

REVISION=${SOURCE_REVISION:-$(git -C "$HERE/.." rev-parse HEAD)}

# The account must already exist, because `create_user` below would otherwise
# create it with its home pointing into this temporary tree, which is deleted
# when the build ends. Checking is cheaper than leaving that behind.
id -u "$ASTERISM_USER" >/dev/null 2>&1 || {
    echo "the service account $ASTERISM_USER does not exist on this machine" >&2
    exit 1
}

# `create_user` also creates the project workspace, which is a host concern
# rather than a runtime one. The installer's own non-interactive default is used
# and then discarded: only `/opt/asterism` is packed.
WORKSPACE="$WORKSPACE_DEFAULT"

echo "==> building the runtime into a staging root"
# Exactly what a host runs, in the order a host runs it. `create_user` supplies
# the directories the rest depends on — including the state directory that
# serves as the account's HOME while uv resolves the lock. `install_hermes`
# orchestrates uv, the Hermes extraction, the Codex CLI and the virtualenv; the
# two SQLite steps supply the driver that is past the WAL-reset bug.
create_user
install_hermes
provide_sqlite
configure_sqlite

# What the runtime actually links, asked of the runtime rather than assumed.
#
# The manifest used to state the target version and the journal mode the build
# hoped for. `provide_sqlite` is deliberately non-fatal — a host that cannot
# reach sqlite.org must still be installable — so a bundle could be published
# claiming SQLite 3.53.4 while carrying the interpreter's own 3.50.4 and running
# every state database without WAL. That is a false claim about a runtime, and it
# costs write concurrency on every host that installs it.
#
# A bundle is not a host improvising. It is built once, in CI, with the network
# and Docker it needs; if the SQLite it exists to carry did not get built, the
# honest outcome is no bundle.
OBSERVED_SQLITE=$(/opt/asterism/hermes/.venv/bin/python \
    -c 'import sqlite3; print(sqlite3.sqlite_version)' 2>/dev/null || echo unknown)
echo "==> the built runtime links SQLite $OBSERVED_SQLITE (journal ${JOURNAL_MODE:-unknown})"

if [ "$OBSERVED_SQLITE" != "$SQLITE_TARGET_VERSION" ]; then
    echo "the runtime links SQLite $OBSERVED_SQLITE, not the required $SQLITE_TARGET_VERSION" >&2
    echo "the SQLite compatibility layer did not take effect; refusing to publish" >&2
    exit 1
fi
if [ "${JOURNAL_MODE:-}" != "wal" ]; then
    echo "the runtime would run its state databases with journal_mode=${JOURNAL_MODE:-unknown}" >&2
    echo "WAL is the accepted requirement; refusing to publish" >&2
    exit 1
fi

TREE="/opt/asterism"
[ -d "$TREE" ] || {
    echo "the runtime tree was not built" >&2
    exit 1
}

# A virtualenv records absolute paths in `pyvenv.cfg` and in the shebang of
# every console script. If any of them point outside the install root, the
# archive works only on the machine that built it — and the symptom on a host is
# `bad interpreter`, long after the download and the checksum both passed. This
# is the assertion that makes shipping such an archive impossible.
LAUNCHER="$TREE/hermes/.venv/bin/hermes"
[ -x "$LAUNCHER" ] || { echo "the Hermes launcher was not built" >&2; exit 1; }
SHEBANG=$(head -1 "$LAUNCHER")
case "$SHEBANG" in
    '#!/opt/asterism/'*) ;;
    *)
        echo "the Hermes launcher starts with '$SHEBANG'," >&2
        echo "which is not inside /opt/asterism; this archive is not relocatable" >&2
        exit 1
        ;;
esac
VENV_HOME=$(sed -n 's/^home = //p' "$TREE/hermes/.venv/pyvenv.cfg")
case "$VENV_HOME" in
    /opt/asterism/*) ;;
    *)
        echo "the virtualenv's interpreter is at '$VENV_HOME'," >&2
        echo "which is not inside /opt/asterism; this archive is not relocatable" >&2
        exit 1
        ;;
esac
echo "    launcher   $SHEBANG"
echo "    interpreter $VENV_HOME"

INSTALLED_BYTES=$(du -sb "$TREE" | cut -f1)
ARCHIVE_NAME="asterism-runtime-${VERSION}-linux-amd64.tar.gz"

echo "==> packing $ARCHIVE_NAME"
# Deterministic where tar allows it: sorted names, one fixed timestamp, numeric
# ownership, and gzip without its own timestamp. Two builds of the same revision
# then differ only where the inputs themselves are not reproducible, which the
# manifest states rather than hides.
tar \
    --sort=name \
    --mtime="@0" \
    --owner=0 --group=0 --numeric-owner \
    --format=gnu \
    -C /opt \
    -cf - asterism |
    gzip -9 -n > "$OUT/$ARCHIVE_NAME"

ARCHIVE_BYTES=$(stat -c %s "$OUT/$ARCHIVE_NAME")
ARCHIVE_SHA=$(sha256sum "$OUT/$ARCHIVE_NAME" | cut -d' ' -f1)

echo "==> writing the manifest"
cat > "$OUT/manifest.json" <<JSON
{
  "schema": 1,
  "product": "asterism-runtime",
  "version": "${VERSION}",
  "source_revision": "${REVISION}",
  "platform": "linux/amd64",
  "components": {
    "hermes": "${HERMES_VERSION}",
    "uv": "${UV_VERSION}",
    "python": "${PYTHON_VERSION}",
    "sqlite": "${OBSERVED_SQLITE}"
  },
  "runtime_image": "${HERMES_SOURCE_IMAGE}",
  "sqlite_journal_mode": "${JOURNAL_MODE:-unknown}",
  "archive": {
    "name": "${ARCHIVE_NAME}",
    "sha256": "${ARCHIVE_SHA}",
    "size_bytes": ${ARCHIVE_BYTES}
  },
  "installed_size_bytes": ${INSTALLED_BYTES},
  "install_root": "/opt/asterism"
}
JSON

# Named for what it covers, not just "the checksums". A GitHub release holds
# every artifact of a version in one flat namespace, and the Node binary
# release already publishes a `SHA256SUMS` there. Two files of that name on one
# release do not merge -- the second upload replaces the first, and whichever
# verification loses then reads checksums for the wrong artifact.
(cd "$OUT" && sha256sum "$ARCHIVE_NAME" manifest.json > SHA256SUMS.runtime)

echo "==> built"
printf '    revision   %s\n' "$REVISION"
printf '    archive    %s\n' "$ARCHIVE_NAME"
printf '    download   %s bytes\n' "$ARCHIVE_BYTES"
printf '    installed  %s bytes\n' "$INSTALLED_BYTES"
printf '    sha256     %s\n' "$ARCHIVE_SHA"
printf '    sqlite     %s (journal %s)\n' "$OBSERVED_SQLITE" "${JOURNAL_MODE:-unknown}"
