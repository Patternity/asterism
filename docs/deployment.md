# Deployment

This describes manual deployment: run the Control Plane container, build and
run the Node binary, register projects.

For a supported host there is now an installer that does all of it — see
[`installation.md`](installation.md). This document remains the reference for
deploying by hand, for the Control Plane, and for the container compatibility
mode, none of which the installer covers.

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
`PUBLIC_BASE_URL` is not `https://`. Set `ALLOWED_ORIGINS` to the exact browser
origins — wildcards are rejected by design.

Set `TRUST_PROXY` to the address or CIDR of the proxy hop itself, not to `true`.
`true` trusts every hop, which behind a single known proxy means any client can
claim any source address and defeat the per-source login limit. Leaving it unset
ignores forwarded headers entirely, which is safe but attributes every request to
the proxy.

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

### Production configuration

The tracked `docker-compose.yml` is a development-shaped stack: plain HTTP, a
loopback origin, and `ALLOW_PLAINTEXT` on. That is the right default for a
laptop and the wrong one for a deployment, so production is a separate tracked
overlay rather than edits someone remembers to make — and rather than an
undocumented override file on one host, which is the same thing with no record.

Two files, neither of them holding a secret in git:

| File | Tracked | Holds |
| --- | --- | --- |
| `control-plane/docker-compose.yml` | yes | the stack itself, development defaults |
| `control-plane/docker-compose.production.yml` | yes | production behaviour, values interpolated |
| `<deploy dir>/.env` | no | `POSTGRES_PASSWORD`, bootstrap metadata |
| `/etc/asterism/control-plane.production.env` | no | `PUBLIC_BASE_URL`, `ALLOWED_ORIGINS`, `TRUST_PROXY` |

A deployment normally has exactly one address, and `PUBLIC_BASE_URL` is it.
`ALLOWED_ORIGINS` is a list because a deployment may temporarily answer at more
than one — during a rename, say — but every extra entry widens the set of origins
the API accepts state-changing requests from, so retire them as soon as the
address they cover is gone.

Copy `control-plane/production.env.example` to the second path, mode `0600`,
owner `root`. Every value in it is mandatory: the overlay uses `${VAR:?...}`, so
a missing one stops the deployment instead of quietly reverting to the
development value underneath.

Validate before deploying. This resolves the overlay — proving the files are
valid and every variable is supplied — and then audits the result:

```sh
scripts/check-production-config.sh \
  --env-file .env \
  --env-file /etc/asterism/control-plane.production.env
```

The audit runs wherever it can: a checkout with dependencies installed runs it
directly, while a deployment host — which has no Node toolchain and need not
grow one — runs the compiled copy inside the image the deployment is about to
use, which is the stricter of the two.

It refuses a stack that is not marked production, a plaintext public URL or
allowed origin, a public URL missing from its own origin list, an enabled
plaintext shortcut, compatibility mode left on or left to a default, missing
secrets, a published database port, or an API bound past the reverse proxy that
terminates its TLS. CI runs the same audit against placeholder values, so the
production shape is checked on every change without a secret anywhere near it.

Then deploy:

```sh
cd <deploy dir>
git checkout <revision>

# Build first, and build everything. Compose does not rebuild an image just
# because the checkout moved, so `up -d` alone silently runs the previous build.
# `migrate` is a separate service from the same source: skipping it leaves the
# schema behind the code, and the Control Plane then refuses to start — which is
# the failure working as designed, but only after a deployment that looked fine.
docker compose \
  -f docker-compose.yml \
  -f docker-compose.production.yml \
  --env-file .env \
  --env-file /etc/asterism/control-plane.production.env \
  build

docker compose \
  -f docker-compose.yml \
  -f docker-compose.production.yml \
  --env-file .env \
  --env-file /etc/asterism/control-plane.production.env \
  up -d
```

Development is unchanged and still explicit: `docker compose up -d` with no
overlay is the development stack, and it says so in its own resolved
configuration.

`NODE_ENV=production` is what makes session and CSRF cookies `Secure`. A console
served over HTTPS while the application believes it is in development emits
cookies a network attacker can read; the guard's `node_env` check exists for
exactly that.

### Uploaded images

Chat accepts images from a user's computer as well as public URLs. The bytes are
stored on the Control Plane's own volume; PostgreSQL holds only metadata and an
opaque storage key. Nothing about that is optional-looking: a deployment either
configures storage and a signing key, or has uploads switched off entirely and
says so to the console, which then hides the control.

| Setting | Meaning |
| --- | --- |
| `UPLOAD_HOST_DIR` | the host directory holding the bytes |
| `UPLOAD_DIR` | where that directory is mounted in the container |
| `MEDIA_SIGNING_KEY` | signs the URLs the model provider fetches with |

