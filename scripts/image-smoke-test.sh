#!/usr/bin/env bash
#
# Smoke test for the Asterism project runtime image.
#
# Proves the contract Asterism Node depends on, without contacting a model
# provider and without any credential. Everything here is checkable from the
# image alone, so it runs identically on a laptop and in CI.
#
# Usage:
#   scripts/image-smoke-test.sh <image-reference>
#
# The reference may be a tag or a digest. A digest is preferred.
set -euo pipefail

image="${1:-}"
if [[ -z "$image" ]]; then
    echo "usage: $0 <image-reference>" >&2
    exit 64
fi

# Mirrors HERMES_UID/HERMES_GID that ProjectContainerSpec::create_args passes.
runtime_uid=1000
runtime_gid=1000

# Expected pinned components. Kept in sync with docker/Dockerfile.codex.
expected_codex_version="0.147.0"

failures=0
pass() { printf '  %-42s PASS  %s\n' "$1" "${2:-}"; }
fail() { printf '  %-42s FAIL  %s\n' "$1" "${2:-}"; failures=$((failures + 1)); }

inspect() { docker image inspect "$image" --format "$1"; }
label() { inspect "{{index .Config.Labels \"$1\"}}"; }

workdir="$(mktemp -d)"
container=""
cleanup() {
    [[ -n "$container" ]] && docker rm -f "$container" >/dev/null 2>&1 || true
    # The container entrypoint chowns the state directory to the runtime uid, so
    # the invoking user often cannot delete it. Remove it from inside a throwaway
    # container that can.
    if [[ -d "$workdir" ]]; then
        docker run --rm --user 0:0 -v "$workdir:/cleanup" --entrypoint sh \
            "$image" -c 'rm -rf /cleanup/..?* /cleanup/.[!.]* /cleanup/*' >/dev/null 2>&1 || true
        rm -rf "$workdir" 2>/dev/null || true
    fi
}
trap cleanup EXIT

printf 'Image smoke test: %s\n\n' "$image"

# ------------------------------------------------------------------ metadata
echo 'Image metadata'

arch="$(inspect '{{.Architecture}}/{{.Os}}')"
if [[ "$arch" == "amd64/linux" ]]; then
    pass 'architecture is linux/amd64' "$arch"
else
    # Only linux/amd64 is built and tested. Anything else is unverified.
    fail 'architecture is linux/amd64' "got $arch"
fi

for key in \
    org.opencontainers.image.title \
    org.opencontainers.image.description \
    org.opencontainers.image.source \
    org.opencontainers.image.revision \
    org.opencontainers.image.version \
    org.opencontainers.image.created \
    io.asterism.component \
    io.asterism.codex-version \
    io.asterism.hermes-base; do
    value="$(label "$key")"
    if [[ -n "$value" && "$value" != "<no value>" ]]; then
        pass "label $key" "${value:0:52}"
    else
        fail "label $key" 'missing'
    fi
done

# Asterism has no selected license, so asserting one would be false.
licenses_label="$(label org.opencontainers.image.licenses)"
if [[ -z "$licenses_label" || "$licenses_label" == "<no value>" ]]; then
    pass 'no false Asterism license label' 'absent as intended'
else
    fail 'no false Asterism license label' "present: $licenses_label"
fi

# A mutable base would make the published image unreproducible.
hermes_base="$(label io.asterism.hermes-base)"
if [[ "$hermes_base" == *"@sha256:"* ]]; then
    pass 'Hermes base is digest-pinned' "${hermes_base##*@}"
else
    fail 'Hermes base is digest-pinned' "$hermes_base"
fi

echo

# ------------------------------------------------------------------ contents
echo 'Bundled software'

codex_version="$(docker run --rm --user "$runtime_uid:$runtime_gid" \
    --entrypoint codex "$image" --version 2>/dev/null || true)"
if [[ "$codex_version" == *"$expected_codex_version"* ]]; then
    pass 'Codex CLI present at pinned version' "$codex_version"
else
    fail 'Codex CLI present at pinned version' "got '${codex_version:-nothing}'"
fi

if docker run --rm --user "$runtime_uid:$runtime_gid" --entrypoint sh "$image" \
        -c 'test -x /opt/hermes/.venv/bin/hermes' 2>/dev/null; then
    pass 'Hermes command exists and is executable' '/opt/hermes/.venv/bin/hermes'
else
    fail 'Hermes command exists and is executable'
fi

# Third-party notices must travel with the image, not only the repository.
if docker run --rm --entrypoint sh "$image" -c \
        'test -s /opt/hermes/LICENSE && grep -qi "MIT" /opt/hermes/LICENSE' 2>/dev/null; then
    pass 'Hermes MIT notice retained' '/opt/hermes/LICENSE'
else
    fail 'Hermes MIT notice retained'
