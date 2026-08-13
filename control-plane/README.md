# Asterism Control Plane

TypeScript service that Asterism Nodes dial outbound, and that operators drive
runs through. Backed by PostgreSQL. Written independently of the Rust Node from
`docs/protocol/v1.md` — no protocol implementation code is shared between them,
only fixtures and the specification.

See `../docs/phase-h-product-foundation.md` for the product architecture,
security model, deployment, acceptance evidence, and limitations.

Phase H is complete and accepted. The final H1–H4 matrix, suite counts, live
restart evidence, and security scan are in `../docs/phase-h-status.md`.

## Requirements

* Node.js 20.19.2 LTS
* PostgreSQL 16

## Configuration

Every setting arrives as environment; the image contains none. Copy
`.env.example` and fill it in. Production refuses `ALLOW_PLAINTEXT` and a
non-HTTPS `PUBLIC_BASE_URL`, and will not start without them corrected.

## Development

```sh
npm install
npm run migrate           # apply migrations
npm run dev               # start with tsx
npm test                  # unit and PostgreSQL integration tests
```

`docker compose up --build -d` brings up PostgreSQL, migrates to completion, then
starts the combined API and compiled console on loopback. Copy `.env.example`,
set a random `POSTGRES_PASSWORD`, and keep this HTTP topology on loopback unless
TLS terminates at a trusted reverse proxy.

Create the first Owner once with a hidden password prompt:

```sh
docker compose --profile tools run --rm admin-create
```

Run the full static and mocked-browser gate from the repository root:

```sh
scripts/phase-h-acceptance.sh
```

`PHASE_H_LIVE=1` turns the same command into the strict live H4 gate. It refuses
missing live inputs, skipped scenarios, or absent machine-readable verdicts.

## Product API

The browser uses server sessions and `/api/v1`: authentication, organizations,
members, invitations, overview, Nodes, projects, runs, SSE, and audit. Every
mutation requires an allowed Origin and session-bound CSRF token.

## Deprecated operator compatibility

The legacy `/v1` operator API is Phase G compatibility, not user authentication.
It is enabled only with `OPERATOR_COMPATIBILITY=true`, restricted to the
bootstrap organization, and disabled by default in production.

| Route | Purpose |
| --- | --- |
| `POST /v1/enrollment-tokens` | Issue a one-time enrollment token |
| `POST /v1/node/enroll` | Node presents its key (enrollment or rotation) |
| `POST /v1/nodes/:id/rotation-token` | Issue a rotation token bound to one Node |
| `GET /v1/nodes/:id/rotations` | Rotation history; keys only |
| `POST /v1/nodes/:id/revoke` | Revoke an identity and drop its session |
| `GET /v1/projects` | Projects reported by connected Nodes |
| `POST /v1/projects/:id/runs` | Create a run (supports `idempotency_key`) |
| `GET /v1/projects/:id/runs/:runId/events` | Journal, replayable by `since_seq` |
| `GET …/events/stream` | The same journal as SSE |
| `GET /v1/runs/stranded` | Active runs whose Node went silent |
| `POST /v1/runs/:runId/force-close` | Close one, with a recorded reason |
| `GET /v1/audit` | Audit log |

The plaintext of an enrollment or rotation token is returned exactly once, at
creation. Only a SHA-256 digest is stored.

## What is never stored

Operator bearer tokens, enrollment or rotation token values, Node private keys,
provider credentials, authorization headers, and host workspace paths. The Control
Plane addresses work by project id and has no column for a path.
