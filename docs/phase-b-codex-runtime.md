# Phase B — Native Codex App-Server Runtime Evaluation

Status: complete. All results below were observed on a real Linux Docker host
against one pinned image; nothing is projected or assumed.

## 1. Executive conclusion

**Hermes cannot replace the planned Asterism Agent Runtime.** It is a capable
execution engine and should remain the runtime, but Asterism Node must supply
the control and persistence layer around it.

The native `codex app-server` runtime was reached, configured, and proven to
execute the acceptance task end to end. In doing so it removed the single
strongest argument for adopting it wholesale: on this runtime Hermes provides
**neither approval mediation nor conversation continuity**, and the only
configuration in which it works at all is one where every Codex permission
request is auto-approved.

Three findings drive the recommendation:

1. **Approvals are unobservable on the native runtime.** Codex raises approval
   requests; Hermes' Codex adapter never forwards them to the API. Zero
   `approval.request` events were emitted across every native-runtime run. The
   same API surface emits them correctly on Hermes' own agent loop, so the
   defect is isolated to the adapter, not to the gateway or to Asterism.
2. **The native runtime is stateless per run.** Every `POST /v1/runs` starts a
   *new* Codex thread. A token stored in turn 1 was not recalled in turn 2 of
   the same `session_id` in the same live container. Hermes' "one persistent
   project agent" model does not hold on this path.
3. **Run metadata does not survive a restart.** The Hermes run registry is
   in-memory. Any durable notion of "what ran, when, and how it ended" must be
   owned by Asterism Node.

Phase B's own deliverables — `project auth`, single-flight admission, the pinned
derived image — all worked and are retained.

## 2. Tested versions and digests

| Component | Value |
| --- | --- |
| Hermes | 0.20.0 |
| Hermes base image | `nousresearch/hermes-agent@sha256:74021a2e4571a7a1200a5b6c12c030eee579f06ba168d846f1df062d4a4ea99f` |
| Derived project image | `asterism/project-runtime:hermes-0.20.0-codex-0.147.0` |
| Derived image id | `sha256:860cbfc09c8331c0a0947714315c15e38556a2bbf62a6e6fd4bfa3692a0f196a` |
| Codex CLI | `codex-cli 0.147.0` (npm `@openai/codex@0.147.0`) |
| Codex minimum required by Hermes | `MIN_CODEX_VERSION = (0, 125, 0)` in `agent/transports/codex_app_server.py` |
| Provider | `openai-codex` (ChatGPT OAuth, device code) |
| Model | `gpt-5.6-sol` |
| Host | Linux, Docker Engine 29.1.3 |
| Rust | 1.97.1 |

Codex 0.147.0 was selected because it is the current `latest` stable npm
dist-tag, is above Hermes' declared floor of 0.125.0, and provides both
`codex app-server` and `codex login --device-auth`. Alpha and beta dist-tags
were deliberately avoided.

The Hermes API server reports `runtime.mode: "server_agent"` in
`/v1/capabilities` regardless of the Codex setting — **capabilities cannot be
used to detect the active runtime.**

## 3. Reproduction

```bash
# 1. Build the pinned project image
scripts/build-project-image.sh
export ASTERISM_HERMES_IMAGE='asterism/project-runtime:hermes-0.20.0-codex-0.147.0'
export ASTERISM_HERMES_API_KEY="$(openssl rand -hex 32)"

# 2. Start the project container
cargo run -- project ensure --project-id phase-a \
  --workspace ./fixtures/test-project \
  --hermes-data ./.asterism/phase-a/hermes --api-port 18642

# 3. Authenticate both credential stores (independent device-code flows)
cargo run -- project auth --project-id phase-a --provider openai-codex
cargo run -- project auth --project-id phase-a --provider codex-cli

# 4. Enable the native runtime (see README for the full config block)
#    model.provider=openai-codex  model.openai_runtime=codex_app_server
#    terminal.cwd=/workspace      approvals.mode=off
cargo run -- project stop  --project-id phase-a
cargo run -- project start --project-id phase-a

# 5. Acceptance task
cargo run -- hermes run --project-id phase-a --session-id phase-b-codex \
  --input "Read PROOF_TASK.md and complete the task exactly as written. Work only inside /workspace." --wait
grep -Fx 'ASTERISM_PHASE_A_OK' fixtures/test-project/PROOF_RESULT.txt
```

