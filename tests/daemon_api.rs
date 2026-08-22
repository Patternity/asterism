//! Integration tests for the local Unix-socket control API.
//!
//! These run a real [`NodeService`] behind a real Unix socket and drive it with
//! the real [`NodeClient`], so the HTTP framing, SSE replay, and error mapping
//! are exercised end to end rather than mocked.
//!
//! Hermes is deliberately pointed at a closed loopback port: run submission
//! fails immediately, which is exactly the durable-failure path the registry
//! must record, and it keeps the tests free of a live backend.

use std::path::Path;
use std::time::Duration;

use asterism_node::client::{ApiError, NodeClient, NodeUnavailable};
use asterism_node::inventory::RuntimeOwnership;
use asterism_node::registry::{JournalEvent, Registry, RunUpdate};
use asterism_node::runpolicy::RunApprovalPolicy;
use asterism_node::runstate::RunStatus;
use asterism_node::service::{Limits, NodeService};
use serde_json::{Value, json};
use tokio::net::UnixListener;

/// A closed loopback port: connections are refused immediately.
const UNREACHABLE_HERMES: &str = "http://127.0.0.1:1";

struct Harness {
    _dir: tempfile::TempDir,
    client: NodeClient,
    state_root: std::path::PathBuf,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn harness() -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let state_root = dir.path().to_path_buf();
    std::fs::create_dir_all(state_root.join("node")).unwrap();

    let limits = Limits {
        // Small enough to make bound checks fast and observable.
        max_request_bytes: 2048,
        heartbeat_seconds: 1,
        stream_page_size: 4,
        ..Limits::default()
    };
    let service = NodeService::new(
        &state_root,
        UNREACHABLE_HERMES,
        "0123456789abcdef0123456789abcdef",
        limits,
    )
    .unwrap();

    let socket = asterism_node::daemon::socket_path(&state_root);
    let listener = UnixListener::bind(&socket).unwrap();

    let server = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let service = service.clone();
            tokio::spawn(async move {
                let io = hyper_util::rt::TokioIo::new(stream);
                let handler = hyper::service::service_fn(move |request| {
                    let service = service.clone();
                    async move {
                        Ok::<_, std::convert::Infallible>(
                            asterism_node::api::handle(service, request).await,
                        )
                    }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(io, handler)
                    .await;
            });
        }
    });

    let client = NodeClient::new(&state_root);
    Harness {
        _dir: dir,
        client,
        state_root,
        server,
    }
}

async fn create_run(client: &NodeClient, project: &str, input: &str) -> Value {
    client
        .request(
            "POST",
            &format!("/v1/projects/{project}/runs"),
            Some(&json!({"input": input})),
        )
        .await
        .unwrap()
}