Create the directory before the first deployment, owned by the container's
runtime user with no access for anyone else:

```sh
sudo install -d -m 700 -o 1000 -g 1000 /var/lib/asterism/control-plane/uploads
```

Generate the signing key once, with `openssl rand -hex 32`, and keep it in the
production env file. It is unrelated to operator tokens, Node identity, Hermes
and provider credentials, and rotating it affects nothing but the image links.

**The provider link is a capability.** The model provider downloads image URLs
from its own infrastructure — it has no browser session and no Asterism
credential — so a stored image is reachable at a signed, unguessable URL that
authenticates by possession alone. **Anyone who obtains one of those URLs can
read that one image.** The design bounds that rather than denying it: one URL
grants one image, the signature covers that attachment id specifically, and
disabling or removing the attachment revokes it immediately. The browser never
receives these links; the console renders images through an authenticated
endpoint instead, and both nginx and the application strip the signature from
their logs.

Storage grows with durable run history: nothing deletes images today, because an
image belongs to a turn that can still be replayed and retried. A quota and a
retention policy are future work. Watch the directory's size.

#### Backup and restore

The database and the image directory are two halves of one thing. Restoring
either without the other leaves runs whose attachments cannot be read, or files
nothing references.

```sh
# Back up together.
docker compose exec -T postgres pg_dump -U asterism asterism_cp | gzip > cp.sql.gz
sudo tar -C /var/lib/asterism/control-plane -czf uploads.tar.gz uploads

# Restore together, then confirm the schema version the service expects.
gunzip -c cp.sql.gz | docker compose exec -T postgres psql -U asterism asterism_cp
sudo tar -C /var/lib/asterism/control-plane -xzf uploads.tar.gz
```

### Operator recovery

Asterism ships no email delivery, no public "forgot password" endpoint, and no
remote administration command. That is deliberate: a self-hosted Control Plane
with a reset endpoint gains an unauthenticated attack surface that exists purely
to undo authentication.

Recovery instead happens where the deployment already grants total trust — on
the host, next to the database. `operator` is a local CLI with no HTTP route
behind it; being able to run it already means holding the server.

```sh
# Reset a password. The prompt is hidden and asks twice.
docker compose --profile tools run --rm operator \
  set-password --email owner@example.test

# Mint a short-lived account with the least privilege that can open a project
# chat, and refuse if that project does not exist.
docker compose --profile tools run --rm operator \
  create --email temp@example.test --display-name "Temporary" \
         --organization org_bootstrap --role developer --project prj_example

# Lock an account out, and let it back in.
docker compose --profile tools run --rm operator disable --email temp@example.test
docker compose --profile tools run --rm operator enable  --email temp@example.test

# Drop every live browser session for an operator.
docker compose --profile tools run --rm operator revoke-sessions --email temp@example.test
```

Automation that cannot type at a prompt pipes the password in explicitly and
confirms explicitly. Both flags are required together: `--password-stdin`
consumes stdin, so there is no channel left for an interactive answer.

```sh
docker compose --profile tools run --rm -T operator \
  set-password --email owner@example.test --password-stdin --yes \
  < /run/secrets/new-operator-password
```

Properties worth relying on:

- The password is never accepted through argv or the environment. Passing
  `--password` or setting `OPERATOR_PASSWORD` is refused, not ignored — a
  silently dropped password leaves nobody sure which credential the account has.
- A non-interactive run without `--password-stdin` fails closed rather than
  prompting into a pipe.
- Passwords are hashed with the same Argon2id parameters and the same minimum
  length the product enforces everywhere else.
- Resetting a password revokes every live session, because the old credential is
  presumed untrusted; `--keep-sessions` opts out for self-rotation.
- A disabled operator cannot authenticate, and their sessions are revoked.
- Every operation writes an audit row naming the operation, the target operator,
  the organization, the time, and `local-recovery` as the actor. No password,
  hash, or token is recorded.
- Only `DATABASE_URL` is read, so recovery still works on a deployment whose
  Control Plane refuses to start over a bad configuration value.

Delete any temporary password file afterwards, and disable a temporary operator
once it has served its purpose.

### Deployment source is not the agent's workspace

The deployment builds from its own checkout, which nothing else writes to:

```text
/srv/asterism/deployment              root-owned clone, detached at one commit
/srv/asterism/control-plane           the agent's workspace, freely edited
/srv/asterism/practice                worktree for the agent's practice projects
/etc/asterism/control-plane.production.env   secrets, 600 root:root, outside git
/var/lib/asterism/control-plane/uploads      attachment bytes, uid 1000
```

These were once the same tree, and the consequences were not theoretical. One
deployment built from a working tree carrying 1,071 lines of uncommitted work;
another silently built an older commit because `git checkout master` had refused
to move and nothing checked. A deployment that cannot name its commit cannot be
reproduced or rolled back to.

