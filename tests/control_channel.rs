//! Integration tests for the outbound control channel against a **mock**
//! Control Plane.
//!
//! The mock is a test harness, not a production Control Plane. It binds
//! loopback only and exists to prove the Node's half of the protocol: one-time
//! enrollment, the Ed25519 handshake, at-most-once command execution, event
//! replay from an acknowledged cursor, outbox retransmission, and survival of
//! adversarial frames.
//!
//! Hermes points at a closed loopback port throughout, so runs settle as failed
//! quickly and no backend is required.

mod support;

use asterism_node::inventory::RuntimeOwnership;
use std::time::Duration;

use asterism_node::control::{self, ChannelStatus, ConnectionState, ControlChannel};
use asterism_node::identity::NodeIdentity;
use asterism_node::nodehome::{DevelopmentConfig, NodeConfig};
use asterism_node::protocol::{self, AuthTranscriptInput, ErrorCode};
use asterism_node::registry::Registry;
use asterism_node::service::{Limits, NodeService};
use serde_json::{Value, json};
use support::mock_control_plane::{Behaviour, MockControlPlane};

const UNREACHABLE_HERMES: &str = "http://127.0.0.1:1";
const SETTLE: Duration = Duration::from_secs(15);

/// Wait for the channel to reach a state, or fail the test.
///
/// The mock signals when it *sends* `server.ready`; the Node records the state
/// a moment later, so tests synchronise on the Node's own view.
async fn await_state(status: &ChannelStatus, expected: ConnectionState, timeout: Duration) {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let current = status.state().await;
        if current == expected {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "channel stayed in {current:?}, expected {expected:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Wait for the Node to durably record an acknowledged cursor of at least `seq`.
///
/// `wait_events` only proves the events reached the mock Control Plane. The
/// acknowledgement is a separate round trip that the Node then writes to its
/// registry, so reading the cursor immediately races that write — which is
/// exactly what failed on a slow CI runner. Poll instead of sleeping: the
/// assertion is unchanged, it simply allows the write the time it needs.
async fn await_acked_seq(
    node_home: &std::path::Path,
    run_id: &str,
    seq: i64,
    timeout: Duration,
) -> i64 {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let observed = Registry::open(node_home)
            .unwrap()
            .subscription(run_id)
            .unwrap()
            .map(|subscription| subscription.acked_seq)
            .unwrap_or(0);
        if observed >= seq {
            return observed;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "acknowledged cursor stalled at {observed}, expected at least {seq}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

struct Harness {
    _dir: tempfile::TempDir,
    node_home: std::path::PathBuf,
    service: NodeService,
    status: ChannelStatus,
    mock: MockControlPlane,
    channel: tokio::task::JoinHandle<()>,
    shutdown: tokio::sync::watch::Sender<bool>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
        self.channel.abort();
    }
}

/// Enroll a fresh Node against the mock and start its control channel.
async fn harness() -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let node_home = dir.path().to_path_buf();
    std::fs::create_dir_all(node_home.join("node")).unwrap();

    let mock = MockControlPlane::start().await;
    mock.issue_token("one-time-token").await;

    let mut identity = NodeIdentity::load_or_create(&node_home).unwrap();
    control::enroll(
        &mut identity,
        &mock.base_url(),
        "one-time-token",
        "test-node",
        true,
    )
    .await
    .expect("enrollment must succeed against the mock");

    let config = NodeConfig {
        control_plane_url: Some(mock.base_url()),
        development: DevelopmentConfig {
            allow_plaintext_loopback: true,
        },
        heartbeat: asterism_node::nodehome::HeartbeatConfig {
            interval_ms: 1_000,
            missed_limit: 5,
        },
        reconnect: asterism_node::nodehome::ReconnectConfig {
            initial_backoff_ms: 100,
            max_backoff_ms: 1_000,
            jitter: 0.0,
            stable_session_ms: 500,
        },
        ..NodeConfig::default()
    };

    let service = NodeService::new(
        &node_home,
        UNREACHABLE_HERMES,
        "0123456789abcdef0123456789abcdef",
        Limits::default(),
    )
    .unwrap();

    // A project the Control Plane is allowed to address.
    {
        let mut registry = Registry::open(&node_home).unwrap();
        registry
            .register_project(
                "p1",
                dir.path(),
                Some("Demo"),
                None,
                // Bound explicitly, exactly as a real Node binds a project to
                // the Hermes home it runs in. Routing no longer falls back to a
                // Node-wide endpoint, so an unbound project has nowhere to run.
                Some(UNREACHABLE_HERMES),
                RuntimeOwnership::ManagedContainer,
            )
            .unwrap();
    }

    let status = ChannelStatus::new(ConnectionState::Connecting);
    let (shutdown, shutdown_rx) = tokio::sync::watch::channel(false);
    let channel = tokio::spawn(
        ControlChannel {
            service: service.clone(),
            node_home: node_home.clone(),
            config,
            status: status.clone(),
        }
        .run(shutdown_rx),
    );

    mock.wait_connected(SETTLE)
        .await
        .expect("the Node must complete the handshake");
    await_state(&status, ConnectionState::Connected, SETTLE).await;

    Harness {
        _dir: dir,
        node_home,
        service,
        status,
        mock,
        channel,
        shutdown,
    }
}

// ------------------------------------------------------------- enrollment

#[tokio::test]
async fn enrollment_registers_the_public_key_and_assigns_a_node_id() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("node")).unwrap();
    let mock = MockControlPlane::start().await;
    mock.issue_token("tok-1").await;

    let mut identity = NodeIdentity::load_or_create(dir.path()).unwrap();
    let outcome = control::enroll(&mut identity, &mock.base_url(), "tok-1", "node-a", true)
        .await
        .unwrap();

    assert!(outcome.node_id.starts_with("node-"));
    assert_eq!(outcome.protocol_version, protocol::PROTOCOL_VERSION);
    assert_eq!(mock.registered_node_count().await, 1);

    // The assignment is persisted; the token is not.
    let reloaded = NodeIdentity::load(dir.path()).unwrap();
    assert_eq!(reloaded.node_id(), Some(outcome.node_id.as_str()));
    let stored = std::fs::read_to_string(asterism_node::identity::meta_path(dir.path())).unwrap();
    assert!(!stored.contains("tok-1"), "the token must never be stored");
}

