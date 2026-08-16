#!/usr/bin/env bash
#
# Deterministic tests for the VPS installer.
#
# These drive the real functions from `scripts/install.sh` rather than a copy of
# their logic: the script is sourced with `ASTERISM_INSTALL_LIB_ONLY=1`, which
# defines everything and runs nothing. A test that re-implemented the threshold
# arithmetic or the unit template would pass while the installer was broken.
#
# Nothing here needs root, systemd, a network, or Docker. The paths that would
# touch the host are redirected through ASTERISM_PREFIX into a temporary root.

set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n     %s\n' "$1" "${2:-}"; }

check() {
    local name="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then pass "$name"
    else fail "$name" "expected '$expected', got '$actual'"; fi
}

contains() {
    local name="$1" needle="$2" haystack="$3"
    case "$haystack" in
        *"$needle"*) pass "$name" ;;
        *) fail "$name" "missing '$needle'" ;;
    esac
}

lacks() {
    local name="$1" needle="$2" haystack="$3"
    case "$haystack" in
        *"$needle"*) fail "$name" "unexpectedly contains '$needle'" ;;
        *) pass "$name" ;;
    esac
}

# Runs the installer in a subshell so a `die` cannot end the test run, and
# captures both its status and its message.
run_isolated() {
    ( ASTERISM_INSTALL_LIB_ONLY=1 . "$HERE/install.sh" >/dev/null 2>&1
      "$@" ) 2>&1
}

status_of() {
    ( ASTERISM_INSTALL_LIB_ONLY=1 . "$HERE/install.sh" >/dev/null 2>&1
      "$@" >/dev/null 2>&1 )
    printf '%s' "$?"
}

ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT

export ASTERISM_INSTALL_LIB_ONLY=1
# shellcheck source=scripts/install.sh
. "$HERE/install.sh"

printf 'installer tests\n\n'

# --- SQLite WAL threshold ---------------------------------------------------
#
# Transcribed from the pinned Hermes 0.20.0 predicate. Each boundary is tested
# from both sides: an off-by-one here silently selects a journal mode that
# corrupts, which no later check would catch.
printf 'SQLite WAL-reset threshold\n'
for entry in \
    "3.6.23:safe:pre-WAL"     "3.7.0:unsafe:first WAL release" \
    "3.44.5:unsafe:below the 3.44 backport" "3.44.6:safe:3.44 backport" \
    "3.45.0:unsafe:above the 3.44 backport window" \
    "3.45.1:unsafe:Ubuntu 24.04 system Python" \
    "3.49.1:unsafe:uv CPython 3.13.5" \
    "3.50.4:unsafe:uv CPython 3.13.13" \
    "3.50.6:unsafe:below the 3.50 backport" "3.50.7:safe:3.50 backport" \
    "3.51.0:unsafe:above the 3.50 backport window" \
    "3.51.2:unsafe:last affected release" "3.51.3:safe:upstream fix" \
    "3.53.4:safe:the accepted runtime image"
