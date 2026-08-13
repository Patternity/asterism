# Phase D — Durable Run Registry and Event Journal

Status: implemented and verified against a live Hermes runtime. Asterism Node no
longer treats Hermes' in-memory run registry as authoritative for externally
visible run state.

Two properties must be kept apart throughout this document:

* **Durable metadata and event capture** — achieved and directly proven.
* **Durable execution** — *not* achieved, and not achievable at this layer. A run
  in flight when the project container restarts is lost by Hermes; Asterism
  records that honestly instead of inventing an outcome.

## 1. Storage architecture

SQLite via `rusqlite` with the `bundled` feature: the engine is compiled into the
binary, so there is no external database service and no runtime dependency on a
system SQLite.

Location: `<state-root>/node/registry.db`, default `./.asterism/node/registry.db`.

This path is deliberately a sibling of the per-project directories rather than a
child. A project container binds exactly two host paths — its workspace and its
Hermes data directory — and `node/` is neither. Verified live: the container has
zero files named `registry.db`, and the parent of `/opt/data` does not expose it.

Connection settings applied on open:

| Setting | Value | Reason |
| --- | --- | --- |
| `journal_mode` | `WAL` | The CLI and detached workers read and write concurrently |
| `foreign_keys` | `ON` | Events and approvals cascade with their run |
| `synchronous` | `NORMAL` | Durable across process crash, which is the failure this guards |
| `busy_timeout` | 5s | Absorbs contention between a worker and a `run show` |

Opening a file that is not a valid database fails closed with an explicit error
rather than silently behaving as an empty registry.

## 2. Schema (version 1)

```sql
runs(run_id PK, project_id, session_id, idempotency_key, runtime_kind,
     provider, model, status, created_at, started_at, updated_at, finished_at,
     last_event_seq, terminal_reason, error_code, error_message,
     hermes_run_id, request_payload, result_payload, recovery_note,
     request_fingerprint)

run_events(run_id FK, seq, event_type, recorded_at, source,
           payload, raw_payload, redacted, dedupe_key,
           PRIMARY KEY (run_id, seq))

run_approvals(run_id FK, request_seq, requested_at, command, choices,
              decision, decided_at, resolution_seq,
              PRIMARY KEY (run_id, request_seq))
```

Indexes that carry semantics, not just speed:

* `UNIQUE (project_id, idempotency_key) WHERE idempotency_key IS NOT NULL` —
  the database, not application logic, guarantees one run per key even if two
  Node processes race.
* `UNIQUE (hermes_run_id) WHERE hermes_run_id IS NOT NULL` — one Asterism run per
  backend run.
* `UNIQUE (run_id, dedupe_key) WHERE dedupe_key IS NOT NULL` — duplicate backend
  frames cannot become duplicate journal entries.

Asterism run ids (`arun_…`) are its own, independent of Hermes run ids, so a
run has a stable identity before submission and after Hermes forgets it.

## 3. Migration strategy

A `schema_version` table holds a single integer. `migrate()` applies numbered
steps from the stored version up to `SCHEMA_VERSION`, each in order, then records
the new version. Re-opening an already-current database is a no-op. A database
whose version is *newer* than the binary supports is refused rather than
downgraded. Adding a change means bumping the constant and adding one arm to
`apply_migration`.

## 4. State machine

```
created ──▶ starting ──▶ running ⇄ waiting_for_approval
   │            │           │              │
   │            └───────────┴──────────────┴──▶ completed / failed / cancelled / lost
   │                        │              │
   │                        └──────────────┴──▶ interrupted ──▶ (resolved by reconciliation)
   └──▶ failed / cancelled / lost
```

* `completed`, `failed`, `cancelled`, `lost` are **terminal and immutable**. Only
  `recovery_note` may be attached afterwards.
* `interrupted` is deliberately **not** terminal: it means "the outcome is
  genuinely unknown", and reconciliation may still resolve it.
* A transition to the identical status is an idempotent no-op, which is what
  makes repeated cancellation and repeated reconciliation safe.
