# Node onboarding

How a person connects a clean server to Asterism, and why the design is shaped
this way. This is the decision record for the phase; `installation.md` remains
the operator's guide and will follow the flow described here as it is built.

## What it has to become

```text
Control Plane -> Add Node -> one command -> watch it install -> approve -> Online
```

Nothing in that line should require deployment documentation, an operator token,
a systemd unit, or knowing what a Hermes profile is. Creating a project comes
afterwards and is a separate operation.

## What exists today, measured

Facts first, because three of the four decisions below turn on numbers rather
than taste.

| | |
| --- | --- |
| Pinned runtime image, compressed | **1.03 GB** across 41 layers |
| Same image, extracted | 3.05 GB |
| What the installation actually occupies | **1.9 GB** in `/opt/asterism` |
| The same trees as one tar, `gzip -6` | **0.55 GB** |
| Published Node binary | 12.8 MB |

The documented "roughly 12 GB free" is a disk requirement — image, extraction,
build caches and the virtualenv at once — not a download. The download is 1.03 GB.

Also established:

* **Entry points** are `install.sh` with no argument (install or repair),
  `--prerequisites`, `--doctor`, `--help`.
* **The Node artifact** is built by `release.yml` inside `debian:11`, so it links
  against glibc 2.31 and runs on every supported platform.
* **The published artifact and the deployed binary differ** because the deployed
  one was built locally in `rust:1-bullseye` from the same revision. Same source,
  different build environment; Rust is not bit-reproducible across environments
  without deliberate work. This is a provenance gap, addressed below.
* **Hermes, Codex CLI and their Node.js** are extracted from the pinned runtime
  image. Python and `uv` are downloaded separately and pinned. SQLite 3.53.4 is
  compiled from a checksum-pinned amalgamation into `pysqlite3` and injected
  through a `.pth` shim, because every interpreter available otherwise carries
  the WAL-reset bug.
* **Provider credentials** are host-owned: `codex login` writes
  `$HERMES_HOME/.codex/auth.json`, and Hermes writes its own
  `$HERMES_HOME/auth.json` on first use. Neither ever leaves the host.
* **Enrollment** issues a token through `POST /v1/enrollment-tokens`, guarded by
  the operator token. The Node calls `POST /v1/node/enroll` with it and receives
  its `node_id`. Identity is an Ed25519 key the Node generates and never sends.
* **Enrollment tokens already store only a digest**, already carry
  `expires_at`, `consumed_at`, `consumed_by`, `revoked_at` and `intended_name`,
  and migration 003 already scoped them to an organization.
* **`node.manage`** is held by `owner` and `admin` and already guards five
  product-API Node routes.
* **The browser already receives live updates** over SSE with a `since_seq`
  cursor, at `/api/v1/runs/:id/events/stream`.

## Decisions

### 1. No new binary. `asterism-node` grows the lifecycle verbs.

```bash
sudo asterism-node node install
sudo asterism-node node update
sudo asterism-node node repair
sudo asterism-node node doctor
```

The binary already uses clap, already has a `node` subcommand group holding
`serve`, `enroll`, `status`, `identity` and `rotate-identity`, and is already the
artifact every release publishes. Installation is the first verb in that same
lifecycle.

**Rejected: a separate `asterismctl`.** It would be a second Rust binary, a
second release artifact, a second checksum, a second provenance chain and a
second thing to keep in step with the protocol — to gain a nicer name. The
bootstrap has to download *something* before anything is installed; downloading
the Node itself means the artifact that performs the installation is the same
artifact that is being installed, verified once.

**Rejected: growing `install.sh`.** It is 1,900 lines of shell running as root
and is already at the limit of what is reviewable. It stays as the supported
path for the current release and is retired once the CLI covers it.

### 2. The bootstrap stays tiny and does four things

```bash
curl -fsSL https://raw.githubusercontent.com/Patternity/asterism/master/scripts/bootstrap.sh | sudo sh
```

and, for reading before running:

```bash
curl -fsSLO https://raw.githubusercontent.com/Patternity/asterism/master/scripts/bootstrap.sh
less bootstrap.sh
sudo sh bootstrap.sh
```

Detect the platform, download the pinned `asterism-node` release, verify its
SHA-256 against the published `SHA256SUMS`, hand over to `node install`, and pass
its exit code through. Nothing else belongs in a script people pipe into a root
shell.

It runs the Node rather than `exec`ing it, which is the difference between
cleaning up after itself and not: an `exec` replaces the process, so the trap
that removes the staged release never fires and the extracted release stays in
`/var/tmp` for good. The exit code is passed through explicitly instead.

The staging directory is under `/var/tmp` rather than `/tmp`. On a small server
`/tmp` is frequently a tmpfs, and staging there spends the machine's memory
rather than its disk. The installer stages beside the runtime for the same
reason, which also puts the free-space check and the final rename on the
filesystem that actually receives the install.

The connection code is never in the command. The Node prompts for it on the
terminal with echo off, reading `/dev/tty` rather than stdin — under
`curl … | sudo sh` stdin is the script itself, so reading it there would consume
the rest of the script and never see a code.

The eventual public form is `https://get.<domain>/node`. That is a redirect in
front of this, so choosing the domain later changes no protocol and no artifact.
The domain is not chosen here and no speculative name is committed.

### 3. The connection code is an enrollment token issued through the product

`Add Node` creates a pending installation and shows a short code. That code *is*
an enrollment token, issued by an authenticated browser session holding
`node.manage`, not by an operator token.

This needs no second identity protocol, because the existing one already has
every property the phase asks for: digest-only storage, expiry, single use,
revocation, organization scope, and an intended name. What is added is a product
route, a rate limit, and a pending-installation row the code points at.

