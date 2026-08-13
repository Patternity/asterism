# Phase E — Persistent Node Daemon and Local Control API

Status: implemented and verified against a live Hermes 0.20.0 runtime in the
default safe configuration. The native Codex unsafe override was not enabled at
any point.

Asterism Node is now a **persistent process** that owns run supervision,
reconciliation, the registry, and a local control endpoint. The CLI is a thin
client of it.

The Unix-socket API described here is the **local control endpoint**, not a
Control Plane transport. The Control Plane link will be an *outbound* connection
opened by this daemon in a later phase; it will call the same application
service, not this socket.

## 1. Daemon architecture

```
              ┌──────────────────────────────────────────────┐
  CLI ───────▶│  asterism-node node serve   (foreground)     │
 (unix socket)│                                              │
              │  api.rs      transport: routing + SSE only    │
              │     │                                        │
              │  service.rs  all behaviour, transport-free    │
              │     │                                        │
              │  registry.rs (SQLite)   runner.rs (workers)   │
              └───────────────┬──────────────────────────────┘
                              │ HTTP + SSE
                       Hermes in the project container
```

`node serve` stays in the foreground and is meant to be supervised by a service
manager. There is deliberately no double-fork daemonizer and no systemd unit in
this phase.

Startup order is fixed, and reconciliation completes **before** the socket is
opened so no client can observe or act on unreconciled state:

1. create and harden the state directory;
2. acquire the singleton lock;
3. clean a stale socket;
4. open and migrate the registry;
5. reconcile every non-terminal run of every configured project;
6. re-attach workers to backend-confirmed live runs;
7. bind the socket and begin accepting requests.

Verified live — the log shows `node.reconciled` before `node.listening`.

A single-instance guarantee comes from an advisory `flock` on
`node/daemon.lock`. Two daemons sharing one state directory would both supervise
runs and both answer on the socket, so the second start is refused. The kernel
releases the lock if the daemon dies, so a crash never blocks the next start.

**Graceful shutdown** on SIGINT/SIGTERM: stop accepting, stop admitting new runs,
wait up to 20 s for workers, close client streams, remove the socket, exit.
Active Hermes runs are deliberately **not** cancelled — shutting down the daemon
must not destroy work nobody asked to stop. Verified live: SIGTERM produced
`node.draining` then `node.stopped` with `unfinished_workers: 1`, and the Hermes
run continued and completed during the downtime.

## 2. Unix socket security

| Property | Value |
| --- | --- |
| Path | `<state-root>/node/asterism.sock` (default `./.asterism/node/asterism.sock`) |
| Socket mode | `srw-------` (0600), re-applied on every start |
| Parent directory | `drwx------` (0700) |
| TCP listener | none |
| Peer check | `SO_PEERCRED`; connections whose uid differs from the daemon's are refused |
| Container exposure | none — not among the project's two bind mounts |

Socket permissions are applied on every bind, so they survive restarts
regardless of umask. `SO_PEERCRED` is a second, kernel-attested check that does
not depend on the filesystem mode being right.

Stale-socket handling is race-safe because the singleton lock is taken first: if
this process holds the lock, no other daemon owns the socket, so a file still
present is stale. A connect probe is an independent second check — a socket that
still accepts connections is never stolen.

Clients that find no daemon receive a typed `node_unavailable` error telling
them how to start one. No local request is ever authenticated with a token
stored inside a project container.

## 3. API contract

Versioned HTTP over the Unix socket. JSON is authoritative.

| Method | Path |
| --- | --- |
| GET | `/v1/health` |
| GET | `/v1/capabilities` |
| POST | `/v1/projects/{project_id}/runs` |
| GET | `/v1/projects/{project_id}/runs` |
| GET | `/v1/projects/{project_id}/runs/{run_id}` |
| GET | `/v1/projects/{project_id}/runs/{run_id}/events` |
| GET | `/v1/projects/{project_id}/runs/{run_id}/events/stream` |
| POST | `/v1/projects/{project_id}/runs/{run_id}/approval` |
| POST | `/v1/projects/{project_id}/runs/{run_id}/cancel` |
| POST | `/v1/projects/{project_id}/runs/{run_id}/retry` |
| POST | `/v1/projects/{project_id}/reconcile` |
| GET | `/v1/projects/{project_id}/activity` |

Capabilities describe the API version, registry schema version, supported and
experimental runtime kinds, approval support and choices, replay cursor
semantics, cancellation, retry, the one-active-run concurrency policy, the
transport kind (`unix_socket_http`, `inbound_tcp: false`), the Node instance id,
and the active limits.

Errors are `{"error": "<code>", "message": "..."}` with stable codes:

