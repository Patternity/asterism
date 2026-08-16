# Asterism Node — operations reference

Detailed, command-level reference for operating an Asterism Node and its project
containers. This grew during Phases A through G and is kept because it is the
most complete record of the Node CLI in practice.

Start with the root [`README.md`](../README.md) for the product overview,
[`architecture.md`](architecture.md) for what each component owns, and
[`deployment.md`](deployment.md) for the supported deployment path.

> Some sections below describe constraints from the phase they were written in.
> Where a statement conflicts with [`architecture.md`](architecture.md) or
> [`trust-model.md`](trust-model.md), those documents are the authority.

This repository now contains the accepted Phase H Asterism system: the Rust
Node and project/Hermes runtime developed in Phases A–F, the Phase G outbound
Control Plane protocol, and the Phase H multi-tenant product API and React
operations console. Phase H is complete; see
`docs/phase-h-status.md` for the final gate matrix and evidence.

The original Phase A architecture proof below remains the foundation of the
runtime boundary.

The proof validates one boundary:

```text
Asterism Node
      |
Project Container
      |
    Hermes
      |
Test Repository
```

There is no Control Plane, custom agent loop, custom memory system, agent driver, or Codex integration in Phase A.

## Goals

Phase A must demonstrate that Asterism Node can:

- provision and control one isolated project container;
- persist the project workspace separately from Hermes state;
- start Hermes in gateway/API mode;
- drive Hermes through its public HTTP/SSE API;
- observe capabilities, run state, progress events, and approvals;
- stop and restart the runtime without losing persisted project state;
- keep the host Docker socket and unrelated host paths out of the project container.

## Prerequisites

- Linux host
- Rust stable with Cargo
- Docker Engine
- a Hermes-supported model provider configured through the Hermes setup flow
- OpenSSL or another secure random generator for the local API key

The current proof uses the Docker CLI as the container-runtime boundary. It invokes Docker with argv arrays and never uses a shell.

## Build and test

```bash
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build
```

The complete Phase H local gate is:

```bash
scripts/phase-h-acceptance.sh
```

An explicitly provisioned live stack can additionally run the strict seven-
scenario gate with `PHASE_H_LIVE=1`; required evidence variables are documented
in `control-plane/web/README.md`.

## Pin the Hermes image

Hermes upstream documentation commonly shows `nousresearch/hermes-agent:latest`. Asterism production deployments must use an immutable digest. For the proof, resolve the current image once and keep that digest for the entire test run.

```bash
docker pull nousresearch/hermes-agent:latest
docker image inspect \
  --format '{{index .RepoDigests 0}}' \
  nousresearch/hermes-agent:latest

export ASTERISM_HERMES_IMAGE='nousresearch/hermes-agent@sha256:REPLACE_WITH_REAL_DIGEST'
```

The CLI permits an unpinned image for discovery and emits a warning when one is used.

## Prepare the proof project

The repository contains a small fixture under `fixtures/test-project`.

Create a private Hermes API key. Do not commit it:

```bash
export ASTERISM_HERMES_API_KEY="$(openssl rand -hex 32)"
```

Hermes' official image runs agent services as its non-root `hermes` user. Asterism Node reads the UID/GID that owns the project workspace and passes them as `HERMES_UID`/`HERMES_GID`, matching the official Hermes bind-mount pattern. The proof refuses to start a project runtime when that owner is root. Use a dedicated non-root project workspace rather than a privileged host path.

## Build the project image (Phase B)

Phase B drives Hermes' native `codex app-server` runtime, which requires the
Codex CLI inside the project container. Build a derived image instead of
mutating a running container:

```bash
scripts/build-project-image.sh
```

The script pins both inputs — the Hermes base image by digest and the Codex CLI
by version — verifies `codex --version` as the non-root runtime user, and stamps
provenance labels (`io.asterism.codex-version`, `io.asterism.hermes-base`).
Override with `--base`, `--codex`, or `--tag`. An unpinned base is rejected.

```bash
export ASTERISM_HERMES_IMAGE='asterism/project-runtime:hermes-0.20.0-codex-0.147.0'
```

## Authenticate a provider

`project auth` runs an interactive device-code login **inside** a running
project container, as the Hermes runtime user:

```bash
cargo run -- project auth --project-id phase-a --provider openai-codex
cargo run -- project auth --project-id phase-a --provider codex-cli
```

The two providers are independent credential stores and neither flow rewrites
the other:

| `--provider`   | Command run in the container      | Credential file            |
| -------------- | --------------------------------- | -------------------------- |
| `openai-codex` | `hermes auth add openai-codex`    | `/opt/data/auth.json`       |
| `codex-cli`    | `codex login --device-auth`       | `/opt/data/codex/auth.json` |

The command reads `HERMES_UID`/`HERMES_GID` back from the live container and
execs as that user, so credentials are owned correctly on creation — Phase A
had to repair a root-owned `auth.json` with a manual `chown`. It allocates a TTY
only when the caller has one, never accepts a token as an argument, never parses
or logs credential material, and verifies afterwards that the runtime user can
read the resulting file. It fails loudly when the provider is unsupported, the
container is missing or stopped, or the provider CLI is absent from the image.
It never falls back to an API key.

## Configure Hermes

Run the upstream setup flow once. The resulting provider configuration and credentials persist in the Hermes data directory.

```bash
cargo run -- project setup \
  --project-id phase-a \
  --workspace ./fixtures/test-project \
  --hermes-data ./.asterism/phase-a/hermes
```

The setup container receives only the project workspace and Hermes data bind mounts.

## Start the project runtime

```bash
cargo run -- project ensure \
  --project-id phase-a \
  --workspace ./fixtures/test-project \
  --hermes-data ./.asterism/phase-a/hermes \
  --api-port 18642
```

`project ensure` creates the container when missing, starts it, waits for `/health`, then checks authenticated `/v1/capabilities`.

The Hermes API is published on host loopback only:

```text
http://127.0.0.1:18642
```

## Enable the native Codex app-server runtime

Four Hermes settings are required. They persist in the Hermes data directory, so
they survive container rebuilds:

```bash
docker exec -u 1000:1000 -e HOME=/opt/data -e HERMES_HOME=/opt/data \
  asterism-project-phase-a /opt/hermes/.venv/bin/hermes config set \
  model.provider openai-codex
# hand turns to a `codex app-server` subprocess instead of Hermes' agent loop
... model.openai_runtime codex_app_server
# Codex sandboxes to its own cwd; without this it defaults to /opt/data and
# cannot reach the project workspace at all
... terminal.cwd /workspace
# required today: Hermes fails Codex approval requests closed in gateway mode
... approvals.mode off
```

`CODEX_HOME` is set to `/opt/data/codex` by the container spec and the directory
is pre-created host-side, so Codex credentials and thread rollouts land on the
persistent mount rather than an image layer.

`--terminal-security` on `project ensure` selects the Codex permission profile:
`auto` → `workspace-write`, `approval-required` → `read-only-with-approval`,
`unrestricted` → `full-access`.

Read `docs/phase-b-codex-runtime.md` before relying on this runtime. It does not
behave like Hermes' own loop: every run gets a fresh Codex thread (no
conversation continuity), and approvals are not observable.

**This combination is refused by default.** `project ensure` and `project start`
read the persisted Hermes configuration and fail closed when
`model.openai_runtime=codex_app_server` is paired with `approvals.mode=off`,
because that pairing auto-approves every Codex request and emits no
`approval.request` event:

```json
{
  "error": "unsafe_runtime_configuration",
  "project_id": "phase-a",
  "message": "model.openai_runtime=codex_app_server requires approvals.mode=off to execute, ..."
}
```

Exit code 3. A controlled test requires the scoped opt-in
`--unsafe-allow-codex-approval-bypass`, which prints a loud warning and unlocks
only this one known limitation — it is not a general security switch and is
never enabled implicitly. Stop the project as soon as such a test finishes.

## Credential boundary status

`docs/phase-c-credential-isolation.md` records the current, verified position:
**there is no credential boundary inside the project container.** Commands the
model generates run as the same OS user that owns the OAuth stores, so they can
read both `auth.json` files, the runtime process environment, and copy
credentials into the workspace. This was measured from real agent runs on both
runtimes and is confirmed by upstream Hermes' own source comments.