## 4. Acceptance matrix

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Derived image builds reproducibly from a pinned base | **PASS** | Build rejects an unpinned base; labels record base digest and Codex version |
| 2 | `codex --version` verified in image | **PASS** | `codex-cli 0.147.0`, executed as uid 1000 during build |
| 3 | `project auth` writes correctly-owned credentials without `chown` | **PASS** | `auth.json` and `codex/auth.json` both `-rw------- 1000 1000` on creation |
| 4 | Hermes provider auth and Codex CLI auth are independent | **PASS** | `hermes auth status openai-codex` → logged in; `codex login status` → "Logged in using ChatGPT"; separate files |
| 5 | Both credentials survive container restart and rebuild | **PASS** | Verified after `project stop/start` and after `project remove` + `ensure` onto the new image |
| 6 | `codex app-server` actually spawned | **PASS** | Log: `codex app-server thread started: id=... profile=workspace-write cwd=/workspace`; processes 194/203 children of Hermes pid 153 |
| 7 | Codex processes run non-root | **PASS** | `Uid: 1000 1000 1000 1000` for `hermes gateway run`, `node codex app-server`, and the native musl binary |
| 8 | Acceptance task completes on the native runtime | **PASS** | `PROOF_RESULT.txt` = `ASTERISM_PHASE_A_OK\n`, 20 bytes exactly |
| 9 | Unrelated workspace files unchanged | **PASS** | `PROOF_TASK.md` / `README.md` md5 and mtimes unchanged |
| 10 | Writes outside approved roots rejected | **PASS** | `/etc/asterism-probe.txt` denied by the Codex sandbox; file absent |
| 11 | SSE streaming on the native runtime | **PASS** | `message.delta`, `tool.started`, `tool.completed`, `run.completed` |
| 12 | `reasoning.available` on the native runtime | **FAIL** | Emitted on Hermes' loop, absent on every native-runtime run |
| 13 | Approval requests forwarded as `approval.request` | **FAIL** | 0 events across all native-runtime runs, including with `read-only-with-approval` |
| 14 | Asterism can deny a native-runtime approval | **FAIL** | Nothing to deny; Hermes declines internally before the API sees it |
| 15 | Asterism can approve a native-runtime approval | **FAIL** | Same layer |
| 16 | Approval round-trip on Hermes' own loop | **PASS** | `waiting_for_approval`; `deny` → blocked, dir preserved; `once` → exactly 1 `tool.started`, dir removed |
| 17 | Delayed approval response honoured | **PASS** | 20 s delay accepted, `resolved: 1`, run continued to `completed` |
| 18 | Codex thread continuity across turns | **FAIL** | New thread id per run; token from turn 1 not recalled in turn 2 of the same session |
| 19 | Cross-session context isolation on the native runtime | **PASS (incidental)** | A fresh thread per run means no bleed — a side effect of #18, not a designed boundary |
| 20 | Hermes run registry survives container restart | **FAIL** | 404 `run_not_found` after restart |
| 21 | Codex thread transcripts persisted | **PASS** | `rollout-*.jsonl` under `CODEX_HOME/sessions/` |
| 22 | Workspace persists across restart | **PASS** | `PROOF_RESULT.txt` intact by checksum |
| 23 | SSE reconnection / resume after restart | **FAIL** | Stream ends with `unexpected EOF during chunk size line`; run outcome unrecoverable |
| 24 | Single-flight admits one run | **PASS** | Second run → exit 2, `run_conflict` |
| 25 | Lock released on completion, failure, cancellation | **PASS** | `active-run.json` cleared in all three cases |
| 26 | Lock survives Node restart while a run is live | **PASS** | Detached run still blocked a new Node process |
| 27 | Lock does not wedge after container restart | **PASS** | Stale record → 404 → admitted |
| 28 | Cancellation of an active native Codex run | **PASS** | `stopping` → `cancelled`, lock released |
| 29 | Failed command yields a usable terminal result | **PASS** | Exit code 2 and stderr reported, run `completed`, lock released |
| 30 | Provider/model error produces a typed terminal result | **UNTESTED** | Setting an account-invalid Hermes model did not reach the provider — Codex selects the model on this path. A real provider failure needs credential or quota damage, which is out of scope |
| 31 | Quota/limit reporting | **UNTESTED** | Not probed; exhausting the user's ChatGPT quota was explicitly out of scope |
| 32 | Container security posture after adding Codex | **PASS** | See §10 |
| 33 | Credentials inaccessible from the workspace mount | **FAIL** | Agent-executed shell reported `READABLE` for both credential files |

