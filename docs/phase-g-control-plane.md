# Phase G — Production Control Plane, Protocol Conformance, Multi-Project Operation

Phase G set out to answer one question: can a Control Plane written independently
of the Rust Node, in a different language, drive real work on a real project
through a real agent runtime? The answer is yes, and this document records how it
was proven, what broke on the way, and what is still not true.

Nothing was committed. The live Node identity, registry, and project state remain
under `.asterism/`.

## 1. What now exists

A TypeScript Control Plane in `control-plane/`, backed by PostgreSQL 16, with:

| Concern | Where |
| --- | --- |
| Validated configuration | `src/config.ts` |
| Pool, transactions, migrations, schema gate | `src/db.ts` |
| Protocol v1, written from the spec | `src/protocol.ts` |
| Repositories for every table | `src/repositories.ts` |
| Node WebSocket channel | `src/node-channel.ts` |
| Enrollment and identity rotation | `src/enrollment.ts` |
| HTTP surface and operator auth | `src/app.ts` |
| Composition and graceful shutdown | `src/main.ts` |

Schema v2, in two numbered migrations with matching `.down.sql` files. The
service refuses to start against a schema it does not support — newer *or* older.

## 2. Cross-language conformance, and the defect it found

Two independent implementations of protocol v1 exist: the Rust Node from Phase F
and this TypeScript service, written from `docs/protocol/v1.md` without porting
Rust code. Language-neutral fixtures live in `docs/protocol/fixtures/v1/`; each
side recomputes every derived value and validates the other's committed output.

Building the second implementation immediately exposed a real ambiguity, which is
exactly what the exercise is for.

The specification said "SHA-256 of a JSON value" without defining
canonicalisation. Rust's `serde_json` orders map keys; JavaScript's
`JSON.stringify` preserves insertion order. `{"b":2,"a":1}` therefore digested
differently in each implementation — a divergence that would have broken command
deduplication across languages.

Fixed by adding §2.1 *Canonical JSON* to the specification: recursively sorted
keys, no insignificant whitespace, explicit string/number/null rules. This is a
clarification, not a wire change — the Rust Node already emitted sorted output, so
no deployed behaviour changed and v1 stays compatible. Fixture
`digest_vectors.key_order` pins it permanently.

**15 Rust conformance tests and 16 TypeScript conformance tests cross-validate
each other.**

## 3. End-to-end acceptance

Run against the real stack: the Rust Node on this host, two Hermes 0.20.0 project
containers, the TypeScript Control Plane, and PostgreSQL. Not mocks.

### 3.1 Enrollment and channel

An operator issued an enrollment token; the Node enrolled over HTTP and opened its
outbound WebSocket. The Ed25519 handshake — implemented independently on each side
— succeeded on the first attempt:

```
node cp state: connected
cp sees: node-1, protocol_version 1, connection_state online
```

The Node's project inventory synchronised automatically, addressed by project id.

### 3.2 A real run, end to end

A run created through the operator API reached Hermes, executed under Codex, and
streamed back a fifteen-event journal:

```
seq=1  asterism.run.accepted      seq=13 reasoning.available
seq=2  asterism.run.submitted     seq=14 run.completed
seq=3  tool.started               seq=15 asterism.run.terminal
...    message.delta ×8
```

The agent read the workspace README and returned `# Asterism Phase A Test
Repository`. SSE replay from `since_seq=12` returned exactly the tail and closed
on the terminal event.

### 3.3 Multi-project operation

Two projects on one Node, each with its own container and host port, driven
concurrently through one Control Plane:

```
phase-a -> "# Asterism Phase A Test Repository"
phase-g -> "# Asterism Phase G Second Project"
```

Each run reached its own workspace. This did not work at first — see §4.

### 3.4 Outage tolerance

The Control Plane was killed while the Node was connected. The Node entered
`backing_off`, retried with exponential backoff, and reconnected without
intervention after an outage of roughly six and a half minutes. No run state was
lost: the Control Plane's facts live in PostgreSQL, and only live sockets are in
memory.

### 3.5 Identity rotation

An operator issued a rotation token bound to `node-1`; the Node generated a
replacement key and presented it:

```
previous fingerprint: 165db83b0c0dc2bc…
new fingerprint:      d2f09e55bdba15cd…
identity_generation:  1 -> 2
```

The Node then reconnected and authenticated under the new key, still as `node-1`.

Rotation deliberately travels over the HTTP enrollment endpoint rather than the
authenticated channel, and therefore **is not a protocol change**: v1 is
untouched. The reasoning is that the case that matters most is a key already
compromised or lost, which is exactly when the authenticated channel is what
cannot be trusted. A rotation token is bound to one Node, single-use, and
short-lived; the old live session is dropped on success so a stolen old key
cannot keep an already-open session alive.

### 3.6 Credential exposure probe

Every credential in play was checked against every artifact the Control Plane
produces. The probe reports presence only and never prints, hashes, or transmits
credential content.

| Artifact | Hermes API key | Operator token | Enrollment token | Node private key | Codex OAuth |
| --- | --- | --- | --- | --- | --- |
| Control Plane database | ABSENT | ABSENT | ABSENT | ABSENT | ABSENT |
| Control Plane log | ABSENT | ABSENT | ABSENT | ABSENT | ABSENT |
| Node daemon log | ABSENT | ABSENT | ABSENT | ABSENT | ABSENT |
| Operator event journal | ABSENT | ABSENT | ABSENT | ABSENT | ABSENT |

Host workspace paths are also absent from the database: the Control Plane
addresses work by project id and has no column for a path.

**The operator bearer token is not user authentication.** It is a single shared
secret for a single trusted operator, adequate for this phase and nothing more.
Real deployments need per-operator identity, and the audit log currently records
`operator` because there is no better answer to record.