The operator token stops appearing in the onboarding path entirely. It remains
what it is — a break-glass credential for recovery — and is not what a person
uses to add a server.

**Rejected: a bearer capability of a new kind.** A second credential shape with
its own storage, expiry and revocation semantics, to do what the first one
already does correctly.

### 4. Progress is typed state plus a byte counter, streamed like run events

A `node_installations` row carries the typed stage, a generation, a monotonic
sequence, and for downloads the bytes moved and the total. The browser reads it
over SSE with `since_seq`, exactly as it reads run events, so resume after a
reload is the mechanism that already works rather than a new one.

The installer reports outbound over HTTPS using the installation capability,
which can report progress for its own installation and nothing else. No inbound
port is opened, which is the same property the Node's own channel has.

Stages are typed values, never matched English:

```text
waiting_for_installer  preflight  downloading  verifying  installing_runtime
configuring_services   waiting_for_approval    waiting_for_provider
starting               health_check            online
failed                 expired                 cancelled
```

Percentage is weighted per stage, monotonic within a generation, and reaches 100
only after the health check passes. Waiting for a person — approval, provider
authorization — holds its percentage rather than inventing motion.

### 5. Installing a Node no longer mentions a project

The installer stops asking for a project id, a slug, a workspace path, a Hermes
profile or a repository. A fresh Node is capacity: it has an identity, a runtime
and no projects. Projects arrive later through `New project`, which already
provisions them onto a chosen online Node.

Existing installations keep their bindings and their behaviour. Nothing migrates.

### 6. Distribution: a purpose-built bundle, not the runtime image

| Option | Download | Reproducible | Verdict |
| --- | --- | --- | --- |
| Pinned runtime image (today) | 1.03 GB | digest-pinned | carries a full OS userland and build layers the installer discards |
| **Signed bundle of the installed trees** | **0.55 GB** | built in CI from a named revision | selected |
| Native `.deb` | ~0.55 GB | good | three distributions, three builds, and apt cannot express the SQLite shim |
| Small package + separate Hermes | smallest first hop | good | two version lines to keep in step, for one runtime that is always needed |
| OCI artifact of host components only | ~0.55 GB | good | equal to the bundle, plus a registry dependency at install time |

The bundle wins on the only axis that separates it: it contains what is actually
installed and nothing else, which is why it is half the size. It keeps the
accepted Hermes and SQLite behaviour byte-for-byte, because it is built by
performing the current extraction and compile once in CI rather than on every
host — which also removes the per-install Docker requirement and the compile.

Every artifact carries its source revision, version, platform, SHA-256 and a
manifest checked before use. Reproducibility is not traded for size: the bundle
is built once, from a named revision, and every host gets the same bytes.

### 6a. What the bundle actually is

Built by `.github/workflows/runtime-bundle.yml` on a clean `ubuntu-24.04`
runner, by `scripts/build-runtime-bundle.sh`, which *sources* `install.sh` and
calls the same functions a host would — `install_hermes`, `provide_sqlite`,
`configure_sqlite`. One definition of what the runtime is, so the bundle cannot
drift from what the supported installer produces.

The archive is `/opt/asterism` and nothing else: Hermes with its virtualenv, the
Codex CLI with its Node.js, the pinned interpreter, `uv`, and the SQLite 3.53.4
shim. It is packed with sorted names, a fixed timestamp, numeric ownership and
`gzip -n`, so two builds of one revision differ only where the inputs themselves
are not reproducible.

Beside it, `manifest.json`:

```json
{
  "schema": 1,
  "source_revision": "<exact commit>",
  "platform": "linux/amd64",
  "components": { "hermes": "…", "uv": "…", "python": "…", "sqlite": "3.53.4" },
  "runtime_image": "<digest-pinned image the components came from>",
  "archive": { "name": "…", "sha256": "…", "size_bytes": 0 },
  "installed_size_bytes": 0
}
```

The checksum file beside it is `SHA256SUMS.runtime`, not `SHA256SUMS`. A GitHub
release holds every artifact of a version in one flat namespace, and the Node
binary release publishes a `SHA256SUMS` there already. Two files of that name do
not merge: the second upload replaces the first, and one of the two verifications
then reads checksums for an artifact it is not verifying. A test asserts that no
two workflows publish a file of the same name.

`scripts/verify-runtime-bundle.sh` runs before anything trusts the archive, and
fails closed on every question it can ask: no manifest, no checksum file, a
schema this build does not understand, another platform, a manifest that cannot
name its revision, a size or digest that does not match the bytes, or a checksum
file that disagrees with the manifest. Nine tests assert each refusal, because a
verifier that only ever passes is indistinguishable from no verifier.

Provenance is attested with GitHub's own OIDC identity through
`actions/attest-build-provenance`, so `gh attestation verify` ties the archive to
the workflow and revision that produced it without anyone holding a signing key.

### 7. Provenance gaps this phase closes

Three are open today and all three are honest-reporting problems:

* Production Control Plane images can receive `org.opencontainers.image.revision`
  of `unknown` when built without `SOURCE_REVISION`. Release builds must fail
  closed instead.
* The deployed Node binary is a local rebuild rather than the published artifact.
  Normal deployment should install the published, verified artifact.
* Where byte-for-byte reproducibility is not achieved, both builds are identified
  honestly rather than described as one.

## What this phase does not touch

Provider authorization keeps its current shape: host-owned credentials, obtained
by `codex login --device-auth`, never returned to the Control Plane. If it cannot
be driven from the installer safely in the first implementation, the Node reports
`provider_auth_required` rather than claiming to be ready — an honest partial
state is worth more than a green one that lies.

Deferred entirely: at-least-once delivery, the semantic event-history UI, the
MulMul rename, PWA, Web Terminal, code-server and the Workspace Manager.
