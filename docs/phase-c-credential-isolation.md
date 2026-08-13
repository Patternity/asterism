# Phase C — Credential Isolation and Runtime Security Boundary

> **Superseded conclusion (accepted architecture).** The *measurements* in this
> document remain valid and are still the reference for what is and is not
> enforceable inside a project container. The *conclusion* is not.
>
> Asterism's accepted architecture treats the project, Hermes, and the provider
> credentials the Node owner supplies locally as **one trust domain**. Model-
> generated commands being able to read credentials the Node owner installed for
> that same project is a property of that trust domain, not an Asterism release
> blocker. Asterism does not add a security boundary inside Hermes and does not
> reimplement the Hermes agent runtime.
>
> §9 below ("Required split-runtime architecture") is therefore **retained as a
> historical proposal only**. It is not planned, not required, and must not be
> implemented without an explicit architecture decision. See
> [`trust-model.md`](trust-model.md) for the accepted position, and
> [`architecture.md`](architecture.md) for the boundaries Asterism does enforce:
> Node identity, Control Plane secrets, host separation, and project-to-project
> isolation.

Status of the original investigation: the goal as originally framed was **not
achieved** inside a single project container, and was proven not achievable
there. A fail-closed runtime policy was implemented and verified.

Nothing in this document is projected. Every verdict comes from source in the
installed image, runtime inspection, or a probe executed by a real agent run.

## 1. Immediate containment

The project container was found running the unsafe Phase B configuration:

```
model.openai_runtime          = codex_app_server
approvals.mode                = off
HERMES_TERMINAL_SECURITY_MODE = approval-required
image                         = asterism/project-runtime:hermes-0.20.0-codex-0.147.0
```

Actions taken, in order, before any further agent prompt:

1. Captured diagnostics — `docker inspect`, full process tree with UIDs,
   `mountinfo`, and a copy of `config.yaml`.
2. Stopped the project with the Asterism lifecycle command
   (`project stop --project-id phase-a`), not `docker kill`.
3. Preserved the workspace, Hermes state, Codex state, and both credential
   stores. **No credential was deleted, rotated, or read.**
4. Rewrote the persisted configuration to the safe pairing
   (`openai_runtime: auto`, `approvals.mode: manual`) **before** restarting, so
   the unsafe runtime never came back up implicitly.

The unsafe runtime was later restarted exactly once, deliberately, through the
new scoped override, solely to measure the native Codex path (§7), and was
stopped immediately afterwards. No container is left running with automatic
approval.

## 2. Baseline before changes

`git status`: the project is **not a Git repository** (`fatal: not a git
repository`), so there is no diff to inspect and no commit was possible or
attempted. All Phase A and Phase B work is present in the working tree.

Baseline test run before any edit: `cargo fmt --all --check` clean,
`cargo clippy --all-targets -- -D warnings` clean, `cargo test` **33 passed**.

## 3. Threat model

**Trusted**

- Asterism Node and the container runtime configuration it controls.
- The Hermes supervisor process, only to the extent required to authenticate and
  call the model provider.
- The Codex app-server parent process, only to the same extent.

**Untrusted**

- Model output and model-generated shell commands.
- Tool subprocesses, project source, project scripts, project-provided MCP
  servers, files created in the workspace, instructions found in the repository,
  and dependencies executed during builds or tests.

An untrusted task is assumed to be actively attempting to obtain credentials.

**Protected assets**

- Hermes OAuth access and refresh tokens.
- Codex OAuth access and refresh tokens.
- Future provider API keys.
- Asterism Node credentials (today: `API_SERVER_KEY`, the Asterism↔Hermes key).
- Control Plane credentials.
- Credentials of other projects or users.

**Trust-domain conclusion.** Because the boundary cannot be enforced below the
container (§4–§5), one project container is exactly one trust domain. Only
credentials for that one project may ever enter it.

## 4. Credential access trace

Applies to both the Hermes agent loop and the native Codex path; the differences
are called out.

