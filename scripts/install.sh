#!/usr/bin/env bash
#
# Asterism VPS installer.
#
# Installs one Asterism Node and one host-native Hermes on a clean Ubuntu 24.04
# server, enrolls the Node with a Control Plane, registers the project as an
# externally managed runtime, and leaves both under systemd.
#
# The accepted topology this script builds:
#
#   Ubuntu VPS
#   ├── asterism-node.service      outbound WebSocket to the Control Plane
#   ├── asterism-hermes.service    agent runtime, loopback only
#   ├── project workspace
#   └── Docker Engine              the project's own services
#
# Read before running. It is meant to be inspected:
#
#   curl -fsSLO https://raw.githubusercontent.com/Patternity/asterism/master/scripts/install.sh
#   less install.sh
#   sudo bash install.sh
#
# Every prompt reads from /dev/tty, so the piped form works too:
#
#   curl -fsSL .../install.sh | sudo bash

set -euo pipefail

# ---------------------------------------------------------------------------
# Pinned versions and paths
# ---------------------------------------------------------------------------

# The Node release this installer fetches. Overridable for testing a candidate
# build; the checksum check below is not optional either way.
ASTERISM_VERSION="${ASTERISM_VERSION:-v0.1.0-alpha.1}"
ASTERISM_REPO="${ASTERISM_REPO:-Patternity/asterism}"
ASTERISM_RELEASE_BASE="${ASTERISM_RELEASE_BASE:-https://github.com/${ASTERISM_REPO}/releases/download}"

# Hermes comes from the digest-pinned Asterism project runtime image rather than
# from PyPI or a git tag. That image is the artifact Asterism has actually
# accepted, so extracting its source tree is what makes the host install
# traceable to something already proven rather than to a version number that
# could resolve differently tomorrow.
HERMES_VERSION="0.20.0"
HERMES_SOURCE_IMAGE="${HERMES_SOURCE_IMAGE:-ghcr.io/patternity/asterism-project-runtime@sha256:1d280b6595e465909ab93759a4406688c7a156f3f556d90c7b22e58765cd3144}"

# `uv` version: the one the accepted image was built with.
UV_VERSION="0.11.6"

# Python: the 3.13 line the accepted image uses, at its latest patch.
#
# The image links a purpose-built SQLite 3.53.4; no python-build-standalone
# release currently does, which is why the SQLite section below probes the real
# interpreter instead of assuming. `requires-python` in the pinned Hermes
# pyproject is >=3.11,<3.14, so 3.14 is not an option.
PYTHON_VERSION="${PYTHON_VERSION:-3.13.13}"

# Dependency extras.
#
# A strict subset of the image's set. Upstream's own policy note in
# `[project.optional-dependencies]` is that everything omitted here
# (anthropic, matrix, messaging, …) is lazily installable at first use;
# `[all]` carries `[sms]`, which is what provides aiohttp.
HERMES_EXTRAS=(--extra all --extra otlp)

ASTERISM_USER="${ASTERISM_USER:-asterism}"
ASTERISM_GROUP="$ASTERISM_USER"

# ASTERISM_PREFIX exists so the test suite can drive the real functions against a
# temporary root. It is empty in every real installation.
PREFIX="${ASTERISM_PREFIX:-}"

ETC_DIR="$PREFIX/etc/asterism"
STATE_DIR="$PREFIX/var/lib/asterism"
# `--node-home` is the Node's *state root*: it creates `node/` inside it and puts
# the identity and registry there. Passing $STATE_DIR/node would nest that a
# second time and produce .../node/node/identity.json.
NODE_HOME="$STATE_DIR"
NODE_STATE_DIR="$STATE_DIR/node"
NODE_IDENTITY_FILE="$NODE_STATE_DIR/identity.json"
HERMES_HOME="$STATE_DIR/hermes"
WORKSPACE_DEFAULT="$PREFIX/srv/asterism/workspace"
OPT_DIR="$PREFIX/opt/asterism"
HERMES_DIR="$OPT_DIR/hermes"
CODEX_DIR="$OPT_DIR/codex"
NODE_BIN="$PREFIX/usr/local/bin/asterism-node"
ENV_FILE="$ETC_DIR/asterism.env"
METADATA_FILE="$ETC_DIR/install-metadata.json"

UNIT_DIR="$PREFIX/etc/systemd/system"
HERMES_UNIT="$UNIT_DIR/asterism-hermes.service"
NODE_UNIT="$UNIT_DIR/asterism-node.service"

# Minimum free space on /. The Hermes dependency set alone is several GiB.
MIN_DISK_MB=12000

MODE=install

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
    C_OK=; C_WARN=; C_ERR=; C_DIM=; C_OFF=
fi

