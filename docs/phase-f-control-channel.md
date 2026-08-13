# Phase F — Outbound Control Channel and Node Enrollment

Status: implemented and verified, including a real Hermes run driven end to end
through the remote protocol.

The peer used throughout testing is a **mock** Control Plane — a loopback test
harness under `tests/support/`. It is not a production Control Plane and not a
preview of one. What is real in these results is the Node, the protocol, the
cryptography, and Hermes.

`docs/protocol/v1.md` is the normative protocol specification.

## 1. Node home and configuration

Phase E derived every Node path from the process working directory. A remotely
managed service cannot work that way: the same daemon started from a different
directory would adopt a different identity and a different registry.

Resolution order: `--node-home` → `ASTERISM_NODE_HOME` → `./.asterism` (the
existing development default, preserved unchanged). The result is canonicalized,
so nothing downstream can be shifted by a later `chdir`. Relative paths other
than the documented default are refused outright, as are the filesystem root and
paths containing NUL.

One home holds everything Node owns:

```
<node-home>/node/
    registry.db        runs, journal, projects, inbox, outbox, subscriptions
    asterism.sock      local control socket (0600)
    daemon.lock        singleton lock
    identity.key       Ed25519 private key (0600)
    identity.json      public metadata (0600)
    config.toml        Node configuration (0600)
```

The directory is `0700`. None of it is mounted into a project container.

`config.toml` supports the Control Plane URL, display name, project inventory,
Hermes URL, log level, reconnect parameters, heartbeat parameters, and the
development transport flag. Unknown keys are rejected so a typo in a service
configuration fails loudly. It holds **no secrets**: a test asserts that no
field named `token`, `secret`, `password`, or `private_key` exists.

## 2. Project inventory

Remote commands address **registered project ids**, never host paths.

`project register|unregister|list` maintain a table in the Node registry. Each
entry has a stable id, a canonical workspace path, a display name, enabled
state, a creation timestamp, and optional metadata. Registration canonicalizes
the path — removing `..` and symlink ambiguity — and refuses duplicates, the
filesystem root, unreachable paths, and identifiers that could escape their
namespace.

The Control Plane never sees a path: `RegisteredProject` skips
`workspace_path` on serialization, and `remote_view()` emits identity and state
only. Unregistering is refused while the project has a non-terminal run.

## 3. Node identity

A persistent Ed25519 keypair generated from OS randomness, stored `0600`, and
created with those permissions from the outset rather than fixed afterwards.

The private key never appears in an argument, an environment variable, a log
line, the local API, or a container mount. `Debug` is implemented by hand to
render only the fingerprint and node id, so an accidental `{:?}` cannot leak it.
The fingerprint is SHA-256 of the public key, lowercase hex.

Identity fails closed in one direction deliberately: a key that is world-
readable, malformed, truncated, or inconsistent with its metadata is an error,
never a reason to quietly mint a replacement. Silent regeneration would present
the Node to the Control Plane as a stranger and mask a tampered key file.

`asterism-node node identity` shows node id, fingerprint, enrollment state, and
Control Plane URL. Verified live: fingerprint `165db83b…`, both identity files
`-rw-------`, the directory `drwx------`, and no private material in the output.

Identity rotation is **not** implemented and is documented as future work.

## 4. Enrollment

```bash
asterism-node node enroll --control-plane https://control.example
```

The one-time token is accepted from stdin or an interactive prompt with terminal
echo disabled. It is deliberately **not** a command-line value: an argument would
be visible in the process table and in shell history.

The Node sends its public key, fingerprint, display name, supported protocol
versions, and software version over HTTPS with the token in an `Authorization`
header. The Control Plane returns a stable `node_id` and the accepted protocol
version. The Node persists the id and endpoint and **discards the token**.

Verified against the mock: enrollment registers the public key and assigns
`node-1`; the token works exactly once — a second Node using it is refused and
the registered count stays at 1; an already-enrolled Node refuses to enroll
again; and the stored metadata contains no trace of the token.

## 5. Transport security