## 5. Native Codex runtime evidence

Log line, per run:

```
agent.transports.codex_app_server_session:
  codex app-server thread started: id=019feda9 profile=workspace-write cwd=/workspace
```

Process tree inside the container, all non-root:

```
pid=153  uid=1000  /opt/hermes/.venv/bin/hermes gateway run --replace
pid=194  uid=1000  node /usr/local/bin/codex app-server            (PPid 153)
pid=203  uid=1000  .../codex-linux-x64/vendor/.../codex app-server (PPid 194)
```

Codex turn context from a persisted rollout:

```json
{"cwd": "/workspace", "approval_policy": "on-request",
 "sandbox_policy": {"type": "read-only"}, "model": "gpt-5.6-sol"}
```

Two configuration facts were discovered the hard way and are mandatory:

- **`terminal.cwd` must be `/workspace`.** It ships as `"."`, which resolved to
  `/opt/data`. Codex sandboxes relative to its cwd, so the first native run
  could not read `/workspace/PROOF_TASK.md` at all: *"the sandbox failed to
  initialize, and the required elevated read request was denied."*
- **`approvals.mode` must be `off`** for the runtime to function today. With the
  default, Codex's requests are declined internally and every run fails with
  *"access to read `/workspace/PROOF_TASK.md` was denied twice."*

## 6. Approval behaviour

Measured on both runtimes with the same API client and the same reversible
command (`rm -rf` of a disposable scratch directory inside the fixture).

**Hermes' own agent loop — works.** Event shape:

```json
{"event": "approval.request", "run_id": "run_...",
 "command": "rm -rf /workspace/.phase-b-scratch/doomed",
 "description": "delete in root path", "pattern_key": "delete in root path",
 "choices": ["once", "session", "always", "deny"],
 "allow_session": true, "allow_permanent": true}
```

Run parks in `waiting_for_approval`. `POST /v1/runs/{id}/approval` returns
`{"choice": "deny", "resolved": 1, ...}`. Denial left the directory intact and
the run finished `completed` with *"The command was blocked because
destructive-action consent was not granted."* Approval with `once` after a
deliberate 20-second delay executed exactly one command (a single
`tool.started`) and the run completed.

**Native Codex runtime — silent.** With `HERMES_TERMINAL_SECURITY_MODE=approval-required`
(Codex profile `read-only-with-approval`), Codex requested permission and the
model reported *"Both write attempts were rejected by the approval system,
including the explicit permission request"* — while the SSE stream carried
**zero** `approval.request` events.

**Responsible layer: the Hermes Codex adapter.** Not the API gateway (proven
working above), not Asterism. `agent/codex_runtime.py` constructs the Codex
session with `approval_callback = _get_approval_callback()`, which is `None` in
gateway/API contexts, and `_ServerRequestRouting(auto_approve_exec=False,
auto_approve_apply_patch=False)`. Its own comment states the intent: *"Gateway /
cron contexts have no UI to surface codex's approval requests through, so codex
app-server exec / apply_patch requests fail closed (silently decline) by
default."* The gateway's `_approval_notify` bridge, which does emit
`approval.request`, is never wired into the Codex session.

The only documented escape is `approvals.mode: off` / `HERMES_YOLO_MODE` /
`--yolo`, which flips both routing flags to auto-approve. That is the
configuration this phase had to use. **On the native runtime the effective
policy is therefore: approve everything, with Codex's sandbox profile as the
sole gate.** No Asterism approval engine was implemented, per scope.

## 7. Session and context behaviour

| Runtime | Continuity within a session | Isolation between sessions |
| --- | --- | --- |
| Hermes agent loop | Yes — one shared server-side agent | **None** — a never-used session id recalled other sessions' tokens (Phase A) |
| Native Codex | **None** — new thread per run | Incidental, as a side effect of having no continuity |

Measured on the native runtime: `codex-mem` turn 1 stored `ORION5150` and
answered `OK`; turn 2 of the same session, same live container, answered *"No
token provided."* After a restart, and from a brand-new session id, both
answered `NONE`. Distinct Codex thread ids per run confirm the mechanism.

`X-Hermes-Session-Id` is **not** a context-isolation boundary and must not be
documented as one. On the native runtime it is not a continuity mechanism
either — it is purely a correlation label.

