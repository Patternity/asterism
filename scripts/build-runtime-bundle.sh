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
# Needs root, Docker and the service account, which is why it belongs on a
# disposable runner rather than anywhere that matters.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
OUT=${1:?usage: build-runtime-bundle.sh <output-directory> <version>}
VERSION=${2:?usage: build-runtime-bundle.sh <output-directory> <version>}

STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT
mkdir -p "$OUT"

# The staging root stands in for `/`, and parts of the build run as the service
# account rather than as root: `build_hermes_env` drives uv through `runuser`.
# `mktemp -d` creates 0700 root, so without this every such step fails with
# "permission denied" on a path the account can read perfectly well on a host.
chmod 0755 "$STAGING"

# Sourced rather than run: `ASTERISM_INSTALL_LIB_ONLY` defines every function and
# every pinned constant without performing an installation. The constants are
# then read from the same place the build used them, so the manifest cannot
# describe a version the bundle does not contain.
export ASTERISM_PREFIX="$STAGING"
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

TREE="$STAGING/opt/asterism"
[ -d "$TREE" ] || {
    echo "the runtime tree was not built" >&2
    exit 1
}

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
    -C "$STAGING/opt" \
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
    "sqlite": "${SQLITE_TARGET_VERSION}"
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

(cd "$OUT" && sha256sum "$ARCHIVE_NAME" manifest.json > SHA256SUMS)

echo "==> built"
printf '    revision   %s\n' "$REVISION"
printf '    archive    %s\n' "$ARCHIVE_NAME"
printf '    download   %s bytes\n' "$ARCHIVE_BYTES"
printf '    installed  %s bytes\n' "$INSTALLED_BYTES"
printf '    sha256     %s\n' "$ARCHIVE_SHA"
printf '    sqlite     %s (journal %s)\n' "$SQLITE_TARGET_VERSION" "${JOURNAL_MODE:-unknown}"