| Status | Codes |
| --- | --- |
| 400 | `invalid_identifier`, `invalid_cursor`, `malformed_json`, `request_too_large`, `missing_field` |
| 404 | `run_not_found`, `project_not_found`, `unknown_route` |
| 409 | `run_conflict`, `idempotency_conflict`, `invalid_transition`, `approval_already_resolved`, `no_pending_approval`, `run_active`, `run_not_retryable` |
| 410 | `backend_run_missing` |
| 422 | `empty_input`, `invalid_choice` |
| 503 | `hermes_unavailable`, `node_draining` |
| 500 | `internal_error` |

Internal errors are opaque by construction: the detail is logged and the caller
receives a fixed message, so a SQLite error or a filesystem path can never
escape. A unit test asserts that a message containing a column name and a home
directory produces neither in the response.

## 4. Service-layer boundaries

`service.rs` owns all behaviour: run creation, idempotency, listing, lookup,
event queries, streaming pages, approvals, cancellation, retry, reconciliation,
project activity, and capabilities. `api.rs` only parses, delegates, and renders.

This split exists so the future outbound Control Plane transport calls the same
layer. Policy, single-flight, and state transitions cannot diverge between the
two transports because there is only one implementation of them.

## 5. Corrected run state machine

Phase D used `interrupted` for both "we lost our observer" and "continuity is
gone", which left runs parked in a non-terminal state nothing would resolve.

```
created ─▶ starting ─▶ running ⇄ waiting_for_approval
              │           │              │
              └───────────┴──────────────┴─▶ recovering ──▶ running / waiting_for_approval
                                                  │
   all live states ────────────────────────────────┴─▶ completed | failed | cancelled
                                                       | interrupted | lost
```

* **`recovering`** — non-terminal. The node is reconnecting to a backend run
  whose outcome is not yet known. It is never a resting place: every path out
  leads to live execution or to a terminal state.
* **`interrupted`** — **terminal**. Execution continuity was definitively lost.
* **`lost`** — **terminal**. The backend cannot find the run; its outcome cannot
  be determined.
* `completed`, `failed`, `cancelled` — terminal, unchanged.

Rules, all enforced by `validate_transition`:

| Situation | Result |
| --- | --- |
| Daemon restart, Hermes still knows the run | `recovering`, reconnect, then `running` / `waiting_for_approval` / terminal |
| Container restart destroys the backend run | terminal `interrupted` |
| Backend reports not-found with no stronger evidence | terminal `lost` |
| Retry of `interrupted` / `lost` | **new** run, `retry_of_run_id` set, original untouched |

No permanently unactionable run is left non-terminal, and the original run is
never silently resubmitted.

### Migration

Schema **v2** adds `retry_of_run_id` with an index, and backfills `finished_at`
plus an explanatory `recovery_note` for rows that are terminal under the new
model but were written while `interrupted` was still active. No record is
deleted and no status is rewritten. A test builds a v1 database by hand,
migrates it, and asserts that both an old `interrupted` row and an
already-settled row survive with the right timestamps. The live 2.5 MB Phase D
registry migrated in place and kept all its runs.

## 6. SSE replay algorithm

SQLite is the source of truth. The in-memory notification bus carries run ids
only and is a wake-up, never the event source.

```
subscribe to the wake-up bus          ← before the first query, so an event
cursor ← Last-Event-ID | since_seq | 0   appended during replay still wakes us
loop:
    page ← events_since(run_id, cursor, page_size)
    emit each event; cursor ← event.seq
    if page was full: continue          ← drain before waiting
    if run is terminal: emit comment, close
    wait for (wake-up | heartbeat), then loop
```

Because every iteration re-queries from the cursor, there is **no window**
between "replay finished" and "live subscription started" in which an appended
event could be missed — the boundary the phase brief asks about does not exist
in this design. An integration test proves the related guarantee directly: an
event appended through a *separate* registry connection, which never fires the
notification bus, is still delivered.

Wire format: SSE `id` is the per-run `seq`, `event` is the event type, `data` is
the JSON payload. `Last-Event-ID` resumes strictly after the cursor;
`?since_seq=` and `?last_event_id=` serve clients that cannot set the header.
Idle streams get `: heartbeat` comments.

A slow consumer cannot block execution: the follower task writes into a bounded
channel that only it and the client touch. The worker never writes to it, and
duplicate delivery is harmless because the client keys on `seq`.

## 7. Worker ownership

Phase D spawned a detached process per run. The daemon now supervises runs as
tasks in-process, which makes it the single authority over active runs.

* A CLI client disconnecting has no effect — proven in Phase D and preserved.
* An SSE client disconnecting has no effect: the follower task ends, the worker
  does not.