## 4. Defects found and fixed

Phase G's value is mostly in what it broke.

### 4.1 Multi-project operation was impossible

`NodeService` held **one** Hermes endpoint for the whole Node, and `project
ensure` defaulted every project to port 18642. Two projects could not coexist:
the second failed to bind, and even if it had, every run would have been
dispatched to the first project's container.

Fixed with registry schema v4: projects carry a `runtime_endpoint`, resolved per
run. `NULL` means the Node-wide default, so every previously registered project
keeps working. Approvals, cancellation, and reconciliation all resolve per project
too — each of them addresses a specific project and would otherwise have talked to
the wrong container. The endpoint is never transmitted: it is a host address.

### 4.2 A reconciled run was reported active forever

The Node reconciled a run to `interrupted`; the Control Plane still showed
`running`, indefinitely. Only `asterism.run.terminal` ended a run — the
`asterism.reconciled` event, which is how a Node reports what it found after a
restart or a lost stream, was ignored.

Fixed: a reconciliation carrying a terminal `new_status` now ends the run. A
reconciliation that returns a run to a live state still does not.

### 4.3 Redaction destroyed telemetry

Both redactors matched the substring `token` on key names, so `usage.input_tokens`
and `enrollment_token_ttl_ms` were logged as `[redacted]`. Token *counts* are the
main operational signal a run produces.

Fixed in both implementations with the same rule: a number or boolean cannot carry
credential content, so key-based redaction applies only to strings and
containers. String secrets under the same key names are still destroyed.

### 4.4 Project provisioning was not reproducible

A freshly provisioned project booted with the container image's defaults —
`model.default: "anthropic/claude-opus-4.6"`, which the ChatGPT-account Codex
route refuses with HTTP 400, and `terminal.cwd: "."`, which resolves to the Hermes
data directory rather than the workspace, so the agent could not see its own
files. Phase A's project only worked because those settings had been corrected by
hand.

Fixed: `project ensure` pins `model.default`, `model.provider`, and
`terminal.cwd` deterministically, using a narrow YAML writer paired with the
existing narrow reader in `policy.rs`. Pinning is idempotent and restarts the
container only when something actually changed.

### 4.5 One busy project could starve another

Command dispatch was strict `ORDER BY created_at`. Fifty commands queued for one
project delayed every other project behind all fifty.

Fixed with a deterministic round-robin: each project's queue is ranked
independently and the ranks interleaved, so a dispatch round takes each project's
oldest command before any project's second. Node-scoped commands that carry no
project share one queue rather than being starved. Ordering is fully deterministic
— `(rank, created_at, command_id)` — so concurrent Control Plane instances agree
on priority, and `FOR UPDATE SKIP LOCKED` keeps them off each other's rows.

## 5. Administrative recovery

A run ends only when its Node says so. If the Node never returns, nothing ever
says so, and the run is reported active forever.

`GET /v1/runs/stranded` lists runs still active whose Node has been silent past a
threshold. `POST /v1/runs/:runId/force-close` closes one, and is deliberately
never automatic:

* it requires an explicit operator reason, recorded in the audit log;
* it records the outcome as `lost`, not `failed` or `cancelled`, because the
  Control Plane genuinely did not observe what the run did;
* it is refused while the Node is online — ask the Node instead.

## 6. Verification

| Gate | Result |
| --- | --- |
| `cargo fmt --all --check` | clean |
| `cargo clippy --all-targets -- -D warnings` | clean |
| `cargo test` | **287 passed**, 1 ignored (live test) |
| `npx tsc --noEmit` | clean |
| `npx eslint src test` | clean |
| `npx prettier --check src test` | clean |
| `npm run build` | clean |
| `npx vitest run` | **68 passed** |

The 68 TypeScript tests include 42 integration tests against a live PostgreSQL
database, covering migrations, operator authentication, enrollment (including two
concurrent requests racing for one token, which must enroll at most one Node),
project inventory synchronisation, run idempotency, event-cursor gaps, dispatch
fairness, identity rotation, and administrative recovery.

## 7. What is still not true

Stated plainly, because a report that only lists successes is not useful.

* **The operator bearer token is not user authentication.** See §3.6.
* **`node.resume` is not implemented.** A Node reconnecting re-synchronises from
  durable state rather than resuming a session, which is correct but slower and
  loses in-flight stream position.
* **Rotation has no revocation grace window.** The old key stops working the
  instant the new one is accepted. That is the safe direction, but an operator who
  rotates the wrong Node must re-enroll it.
* **Provisioning still depends on first boot.** `config.yaml` is seeded by Hermes,
  so the pins in §4.4 are applied after the container's first start and require a
  restart. A config written before first boot would be better.
* **Credentials are shared between a host's project containers.** Phase C already
  established that single-container credential isolation is not achievable here;
  the second project reuses the same account's credentials, and both containers
  are on the same trust boundary.
* **No load or failure-injection testing.** Reconnect was observed once, under one
  natural outage. Behaviour under packet loss, partial writes, or database
  failover is unmeasured.
* **A single Control Plane instance was tested.** The schema and queries are
  written for concurrent instances — `FOR UPDATE`, `FOR UPDATE SKIP LOCKED`,
  deterministic ordering — but two instances have never actually run together.

## 8. Deployment

`control-plane/Dockerfile` builds a two-stage image running as an unprivileged
user with a health check. `control-plane/docker-compose.yml` brings up PostgreSQL,
runs migrations to completion, then starts the service.

The compose file is **development only**: PostgreSQL is unhardened, TLS terminates
nowhere, and `ALLOW_PLAINTEXT` is on. Production configuration refuses both
`ALLOW_PLAINTEXT` and a non-HTTPS `PUBLIC_BASE_URL`, and the service will not
start without them corrected.
