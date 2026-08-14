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

### Project runtime image

Each project container runs the **Asterism project runtime image**: the pinned
Hermes base plus the Codex CLI. Hermes is developed by Nous Research and the
Codex CLI by OpenAI; Asterism only assembles them. Notices travel inside the
image at `/opt/hermes/LICENSE` and `/opt/asterism/third-party/`.

```text
ghcr.io/patternity/asterism-project-runtime
```

Supported platform: **`linux/amd64` only.** No other architecture is built or
tested, so none is claimed.

Three references exist and they are not interchangeable:

| Reference | Purpose | Safe as the Node default |
| --- | --- | --- |
| `@sha256:<manifest-digest>` | immutable, what Node pins | **yes — the only correct one** |
| `:hermes-<v>-codex-<v>` | human-readable discovery | no |
| `:sha-<short-commit>` | traceability to a commit | no |

A tag can be repointed at different content; a digest cannot. **Never configure a
tag as the reproducible Node default**, including any `latest` tag that may exist
for operator convenience.

The current default, compiled into `DEFAULT_HERMES_IMAGE` in `src/docker.rs`:

```text
ghcr.io/patternity/asterism-project-runtime@sha256:1d280b6595e465909ab93759a4406688c7a156f3f556d90c7b22e58765cd3144
```

`project ensure` uses it with no `--image` argument, pulls it from GHCR without
authentication, and needs no locally built image.

Overriding the image stays possible for development:

```sh
asterism-node project ensure --project-id demo --image <reference> ...
# or ASTERISM_HERMES_IMAGE=<reference>
```

An override without a digest still emits the unpinned-image warning. That
warning is the point: it says the result is not reproducible.

#### Publishing a new image (maintainers)

Publication is automated by `.github/workflows/project-runtime-image.yml`:

* **Pull requests** touching `docker/`, the image scripts, or that workflow
  build the image, guard the build context, and run the smoke test — but never
  push. Untrusted pull-request code cannot reach the registry.
* **Merges to `master`** touching the same paths build the identical definition,
  authenticate to GHCR with the repository's own `GITHUB_TOKEN`, push the
  readable and commit-derived tags, re-run the smoke test **against the pushed
  digest**, and record that digest in the workflow run summary.
* **`workflow_dispatch`** lets a maintainer republish deliberately, with a
  required reason.

The workflow holds `contents: read` and `packages: write` and nothing more.

To change what ships, edit `docker/Dockerfile.codex` — `HERMES_BASE_IMAGE` must
stay a digest and `CODEX_VERSION` an exact version; `scripts/verify-image-context.sh`
fails the build otherwise. Then update the Node default as below.

#### Updating the Node default digest

The digest does not exist until the image is published, so the two steps are
separate pull requests by necessity:

1. merge the image change and let `master` publish it;
2. take the digest from the run summary, verify it pulls unauthenticated, then
   open a second pull request updating `DEFAULT_HERMES_IMAGE` in
   `src/docker.rs` and the tests that assert it.

Never commit a placeholder digest, and never push the update straight to
`master`.

#### Verifying public accessibility

Use an empty Docker configuration so existing credentials cannot make a private
package look public:

```sh
TEMP_DOCKER_CONFIG="$(mktemp -d)"
DOCKER_CONFIG="$TEMP_DOCKER_CONFIG" docker pull \
    ghcr.io/patternity/asterism-project-runtime@sha256:<digest>
rm -rf "$TEMP_DOCKER_CONFIG"
```

Then run the smoke test against the pulled digest:

```sh
scripts/image-smoke-test.sh ghcr.io/patternity/asterism-project-runtime@sha256:<digest>
```

It proves the image starts, the Hermes command and pinned Codex CLI exist,
`/opt/data` and the `/workspace` mount behave, the health endpoint becomes ready
unprivileged, no Docker socket is present, no Codex approval bypass is baked in,
and the required OCI labels are set. It contacts no model provider and needs no
credential.

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

`Project runtime image` is required, and it runs on **every** pull request — not
only those touching the image. A workflow filtered out by path never starts, so
its check never appears, and a required check that never appears blocks the pull
request forever. The job therefore always runs and detects internally whether any
image input changed: if one did it guards the build context, builds, and smoke
tests; if none did it reports an explicit success and does nothing else. A
skipped job is deliberately not used as that success, because GitHub treats a
skipped required check ambiguously.

`Publish project runtime image` is **not** required and must never be: it only
runs after a merge, so requiring it would make every pull request wait for a
status that cannot exist yet.

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

## Project chat

Each project page opens one conversation. A message creates a run; the reply
streams into the chat; the composer is disabled while a turn is in flight because
only one run may execute per project.

Conversation identity lives in `runs.session_id` (schema v4). Nothing is held in
the browser, so a reload or a second operator recovers the same thread. The
active conversation of a project is the session of its most recent run carrying
one.

The raw event journal moved under **Technical details** below the chat. It is
unchanged evidence — exact order, gapless sequence numbers — just no longer the
first thing a reader meets.

One conversation per project is exposed. There is no session list or branching.

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
* **Only one conversation per project is exposed**, and isolation between
  separate Hermes sessions has not been tested or claimed.
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
