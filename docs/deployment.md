# Deployment

This describes what exists today. Asterism has **no installer, no distribution
package, no systemd unit, and no upgrade mechanism**. Deployment is: run the
Control Plane container, build and run the Node binary, register projects.

## Control Plane

### Image and Compose

`control-plane/Dockerfile` is a multi-stage build that compiles the backend and
the console, prunes development dependencies, and runs the combined service as
the unprivileged `node` user with a health check.

`control-plane/docker-compose.yml` gives PostgreSQL an internal-only network and
a persistent volume, runs migrations to completion before starting the service,
and exposes only loopback HTTP.

```sh
cd control-plane
cp .env.example .env
# Set a random POSTGRES_PASSWORD in .env.
docker compose up --build -d
```

### HTTPS is required

The service listens on plain HTTP and **must sit behind a reverse proxy that
terminates TLS**. Compose binds it to loopback for exactly this reason.

Production configuration refuses to start when `ALLOW_PLAINTEXT` is set or
`PUBLIC_BASE_URL` is not `https://`. Set `TRUST_PROXY=true` only when a proxy you
control is in front of it, and set `ALLOWED_ORIGINS` to the exact browser origins
— wildcards are rejected by design.

There is no bundled reverse proxy configuration. Supply your own.

### Migrations

Migrations are numbered SQL files with matching `.down.sql` pairs, applied by a
CLI rather than at service start. Compose runs them as a separate service that
must complete before the Control Plane starts.

```sh
npm run migrate           # apply
npm run migrate rollback  # roll back
```

The service verifies the schema at startup and **refuses to run against a schema
it does not support — newer or older**. Migrate before deploying a new version.

### Create the first Owner

There is no public signup. The first Owner is created once by a CLI; every
subsequent user enters through an expiring, single-use invitation.

```sh
# Set OWNER_EMAIL and OWNER_DISPLAY_NAME in .env, then:
docker compose --profile tools run --rm admin-create
```

The password is typed at a hidden prompt. It is never a command-line argument
and never an environment variable.

## Asterism Node

The Node runs on a server the Node owner controls. Build it from source:

```sh
cargo build --release
# target/release/asterism-node
```

There is no package or service unit. Supervise it with whatever the host already
uses; it runs in the foreground and never forks.

### Node home

Node home defaults to `./.asterism` and is set explicitly with
`--node-home` or `ASTERISM_NODE_HOME`. It holds the Ed25519 private identity
(`0600`), the SQLite run registry, the local Unix control socket, and each
project's Hermes data directory.

**Node home is the backup-sensitive path.** It contains the Node private
identity and every project's provider credentials. Back it up like a secret
store or do not back it up at all. Everything else in a deployment is
reconstructible; this is not.

### Enrollment

An operator issues a one-time enrollment token in the Control Plane, then:

```sh
asterism-node node enroll --control-plane https://control.example --token-stdin < token
```

The token is read from stdin, never from `argv`, so it does not appear in the
process table or shell history. It is never written to disk; only the assigned
`node_id` is persisted.

### Run the daemon

```sh
export ASTERISM_HERMES_API_KEY="..."   # the key the project containers were created with
asterism-node node serve --project phase-a --project phase-b
```

The daemon opens one outbound WebSocket to the Control Plane and reconnects with
exponential backoff across outages. It listens on a Unix socket only — **no
inbound TCP port**, so no firewall rule is needed for it.

### Identity rotation

```sh
# Operator, against the Control Plane:
curl -X POST "$CP/v1/nodes/node-1/rotation-token" -H "Authorization: Bearer $OPERATOR_TOKEN"

# On the Node, with the daemon stopped:
asterism-node node rotate-identity --control-plane "$CP" --token-stdin < token
```

The Node writes the replacement key only after the Control Plane accepts it, so
a failure mid-rotation leaves the existing key usable. The old key stops working
the instant the new one is accepted — there is no grace window.

## Projects

Each project runs in its own container on its own host port.

```sh
asterism-node project register --project-id demo --workspace /srv/demo \
    --runtime-endpoint http://127.0.0.1:18643

asterism-node project ensure --project-id demo --workspace /srv/demo \
    --hermes-data /var/lib/asterism/demo/hermes \
    --api-key "$ASTERISM_HERMES_API_KEY" --api-port 18643 \
    --model gpt-5.6-sol --model-provider openai-codex
```