* Every other transition is rejected with a typed `InvalidTransition`, and the
  rejection rolls back any event appended in the same transaction.

Hermes statuses map on conservatively: only `completed`, `failed`, `cancelled`,
and `waiting_for_approval` are recognised; **anything unrecognised is treated as
still running**, never as a terminal result.

## 5. Event normalization

Hermes carries the event name both in the SSE `event:` field and inside the JSON
body, and either may be absent. Normalization prefers the SSE field, falls back
to the body, and otherwise records `unknown`. A frame whose body is not JSON is
preserved as `{"text": "…"}` rather than dropped, so malformed or future event
shapes still reach the journal.

Sequence numbers are per-run, assigned inside the same transaction as the append
and mirrored into `runs.last_event_seq`, so ordering is deterministic and the run
record and journal can never disagree.

Hermes assigns no event identifier, so identity for deduplication is
`event_type : timestamp : FNV-1a(payload)`. Two genuinely identical frames
collapse; two distinct message deltas at the same timestamp do not. This is what
makes SSE reconnection safe.

Asterism appends its own events alongside Hermes': `asterism.run.accepted`,
`asterism.run.submitted`, `asterism.run.resumed`, `asterism.cancel.requested`,
`asterism.cancel.response`, `asterism.approval.decision`, `asterism.reconciled`,
`asterism.run.terminal`.

## 6. Redaction policy

Every payload is redacted recursively **before** it reaches storage, because the
registry lives outside the project trust domain and must never become a second
copy of a secret.

* **By key name**, case- and separator-insensitive: anything containing `token`,
  `secret`, `password`, `apikey`, `authorization`, `cookie`, `credential`,
  `privatekey`, `sessionkey`, `clientsecret`.
* **By value shape**, for secrets arriving under innocuous keys: `eyJ…` (JWT),
  `sk-…`, and `Bearer …`.
* **Whole environments**: a field named `environ`/`environment`/`envvars` is
  replaced entirely.
* **Bounded**: strings over 8 KiB are truncated on a character boundary; a raw
  payload over 64 KiB is dropped in favour of the normalized form; recursion
  stops at depth 32.

The `redacted` column records when anything was destroyed or truncated.

Verified on the live database: 9 255 stored payload fields scanned, **0**
token-shaped matches.

## 7. Idempotency

`--idempotency-key` is optional and scoped per project.

* Same key + materially identical request → the existing run is returned,
  `idempotent_replay: true`, and **no second execution is submitted**.
* Same key + different request → typed `idempotency_conflict`, exit code **4**.
* Concurrency is settled by the unique index, not by application logic.
* Behaviour survives Node restart because the key lives in the database.

"Materially identical" is an FNV-1a digest over the canonical JSON of project,
session, runtime kind, and the redacted request. It is a change detector, not a
security control.

## 8. Replay semantics

`run events --since-seq N` returns every stored event with `seq > N`, in append
order. `run follow --since-seq N` replays that tail and then continues with live
events, with no gap: the terminal event is committed in the same transaction as
the terminal status, so once a caller observes a terminal status it has by
construction already seen every event.

Replay reads **only** the journal. A terminal run replays completely without
contacting Hermes, which is what makes history survive a container restart that
wipes the backend registry.

Duplicate delivery is harmless by design (dedupe keys), so a client that
re-reads from a stale cursor cannot corrupt anything.

**Transport contract for the future Control Plane**: `seq` is the cursor. When
Asterism Node exposes HTTP/SSE, `Last-Event-ID` maps directly onto `since_seq`,
and the same `events_since(run_id, after_seq, limit)` call serves it. No Node
server exists yet; the storage and cursor semantics are implemented behind the
CLI exactly as they will be exposed.

## 9. Reconciliation

Runs before every `run start` and on demand via `run reconcile`. It is skipped
entirely when a worker holds the project lock, because a live worker is
authoritative and must not be second-guessed.

Decision table for a non-terminal run:

| Evidence | Result |
| --- | --- |
| Hermes still reports the run | adopt its status |
| Hermes forgot it, events were journalled | `interrupted` — execution was cut short, outcome unknown |
| Hermes forgot it, no events ever | `lost` — no evidence it ran |
| Never submitted, no worker claimed it | `lost` |

A run is **never** silently marked completed, and nothing is ever resubmitted
automatically. Each decision appends a synthetic `asterism.reconciled` event
carrying the previous status, new status, reason, and the backend status
observed. Previously journalled history is preserved untouched.

**Orphan re-attach.** If reconciliation finds a run Hermes still reports as
`running` or `waiting_for_approval`, a fresh worker is spawned to resume
following it. Without this the run would keep executing unobserved while the
freed single-flight slot allowed a second run to start alongside it. The
resumed worker skips submission and attaches to the existing backend run, so
re-attachment never executes the task twice. Re-attach is deliberately limited
to backend-confirmed live runs: an `interrupted` run whose backend is gone is
left alone, which keeps repeated reconciliation a clean no-op.

## 10. Approval persistence

On `approval.request`: the event is journalled, the run transitions to
`waiting_for_approval`, and a row is written to `run_approvals` with the command
and the offered choices.

`run approve --choice …` claims the decision durably **before** calling Hermes,
using `UPDATE … WHERE decision IS NULL`. A second attempt finds no pending
approval and is refused without sending anything, so a decision is applied at
most once. The backend response is journalled as
`asterism.approval.decision` and linked back through `resolution_seq`.

The decision survives client disconnect: it lives in the database, and the
detached worker — not the CLI — is what observes the run resuming.

A container restart while an approval is pending resolves to `interrupted` or
`lost` by the §9 table. Asterism does not pretend a stored approval remains
actionable against a backend that has forgotten the run.

## 11. Execution integration

`run start` creates the durable record and spawns a **detached worker process**
(`run worker`, hidden), then optionally tails the journal. The worker owns the
whole lifecycle: single-flight lock → `starting` → submit → store the Hermes run
id → `running` → consume SSE → journal every event → resolve the terminal state
→ release the lock. The kernel releases the advisory lock if the worker dies, so
a crash cannot wedge the project.

The API key reaches the worker through the inherited environment, never as a
command-line argument.

**Stream resume.** Hermes ends the SSE stream whenever a run parks — most
visibly on `approval.request` — even though the run is still alive. Treating the
first stream end as the end of the run made Asterism record `interrupted` for
runs Hermes went on to complete. This was caught in live testing and fixed: the
worker reconnects until Hermes reports a terminal status or forgets the run.
Replayed frames are absorbed by the dedupe keys. A run that produces no new
events for 900 s while Hermes still calls it active is recorded `interrupted`;
the budget comfortably exceeds the 300 s Hermes approval timeout.

If the worker never claims the run, `run start --wait` stops after 30 s and
records `failed` with `worker_start_failed` rather than hanging.

## 12. Acceptance results

