#!/usr/bin/env bash
#
# Check a runtime bundle before anything trusts it.
#
# Fails closed on every question it can ask: an unreadable manifest, a schema
# this build does not understand, another platform, a digest that does not match
# the bytes, or a checksum file that disagrees with the manifest. An archive that
# passes has been described by its own manifest and matches it; an archive that
# does not is refused rather than extracted and inspected afterwards.
#
#   scripts/verify-runtime-bundle.sh <directory>
set -euo pipefail

DIR=${1:?usage: verify-runtime-bundle.sh <directory>}
SUPPORTED_SCHEMA=1
EXPECTED_PLATFORM=linux/amd64

fail() { printf '  refused: %s\n' "$*" >&2; exit 1; }

[ -f "$DIR/manifest.json" ] || fail "no manifest"
[ -f "$DIR/SHA256SUMS.runtime" ] || fail "no checksum file"

# One parse, in a language that can actually parse JSON. Reading a manifest with
# `grep` is how a field ends up believed because it appeared in a comment.
read -r schema platform archive declared size revision <<EOF
$(python3 - "$DIR/manifest.json" <<'PY'
import json, sys
with open(sys.argv[1]) as handle:
    manifest = json.load(handle)
archive = manifest.get("archive", {})
print(
    manifest.get("schema", 0),
    manifest.get("platform", "?"),
    archive.get("name", "?"),
    archive.get("sha256", "?"),
    archive.get("size_bytes", -1),
    manifest.get("source_revision", "?"),
)
PY
)
EOF

[ "$schema" = "$SUPPORTED_SCHEMA" ] ||
  fail "bundle schema $schema is not supported by this build (expected $SUPPORTED_SCHEMA)"
[ "$platform" = "$EXPECTED_PLATFORM" ] ||
  fail "bundle is for $platform, not $EXPECTED_PLATFORM"
[ -f "$DIR/$archive" ] || fail "the manifest names $archive, which is not here"
case "$revision" in
  ""|"?"|unknown) fail "the manifest does not name the revision it was built from" ;;
esac

actual_size=$(stat -c %s "$DIR/$archive")
[ "$actual_size" = "$size" ] ||
  fail "the archive is $actual_size bytes, the manifest says $size"

actual_sha=$(sha256sum "$DIR/$archive" | cut -d' ' -f1)
[ "$actual_sha" = "$declared" ] ||
  fail "the archive does not match the digest its manifest declares"

# The checksum file and the manifest are written separately, so they are also
# checked against each other rather than only against the bytes.
( cd "$DIR" && sha256sum --quiet --check SHA256SUMS.runtime ) ||
  fail "the checksum file does not match what is here"

printf '  bundle verified\n'
printf '    revision   %s\n' "$revision"
printf '    archive    %s\n' "$archive"
printf '    sha256     %s\n' "$actual_sha"
printf '    size       %s bytes\n' "$actual_size"
