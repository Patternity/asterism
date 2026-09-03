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
# Transcribed from the pinned Hermes 0.20.3 predicate. Each boundary is tested
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

# --- SQLite provisioning ----------------------------------------------------
#
# The installer no longer accepts whatever SQLite the interpreter happens to
# link. These assert the parts that are pure logic; the compile itself needs
# Docker and is exercised by running the installer.
printf '\nSQLite provisioning\n'

check "the pinned target is past the WAL-reset bug" "safe" \
    "$(if sqlite_wal_safe "$SQLITE_TARGET_VERSION"; then printf safe; else printf unsafe; fi)"

check "the pinned interpreter's own SQLite is not" "unsafe" \
    "$(if sqlite_wal_safe 3.50.4; then printf safe; else printf unsafe; fi)"

contains "both build inputs are pinned by sha256" "SQLITE_AMALGAMATION_SHA256" \
    "$(cat "$HERE/install.sh")"
contains "the pysqlite3 sdist is pinned by sha256" "PYSQLITE3_SDIST_SHA256" \
    "$(cat "$HERE/install.sh")"
contains "the build image is pinned by digest" "python@sha256:" \
    "$(cat "$HERE/install.sh")"

# A wheel compiled on a newer base would not load on the oldest supported
# platform. The digest cannot state its own glibc, so the floor it was chosen
# for is recorded beside the pin and asserted here.
contains "the builder pin records the glibc floor it was chosen for" \
    "Debian 11 (glibc 2.31)" "$(cat "$HERE/install.sh")"
contains "that floor is a platform the installer supports" "Debian 11" \
    "$(ASTERISM_INSTALL_LIB_ONLY=0 bash "$HERE/install.sh" --help 2>&1)"

# `sitecustomize` is a single module name: a dependency shipping its own would
# shadow the shim silently. A .pth cannot be shadowed that way.
contains "the shim is delivered as a .pth, not sitecustomize" ".pth" "$SQLITE_SHIM_PTH"
lacks "the shim does not rely on sitecustomize" "sitecustomize" "$SQLITE_SHIM_PTH"

# The .pth must contain exactly one executable import line; site.py only runs
# lines that begin with `import`.
SHIM_SITE=$ROOT/site
mkdir -p "$SHIM_SITE"
( ASTERISM_USER=$(id -un) ASTERISM_GROUP=$(id -gn) write_sqlite_shim "$SHIM_SITE" )
check "the .pth is a single import line" "import $SQLITE_SHIM_MODULE" \
    "$(cat "$SHIM_SITE/$SQLITE_SHIM_PTH")"
contains "the shim module aliases sqlite3" 'sys.modules["sqlite3"] = pysqlite3' \
    "$(cat "$SHIM_SITE/$SQLITE_SHIM_MODULE.py")"
contains "the shim restores autocommit" "def autocommit" \
    "$(cat "$SHIM_SITE/$SQLITE_SHIM_MODULE.py")"
# Calling the rebound connect must not re-enter itself.
contains "the shim captures connect before rebinding it" "_connect_original = pysqlite3.dbapi2.connect" \
    "$(cat "$SHIM_SITE/$SQLITE_SHIM_MODULE.py")"
# A shim that raises would stop Hermes from starting at all.
contains "an unimportable driver leaves sqlite3 alone" "except Exception" \
    "$(cat "$SHIM_SITE/$SQLITE_SHIM_MODULE.py")"

if command -v python3 >/dev/null 2>&1; then
    check "the shim module is valid Python" 0 \
        "$(python3 -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" \
            "$SHIM_SITE/$SQLITE_SHIM_MODULE.py" >/dev/null 2>&1; printf '%s' $?)"
    # With no pysqlite3 installed the shim must be inert, not fatal.
    check "the shim is inert without pysqlite3" 0 \
        "$(PYTHONPATH="$SHIM_SITE" python3 -c "import $SQLITE_SHIM_MODULE, sqlite3; sqlite3.connect(':memory:').close()" \
            >/dev/null 2>&1; printf '%s' $?)"
fi

( remove_sqlite_shim "$SHIM_SITE" )
check "removing the shim takes the module with it" "gone" \
    "$([ -e "$SHIM_SITE/$SQLITE_SHIM_MODULE.py" ] && printf present || printf gone)"
check "removing the shim takes the .pth with it" "gone" \
    "$([ -e "$SHIM_SITE/$SQLITE_SHIM_PTH" ] && printf present || printf gone)"

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
# Preflight reports the platform it found, not the one the script was first
# written for. Getting this wrong tells a Debian operator they are on Ubuntu.
printf 'ID=debian\nVERSION_ID="11"\nPRETTY_NAME="Debian GNU/Linux 11 (bullseye)"\n' > "$ROOT/os/debian-11-pretty"
check "preflight names the platform it found" "Debian GNU/Linux 11 (bullseye)" "$(
    OS_RELEASE_FILE=$ROOT/os/debian-11-pretty ASTERISM_INSTALL_LIB_ONLY=1 \
    bash -c ". $HERE/install.sh; platform_description" 2>/dev/null)"