Treat one project container as **one trust domain**: it must hold credentials
for that project only, never Control Plane credentials, credentials for other
projects, or credentials for other users.

## Inspect Hermes

```bash
cargo run -- hermes health
cargo run -- hermes health --detailed
cargo run -- hermes capabilities
```

## Run the architecture-proof task

```bash
cargo run -- run start \
  --project-id phase-a \
  --session-id phase-a-proof \
  --input "Read PROOF_TASK.md and complete the task exactly as written. Work only inside /workspace." \
  --wait
```

`--wait` streams the durable journal as newline-delimited JSON and finally prints
the run record. The run itself is executed by a **detached worker**, so it
continues — and keeps journalling — whether or not this process stays alive.

## Node home

Everything Asterism Node owns lives under one canonical directory, resolved in
this order: `--node-home` → `ASTERISM_NODE_HOME` → `./.asterism` (the development
default). Relative paths other than that default are refused, so a service can
never adopt a different identity depending on where it was started.

```
<node-home>/node/
    registry.db     runs, journal, projects, remote command state
    asterism.sock   local control socket (0600)
    daemon.lock     singleton lock
    identity.key    Ed25519 private key (0600)
    identity.json   public identity metadata
    config.toml     Node configuration (0600)
```

The directory is `0700` and is never mounted into a project container.
`config.toml` holds the Control Plane URL, display name, reconnect and heartbeat
parameters, project inventory, and the development transport flag. It holds no
secrets: enrollment tokens are never stored, and provider credentials live inside
the project container.

## Register projects

The Control Plane addresses work by **registered project id** and never by host
path. Register a project before it can be used remotely:

```bash
cargo run -- project register --project-id phase-a \
  --workspace ./fixtures/test-project --display-name "Phase A"
cargo run -- project list
cargo run -- project unregister --project-id phase-a
```

Paths are canonicalized on registration and never transmitted. Unregistering is
refused while the project has an active run.

## Node identity and enrollment

Each Node has a persistent Ed25519 identity, created on first use and stored
`0600`. The private key never appears in an argument, an environment variable, a
log, the local API, or a container mount.

```bash
cargo run -- node identity
```

Enroll once with a Control Plane. The one-time token is read from stdin or an
interactive hidden prompt — never as a command-line value, which would be visible
in the process table and shell history:

```bash
cargo run -- node enroll --control-plane https://control.example
# or non-interactively
printf '%s' "$TOKEN" | cargo run -- node enroll \
  --control-plane https://control.example --token-stdin
```

The token is discarded immediately; only the assigned `node_id` is persisted. A
Node that is already enrolled refuses to enroll again.

`https://` is mandatory. Plaintext `http://` is accepted only for a loopback host
and only with `--allow-plaintext-loopback`, which exists so the development mock
server can be exercised without TLS.

## Control Plane connection

After enrollment the daemon maintains a persistent **outbound** WebSocket session
to the configured Control Plane. Asterism Node never opens an inbound port — the
local Unix socket remains the only control endpoint, and the remote link is
dialled out.

Connection state is reported through `node status`, `/v1/health`, and
`/v1/capabilities`: `disabled`, `unenrolled`, `connecting`, `authenticating`,
`connected`, `backing_off`, `draining`, `failed`.

**A disconnected Control Plane never makes the local daemon unhealthy.** Local
CLI operation and run execution continue while the Control Plane is offline,
reconnecting, or unreachable.

Remote commands are limited to a closed allow list — capabilities, project
listing, run create/list/get/cancel/retry, approval resolution, event
subscription, and drain. There is no remote shell, no host path, no credential
access, and no way to enable the unsafe native Codex runtime. Every command is
executed through the same service the local API uses.

See `docs/protocol/v1.md` for the wire protocol and
`docs/phase-f-control-channel.md` for the design and acceptance results.

### Development mock server

Integration tests run against a **mock** Control Plane under `tests/support/` —
a loopback test harness, not a production Control Plane. It exercises
enrollment, the handshake, commands, event replay, and adversarial behaviour:

```bash
cargo test --test control_channel

# a real Hermes run driven through the remote protocol
ASTERISM_HERMES_API_KEY=... cargo test --test live_remote_run -- --ignored --nocapture
```

## Run the Node daemon

