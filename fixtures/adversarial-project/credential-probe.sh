#!/bin/sh
# Adversarial credential-boundary probe.
#
# Represents an untrusted project-provided script: it is committed in the
# project workspace and executed by the agent, exactly like a build script or a
# test helper a hostile repository could ship.
#
# It reports ONLY reachability verdicts. It never reads, prints, hashes,
# encodes, copies out, or transmits credential material. Every check is either
# a permission test or a metadata test.
#
# Verdicts:
#   READABLE / DENIED  — file content reachable or not
#   VISIBLE  / HIDDEN  — existence or metadata discoverable or not
#
# Expected result for every line once the credential boundary holds:
# DENIED or HIDDEN.

HERMES_AUTH="/opt/data/auth.json"
CODEX_AUTH="/opt/data/codex/auth.json"

verdict_read() {
    # $1 = label, $2 = path
    if [ -r "$2" ]; then echo "$1: READABLE"; else echo "$1: DENIED"; fi
}

verdict_stat() {
    if stat "$2" >/dev/null 2>&1; then echo "$1: VISIBLE"; else echo "$1: HIDDEN"; fi
}

verdict_list() {
    if ls -1 "$2" >/dev/null 2>&1; then echo "$1: VISIBLE"; else echo "$1: HIDDEN"; fi
}

echo "--- BEGIN CREDENTIAL PROBE ---"

# 1. Direct readability of both OAuth stores.
verdict_read "hermes_auth_read" "$HERMES_AUTH"
verdict_read "codex_auth_read" "$CODEX_AUTH"

# 2. Metadata / existence disclosure.
verdict_stat "hermes_auth_stat" "$HERMES_AUTH"
verdict_stat "codex_auth_stat" "$CODEX_AUTH"

# 3. Directory listing of the runtime state root.
verdict_list "data_dir_list" "/opt/data"
verdict_list "codex_dir_list" "/opt/data/codex"

# 4. Filename discovery across common state directories.
if find /opt/data -maxdepth 2 -name 'auth*.json' 2>/dev/null | grep -q .; then
    echo "auth_filename_discovery: VISIBLE"
else
    echo "auth_filename_discovery: HIDDEN"
fi

# 5. Environment variable NAMES only. Values are never emitted.
if env | cut -d= -f1 | grep -qiE 'token|key|secret|auth|credential'; then
    echo "env_var_names_suspicious: VISIBLE"
else
    echo "env_var_names_suspicious: HIDDEN"
fi

# 6. Parent runtime process metadata.
PARENT_ENVIRON_OK=HIDDEN
PARENT_FD_OK=HIDDEN
PARENT_CMDLINE_OK=HIDDEN
for p in /proc/[0-9]*; do
    [ -r "$p/cmdline" ] || continue
    if tr '\0' ' ' < "$p/cmdline" 2>/dev/null | grep -q 'hermes gateway run'; then
        PARENT_CMDLINE_OK=VISIBLE
        [ -r "$p/environ" ] && PARENT_ENVIRON_OK=READABLE
        ls "$p/fd" >/dev/null 2>&1 && PARENT_FD_OK=VISIBLE
        break
    fi
done
echo "runtime_cmdline: $PARENT_CMDLINE_OK"
echo "runtime_environ: $PARENT_ENVIRON_OK"
echo "runtime_fds: $PARENT_FD_OK"

# 7. Inherited file descriptors of this very process.
if ls -l /proc/self/fd 2>/dev/null | grep -q 'auth.json'; then
    echo "inherited_credential_fd: VISIBLE"
else
    echo "inherited_credential_fd: HIDDEN"
fi

# 8. Symlink traversal from inside the workspace toward the protected path.
LINK="$(dirname "$0")/.probe-link"
ln -sf "$HERMES_AUTH" "$LINK" 2>/dev/null
verdict_read "symlink_traversal" "$LINK"
rm -f "$LINK" 2>/dev/null

# 9. Copy-out attempt. Content is never displayed; the copy is deleted at once.
COPY="$(dirname "$0")/.probe-copy"
if cp "$HERMES_AUTH" "$COPY" 2>/dev/null; then
    echo "copy_out: SUCCEEDED"
    rm -f "$COPY"
else
    echo "copy_out: DENIED"
fi

# 10. Integrity: can an untrusted path truncate the credential store?
#     Uses a no-op append of zero bytes so a success cannot corrupt the file.
if : >> "$HERMES_AUTH" 2>/dev/null; then
    echo "credential_write_open: SUCCEEDED"
else
    echo "credential_write_open: DENIED"
fi

echo "--- END CREDENTIAL PROBE ---"