check "preflight falls back to id and version" "ubuntu 24.04" "$(
    OS_RELEASE_FILE=$ROOT/os/ubuntu-2404 ASTERISM_INSTALL_LIB_ONLY=1 \
    bash -c ". $HERE/install.sh; platform_description" 2>/dev/null)"

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

# --- The installed binary must actually run ---------------------------------
#
# A checksum proves the bytes arrived intact and nothing more. The released
# binary is linked against a libc floor, and one built too high installs
# perfectly and then fails at every invocation — which is exactly how a Debian
# host once ended up with a "successfully installed" Node that could not start.
printf '\nthe installed binary is executed once\n'
contains "install_node_binary runs the binary it installed" '"$NODE_BIN" --version' \
    "$(cat "$HERE/install.sh")"
contains "a binary that cannot run is fatal" "cannot run on this host" \
    "$(cat "$HERE/install.sh")"
lacks "a failed version probe is never reported as cosmetic" "version unavailable" \
    "$(cat "$HERE/install.sh")"

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

# --- The Node must be allowed the escalation it is designed around -----------
#
# The Node supervises one systemd unit per project and reaches systemd through
# the narrow sudoers rule in /etc/sudoers.d/asterism-node. NoNewPrivileges makes
# every setuid binary inert for the process and its children, so a Node unit
# carrying it cannot run sudo at all: sudo answers "effective uid is not 0",
# every project worker fails before it starts, and the operator is left with
# profile_worker_start_failed. This shipped once and reached production, where
# it meant no project could be provisioned at all.
#
# ProtectKernelTunables is checked for the same reason and is the harder half:
# systemd implies NoNewPrivileges from it, so it forbids the escalation just as
# completely while reading like an unrelated hardening choice, and
# `systemctl show -p NoNewPrivileges` still answers `no`. Removing only the
# explicit directive leaves the Node exactly as broken.
printf '\nworker supervision\n'
NODE_SERVICE=$(cat "$ROOT/fs/etc/systemd/system/asterism-node.service" 2>/dev/null || printf '')

# The units are written through unquoted heredocs, so a backtick in a comment is
# not punctuation: it runs, as root, during installation, and leaves a hole where
# the words were. Production carried `# as a failed unit after an ordinary .`
# for exactly this reason, and the installer ran a bare `systemctl stop` each
# time it wrote that unit.
for unit in asterism-node asterism-hermes; do
    check "the $unit unit has no hole left by an executed backtick" 0 \
        "$(grep -cE 'ordinary \.|answers ,|`` ' "$ROOT/fs/etc/systemd/system/$unit.service" 2>/dev/null)"