TLS is mandatory. `https://` and `wss://` are verified against the platform
trust store, and verification cannot be switched off. Plaintext `http://`/`ws://`
is accepted only for a **loopback** host **and** only when
`development.allow_plaintext_loopback` is explicitly set — never implicitly, and
never to a remote address. Tests cover each combination, including the case that
matters most: plaintext to a remote host is refused even with the flag on.

## 6. Protocol envelope

A versioned JSON envelope carrying `protocol_version`, a UUID v4 `message_id`,
`type`, an informational `timestamp`, an optional `correlation_id`, and a typed
`payload`. Frames are capped at 1 MiB and command payloads at 128 KiB. Unknown
optional fields are tolerated for forward compatibility; unknown message types
receive a typed protocol error; malformed frames never terminate the session.

`src/protocol.rs` is independent of the WebSocket implementation, so the
envelope, the transcript, and validation are unit-testable without a socket.

## 7. Handshake and canonical signature

`client.hello` → `server.challenge` → `client.authenticate` → `server.ready`,
with the highest shared protocol version selected in the challenge.

The signed transcript is a JSON object with **sorted keys** and no insignificant
whitespace, every value rendered as a string, containing: `capabilities_digest`,
`client_nonce`, `domain`, `expires_at`, `instance_id`, `issued_at`, `node_id`,
`protocol_version`, `server_nonce`, `session_id`. `domain` is
`asterism-node-auth/v1`, which prevents a signature made here from being valid
elsewhere. A test asserts that changing **any** of the eight variable fields
changes the signed bytes.

Replay protection rests on the nonces, never on `timestamp`. SHA-256 is the only
digest in the protocol; the non-cryptographic hash used for run idempotency never
appears on the wire. Signature verification uses `ed25519-dalek`'s own
comparison — no bytes are compared by hand.

Verified live: the mock verified the signature against the key registered at
enrollment and the session reached `connected` with protocol version 1.

## 8. Command inbox

Delivery is at-least-once; execution is at-most-once.

A command is persisted **before** acceptance is acknowledged. `command_id` is
the deduplication key and the payload digest is SHA-256 over
`{command, project_id, payload}`. A redelivery with the same digest returns the
stored outcome marked `"deduplicated": true`; a redelivery with a different
digest is `duplicate_payload_mismatch`. Stored responses are recursively
redacted and size-bounded.

A daemon restart never re-executes a settled command. Commands caught mid
execution are surfaced by `interrupted_remote_commands()` and are **not**
replayed automatically — a partially executed command may already have had an
effect, and repeating it without evidence could duplicate work.

## 9. Response outbox

Command results and other protocol-critical messages are persisted before being
sent and retained until acknowledged, then resent in insertion order after a
reconnect. Payloads are redacted and bounded. At 1024 unacknowledged entries the
Node **refuses new remote commands** rather than accepting work whose result it
could not report.

Events are deliberately **not** copied here: the journal already provides durable
replay by `seq`, and a second copy would be a second source of truth.

## 10. Event subscriptions and replay

The Control Plane subscribes with project id, run id, and a starting cursor.
Only the cursor is persisted; events stay in the journal. Delivery is strictly
after `acked_seq`, ordered per run, and the acknowledged cursor never moves
backwards, so a late or duplicated acknowledgement cannot cause an endless
resend.

The pump reads SQLite in bounded pages, so nothing is lost to an in-memory queue
and a slow Control Plane cannot block execution — the worker writes to the
journal and the pump lags at its own pace.

Verified: the mock disconnected mid-stream and every event delivered after the
reconnect had `seq` strictly greater than the acknowledged cursor.

## 11. Reconnect

Exponential backoff from `initial_backoff_ms`, capped at `max_backoff_ms`, with
jitter that only ever **shortens** a delay so the ceiling always holds — asserted
directly, including for `u32::MAX` attempts. A session that stays up for
`stable_session_ms` resets the sequence. DNS and connection failures are
reconnects, never crashes.

## 12. Heartbeats and liveness

Application-level `client.heartbeat` → `server.heartbeat.ack` in addition to
WebSocket ping/pong. Payloads carry only safe summaries: instance id, connection
state, registered project count, active run count, draining flag, software
version. Never host paths, environment variables, credentials, prompt content,
source code, or raw event payloads.

Timeout decisions use a **monotonic** clock; wall-clock values are for reporting
only.