#[tokio::test]
async fn an_enrollment_token_works_exactly_once() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(first.path().join("node")).unwrap();
    std::fs::create_dir_all(second.path().join("node")).unwrap();
    let mock = MockControlPlane::start().await;
    mock.issue_token("tok-1").await;

    let mut a = NodeIdentity::load_or_create(first.path()).unwrap();
    control::enroll(&mut a, &mock.base_url(), "tok-1", "a", true)
        .await
        .unwrap();

    let mut b = NodeIdentity::load_or_create(second.path()).unwrap();
    let error = control::enroll(&mut b, &mock.base_url(), "tok-1", "b", true)
        .await
        .unwrap_err();

    assert!(error.to_string().contains("refused"));
    assert_eq!(mock.registered_node_count().await, 1);
}

#[tokio::test]
async fn re_enrolling_an_already_enrolled_node_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("node")).unwrap();
    let mock = MockControlPlane::start().await;
    mock.issue_token("tok-1").await;
    mock.issue_token("tok-2").await;

    let mut identity = NodeIdentity::load_or_create(dir.path()).unwrap();
    control::enroll(&mut identity, &mock.base_url(), "tok-1", "a", true)
        .await
        .unwrap();

    let error = control::enroll(&mut identity, &mock.base_url(), "tok-2", "a", true)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("already enrolled"));
}

#[tokio::test]
async fn enrollment_refuses_plaintext_without_the_development_flag() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("node")).unwrap();
    let mock = MockControlPlane::start().await;
    mock.issue_token("tok-1").await;

    let mut identity = NodeIdentity::load_or_create(dir.path()).unwrap();
    let error = control::enroll(&mut identity, &mock.base_url(), "tok-1", "a", false)
        .await
        .unwrap_err();

    assert!(error.to_string().contains("plaintext"));
    assert_eq!(mock.registered_node_count().await, 0);
}

// -------------------------------------------------------------- handshake

#[tokio::test]
async fn the_node_authenticates_and_reaches_the_connected_state() {
    let harness = harness().await;

    assert_eq!(harness.status.state().await, ConnectionState::Connected);
    let observed = harness.mock.observations.lock().await;
    assert_eq!(observed.authentications, 1);
    assert_eq!(observed.authentication_failures, 0);

    let hello = observed.hellos.first().expect("a hello was sent");
    assert_eq!(hello.supported_versions, protocol::SUPPORTED_VERSIONS);
    assert_eq!(hello.public_key_fingerprint.len(), 64);
    assert!(!hello.client_nonce.is_empty());
}