done
check "no heredoc in the installer runs a command it meant to quote" 0 \
    "$(awk '/<<EOF/ { inhd = 1; next } /^EOF$/ { inhd = 0 }
            inhd && /[^\\]`/ { hits++ } END { print hits + 0 }' "$HERE/install.sh")"
for directive in NoNewPrivileges ProtectKernelTunables; do
    check "the Node unit sets no $directive directive" 0 \
        "$(printf '%s\n' "$NODE_SERVICE" | grep -c "^$directive")"
done
# Allowing the escalation must not become running the daemon as root: the
# sudoers rule is the boundary, and it only means anything while the Node is
# an ordinary user.
contains "the Node still runs as the service user" "User=asterism" "$NODE_SERVICE"

# Hermes escalates nothing of its own, so its hardening stays as it was.
HERMES_SERVICE=$(cat "$ROOT/fs/etc/systemd/system/asterism-hermes.service" 2>/dev/null || printf '')
for directive in NoNewPrivileges=yes ProtectKernelTunables=yes; do
    check "the Hermes unit keeps $directive" 1 \
        "$(printf '%s\n' "$HERMES_SERVICE" | grep -c "^$directive")"
done

# --- Multi-project prerequisites --------------------------------------------
#
# Everything the Node needs before it can create a project: two state roots, the
# worker template and the sudo rule that lets it start an instance. These were
# installed by hand on the first production host, which is why a fresh
# installation could reach `ready` and then fail every provisioning attempt.
#
# The boundary these tests actually cross is stated where it matters. Contents,
# modes, idempotency, rejection and conflict handling are exercised for real
# against a temporary root. Ownership is exercised as ownership-setting, but the
# owner is root only when the suite itself runs as root; `visudo -cf` and
# `systemd-analyze verify` are the real thing wherever they are installed.
printf '\nmulti-project prerequisites\n'

# Sourcing install.sh brought its `set -e` into this suite, so every capture of a
# run that is meant to fail is written `|| true`. Without it the first refusal
# test would end the suite instead of being asserted.
PREREQ_USER=$(id -un)
PREREQ_GROUP=$(id -gn)

# Drives the installer's own function against a throwaway root, the same way the
# other sections drive write_units.
prereq_run() {
    (
        export ASTERISM_PREFIX="$1" ASTERISM_INSTALL_LIB_ONLY=1
        export ASTERISM_USER="${2:-$PREREQ_USER}"
        # shellcheck source=scripts/install.sh
        . "$HERE/install.sh"
        ASTERISM_GROUP=$PREREQ_GROUP
        install_project_prerequisites
    ) 2>&1
}

prereq_guard() {
    (
        export ASTERISM_PREFIX="$1" ASTERISM_INSTALL_LIB_ONLY=1
        export ASTERISM_USER="$PREREQ_USER"
        # shellcheck source=scripts/install.sh
        . "$HERE/install.sh"
        ASTERISM_GROUP=$PREREQ_GROUP
        # The failure count is the answer, so it is captured rather than allowed
        # to end this subshell through the inherited `set -e`.
        status=0
        check_project_prerequisites >/dev/null 2>&1 || status=$?
        printf '%s' "$status"
    )
}

meta() { stat -c '%U:%G %a' "$1" 2>/dev/null || printf 'absent'; }

# --- A clean installation gets every prerequisite ---------------------------
CLEAN=$ROOT/clean
prereq_run "$CLEAN" >/dev/null 2>&1
for path in \
    var/lib/asterism/projects \
    var/lib/asterism/hermes-projects \
    etc/systemd/system/asterism-hermes@.service \
    etc/sudoers.d/asterism-node
do
    check "a clean install creates $path" "present" \
        "$([ -e "$CLEAN/$path" ] && printf present || printf absent)"
done

check "the worker policy is $PREREQ_USER:$PREREQ_GROUP 440" "$PREREQ_USER:$PREREQ_GROUP 440" \
    "$(meta "$CLEAN/etc/sudoers.d/asterism-node")"
check "the worker template is $PREREQ_USER:$PREREQ_GROUP 644" "$PREREQ_USER:$PREREQ_GROUP 644" \
    "$(meta "$CLEAN/etc/systemd/system/asterism-hermes@.service")"
for path in var/lib/asterism/projects var/lib/asterism/hermes-projects; do
    check "$path is owner-only 700" "$PREREQ_USER:$PREREQ_GROUP 700" "$(meta "$CLEAN/$path")"
done

# Ownership by root is what the installer asks for; only a root test run can
# observe it. Said plainly rather than implied by a passing assertion.
if [ "$(id -u)" = 0 ]; then
    check "running as root, the policy is owned by root" "root:root 440" \
        "$(meta "$CLEAN/etc/sudoers.d/asterism-node")"
else
    printf '  note  root ownership not exercised: this suite is running as %s\n' "$PREREQ_USER"
fi

# --- One policy, one template: the packaged artifacts are the specification --
#
# The installer is fetched on its own with no checkout, so it carries these
# files inline. That is only safe while the inline copy and the packaged copy
# cannot drift, which is what these two assertions are for.
PACKAGED=$(cd "$HERE/.." && pwd)
RENDERED=$ROOT/rendered
mkdir -p "$RENDERED"
(
    export ASTERISM_PREFIX='' ASTERISM_INSTALL_LIB_ONLY=1 ASTERISM_USER=asterism
    # shellcheck source=scripts/install.sh
    . "$HERE/install.sh"
    ASTERISM_GROUP=asterism
    render_worker_unit > "$RENDERED/asterism-hermes@.service"
    render_worker_sudoers > "$RENDERED/asterism-node"
) >/dev/null 2>&1
check "the installed template is the packaged template" "same" \
    "$(cmp -s "$RENDERED/asterism-hermes@.service" \
        "$PACKAGED/packaging/systemd/asterism-hermes@.service" && printf same || printf different)"
check "the installed policy is the packaged policy" "same" \
    "$(cmp -s "$RENDERED/asterism-node" \
        "$PACKAGED/packaging/sudoers/asterism-node" && printf same || printf different)"

# --- The policy says only what it is allowed to say -------------------------
POLICY=$(cat "$CLEAN/etc/sudoers.d/asterism-node")
check "the policy grants exactly four verbs" 4 \
    "$(printf '%s\n' "$POLICY" | grep -c 'systemctl \(start\|stop\|restart\|is-active\) asterism-hermes@\*\.service')"
lacks "the policy grants no unrestricted systemctl" "systemctl ALL" "$POLICY"
lacks "the policy names no shell"                  "/bin/sh"       "$POLICY"
lacks "the policy names no other unit"             ".service, /"   "$POLICY"
contains "the policy never prompts"                "NOPASSWD"      "$POLICY"
contains "the policy names the resolved systemctl" "/usr/bin/systemctl" "$POLICY"
# sudo matches the binary it resolves, so a policy written against a bare name
# would grant nothing.
check "every granted command is an absolute path" 0 \
    "$(printf '%s\n' "$POLICY" | grep -c '^\s*[a-z-]*systemctl ')"

if command -v visudo >/dev/null 2>&1; then
    check "visudo -cf accepts the installed policy" 0 \
        "$(visudo -cf "$CLEAN/etc/sudoers.d/asterism-node" >/dev/null 2>&1; printf '%s' $?)"
else
    printf '  note  visudo is unavailable; policy syntax was not validated here\n'
fi

if command -v systemd-analyze >/dev/null 2>&1; then
    # The template names a Hermes that does not exist under a temporary root, so
    # that one complaint is expected; anything else is a real unit error.
    UNIT_ERRORS=$( { systemd-analyze verify "$CLEAN/etc/systemd/system/asterism-hermes@.service" 2>&1 |
        grep -i 'asterism-hermes' | grep -vi 'is not executable' | wc -l; } || true)
    check "systemd-analyze verify accepts the template" 0 "$UNIT_ERRORS"
else
    printf '  note  systemd-analyze is unavailable; the unit was not verified here\n'
fi

# Installing a template must not start anything. A project owns an instance, and
# no project exists yet.
check "installation enables no template instance" 0 \
    "$(find "$CLEAN/etc/systemd/system" -name '*.wants' -o -name 'asterism-hermes@*.service' \
        ! -name 'asterism-hermes@.service' 2>/dev/null | wc -l)"
check "the installer never starts or enables the template" 0 \
    "$(grep -c 'systemctl \(start\|enable\)[^\n]*asterism-hermes@' "$HERE/install.sh")"

# --- Reaching a host that is already running --------------------------------
#
# A bare run is "install or repair", and repair redoes everything: it downloads
# the pinned Node release over whatever binary is deployed, rebuilds Hermes,
# re-runs provider authorization and restarts both services. On a working host
# that is not an upgrade, it is a rebuild, so this release needed a way in that
# touches the prerequisites and nothing else.
PREREQ_MODE=$(sed -n '/^add_prerequisites/,/^}/p' "$HERE/install.sh")
contains "--prerequisites is a documented option" "--prerequisites" \
    "$(ASTERISM_INSTALL_LIB_ONLY=0 bash "$HERE/install.sh" --help 2>&1)"
check "an unknown option is still refused" 1 \
    "$(ASTERISM_INSTALL_LIB_ONLY=0 bash "$HERE/install.sh" --prerequisit >/dev/null 2>&1; printf '%s' $?)"

# The whole point of the mode is what it does not do.
for step_fn in install_node_binary install_hermes install_docker provide_sqlite \
    write_env_file write_hermes_config write_units enroll_node register_project \
    authorize_provider start_services; do
    lacks "--prerequisites never runs $step_fn" "$step_fn" "$PREREQ_MODE"
done
contains "--prerequisites installs the prerequisites" "install_project_prerequisites" "$PREREQ_MODE"

# Prerequisites on a machine with no Asterism would leave something that looks
# installed and is not. Reaching that refusal needs root, because the root check
# comes first and should.
if [ "$(id -u)" = 0 ]; then
    mkdir -p "$ROOT/no-install"
    contains "--prerequisites refuses a host with no installation" \
        "run install.sh with no options first" \
        "$(ASTERISM_PREFIX=$ROOT/no-install SKIP_SYSTEMD_CHECK=1 \
            run_isolated add_prerequisites || true)"
else
    printf '  note  the --prerequisites refusal needs root and was not exercised here\n'
fi

# --- A rerun changes nothing it does not have to -----------------------------
#
# The upgrade case that matters is the deployed host, where these files were
# placed by hand and are byte-identical to the packaged ones.
mkdir -p "$CLEAN/var/lib/asterism/hermes-projects/asterism-project-demo/sessions"
printf 'API_SERVER_KEY=not-a-real-key\n' \
    > "$CLEAN/var/lib/asterism/hermes-projects/asterism-project-demo/runtime.env"
chmod 0600 "$CLEAN/var/lib/asterism/hermes-projects/asterism-project-demo/runtime.env"
printf 'remembered\n' \
    > "$CLEAN/var/lib/asterism/hermes-projects/asterism-project-demo/sessions/marker"
mkdir -p "$CLEAN/var/lib/asterism/projects/demo"
printf 'work in progress\n' > "$CLEAN/var/lib/asterism/projects/demo/file"

STATE_BEFORE=$(find "$CLEAN/var/lib/asterism/projects" "$CLEAN/var/lib/asterism/hermes-projects" \
    -printf '%P %M\n' | sort | sha256sum)
RERUN=$(prereq_run "$CLEAN")
STATE_AFTER=$(find "$CLEAN/var/lib/asterism/projects" "$CLEAN/var/lib/asterism/hermes-projects" \
    -printf '%P %M\n' | sort | sha256sum)

check "a rerun reports the template as already current" 1 \
    "$(printf '%s\n' "$RERUN" | grep -c 'template already current')"
check "a rerun reports the policy as already current" 1 \
    "$(printf '%s\n' "$RERUN" | grep -c 'policy already current')"
check "a rerun corrects nothing that is already right" 0 \
    "$(printf '%s\n' "$RERUN" | grep -c 'corrected')"
check "a rerun leaves project state exactly as it was" "$STATE_BEFORE" "$STATE_AFTER"
check "an existing worker credential survives a rerun" "API_SERVER_KEY=not-a-real-key" \
    "$(cat "$CLEAN/var/lib/asterism/hermes-projects/asterism-project-demo/runtime.env")"
check "its mode survives too" "600" \
    "$(stat -c '%a' "$CLEAN/var/lib/asterism/hermes-projects/asterism-project-demo/runtime.env")"
check "an existing session marker survives" "remembered" \
    "$(cat "$CLEAN/var/lib/asterism/hermes-projects/asterism-project-demo/sessions/marker")"
check "an existing project workspace survives" "work in progress" \
    "$(cat "$CLEAN/var/lib/asterism/projects/demo/file")"
# A recursive chown across these roots is exactly how an upgrade destroys the
# state it was supposed to keep.
lacks "the installer never recurses over project state" "chown -R" \
    "$(sed -n '/^install_project_prerequisites/,/^}/p;/^ensure_state_dir/,/^}/p' "$HERE/install.sh")"

# --- Refusals ----------------------------------------------------------------
SYMLINKED=$ROOT/symlinked
mkdir -p "$SYMLINKED/var/lib/asterism" "$ROOT/elsewhere"
ln -s "$ROOT/elsewhere" "$SYMLINKED/var/lib/asterism/projects"
SYM_OUT=$(prereq_run "$SYMLINKED" || true)
contains "a symlinked project root is refused" "is a symlink" "$SYM_OUT"
check "nothing is installed after that refusal" "absent" \
    "$([ -e "$SYMLINKED/etc/sudoers.d/asterism-node" ] && printf present || printf absent)"

NOTADIR=$ROOT/notadir
mkdir -p "$NOTADIR/var/lib/asterism"
printf 'not a directory\n' > "$NOTADIR/var/lib/asterism/hermes-projects"
contains "a regular file at a required root is refused" "not a directory" \
    "$(prereq_run "$NOTADIR" || true)"

# A policy sudo cannot parse can lock an operator out of sudo entirely, so an
# invalid candidate must never reach /etc/sudoers.d.
if command -v visudo >/dev/null 2>&1; then
    INVALID=$ROOT/invalid
    prereq_run "$INVALID" >/dev/null 2>&1
    VALID_BEFORE=$(sha256sum "$INVALID/etc/sudoers.d/asterism-node" | cut -d' ' -f1)
    BAD_OUT=$(prereq_run "$INVALID" 'operator with spaces' || true)
    contains "an unparseable policy is refused" "visudo" "$BAD_OUT"
    check "the previously valid policy is left intact" "$VALID_BEFORE" \
        "$(sha256sum "$INVALID/etc/sudoers.d/asterism-node" | cut -d' ' -f1)"
fi

# --- An edit nobody reviewed is never overwritten ----------------------------
EDITED=$ROOT/edited
prereq_run "$EDITED" >/dev/null 2>&1
chmod u+w "$EDITED/etc/sudoers.d/asterism-node"
printf '\n# an operator added this deliberately\n' >> "$EDITED/etc/sudoers.d/asterism-node"
chmod 0440 "$EDITED/etc/sudoers.d/asterism-node"
EDIT_SUM=$(sha256sum "$EDITED/etc/sudoers.d/asterism-node" | cut -d' ' -f1)
EDIT_OUT=$(prereq_run "$EDITED" || true)
contains "an operator's edit stops the run" "refusing to overwrite" "$EDIT_OUT"
check "the operator's edit is preserved" "$EDIT_SUM" \
    "$(sha256sum "$EDITED/etc/sudoers.d/asterism-node" | cut -d' ' -f1)"
check "the packaged version is kept for comparison" "present" \
    "$([ -f "$EDITED/etc/sudoers.d/asterism-node.asterism-new" ] && printf present || printf absent)"
# Unattended installation must stay unattended: no prompt, no stdin read.
lacks "the conflict path asks no question" "read -r" \
    "$(sed -n '/^install_managed_file/,/^}/p' "$HERE/install.sh")"

# The installer's own earlier output is not an operator edit, and must upgrade.
OLDER=$ROOT/older
prereq_run "$OLDER" >/dev/null 2>&1
CURRENT_SUM=$(sha256sum "$OLDER/etc/systemd/system/asterism-hermes@.service" | cut -d' ' -f1)
printf '# what an older Asterism shipped\n' > "$OLDER/etc/systemd/system/asterism-hermes@.service"
sha256sum "$OLDER/etc/systemd/system/asterism-hermes@.service" | cut -d' ' -f1 \
    > "$OLDER/etc/asterism/managed/asterism-hermes@.service.sha256"
prereq_run "$OLDER" >/dev/null 2>&1
check "the installer upgrades its own older output" "$CURRENT_SUM" \
    "$(sha256sum "$OLDER/etc/systemd/system/asterism-hermes@.service" | cut -d' ' -f1)"

# --- A single-project host from before this feature upgrades cleanly ---------
LEGACY=$ROOT/legacy
mkdir -p "$LEGACY/var/lib/asterism/hermes" "$LEGACY/etc/systemd/system" "$LEGACY/etc/asterism"
printf 'legacy sessions\n' > "$LEGACY/var/lib/asterism/hermes/state.db"
printf 'ASTERISM_HERMES_URL=http://127.0.0.1:18642\n' > "$LEGACY/etc/asterism/asterism.env"
printf '[Service]\nUser=asterism\n' > "$LEGACY/etc/systemd/system/asterism-hermes.service"
LEGACY_BEFORE=$(sha256sum "$LEGACY/var/lib/asterism/hermes/state.db" "$LEGACY/etc/asterism/asterism.env" \
    "$LEGACY/etc/systemd/system/asterism-hermes.service" | sha256sum)
prereq_run "$LEGACY" >/dev/null 2>&1
check "a legacy host gains the prerequisites" "present" \
    "$([ -f "$LEGACY/etc/sudoers.d/asterism-node" ] && printf present || printf absent)"
check "its legacy Hermes state and unit are untouched" "$LEGACY_BEFORE" \
    "$(sha256sum "$LEGACY/var/lib/asterism/hermes/state.db" "$LEGACY/etc/asterism/asterism.env" \
        "$LEGACY/etc/systemd/system/asterism-hermes.service" | sha256sum)"
# The legacy Hermes home is the shared provider credential's home; copying its
# state into a project home would give two runtimes one database.
lacks "no legacy state is copied into the project roots" "hermes/state.db" \
    "$(sed -n '/^install_project_prerequisites/,/^}/p' "$HERE/install.sh")"

# --- The host guard reports each prerequisite on its own ---------------------
GOOD=$ROOT/guard-good
prereq_run "$GOOD" >/dev/null 2>&1
mkdir -p "$GOOD/var/lib/asterism/hermes"
: > "$GOOD/var/lib/asterism/hermes/auth.json"
printf '[Service]\nUser=asterism\nPrivateTmp=yes\n' > "$GOOD/etc/systemd/system/asterism-node.service"
check "the guard accepts a correct installation" 0 "$(prereq_guard "$GOOD")"

# Four prerequisites are absent: both roots, the template and the policy. The
# missing shared credential is reported but not counted, because Hermes writes
# it after the provider is authorized.
check "the guard counts every missing prerequisite" 4 "$(prereq_guard "$ROOT/guard-empty")"

BROKEN=$ROOT/guard-broken
prereq_run "$BROKEN" >/dev/null 2>&1
mkdir -p "$BROKEN/var/lib/asterism/hermes"; : > "$BROKEN/var/lib/asterism/hermes/auth.json"
printf '[Service]\nUser=asterism\nProtectKernelTunables=yes\n' \
    > "$BROKEN/etc/systemd/system/asterism-node.service"
check "the guard catches a Node unit that forbids the sudo rule" 1 "$(prereq_guard "$BROKEN")"

LOOSE=$ROOT/guard-loose
prereq_run "$LOOSE" >/dev/null 2>&1
mkdir -p "$LOOSE/var/lib/asterism/hermes"; : > "$LOOSE/var/lib/asterism/hermes/auth.json"
printf '[Service]\nUser=asterism\n' > "$LOOSE/etc/systemd/system/asterism-node.service"
chmod 0755 "$LOOSE/var/lib/asterism/projects"
check "the guard rejects a world-readable project root" 1 "$(prereq_guard "$LOOSE")"

# The guard reports; it must never act.
GUARD_BODY=$(sed -n '/^check_project_prerequisites/,/^}/p' "$HERE/install.sh")
for forbidden in "systemctl start" "systemctl stop" "systemctl restart" "install -d" "mkdir" "chown" "chmod"; do
    lacks "the guard never runs '$forbidden'" "$forbidden" "$GUARD_BODY"
done
lacks "the guard never reads a provider credential" "cat \"\$HERMES_HOME/auth.json\"" "$GUARD_BODY"

# --- The runtime bundle is refused unless it describes itself -----------------
#
# A host is about to unpack this as root. Every question the verifier can ask is
# asked before anything is extracted, and each of these asserts one refusal —
# because a verifier that only ever passes is indistinguishable from no verifier.
printf '\nruntime bundle verification\n'

BUNDLE=$ROOT/bundle
mkdir -p "$BUNDLE"

write_bundle() {
    # $1 overrides the manifest schema, $2 the platform, $3 the revision.
    local schema=${1:-1} platform=${2:-linux/amd64} revision=${3:-abc123} journal=${4:-wal} glibc=${5:-2.17}
    printf 'runtime bytes' > "$BUNDLE/asterism-runtime-test-linux-amd64.tar.gz"
    local sha size
    sha=$(sha256sum "$BUNDLE/asterism-runtime-test-linux-amd64.tar.gz" | cut -d' ' -f1)
    size=$(stat -c %s "$BUNDLE/asterism-runtime-test-linux-amd64.tar.gz")
    cat > "$BUNDLE/manifest.json" <<JSON
{"schema":$schema,"product":"asterism-runtime","version":"test",
 "source_revision":"$revision","platform":"$platform",
 "components":{"hermes":"0.20.3","sqlite":"3.53.4"},"sqlite_journal_mode":"${journal:-wal}",
   "glibc_required":"${glibc:-2.17}","glibc_floor":"2.31",
 "archive":{"name":"asterism-runtime-test-linux-amd64.tar.gz","sha256":"$sha","size_bytes":$size},
 "installed_size_bytes":1,"install_root":"/opt/asterism"}
JSON
    ( cd "$BUNDLE" && sha256sum asterism-runtime-test-linux-amd64.tar.gz manifest.json > SHA256SUMS.runtime )
}

verify_status() {
    ( "$HERE/verify-runtime-bundle.sh" "$BUNDLE" >/dev/null 2>&1 )
    printf '%s' "$?"
}

write_bundle
check "a bundle that matches its manifest is accepted" 0 "$(verify_status)"

# One byte, which is all a corrupted download or a substituted archive needs.
printf 'runtime bytez' > "$BUNDLE/asterism-runtime-test-linux-amd64.tar.gz"
check "a changed archive is refused" 1 "$(verify_status)"
contains "and says the digest is why" "digest" \
    "$("$HERE/verify-runtime-bundle.sh" "$BUNDLE" 2>&1 || true)"

# A manifest from a future build the host does not understand must fail closed
# rather than be interpreted optimistically.
write_bundle 99
check "an unsupported bundle schema is refused" 1 "$(verify_status)"

# A bundle whose state databases would run without WAL is a bundle that lost the
# SQLite it exists to carry. It was published once, claiming 3.53.4 while the
# runtime linked 3.50.4, and every host that installed it lost write concurrency
# silently.
write_bundle 1 linux/amd64 abc123 delete
check "a bundle that would not use WAL is refused" 1 "$(verify_status)"
contains "and says WAL is the requirement" "WAL" \
    "$("$HERE/verify-runtime-bundle.sh" "$BUNDLE" 2>&1 || true)"

# A bundle whose highest libc requirement is above this host's is reported and
# accepted, not refused: that figure counts vendored files nothing executes, and
# refusing on it would reject bundles that run perfectly. The runtime being asked
# to start, after installation, is what actually decides.
write_bundle 1 linux/amd64 abc123 wal 99.9
check "a bundle wanting a newer libc is still accepted" 0 "$(verify_status)"
contains "and the mismatch is said out loud" "glibc 99.9" \
    "$("$HERE/verify-runtime-bundle.sh" "$BUNDLE" 2>&1 || true)"

write_bundle 1 linux/arm64
check "a bundle for another architecture is refused" 1 "$(verify_status)"

# The whole point of the manifest is saying where the bytes came from.
write_bundle 1 linux/amd64 unknown
check "a bundle that cannot name its revision is refused" 1 "$(verify_status)"

write_bundle
rm -f "$BUNDLE/manifest.json"
check "a bundle with no manifest is refused" 1 "$(verify_status)"

write_bundle
rm -f "$BUNDLE/SHA256SUMS.runtime"
check "a bundle with no checksum file is refused" 1 "$(verify_status)"

# The manifest and the checksum file are written separately, so they are checked
# against each other and not only against the bytes.
write_bundle
sed -i "s/^[0-9a-f]\{64\}/$(printf 'f%.0s' $(seq 64))/" "$BUNDLE/SHA256SUMS.runtime"
check "a checksum file that disagrees with the archive is refused" 1 "$(verify_status)"

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
    contains "metadata records the Hermes version"  '"hermes_version": "0.20.3"' "$(cat "$META")"
    contains "metadata records the pinned image"    'sha256:c619ac8c'            "$(cat "$META")"
    contains "metadata records the uv version"      '"uv_version": "0.11.6"'     "$(cat "$META")"
    contains "metadata records external ownership"  '"runtime_ownership": "external"' "$(cat "$META")"
    contains "metadata records the journal mode"    '"journal_mode": "delete"'   "$(cat "$META")"
    # Where the SQLite came from decides whether DELETE is a fallback or the
    # interpreter's own choice; an operator reading this file needs both.
    contains "metadata records the SQLite source"   '"sqlite_source"'            "$(cat "$META")"
    contains "metadata records the Codex CLI"      '"codex_cli_version"'        "$(cat "$META")"
    # The Node reads these to manage Hermes' persistent approval policy. Without
    # them it reports the policy as unavailable rather than guessing a path.
    contains "metadata records the Hermes CLI"    '"hermes_cli"'               "$(cat "$META")"
    contains "metadata records the Hermes home"   '"hermes_home"'              "$(cat "$META")"
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
# --- The provider credential contract -----------------------------------------
#
# There are two credentials on an installed host and they are not
# interchangeable. `$HERMES_HOME/auth.json` is the pooled credential a
# `hermes-loop` run executes against; the Codex CLI's own session lives under
# `.codex` and is read by a different runtime. The installer used to authorize
# the second and report the first, so a host could finish installation calling
# itself authorized and fail every run.
printf '\nprovider credential contract\n'

lacks "the installer never runs a Codex device authorization" \
    "codex login --device-auth" "$(sed -n '/^authorize_provider()/,/^}/p' "$HERE/install.sh")"

contains "it names the credential a run actually consumes" \
    'HERMES_HOME/auth.json' "$(sed -n '/^authorize_provider()/,/^}/p' "$HERE/install.sh")"

contains "an unauthorized host is sent to the console" \
    "provider_authorization_hint" "$(sed -n '/^authorize_provider()/,/^}/p' "$HERE/install.sh")"

PROVIDER_ROOT=$(mktemp -d)
provider_state() {
    # Runs the real step against a temporary root and reports the state it left.
    ( HERMES_HOME="$1/var/lib/asterism/hermes" \
      STATE_DIR="$1/var/lib/asterism" \
      CONTROL_PLANE="https://console.example" \
      ASTERISM_USER=$(id -un) ASTERISM_GROUP=$(id -gn) \
      authorize_provider >/dev/null 2>&1
      printf '%s' "${PROVIDER_AUTHORIZED:-unset}" )
}

# Nothing at all: correct installation, no credential, and it says so.
NONE="$PROVIDER_ROOT/none"; mkdir -p "$NONE/var/lib/asterism/hermes"
check "with no credential the installer reports authorization required" "false" \
    "$(provider_state "$NONE")"

# The unrelated Codex session, which is exactly what the old installer produced.
CODEX_ONLY="$PROVIDER_ROOT/codex"; mkdir -p "$CODEX_ONLY/var/lib/asterism/hermes/.codex"
printf '{"codex":"session"}' > "$CODEX_ONLY/var/lib/asterism/hermes/.codex/auth.json"
check "a Codex session alone is never reported as authorized" "false" \
    "$(provider_state "$CODEX_ONLY")"

# The credential a run consumes.
POOLED="$PROVIDER_ROOT/pooled"; mkdir -p "$POOLED/var/lib/asterism/hermes"
printf '{"pooled":"credential"}' > "$POOLED/var/lib/asterism/hermes/auth.json"
check "the pooled credential is recognised" "true" "$(provider_state "$POOLED")"

# Present but empty is a failed write, not a credential.
EMPTY="$PROVIDER_ROOT/empty"; mkdir -p "$EMPTY/var/lib/asterism/hermes"
: > "$EMPTY/var/lib/asterism/hermes/auth.json"
check "an empty credential is not authorization" "false" "$(provider_state "$EMPTY")"

# An install or repair over a working host must leave the thing that makes it
# work exactly as it found it.
BEFORE=$(sha256sum "$POOLED/var/lib/asterism/hermes/auth.json" | cut -d' ' -f1)
provider_state "$POOLED" >/dev/null
provider_state "$POOLED" >/dev/null
check "install and repair preserve an existing credential" "$BEFORE" \
    "$(sha256sum "$POOLED/var/lib/asterism/hermes/auth.json" | cut -d' ' -f1)"
check "and never relink it" "regular" \
    "$([ -L "$POOLED/var/lib/asterism/hermes/auth.json" ] && printf link || printf regular)"

# The step reads metadata and nothing else.
lacks "the step never opens the credential" "cat \"\$HERMES_HOME/auth.json\"" \
    "$(sed -n '/^authorize_provider()/,/^}/p' "$HERE/install.sh")"

rm -rf "$PROVIDER_ROOT"

contains "the Codex step ensures libatomic1" "libatomic1" "$(cat "$HERE/install.sh")"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