fi
if docker run --rm --entrypoint sh "$image" -c \
        'test -s /opt/asterism/third-party/THIRD_PARTY_NOTICES.md &&
         test -s /opt/asterism/third-party/LICENSE.Apache-2.0.txt' 2>/dev/null; then
    pass 'third-party notices bundled' '/opt/asterism/third-party/'
else
    fail 'third-party notices bundled'
fi

echo

# ------------------------------------------------------------------- runtime
echo 'Runtime layout'

if docker run --rm --entrypoint sh "$image" -c 'test -d /opt/data' 2>/dev/null; then
    pass 'persistent Hermes state dir exists' '/opt/data'
else
    fail 'persistent Hermes state dir exists' '/opt/data missing'
fi

# `/workspace` is supplied by the Node bind mount rather than baked in. Prove the
# mount point works for the runtime user, which is what actually matters.
#
# The probe directory is given explicit permissions: `mktemp -d` is 0700, so
# without this the check would silently pass only when the invoking user happens
# to share the runtime uid, and fail on any CI runner that does not.
probe_dir="$workdir/workspace"
mkdir -p "$probe_dir"
chmod 0755 "$workdir" "$probe_dir"
echo 'workspace probe' >"$probe_dir/probe.txt"
chmod 0644 "$probe_dir/probe.txt"
if docker run --rm --user "$runtime_uid:$runtime_gid" \
        -v "$probe_dir:/workspace:ro" --entrypoint sh "$image" \
        -c 'test -r /workspace/probe.txt' 2>/dev/null; then
    pass 'workspace mount readable by runtime user' '/workspace'
else
    fail 'workspace mount readable by runtime user'
fi

if docker run --rm --entrypoint sh "$image" -c 'test ! -S /var/run/docker.sock' 2>/dev/null; then
    pass 'no Docker socket in the image' 'absent'
else
    fail 'no Docker socket in the image' 'present'
fi

# The image must not ship a configuration that turns off the approval control
# point. Native Codex App-Server stays experimental and off by default.
if docker run --rm --entrypoint sh "$image" -c '
        for f in /opt/hermes/config.yaml /opt/data/config.yaml; do
            [ -f "$f" ] || continue
            grep -Eq "^[[:space:]]*mode:[[:space:]]*(off|none)" "$f" && exit 1
            grep -Eq "^[[:space:]]*openai_runtime:[[:space:]]*codex_app_server" "$f" && exit 1
        done
        exit 0' 2>/dev/null; then
    pass 'no baked-in Codex approval bypass' 'approvals not disabled'
else
    fail 'no baked-in Codex approval bypass'
fi

echo

# -------------------------------------------------------------------- health
echo 'Health'

api_key="smoke-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
port="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
container="asterism-image-smoke-$$"

# Unprivileged on purpose: the real project container never needs more.
docker run -d --name "$container" \
    --user root \
    --cap-drop ALL \
    --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
    --cap-add SETGID --cap-add SETUID \
    --security-opt no-new-privileges:true \
    -e "HERMES_UID=$runtime_uid" -e "HERMES_GID=$runtime_gid" \
    -e API_SERVER_ENABLED=true -e API_SERVER_HOST=0.0.0.0 -e API_SERVER_PORT=8642 \
    -e "API_SERVER_KEY=$api_key" \
    -e HERMES_HOME=/opt/data -e CODEX_HOME=/opt/data/codex \
    -e HERMES_WRITE_SAFE_ROOT=/workspace:/opt/data \
    -v "$workdir/state:/opt/data" -v "$probe_dir:/workspace" \
    -w /workspace \
    -p "127.0.0.1:$port:8642" \
    "$image" gateway >/dev/null

ready=0
for _ in $(seq 1 60); do
    if curl -4 -sf -m 3 -o /dev/null "http://127.0.0.1:$port/health" \
            -H "X-API-Key: $api_key" 2>/dev/null; then
        ready=1
        break
    fi
    sleep 2
done
if [[ "$ready" -eq 1 ]]; then
    pass 'health endpoint becomes ready' "127.0.0.1:$port/health"
else
    fail 'health endpoint becomes ready' 'timed out after 120s'
    docker logs "$container" 2>&1 | tail -15 | sed 's/^/      /'
fi

if [[ "$(docker inspect "$container" --format '{{.HostConfig.Privileged}}')" == "false" ]]; then
    pass 'runs unprivileged' 'privileged=false'
else
    fail 'runs unprivileged'
fi

# The entrypoint must drop from root to the requested runtime uid.
hermes_owner="$(docker exec "$container" sh -c 'stat -c %u /opt/data' 2>/dev/null || echo '')"
if [[ "$hermes_owner" == "$runtime_uid" ]]; then
    pass 'state dir owned by the runtime uid' "uid $hermes_owner"
else
    fail 'state dir owned by the runtime uid' "got '${hermes_owner:-unknown}'"
fi

echo
if [[ "$failures" -gt 0 ]]; then
    printf 'FAILED: %d smoke check(s).\n' "$failures"
    exit 1
fi
printf 'PASSED: image smoke test is clean.\n'