`project ensure` pins the model, provider, and terminal working directory rather
than inheriting the image defaults, which are not necessarily compatible with the
configured provider. Pinning is idempotent and restarts the container only when
something actually changed.

Registering without `--runtime-endpoint` falls back to the Node-wide default,
which is correct only for a single-project Node.

### Provider authentication

Credentials are installed **locally, per project**, and never travel through the
Control Plane:

```sh
asterism-node project auth --project-id demo
```

This runs the provider's own login flow inside that project's container. The
credentials land in that project's Hermes data directory and are readable by code
that project executes — see [`trust-model.md`](trust-model.md).

The device-code flow needs a browser. It is refused while a run is in flight, so
rotating credentials cannot break a live execution.

## Repository protection

The repository is **public**, so branch protection is available on GitHub Free
for organizations. No paid plan is required.

`master` is protected and verified:

| Control | State |
| --- | --- |
| Pull request required | yes |
| Required approving reviews | 0 — single-maintainer workflow |
| Dismiss stale approvals on push | yes |
| Approval from someone other than the last pusher | not required |
| Required status checks | `Repository hygiene`, `Node runtime (Rust)`, `Control Plane (backend)`, `Operations console (web)` |
| Branch must be up to date before merge (strict) | yes |
| Conversation resolution required | yes |
| Linear history required | yes |
| Administrators included | yes |
| Force pushes | blocked |
| Branch deletion | blocked |
| Bypass for users or teams | none |

The required approving review count is **0** deliberately. A pull request is
still mandatory and every check must still pass; requiring an approval nobody
else can give would only invite bypassing the rule. Raise it to 1 and enable
`require_last_push_approval` as soon as there is a second maintainer.

`.github/branch-protection.json` holds the configuration. Reapply it after any
change:

```sh
gh api -X PUT repos/Patternity/asterism/branches/master/protection \
    --input .github/branch-protection.json

gh api repos/Patternity/asterism/branches/master/protection --jq '{
  checks: .required_status_checks.contexts,
  strict: .required_status_checks.strict,
  admins: .enforce_admins.enabled,
  reviews: .required_pull_request_reviews.required_approving_review_count
}'
```

The required check names match the CI job names exactly. **Renaming a CI job
silently disables the rule that requires it** — rename both together.

### Security features

All free public-repository features are enabled and verified: secret scanning,
push protection, Dependabot alerts, Dependabot security updates, and private
vulnerability reporting.

Two secret-scanning options remain unavailable because they need GitHub Advanced
Security: **non-provider patterns** and **validity checks**. The API accepts the
request and leaves them `disabled`. `scripts/repo-hygiene.sh` covers
project-specific artifacts that GitHub's patterns would miss anyway.

### Public repository consequences

Everything in this repository and its entire history is now world-readable.
Before every push, assume it is permanent:

* a credential pushed here is compromised the moment it lands — rotate it, do
  not merely rewrite history;
* `scripts/repo-hygiene.sh` runs in CI, and push protection blocks known
  credential formats, but neither catches a project-specific secret;
* runtime state stays out of Git by `.gitignore` and stays on disk. Nothing in
  `.asterism/` has ever been tracked.

## Current operational limitations

Stated plainly rather than left to discovery:

* **No installer, package, service unit, or upgrade path.** Deployment is manual.
* **No bundled TLS.** A reverse proxy is required and is not supplied.
* **No backup or restore tooling.** Back up the PostgreSQL database and each
  Node's `.asterism/` yourself.
* **A single Control Plane instance is what has been tested.** The schema and
  queries are written for concurrent instances — `FOR UPDATE`,
  `FOR UPDATE SKIP LOCKED`, deterministic ordering — but two instances have never
  actually run together.
* **No load or failure-injection testing.** Reconnect, restart recovery, and
  concurrency were each proven by real observation, not by fault injection.
* **`node.resume` is not implemented.** A reconnecting Node re-synchronises from
  durable state rather than resuming a session: correct, but slower.
* **Config is seeded on first container boot.** Hermes writes `config.yaml`
  itself, so the pins above are applied after the first start and require a
  restart to take effect.
* **Native Codex App-Server is experimental and off by default.** Its approval
  forwarding is incomplete. The supported runtime is the normal Hermes agent
  loop.