## 13. Drain

Remote `node.drain` stops the Node accepting new runs, leaves current runs
executing, reports the active run count, and is durably acknowledged. It cannot
stop the daemon, stop Docker, remove a project, or touch the host.

Four different things, deliberately distinct:

| Action | Effect |
| --- | --- |
| **Remote drain** | No new runs; existing runs continue; daemon keeps serving locally |
| **Daemon graceful shutdown** | Stops accepting, waits for workers, removes the socket, exits — and does **not** cancel Hermes runs |
| **Project stop** | Stops the project container; refused while a run is active |
| **Run cancellation** | Asks Hermes to stop one run; terminal state claimed only on backend evidence |

Verified: after a remote drain the service reported `draining: true` while
`health.status` stayed `ok`.

## 14. Local API compatibility

`/v1/health` now reports the Control Plane state and distinguishes connected,
authentication-failed, and draining. **A disconnected Control Plane never makes
the local daemon unhealthy.** `/v1/capabilities` reports supported protocol
versions, `outbound_only: true`, `inbound_listener: false`, and the channel
snapshot with its metrics.

Verified live with no Control Plane configured: `health: ok`,
`control plane: disabled`, and a full local run completed
(`PHASE_F_LOCAL_OK`). Tests additionally cover an unenrolled Node, an
unreachable Control Plane, malformed and oversized frames, and a reconnecting
session — the local service answers throughout.

## 15. Observability

Counters exposed through the local API: connection attempts, sessions
established, authentication failures, protocol errors, commands received,
duplicate commands, commands rejected, responses retransmitted, events sent, and
heartbeat timeouts. Structured single-line JSON logs cover enrollment,
connection, session establishment, configuration rejection, and session end.

All log fields pass through the recursive redactor before rendering, so a value
that happens to look like a credential cannot reach the log. Enrollment tokens,
private keys, authorization headers, OAuth data, and event content are never
logged.

## 16. Security analysis

| Property | Result |
| --- | --- |
| No inbound TCP listener added by the Node | **Verified** — listener count before/after starting the daemon: 16 → 16, delta 0; 0 TCP sockets owned by the daemon pid |
| Only the mock listens during tests | Verified — the Node reaches it by dialling out |
| Production URLs require TLS | Verified — `http://`/`ws://` to a remote host refused with or without the development flag |
| Plaintext is loopback-only and explicit | Verified — refused without the flag even for `127.0.0.1` |
| TLS validation cannot be disabled silently | No option exists; the HTTPS client uses default verification |
| Private key is `0600` | Verified on disk |
| Containers cannot reach Node state | Node home is not among the project's two bind mounts (Phase E verification stands) |
| Enrollment token is never stored | Verified — absent from identity metadata |
| Remote commands cannot supply host paths | Verified — the wire model has no path field; ids resolve locally |
| Remote commands cannot call arbitrary shell | Verified — closed allow list, `forbidden_command` |
| Duplicate commands do not execute twice | Verified live and against the mock |
| Malformed signatures fail | Verified |
| Wrong identity fails | Verified — a signature from another key is refused |
| Expired challenges fail | Verified — the Node never reached `connected` |
| Frames are size-bounded | Verified — oversized frames rejected before parsing |
| Payloads redacted | Verified in registry, outbox, and logs |
| Remote disconnect cannot interrupt local execution | Verified |
| Control Plane cannot enable unsafe native Codex | No command exists to change runtime configuration |

## 17. Live acceptance results

Against Hermes 0.20.0 in the default safe runtime; the native Codex unsafe
override was never enabled.