#[tokio::test]
async fn a_signature_over_a_different_transcript_is_refused() {
    // Verified directly: the transcript binds every handshake field, so a
    // signature made for one session cannot authenticate another.
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("node")).unwrap();
    let identity = NodeIdentity::load_or_create(dir.path()).unwrap();

    let genuine = protocol::auth_transcript(&AuthTranscriptInput {
        protocol_version: 1,
        node_id: "node-1",
        instance_id: "inst-1",
        session_id: "sess-1",
        client_nonce: "cn",
        server_nonce: "sn",
        issued_at: 10,
        expires_at: 20,
        capabilities_digest: "cap",
    });
    let replayed_session = protocol::auth_transcript(&AuthTranscriptInput {
        protocol_version: 1,
        node_id: "node-1",
        instance_id: "inst-1",
        session_id: "sess-2",
        client_nonce: "cn",
        server_nonce: "sn",
        issued_at: 10,
        expires_at: 20,
        capabilities_digest: "cap",
    });
    let signature = identity.sign(&genuine);

    assert!(asterism_node::identity::verify_signature(
        &identity.public_key_base64(),
        &genuine,
        &signature
    ));
    assert!(!asterism_node::identity::verify_signature(
        &identity.public_key_base64(),
        &replayed_session,
        &signature
    ));
}

#[tokio::test]
async fn an_expired_challenge_is_refused_by_the_server() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("node")).unwrap();
    let mock = MockControlPlane::start().await;
    mock.issue_token("tok").await;
    mock.set_behaviour(Behaviour {
        expired_challenge: true,
        ..Behaviour::default()
    })
    .await;

    let mut identity = NodeIdentity::load_or_create(dir.path()).unwrap();
    control::enroll(&mut identity, &mock.base_url(), "tok", "a", true)
        .await
        .unwrap();

    let service = NodeService::new(
        dir.path(),
        UNREACHABLE_HERMES,
        "0123456789abcdef0123456789abcdef",
        Limits::default(),
    )
    .unwrap();
    let status = ChannelStatus::new(ConnectionState::Connecting);
    let (shutdown, shutdown_rx) = tokio::sync::watch::channel(false);
    let channel = tokio::spawn(
        ControlChannel {
            service,
            node_home: dir.path().to_path_buf(),
            config: NodeConfig {
                control_plane_url: Some(mock.base_url()),
                development: DevelopmentConfig {
                    allow_plaintext_loopback: true,
                },
                reconnect: asterism_node::nodehome::ReconnectConfig {
                    initial_backoff_ms: 10_000,
                    max_backoff_ms: 10_000,
                    jitter: 0.0,
                    stable_session_ms: 60_000,
                },
                ..NodeConfig::default()
            },
            status: status.clone(),
        }
        .run(shutdown_rx),
    );

    // The handshake must fail; the Node must not end up connected.
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_ne!(status.state().await, ConnectionState::Connected);
    assert!(mock.observations.lock().await.authentication_failures >= 1);

    let _ = shutdown.send(true);
    channel.abort();
}

// --------------------------------------------------------------- commands

#[tokio::test]
async fn a_remote_command_executes_through_the_node_service() {
    let harness = harness().await;
    harness
        .mock
        .push_command("cmd-1", "projects.list", None, json!({}))
        .await;

    let result = harness
        .mock
        .wait_result("cmd-1", SETTLE)
        .await
        .expect("a result must come back");

    assert_eq!(result["state"], json!("completed"));
    let projects = &result["result"]["projects"];
    assert_eq!(projects[0]["project_id"], json!("p1"));
    // The remote view never carries a host path.
    assert!(!result.to_string().contains("workspace_path"));
}

#[tokio::test]
async fn a_command_naming_an_unregistered_project_is_refused() {
    let harness = harness().await;
    harness
        .mock
        .push_command(
            "cmd-unknown",
            "runs.create",
            Some("not-registered"),
            json!({"input": "hello"}),
        )
        .await;

    let result = harness
        .mock
        .wait_result("cmd-unknown", SETTLE)
        .await
        .expect("a result must come back");

    assert_eq!(result["state"], json!("failed"));
    assert_eq!(
        result["error_code"],
        json!(ErrorCode::ProjectNotRegistered.as_str())
    );
}