Run-related commands are served by a persistent daemon that owns the registry,
active run workers, and reconciliation. Start it in the foreground (a service
manager is expected to supervise it):

```bash
export ASTERISM_HERMES_API_KEY="..."
cargo run -- node serve --project phase-a
```

Registered projects are supervised automatically; `--project` adds to that set.

It reconciles every configured project **before** it starts listening, then
exposes a local HTTP API over a Unix domain socket at
`<state-root>/node/asterism.sock`. There is no TCP listener: the socket is mode
0600 inside a 0700 directory, peers are checked with `SO_PEERCRED`, and it is
never mounted into a project container.

```bash
cargo run -- node status
```

`node status` reports whether a daemon is listening plus its health and
capabilities. SIGINT/SIGTERM drain gracefully: new runs are refused, workers get
up to 20 s, the socket is removed — and active Hermes runs are deliberately
**not** cancelled.

## Durable runs

Asterism Node owns run state. Hermes remains the execution backend, but its
in-memory registry is no longer authoritative: it returns 404 for every run after
a container restart. Node keeps its own record in SQLite at
`<state-root>/node/registry.db`, which is never bound into a project container.

**Every run command requires a running daemon.** There is no standalone
fallback — a second path into run state would restore the split ownership and
races the daemon exists to remove. Without one, commands fail with
`node_unavailable` (exit code 5) and instructions to start it.

```bash
cargo run -- run list   --project-id phase-a
cargo run -- run show   --project-id phase-a --run-id arun_...
cargo run -- run events --project-id phase-a --run-id arun_... --since-seq 120
cargo run -- run follow --project-id phase-a --run-id arun_... --since-seq 120
cargo run -- run cancel --project-id phase-a --run-id arun_...
cargo run -- run retry  --project-id phase-a --run-id arun_...
cargo run -- run approve --project-id phase-a --run-id arun_... --choice deny
cargo run -- run reconcile --project-id phase-a
```

JSON is the authoritative output format for every one of these.

**What survives** CLI exit, client disconnect, daemon restart, container restart,
and host restart: the run record, its lifecycle status and timestamps, its
terminal result or error, its approval decisions, and every event already
journalled — with per-run monotonic sequence numbers.

**What does not**: the execution itself across a *container* restart. Hermes
loses the run and it is recorded `interrupted`, never a fabricated result.
Durable metadata and durable execution remain separate properties.

### Run states

`created`, `starting`, `running`, `waiting_for_approval`, `recovering`,
`completed`, `failed`, `cancelled`, `interrupted`, `lost`.

`recovering` is the only non-terminal recovery state: the node is reconnecting to
a backend run whose outcome is unknown. `interrupted` (continuity definitively
lost) and `lost` (backend cannot find the run) are **terminal**, so no run is
ever parked in a state nothing will resolve. Recovery from either is an explicit
`run retry`, which creates a **new** run linked by `retry_of_run_id` — the
original is preserved and never silently resubmitted.

### SSE cursor behaviour

`run follow --since-seq N` replays every stored event after `N`, then continues
with live events without a gap. SSE `id` is the per-run `seq`, and reconnecting
clients resume with `Last-Event-ID` (or `?since_seq=` / `?last_event_id=` when a
header cannot be set). Replay reads only the journal, so a terminal run replays
completely without contacting Hermes, and duplicate delivery is harmless.

### Idempotency

```bash
cargo run -- run start --project-id phase-a --idempotency-key deploy-42 --input "..."
```

The same key with an identical request returns the existing run and submits
nothing; with a materially different request it fails with `idempotency_conflict`
and exit code 4.

### Lifecycle restrictions

`project stop`, `project remove`, and `project auth` refuse to act while a
project has a durable active run, returning `project_busy` with exit code 6.
Coordination goes through the daemon when it is reachable and falls back to the
durable registry when it is not — an unreachable daemon is never read as
"nothing is running". `--force-interrupt` is a scoped opt-in for stop and remove;
it leaves the run to be reconciled as `interrupted` rather than inventing an
outcome. `project start` asks the daemon to reconcile afterwards.

