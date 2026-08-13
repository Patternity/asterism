# Phase H — Multi-Tenant Product Foundation and Operations Console

Phase H turns the Phase G Control Plane into a browser product without changing
the accepted execution boundary: the Control Plane owns product state and sends
durable commands over the outbound Node channel; the Rust Node owns project and
Hermes lifecycle. The browser never contacts a Node or Hermes directly.

## Authentication and sessions

There is no public signup. `npm run admin:create` creates the first Owner once;
subsequent users enter through expiring invitations. Email addresses are
normalized and passwords use Argon2id (64 MiB, three iterations, one lane,
32-byte output). Login failures are generic and throttled by account and source.

Browser sessions are PostgreSQL-backed. Only SHA-256 digests of the random
session and CSRF tokens are stored. The session cookie is HttpOnly,
SameSite=Lax, and Secure in production; the separate browser-readable CSRF
cookie is not a credential. Sessions have idle and absolute deadlines and are
revoked on logout, logout-all, password changes, disabled users, or disabled
memberships. Login and organization changes rotate session state.

Every browser mutation requires both an exact configured Origin and a
constant-time verified session-bound CSRF token. Credentialed wildcard CORS is
not used. CSP, frame denial, MIME sniff protection, a no-referrer policy, and a
restricted Permissions Policy are applied globally.

## Organizations, RBAC, and isolation

Users can belong to multiple organizations and select an active membership.
Central default-deny permissions implement Owner, Admin, Developer, and Viewer.
Admins cannot grant Owner; the last active Owner cannot be demoted or disabled.
Developers can create runs and manage only eligible runs they created. Viewers
are read-only.

Migration 003 assigns every historical Phase G Node, project, command, run,
enrollment token, rotation, and audit row to `org_bootstrap`. Composite foreign
keys prevent cross-organization Node/project/run relations. Product repository
queries require an organization ID, including counts, pagination, audit, event
history, and SSE. Foreign tenant identifiers resolve as 404.

Invitation values, enrollment values, and rotation values are returned only
once and stored only as digests. Invitations are expiring and single-use.

## Product API

The browser API is rooted at `/api/v1` and covers authentication, organization
selection, members, invitations, overview, Nodes, projects, runs, replayable SSE,
approval, cancellation, retry, and filtered deterministic audit pagination.
Run operations create durable commands for the existing outbound Node protocol;
they never call Hermes directly or accept host paths.

The old `/v1` operator surface is a deprecated Phase G compatibility mode. It is
not user authentication, is disabled by default in production, is restricted to
the bootstrap organization, and audits every authenticated use. The Node
enrollment and Ed25519 WebSocket authentication surfaces remain separate.

## Operations console

`control-plane/web` contains the React, strict TypeScript, Vite, React Router,
TanStack Query console. It provides login, invitation acceptance, organization
selection, overview, Node list/detail, project list/detail and run creation, run
list/detail, members/invitations, and audit pages.

Server permissions hide unavailable controls, while the backend remains the
authority. Organization changes clear the query client and all tenant query keys
include the organization. EventSource reconnects with an organization/run scoped
cursor stored in sessionStorage; no session credential enters web storage. Run
events render as a safe timeline, assistant output, tool activity, approval UI,
and honest connection state rather than raw JSON or unsupported hidden reasoning.

## Deployment

The multi-stage `control-plane/Dockerfile` builds the backend and console, prunes
development dependencies, and runs the combined service as the unprivileged
`node` user. Compose gives PostgreSQL an internal-only network and persistent
volume, runs migrations before the service, exposes only loopback HTTP, and adds
health and graceful-stop policy. Production must use HTTPS at a reverse proxy.

```sh
cd control-plane
cp .env.example .env
# Set a random POSTGRES_PASSWORD in .env.
docker compose up --build -d

# Set OWNER_EMAIL and OWNER_DISPLAY_NAME in .env, then type the password at the
# hidden prompt. The password is not an argument or environment variable.
docker compose --profile tools run --rm admin-create

# Complete local acceptance (PostgreSQL and Chromium must be available):
../scripts/phase-h-acceptance.sh
```

For native development, install each package independently and run the backend
on port 8080 plus the Vite server. `.env.example` documents every product
security setting. `STATIC_ROOT` is reserved for the built image and normally
does not need manual configuration.

## Acceptance and security result

Automated acceptance covers the RBAC matrix, immediate revocation, last-Owner
protection, two-organization data, cross-tenant reads and mutations, tenant SSE,
login throttling, session rotation/revocation, CSRF, Origin policy, invitation
single use, command dispatch, SSE replay, frontend permission controls, and
organization cache clearing. Browser tests run in Chromium.

The Phase G live state and two Hermes containers were preserved. Their
`openai-codex` provider runs through the normal Hermes agent loop
(`model.openai_runtime: auto`), not Native Codex App-Server. An isolated database
and temporary Node proved browser login, inventory, real Hermes execution,
ordered SSE, replay after reload, and simultaneous work in two projects. That
concurrency test exposed and drove a fix for a SQLite registry-open lock race.

The final strict live gate passed seven of seven serial Chromium scenarios. It
proved real approval denial after reload, approval after the original event
stream disconnected, two-project concurrency, same-project single-flight and
idempotent cancellation, a linked retry after a real Hermes interruption, and
gapless browser history after a Control Plane restart. A separate Node restart
preserved logical identity, public-key fingerprint, project inventory, and
history. `docs/phase-h-status.md` records the machine verdicts and final security
scan. H1 through H4 are accepted.

## Known limitations and next phase

- Email delivery, password reset, verification, MFA, OAuth, billing, SSO, HA,
  Kubernetes, multi-region operation, and split-runtime credential isolation are
  deliberately out of scope.
- Provider credentials still share the project-container trust domain.
- The local Compose topology terminates no TLS and must remain loopback-only.
- A single-host Compose deployment is accepted; HA, orchestration, backups, and
  multi-region operation remain future work.

The recommended next phase is **Phase I: production runtime and credential
isolation**. It should separate provider credentials from model-generated tool
execution, enforce measured egress policy, and harden the accepted single-host
deployment without reopening the Phase H product boundary.