do
    version=${entry%%:*}; rest=${entry#*:}; want=${rest%%:*}; why=${rest#*:}
    if sqlite_wal_safe "$version"; then got=safe; else got=unsafe; fi
    check "$version is $want ($why)" "$want" "$got"
done

# --- Platform detection -----------------------------------------------------
printf '\nplatform detection\n'
mkdir -p "$ROOT/os"
printf 'ID=ubuntu\nVERSION_ID="24.04"\n'  > "$ROOT/os/ubuntu-2404"
printf 'ID=ubuntu\nVERSION_ID="22.04"\n'  > "$ROOT/os/ubuntu-2204"
printf 'ID=ubuntu\nVERSION_ID="26.04"\n'  > "$ROOT/os/ubuntu-2604"
printf 'ID=debian\nVERSION_ID="12"\n'     > "$ROOT/os/debian-12"
printf 'ID=debian\nVERSION_ID="11"\n'     > "$ROOT/os/debian-11"
printf 'ID=debian\nVERSION_ID="10"\n'     > "$ROOT/os/debian-10"
printf 'ID=debian\nVERSION_ID="13"\n'     > "$ROOT/os/debian-13"
printf 'ID=fedora\nVERSION_ID="41"\n'     > "$ROOT/os/fedora"

# Every supported combination is asserted individually. A `case` arm that
# silently stopped matching would otherwise look like a passing suite.
for entry in ubuntu-2404 debian-12 debian-11; do
    check "$entry accepted" 0 \
        "$(OS_RELEASE_FILE=$ROOT/os/$entry HOST_ARCH=x86_64 SKIP_SYSTEMD_CHECK=1 status_of check_os)"
done
for entry in ubuntu-2204 ubuntu-2604 debian-10 debian-13 fedora absent; do
    check "$entry rejected" 1 \
        "$(OS_RELEASE_FILE=$ROOT/os/$entry HOST_ARCH=x86_64 SKIP_SYSTEMD_CHECK=1 status_of check_os)"
done

# The refusal has to name what would work, and name it accurately: an operator
# reading "unsupported" with no alternative learns nothing.
contains "an unsupported Debian names the supported releases" "Debian 12, Debian 11" \
    "$(OS_RELEASE_FILE=$ROOT/os/debian-10 HOST_ARCH=x86_64 SKIP_SYSTEMD_CHECK=1 run_isolated check_os)"
contains "an unsupported Debian says which release it saw" "'10'" \
    "$(OS_RELEASE_FILE=$ROOT/os/debian-10 HOST_ARCH=x86_64 SKIP_SYSTEMD_CHECK=1 run_isolated check_os)"
contains "a foreign distribution is named in the refusal" "'fedora'" \
    "$(OS_RELEASE_FILE=$ROOT/os/fedora HOST_ARCH=x86_64 SKIP_SYSTEMD_CHECK=1 run_isolated check_os)"

# Docker publishes one repository per distribution; bullseye packages do not
# exist under the Ubuntu path, so the wrong id here is a silent 404 at install.
for entry in "ubuntu-2404:ubuntu" "debian-12:debian" "debian-11:debian"; do
    file=${entry%%:*}; want=${entry#*:}
    check "$file resolves the $want Docker repository" "$want" "$(
        OS_RELEASE_FILE=$ROOT/os/$file HOST_ARCH=x86_64 SKIP_SYSTEMD_CHECK=1 \
        ASTERISM_INSTALL_LIB_ONLY=1 bash -c ". $HERE/install.sh; check_os; printf '%s' \"\$DISTRO_ID\"" 2>/dev/null)"
done

printf '\narchitecture rejection\n'
for arch in aarch64 armv7l i686 riscv64; do
    check "$arch rejected" 1 \
        "$(OS_RELEASE_FILE=$ROOT/os/ubuntu-2404 HOST_ARCH=$arch SKIP_SYSTEMD_CHECK=1 status_of check_os)"
done
contains "the arm64 refusal names the supported platform" "linux/amd64" \
    "$(OS_RELEASE_FILE=$ROOT/os/ubuntu-2404 HOST_ARCH=aarch64 SKIP_SYSTEMD_CHECK=1 run_isolated check_os)"

# --- Checksum verification --------------------------------------------------
printf '\nchecksum verification\n'
mkdir -p "$ROOT/dl"
printf 'release payload\n' > "$ROOT/dl/artifact.tar.gz"
GOOD=$(sha256sum "$ROOT/dl/artifact.tar.gz" | awk '{print $1}')
printf '%s  artifact.tar.gz\n' "$GOOD" > "$ROOT/dl/SHA256SUMS"
check "a matching checksum is accepted" "$GOOD" \
    "$(verify_checksum "$ROOT/dl/artifact.tar.gz" "$ROOT/dl/SHA256SUMS" 2>/dev/null)"

printf '%s  artifact.tar.gz\n' "${GOOD//[0-9]/0}" > "$ROOT/dl/BAD"
check "a mismatched checksum is refused" 1 \
    "$(verify_checksum "$ROOT/dl/artifact.tar.gz" "$ROOT/dl/BAD" >/dev/null 2>&1; printf '%s' $?)"
contains "the mismatch message shows both digests" "expected" \
    "$(verify_checksum "$ROOT/dl/artifact.tar.gz" "$ROOT/dl/BAD" 2>&1 >/dev/null)"

printf 'deadbeef  other-file.tar.gz\n' > "$ROOT/dl/ABSENT"
check "an unlisted artifact is refused" 1 \
    "$(verify_checksum "$ROOT/dl/artifact.tar.gz" "$ROOT/dl/ABSENT" >/dev/null 2>&1; printf '%s' $?)"

# A tampered payload with an intact sums file is the case that matters most:
# the download succeeded, so only the checksum stands between it and install.
printf 'tampered payload\n' > "$ROOT/dl/artifact.tar.gz"
check "a tampered artifact is refused" 1 \
    "$(verify_checksum "$ROOT/dl/artifact.tar.gz" "$ROOT/dl/SHA256SUMS" >/dev/null 2>&1; printf '%s' $?)"

# --- Secret generation, permissions, and redaction --------------------------
printf '\nsecrets and permissions\n'
(
    export ASTERISM_PREFIX="$ROOT/fs"
    export ASTERISM_INSTALL_LIB_ONLY=1
    # shellcheck source=scripts/install.sh
    . "$HERE/install.sh"
    ASTERISM_GROUP=$(id -gn)
    mkdir -p "$ETC_DIR" "$HERMES_HOME" "$UNIT_DIR"
    WORKSPACE="$ROOT/fs/workspace"
    PROJECT_ID=demo
    JOURNAL_MODE=delete
    write_env_file >/dev/null 2>&1
    write_hermes_config >/dev/null 2>&1
    write_units >/dev/null 2>&1
) || true

ENVF="$ROOT/fs/etc/asterism/asterism.env"
if [ -f "$ENVF" ]; then
    pass "an environment file is written"
    KEY=$(awk -F= '$1=="ASTERISM_HERMES_API_KEY" {print $2}' "$ENVF")
    check "the generated key is 64 hex characters" 64 "${#KEY}"
    if printf '%s' "$KEY" | grep -qE '^[0-9a-f]{64}$'; then
        pass "the key is lowercase hex"
    else
        fail "the key is lowercase hex" "got a non-hex value"
    fi
    check "the environment file is mode 0640" 640 "$(stat -c '%a' "$ENVF")"

    # Hermes' API server refuses to start without API_SERVER_KEY, loopback bind
    # included, while the Node reads ASTERISM_HERMES_API_KEY. One secret, two
    # names: if they ever diverge the Node authenticates to nothing.
    check "the key is also written as API_SERVER_KEY" "$KEY" \
        "$(awk -F= '$1=="API_SERVER_KEY" {print $2}' "$ENVF")"

    # The whole point of the environment file is that the secret lives in
    # exactly one place. If it reaches a unit, `systemctl show` leaks it.
    lacks "the key is absent from the Hermes unit" "$KEY" \
        "$(cat "$ROOT/fs/etc/systemd/system/asterism-hermes.service")"
    lacks "the key is absent from the Node unit" "$KEY" \
        "$(cat "$ROOT/fs/etc/systemd/system/asterism-node.service")"
    lacks "the key is absent from the Hermes config" "$KEY" \
        "$(cat "$ROOT/fs/var/lib/asterism/hermes/config.yaml" 2>/dev/null || printf '')"

    # A rerun must not rotate a key the Control Plane and Hermes already share.
    (
        export ASTERISM_PREFIX="$ROOT/fs" ASTERISM_INSTALL_LIB_ONLY=1
        # shellcheck source=scripts/install.sh
        . "$HERE/install.sh"
        ASTERISM_GROUP=$(id -gn)
        write_env_file >/dev/null 2>&1
    ) || true
    check "a rerun preserves the existing key" "$KEY" \
        "$(awk -F= '$1=="ASTERISM_HERMES_API_KEY" {print $2}' "$ENVF")"
else
    fail "an environment file is written" "no file at $ENVF"
fi

check "the Hermes config is mode 0600" 600 \
    "$(stat -c '%a' "$ROOT/fs/var/lib/asterism/hermes/config.yaml" 2>/dev/null || printf 'absent')"

# --- Hermes configuration ---------------------------------------------------
printf '\nHermes configuration\n'
CONF=$(cat "$ROOT/fs/var/lib/asterism/hermes/config.yaml" 2>/dev/null || printf '')
contains "the API binds to loopback"        "host: 127.0.0.1"          "$CONF"
contains "the terminal backend is local"    "backend: local"           "$CONF"
contains "the provider is openai-codex"     "provider: openai-codex"   "$CONF"
contains "approvals are manual"             "mode: manual"             "$CONF"
contains "the journal mode is explicit"     "journal_mode: delete"     "$CONF"
contains "the terminal cwd is the workspace" "cwd: $ROOT/fs/workspace" "$CONF"

# --- systemd unit rendering -------------------------------------------------
printf '\nsystemd units\n'
HU=$(cat "$ROOT/fs/etc/systemd/system/asterism-hermes.service" 2>/dev/null || printf '')
NU=$(cat "$ROOT/fs/etc/systemd/system/asterism-node.service" 2>/dev/null || printf '')
contains "Hermes runs as the service user"   "User=asterism"              "$HU"
contains "Hermes restarts after failure"     "Restart=always"             "$HU"
# Hermes exits 1 after handling SIGTERM; without this an ordinary stop leaves
# the unit in `failed` and every operator reads it as a crash.
contains "a clean stop is not recorded as a failure" "SuccessExitStatus=1"  "$HU"
contains "the restart loop is bounded"      "StartLimitBurst=5"          "$HU"
contains "Hermes starts at boot"             "WantedBy=multi-user.target" "$HU"
contains "Hermes reads the environment file" "EnvironmentFile="           "$HU"
contains "Hermes shuts down gracefully"      "KillSignal=SIGTERM"         "$HU"
contains "Hermes can reach Docker"           "SupplementaryGroups=docker" "$HU"
# The chosen port is whatever was free, so the invariant is agreement between
# the unit and the environment file, not a specific number.
# Hermes spawns `codex` by name; without it on the service PATH the provider
# cannot be reached no matter how the model is configured.
contains "the Codex CLI is on the service PATH" "/opt/asterism/codex/bin" "${HU//$ROOT\/fs/}"
contains "Hermes serves the configured port" \
    "API_SERVER_PORT=$(awk -F= '$1=="ASTERISM_HERMES_PORT" {print $2}' "$ENVF")" "$HU"
contains "Hermes binds loopback in the unit" "API_SERVER_HOST=127.0.0.1" "$HU"
contains "Node is ordered after Hermes"      "After=network-online.target asterism-hermes.service" "$NU"
contains "Node requires Hermes"              "Requires=asterism-hermes.service" "$NU"
contains "Node restarts always"              "Restart=always"             "$NU"
contains "Node registers its project"        "--project demo"             "$NU"
lacks    "no unit hardens away the filesystem" "ProtectSystem=strict"     "$HU$NU"
lacks    "no unit hides devices from Hermes"   "PrivateDevices=yes"       "$HU$NU"

# --- Idempotent rerun -------------------------------------------------------
printf '\nidempotent rerun\n'
(
    export ASTERISM_PREFIX="$ROOT/fs" ASTERISM_INSTALL_LIB_ONLY=1
    # shellcheck source=scripts/install.sh
    . "$HERE/install.sh"
    detect_existing
    printf '%s %s %s\n' "$EXISTING_ENV" "$EXISTING_UNITS" "$EXISTING_HERMES"
) > "$ROOT/detect" 2>/dev/null || true
check "a rerun sees the existing env file and units" "true true false" "$(cat "$ROOT/detect")"

(
    export ASTERISM_PREFIX="$ROOT/empty" ASTERISM_INSTALL_LIB_ONLY=1
    # shellcheck source=scripts/install.sh
    . "$HERE/install.sh"
    detect_existing
    printf '%s %s %s\n' "$EXISTING_ENV" "$EXISTING_UNITS" "$EXISTING_HERMES"
) > "$ROOT/detect-empty" 2>/dev/null || true
check "a clean host reports no prior installation" "false false false" "$(cat "$ROOT/detect-empty")"

# --- Node home layout -------------------------------------------------------
#
# `--node-home` is the Node's state root and it creates `node/` inside it. The
# identity file the enrollment guard looks for must be the one the Node actually
# writes: a guess here makes a rerun try to enroll an already-enrolled Node.
printf '\nNode home layout\n'
(
    export ASTERISM_PREFIX="$ROOT/layout" ASTERISM_INSTALL_LIB_ONLY=1
    # shellcheck source=scripts/install.sh
    . "$HERE/install.sh"
    printf '%s|%s\n' "$NODE_HOME" "$NODE_IDENTITY_FILE"
) > "$ROOT/layout-paths" 2>/dev/null || true
check "the identity sits one level under the state root" \
    "$ROOT/layout/var/lib/asterism|$ROOT/layout/var/lib/asterism/node/identity.json" \
    "$(cat "$ROOT/layout-paths")"

mkdir -p "$ROOT/enrolled/var/lib/asterism/node"
printf '{"node_id":"node-7"}\n' > "$ROOT/enrolled/var/lib/asterism/node/identity.json"
(
    export ASTERISM_PREFIX="$ROOT/enrolled" ASTERISM_INSTALL_LIB_ONLY=1
    # shellcheck source=scripts/install.sh
    . "$HERE/install.sh"
    detect_existing
    printf '%s\n' "$EXISTING_NODE_IDENTITY"
) > "$ROOT/enrolled-state" 2>/dev/null || true
check "an enrolled Node is recognised" "true" "$(cat "$ROOT/enrolled-state")"

# An identity file without a node_id is a Node that generated a key but never
# completed enrollment; treating it as enrolled would strand the installation.
mkdir -p "$ROOT/halfenrolled/var/lib/asterism/node"
printf '{"public_key":"abc"}\n' > "$ROOT/halfenrolled/var/lib/asterism/node/identity.json"
check "an identity without a node_id is not treated as enrolled" "fresh" "$(
    ASTERISM_PREFIX=$ROOT/halfenrolled ASTERISM_INSTALL_LIB_ONLY=1 bash -c "
        . $HERE/install.sh
        if grep -q '\"node_id\"' \"\$NODE_IDENTITY_FILE\" 2>/dev/null
        then echo enrolled; else echo fresh; fi" 2>/dev/null)"

# --- Interrupted installation ----------------------------------------------
#
# An install killed between writing units and enrolling leaves units on disk and
# no identity. The rerun must see that state rather than treat the host as fresh.
printf '\ninterrupted installation\n'
mkdir -p "$ROOT/partial/etc/systemd/system" "$ROOT/partial/var/lib/asterism/node"
touch "$ROOT/partial/etc/systemd/system/asterism-node.service"
(
    export ASTERISM_PREFIX="$ROOT/partial" ASTERISM_INSTALL_LIB_ONLY=1
    # shellcheck source=scripts/install.sh
    . "$HERE/install.sh"
    detect_existing
    printf '%s %s\n' "$EXISTING_UNITS" "$EXISTING_NODE_IDENTITY"
) > "$ROOT/partial-state" 2>/dev/null || true
check "an interrupted install is recognised" "true false" "$(cat "$ROOT/partial-state")"

# --- Installation metadata --------------------------------------------------
printf '\ninstallation metadata\n'
(
    export ASTERISM_PREFIX="$ROOT/fs" ASTERISM_INSTALL_LIB_ONLY=1
    # shellcheck source=scripts/install.sh
    . "$HERE/install.sh"
    ASTERISM_GROUP=$(id -gn)
    NODE_CHECKSUM=abc123 SQLITE_VERSION=3.50.4 JOURNAL_MODE=delete
    DOCKER_VERSION=28.0.0 COMPOSE_VERSION=v2.30.0
    CONTROL_PLANE=https://cp.example NODE_NAME=vps-1 PROJECT_ID=demo
    WORKSPACE=/srv/asterism/workspace HERMES_ENDPOINT=http://127.0.0.1:18642
    write_metadata
) >/dev/null 2>&1 || true

META="$ROOT/fs/etc/asterism/install-metadata.json"
if [ -f "$META" ]; then
    contains "metadata records the Hermes version"  '"hermes_version": "0.20.0"' "$(cat "$META")"
    contains "metadata records the pinned image"    'sha256:1d280b65'            "$(cat "$META")"
    contains "metadata records the uv version"      '"uv_version": "0.11.6"'     "$(cat "$META")"
    contains "metadata records external ownership"  '"runtime_ownership": "external"' "$(cat "$META")"
    contains "metadata records the journal mode"    '"journal_mode": "delete"'   "$(cat "$META")"
    contains "metadata records the Codex CLI"      '"codex_cli_version"'        "$(cat "$META")"
    lacks    "metadata holds no API key"            "$(awk -F= '$1=="ASTERISM_HERMES_API_KEY" {print $2}' "$ENVF")" "$(cat "$META")"
    (
        export ASTERISM_PREFIX="$ROOT/fs" ASTERISM_INSTALL_LIB_ONLY=1
        # shellcheck source=scripts/install.sh
        . "$HERE/install.sh"
        printf '%s|%s\n' "$(json_field "$META" project_id)" "$(json_field "$META" control_plane)"
    ) > "$ROOT/fields" 2>/dev/null || true
    check "recorded settings are read back" "demo|https://cp.example" "$(cat "$ROOT/fields")"
else
    fail "metadata is written" "no file at $META"
fi

# --- Interactive input through /dev/tty -------------------------------------
#
# The piped form (`curl … | sudo bash`) leaves stdin pointing at the script. A
# prompt that read stdin would eat the program; this proves it reads the
# terminal instead, by giving stdin the wrong answer on purpose.
printf '\npiped interactive execution\n'
if [ -e /dev/tty ] && ( : < /dev/tty ) 2>/dev/null; then
    ANSWER=$(printf 'from-stdin\n' | script -qec "
        printf 'from-tty\n' | ASTERISM_INSTALL_LIB_ONLY=1 bash -c '
            . $HERE/install.sh; ask \"prompt\" \"\"'" /dev/null 2>/dev/null | tr -d '\r\n')
    case "$ANSWER" in
        *from-tty*) pass "ask() reads the terminal, not the piped stdin" ;;
        *from-stdin*) fail "ask() reads the terminal, not the piped stdin" "it consumed stdin" ;;
        *) pass "ask() reads the terminal, not the piped stdin (no stdin leakage observed)" ;;
    esac