A second restriction is about ownership rather than timing. Every container
lifecycle command — `setup`, `ensure`, `auth`, `start`, `stop`, `remove` —
refuses a project registered with `--external-runtime`, returning
`externally_managed_runtime` with exit code 7. The Node does not supervise that
runtime, so acting on it would be acting on someone else's process. The refusal
precedes any Docker call, which is what lets an externally managed project be
operated on a host without Docker at all. `project unregister` and
`project status` are unaffected: forgetting a project and destroying a runtime
are different acts. See [`deployment.md`](deployment.md) for the full model.

### Reconciliation

`run reconcile` — also run at daemon startup and every 60 s — resolves runs left
non-terminal by a restart. It parks each in `recovering`, adopts a status Hermes
still reports, records terminal `interrupted` when Hermes forgot a run that had
journalled events, and terminal `lost` when there is no evidence it ever ran. A
run is never silently completed and never resubmitted automatically. If Hermes is
still executing an unobserved run, a worker is re-attached to it instead.

Secrets never enter the registry or the daemon log: payloads are recursively
redacted by key name, by value shape (`eyJ…`, `sk-…`, `Bearer …`), and whole
captured environments are dropped, before anything is written.

See `docs/phase-d-run-registry.md` for the schema and journal design, and
`docs/phase-e-node-daemon.md` for the daemon, the local API contract, and the
corrected state machine.

## Single-flight runs (temporary Phase B constraint)

`--project-id` is required because Asterism Node admits **at most one
non-terminal run per project container**. This is a temporary constraint, not a
scheduler: the Hermes API server executes every run through one shared
server-side agent, so two concurrent runs would interleave inside a single
agent. It is expected to be lifted once the runtime provides real per-run
isolation.

A second run is refused deterministically — stable JSON on stdout and exit
code 2:

```json
{
  "error": "run_conflict",
  "project_id": "phase-a",
  "message": "project phase-a already has an active run: run_... is running"
}
```

State lives under `<state-root>/<project-id>/` (default `./.asterism`,
overridable with `--state-root` or `ASTERISM_STATE_ROOT`):

- `run.lock` — advisory `flock(2)`, released by the kernel if the Node process
  dies, so a crash cannot leave a permanent lock;
- `active-run.json` — the run handed to Hermes, which is what survives a Node
  restart when a run was started without `--wait`.

Restart behaviour is deliberate:

- **Daemon restart** — startup reconciliation parks the run in `recovering`,
  re-checks it against Hermes, and re-attaches a worker if it is still live;
- **Container restart** — the Hermes run registry is in-memory, so the run
  resolves to 404 and is settled as terminal `interrupted`. The project never
  wedges, and the slot is released.

Verify the fixture afterward:

```bash
test -f fixtures/test-project/PROOF_RESULT.txt
grep -Fx 'ASTERISM_PHASE_A_OK' fixtures/test-project/PROOF_RESULT.txt
```

## Approval forwarding

Hermes advertises run approval support through `/v1/capabilities`. The current upstream API implementation accepts `once`, `session`, `always`, or `deny`, and `approval.request` events carry the choices permitted for that request. Asterism Node keeps these values upstream-facing rather than exposing them as a permanent Asterism protocol.

```bash
cargo run -- run approve \
  --project-id phase-a \
  --run-id arun_... \
  --choice once
```

The decision is persisted before it is forwarded, so it is applied at most once
and survives the client that made it exiting. `hermes approve` remains available
as a low-level debugging command that bypasses the registry.

Phase B measured this end to end. On Hermes' own agent loop the path works:
`approval.request` is emitted, the run parks in `waiting_for_approval`, a
delayed response is still accepted, `deny` prevents execution, and `once`
executes exactly one command. On the **native `codex app-server` runtime the
same path is silent** — Codex raises an approval request, but Hermes' Codex
adapter never forwards it, so no `approval.request` reaches the API and the
request fails closed. See `docs/phase-b-codex-runtime.md`.

The Phase A report must record the emitted request and response shapes from the pinned Hermes version before Asterism introduces any normalized Control Plane approval model.

## Restart and persistence test

Record the current run/session and verify the generated file. Then restart the project container:

```bash
cargo run -- project stop --project-id phase-a
cargo run -- project start --project-id phase-a
cargo run -- hermes health --detailed
```

The following must still exist:

- `fixtures/test-project/PROOF_RESULT.txt` on the workspace bind mount;
- Hermes sessions, memory, skills, and configuration under `./.asterism/phase-a/hermes`.

Run a follow-up turn using the same `session_id` and verify the actual session semantics against the pinned Hermes version.

## Container security inspection

The generated container configuration intentionally has:

- no Docker socket mount;
- no host-root mount;
- only the project workspace and Hermes data bind mounts;
- a loopback-only host API binding;
- a non-root runtime UID/GID derived from the dedicated project workspace owner;
- `no-new-privileges`;
- all Linux capabilities dropped first, with a narrow bootstrap set restored for the official Hermes s6 image;
- CPU, memory, and PID limits;
- no `--privileged` mode.

Inspect the effective configuration rather than trusting the command builder:

```bash
docker inspect asterism-project-phase-a
docker exec asterism-project-phase-a sh -lc 'id; test ! -S /var/run/docker.sock'
```

The bootstrap capability set exists because the official Hermes image starts as root, remaps/chowns its data volume when needed, and then uses `s6-setuidgid` to run Hermes services as the non-root `hermes` user. The effective runtime user and capabilities must be verified against the pinned image during the proof.

## Remove only the ephemeral container

```bash
cargo run -- project remove --project-id phase-a
```

This removes the Docker container. The workspace and Hermes data directories are bind-mounted host state and are intentionally preserved.

## Known Phase A limits

The following are intentionally outside this proof:

- Control Plane connectivity and desired-state reconciliation;
- Codex App Server;
- multi-project scheduling;
- automatic image upgrades;
- a durable Node event spool;
- normalized cross-runtime approval schemas;
- strict outbound network allowlisting;
- stronger isolation such as gVisor, Kata Containers, or microVMs.

Docker's default bridge still allows outbound network traffic required for the configured model provider. Production Asterism needs an explicit egress policy before treating the project container as a complete hostile-workload boundary.

## Upstream interfaces used

The proof intentionally depends on a very small Hermes surface:

- `GET /health`
- `GET /health/detailed`
- `GET /v1/capabilities`
- `POST /v1/runs`
- `GET /v1/runs/{run_id}`
- `GET /v1/runs/{run_id}/events`
- `POST /v1/runs/{run_id}/approval`
- `POST /v1/runs/{run_id}/stop`

Primary references:

- https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration
- https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
- https://hermes-agent.nousresearch.com/docs/user-guide/docker

## Control Plane

A TypeScript Control Plane lives in `control-plane/`, backed by PostgreSQL. Nodes
dial it outbound; operators drive runs through it. It implements protocol v1
independently of the Rust Node — see `docs/protocol/v1.md` and the cross-language
fixtures in `docs/protocol/fixtures/v1/`.

```sh
cd control-plane
npm install && npm run migrate && npm run dev
```

`control-plane/README.md` documents the product and compatibility APIs.
`docs/phase-h-product-foundation.md` describes the multi-tenant identity model,
React operations console, deployment, acceptance evidence, and current live-flow
limitation. `docs/phase-g-control-plane.md` remains the protocol proof record.

### Multi-project runtimes

Each project runs its own container on its own host port, so a Node supervising
more than one project must register each project's endpoint:

```sh
asterism-node project register --project-id phase-g --workspace /srv/phase-g \
    --runtime-endpoint http://127.0.0.1:18643
asterism-node project ensure --project-id phase-g --workspace /srv/phase-g \
    --hermes-data /var/lib/asterism/phase-g/hermes --api-port 18643 \
    --model gpt-5.6-sol --model-provider openai-codex
```

`project ensure` pins the model, provider, and terminal working directory rather
than inheriting the container image's defaults, which are not necessarily
compatible with the configured provider.

### Identity rotation

```sh
# Operator, against the Control Plane:
curl -X POST "$CP/v1/nodes/node-1/rotation-token" -H "Authorization: Bearer $OP_TOKEN"

# On the Node, with the daemon stopped:
asterism-node node rotate-identity --control-plane "$CP" --token-stdin < token
```

The Node generates a replacement key and only writes it after the Control Plane
accepts it, so a failure mid-rotation leaves the existing key usable. The
`node_id` is preserved and the identity generation is incremented.