| # | Check | Result |
| --- | --- | --- |
| 1 | Enrollment against the mock | **PASS** — assigned `node-1` |
| 2 | Authenticated session established | **PASS** — protocol v1, `sess-906c829d-…` |
| 3 | Remote `runs.create` drove a real Hermes run | **PASS** — `arun_478fc6084defd6db101825eb` |
| 4 | Run reached a terminal state | **PASS** — `completed`, 10 events |
| 5 | Model output as requested | **PASS** — `PHASE_F_REMOTE_OK` |
| 6 | Events delivered over the protocol | **PASS** — 10 events, per-run ordering |
| 7 | Cursor acknowledged durably | **PASS** — `acked_seq = 10` |
| 8 | Redelivered command did not run twice | **PASS** — exactly 1 run in the registry |
| 9 | `node identity` shows no private material | **PASS** |
| 10 | Identity files `0600`, directory `0700` | **PASS** |
| 11 | `project register` / `list` without host paths | **PASS** |
| 12 | No new TCP listener when the daemon starts | **PASS** — delta 0 |
| 13 | Local run with no Control Plane | **PASS** — `PHASE_F_LOCAL_OK` |
| 14 | Health distinguishes daemon vs Control Plane | **PASS** — `ok` / `disabled` |

Test suite: `cargo fmt --all --check` clean, `cargo clippy --all-targets -D
warnings` clean, `cargo build` clean, `cargo test` **255 passed** (213 unit +
22 daemon API + 20 control channel; baseline was 162), plus 1 ignored live test
that passes when run explicitly against a project container.

## 18. Known limitations

* **Identity rotation is not implemented.** A compromised key currently requires
  manual removal of the identity files and a fresh enrollment.
* **Re-enrollment has no reset workflow.** An enrolled Node refuses to enroll
  again by design; recovering requires operator intervention on disk.
* **Interrupted remote commands are surfaced but not resolved.** They are listed
  for reconciliation; no automatic policy decides their outcome.
* **`node.drain` cannot be lifted remotely.** Resuming requires a local restart;
  no `node.resume` command exists in v1.
* **Subscriptions are polled** every 250 ms rather than driven by the journal's
  notification bus.
* **One Control Plane.** No failover, no multi-tenancy.
* **The mock is a harness**, not a conformance suite — it proves the Node's half
  of the protocol, not a server implementation's.
* **The URL parser is minimal.** It enforces scheme and host policy but is not a
  general RFC 3986 implementation.
* **Outbox ordering is global**, not per-correlation-group; sufficient today
  because results are independent.
* Everything carried forward from earlier phases still holds: execution is not
  durable across a container restart, and credentials remain readable inside the
  project trust domain.

## 19. Requirements for the production Control Plane

A real Control Plane implementing this protocol must:

1. **Enrollment** — issue single-use tokens with a short TTL, bind each to an
   organization and an intended Node, invalidate on first use, and store the
   submitted public key against the assigned `node_id`.
2. **Authentication** — build the §5.1 transcript byte-for-byte identically,
   verify the Ed25519 signature against the enrolled key, generate a fresh
   256-bit `server_nonce` per challenge, enforce a short expiry, and **reject a
   reused nonce**. Nonce reuse tracking is mandatory: the Node cannot enforce it.
3. **Version negotiation** — advertise a set, select the highest shared version,
   and close cleanly when none exists.
4. **Command discipline** — use collision-resistant `command_id`s, never reuse an
   id for different work, and be prepared for `"deduplicated": true`.
5. **Acknowledgements** — acknowledge every command result, and acknowledge
   events with the highest **contiguous** `seq` only after durable storage.
   Failing to acknowledge will eventually make the Node refuse new commands,
   which is the intended fail-closed behaviour.
6. **Replay tolerance** — expect duplicate events and results after any
   reconnect and deduplicate on `(run_id, seq)` and `command_id`.
7. **Transport** — terminate TLS with a certificate valid for the configured
   hostname. Plaintext will be refused by every non-development Node.
8. **Least privilege** — never expect to supply host paths, shell commands, or
   credentials; the Node will refuse. Address projects by registered id only.
9. **Backpressure** — a slow Control Plane degrades event delivery, never Node
   execution; do not rely on the Node to buffer indefinitely.
10. **Operational surface** — treat `node.drain` as advisory flow control, not a
    lifecycle command; it can never stop a daemon or a host.

## 20. Next phase

**Phase G — Control Plane conformance and multi-project operation.**

The Node half of the protocol is proven against a harness. The next step is a
second implementation that must interoperate with it — a real Control Plane
service — together with the operational gaps that only appear with more than one
project per Node: per-project concurrency policy, fair event pumping across many
subscriptions, and identity rotation, which is the most significant security gap
this phase leaves open.