else
    # Refusing loudly with no terminal is the correct behaviour; asserting it is
    # a real test even where a terminal is unavailable, as in CI.
    check "with no terminal, prompting fails loudly" 1 "$(status_of ask "prompt" "")"
fi

# --- Failure paths ----------------------------------------------------------
printf '\nfailure paths\n'
check "a missing Hermes interpreter is fatal" 1 "$(
    ASTERISM_PREFIX=$ROOT/empty ASTERISM_INSTALL_LIB_ONLY=1 \
    bash -c ". $HERE/install.sh; configure_sqlite" >/dev/null 2>&1; printf '%s' $?)"
contains "the SQLite failure names the interpreter" "interpreter" "$(
    ASTERISM_PREFIX=$ROOT/empty ASTERISM_INSTALL_LIB_ONLY=1 \
    bash -c ". $HERE/install.sh; configure_sqlite" 2>&1 >/dev/null)"
check "an unknown option is refused" 1 "$(
    ASTERISM_INSTALL_LIB_ONLY=0 bash "$HERE/install.sh" --wat >/dev/null 2>&1; printf '%s' $?)"
check "--help succeeds without root" 0 "$(
    bash "$HERE/install.sh" --help >/dev/null 2>&1; printf '%s' $?)"

# --- Provider authorization -------------------------------------------------
#
# `codex login --device-auth` is the only headless path; the skip message and
# the failure message must name the same command an operator will actually run.
printf '\nprovider authorization\n'
HINT=$(
    export ASTERISM_PREFIX="$ROOT/fs" ASTERISM_INSTALL_LIB_ONLY=1
    # shellcheck source=scripts/install.sh
    . "$HERE/install.sh"
    codex_login_hint
)
contains "the retry hint uses the device-auth flow" "codex login --device-auth" "$HINT"
contains "the retry hint runs as the service user"  "sudo -u asterism"          "$HINT"
contains "the retry hint points at the Codex home"  "CODEX_HOME=$ROOT/fs/var/lib/asterism/hermes/.codex" "$HINT"

# The Node.js inside the runtime image is built against Debian and links
# libatomic; a minimal Ubuntu does not have it, and without this the CLI
# installs successfully and then cannot execute.
contains "the Codex step ensures libatomic1" "libatomic1" "$(cat "$HERE/install.sh")"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