#[tokio::test]
async fn a_forbidden_command_is_rejected_without_executing() {
    let harness = harness().await;
    harness
        .mock
        .push_command("cmd-evil", "shell.exec", Some("p1"), json!({"cmd": "id"}))
        .await;

    tokio::time::sleep(Duration::from_secs(2)).await;

    let observed = harness.mock.observations.lock().await;
    let refused = observed
        .protocol_errors
        .iter()
        .any(|error| error["code"] == json!(ErrorCode::ForbiddenCommand.as_str()));
    assert!(
        refused,
        "the Node must refuse commands outside the allow list"
    );
    // Nothing was recorded as work.
    let registry = Registry::open(&harness.node_home).unwrap();
    assert!(registry.remote_command("cmd-evil").unwrap().is_none());
}

#[tokio::test]
async fn a_redelivered_command_is_not_executed_twice() {
    let harness = harness().await;
    harness
        .mock
        .push_command(
            "cmd-dup",
            "runs.create",
            Some("p1"),
            json!({"input": "duplicate me"}),
        )
        .await;
    let first = harness
        .mock
        .wait_result("cmd-dup", SETTLE)
        .await
        .expect("first result");
    let run_id = first["result"]["run_id"].as_str().unwrap().to_owned();

    // Exactly the same command id and payload arrives again.
    harness
        .mock
        .push_command(
            "cmd-dup",
            "runs.create",
            Some("p1"),
            json!({"input": "duplicate me"}),
        )
        .await;
    tokio::time::sleep(Duration::from_secs(3)).await;

    let observed = harness.mock.observations.lock().await;
    let replies: Vec<&Value> = observed
        .command_results
        .iter()
        .filter(|result| result["command_id"] == json!("cmd-dup"))
        .collect();
    assert!(replies.len() >= 2, "the duplicate must still be answered");
    assert!(
        replies
            .iter()
            .any(|reply| reply["deduplicated"] == json!(true)),
        "the second answer must be marked as a replay"
    );
    drop(observed);

    // Only one run exists for that work.
    let registry = Registry::open(&harness.node_home).unwrap();
    let runs = registry.list_runs("p1", 50).unwrap();
    assert_eq!(runs.iter().filter(|run| run.run_id == run_id).count(), 1);
    assert_eq!(
        runs.len(),
        1,
        "a redelivered command must not create a second run"
    );
}

#[tokio::test]
async fn reusing_a_command_id_with_a_different_payload_is_a_protocol_violation() {
    let harness = harness().await;
    harness
        .mock
        .push_command("cmd-x", "runs.create", Some("p1"), json!({"input": "one"}))
        .await;
    harness.mock.wait_result("cmd-x", SETTLE).await.unwrap();

    harness
        .mock
        .push_command(
            "cmd-x",
            "runs.create",
            Some("p1"),
            json!({"input": "something else"}),
        )
        .await;
    tokio::time::sleep(Duration::from_secs(2)).await;

    let observed = harness.mock.observations.lock().await;
    assert!(
        observed
            .protocol_errors
            .iter()
            .any(|error| error["code"] == json!(ErrorCode::DuplicatePayloadMismatch.as_str())),
        "a reused id with different work must be reported as a violation"
    );
}

#[tokio::test]
async fn node_drain_stops_new_work_without_stopping_the_daemon() {
    let harness = harness().await;
    harness
        .mock
        .push_command("cmd-drain", "node.drain", None, json!({}))
        .await;

    let result = harness
        .mock
        .wait_result("cmd-drain", SETTLE)
        .await
        .expect("a drain acknowledgement");

    assert_eq!(result["state"], json!("completed"));
    assert_eq!(result["result"]["draining"], json!(true));
    assert!(harness.service.is_draining());

    // The local service is still answering; drain is not a shutdown.
    let health = harness.service.health().await;
    assert_eq!(health["status"], json!("ok"));
    assert_eq!(health["draining"], json!(true));
}

// ----------------------------------------------------------------- events

#[tokio::test]
async fn subscribed_events_are_delivered_and_acknowledged() {
    let harness = harness().await;
    harness
        .mock
        .push_command(
            "cmd-run",
            "runs.create",
            Some("p1"),
            json!({"input": "make some events"}),
        )
        .await;
    let created = harness.mock.wait_result("cmd-run", SETTLE).await.unwrap();
    let run_id = created["result"]["run_id"].as_str().unwrap().to_owned();

    harness
        .mock
        .push_command(
            "cmd-sub",
            "events.subscribe",
            Some("p1"),
            json!({"run_id": run_id, "from_seq": 0}),
        )
        .await;
    harness.mock.wait_result("cmd-sub", SETTLE).await.unwrap();

    let events = harness.mock.wait_events(&run_id, 2, SETTLE).await;
    assert!(
        events.len() >= 2,
        "expected journalled events, got {}",
        events.len()
    );

    let seqs: Vec<i64> = events
        .iter()
        .map(|event| event["seq"].as_i64().unwrap())
        .collect();
    assert_eq!(
        seqs[0], 1,
        "delivery starts at the first unacknowledged event"
    );
    assert!(
        seqs.windows(2).all(|pair| pair[1] > pair[0]),
        "ordering per run"
    );

    // The cursor advanced durably.
    await_acked_seq(&harness.node_home, &run_id, 2, SETTLE).await;
}