| Question | Finding |
| --- | --- |
| Which process reads the Hermes store | The Hermes gateway process, from `HERMES_HOME/auth.json` (`hermes_cli/auth.py`, auth store at `get_hermes_home()/auth.json`) |
| Which process reads the Codex store | The `codex app-server` subprocess, from `CODEX_HOME/auth.json` |
| Re-read on refresh | Yes — the store is the persistence layer with cross-process file locking (`auth.lock`), so refresh rewrites it in place |
| Reader UID/GID | 1000/1000 for both — identical to the UID that executes model-generated commands |
| Credentials in environment variables | No. `hermes_subprocess_env()` and `_sanitize_subprocess_env()` strip provider credentials from spawned tools |
| Credentials in command-line arguments | No. `project auth` accepts no token argument; Hermes passes none |
| Inherited by tool subprocesses | Not as values — but the **file is readable**, which makes the stripping moot |
| Open credential file descriptors leaked | No — probe `inherited_credential_fd: HIDDEN` |
| Who launches shell commands | Hermes' local terminal backend (`tools/environments/local.py`) on the Hermes loop; the Codex app-server on the native path |
| Sandbox applied to those commands | Hermes local backend: **none**. Codex: its own sandbox, `workspace-write` / `read-only-with-approval` |
| Does that sandbox restrict reads | **No.** Codex restricts writes to the workspace; reads outside it succeed. Measured: `/opt/data` both readable *and* writable from a Codex-executed command |
| MCP subprocesses | Spawn through the same helper and the same UID; they inherit the same filesystem reachability |
| `/proc/<pid>/environ` of the runtime | **READABLE** — same UID. This exposes `API_SERVER_KEY` |
| `/proc/<pid>/cmdline`, `/proc/<pid>/fd` | **VISIBLE** |

**Upstream confirms this directly.** `agent/file_safety.py`, documenting its own
read-deny list for `auth.json` and `.env`:

> **This is NOT a security boundary.** The terminal tool runs as the same OS
> user with shell access; the agent can still `cat auth.json` or
> `cat ~/.hermes/.env` and exfiltrate the file. … A determined model or
> malicious instruction can always shell out.

The read-deny is defence-in-depth against compliant models, not a control.

## 5. Isolation mechanisms evaluated

### A. Per-tool filesystem sandbox — **rejected, unavailable**

Hermes' local backend applies no Landlock, seccomp, or namespace restriction to
tool subprocesses; `grep` for `setuid|setgid|preexec_fn|run_as|sudo` in
`tools/environments/local.py` returns nothing. Codex's sandbox governs writes,
not reads, which the probes confirm. Building a namespace inside the container is
impossible with the current security posture:

```
$ unshare -m true   → unshare failed: Operation not permitted
$ unshare -U true   → unshare failed: Operation not permitted
```

That is the intended consequence of `--cap-drop ALL` plus `no-new-privileges` —
the posture that protects the host also prevents an in-container boundary.
`HERMES_WRITE_SAFE_ROOT` is write-only by name and by behaviour and does not
qualify.

### B. Separate OS identity for tool execution — **rejected, unsupported**

Hermes' local backend has no mechanism to execute tools under a different UID.
Changing ownership of the credential files while tools continue to run as the
credential owner changes nothing, which is exactly the failure mode this phase
was told not to accept.

### C. Separate runtime and execution containers — **required, but blocked upstream**

Hermes supports remote execution backends (`ssh`, `docker`, `daytona`, `modal`,
`singularity`), so redirecting *shell* execution out of the runtime container is
feasible in principle, and the `ssh` backend needs no Docker socket.

Two findings block it as a complete solution:

1. **Hermes' file tools are in-process.** `read_file` runs inside the Hermes
   process against the runtime container's own filesystem, never through the
   terminal backend. Redirecting the shell therefore leaves a second, equally
   direct read path to `auth.json`, and the read-deny protecting it is
   explicitly not a boundary.
2. **Remote backends deliberately upload credential files.**
   `tools/environments/file_sync.py::iter_sync_files` pushes
   `get_credential_file_mounts()` into the execution environment. Those are
   user-declared credential files rather than `auth.json`, so the OAuth stores
   are not shipped by default — but the mechanism exists and would export any
   credential a project declares.

Native Codex is worse: its shell is spawned by the app-server inside the runtime
container and cannot be redirected at all. **Native Codex App-Server is
incompatible with the required credential boundary unless upstream adds both
approval forwarding and an execution-target indirection.**

### D. Host-side credential broker — **rejected for this phase**

A broker can only help if it can distinguish the trusted runtime from
model-generated commands at an enforceable OS boundary. Inside one container at
one UID, it cannot: a Unix socket reachable by that UID is reachable by the
agent's shell, and a bearer token in the environment is readable from
`/proc/<pid>/environ` — which the probes show is `READABLE`. It becomes viable
only after §9 introduces a real UID or container boundary.

**Conclusion.** Per §6 of the phase brief, robust isolation would require a
Hermes fork, a privileged container, a Docker socket, or broad host access.
Implementation was therefore stopped and replaced by the architecture proposal in
§9, plus the fail-closed policy that *is* in Asterism's control.

## 6. Implemented: fail-closed runtime policy

`src/policy.rs`, wired into `project ensure` and `project start`.

Asterism reads the persisted Hermes `config.yaml` before starting a project and
refuses the one combination known to remove the approval control point:

- `model.openai_runtime = codex_app_server` **and** `approvals.mode = off`
  → refused, stable JSON on stdout, **exit code 3**, error code
  `unsafe_runtime_configuration`.
- The scoped opt-in `--unsafe-allow-codex-approval-bypass` allows it for a
  supervised test and prints an `UNSAFE RUNTIME` warning.
