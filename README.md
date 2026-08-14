# Asterism

Central management for persistent AI development agents running on remote
project servers.

An Asterism Node runs on a server you control, supervises one container per
project, and maintains a single outbound authenticated connection to a central
Control Plane. Operators drive work from a browser: create runs, watch output
live, answer approvals, cancel, retry, and read durable history — without any
inbound port on the server and without provider credentials ever leaving it.

## Status

**Pre-release.** Phases A through H are accepted; there is no published release,
no version tag, and no upgrade path. Deployment is manual. Do not run this
against anything you cannot afford to rebuild.

What works and has been proven end to end against real infrastructure:

* Node enrollment, Ed25519 channel authentication, and identity rotation.
* Real runs executed by Hermes, with ordered event streaming and replay.
* Multi-project operation on a single Node, concurrently.
* Reconnection across a Control Plane outage, and recovery across restarts of
  both the Control Plane and the Node.
* Multi-tenant product: organizations, RBAC, invitations, browser sessions,
  audit — with cross-tenant isolation enforced in the database.
* A React operations console covering the full workflow.

This repository is **public**. Its full history is world-readable, and no
credential or runtime state has ever been tracked in it — see
[`SECURITY.md`](SECURITY.md).

**No software license has been selected. Public visibility grants no rights to
use the software — see [License status](#license-status).**

## Architecture

```mermaid
flowchart LR
    C[Operations console] -->|HTTPS| CP[Control Plane]
    CP --- DB[(PostgreSQL)]
    N[Asterism Node] -->|outbound WSS, Ed25519| CP
    N --- R[(SQLite registry)]
    N -->|loopback| H1[Hermes / project A]
    N -->|loopback| H2[Hermes / project B]
```

* **Control Plane** owns users, organizations, RBAC, browser sessions, product
  state, durable commands, run history, event replay, and audit.
* **Asterism Node** runs on the Node owner's server. It owns project container
  lifecycle, the durable local run registry and event journal, reconciliation,
  approvals, cancellation, and retry semantics.
* **Hermes** is the agent runtime inside each project container. It owns the
  agent loop, tools, provider integration, model calls, memory, approvals, and
  execution behavior. **Asterism does not reimplement any of it.**

The connection direction is always Node → Control Plane. The browser never talks
to a Node or to Hermes.

See [`docs/architecture.md`](docs/architecture.md) for the full picture.

## Repository structure

```
src/                      Asterism Node (Rust)
tests/                    Node integration tests
control-plane/            Control Plane backend (TypeScript, Fastify, PostgreSQL)
control-plane/web/        Operations console (React, Vite)
control-plane/migrations/ Numbered SQL migrations with .down.sql pairs
docs/                     Architecture, trust model, operations, phase reports
docs/protocol/            Protocol v1 specification and cross-language fixtures
fixtures/                 Reproducible acceptance fixtures
scripts/                  Build and acceptance tooling
docker/                   Project runtime image
```

## Prerequisites

| Tool | Version |
| --- | --- |
| Rust | 1.97.1 (edition 2024) |
| Node.js | 20.19.2 LTS |
| npm | 11.4.1 |
| PostgreSQL | 16 |
| Docker | for project containers and the Compose stack |

The backend and console are separate npm packages with separate lockfiles.
Install each independently.

## Local development

```sh
git clone git@github.com:Patternity/asterism.git
cd asterism

cargo build
(cd control-plane && npm ci)
(cd control-plane/web && npm ci)
```

### Control Plane

```sh
docker run -d --name asterism-dev-postgres \
  -e POSTGRES_USER=asterism -e POSTGRES_PASSWORD=asterism \
  -e POSTGRES_DB=asterism_dev \
  -p 127.0.0.1:55432:5432 postgres:16-alpine

cd control-plane
export DATABASE_URL="postgres://asterism:asterism@127.0.0.1:55432/asterism_dev"
export PUBLIC_BASE_URL="http://127.0.0.1:8080"
export ALLOWED_ORIGINS="http://127.0.0.1:5173"
export ALLOW_PLAINTEXT=true

npm run migrate
npm run admin:create   # first Owner; the password is typed, never an argument
npm run dev

cd web && npm run dev  # console on :5173
```

There is no public signup. The first Owner is created by CLI; everyone else
enters through an expiring, single-use invitation.

`.env.example` documents every setting. Production refuses `ALLOW_PLAINTEXT` and
a non-HTTPS `PUBLIC_BASE_URL`.

### Asterism Node

```sh
cargo build --release

# One-time enrollment; the token is read from stdin, never from argv.
./target/release/asterism-node node enroll \
    --control-plane https://control.example --token-stdin < token

# Register and provision a project, then supervise it.
./target/release/asterism-node project register --project-id demo \
    --workspace /srv/demo --runtime-endpoint http://127.0.0.1:18643
./target/release/asterism-node project ensure --project-id demo \
    --workspace /srv/demo --hermes-data /var/lib/asterism/demo/hermes \
    --api-key "$ASTERISM_HERMES_API_KEY" --api-port 18643 \
    --model gpt-5.6-sol --model-provider openai-codex
./target/release/asterism-node project auth --project-id demo

./target/release/asterism-node node serve --project demo
```

The daemon listens on a Unix socket only — no inbound TCP port.
[`docs/node-operations.md`](docs/node-operations.md) is the command-level
reference.

## Tests

```sh
# Node
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build

# Control Plane backend
cd control-plane
npm run format:check && npm run lint && npm run typecheck && npm run build
npm test                    # integration tests need DATABASE_URL

# Operations console
cd control-plane/web
npm run format:check && npm run lint && npm run typecheck && npm run build
npm test                    # unit
npm run test:e2e            # mocked Chromium
```

### Acceptance

```sh
scripts/phase-h-acceptance.sh
```

Runs every static, unit, integration, build, audit, and mocked browser check
across all three packages. Requires PostgreSQL and Chromium; touches no live
infrastructure.

`PHASE_H_LIVE=1` additionally requires a fully provisioned live stack and all
live evidence inputs. It is an explicit opt-in operation — see
[`docs/development.md`](docs/development.md).

## Supported Hermes runtime path

The **normal Hermes agent loop** is the supported default and the only runtime
path that should be used.

Native Codex App-Server support is **experimental and disabled by default**. Its
approval-forwarding path is incomplete: approval requests raised under it never
reach the Asterism API, so an operator cannot see or answer them. Do not enable
it on anything that matters.

## Security and trust model

A project container — the workspace, the Hermes runtime, and the provider
credentials the Node owner installs for that project — is **one trust domain**.
Code that runs inside it can read the credentials inside it. That is a property
of the trust model the Node owner chose, not an unresolved defect.

**Credentials never travel through the Control Plane.** They are installed
locally, per project, by the Node owner.

Asterism protects the boundaries around that domain:

* **Node identity** — Ed25519 private key, `0600`, never leaves the Node home.
* **Control Plane secrets** — never on a Node or in a project container.
* **Host separation** — no Docker socket, no access to the Node home or registry.
* **Project-to-project isolation** — separate containers, workspaces, credential
  stores, and ports.
* **Tenant isolation** — enforced by composite foreign keys in the database.

Asterism **does not** claim isolation between Hermes and the code Hermes
executes. Pointing a project at an untrusted repository carries the normal risks
of executing untrusted code.

Full statement: [`docs/trust-model.md`](docs/trust-model.md). Reporting:
[`SECURITY.md`](SECURITY.md).

## Known limitations

* No installer, package, service unit, or upgrade mechanism.
* No bundled TLS — a reverse proxy is required and not supplied.
* No backup or restore tooling. `.asterism/` holds the Node private identity and
  every project's credentials; treat it as a secret store.
* Only a single Control Plane instance has been tested, though the schema and
  queries are written for concurrent instances.
* No load or failure-injection testing.
* `node.resume` is not implemented; a reconnecting Node re-synchronises from
  durable state instead.
* Identity rotation has no grace window — the old key stops working immediately.
* Project configuration is seeded on first container boot, so pins are applied
  after the first start and require a restart.
* The deprecated Phase G `/v1` operator surface uses a shared bearer token and is
  **not** user authentication. It is off by default in production.
* Required approving reviews on `master` are set to 0 while there is a single
  maintainer. A pull request and all CI checks are still mandatory. See
  [`docs/deployment.md`](docs/deployment.md#repository-protection).

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | Component responsibilities, ownership, boundaries |
| [`docs/trust-model.md`](docs/trust-model.md) | What Asterism protects and what it does not |
| [`docs/development.md`](docs/development.md) | Commands, database setup, protocol changes |
| [`docs/deployment.md`](docs/deployment.md) | Supported deployment and its limitations |
| [`docs/node-operations.md`](docs/node-operations.md) | Node CLI reference |
| [`docs/protocol/v1.md`](docs/protocol/v1.md) | Normative protocol specification |
| [`control-plane/README.md`](control-plane/README.md) | Backend and operator API |
| [`SECURITY.md`](SECURITY.md) | Reporting, secret handling, boundaries |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Workflow, conventions, architecture boundary |

Phase reports `docs/phase-a-*` through `docs/phase-h-*` record how each stage was
proven, including the defects that proving it exposed. They are historical: where
one conflicts with `architecture.md` or `trust-model.md`, those are the
authority.

## License status

No software license has been selected or granted for Asterism at this stage.

The source code is publicly visible for review and evaluation. Public
availability does not grant permission to use, copy, modify, redistribute,
sublicense, sell, host, or provide the software as a service.

All rights are reserved until an explicit license is published.

The repository is public because branch protection and CI are available to
public repositories on GitHub Free. That is an operational reason, not a
licensing decision: Asterism is **not** open source, and it is **not**
source-available under any recognized license.

The permanent licensing and commercial model will be selected later. Until then,
treat the absence of a license as the answer it is.

This statement covers Asterism's own source. Third-party dependencies remain
under their own licenses, recorded in `Cargo.lock`,
`control-plane/package-lock.json`, and `control-plane/web/package-lock.json`;
nothing here claims ownership of them or alters their terms.