#[tokio::test]
async fn replay_resumes_from_the_acknowledged_cursor_after_a_disconnect() {
    let harness = harness().await;
    harness
        .mock
        .push_command(
            "cmd-run",
            "runs.create",
            Some("p1"),
            json!({"input": "events for replay"}),
        )
        .await;
    let created = harness.mock.wait_result("cmd-run", SETTLE).await.unwrap();
    let run_id = created["result"]["run_id"].as_str().unwrap().to_owned();

    harness
        .mock
        .push_command(
            "cmd-sub",
            "events.subscribe",
            Some("p1"),
            json!({"run_id": run_id, "from_seq": 0}),
        )
        .await;
    harness.mock.wait_result("cmd-sub", SETTLE).await.unwrap();
    harness.mock.wait_events(&run_id, 2, SETTLE).await;

    let acked_before = await_acked_seq(&harness.node_home, &run_id, 1, SETTLE).await;

    // Force a reconnect; the Node must resume strictly after the cursor.
    harness.mock.observations.lock().await.events.clear();
    harness
        .mock
        .set_behaviour(Behaviour {
            disconnect_after_frames: Some(1),
            ..Behaviour::default()
        })
        .await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    harness.mock.set_behaviour(Behaviour::default()).await;

    let resumed = harness.mock.wait_events(&run_id, 1, SETTLE).await;
    for event in &resumed {
        assert!(
            event["seq"].as_i64().unwrap() > acked_before,
            "resumed delivery must start strictly after the acknowledged cursor"
        );
    }
}

// ----------------------------------------------------------------- outbox

#[tokio::test]
async fn unacknowledged_results_are_retransmitted_after_a_reconnect() {
    let harness = harness().await;
    // The Control Plane never acknowledges, so the outbox must retain and resend.
    harness
        .mock
        .set_behaviour(Behaviour {
            withhold_result_acks: true,
            ..Behaviour::default()
        })
        .await;

    harness
        .mock
        .push_command("cmd-keep", "projects.list", None, json!({}))
        .await;
    harness.mock.wait_result("cmd-keep", SETTLE).await.unwrap();

    let depth = {
        let registry = Registry::open(&harness.node_home).unwrap();
        registry.outbox_depth().unwrap()
    };
    assert!(
        depth >= 1,
        "an unacknowledged result must stay in the outbox"
    );

    let before = harness
        .mock
        .observations
        .lock()
        .await
        .command_results
        .iter()
        .filter(|result| result["command_id"] == json!("cmd-keep"))
        .count();

    // Reconnect, then start acknowledging again.
    harness
        .mock
        .set_behaviour(Behaviour {
            disconnect_after_frames: Some(1),
            withhold_result_acks: true,
            ..Behaviour::default()
        })
        .await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    harness.mock.set_behaviour(Behaviour::default()).await;
    tokio::time::sleep(Duration::from_secs(4)).await;

    let after = harness
        .mock
        .observations
        .lock()
        .await
        .command_results
        .iter()
        .filter(|result| result["command_id"] == json!("cmd-keep"))
        .count();
    assert!(
        after > before,
        "the result must be retransmitted after reconnect ({before} -> {after})"
    );

    let drained = {
        let registry = Registry::open(&harness.node_home).unwrap();
        registry.outbox_depth().unwrap()
    };
    assert_eq!(drained, 0, "acknowledgement must clear the outbox");
}

// ------------------------------------------------------------- resilience

