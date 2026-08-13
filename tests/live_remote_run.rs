//! Live acceptance: a real Hermes run initiated through the remote protocol.
//!
//! Ignored by default because it needs a running project container. Run it with
//! a reachable Hermes and its API key:
//!
//! ```bash
//! ASTERISM_HERMES_API_KEY=... ASTERISM_HERMES_URL=http://127.0.0.1:18642 \
//!   cargo test --test live_remote_run -- --ignored --nocapture
//! ```
//!
//! The peer is the **mock** Control Plane — a test harness, not a production
//! Control Plane. What is real here is the Node, the protocol, and Hermes.
//!
//! The default safe runtime is used throughout; the native Codex unsafe
//! override is never enabled.

mod support;

use std::time::Duration;

use asterism_node::control::{self, ChannelStatus, ConnectionState, ControlChannel};
use asterism_node::identity::NodeIdentity;
use asterism_node::nodehome::{DevelopmentConfig, NodeConfig};
use asterism_node::registry::Registry;
use asterism_node::service::{Limits, NodeService};
use serde_json::json;
use support::mock_control_plane::MockControlPlane;

const LIVE_TIMEOUT: Duration = Duration::from_secs(240);

#[tokio::test]
#[ignore = "requires a running Hermes project container"]
async fn a_remote_command_drives_a_real_hermes_run_end_to_end() {
    let api_key = std::env::var("ASTERISM_HERMES_API_KEY")
        .expect("ASTERISM_HERMES_API_KEY is required for the live test");
    let hermes_url = std::env::var("ASTERISM_HERMES_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:18642".to_owned());
    let workspace = std::env::var("ASTERISM_LIVE_WORKSPACE")
        .unwrap_or_else(|_| "fixtures/test-project".to_owned());

    let dir = tempfile::tempdir().unwrap();
    let node_home = dir.path().to_path_buf();
    std::fs::create_dir_all(node_home.join("node")).unwrap();

    let mock = MockControlPlane::start().await;
    mock.issue_token("live-token").await;

    let mut identity = NodeIdentity::load_or_create(&node_home).unwrap();
    control::enroll(
        &mut identity,
        &mock.base_url(),
        "live-token",
        "live-node",
        true,
    )
    .await
    .expect("enrollment against the mock");
    println!("enrolled as {:?}", identity.node_id());

    let service = NodeService::new(&node_home, &hermes_url, &api_key, Limits::default()).unwrap();

    // Only a registered project can be addressed remotely.
    {
        let mut registry = Registry::open(&node_home).unwrap();
        registry
            .register_project(
                "live",
                std::path::Path::new(&workspace),
                Some("Live project"),
                None,
                None,
            )
            .unwrap();
    }

    let status = ChannelStatus::new(ConnectionState::Connecting);
    let (shutdown, shutdown_rx) = tokio::sync::watch::channel(false);
    let channel = tokio::spawn(
        ControlChannel {
            service: service.clone(),
            node_home: node_home.clone(),
            config: NodeConfig {
                control_plane_url: Some(mock.base_url()),
                development: DevelopmentConfig {
                    allow_plaintext_loopback: true,
                },
                ..NodeConfig::default()
            },
            status: status.clone(),
        }
        .run(shutdown_rx),
    );

    mock.wait_connected(Duration::from_secs(20))
        .await
        .expect("the Node must connect to the mock");
    println!("control channel connected");

    // 1. The Control Plane asks the Node to start real work.
    mock.push_command(
        "live-run-1",
        "runs.create",
        Some("live"),
        json!({"input": "Reply with exactly: PHASE_F_REMOTE_OK. Do not use tools."}),
    )
    .await;

    let created = mock
        .wait_result("live-run-1", LIVE_TIMEOUT)
        .await
        .expect("a command result must come back");
    assert_eq!(created["state"], json!("completed"), "{created}");
    let run_id = created["result"]["run_id"]
        .as_str()
        .expect("a run id")
        .to_owned();
    println!("remote command created run {run_id}");

    // 2. Subscribe and receive the journal remotely.
    mock.push_command(
        "live-sub-1",
        "events.subscribe",
        Some("live"),
        json!({"run_id": run_id, "from_seq": 0}),
    )
    .await;
    mock.wait_result("live-sub-1", Duration::from_secs(30))
        .await
        .expect("the subscription must be acknowledged");

    // 3. Wait for the run to settle locally.
    let deadline = tokio::time::Instant::now() + LIVE_TIMEOUT;
    let final_run = loop {
        let record = service.get_run("live", &run_id).await.unwrap();
        let status = asterism_node::runstate::RunStatus::parse(&record.status).unwrap();
        if status.is_terminal() {
            break record;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the live run never reached a terminal state"
        );
        tokio::time::sleep(Duration::from_secs(2)).await;
    };

    println!(
        "run finished: status={} events={}",
        final_run.status, final_run.last_event_seq
    );
    assert_eq!(final_run.status, "completed", "{final_run:?}");
    let output = final_run
        .result_payload
        .as_ref()
        .and_then(|value| value.get("output"))
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    assert!(
        output.contains("PHASE_F_REMOTE_OK"),
        "unexpected model output: {output:?}"
    );

    // 4. The events reached the Control Plane over the protocol.
    let events = mock.wait_events(&run_id, 3, Duration::from_secs(60)).await;
    println!("mock received {} remote events", events.len());
    assert!(events.len() >= 3, "expected journal events to be delivered");

    let seqs: Vec<i64> = events
        .iter()
        .map(|event| event["seq"].as_i64().unwrap())
        .collect();
    assert!(
        seqs.windows(2).all(|pair| pair[1] > pair[0]),
        "events must arrive in per-run order: {seqs:?}"
    );
    assert!(
        events
            .iter()
            .all(|event| event["project_id"] == json!("live")),
        "every delivery names its project"
    );

    // 5. The cursor advanced durably.
    let registry = Registry::open(&node_home).unwrap();
    let subscription = registry.subscription(&run_id).unwrap().unwrap();
    println!("acknowledged cursor: {}", subscription.acked_seq);
    assert!(subscription.acked_seq >= 3);

    // 6. A redelivery of the same command must not run the task again.
    mock.push_command(
        "live-run-1",
        "runs.create",
        Some("live"),
        json!({"input": "Reply with exactly: PHASE_F_REMOTE_OK. Do not use tools."}),
    )
    .await;
    tokio::time::sleep(Duration::from_secs(5)).await;
    let runs = registry.list_runs("live", 50).unwrap();
    assert_eq!(
        runs.len(),
        1,
        "a redelivered command must not create a second run"
    );

    let _ = shutdown.send(true);
    channel.abort();
}
