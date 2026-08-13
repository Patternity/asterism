# Phase H — Multi-Tenant Product Foundation and Minimal Operations Console

Phase H is complete and accepted as of 2026-08-13. Phase G's execution and
protocol boundaries remain unchanged: the browser talks only to the Control
Plane, the Control Plane sends durable commands over the outbound Node channel,
and the Rust Node owns project and Hermes lifecycle.

## Final gate matrix

| Gate | Status | Acceptance evidence |
| --- | --- | --- |
| H1 — identity, organizations, sessions, RBAC, tenant persistence | Accepted | Owner bootstrap, Argon2id authentication, digest-only sessions, CSRF/Origin enforcement, invitation flow, centralized RBAC, tenant-scoped persistence, and cross-tenant negative tests |
| H2 — tenant-scoped product API | Accepted | Versioned browser API, durable run commands, replayable SSE, approval/cancel/retry, ownership checks, audit pagination, and disabled-by-default operator compatibility |
| H3 — React operations console | Accepted | Complete operations workflow, organization-safe query caching, reconnecting event history, permission-aware controls, and safe event rendering |
| H4 — deployment, live E2E, restart recovery, security | Accepted | Production image and Compose validation, 7/7 real Chromium-to-Hermes scenarios, Node and Control Plane restart evidence, full suites, audits, and credential-value scan |

## Final verification

`scripts/phase-h-acceptance.sh` is the full local gate. Its default mode runs
all static, unit, integration, build, audit, and mocked-browser checks. Setting
`PHASE_H_LIVE=1` additionally requires an explicitly provisioned live stack,
all live evidence inputs, seven passing live browser scenarios, and all eleven
machine-readable browser and Node verdicts. Missing inputs, skipped scenarios,
or missing verdicts fail the command.

Final results:

- Rust formatting and clippy are clean. 289 tests pass; the one explicitly live
  Hermes test remains ignored by the normal suite. The production build passes.
- Control Plane formatting, ESLint, strict typecheck, and build pass. 91 tests
  pass and `npm audit` reports zero vulnerabilities.
- Console formatting, ESLint, strict typecheck, and build pass. Five unit tests
  and four mocked Chromium tests pass; `npm audit` reports zero vulnerabilities.
- The strict live gate passes all seven serial Chromium scenarios and all eleven
  required verdicts.
- The multi-stage production image builds as unprivileged user `node`; verified
  image ID:
  `sha256:25e72674aa10d3463588213ce25a8b36f00d96ea4f43dec39432440a55c5f243`.
- Compose interpolation/config validation and the running `/health` endpoint
  pass.

## Live vertical acceptance

The retained Phase A and Phase G Hermes containers ran through the normal
Hermes `gateway run` loop. Phase A used manual approvals. Phase G used smart
approvals and had no `model.openai_runtime` override, so Native Codex App-Server
and its approval bypass were not active.

The final live gate proved:

1. Owner login, organization selection, Node/project inventory, browser-created
   execution through the outbound channel, ordered output, reload, and replay.
2. A real manual approval denied after reload; the disposable command did not
   execute and duplicate resolution returned 409.
3. A real approval accepted after the original event-stream page closed; the
   command executed exactly once.
4. Simultaneous runs in two different projects.
5. Same-project single-flight, active cancellation, repeated idempotent cancel
   returning 202, and successful work after the flight was released.
6. Active-run retry rejection, a real interruption caused by restarting the
   disposable Hermes container, a completed linked replacement, both browser
   relationship directions, and completed-run retry rejection returning 409.
7. Control Plane restart against the same PostgreSQL database, preserved browser
   session, durable history, and gapless event replay.

A separate real Node restart preserved logical Node identity, Ed25519 public-key
fingerprint, project inventory, and history while changing only the process
instance. The Control Plane observed disconnect and a new authenticated session.

## Closure defects fixed

- Registry read-then-write transactions now use `BEGIN IMMEDIATE`, preventing
  `SQLITE_BUSY_SNAPSHOT` during concurrent worker, reconciliation, and control
  delivery writes. A concurrent WAL regression test covers the behavior.
- Control Plane WebSocket frames are serialized per Node session, preventing a
  replay burst from exhausting the PostgreSQL pool or reordering acknowledgments.
- An authenticated server `error` frame now terminates the Node session and
  enters bounded reconnect backoff instead of creating an error-frame loop.
- Real approval requests move central runs to `waiting_for_approval`; successful
  resolution returns them to `running`. Resolution replay uses the correct
  `remote_commands` table.
- Repeated cancellation reaches the Node idempotency path instead of failing at
  the product API.
- Failed run creation closes the central placeholder as failed.
- Retry navigation opens the replacement run. The product API exposes
  `replacement_run_id`, so both retry relationship directions use Control Plane
  IDs consistently.
- Live event sequences are normalized from PostgreSQL `BIGINT` strings before
  gap validation.
- The acceptance fixture setup is idempotent, and the H4 command now treats
  skipped live scenarios or absent machine verdicts as failures.

## Security closure

Both retained acceptance databases report zero invalid Argon2id hashes, zero
invalid session/CSRF, invitation, enrollment, or login digests, and zero
secret-key patterns in audit details and run-event payloads.

A value-based scan loaded eight actual test/provider credential values without
printing them. Matches were zero in both database dumps, compiled backend,
frontend bundles, project workspace, acceptance log, production image history,
and 76 runtime log/session artifacts. Provider credential matches were zero in
the Control Plane and Node process boundaries; Control Plane credential matches
were zero in Hermes container metadata. Browser localStorage and sessionStorage
contained zero credential values or credential-shaped entries.

## Preserved and cleaned resources

PostgreSQL databases `asterism_phase_h_acceptance` and
`asterism_phase_h_closure` remain in `asterism-cp-postgres` as durable acceptance
evidence. The Phase A and Phase G Hermes containers and their project state are
also preserved.

The temporary acceptance Control Plane and Node were stopped. Exact test-only
plaintext passwords/tokens, browser storage state, Node private identity,
temporary database dumps/logs/verdict file, and disposable approval fixtures
were deleted. These plaintext test artifacts are not recoverable; recreating the
closure stack requires a new Owner credential, enrollment token, and Node
identity. No project credential or retained database was deleted.

## Environment note

No `AGENTS.md` files or `docs/phase-g-status.md` were present. Git metadata is
unavailable in this environment because `.git/` is mounted empty, so no commit
or push was attempted and every pre-existing uncommitted file was preserved.

## Next phase

The recommended next phase is **Phase I: production runtime and credential
isolation**. It should split provider credentials from model-generated tool
execution, enforce measured egress policy, add TLS/reverse-proxy production
guidance, and turn the accepted single-host product into a safely operable
deployment without reopening Phase H architecture.