* Single-flight is unchanged: the worker holds the project `flock` for the whole
  run, and two tasks in one process contend correctly because each opens its own
  file description.
* On restart the daemon re-attaches to backend-confirmed live runs instead of
  resubmitting: a worker that finds an existing `hermes_run_id` resumes
  following it, so a task is never executed twice.
* The project slot is released only after a supported terminal transition.

## 8. Restart reconciliation

Startup and every 60 s. Skipped for a project whose lock is held, because a live
worker is authoritative.

For each non-terminal run: park it in `recovering` (journalled as
`asterism.run.recovering`), query the backend, then resolve by the §5 table and
append `asterism.reconciled` with the previous status, new status, reason, and
observed backend status. Previously journalled history is preserved untouched.

Live evidence — a run with 348 events when the daemon was SIGTERMed:

```
seq 1346  asterism.run.recovering  {"previous_status": "running"}
seq 1347  asterism.reconciled      {"backend_status": "completed",
                                    "previous_status": "running",
                                    "new_status": "completed", ...}
```

The Hermes run had continued during the downtime; the daemon adopted its real
outcome rather than guessing, and all 1 347 events were retained.

## 9. Approval handling

Requests are persisted before they are exposed, and the approval identifier is
the journal `seq` of the request event — stable and already meaningful as a
cursor.

The decision is claimed durably **before** it is forwarded
(`UPDATE … WHERE decision IS NULL`), so a retry cannot send a second decision.
The backend response is journalled as `asterism.approval.decision` and linked by
`resolution_seq`. The run returns to `running` only when backend traffic shows it
resumed. A container restart while an approval is pending resolves through the
§5 table; Asterism does not pretend a stored approval remains actionable against
a backend that forgot the run.

Verified live from a **separate** CLI process after the starting client had
exited: the run parked in `waiting_for_approval`, `deny` applied
(`approval_id: 4`), a repeat was refused with 409 `no_pending_approval`, the
denied command did not execute, and the run finished `completed`.

## 10. Retry semantics

Only terminal `interrupted` and `lost` runs are retryable — outcomes Asterism
could not determine. A run that genuinely completed, failed, or was cancelled has
a real result, so re-running it is a new decision the caller must express.

A retry creates a new `run_id`, copies only the request fields that describe the
work, deliberately does **not** copy the idempotency key, sets `retry_of_run_id`,
and journals the relationship on both sides (`asterism.retry.created` on the
original, `asterism.retry.of` on the replacement). The original is otherwise
untouched. Single-flight and idempotency apply normally. Nothing is retried
automatically after a container restart.

Verified live: an `interrupted` run with 777 events produced a linked
replacement; the original kept its status and gained only the link event at
seq 778.

## 11. Lifecycle coordination

Coordination goes through the daemon when it is reachable, because only the
daemon knows what it supervises. When it is not reachable the durable registry
is consulted directly and the command **still fails closed** — an unreachable
daemon is never read as "nothing is running".

| Command | Behaviour with an active run |
| --- | --- |
| `project stop` | refused, `project_busy`, exit 6 |
| `project remove` | refused, `project_busy`, exit 6 |
| `project auth` | refused — rotating credentials mid-run would break it |
| `project start` | proceeds, then asks the daemon to reconcile |

`--force-interrupt` is a scoped opt-in for stop/remove. It does not fabricate an
outcome: the run is left to be reconciled as `interrupted`.

Verified live: with a run in flight, `project stop` returned `project_busy` with
exit code 6 and the container stayed up; `project auth` was refused identically.

## 12. Resource limits

| Limit | Default |
| --- | --- |
| Request body | 256 KiB |
| Events per non-streaming query | 5 000 |
| Stream page size | 256 |
| Concurrent local connections | 64 (semaphore; excess rejected) |
| SSE followers per run | 8 |
| Heartbeat | 15 s |

Event payloads and raw payloads keep the Phase D bounds (8 KiB per string,
64 KiB per raw payload, recursion depth 32). Oversized and malformed input is
rejected with a typed error; an integration test sends malformed JSON, an
oversized body, and an unknown route in sequence and then asserts the daemon is
still healthy. No unbounded in-memory event accumulation exists: streaming is
paged from SQLite and bounded by a channel.

No retention or deletion is implemented — that is deliberately out of scope.

### Measurements

| Metric | Value |
| --- | --- |
| Registry size after Phase D + E | 4.7 MB |
| Runs / events stored | 20 / 9 247 |
| Largest run | 2 460 events |
| Replay of 2 461 events through the API | **170 ms** |
| Daemon RSS during and after replay | **33 MB** |
| Backend frames stored with a dedupe key | 10 764 |
| Duplicate dedupe keys stored | **0** |
| Runs with gaps or non-contiguous sequences | **0** |

