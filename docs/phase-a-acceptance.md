# Phase A Acceptance Criteria

Phase A is an architecture proof. It is complete only when every required criterion below is observed on a real Linux Docker host with one pinned Hermes image digest.

## Required

- [ ] `cargo fmt --all --check` succeeds.
- [ ] `cargo clippy --all-targets -- -D warnings` succeeds.
- [ ] `cargo test` succeeds.
- [ ] `cargo build` succeeds.
- [ ] Hermes provider setup persists in the dedicated Hermes data directory.
- [ ] `project ensure` starts the official Hermes image.
- [ ] `/health` becomes healthy.
- [ ] Authenticated `/v1/capabilities` succeeds.
- [ ] `POST /v1/runs` accepts a bounded development task.
- [ ] SSE events are received while the run executes.
- [ ] The agent writes `PROOF_RESULT.txt` inside the project workspace.
- [ ] Run status reaches a documented terminal state.
- [ ] An approval request can be observed and resolved through the Runs API.
- [ ] Restarting Hermes/container preserves the project workspace.
- [ ] Restarting Hermes/container preserves Hermes state.
- [ ] A follow-up turn can correlate with the intended persisted Hermes session semantics.
- [ ] `/var/run/docker.sock` is absent inside the project container.
- [ ] No unrelated host directory is mounted into the project container.
- [ ] The Hermes runtime process is non-root after container initialization.
- [ ] The project container runs without `--privileged`.
- [ ] CPU, memory, and PID limits are visible in `docker inspect`.

## Record during the proof

- Exact Hermes image digest.
- Hermes version reported by the image.
- Exact `/v1/capabilities` response relevant to runs and approvals.
- Observed SSE event names and representative redacted shapes.
- Observed approval request and response JSON shapes.
- Session identifier behavior before and after restart.
- Effective runtime UID/GID and Linux capabilities.
- Any files written outside `/workspace` and `/opt/data`.
- Container restart behavior and time to health.

## Explicitly unresolved after Phase A

- Model-provider egress allowlisting.
- Cross-host Control Plane protocol.
- Offline Node event spooling.
- Fleet scheduling.
- Codex App Server compatibility.
- Stronger-than-OCI isolation requirements.

Phase B may begin only after the required Phase A checks pass or any failed criterion has an explicit architectural disposition.