log()  { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s\n' "$C_DIM" "$C_OFF" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$C_OK" "$C_OFF" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_WARN" "$C_OFF" "$*" >&2; }
die()  { printf '\n%serror:%s %s\n' "$C_ERR" "$C_OFF" "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Interactive input
# ---------------------------------------------------------------------------

# All prompts read /dev/tty rather than stdin so that the documented
# `curl … | sudo bash` form stays interactive: stdin is the script itself there,
# and reading it would consume the program being executed.
have_tty() { [ -r /dev/tty ]; }

ask() {
    local prompt="$1" default="${2:-}" reply
    have_tty || die "interactive input is required but /dev/tty is unavailable"
    if [ -n "$default" ]; then
        printf '  %s [%s]: ' "$prompt" "$default" > /dev/tty
    else
        printf '  %s: ' "$prompt" > /dev/tty
    fi
    IFS= read -r reply < /dev/tty || die "input ended unexpectedly"
    printf '%s' "${reply:-$default}"
}

# Reads a secret without echoing it and without ever placing it in argv.
ask_secret() {
    local prompt="$1" reply
    have_tty || die "interactive input is required but /dev/tty is unavailable"
    printf '  %s: ' "$prompt" > /dev/tty
    IFS= read -rs reply < /dev/tty || die "input ended unexpectedly"
    printf '\n' > /dev/tty
    printf '%s' "$reply"
}

confirm() {
    local reply
    reply=$(ask "$1 [y/N]" "n")
    case "$reply" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

# Ubuntu 24.04 on amd64 with systemd is the only combination this installer has
# been proven against. Everything else is refused by name rather than attempted
# and left half-done — a partially configured host is worse than a refusal.
check_os() {
    local release="${OS_RELEASE_FILE:-/etc/os-release}"
    local id version arch
    [ -r "$release" ] || die "cannot read $release; this installer supports Ubuntu 24.04 LTS only"
    # shellcheck disable=SC1090
    id=$(. "$release" && printf '%s' "${ID:-}")
    # shellcheck disable=SC1090
    version=$(. "$release" && printf '%s' "${VERSION_ID:-}")
    [ "$id" = ubuntu ] || die "unsupported distribution '$id'. Supported: Ubuntu 24.04 LTS"
    [ "$version" = "24.04" ] || die "unsupported Ubuntu release '$version'. Supported: Ubuntu 24.04 LTS"

    arch="${HOST_ARCH:-$(uname -m)}"
    [ "$arch" = "x86_64" ] || die "unsupported architecture '$arch'. Supported: linux/amd64"

    [ "${SKIP_SYSTEMD_CHECK:-0}" = 1 ] && return 0
    [ -d /run/systemd/system ] || die "systemd is not the init system here. Supported: systemd"
    command -v systemctl >/dev/null 2>&1 || die "systemctl is missing; systemd is required"
}

check_root() {
    [ "$(id -u)" -eq 0 ] || die "run as root: sudo bash install.sh"
}

check_commands() {
    local missing=()
    local cmd
    for cmd in curl tar sha256sum install useradd systemctl awk sed grep; do
        command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
    done
    [ ${#missing[@]} -eq 0 ] || die "missing required commands: ${missing[*]}"
}

check_disk() {
    local free_mb
    free_mb=$(df -Pm / | awk 'NR==2 {print $4}')
    [ "$free_mb" -ge "$MIN_DISK_MB" ] ||
        die "need at least ${MIN_DISK_MB} MB free on /, found ${free_mb} MB"
}

check_network() {
    local host failed=()
    for host in https://github.com https://astral.sh https://pypi.org https://ghcr.io; do
        curl -fsS --max-time 15 -o /dev/null "$host" 2>/dev/null || failed+=("$host")
    done
    [ ${#failed[@]} -eq 0 ] || die "cannot reach required sources: ${failed[*]}"
}

# Existing installation state, reported before anything is written so that a
# rerun announces what it will preserve rather than discovering it midway.
detect_existing() {
    EXISTING_NODE_IDENTITY=false
    EXISTING_ENV=false
    EXISTING_HERMES=false
    EXISTING_UNITS=false

    [ -f "$NODE_IDENTITY_FILE" ] && EXISTING_NODE_IDENTITY=true
    [ -f "$ENV_FILE" ] && EXISTING_ENV=true
    [ -d "$HERMES_DIR/.venv" ] && EXISTING_HERMES=true
    if [ -f "$HERMES_UNIT" ] || [ -f "$NODE_UNIT" ]; then
        EXISTING_UNITS=true
    fi
    return 0
}

preflight() {
    step "Preflight"
    check_root;     ok "running as root"
    check_os;       ok "Ubuntu 24.04 LTS on linux/amd64 with systemd"
    check_commands; ok "required host commands present"
    check_disk;     ok "sufficient free disk space"
    check_network;  ok "artifact sources reachable"
    detect_existing
    if [ "$EXISTING_ENV" = true ] || [ "$EXISTING_HERMES" = true ] || [ "$EXISTING_UNITS" = true ]; then
        ok "existing installation detected — credentials, state, and workspace will be preserved"
        if [ "$EXISTING_NODE_IDENTITY" = true ]; then
            ok "this Node already has an identity; it will not be re-enrolled"
        else
            warn "units or credentials exist but no Node identity does — a previous run was interrupted"
        fi
    else
        ok "no previous installation found"
    fi
}

# ---------------------------------------------------------------------------
# User and directories
# ---------------------------------------------------------------------------

create_user() {
    step "Service account and directories"
    if id -u "$ASTERISM_USER" >/dev/null 2>&1; then
        ok "user $ASTERISM_USER already exists"
    else
        useradd --system --create-home --home-dir "$STATE_DIR" \
            --shell /usr/sbin/nologin "$ASTERISM_USER"
        ok "created system user $ASTERISM_USER"
    fi

    # Node and Hermes share one account on purpose. The whole VPS is a single
    # project trust domain: an agent that can run arbitrary commands in the
    # workspace and drive the project's Docker daemon is already inside it, so a
    # second account would suggest a boundary that does not exist.
    install -d -o root -g "$ASTERISM_GROUP" -m 0750 "$ETC_DIR"
    install -d -o "$ASTERISM_USER" -g "$ASTERISM_GROUP" -m 0750 "$STATE_DIR"
    install -d -o "$ASTERISM_USER" -g "$ASTERISM_GROUP" -m 0700 "$NODE_STATE_DIR"
    install -d -o "$ASTERISM_USER" -g "$ASTERISM_GROUP" -m 0700 "$HERMES_HOME"
    install -d -o root -g root -m 0755 "$OPT_DIR"
    install -d -o "$ASTERISM_USER" -g "$ASTERISM_GROUP" -m 0755 "$WORKSPACE"
    ok "directories created with restrictive ownership"
}

# ---------------------------------------------------------------------------
# Docker
# ---------------------------------------------------------------------------

install_docker() {
    step "Docker Engine"
    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
        ok "existing Docker installation preserved"
    else
        log "  installing Docker Engine from the official Docker apt repository"
        install -m 0755 -d /etc/apt/keyrings
        curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
            -o /etc/apt/keyrings/docker.asc
        chmod a+r /etc/apt/keyrings/docker.asc
        printf 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
            "$(. /etc/os-release && printf '%s' "$VERSION_CODENAME")" \
            > /etc/apt/sources.list.d/docker.list
        DEBIAN_FRONTEND=noninteractive apt-get update -qq
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
            docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
        systemctl enable --now docker
        ok "Docker Engine installed"
    fi

    docker info >/dev/null 2>&1 || die "the Docker daemon is not healthy"
    docker compose version >/dev/null 2>&1 || die "the Docker Compose plugin is missing"

    # Hermes drives the project's own services. It talks to the host daemon
    # directly: Docker-in-Docker would give the agent a second, invisible
    # daemon whose containers nothing on the host could see.
    if ! id -nG "$ASTERISM_USER" | tr ' ' '\n' | grep -qx docker; then
        usermod -aG docker "$ASTERISM_USER"
    fi
    # `sg` picks up the new membership without a login session, which is what
    # makes this a real check rather than a claim.
    sg docker -c "docker ps >/dev/null" >/dev/null 2>&1 ||
        runuser -u "$ASTERISM_USER" -- docker ps >/dev/null 2>&1 ||
        warn "could not verify Docker access as $ASTERISM_USER; it will apply once the service starts"

    DOCKER_VERSION=$(docker version --format '{{.Server.Version}}' 2>/dev/null || printf 'unknown')
    COMPOSE_VERSION=$(docker compose version --short 2>/dev/null || printf 'unknown')
    ok "Docker $DOCKER_VERSION, Compose $COMPOSE_VERSION, accessible to $ASTERISM_USER"
}

# ---------------------------------------------------------------------------
# Asterism Node binary
# ---------------------------------------------------------------------------

# Verifies one file against a SHA256SUMS listing. Kept separate so the test
# suite can exercise the rejection path without a network.
verify_checksum() {
    local file="$1" sums="$2" name expected actual
    name=$(basename "$file")
    expected=$(awk -v n="$name" '$2 == n || $2 == "*"n {print $1; exit}' "$sums")
    [ -n "$expected" ] || { printf 'no checksum recorded for %s\n' "$name" >&2; return 1; }
    actual=$(sha256sum "$file" | awk '{print $1}')
    [ "$expected" = "$actual" ] || {
        printf 'checksum mismatch for %s\n  expected %s\n  actual   %s\n' \
            "$name" "$expected" "$actual" >&2
        return 1
    }
    printf '%s' "$actual"
}

install_node_binary() {
    step "Asterism Node $ASTERISM_VERSION"
    local name url tmp
    name="asterism-node-${ASTERISM_VERSION}-linux-amd64"
    url="${ASTERISM_RELEASE_BASE}/${ASTERISM_VERSION}"
    tmp=$(mktemp -d)
    # shellcheck disable=SC2064
    trap "rm -rf '$tmp'" RETURN

    # Rust is never compiled here. A toolchain on the user's VPS would be a
    # large dependency and would produce a binary nobody can verify.
    curl -fsSL --retry 3 -o "$tmp/${name}.tar.gz" "${url}/${name}.tar.gz" ||
        die "cannot download the Node release ${ASTERISM_VERSION}"
    curl -fsSL --retry 3 -o "$tmp/SHA256SUMS" "${url}/SHA256SUMS" ||
        die "cannot download the release checksums"

    NODE_CHECKSUM=$(verify_checksum "$tmp/${name}.tar.gz" "$tmp/SHA256SUMS") ||
        die "release checksum verification failed; refusing to install"
    ok "checksum verified: ${NODE_CHECKSUM}"

    tar -C "$tmp" -xzf "$tmp/${name}.tar.gz"
    install -o root -g root -m 0755 "$tmp/${name}/asterism-node" "$NODE_BIN"
    ok "installed $NODE_BIN ($("$NODE_BIN" --version 2>/dev/null || printf 'version unavailable'))"
}

# ---------------------------------------------------------------------------
# Hermes
# ---------------------------------------------------------------------------

install_uv() {
    if [ -x "$OPT_DIR/bin/uv" ] && "$OPT_DIR/bin/uv" --version 2>/dev/null | grep -q "$UV_VERSION"; then
        ok "uv $UV_VERSION already installed"
        return
    fi
    install -d -o root -g root -m 0755 "$OPT_DIR/bin"
    curl -fsSL "https://astral.sh/uv/${UV_VERSION}/install.sh" |
        env UV_INSTALL_DIR="$OPT_DIR/bin" INSTALLER_NO_MODIFY_PATH=1 sh >/dev/null
    ok "uv $UV_VERSION installed"
}

# The Codex CLI, taken from the same pinned image.
#
# Hermes' `openai-codex` provider spawns this binary; without it the model
# cannot be reached and `codex login --device-auth` — the only headless
# authorization path — does not exist on the host. It is a Node.js package, so
# the interpreter travels with it rather than becoming a host dependency.
install_codex_cli() {
    if [ -x "$CODEX_DIR/bin/codex" ] &&
       CODEX_VERSION=$("$CODEX_DIR/bin/codex" --version 2>/dev/null | awk '{print $NF}') &&
       [ -n "$CODEX_VERSION" ]; then
        ok "Codex CLI $CODEX_VERSION already installed"
        return
    fi
    # The Node.js binary comes from a Debian image and links libatomic, which a
    # minimal Ubuntu does not carry. Installing the tiny system package is
    # cleaner than shipping a copy of the shared object.
    if ! ldconfig -p | grep -q 'libatomic\.so\.1'; then
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq libatomic1 ||
            die "cannot install libatomic1, which the Codex CLI's Node.js requires"
    fi

    log "  extracting the Codex CLI from the pinned runtime image"
    docker pull -q "$HERMES_SOURCE_IMAGE" >/dev/null ||
        die "cannot pull the pinned runtime image"
    local cid
    cid=$(docker create "$HERMES_SOURCE_IMAGE" /bin/true)
    rm -rf "$CODEX_DIR"
    install -d -o root -g root -m 0755 "$CODEX_DIR/bin" "$CODEX_DIR/lib/node_modules"
    docker cp "$cid:/usr/local/bin/node" "$CODEX_DIR/bin/node" >/dev/null
    docker cp "$cid:/usr/local/lib/node_modules/@openai" \
        "$CODEX_DIR/lib/node_modules/@openai" >/dev/null
    cat > "$CODEX_DIR/bin/codex" <<EOF
#!/bin/sh
# Runs the pinned Codex CLI against the interpreter it shipped with, so neither
# depends on anything the host happens to have.
exec "$CODEX_DIR/bin/node" "$CODEX_DIR/lib/node_modules/@openai/codex/bin/codex.js" "\$@"
EOF
    chmod 0755 "$CODEX_DIR/bin/codex"
    chmod -R a+rX "$CODEX_DIR"
    docker rm -f "$cid" >/dev/null
    CODEX_VERSION=$("$CODEX_DIR/bin/codex" --version 2>/dev/null | awk '{print $NF}')
    if [ -z "$CODEX_VERSION" ]; then
        "$CODEX_DIR/bin/codex" --version 2>&1 | sed 's/^/    /' >&2 || true
        die "the extracted Codex CLI does not run on this host"
    fi
    ok "Codex CLI $CODEX_VERSION installed at $CODEX_DIR"
}

extract_hermes_source() {
    if [ -f "$HERMES_DIR/pyproject.toml" ] &&
       grep -q "^version = \"${HERMES_VERSION}\"" "$HERMES_DIR/pyproject.toml" 2>/dev/null; then
        ok "Hermes $HERMES_VERSION source tree already present"
        return
    fi
    log "  extracting Hermes $HERMES_VERSION from the pinned runtime image"
    docker pull -q "$HERMES_SOURCE_IMAGE" >/dev/null ||
        die "cannot pull the pinned Hermes source image"
    local cid staging
    staging="${HERMES_DIR}.staging"
    rm -rf "$staging"
    cid=$(docker create "$HERMES_SOURCE_IMAGE" /bin/true)
    # The image's own virtualenv is not copied: it links the image's
    # interpreter, which does not exist on this host. Only the source and the
    # lock travel; the environment is rebuilt below from that lock.
    docker cp "$cid:/opt/hermes" "$staging" >/dev/null
    rm -rf "$staging/.venv"
    rm -rf "$HERMES_DIR"
    mv "$staging" "$HERMES_DIR"
    chown -R "$ASTERISM_USER:$ASTERISM_GROUP" "$HERMES_DIR"
    docker rm -f "$cid" >/dev/null
    ok "Hermes $HERMES_VERSION source installed at $HERMES_DIR"
}

build_hermes_env() {
    log "  resolving the pinned dependency lock (this takes several minutes)"
    install -d -o "$ASTERISM_USER" -g "$ASTERISM_GROUP" -m 0755 "$OPT_DIR/python"
    runuser -u "$ASTERISM_USER" -- env \
        UV_PYTHON_INSTALL_DIR="$OPT_DIR/python" \
        UV_PROJECT_ENVIRONMENT="$HERMES_DIR/.venv" \
        HOME="$STATE_DIR" \
        "$OPT_DIR/bin/uv" python install "$PYTHON_VERSION" >/dev/null 2>&1 ||
        die "cannot provision the pinned Python $PYTHON_VERSION"

    ( cd "$HERMES_DIR" && runuser -u "$ASTERISM_USER" -- env \
        UV_PYTHON_INSTALL_DIR="$OPT_DIR/python" \
        UV_PROJECT_ENVIRONMENT="$HERMES_DIR/.venv" \
        HOME="$STATE_DIR" \
        "$OPT_DIR/bin/uv" sync --frozen --no-install-project \
            --python "$PYTHON_VERSION" "${HERMES_EXTRAS[@]}" ) >/dev/null ||
        die "the pinned Hermes dependency set failed to install"

    ( cd "$HERMES_DIR" && runuser -u "$ASTERISM_USER" -- env \
        UV_PROJECT_ENVIRONMENT="$HERMES_DIR/.venv" \
        HOME="$STATE_DIR" \
        "$OPT_DIR/bin/uv" pip install --no-deps -e . ) >/dev/null ||
        die "installing the Hermes project itself failed"

    ok "Hermes environment built from the pinned lock"
}

install_hermes() {
    step "Hermes $HERMES_VERSION"
    install_uv
    extract_hermes_source
    install_codex_cli
    if [ -x "$HERMES_DIR/.venv/bin/hermes" ] && [ "$MODE" = doctor ]; then
        ok "Hermes environment present"
    else
        build_hermes_env
    fi
}

# ---------------------------------------------------------------------------
# SQLite policy
# ---------------------------------------------------------------------------

# Hermes stores its state in SQLite and nothing here changes that; PostgreSQL is
# a thing a *project* may deploy, not an Asterism dependency.
#
# The threshold below is transcribed from the pinned Hermes 0.20.0
# implementation (`hermes_cli/sqlite_runtime.py: is_sqlite_wal_reset_vulnerable`),
# which follows https://sqlite.org/wal.html#walresetbug: the WAL-reset bug spans
# 3.7.0 through 3.51.2, fixed in 3.51.3, with backports in 3.50.7 and 3.44.6.
# Guessing a version here would silently choose a corrupting configuration.
sqlite_wal_safe() {
    local version="$1"
    local major minor patch
    IFS=. read -r major minor patch <<< "$version"
    patch=${patch:-0}
    local n=$((major * 1000000 + minor * 1000 + patch))
    [ "$n" -lt 3007000 ] && return 0                                  # pre-WAL
    [ "$n" -ge 3051003 ] && return 0                                  # fixed
    [ "$n" -ge 3050007 ] && [ "$n" -lt 3051000 ] && return 0          # 3.50.x backport
    [ "$n" -ge 3044006 ] && [ "$n" -lt 3045000 ] && return 0          # 3.44.x backport
    return 1
}

configure_sqlite() {
    step "SQLite policy"
    local python="$HERMES_DIR/.venv/bin/python"
    [ -x "$python" ] || die "the Hermes interpreter is missing at $python"

    # The interpreter Hermes will actually run is the one that gets tested. The
    # system Python's SQLite is irrelevant here and trusting it would be wrong:
    # on Ubuntu 24.04 it is a different, older library entirely.
    SQLITE_VERSION=$("$python" -c 'import sqlite3; print(sqlite3.sqlite_version)') ||
        die "cannot determine the SQLite version linked by the Hermes interpreter"

    # FTS5 is proven with a real virtual table, not with a compile flag: a build
    # can advertise the option and still fail to create the table.
    "$python" - <<'PY' >/dev/null 2>&1 || die "the Hermes interpreter's SQLite lacks working FTS5 support"
import sqlite3, tempfile, os
path = os.path.join(tempfile.mkdtemp(), "fts.db")
conn = sqlite3.connect(path)
conn.execute("CREATE VIRTUAL TABLE probe USING fts5(body)")
conn.execute("INSERT INTO probe(body) VALUES ('asterism installer probe')")
row = conn.execute("SELECT body FROM probe WHERE probe MATCH 'installer'").fetchone()
conn.close()
assert row is not None
PY
    ok "SQLite $SQLITE_VERSION with working FTS5"

    if sqlite_wal_safe "$SQLITE_VERSION"; then
        JOURNAL_MODE=wal
        ok "journal mode: wal (this SQLite is past the WAL-reset bug)"
    else
        JOURNAL_MODE=delete
        warn "SQLite $SQLITE_VERSION carries the WAL-reset bug (sqlite.org/wal.html#walresetbug)"
        ok "journal mode: delete — Hermes' supported fallback, configured explicitly"
    fi

    # Hermes supports exactly these two modes; anything else would be an
    # invented configuration.
    case "$JOURNAL_MODE" in
        wal|delete) ;;
        *) die "no safe journal mode is available for SQLite $SQLITE_VERSION" ;;
    esac

    # Hermes databases stay on local disk. WAL and network filesystems are a
    # known corruption pairing, and DELETE only narrows that risk.
    local fstype
    fstype=$(stat -f -c %T "$HERMES_HOME" 2>/dev/null || printf 'unknown')
    case "$fstype" in
        nfs*|smb*|cifs*|fuse*)
            die "$HERMES_HOME is on a $fstype filesystem; Hermes databases must be on local storage" ;;
    esac
    ok "Hermes state on a local filesystem ($fstype)"
}

# ---------------------------------------------------------------------------
# Secrets and configuration
# ---------------------------------------------------------------------------

# Picks a free loopback port deterministically: the same host keeps the same
# port across reruns unless something else has taken it.
pick_hermes_port() {
    local port
    if [ -f "$ENV_FILE" ]; then
        port=$(awk -F= '$1=="ASTERISM_HERMES_PORT" {print $2}' "$ENV_FILE" | tr -d '"')
        [ -n "$port" ] && { printf '%s' "$port"; return; }
    fi
    for port in $(seq 18642 18700); do
        if ! ss -ltn "sport = :$port" 2>/dev/null | grep -q LISTEN; then
            printf '%s' "$port"; return
        fi
    done
    die "no free loopback port available in 18642-18700"
}

write_env_file() {
    step "Credentials and configuration"
    HERMES_PORT=$(pick_hermes_port)
    HERMES_ENDPOINT="http://127.0.0.1:${HERMES_PORT}"

    if [ -f "$ENV_FILE" ] && grep -q '^ASTERISM_HERMES_API_KEY=' "$ENV_FILE"; then
        ok "existing Hermes API key preserved"
    else
        # 32 bytes of kernel randomness, hex-encoded. Written straight into a
        # 0640 root:asterism file: never echoed, never an argument, never sent
        # to the Control Plane, and never in a unit's command line.
        local key
        key=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
        umask 027
        cat > "$ENV_FILE" <<EOF
# Asterism runtime environment. Contains a secret: keep mode 0640, root:$ASTERISM_GROUP.
#
# One key under two names. The Node reads ASTERISM_HERMES_API_KEY; the Hermes API
# server reads API_SERVER_KEY and refuses to start without it, loopback bind
# included. Both must be the same value or the Node authenticates to nothing.
ASTERISM_HERMES_API_KEY=$key
API_SERVER_KEY=$key
ASTERISM_HERMES_PORT=$HERMES_PORT
ASTERISM_HERMES_URL=$HERMES_ENDPOINT
ASTERISM_NODE_HOME=$NODE_HOME
EOF
        unset key
        ok "generated a Hermes API key"
    fi
    chown root:"$ASTERISM_GROUP" "$ENV_FILE"
    chmod 0640 "$ENV_FILE"

    # Repair an environment file that predates the two-name contract, without
    # rotating the key an enrolled Hermes is already using.
    if ! grep -q '^API_SERVER_KEY=' "$ENV_FILE"; then
        awk -F= '$1=="ASTERISM_HERMES_API_KEY" {print "API_SERVER_KEY=" substr($0, index($0, "=") + 1)}' \
            "$ENV_FILE" >> "$ENV_FILE"
        ok "added the API_SERVER_KEY alias for the existing key"
    fi

    # Refresh the non-secret entries without touching the key.
    sed -i "s|^ASTERISM_HERMES_PORT=.*|ASTERISM_HERMES_PORT=$HERMES_PORT|; \
            s|^ASTERISM_HERMES_URL=.*|ASTERISM_HERMES_URL=$HERMES_ENDPOINT|; \
            s|^ASTERISM_NODE_HOME=.*|ASTERISM_NODE_HOME=$NODE_HOME|" "$ENV_FILE"
    ok "Hermes endpoint: $HERMES_ENDPOINT (loopback only)"
}

write_hermes_config() {
    local config="$HERMES_HOME/config.yaml"
    if [ -f "$config" ]; then
        ok "existing Hermes configuration preserved"
        return
    fi
    umask 077
    cat > "$config" <<EOF
# Asterism-managed Hermes configuration.
#
# The API binds to loopback only: Asterism Node reaches it over 127.0.0.1 and
# nothing else may. No inbound public port is introduced by this installation.
api_server:
  enabled: true
  host: 127.0.0.1
  port: $HERMES_PORT

terminal:
  backend: local
  cwd: $WORKSPACE

model:
  provider: openai-codex

approvals:
  mode: manual

database:
  # Resolved by the installer against the SQLite this interpreter actually
  # links. See docs/installation.md for the threshold and why it matters.
  journal_mode: $JOURNAL_MODE
EOF
    chown "$ASTERISM_USER:$ASTERISM_GROUP" "$config"
    chmod 0600 "$config"
    ok "Hermes configured: local terminal, openai-codex, manual approvals"
}

# ---------------------------------------------------------------------------
# systemd units
# ---------------------------------------------------------------------------

write_units() {
    step "systemd units"

    # Hardening here is deliberately modest. Hermes runs arbitrary project
    # commands and drives the host Docker daemon; directives like
    # ProtectSystem=strict or PrivateDevices would break exactly the work it
    # exists to do. Every directive below was tested against a running install.
    cat > "$HERMES_UNIT" <<EOF
[Unit]
Description=Asterism host-native Hermes agent runtime
Documentation=https://github.com/${ASTERISM_REPO}/blob/master/docs/installation.md
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service
# Bound the restart loop so a configuration error fails visibly instead of
# retrying forever.
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=$ASTERISM_USER
Group=$ASTERISM_GROUP
SupplementaryGroups=docker
WorkingDirectory=$WORKSPACE
# The API key reaches Hermes through the environment file, never through the
# command line, so it stays out of the process table and out of systemctl show.
EnvironmentFile=$ENV_FILE
Environment=HOME=$STATE_DIR
Environment=HERMES_HOME=$HERMES_HOME
Environment=HERMES_CONFIG_DIR=$HERMES_HOME
Environment=CODEX_HOME=$HERMES_HOME/.codex
Environment=API_SERVER_ENABLED=true
Environment=API_SERVER_HOST=127.0.0.1
Environment=API_SERVER_PORT=$HERMES_PORT
Environment=PYTHONUNBUFFERED=1
Environment=PATH=$CODEX_DIR/bin:$HERMES_DIR/.venv/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$HERMES_DIR/.venv/bin/hermes gateway
# Hermes handles SIGTERM and then exits 1, which systemd would otherwise record
# as a failed unit after an ordinary `systemctl stop`. Restart=always keeps crash
# recovery regardless of exit status, so nothing is lost by accepting 1 as clean.
Restart=always
SuccessExitStatus=1
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGTERM
NoNewPrivileges=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
StandardOutput=journal
StandardError=journal
SyslogIdentifier=asterism-hermes

[Install]
WantedBy=multi-user.target
EOF

    cat > "$NODE_UNIT" <<EOF
[Unit]
Description=Asterism Node
Documentation=https://github.com/${ASTERISM_REPO}/blob/master/docs/installation.md
# Hermes first: the Node dials it. Ordering is not readiness, so the Node also
# retries — a unit that merely starts second would still race the runtime.
After=network-online.target asterism-hermes.service
Wants=network-online.target
Requires=asterism-hermes.service

[Service]
Type=simple
User=$ASTERISM_USER
Group=$ASTERISM_GROUP
SupplementaryGroups=docker
WorkingDirectory=$STATE_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN node serve --node-home $NODE_HOME --project $PROJECT_ID
Restart=always
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGTERM
NoNewPrivileges=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
StandardOutput=journal
StandardError=journal
SyslogIdentifier=asterism-node

[Install]
WantedBy=multi-user.target
EOF

    [ -n "$PREFIX" ] || systemctl daemon-reload
    ok "asterism-hermes.service and asterism-node.service installed"
}

# ---------------------------------------------------------------------------
# Product setup
# ---------------------------------------------------------------------------

collect_settings() {
    step "Project setup"
    if [ -f "$METADATA_FILE" ]; then
        CONTROL_PLANE=$(json_field "$METADATA_FILE" control_plane)
        PROJECT_ID=$(json_field "$METADATA_FILE" project_id)
        WORKSPACE=$(json_field "$METADATA_FILE" workspace)
        NODE_NAME=$(json_field "$METADATA_FILE" node_name)
        ok "reusing the recorded settings for project $PROJECT_ID"
        return
    fi

    CONTROL_PLANE=$(ask "Control Plane URL" "https://")
    case "$CONTROL_PLANE" in
        https://*) ;;
        http://127.0.0.1*|http://localhost*)
            warn "a plaintext loopback Control Plane is a development configuration" ;;
        *) die "the Control Plane URL must be https://" ;;
    esac
    NODE_NAME=$(ask "Node display name" "$(hostname -s)")
    PROJECT_ID=$(ask "Project identifier" "$(hostname -s | tr -cd 'a-z0-9-')")
    [ -n "$PROJECT_ID" ] || die "a project identifier is required"
    WORKSPACE=$(ask "Project workspace path" "$WORKSPACE_DEFAULT")
}

# Reads one string value out of the flat metadata file this installer writes.
# Deliberately not a general JSON parser: it only ever reads its own output, and
# depending on jq would add a host requirement for a single lookup.
json_field() {
    sed -n "s/^[[:space:]]*\"$2\"[[:space:]]*:[[:space:]]*\"\(.*\)\"[,]\{0,1\}[[:space:]]*$/\1/p" "$1" | head -1
}

enroll_node() {
    step "Control Plane enrollment"
    if [ -f "$NODE_IDENTITY_FILE" ] &&
       grep -q '"node_id"' "$NODE_IDENTITY_FILE" 2>/dev/null; then
        ok "this Node is already enrolled; identity preserved"
        return
    fi

    log "  Create a Node enrollment token in the Asterism console, then paste it."
    log "  It is read without echo and never appears in the process table."
    local token plaintext=()
    token=$(ask_secret "Enrollment token")
    [ -n "$token" ] || die "an enrollment token is required"
    case "$CONTROL_PLANE" in
        http://*) plaintext=(--allow-plaintext-loopback) ;;
    esac

    # --token-stdin is the Node's own contract for this: the token is never
    # accepted as an argument, precisely so it cannot leak through argv.
    if ! printf '%s' "$token" | runuser -u "$ASTERISM_USER" -- \
        "$NODE_BIN" node enroll --control-plane "$CONTROL_PLANE" \
        --node-home "$NODE_HOME" --token-stdin "${plaintext[@]+"${plaintext[@]}"}" >/dev/null; then
        unset token
        die "enrollment failed; the token may be expired or already used"
    fi
    unset token
    ok "Node enrolled with $CONTROL_PLANE"
}

register_project() {
    step "Project registration"
    if runuser -u "$ASTERISM_USER" -- "$NODE_BIN" project list --node-home "$NODE_HOME" 2>/dev/null |
        grep -q "\"$PROJECT_ID\""; then
        ok "project $PROJECT_ID already registered"
        return
    fi
    # External ownership is the whole point of this topology: Hermes is a host
    # service under systemd, so the Node addresses it and never tries to create,
    # start, stop, or delete a container for it.
    runuser -u "$ASTERISM_USER" -- "$NODE_BIN" project register \
        --project-id "$PROJECT_ID" --workspace "$WORKSPACE" \
        --display-name "$NODE_NAME" --node-home "$NODE_HOME" \
        --external-runtime --runtime-endpoint "$HERMES_ENDPOINT" >/dev/null ||
        die "registering project $PROJECT_ID failed"
    ok "project $PROJECT_ID registered with runtime_ownership=external"
}

# The exact command an operator repeats by hand, kept in one place so the
# skip message and the failure message cannot drift apart.
codex_login_hint() {
    printf 'sudo -u %s env HOME=%s CODEX_HOME=%s/.codex %s/bin/codex login --device-auth' \
        "$ASTERISM_USER" "$STATE_DIR" "$HERMES_HOME" "$CODEX_DIR"
}

# Codex refuses to load its configuration when CODEX_HOME does not exist, so the
# directory is created whether or not authorization is run now — otherwise the
# command printed in the summary fails for anyone who defers it.
ensure_codex_home() {
    install -d -o "$ASTERISM_USER" -g "$ASTERISM_GROUP" -m 0700 "$HERMES_HOME/.codex"
}

authorize_provider() {
    step "Model provider authorization"
    if [ -f "$HERMES_HOME/.codex/auth.json" ]; then
        CODEX_AUTHORIZED=true
        ok "openai-codex authorization already present"
        return
    fi
    log "  Codex will print a URL and a code. Open the URL in any browser, enter"
    log "  the code, and approve. Nothing is pasted back into this terminal and no"
    log "  token is ever printed here."
    ensure_codex_home
    if ! confirm "Run the Codex device authorization now?"; then
        CODEX_AUTHORIZED=false
        warn "skipped; run '$(codex_login_hint)' later"
        return
    fi
    runuser -u "$ASTERISM_USER" -- env HOME="$STATE_DIR" \
        CODEX_HOME="$HERMES_HOME/.codex" \
        "$CODEX_DIR/bin/codex" login --device-auth < /dev/tty > /dev/tty 2>&1 ||
        warn "authorization did not complete"
    if [ -f "$HERMES_HOME/.codex/auth.json" ]; then
        CODEX_AUTHORIZED=true
        chmod 0600 "$HERMES_HOME/.codex/auth.json"
        ok "openai-codex authorized"
    else
        CODEX_AUTHORIZED=false
        warn "no credential was written; Hermes will run but cannot reach the provider"
        warn "run '$(codex_login_hint)' to retry"
    fi
}

# ---------------------------------------------------------------------------
# Service start and health
# ---------------------------------------------------------------------------

wait_for_hermes() {
    local deadline=$((SECONDS + 180))
    while [ "$SECONDS" -lt "$deadline" ]; do
        if curl -fsS --max-time 5 -o /dev/null "$HERMES_ENDPOINT/health" 2>/dev/null; then
            return 0
        fi
        systemctl is-active --quiet asterism-hermes.service ||
            { warn "asterism-hermes.service stopped; see journalctl -u asterism-hermes"; return 1; }
        sleep 3
    done
    return 1
}

wait_for_node() {
    local deadline=$((SECONDS + 90))
    while [ "$SECONDS" -lt "$deadline" ]; do
        if runuser -u "$ASTERISM_USER" -- "$NODE_BIN" node status \
            --node-home "$NODE_HOME" >/dev/null 2>&1; then
            return 0
        fi
        systemctl is-active --quiet asterism-node.service ||
            { warn "asterism-node.service stopped; see journalctl -u asterism-node"; return 1; }
        sleep 3
    done
    return 1
}

# The connection state the Node reports for its outbound Control Plane session.
control_plane_state() {
    runuser -u "$ASTERISM_USER" -- "$NODE_BIN" node status --node-home "$NODE_HOME" 2>/dev/null |
        awk '/"control_plane"/ { inside = 1 }
             inside && /"state"/ {
                 gsub(/[",]/, "")
                 print $2
                 exit
             }'
}

start_services() {
    step "Starting services"
    systemctl enable --quiet asterism-hermes.service asterism-node.service
    systemctl restart asterism-hermes.service
    if wait_for_hermes; then
        ok "Hermes healthy at $HERMES_ENDPOINT"
        HERMES_STATE=healthy
    else
        HERMES_STATE=unhealthy
        die "Hermes did not become healthy within 180s; journalctl -u asterism-hermes"
    fi

    systemctl restart asterism-node.service
    if wait_for_node; then
        ok "Node daemon responding"
        NODE_STATE=running
    else
        NODE_STATE=unavailable
        die "the Node daemon did not become reachable; journalctl -u asterism-node"
    fi

    # The outbound Control Plane session is what makes the Node usable; a
    # daemon that runs but never connects is not a successful installation.
    local deadline=$((SECONDS + 60))
    CONNECTION_STATE=unknown
    while [ "$SECONDS" -lt "$deadline" ]; do
        CONNECTION_STATE=$(control_plane_state)
        [ "$CONNECTION_STATE" = connected ] && break
        sleep 3
    done
    if [ "$CONNECTION_STATE" = connected ]; then
        ok "outbound Control Plane session established"
    else
        warn "the Control Plane session is '${CONNECTION_STATE:-unreported}'; journalctl -u asterism-node"
    fi
}

verify_registration() {
    step "Verification"
    PROJECT_STATUS=$(runuser -u "$ASTERISM_USER" -- bash -c '
        set -a; . "$1"; set +a
        exec "$2" project status --project-id "$3"' _ \
        "$ENV_FILE" "$NODE_BIN" "$PROJECT_ID" 2>&1) ||
        die "project status failed: $PROJECT_STATUS"
    printf '%s\n' "$PROJECT_STATUS" | sed 's/^/    /'
    printf '%s' "$PROJECT_STATUS" | grep -q '"runtime_ownership": "external"' ||
        die "the project is not registered as an external runtime"
    if printf '%s' "$PROJECT_STATUS" | grep -q '"runtime_health": "ok"'; then
        ok "project $PROJECT_ID reports an external, reachable runtime"
    else
        die "project $PROJECT_ID is registered but its runtime did not answer a health probe"
    fi
}

write_metadata() {
    # Resolved versions, recorded so an operator can tell what is installed
    # without re-deriving it. No secret is written here.
    cat > "$METADATA_FILE" <<EOF
{
  "installer_version": "1",
  "installed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "asterism_node_version": "$ASTERISM_VERSION",
  "asterism_node_sha256": "${NODE_CHECKSUM:-unknown}",
  "hermes_version": "$HERMES_VERSION",
  "hermes_source_image": "$HERMES_SOURCE_IMAGE",
  "uv_version": "$UV_VERSION",
  "python_version": "$PYTHON_VERSION",
  "sqlite_version": "${SQLITE_VERSION:-unknown}",
  "journal_mode": "${JOURNAL_MODE:-unknown}",
  "docker_version": "${DOCKER_VERSION:-unknown}",
  "compose_version": "${COMPOSE_VERSION:-unknown}",
  "codex_cli_version": "${CODEX_VERSION:-unknown}",
  "control_plane": "$CONTROL_PLANE",
  "node_name": "$NODE_NAME",
  "project_id": "$PROJECT_ID",
  "workspace": "$WORKSPACE",
  "runtime_endpoint": "$HERMES_ENDPOINT",
  "runtime_ownership": "external"
}
EOF
    chmod 0640 "$METADATA_FILE"
    chown root:"$ASTERISM_GROUP" "$METADATA_FILE"
}

summary() {
    printf '\n'
    printf 'Asterism installed successfully\n'
    printf 'Node: %s (daemon %s)\n' "${CONNECTION_STATE:-unknown}" "${NODE_STATE:-unknown}"
    printf 'Hermes: %s\n' "${HERMES_STATE:-unknown}"
    printf 'Project: registered\n'
    if [ "${CODEX_AUTHORIZED:-false}" = true ]; then
        printf 'Provider: openai-codex authorized\n'
    else
        printf 'Provider: openai-codex NOT authorized\n'
        printf '  authorize with: %s\n' "$(codex_login_hint)"
    fi
    printf 'Workspace: %s\n' "$WORKSPACE"
    printf 'Control Plane: %s\n' "$CONTROL_PLANE"
    printf '\n'
    printf 'SQLite %s, journal mode %s\n' "${SQLITE_VERSION:-unknown}" "${JOURNAL_MODE:-unknown}"
    printf 'Logs:   journalctl -u asterism-node -u asterism-hermes -f\n'
    printf 'Status: sudo bash install.sh --doctor\n'
}

# ---------------------------------------------------------------------------
# Doctor
# ---------------------------------------------------------------------------

# Reports without repairing. A diagnostic that changes the system cannot be run
# safely on a host that is already misbehaving.
doctor() {
    local failures=0
    step "Asterism doctor"
    check_root
    check_os; ok "platform supported"

    [ -x "$NODE_BIN" ] && ok "Node binary: $("$NODE_BIN" --version 2>/dev/null)" ||
        { warn "Node binary missing at $NODE_BIN"; failures=$((failures + 1)); }
    [ -x "$HERMES_DIR/.venv/bin/hermes" ] && ok "Hermes present at $HERMES_DIR" ||
        { warn "Hermes environment missing"; failures=$((failures + 1)); }

    if [ -f "$ENV_FILE" ]; then
        local mode
        mode=$(stat -c '%a %U:%G' "$ENV_FILE")
        [ "$mode" = "640 root:$ASTERISM_GROUP" ] && ok "credentials file $mode" ||
            { warn "credentials file has unexpected mode/owner: $mode"; failures=$((failures + 1)); }
        HERMES_ENDPOINT=$(awk -F= '$1=="ASTERISM_HERMES_URL" {print $2}' "$ENV_FILE")
    else
        warn "no credentials file at $ENV_FILE"; failures=$((failures + 1))
    fi

    local unit
    for unit in asterism-hermes asterism-node; do
        if systemctl is-active --quiet "$unit.service"; then
            ok "$unit.service active"
        else
            warn "$unit.service is $(systemctl is-active "$unit.service" 2>/dev/null || printf 'absent')"
            failures=$((failures + 1))
        fi
    done

    if [ -n "${HERMES_ENDPOINT:-}" ] && curl -fsS --max-time 5 -o /dev/null "$HERMES_ENDPOINT/health" 2>/dev/null; then
        ok "Hermes healthy at $HERMES_ENDPOINT"
    else
        warn "Hermes is not answering on ${HERMES_ENDPOINT:-its endpoint}"; failures=$((failures + 1))
    fi

    # A public listener would contradict the documented topology, so the bind
    # address is checked rather than asserted.
    local hermes_port bind
    hermes_port=$(awk -F= '$1=="ASTERISM_HERMES_PORT" {print $2}' "$ENV_FILE" 2>/dev/null)
    if [ -n "$hermes_port" ]; then
        bind=$(ss -ltn "sport = :$hermes_port" 2>/dev/null | awk 'NR>1 {print $4}' | head -1)
        case "$bind" in
            127.0.0.1:*|"[::1]:"*) ok "Hermes listens on loopback only ($bind)" ;;
            "") warn "nothing is listening on port $hermes_port"; failures=$((failures + 1)) ;;
            *) warn "Hermes is listening on $bind, not loopback"; failures=$((failures + 1)) ;;
        esac
    fi

    if [ -f "$METADATA_FILE" ]; then
        ok "installation metadata:"
        sed 's/^/    /' "$METADATA_FILE"
    fi

    [ "$failures" -eq 0 ] && { printf '\nAll checks passed.\n'; return 0; }
    printf '\n%d check(s) failed.\n' "$failures"
    return 1
}

usage() {
    cat <<'EOF'
Asterism VPS installer

  sudo bash install.sh              install or repair
  sudo bash install.sh --doctor     report status, change nothing
  bash install.sh --help            this message

Supported platform: Ubuntu 24.04 LTS, linux/amd64, systemd.
EOF
}

main() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --doctor) MODE=doctor ;;
            --help|-h) usage; exit 0 ;;
            *) die "unknown option: $1" ;;
        esac
        shift
    done

    if [ "$MODE" = doctor ]; then
        doctor
        exit $?
    fi

    WORKSPACE="$WORKSPACE_DEFAULT"
    preflight
    collect_settings
    create_user
    install_docker
    install_node_binary
    install_hermes
    configure_sqlite
    write_env_file
    write_hermes_config
    write_units
    enroll_node
    register_project
    authorize_provider
    start_services
    verify_registration
    write_metadata
    summary
}

# Sourcing the script exposes its functions to the test suite without running an
# installation, which is what makes the pure logic here directly testable.
if [ "${ASTERISM_INSTALL_LIB_ONLY:-0}" != "1" ]; then
    main "$@"
fi