All against Hermes 0.20.0 in the default safe configuration
(`model.openai_runtime: auto`, `approvals.mode: manual`). The unsafe native Codex
override was **not** enabled at any point.

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Durable run end to end | **PASS** | 9 events journalled, `completed`, output `PHASE_D_OK` captured |
| 2 | Survives CLI disconnect | **PASS** | CLI `kill -9`; journal grew 87 → 545 → 1 658 events, run reached `completed` |
| 3 | Full replay | **PASS** | 1 658 events, strictly increasing unique `seq` |
| 4 | Replay from cursor | **PASS** | `--since-seq 1650` returned exactly seq 1651–1658 |
| 5 | Terminal replay without Hermes | **PASS** | `run follow` on a terminal run returned immediately from the journal |
| 6 | Idempotent creation | **PASS** | Same key → same `arun_…`, `idempotent_replay: true`, one run in the registry |
| 7 | Idempotency conflict | **PASS** | Different request → `idempotency_conflict`, exit code 4 |
| 8 | Single-flight refusal is durable | **PASS** | Second run persisted as `failed` / `run_conflict`, not just an ephemeral error |
| 9 | Cancellation | **PASS** | Request, backend response, and `run.cancelled` all journalled; final `cancelled` on backend evidence |
| 10 | Cancellation idempotent | **PASS** | Repeat returned `already reached a terminal state`, no state change |
| 11 | Approval persisted | **PASS** | Command and choices stored; run parked in `waiting_for_approval` |
| 12 | Delayed approval honoured | **PASS** | 20 s delay, then `deny` accepted, `resolved: 1` |
| 13 | Approval at most once | **PASS** | Retry refused, no second decision sent; denied command did not execute |
| 14 | Run resumes after approval | **PASS** | Final `completed`, matching Hermes — the bug from the first attempt |
| 15 | Container restart mid-run | **PASS** | Worker recorded `interrupted` / `stream_broken`; 656 events preserved; no fabricated result |
| 16 | Orphaned run reconciled | **PASS** | Worker killed; reconcile adopted Hermes' `completed`, history preserved |
| 17 | Reconcile idempotent | **PASS** | Repeated reconcile: `reconciled: 0`, event count unchanged at 658 |
| 18 | Node restart | **PASS** | A brand-new process read all 1 658 events and the run status |
| 19 | Registry unreachable from container | **PASS** | Only two binds; zero `registry.db` files inside the container |
| 20 | Redaction | **PASS** | 9 255 payload fields scanned in the live database, 0 token-shaped matches |
| 21 | Schema and migrations | **PASS** | Version 1; reopen is a no-op; newer version refused; corrupt file fails closed |
| 22 | **Durable execution across container restart** | **NOT ACHIEVED** | Hermes loses the run; only metadata and prior events survive |

Test suite: `cargo fmt --all --check` clean, `cargo clippy --all-targets -D
warnings` clean, `cargo test` **105 passed** (47 baseline + 58 new),
`cargo build` clean.

## 13. Files changed

New:

* `src/runstate.rs` — lifecycle states and transition validation
* `src/redact.rs` — recursive redaction and payload bounding
* `src/registry.rs` — SQLite store, schema, migrations, runs, journal, approvals
* `src/runner.rs` — execution, normalization, stream resume, reconciliation
* `docs/phase-d-run-registry.md` — this report

Modified:

* `src/main.rs` — `run` command family, detached worker, orphan re-attach
* `src/lib.rs`, `Cargo.toml` — module and dependency wiring
* `README.md` — new commands and durability guarantees

The pre-Phase-D `hermes run` subcommand was removed. It maintained its own
non-durable run path, which directly contradicts this phase's objective; the
low-level `hermes status/events/approve/stop` debugging commands remain.

## 14. Known limitations

* **Execution is not durable.** A run in flight when the container restarts is
  lost by Hermes and recorded `interrupted`. Only metadata and already-journalled
  events survive.
* **No Node server yet.** Replay is CLI-only. The cursor contract is defined but
  `Last-Event-ID` has no transport to ride on.
* **`interrupted` never settles by itself.** By design it is non-terminal, so
  such runs stay in `active_runs` until a human or a future retry operation
  resolves them.
* **Dedupe is content-derived.** Hermes emits no event ids, so two byte-identical
  frames with the same timestamp are treated as one. Message deltas carry
  distinct timestamps in practice, but this is a heuristic, not a guarantee.
* **Idempotency fingerprint is non-cryptographic** (FNV-1a). Adequate for change
  detection, unsuitable as a security control.
* **Approval timeout is Hermes'.** Asterism does not enforce its own deadline.
* **Follow polls at 250 ms** rather than being event-driven.
* **Forced credential refresh remains untested** (carried over from Phase C).

## 15. Next architectural step

**Phase E — Asterism Node service and Control Plane transport.**

The registry now holds everything an external consumer needs, but nothing can
reach it except a local CLI. The next step is a Node-local HTTP/SSE service that
exposes run creation, queries, live event streaming with `Last-Event-ID` replay,
approval resolution, and cancellation over the contract defined in §8 — turning
the durable state Phase D produced into something the Control Plane can consume,
and giving reconciliation a natural place to run at startup rather than
piggybacking on the next CLI invocation.