Shared context on the Hermes loop is **not a defect** under the current model
(one project container, one persistent agent, one active run, sequential
execution). It is a limitation for parallel independent tasks, reproducible
isolated sessions, and multi-user isolation within one container. Growing
context under ChatGPT OAuth shows up as latency, context pressure, quota
consumption, and eventual compaction — not as direct per-token billing, which
applies to API-key usage.

## 8. Restart and persistence

Distinguish five different things; they behave differently:

| State | Persisted? | Where |
| --- | --- | --- |
| Hermes agent memory / config / skills | Yes | `/opt/data` bind mount |
| Hermes conversation transcript | Not across container restart | in-memory agent |
| Codex thread transcript | Yes, as an artifact | `CODEX_HOME/sessions/rollout-*.jsonl` |
| Codex live thread | No | new thread per run |
| Asterism run metadata | Yes | `<state-root>/<project>/active-run.json` |
| Hermes run registry | **No** | in-memory; 404 after restart |
| Workspace | Yes | `/workspace` bind mount |
| Both OAuth credential sets | Yes | `/opt/data` bind mount |

Restart **between** runs is clean. Restart **during** a run loses everything
about it: the SSE stream dies with `unexpected EOF during chunk size line`, the
CLI exits 1, and the run id returns 404 — there is no resume, no replay, and no
terminal status. Asterism's own record correctly stops blocking admission, and a
new run succeeds immediately, so the project does not wedge.

## 9. Authentication lifecycle

Two independent ChatGPT OAuth sessions, both device-code, neither accepting an
API key:

- Hermes provider — `hermes auth add openai-codex --type oauth --no-browser` →
  `/opt/data/auth.json`
- Codex CLI — `codex login --device-auth` → `/opt/data/codex/auth.json`

`project auth` resolves the container, refuses when it is missing or stopped,
refuses a root runtime identity, verifies the provider CLI exists before burning
a device code, execs as the container's declared `HERMES_UID:HERMES_GID`,
allocates a TTY only when the caller has one, and afterwards verifies the
runtime user can read the credential file. Phase A's root-owned-`auth.json`
failure mode is structurally prevented. Both credential sets survived a container
restart and a full image swap.

Codex's device-code flow is a per-account opt-in: it fails until device-code
authorization is enabled in ChatGPT security settings. Both flows also proved
sensitive to transient TLS failures against `auth.openai.com` and needed a
retry — worth handling explicitly in any automated provisioning path.

## 10. Security boundary

Revalidated after adding the Codex CLI:

| Check | Result |
| --- | --- |
| `Privileged` | `false` |
| `CapDrop` | `[ALL]` |
| `CapAdd` | `CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID` (s6 bootstrap set, unchanged) |
| `no-new-privileges` | enabled |
| Limits | pids 512, memory 4 GiB, cpus 2 |
| Port binding | `127.0.0.1:18642` only, confirmed with `ss` |
| Bind mounts | exactly two: workspace and Hermes data |
| Docker socket | absent |
| Runtime UIDs | Hermes and both Codex processes at uid/gid 1000 |
| Host paths outside mounts | not visible (`/home/lexx` absent) |
| Credentials in image layers | none — `/opt/data` is empty in the image |
| OAuth material in fixtures / sources / docs | none |

Two findings:

1. **Credentials are readable from the agent's execution context.** A shell
   command issued through a normal run reported `READABLE` for both
   `/opt/data/auth.json` and `/opt/data/codex/auth.json`, and a write to
   `/opt/data/asterism-probe.txt` succeeded. Everything the agent needs and
   everything that authenticates the project share one mount and one uid. A
   prompt-injected task can exfiltrate both OAuth sessions. **This is the most
   serious open issue in Phase B.**
2. The `docker` CLI binary is present in the base image. Inert without a socket,
   but it is avoidable attack surface in a derived image.

## 11. Known limitations

- Approvals are unobservable and unresolvable on the native Codex runtime.
- The native runtime only functions with approvals bypassed.
- No conversation continuity on the native runtime.
- No session isolation on the Hermes loop.
- Run registry is in-memory; no durable run history from Hermes.
- SSE has no resume; a mid-run restart loses the outcome.
- `/v1/capabilities` does not report which runtime is active.
- Hermes' `model.default` is not authoritative on the native runtime.
- Single-flight is per-Node-process plus a file record; it assumes one Node owns
  one project directory. It is not a distributed lock.
- Docker's default bridge still allows unrestricted egress.

## 12. Remaining risks