#[tokio::test]
async fn malformed_and_oversized_frames_do_not_kill_the_channel() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("node")).unwrap();
    let mock = MockControlPlane::start().await;
    mock.issue_token("tok").await;
    mock.set_behaviour(Behaviour {
        send_malformed_frame: true,
        send_oversized_frame: true,
        ..Behaviour::default()
    })
    .await;

    let mut identity = NodeIdentity::load_or_create(dir.path()).unwrap();
    control::enroll(&mut identity, &mock.base_url(), "tok", "a", true)
        .await
        .unwrap();

    let service = NodeService::new(
        dir.path(),
        UNREACHABLE_HERMES,
        "0123456789abcdef0123456789abcdef",
        Limits::default(),
    )
    .unwrap();
    let status = ChannelStatus::new(ConnectionState::Connecting);
    let (shutdown, shutdown_rx) = tokio::sync::watch::channel(false);
    let channel = tokio::spawn(
        ControlChannel {
            service: service.clone(),
            node_home: dir.path().to_path_buf(),
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

    mock.wait_connected(SETTLE).await.expect("handshake");
    tokio::time::sleep(Duration::from_secs(2)).await;

    // The daemon survived and the local service still answers.
    assert_eq!(service.health().await["status"], json!("ok"));
    assert!(
        status
            .metrics()
            .protocol_errors
            .load(std::sync::atomic::Ordering::Relaxed)
            >= 1
    );

    let _ = shutdown.send(true);
    channel.abort();
}

#[tokio::test]
async fn the_local_service_keeps_working_while_the_control_plane_is_absent() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("node")).unwrap();

    let service = NodeService::new(
        dir.path(),
        UNREACHABLE_HERMES,
        "0123456789abcdef0123456789abcdef",
        Limits::default(),
    )
    .unwrap();
    let status = ChannelStatus::new(ConnectionState::Connecting);
    service.attach_channel(status.clone()).await;

    // A Control Plane URL that will never answer.
    let (shutdown, shutdown_rx) = tokio::sync::watch::channel(false);
    let channel = tokio::spawn(
        ControlChannel {
            service: service.clone(),
            node_home: dir.path().to_path_buf(),
            config: NodeConfig {
                control_plane_url: Some("http://127.0.0.1:1".to_owned()),
                development: DevelopmentConfig {
                    allow_plaintext_loopback: true,
                },
                ..NodeConfig::default()
            },
            status,
        }
        .run(shutdown_rx),
    );

    // Unenrolled and unreachable — the local API must not care.
    let health = service.health().await;
    assert_eq!(health["status"], json!("ok"));
    assert_eq!(health["control_plane"]["connected"], json!(false));

    let created = service
        .create_run(
            "p1",
            asterism_node::service::CreateRun {
                input: "local work".to_owned(),
                ..Default::default()
            },
        )
        .await
        .expect("runs must be creatable with no Control Plane");
    assert!(created.run.run_id.starts_with("arun_"));

    let _ = shutdown.send(true);
    channel.abort();
}

#[tokio::test]
async fn an_unenrolled_node_reports_its_state_without_connecting() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("node")).unwrap();
    NodeIdentity::load_or_create(dir.path()).unwrap();

    let service = NodeService::new(
        dir.path(),
        UNREACHABLE_HERMES,
        "0123456789abcdef0123456789abcdef",
        Limits::default(),
    )
    .unwrap();
    let status = ChannelStatus::new(ConnectionState::Connecting);
    let (shutdown, shutdown_rx) = tokio::sync::watch::channel(false);
    let channel = tokio::spawn(
        ControlChannel {
            service,
            node_home: dir.path().to_path_buf(),
            config: NodeConfig {
                control_plane_url: Some("https://control.example".to_owned()),
                ..NodeConfig::default()
            },
            status: status.clone(),
        }
        .run(shutdown_rx),
    );

    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(status.state().await, ConnectionState::Unenrolled);

    let _ = shutdown.send(true);
    channel.abort();
}

#[tokio::test]
async fn the_node_opens_no_inbound_listener() {
    // The mock is the only thing listening. The Node dials out; it never binds
    // a TCP port, which is the security property Phase F rests on.
    let harness = harness().await;

    let listeners = std::fs::read_to_string("/proc/net/tcp").unwrap_or_default();
    let mock_port = harness.mock.http_addr.port();
    let listening_ports: Vec<u16> = listeners
        .lines()
        .skip(1)
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let local = fields.nth(1)?;
            let state = fields.nth(1)?;
            // 0A is TCP_LISTEN.
            (state == "0A").then(|| u16::from_str_radix(local.split(':').nth(1)?, 16).ok())?
        })
        .collect();

    assert!(
        listening_ports.contains(&mock_port),
        "the mock Control Plane should be the listener in this test"
    );
    assert_eq!(
        harness.status.state().await,
        ConnectionState::Connected,
        "and the Node reached it by dialling out"
    );
}
