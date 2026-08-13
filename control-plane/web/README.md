# Asterism Operations Console

React operations console for the tenant-scoped Control Plane product API.

```sh
npm install
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```

The development server proxies `/api` to `http://127.0.0.1:8080`. Authentication
uses only HttpOnly server sessions. No session credential is written to browser
storage; `sessionStorage` is used only for per-organization SSE cursors.

Production does not need a separate frontend service. The Control Plane
multi-stage image builds this package and serves `dist/` with SPA fallback while
preserving JSON 404 responses under `/api`, `/v1`, and `/health`.

Pages include login, invitation acceptance, organization selection, overview,
Nodes, projects and run creation, runs with replayable SSE and approvals,
members/invitations, and audit. Server-provided permissions control presentation;
all authorization is enforced again by the API.

## Live Phase H acceptance

The normal `npm run test:e2e` command runs the mocked console suite and skips the
explicitly provisioned live file. The repository-level gate runs all seven live
scenarios when `PHASE_H_LIVE=1` and requires these variables:

- `LIVE_BASE_URL`, `LIVE_OWNER_EMAIL`, and `LIVE_OWNER_PASSWORD`
- `LIVE_HERMES_CONTAINER`, naming an explicitly disposable restart target
- `LIVE_REPLAY_RUN_ID` and `LIVE_REPLAY_EXPECTED_TEXT`
- `LIVE_SESSION_STATE`, a readable Playwright storage-state file captured before
  the tested Control Plane restart
- `LIVE_NODE_VERDICTS_FILE`, containing `node_reconnected` and
  `node_identity_preserved` JSON verdict lines from the real Node restart check

The gate fails unless all seven browser tests pass and all eleven required
browser/Node verdicts are present. Live approval tests remove only fixtures they
create below `fixtures/test-project/.phase-h-acceptance`.