| Risk | Severity | Note |
| --- | --- | --- |
| Credential theft via an agent task | **High** | Both OAuth sessions readable from the workspace execution context |
| Auto-approve is mandatory on the native runtime | **High** | No policy gate above Codex's sandbox |
| Silent behaviour change on Codex or Hermes upgrade | Medium | Adapter behaviour is undocumented upstream and version-sensitive |
| Lost runs on restart | Medium | No durable execution record without Asterism |
| Unrestricted egress | Medium | Carried over from Phase A |
| Device-code flow fragility | Low | Transient TLS failures observed twice |

## 13. Recommended production architecture

Keep Hermes as the in-container execution engine. Do **not** adopt the native
Codex runtime as the default until approval forwarding exists upstream; prefer
Hermes' own agent loop, which has a working approval path.

Asterism Node should own:

- run admission and concurrency (single-flight today, real scheduling later);
- a durable run registry and event spool, since Hermes' is in-memory;
- SSE consumption with reconnect and replay;
- the approval control point — consuming `approval.request` and resolving it via
  the Runs API, which works on Hermes' loop today;
- provider credential lifecycle;
- the container security boundary, including **splitting credentials out of the
  agent-reachable mount**.

The immediate architectural change this evidence demands: credentials must not
live in a mount the agent can read. Options are a separate mount owned by a
different uid than the runtime user, or moving credential material out of the
container entirely behind a broker.

## 14. Ownership matrix

| Capability | Hermes | Codex | Asterism Node | Asterism Control Plane |
| --- | --- | --- | --- | --- |
| Model inference | Owns | Owns (native runtime) | — | — |
| Agent loop / tool selection | Owns | Owns (native runtime) | — | — |
| Code editing, shell execution | Owns | Owns | — | — |
| Filesystem sandbox | Partial (`HERMES_WRITE_SAFE_ROOT`) | Owns (native runtime) | Defines mounts and roots | Policy |
| Approval decision | Owns (own loop) | Raises requests | **Must own the control point** | Policy source |
| Approval forwarding on native runtime | **Missing** | Raises | Cannot compensate today | — |
| Conversation continuity | Owns (own loop) | Per-thread only | Must supply across runs | — |
| Session isolation | **Missing** | Incidental | Container is the boundary | Project/tenant model |
| Run registry / history | In-memory only | Thread rollouts | **Owns durable record** | Aggregates fleet-wide |
| Event stream | Emits SSE | Emits JSON-RPC | **Owns spooling and replay** | Consumes |
| Concurrency control | None | None | **Owns** | Scheduling policy |
| Provider authentication | Owns its store | Owns its store | **Owns the lifecycle** | Credential policy |
| Container lifecycle / security | — | — | **Owns** | Desired state |
| Secret isolation | Inadequate today | — | **Must own** | Policy |
| Project / user / task model | — | — | Executes | **Owns** |

## 15. Final recommendation

**Hermes remains the runtime, while Asterism Node supplies missing control and
persistence.**

Not "Hermes replaces the Agent Runtime": it provides no durable run registry, no
event replay, no concurrency control, no session isolation, and — on the native
Codex path — no approval mediation and no continuity.

Not "Hermes is only one optional managed agent": it demonstrably performs the
hard part well. It provisioned, authenticated, executed the acceptance task
correctly through two different runtimes, sandboxed writes, cancelled cleanly,
and reported failures usefully. Rebuilding that would be waste.

The boundary is now empirically clear. Hermes and Codex own *executing a turn*.
Asterism Node owns *everything that must survive, be observed, or be denied*.

## 16. State the container was left in

`asterism-project-phase-a` is running the derived image with the native runtime
enabled, so the findings above can be re-observed directly:

```
model.provider        = openai-codex
model.default         = gpt-5.6-sol
model.openai_runtime  = codex_app_server
terminal.cwd          = /workspace
approvals.mode        = off
HERMES_TERMINAL_SECURITY_MODE = approval-required
```

`approvals.mode: off` is required for this runtime to function and means every
Codex permission request is auto-approved. To return to the configuration where
approvals are observable and enforceable, set `model.openai_runtime` back to
`auto` and `approvals.mode` back to `manual`, then restart the container.

## 17. Single next action

**Split credentials out of the agent-reachable mount, then re-run the §10
credential probe until it reports `DENIED`.**

This is the only Phase B finding that is both actively exploitable and fully
inside Asterism's control. Approval forwarding is an upstream defect, and
continuity is a design question — but a project task being able to read the
OAuth sessions that authenticate the project is a boundary failure Asterism
Node is responsible for and can fix without upstream changes.