Memory stays flat during replay because pages are streamed rather than
accumulated. The count of duplicate frames *suppressed* by deduplication is not
instrumented — dedupe drops them before they are counted. What is verified is the
consequence: across 10 764 keyed frames, including several worker reconnections
that replayed Hermes frames, there are zero duplicate keys and zero sequence
gaps.

## 13. Live acceptance results

| # | Check | Result |
| --- | --- | --- |
| 1 | `node serve` starts, reconciles, then listens | **PASS** |
| 2 | `node status` reports health and capabilities | **PASS** |
| 3 | Socket 0600, directory 0700, no TCP listener | **PASS** |
| 4 | Run created and completed through the daemon | **PASS** — `PHASE_E_OK`, 9 events |
| 5 | Full SSE replay | **PASS** — 9 of 9 |
| 6 | Replay from a cursor | **PASS** — `since_seq=7` returned exactly 2 |
| 7 | Approval from a separate process after the starter exited | **PASS** |
| 8 | Approval applied at most once | **PASS** — repeat → 409 |
| 9 | Denied command did not execute | **PASS** |
| 10 | Graceful SIGTERM leaves the Hermes run alive | **PASS** |
| 11 | Run commands without a daemon | **PASS** — typed `node_unavailable`, exit 5 |
| 12 | Daemon restart: `recovering` → adopted real outcome | **PASS** — 1 347 events kept |
| 13 | Container restart mid-run → terminal `interrupted` | **PASS** — 777 events kept |
| 14 | Retry creates a linked replacement | **PASS** |
| 15 | Retry refused for a genuinely failed run | **PASS** — 409 `run_not_retryable` |
| 16 | `project stop` / `auth` refused while busy | **PASS** — `project_busy`, exit 6 |
| 17 | Socket and registry unreachable from the container | **PASS** — 0 matches each |
| 18 | Daemon holds no provider OAuth material | **PASS** |
| 19 | No secrets in daemon logs | **PASS** — 0 matches |
| 20 | Malformed / oversized / unknown-route input | **PASS** — daemon stayed healthy |
| 21 | Schema v2 migration of the live registry | **PASS** |

Test suite: `cargo fmt --all --check` clean, `cargo clippy --all-targets -D
warnings` clean, `cargo build` clean, `cargo test` **162 passed** (140 unit +
22 integration; baseline was 105).

## 14. Known limitations

* **Execution durability is unchanged.** A run in flight when the *container*
  restarts is still lost by Hermes and recorded `interrupted`. The daemon adds
  continuity across *its own* restarts, not across backend restarts.
* Projects are reconciled only if named with `--project`; there is no discovery.
* Periodic reconciliation is a fixed 60 s interval, not adaptive.
* The CLI's HTTP client is minimal and speaks only to this server; it is not a
  general-purpose HTTP client.
* Connection limiting is per-daemon, not per-peer, so one local user could
  occupy all 64 slots. Acceptable while every peer is the same uid.
* No retention, compaction, or deletion of events.
* Approval timeout remains Hermes'; Asterism enforces none of its own.
* `--force-interrupt` is not yet exposed through the API, only the CLI.
* Multi-project daemons share one registry connection mutex; fine at this scale,
  a bottleneck if projects multiply.

## 15. Preparation for the outbound Control Plane transport

Everything the next phase needs is already in place and deliberately shaped for
it:

* **A transport-free service layer.** `NodeService` exposes the complete
  operation set with typed errors and no HTTP in its signatures. The outbound
  transport constructs one and calls the same methods the socket API calls.
* **A stable event cursor.** Per-run monotonic `seq`, already used as SSE `id`
  and `Last-Event-ID`. A Control Plane consumer resumes with the same mechanism
  and the same guarantee, without contacting Hermes.
* **A Node instance identifier** in health and capabilities, ready to identify
  this Node to a remote peer.
* **Capability negotiation** already describing runtime kinds, approvals,
  replay, retry, and concurrency policy.
* **Drain semantics** (`begin_drain`, `is_draining`, `node_draining` → 503) that
  a remote session can reuse when a Node is being taken out of service.

What the next phase must add: an outbound persistent connection, remote
authentication of the Node to the Control Plane, and multiplexing of remote
requests onto the same service. The direction of the connection is the point —
this daemon must never gain an inbound network listener.

## 16. Next phase

**Phase F — outbound Control Plane session.**

Add a persistent outbound connection from the daemon to the Control Plane that
authenticates the Node, negotiates capabilities from §3, streams run events using
the `seq` cursor, and accepts remote run, approval, cancellation, and retry
commands by calling `NodeService` directly. No inbound port is added, and the
local Unix socket keeps working unchanged for operators.