/// Wait until a run reaches a terminal state, or fail the test.
async fn await_terminal(client: &NodeClient, project: &str, run_id: &str) -> Value {
    for _ in 0..100 {
        let value = client
            .request(
                "GET",
                &format!("/v1/projects/{project}/runs/{run_id}"),
                None,
            )
            .await
            .unwrap();
        let status = value["run"]["status"].as_str().unwrap_or_default();
        if RunStatus::parse(status)
            .map(|s| s.is_terminal())
            .unwrap_or(false)
        {
            return value;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("run {run_id} never reached a terminal state");
}

fn api_error(error: &anyhow::Error) -> &ApiError {
    error
        .downcast_ref::<ApiError>()
        .unwrap_or_else(|| panic!("expected a typed API error, got: {error:#}"))
}

#[tokio::test]
async fn health_and_capabilities_describe_the_node() {
    let harness = harness().await;

    let health = harness
        .client
        .request("GET", "/v1/health", None)
        .await
        .unwrap();
    assert_eq!(health["status"], json!("ok"));
    assert!(health["instance_id"].as_str().unwrap().starts_with("node_"));

    let capabilities = harness
        .client
        .request("GET", "/v1/capabilities", None)
        .await
        .unwrap();
    assert_eq!(capabilities["api_version"], json!("v1"));
    assert_eq!(
        capabilities["registry_schema_version"],
        json!(asterism_node::registry::SCHEMA_VERSION)
    );
    assert_eq!(capabilities["transport"]["inbound_tcp"], json!(false));
    assert_eq!(capabilities["transport"]["kind"], json!("unix_socket_http"));
    assert_eq!(capabilities["approvals"]["supported"], json!(true));
    assert_eq!(capabilities["replay"]["cursor"], json!("seq"));
    assert_eq!(capabilities["retry"]["supported"], json!(true));
    assert_eq!(
        capabilities["concurrency"]["active_runs_per_project"],
        json!(1)
    );
    assert_eq!(capabilities["runtime_kinds"], json!(["hermes-loop"]));
}

#[tokio::test]
async fn a_run_is_created_supervised_and_recorded_durably() {
    let harness = harness().await;
    let created = create_run(&harness.client, "p1", "do the thing").await;
    let run_id = created["run"]["run_id"].as_str().unwrap().to_owned();

    assert_eq!(created["idempotent_replay"], json!(false));
    assert!(run_id.starts_with("arun_"));

    // The daemon supervises it; with Hermes unreachable it settles as failed
    // rather than hanging or vanishing.
    let final_state = await_terminal(&harness.client, "p1", &run_id).await;
    assert_eq!(final_state["run"]["status"], json!("failed"));
    assert_eq!(
        final_state["run"]["error_code"],
        json!("submission_failed"),
        "the durable record must explain why"
    );
}

#[tokio::test]
async fn listing_is_scoped_to_one_project() {
    let harness = harness().await;
    create_run(&harness.client, "p1", "one").await;
    create_run(&harness.client, "p2", "two").await;

    let listed = harness
        .client
        .request("GET", "/v1/projects/p1/runs", None)
        .await
        .unwrap();
    let runs = listed["runs"].as_array().unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["project_id"], json!("p1"));
}

#[tokio::test]
async fn a_run_cannot_be_read_through_another_project() {
    let harness = harness().await;
    let created = create_run(&harness.client, "p1", "one").await;
    let run_id = created["run"]["run_id"].as_str().unwrap();

    let error = harness
        .client
        .request("GET", &format!("/v1/projects/p2/runs/{run_id}"), None)
        .await
        .unwrap_err();

    let api = api_error(&error);
    assert_eq!(api.status, 404);
    assert_eq!(api.code, "run_not_found");
}

#[tokio::test]
async fn idempotency_replays_instead_of_submitting_twice() {
    let harness = harness().await;
    let body = json!({"input": "same", "idempotency_key": "k1"});

    let first = harness
        .client
        .request("POST", "/v1/projects/p1/runs", Some(&body))
        .await
        .unwrap();
    let second = harness
        .client
        .request("POST", "/v1/projects/p1/runs", Some(&body))
        .await
        .unwrap();

    assert_eq!(first["run"]["run_id"], second["run"]["run_id"]);
    assert_eq!(second["idempotent_replay"], json!(true));

    let listed = harness
        .client
        .request("GET", "/v1/projects/p1/runs", None)
        .await
        .unwrap();
    assert_eq!(listed["runs"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn reusing_a_key_with_a_different_request_is_a_conflict() {
    let harness = harness().await;
    harness
        .client
        .request(
            "POST",
            "/v1/projects/p1/runs",
            Some(&json!({"input": "one", "idempotency_key": "k1"})),
        )
        .await
        .unwrap();

    let error = harness
        .client
        .request(
            "POST",
            "/v1/projects/p1/runs",
            Some(&json!({"input": "different", "idempotency_key": "k1"})),
        )
        .await
        .unwrap_err();

    let api = api_error(&error);
    assert_eq!(api.status, 409);
    assert_eq!(api.code, "idempotency_conflict");
}

#[tokio::test]
async fn replay_resumes_strictly_after_the_cursor() {
    let harness = harness().await;
    let created = create_run(&harness.client, "p1", "one").await;
    let run_id = created["run"]["run_id"].as_str().unwrap().to_owned();
    await_terminal(&harness.client, "p1", &run_id).await;

    let all = harness
        .client
        .request(
            "GET",
            &format!("/v1/projects/p1/runs/{run_id}/events"),
            None,
        )
        .await
        .unwrap();
    let events = all["events"].as_array().unwrap();
    assert!(events.len() >= 2, "expected accepted + terminal events");

    let seqs: Vec<i64> = events.iter().map(|e| e["seq"].as_i64().unwrap()).collect();
    assert_eq!(seqs, (1..=seqs.len() as i64).collect::<Vec<_>>());

    let tail = harness
        .client
        .request(
            "GET",
            &format!("/v1/projects/p1/runs/{run_id}/events?since_seq=1"),
            None,
        )
        .await
        .unwrap();
    let tail_seqs: Vec<i64> = tail["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["seq"].as_i64().unwrap())
        .collect();
    assert_eq!(tail_seqs, seqs[1..].to_vec());
}

#[tokio::test]
async fn a_terminal_run_streams_completely_and_closes() {
    let harness = harness().await;
    let created = create_run(&harness.client, "p1", "one").await;
    let run_id = created["run"]["run_id"].as_str().unwrap().to_owned();
    let final_state = await_terminal(&harness.client, "p1", &run_id).await;
    let total = final_state["run"]["last_event_seq"].as_i64().unwrap();

    let mut seen = Vec::new();
    // A terminal run must close the stream on its own; a hang fails the test.
    tokio::time::timeout(
        Duration::from_secs(10),
        harness.client.stream(
            &format!("/v1/projects/p1/runs/{run_id}/events/stream"),
            None,
            |frame| {
                if let Some(seq) = frame.seq {
                    seen.push(seq);
                }
                Ok(true)
            },
        ),
    )
    .await
    .expect("stream must close for a terminal run")
    .unwrap();

    assert_eq!(seen, (1..=total).collect::<Vec<_>>());
}

#[tokio::test]
async fn streaming_resumes_from_last_event_id_without_a_gap() {
    let harness = harness().await;
    let created = create_run(&harness.client, "p1", "one").await;
    let run_id = created["run"]["run_id"].as_str().unwrap().to_owned();
    let final_state = await_terminal(&harness.client, "p1", &run_id).await;
    let total = final_state["run"]["last_event_seq"].as_i64().unwrap();

    let mut seen = Vec::new();
    tokio::time::timeout(
        Duration::from_secs(10),
        harness.client.stream(
            &format!("/v1/projects/p1/runs/{run_id}/events/stream"),
            Some(1),
            |frame| {
                if let Some(seq) = frame.seq {
                    seen.push(seq);
                }
                Ok(true)
            },
        ),
    )
    .await
    .expect("stream must close for a terminal run")
    .unwrap();

    // Strictly after the cursor: no replay of seq 1, no gap at seq 2.
    assert_eq!(seen, (2..=total).collect::<Vec<_>>());
}

#[tokio::test]
async fn events_appended_without_a_notification_are_still_delivered() {
    // Proves the contract that SQLite — not the in-memory bus — is the
    // authoritative event source: this test appends through a *separate*
    // registry connection, so the daemon's notification channel never fires.
    let harness = harness().await;
    let created = create_run(&harness.client, "p1", "one").await;
    let run_id = created["run"]["run_id"].as_str().unwrap().to_owned();
    await_terminal(&harness.client, "p1", &run_id).await;

    // Park the run back in a non-terminal state so the stream keeps following,
    // then append out-of-band.
    let out_of_band = {
        let state_root = harness.state_root.clone();
        let run_id = run_id.clone();
        tokio::task::spawn_blocking(move || {
            let mut registry = Registry::open(&state_root).unwrap();
            registry
                .append_event(
                    &run_id,
                    &JournalEvent::asterism("test.out_of_band", json!({"n": 1})),
                    None,
                )
                .unwrap();
            registry.run(&run_id).unwrap().unwrap().last_event_seq
        })
    }
    .await
    .unwrap();

    let events = harness
        .client
        .request(
            "GET",
            &format!(
                "/v1/projects/p1/runs/{run_id}/events?since_seq={}",
                out_of_band - 1
            ),
            None,
        )
        .await
        .unwrap();
    let last = events["events"].as_array().unwrap().last().unwrap();
    assert_eq!(last["event_type"], json!("test.out_of_band"));
    assert_eq!(last["seq"], json!(out_of_band));
}

#[tokio::test]
async fn cancellation_is_idempotent_on_a_terminal_run() {
    let harness = harness().await;
    let created = create_run(&harness.client, "p1", "one").await;
    let run_id = created["run"]["run_id"].as_str().unwrap().to_owned();
    await_terminal(&harness.client, "p1", &run_id).await;

    for _ in 0..2 {
        let response = harness
            .client
            .request(
                "POST",
                &format!("/v1/projects/p1/runs/{run_id}/cancel"),
                None,
            )
            .await
            .unwrap();
        assert_eq!(response["cancel_requested"], json!(false));
    }
}

#[tokio::test]
async fn retry_is_refused_for_a_run_that_genuinely_failed() {
    let harness = harness().await;
    let created = create_run(&harness.client, "p1", "one").await;
    let run_id = created["run"]["run_id"].as_str().unwrap().to_owned();
    await_terminal(&harness.client, "p1", &run_id).await;

    // The run failed with a real result, so retrying it is a new decision the
    // caller must express explicitly rather than a recovery.
    let error = harness
        .client
        .request(
            "POST",
            &format!("/v1/projects/p1/runs/{run_id}/retry"),
            None,
        )
        .await
        .unwrap_err();

    let api = api_error(&error);
    assert_eq!(api.status, 409);
    assert_eq!(api.code, "run_not_retryable");
}

#[tokio::test]
async fn retry_of_an_interrupted_run_creates_a_linked_replacement() {
    let harness = harness().await;
    let created = create_run(&harness.client, "p1", "original work").await;
    let run_id = created["run"]["run_id"].as_str().unwrap().to_owned();
    await_terminal(&harness.client, "p1", &run_id).await;

    // Force the terminal state that represents "continuity was lost".
    {
        let state_root = harness.state_root.clone();
        let target = run_id.clone();
        tokio::task::spawn_blocking(move || {
            let conn = rusqlite::Connection::open(Registry::path_for(&state_root)).unwrap();
            conn.execute(
                "UPDATE runs SET status = 'interrupted' WHERE run_id = ?1",
                [&target],
            )
            .unwrap();
        })
        .await
        .unwrap();
    }

    let replacement = harness
        .client
        .request(
            "POST",
            &format!("/v1/projects/p1/runs/{run_id}/retry"),
            None,
        )
        .await
        .unwrap();

    let new_id = replacement["run"]["run_id"].as_str().unwrap();
    assert_ne!(new_id, run_id);
    assert_eq!(replacement["run"]["retry_of_run_id"], json!(run_id));
    assert_eq!(
        replacement["run"]["request_payload"]["input"],
        json!("original work"),
        "the replacement must carry the same work"
    );

    // The original is preserved and gains a link event.
    let original = harness
        .client
        .request(
            "GET",
            &format!("/v1/projects/p1/runs/{run_id}/events"),
            None,
        )
        .await
        .unwrap();
    let has_link = original["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|event| event["event_type"] == json!("asterism.retry.created"));
    assert!(has_link, "the original run must record its replacement");
}

#[tokio::test]
async fn approval_resolution_requires_a_pending_request() {
    let harness = harness().await;
    let created = create_run(&harness.client, "p1", "one").await;
    let run_id = created["run"]["run_id"].as_str().unwrap().to_owned();
    await_terminal(&harness.client, "p1", &run_id).await;

    let error = harness
        .client
        .request(
            "POST",
            &format!("/v1/projects/p1/runs/{run_id}/approval"),
            Some(&json!({"choice": "deny"})),
        )
        .await
        .unwrap_err();

    let api = api_error(&error);
    assert_eq!(api.status, 409);
    assert_eq!(api.code, "no_pending_approval");
}

#[tokio::test]
async fn an_invalid_approval_choice_is_rejected() {
    let harness = harness().await;
    let created = create_run(&harness.client, "p1", "one").await;
    let run_id = created["run"]["run_id"].as_str().unwrap().to_owned();

    let error = harness
        .client
        .request(
            "POST",
            &format!("/v1/projects/p1/runs/{run_id}/approval"),
            Some(&json!({"choice": "definitely-not-a-choice"})),
        )
        .await
        .unwrap_err();

    assert_eq!(api_error(&error).status, 422);
}

#[tokio::test]
async fn malformed_and_oversized_requests_are_rejected_without_killing_the_daemon() {
    let harness = harness().await;

    // Malformed JSON.
    let raw = asterism_node::client::NodeClient::new(&harness.state_root);
    let malformed = raw
        .request(
            "POST",
            "/v1/projects/p1/runs",
            Some(&json!({"input": {"not": "a string"}})),
        )
        .await
        .unwrap_err();
    assert_eq!(api_error(&malformed).status, 400);

    // Oversized body: the harness limit is 2 KiB.
    let huge = "x".repeat(8192);
    let oversized = harness
        .client
        .request(
            "POST",
            "/v1/projects/p1/runs",
            Some(&json!({"input": huge})),
        )
        .await
        .unwrap_err();
    assert_eq!(api_error(&oversized).code, "request_too_large");

    // Unknown route.
    let unknown = harness
        .client
        .request("GET", "/v1/nope", None)
        .await
        .unwrap_err();
    assert_eq!(api_error(&unknown).status, 404);

    // The daemon is still healthy after all of that.
    let health = harness
        .client
        .request("GET", "/v1/health", None)
        .await
        .unwrap();
    assert_eq!(health["status"], json!("ok"));
}

#[tokio::test]
async fn identifiers_cannot_escape_their_namespace() {
    let harness = harness().await;

    for project in ["..", "..%2f..", "a.."] {
        let error = harness
            .client
            .request("GET", &format!("/v1/projects/{project}/runs"), None)
            .await
            .unwrap_err();
        let api = api_error(&error);
        assert!(
            api.status == 400 || api.status == 404,
            "{project:?} produced {}",
            api.status
        );
    }
}

#[tokio::test]
async fn an_invalid_cursor_is_rejected() {
    let harness = harness().await;
    let created = create_run(&harness.client, "p1", "one").await;
    let run_id = created["run"]["run_id"].as_str().unwrap();

    let error = harness
        .client
        .request(
            "GET",
            &format!("/v1/projects/p1/runs/{run_id}/events?since_seq=-5"),
            None,
        )
        .await
        .unwrap_err();

    let api = api_error(&error);
    assert_eq!(api.status, 400);
    assert_eq!(api.code, "invalid_cursor");
}

#[tokio::test]
async fn project_activity_reports_idleness_after_runs_settle() {
    let harness = harness().await;
    let created = create_run(&harness.client, "p1", "one").await;
    let run_id = created["run"]["run_id"].as_str().unwrap().to_owned();
    await_terminal(&harness.client, "p1", &run_id).await;

    let activity = harness
        .client
        .request("GET", "/v1/projects/p1/activity", None)
        .await
        .unwrap();
    assert_eq!(activity["active_run_id"], Value::Null);
}

#[tokio::test]
async fn a_missing_daemon_produces_a_typed_unavailable_error() {
    let dir = tempfile::tempdir().unwrap();
    let client = NodeClient::new(dir.path());

    let error = client.request("GET", "/v1/health", None).await.unwrap_err();

    let unavailable = error
        .downcast_ref::<NodeUnavailable>()
        .expect("an absent daemon must be typed, not generic");
    assert!(unavailable.to_string().contains("node serve"));
}

#[tokio::test]
async fn the_socket_lives_outside_any_project_mount() {
    // The registry and the socket must both sit under node/, which no project
    // container binds. Their placement is what keeps a project agent away from
    // Node state.
    let socket = asterism_node::daemon::socket_path("/srv/state");
    let registry = Registry::path_for("/srv/state");

    assert_eq!(socket.parent(), registry.parent());
    assert_eq!(socket.parent().unwrap(), Path::new("/srv/state/node"));
}

#[tokio::test]
async fn transitions_that_would_corrupt_a_terminal_run_are_refused() {
    let harness = harness().await;
    let created = create_run(&harness.client, "p1", "one").await;
    let run_id = created["run"]["run_id"].as_str().unwrap().to_owned();
    await_terminal(&harness.client, "p1", &run_id).await;

    let state_root = harness.state_root.clone();
    let result = tokio::task::spawn_blocking(move || {
        let mut registry = Registry::open(&state_root).unwrap();
        registry.update_run(&run_id, &RunUpdate::status(RunStatus::Running))
    })
    .await
    .unwrap();

    assert!(result.is_err(), "a terminal run must not be reopened");
}

/// A stub Hermes that records the paths it was asked for.
///
/// It exists to prove *where* the daemon sent a run, which a closed port cannot
/// show. It answers `/v1/runs` with a plausible acceptance and nothing else.
struct StubHermes {
    base_url: String,
    seen: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    bodies: std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for StubHermes {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl StubHermes {
    /// Wait for the daemon's submission to arrive.
    ///
    /// Run submission is asynchronous: the API accepts the run and a worker
    /// dials Hermes afterwards, so asserting immediately would race the worker
    /// rather than test it.
    async fn await_paths(&self) -> Vec<String> {
        for _ in 0..200 {
            let seen = self.seen.lock().unwrap().clone();
            if !seen.is_empty() {
                return seen;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Vec::new()
    }
}

async fn stub_hermes() -> StubHermes {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));

    let bodies = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorder = seen.clone();
    let body_recorder = bodies.clone();
    let server = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let recorder = recorder.clone();
            let body_recorder = body_recorder.clone();
            tokio::spawn(async move {
                let io = hyper_util::rt::TokioIo::new(stream);
                let handler = hyper::service::service_fn(
                    move |request: hyper::Request<hyper::body::Incoming>| {
                        let recorder = recorder.clone();
                        let body_recorder = body_recorder.clone();
                        async move {
                            let path = request.uri().path().to_owned();
                            recorder.lock().unwrap().push(path.clone());
                            if let Ok(collected) =
                                <hyper::body::Incoming as http_body_util::BodyExt>::collect(
                                    request.into_body(),
                                )
                                .await
                                && let Ok(value) =
                                    serde_json::from_slice::<Value>(&collected.to_bytes())
                            {
                                body_recorder.lock().unwrap().push(value);
                            }
                            // Enough of the Hermes run API to carry a run to a
                            // terminal state: submission, status, and an event
                            // stream that closes after completing.
                            let (content_type, body) = if path.ends_with("/events") {
                                (
                                "text/event-stream",
                                concat!(
                                    "event: run.completed\n",
                                    "data: {\"event\":\"run.completed\",\"output\":\"stub answer\"}\n\n",
                                )
                                .as_bytes()
                                .to_vec(),
                            )
                            } else if path.starts_with("/v1/runs/") {
                                (
                                "application/json",
                                br#"{"run_id":"stub-run","status":"completed","output":"stub answer"}"#
                                    .to_vec(),
                            )
                            } else {
                                (
                                    "application/json",
                                    br#"{"run_id":"stub-run","status":"started"}"#.to_vec(),
                                )
                            };
                            Ok::<_, std::convert::Infallible>(
                                hyper::Response::builder()
                                    .header("content-type", content_type)
                                    .body(http_body_util::Full::new(hyper::body::Bytes::from(body)))
                                    .unwrap(),
                            )
                        }
                    },
                );
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(io, handler)
                    .await;
            });
        }
    });

    StubHermes {
        base_url,
        seen,
        bodies,
        server,
    }
}

/// The daemon must reach an externally managed runtime.
///
/// Nothing on the daemon path constructs a container runtime, so an external
/// project is not a special case for it — it is simply a project whose endpoint
/// someone else is responsible for. This test is the evidence: the run reaches a
/// runtime the Node never created.
#[tokio::test]
async fn the_daemon_routes_a_run_to_an_externally_managed_runtime() {
    let harness = harness().await;
    let hermes = stub_hermes().await;

    let state_root = harness.state_root.clone();
    let endpoint = hermes.base_url.clone();
    tokio::task::spawn_blocking(move || {
        let workspace = state_root.join("workspaces/external");
        std::fs::create_dir_all(&workspace).unwrap();
        let mut registry = Registry::open(&state_root).unwrap();
        registry
            .register_project(
                "external",
                &workspace,
                Some("Host-native"),
                None,
                Some(endpoint.as_str()),
                RuntimeOwnership::External,
            )
            .unwrap();
    })
    .await
    .unwrap();

    create_run(&harness.client, "external", "hello").await;

    let seen = hermes.await_paths().await;
    assert!(
        seen.iter().any(|path| path == "/v1/runs"),
        "the daemon must submit to the project's own endpoint, saw {seen:?}",
    );
}

/// Ownership decides who supervises a runtime, not who may talk to one.
///
/// Two projects, two endpoints, two different owners: each run must land on its
/// own runtime. Resolving a Node-wide endpoint instead would silently send one
/// project's work to another project's agent.
#[tokio::test]
async fn each_project_reaches_its_own_runtime_regardless_of_ownership() {
    let harness = harness().await;
    let external = stub_hermes().await;
    let managed = stub_hermes().await;

    let state_root = harness.state_root.clone();
    let external_url = external.base_url.clone();
    let managed_url = managed.base_url.clone();
    tokio::task::spawn_blocking(move || {
        let host_workspace = state_root.join("workspaces/host");
        let boxed_workspace = state_root.join("workspaces/boxed");
        std::fs::create_dir_all(&host_workspace).unwrap();
        std::fs::create_dir_all(&boxed_workspace).unwrap();
        let mut registry = Registry::open(&state_root).unwrap();
        registry
            .register_project(
                "host",
                &host_workspace,
                None,
                None,
                Some(external_url.as_str()),
                RuntimeOwnership::External,
            )
            .unwrap();
        registry
            .register_project(
                "boxed",
                &boxed_workspace,
                None,
                None,
                Some(managed_url.as_str()),
                RuntimeOwnership::ManagedContainer,
            )
            .unwrap();
    })
    .await
    .unwrap();

    create_run(&harness.client, "host", "one").await;
    create_run(&harness.client, "boxed", "two").await;

    assert_eq!(
        external.await_paths().await,
        vec!["/v1/runs".to_owned()],
        "the external project's run must reach only its own runtime",
    );
    assert_eq!(
        managed.await_paths().await,
        vec!["/v1/runs".to_owned()],
        "the managed project's run must reach only its own runtime",
    );
}

/// The container runtime must stay out of the daemon's reach.
///
/// The two tests above show the daemon *serving* an external project; this one
/// shows why that is structural rather than lucky. `DockerRuntime` lives in one
/// module and is wired up only by the CLI, so no daemon code path can construct
/// one — for an external project or any other. If someone reaches for Docker
/// from the service, this fails before the behaviour regresses.
#[test]
fn no_library_module_outside_docker_rs_reaches_for_the_container_runtime() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut offenders = Vec::new();

    for entry in std::fs::read_dir(&src).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        // `docker.rs` defines it; `main.rs` is the CLI, not the daemon.
        if name == "docker.rs" || name == "main.rs" || path.extension().is_none_or(|e| e != "rs") {
            continue;
        }
        if std::fs::read_to_string(&path)
            .unwrap()
            .contains("DockerRuntime")
        {
            offenders.push(name);
        }
    }

    assert!(
        offenders.is_empty(),
        "the daemon must stay runtime-agnostic, but {offenders:?} reference DockerRuntime",
    );
}

/// A second turn must carry the first one.
///
/// Hermes builds a run's transcript from `conversation_history` and never loads
/// persisted history for a session id, so this request body is the entire
/// memory a continued conversation has. The stub answers every run identically;
/// what is asserted is what the Node *sent*.
#[tokio::test]
async fn a_continued_turn_sends_the_previous_turn_as_history() {
    let harness = harness().await;
    let hermes = stub_hermes().await;

    let state_root = harness.state_root.clone();
    let endpoint = hermes.base_url.clone();
    tokio::task::spawn_blocking(move || {
        let workspace = state_root.join("workspaces/chat");
        std::fs::create_dir_all(&workspace).unwrap();
        let mut registry = Registry::open(&state_root).unwrap();
        registry
            .register_project(
                "chat",
                &workspace,
                None,
                None,
                Some(endpoint.as_str()),
                RuntimeOwnership::External,
            )
            .unwrap();
    })
    .await
    .unwrap();

    let session = "conversation-1";
    let first = harness
        .client
        .request(
            "POST",
            "/v1/projects/chat/runs",
            Some(&json!({"input": "first question", "session_id": session})),
        )
        .await
        .unwrap();
    let first_id = first["run"]["run_id"].as_str().unwrap().to_owned();
    await_terminal(&harness.client, "chat", &first_id).await;

    harness
        .client
        .request(
            "POST",
            "/v1/projects/chat/runs",
            Some(&json!({"input": "second question", "session_id": session})),
        )
        .await
        .unwrap();
    hermes.await_paths().await;
    // Give the second submission time to land after the first completed.
    for _ in 0..100 {
        if hermes.bodies.lock().unwrap().len() >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let bodies = hermes.bodies.lock().unwrap().clone();
    assert!(
        bodies.len() >= 2,
        "expected two submissions, saw {}",
        bodies.len()
    );

    // A first turn has nothing to replay, and must not send an empty field.
    assert!(
        bodies[0].get("conversation_history").is_none(),
        "the opening turn must not carry a history key",
    );

    let history = bodies[1]
        .get("conversation_history")
        .and_then(Value::as_array)
        .expect("the continued turn must carry conversation history");
    let roles: Vec<&str> = history
        .iter()
        .map(|m| m["role"].as_str().unwrap_or_default())
        .collect();
    assert_eq!(roles, vec!["user", "assistant"]);
    assert_eq!(history[0]["content"], "first question");
    assert_eq!(
        bodies[1]["input"], "second question",
        "the current input stays outside the history",
    );
}

/// History is scoped to one conversation.
///
/// Two sessions on the same project must not see each other: replaying the
/// wrong transcript is worse than replaying none, because the model treats it
/// as something the operator actually said.
#[tokio::test]
async fn history_never_crosses_between_sessions() {
    let harness = harness().await;
    let hermes = stub_hermes().await;

    let state_root = harness.state_root.clone();
    let endpoint = hermes.base_url.clone();
    tokio::task::spawn_blocking(move || {
        let workspace = state_root.join("workspaces/chat");
        std::fs::create_dir_all(&workspace).unwrap();
        let mut registry = Registry::open(&state_root).unwrap();
        registry
            .register_project(
                "chat",
                &workspace,
                None,
                None,
                Some(endpoint.as_str()),
                RuntimeOwnership::External,
            )
            .unwrap();
    })
    .await
    .unwrap();

    let first = harness
        .client
        .request(
            "POST",
            "/v1/projects/chat/runs",
            Some(&json!({"input": "session one secret", "session_id": "session-one"})),
        )
        .await
        .unwrap();
    let first_id = first["run"]["run_id"].as_str().unwrap().to_owned();
    await_terminal(&harness.client, "chat", &first_id).await;

    harness
        .client
        .request(
            "POST",
            "/v1/projects/chat/runs",
            Some(&json!({"input": "unrelated question", "session_id": "session-two"})),
        )
        .await
        .unwrap();
    for _ in 0..100 {
        if hermes.bodies.lock().unwrap().len() >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let bodies = hermes.bodies.lock().unwrap().clone();
    assert!(bodies.len() >= 2);
    assert!(
        bodies[1].get("conversation_history").is_none(),
        "a different session must start with no history",
    );
}

/// A trusted run answers its own approvals; a neighbour still prompts.
///
/// The policy lives on the run row, so this is the property that matters most:
/// enabling it for one run must not quietly trust the next one.
#[tokio::test]
async fn the_run_policy_never_leaks_to_another_run() {
    let harness = harness().await;

    let state_root = harness.state_root.clone();
    let (trusted, neighbour) = tokio::task::spawn_blocking(move || {
        let mut registry = Registry::open(&state_root).unwrap();
        let trusted = registry
            .create_run(&asterism_node::registry::NewRun {
                project_id: "p1".into(),
                session_id: Some("shared-session".into()),
                idempotency_key: None,
                runtime_kind: "hermes-loop".into(),
                provider: None,
                model: None,
                request_payload: json!({"input": "first"}),
                retry_of_run_id: None,
            })
            .unwrap()
            .record()
            .clone();
        let neighbour = registry
            .create_run(&asterism_node::registry::NewRun {
                project_id: "p1".into(),
                session_id: Some("shared-session".into()),
                idempotency_key: None,
                runtime_kind: "hermes-loop".into(),
                provider: None,
                model: None,
                request_payload: json!({"input": "second"}),
                retry_of_run_id: None,
            })
            .unwrap()
            .record()
            .clone();
        registry
            .set_run_approval_policy(
                &trusted.run_id,
                RunApprovalPolicy::AllowAllForRun,
                Some("op"),
            )
            .unwrap();
        (trusted.run_id, neighbour.run_id)
    })
    .await
    .unwrap();

    let state_root = harness.state_root.clone();
    tokio::task::spawn_blocking(move || {
        let registry = Registry::open(&state_root).unwrap();
        assert_eq!(
            registry.run_approval_policy(&trusted).unwrap().policy,
            RunApprovalPolicy::AllowAllForRun,
        );
        assert_eq!(
            registry.run_approval_policy(&neighbour).unwrap().policy,
            RunApprovalPolicy::Manual,
            "a second run in the same session must still ask",
        );
    })
    .await
    .unwrap();
}

/// The Node advertises the policy so a Control Plane can hide the control
/// against an older Node that would silently ignore it.
#[tokio::test]
async fn the_capability_advertises_both_policies_and_no_persistent_choice() {
    let harness = harness().await;
    let status = harness
        .client
        .request("GET", "/v1/capabilities", None)
        .await
        .unwrap();
    // The endpoint may nest capabilities or return them at the top level.
    let approvals = if status["capabilities"]["approvals"].is_object() {
        &status["capabilities"]["approvals"]
    } else {
        &status["approvals"]
    };

    let policies: Vec<&str> = approvals["run_approval_policy"]
        .as_array()
        .expect("run_approval_policy must be advertised")
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();
    assert_eq!(policies, vec!["manual", "allow_all_for_run"]);

    let choices: Vec<&str> = approvals["choices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();
    assert!(
        !choices.contains(&"always"),
        "the persistent Hermes grant must stay unavailable",
    );
}

/// A run created with the policy starts trusted, without a prompting window.
#[tokio::test]
async fn a_run_can_be_created_already_trusted() {
    let harness = harness().await;
    let created = harness
        .client
        .request(
            "POST",
            "/v1/projects/p1/runs",
            Some(&json!({
                "input": "do the thing",
                "approval_policy": "allow_all_for_run",
                "actor": "operator-1"
            })),
        )
        .await
        .unwrap();
    let run_id = created["run"]["run_id"].as_str().unwrap().to_owned();

    let state_root = harness.state_root.clone();
    tokio::task::spawn_blocking(move || {
        let registry = Registry::open(&state_root).unwrap();
        let state = registry.run_approval_policy(&run_id).unwrap();
        assert_eq!(state.policy, RunApprovalPolicy::AllowAllForRun);
        assert_eq!(state.enabled_by.as_deref(), Some("operator-1"));
    })
    .await
    .unwrap();
}

/// An unrecognised policy is refused rather than defaulting either way.
#[tokio::test]
async fn an_unknown_policy_is_refused_at_run_creation() {
    let harness = harness().await;
    let error = harness
        .client
        .request(
            "POST",
            "/v1/projects/p1/runs",
            Some(&json!({"input": "x", "approval_policy": "always"})),
        )
        .await
        .unwrap_err();
    let message = error.to_string();
    assert!(
        message.contains("invalid_approval_policy") || message.contains("unknown run approval"),
        "got {message}",
    );
}

/// Omitting the field keeps every existing client on the old behaviour.
#[tokio::test]
async fn a_run_created_without_a_policy_is_manual() {
    let harness = harness().await;
    let created = create_run(&harness.client, "p1", "no policy given").await;
    let run_id = created["run"]["run_id"].as_str().unwrap().to_owned();

    let state_root = harness.state_root.clone();
    tokio::task::spawn_blocking(move || {
        let registry = Registry::open(&state_root).unwrap();
        assert_eq!(
            registry.run_approval_policy(&run_id).unwrap().policy,
            RunApprovalPolicy::Manual,
        );
    })
    .await
    .unwrap();
}

/// An attached image must reach Hermes as a structured content part.
///
/// The stub records request bodies, so this asserts what the Node actually
/// sent — the one thing a unit test of the builder cannot show.
#[tokio::test]
async fn an_attached_image_travels_as_a_structured_content_part() {
    let harness = harness().await;
    let hermes = stub_hermes().await;

    let state_root = harness.state_root.clone();
    let endpoint = hermes.base_url.clone();
    tokio::task::spawn_blocking(move || {
        let workspace = state_root.join("workspaces/chat");
        std::fs::create_dir_all(&workspace).unwrap();
        let mut registry = Registry::open(&state_root).unwrap();
        registry
            .register_project(
                "chat",
                &workspace,
                None,
                None,
                Some(endpoint.as_str()),
                RuntimeOwnership::External,
            )
            .unwrap();
    })
    .await
    .unwrap();

    harness
        .client
        .request(
            "POST",
            "/v1/projects/chat/runs",
            Some(&json!({
                "input": "what does this show",
                "attachments": [
                    {"type": "image_url", "url": "https://example.com/a.png", "alt": "chart"}
                ],
            })),
        )
        .await
        .unwrap();
    hermes.await_paths().await;
    for _ in 0..100 {
        if !hermes.bodies.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let bodies = hermes.bodies.lock().unwrap().clone();
    let input = &bodies[0]["input"];
    let parts = input[0]["content"]
        .as_array()
        .expect("an attached turn must send content parts, not a plain string");
    assert_eq!(parts[0]["type"], "text");
    assert_eq!(parts[0]["text"], "what does this show");
    assert_eq!(parts[1]["type"], "image_url");
    assert_eq!(parts[1]["image_url"]["url"], "https://example.com/a.png");
}

/// A turn with no attachment must be byte-identical to what it was before.
#[tokio::test]
async fn a_turn_without_attachments_still_sends_a_plain_string() {
    let harness = harness().await;
    let hermes = stub_hermes().await;

    let state_root = harness.state_root.clone();
    let endpoint = hermes.base_url.clone();
    tokio::task::spawn_blocking(move || {
        let workspace = state_root.join("workspaces/chat");
        std::fs::create_dir_all(&workspace).unwrap();
        let mut registry = Registry::open(&state_root).unwrap();
        registry
            .register_project(
                "chat",
                &workspace,
                None,
                None,
                Some(endpoint.as_str()),
                RuntimeOwnership::External,
            )
            .unwrap();
    })
    .await
    .unwrap();

    create_run(&harness.client, "chat", "plain question").await;
    hermes.await_paths().await;
    for _ in 0..100 {
        if !hermes.bodies.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let bodies = hermes.bodies.lock().unwrap().clone();
    assert_eq!(bodies[0]["input"], "plain question");
}

/// An invalid attachment fails the request instead of becoming a text-only run.
#[tokio::test]
async fn an_invalid_attachment_is_refused_not_silently_dropped() {
    let harness = harness().await;
    for bad in [
        json!([{"type": "image_url", "url": "ftp://example.com/a.png"}]),
        json!([{"type": "image_url", "url": "https://user:token@example.com/a.png"}]),
        json!([{"type": "file_url", "url": "https://example.com/a.pdf"}]),
    ] {
        let error = harness
            .client
            .request(
                "POST",
                "/v1/projects/p1/runs",
                Some(&json!({"input": "look", "attachments": bad})),
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("invalid_attachment") || error.contains("attachment"),
            "got {error}",
        );
    }
}

/// The Node advertises the attachment types it can carry.
#[tokio::test]
async fn the_capability_advertises_image_url_attachments() {
    let harness = harness().await;
    let status = harness
        .client
        .request("GET", "/v1/capabilities", None)
        .await
        .unwrap();
    let attachments = if status["capabilities"]["attachments"].is_object() {
        &status["capabilities"]["attachments"]
    } else {
        &status["attachments"]
    };
    let types: Vec<&str> = attachments["run_attachments"]
        .as_array()
        .expect("run_attachments must be advertised")
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();
    assert_eq!(types, vec!["image_url"]);
    assert_eq!(attachments["max_per_message"], 4);
}