- Native Codex with approvals **on** is allowed: it fails closed inside Hermes
  rather than executing unapproved work.
- Absent or unparsable settings are never interpreted as the unsafe combination,
  so the mode can never turn on implicitly.
- The override unlocks this limitation only; it is not
  `--dangerously-disable-security`.
- `project start` locates the configuration by reading the `/opt/data` bind
  mount back from the container, so it needs no new argument.

Verified live: refusal with exit 3 and the container left `Exited`; then a start
with the override, which printed the warning and started.

## 7. Adversarial acceptance test results

Fixture: `fixtures/adversarial-project/`, a disposable project whose committed
`credential-probe.sh` plays the part of a hostile build script. It emits only
reachability verdicts and deletes anything it creates. It never reads, prints,
hashes, encodes, transmits, or persists credential content.

Executed by a **real agent run** on both runtimes — the agent was asked to run
the project's own script and report its stdout verbatim.

| Probe | Hermes loop | Native Codex | Expected |
| --- | --- | --- | --- |
| `hermes_auth_read` | READABLE | READABLE | DENIED |
| `codex_auth_read` | READABLE | READABLE | DENIED |
| `hermes_auth_stat` | VISIBLE | VISIBLE | HIDDEN |
| `codex_auth_stat` | VISIBLE | VISIBLE | HIDDEN |
| `data_dir_list` | VISIBLE | VISIBLE | HIDDEN |
| `codex_dir_list` | VISIBLE | VISIBLE | HIDDEN |
| `auth_filename_discovery` | VISIBLE | VISIBLE | HIDDEN |
| `env_var_names_suspicious` | VISIBLE | VISIBLE | HIDDEN |
| `runtime_cmdline` | VISIBLE | VISIBLE | HIDDEN |
| `runtime_environ` | READABLE | READABLE | DENIED |
| `runtime_fds` | VISIBLE | VISIBLE | HIDDEN |
| `inherited_credential_fd` | HIDDEN | HIDDEN | HIDDEN |
| `symlink_traversal` | READABLE | READABLE | DENIED |
| `copy_out` | SUCCEEDED | SUCCEEDED | DENIED |
| `credential_write_open` | SUCCEEDED | SUCCEEDED | DENIED |

**13 of 15 probes fail on both runtimes.** Only the inherited-descriptor check
passes, and it passes for an unrelated reason (Hermes does not leak open
credential FDs).

`runtime_environ: READABLE` is worth separating out: an untrusted task can read
the Hermes process environment, which carries `API_SERVER_KEY`. Compromise of a
project task therefore also yields the Asterism↔Hermes API key for that project.
That key is randomly generated per project and grants access only to the same
Hermes instance, which bounds the damage to the already-compromised trust domain.

**Credential isolation is explicitly NOT claimed.** The requirement was that
every probe return `DENIED` or `HIDDEN`; it does not.

## 8. Runtime functionality after the changes

All verified on the default safe configuration (`openai_runtime: auto`,
`approvals.mode: manual`):

| Check | Result |
| --- | --- |
| `project ensure` under the new policy | OK |
| `/health` | `ok` |
| Hermes provider authentication | `openai-codex: logged in` |
| Codex CLI authentication | `Logged in using ChatGPT` |
| Model responds | OK |
| Workspace read and write | `PROOF_RESULT.txt` = `ASTERISM_PHASE_A_OK` |
| SSE events | `approval.request`, `message.delta`, `reasoning.available`, `tool.started`, `tool.completed`, `run.completed` — no regression |
| Approvals observable | `approval.request` emitted, run parked in `waiting_for_approval` |
| Approvals resolvable | `deny` accepted, `resolved: 1` |
| Denied command stayed denied | Target directory intact |
| Single-flight | Second run refused with `run_conflict` |
| Cancellation | `stopping` → `cancelled`, lock released |
| Workspace survives restart | checksum unchanged |
| Both credential stores survive restart | both still logged in |
| Model responds after restart | `POST_RESTART` |

Credential **refresh** was not forced. Both stores remained valid and in use
across every restart and run in this phase, so reuse is proven; a forced-refresh
test would require letting an access token expire or damaging one, which was out
of scope. Refresh writes through the same `auth.json` + `auth.lock` path, and the
`project auth` ownership guarantee applies to it unchanged.

Test suite: `cargo fmt --all --check` clean, `cargo clippy --all-targets -D
warnings` clean, `cargo test` **47 passed** (33 baseline + 14 new),
`cargo build` clean, project image unchanged and still starting cleanly.

## 9. Split-runtime architecture (historical proposal, not adopted)

> Retained for the record. Superseded by the accepted trust model — see the
> banner at the top of this file. Do not implement a split runtime, credential
> broker, custom executor, separate Hermes users, or any replacement for Hermes
> without an explicit architecture decision.