Deploy an exact revision:

```bash
sudo scripts/deploy-staging.sh --revision <commit-sha>
```

The script refuses rather than repairs. It stops if the checkout has tracked or
untracked changes, if the revision does not resolve, if the resolved
configuration is not production, if `PUBLIC_BASE_URL` is loopback, if the
uploads mount is absent, or if the application and migration images were not
both built from the requested commit. That last check exists because a stale
migration image against a fresh application is how a deployment ends up refusing
to start on a schema it already shipped.

Every image carries its source commit, so the running container can be asked
what it is rather than having it inferred:

```bash
docker inspect control-plane-control-plane \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
```

### Volume identity does not depend on the directory

`docker-compose.yml` pins `name: control-plane`. Volume names are derived from
the project name, so without pinning it, moving the compose file to a different
directory resolves to new, empty volumes — a Control Plane that starts
successfully with no database.

### Attachments whose bytes are missing

A row in state `ready` whose stored object cannot be read renders as an image
that answers 404 forever, and nothing distinguishes a lost file from storage
mounted at the wrong path. The audit answers that:

```bash
docker compose exec control-plane node dist/src/cli/attachments-audit.js
docker compose exec control-plane node dist/src/cli/attachments-audit.js --apply
```

It reports by default and changes nothing. `--apply` moves unreadable rows to
`disabled`, the state the schema already defines for an attachment that stays
referenced but is not served, so historical runs remain structurally intact.
Repeating it is not a different operation from running it once.

Check the mount before concluding anything is lost. Four attachments were
reported as destroyed when their files had been on the host the whole time,
behind a container pointed at an empty volume.

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

**One project, one VPS, one Asterism Node, one Hermes.** A Control Plane manages
many projects, but each project lives on its own server behind its own Node with
its own agent runtime. Nothing below relaxes that; it only decides *who starts
that runtime*.

### Runtime ownership

Every project records a `runtime_ownership`, and the Node consults it before
touching anything:

| Ownership | Who supervises Hermes | Node may start/stop/remove it |
| --- | --- | --- |
| `external` | the host — an operator today, an installer later | **no** |
| `managed_container` | the Node, via Docker | yes |

`external` is the **host-native path**: Hermes runs as an ordinary process on the
VPS and the Node only talks to it. `managed_container` is the **compatibility
mode** — it is how every project before this existed, it is what such projects
migrate to automatically, and it remains fully supported.

Ownership is fixed at registration. Re-registering a project cannot change it;
the Node refuses rather than silently converting a runtime it does or does not
own. Unregister first if the change is intended.

### Registering an externally managed project

**The external Hermes must already be running and reachable on the endpoint you
give.** The Node does not start it, does not install it, and does not check for
Docker on this path — Docker need not be installed at all.

```sh
asterism-node project register --project-id demo --workspace /srv/demo \
    --external-runtime --runtime-endpoint http://127.0.0.1:8642
```

`--external-runtime` requires `--runtime-endpoint`: there is no container to fall
back to, so an endpoint the Node has to guess would be a broken project.

On a supported platform, [`installation.md`](installation.md) provisions that
host-native Hermes, enrolls the Node, and performs this registration. Elsewhere
it remains a manual operator task.

### Lifecycle of an externally managed project

`project setup`, `ensure`, `auth`, `start`, `stop`, and `remove` are container
operations. Against an `external` project each of them refuses:

```json
{"error": "externally_managed_runtime", "message": "This project's runtime lifecycle is managed outside Asterism Node."}
```

The exit code is **7**. The refusal happens before any Docker call, so it also
holds on a host with no Docker.

`project unregister` still works: removing a project from the Node's registry is
a different act from destroying a runtime, and only the first is the Node's to
perform on an external project.

`project status` works without Docker too. For an `external` project it reports
the project id, its ownership, its endpoint, whether it is enabled, and the
result of a Hermes health probe:

```json
{
  "project_id": "demo",
  "runtime_ownership": "external",
  "runtime_endpoint": "http://127.0.0.1:8642",
  "enabled": true,
  "runtime_reachable": true,
  "runtime_health": "ok"
}
```

`runtime_health` is `ok` when the probe succeeded, `unavailable` when it ran and
failed — that means the *runtime* is unavailable, never that the Node should look
for a container — and `not_probed` when no probe was possible, which is what an
absent or unusable `ASTERISM_HERMES_API_KEY` produces. `runtime_reachable` is
`null` in that last case rather than `false`, because nothing was observed.

### Node-managed container projects

Each such project runs in its own container on its own host port.

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

* **The installer covers one platform family.** Ubuntu 24.04 and Debian 11/12 on
  amd64 with systemd; anywhere else, deployment is manual. There is still no
  distribution package, and upgrading means re-running the installer.
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