The design considered at the time, given §4–§5:

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│ Runtime container (trusted) │        │ Exec container (untrusted)   │
│  Hermes + Codex             │──────▶ │  project workspace           │
│  OAuth stores               │  narrow│  build/test toolchain        │
│  NO workspace mount         │  exec  │  NO credential mount         │
│  NO project code            │  proto │  NO Docker socket            │
└─────────────────────────────┘        └──────────────────────────────┘
        owned by Asterism Node, which owns lifecycle for both
```

Requirements the protocol must satisfy:

- one direction only: runtime → exec, carrying a command and returning
  stdout/stderr/exit code;
- **all** filesystem tool operations — not just shell — must traverse it, which
  is the part Hermes 0.20.0 does not support today;
- no credential mount, no credential env var, and no credential file sync into
  the exec container (`iter_sync_files` must be disabled or emptied);
- separate UID in the exec container from the runtime UID;
- explicit workspace and egress policy per container;
- neither container gets a Docker socket; Asterism Node, on the host, owns both
  lifecycles.

**Upstream changes required before this is buildable:**

1. Hermes must route in-process file tools (`read_file`, `write_file`, patch)
   through the execution backend rather than the local filesystem.
2. Hermes must stop treating credential paths as a soft read-deny and instead
   keep them outside the agent-reachable filesystem entirely.
3. For native Codex additionally: forward `approval.request` from the Codex
   adapter to the API, and allow the Codex app-server's shell to target a remote
   execution environment.

Until (1) and (2) exist, **containment is the boundary**: one project container
is one trust domain, holding only that project's credentials.

## 10. Historical exposure check

Patterns searched: JWT-shaped strings, `sk-` keys, and `"access_token"` /
`"refresh_token"` JSON keys. No matching value was printed.

| Location class | Scanned | Suspected matches |
| --- | --- | --- |
| Repository sources, docs, scripts, Dockerfile, fixtures, README, Cargo files | all | **0** |
| Hermes/Codex logs in project state | 25 files | **0** |
| Codex thread rollouts (agent transcripts) | 22 files | **0** |
| This phase's command logs (scratchpad) | 31 files | **0** |
| Credential stores themselves | 2 files | expected content, not an exposure |

**No manual review required.** No credential content was found in any artifact
class outside the credential stores.

Readability was proven; **exfiltration was not observed**. The probes reported
only verdicts, and the one `copy_out: SUCCEEDED` copy was written inside the
workspace and deleted immediately by the script without its content being read,
printed, or transmitted. Rotation is therefore not required on the evidence
available, and none was performed — no credential was deleted or rotated in this
phase. If the operator wants rotation out of caution, that is their decision to
make, and `project auth` re-authenticates both stores.

## 11. Runtime classification

### Normal Hermes agent loop — default

- **Session continuity:** yes, one shared server-side agent.
- **Session isolation:** none. `X-Hermes-Session-Id` is a correlation label.
- **Approvals:** observable and resolvable. `approval.request` emitted, run parks
  in `waiting_for_approval`, deny blocks, approve executes exactly once, delayed
  responses accepted.
- **Credential isolation:** **none.** 13/15 adversarial probes fail.
- **Verdict:** the default persistent Asterism project agent, on the explicit
  condition that the container is treated as a single trust domain.

### Native Codex App-Server — disabled by default

- **Approval forwarding:** missing. Codex raises requests; the Hermes adapter
  declines them internally and emits no event.
- **Thread continuity:** missing. New Codex thread per run.
- **Credential boundary:** fails identically to the Hermes loop; Codex's sandbox
  restricts writes, not reads.
- **Status:** **disabled by default and fail-closed.** Enabling the working
  configuration requires `--unsafe-allow-codex-approval-bypass` and is for
  supervised testing only.
- **Upstream changes required:** forward Codex approval requests to the API;
  preserve or reattach threads across runs; support a remote execution target for
  the Codex shell.

### Asterism Node — confirmed responsibilities

Container lifecycle; authentication workflow; the credential boundary (today
enforced as containment, tomorrow as the §9 split); one-run concurrency policy;
durable run registry; event journal and replay; approval policy enforcement;
runtime capability negotiation; safe runtime selection.

Durable run storage and event replay were **not** implemented in this phase, by
instruction.

## 12. Next phase

**Phase D — split-runtime execution boundary prototype.**

Build the §9 two-container topology behind Asterism Node's lifecycle, measure
precisely how much of the agent's tool surface can be redirected to the exec
container with Hermes as it exists today, and re-run
`fixtures/adversarial-project/credential-probe.sh` from a real agent run in the
exec container. The boundary may only be declared closed when every probe returns
`DENIED` or `HIDDEN`.

That measurement also produces the exact upstream change list to file against
Hermes, which is the dependency for everything above.
