//! The provisioning chain, end to end.
//!
//! Real workspace provisioner, real profile provisioner, real port allocator,
//! real inventory and the real authenticated health check. Only two things are
//! fakes, and both are boundaries this process cannot own in a test: systemd,
//! and the Hermes worker itself.
//!
//! The fake worker checks the bearer token. A health server that answered
//! anything would prove the chain reaches *a* port, not that it reaches the
//! worker it provisioned with the key it generated.

use std::sync::{Arc, Mutex as StdMutex};

use anyhow::Result;
use asterism_node::inventory::{ProfileState, RuntimeOwnership};
use asterism_node::profiles::{ProvisionSettings, read_worker_key};
use asterism_node::provisioning::{
    ProvisionOutcome, ProvisionRequest, WorkspaceMode, WorkspaceSettings, provision_project,
};
use asterism_node::registry::Registry;
use asterism_node::workers::{HttpWorkerHealth, ServiceControl, WorkerManager, WorkerTimings};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

/// Records what was asked of systemd so a test can assert the exact unit.
#[derive(Default)]
struct FakeSystemd {
    calls: StdMutex<Vec<String>>,
    started: StdMutex<Vec<String>>,
    refuse_start: bool,
}

impl FakeSystemd {
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

impl ServiceControl for FakeSystemd {
    fn start(&self, unit: &str) -> Result<()> {
        self.calls.lock().unwrap().push(format!("start {unit}"));
        if self.refuse_start {
            anyhow::bail!("unit refused to start");
        }
        self.started.lock().unwrap().push(unit.to_owned());
        Ok(())
    }
    fn stop(&self, unit: &str) -> Result<()> {
        self.calls.lock().unwrap().push(format!("stop {unit}"));
        Ok(())
    }
    fn restart(&self, unit: &str) -> Result<()> {
        self.calls.lock().unwrap().push(format!("restart {unit}"));
        Ok(())
    }
    fn is_active(&self, unit: &str) -> Result<bool> {
        Ok(self.started.lock().unwrap().iter().any(|held| held == unit))
    }
}

/// A worker that answers `/health` only for the key it was told to expect.
///
/// Bound to a port the allocator has already chosen, so the chain has to reach
/// exactly this listener with exactly that credential.
async fn fake_worker(
    port: u16,
    expected_key: String,
    healthy: bool,
) -> tokio::task::JoinHandle<()> {
    let listener = TcpListener::bind(("127.0.0.1", port)).await.expect("bind");
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let mut buffer = vec![0u8; 4096];
            let Ok(read) = stream.read(&mut buffer).await else {
                continue;
            };
            let request = String::from_utf8_lossy(&buffer[..read]).to_string();
            let authorized = request.contains(&format!("Bearer {expected_key}"));
            let status = if authorized && healthy {
                "HTTP/1.1 200 OK"
            } else if authorized {
                "HTTP/1.1 503 Service Unavailable"
            } else {
                "HTTP/1.1 401 Unauthorized"
            };
            let _ = stream
                .write_all(
                    format!("{status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .as_bytes(),
                )
                .await;
            let _ = stream.shutdown().await;
        }
    })
}

struct Harness {
    _root: tempfile::TempDir,
    registry: Mutex<Registry>,
    workspace: WorkspaceSettings,
    profiles: ProvisionSettings,
    port: u16,
}

/// A Node with one registered project and a free port already chosen.
///
/// The port is picked first so the fake worker can be listening before the
/// chain reserves it: the allocator skips ports that already answer, so the
/// range is narrowed to exactly the one the worker holds.
async fn harness(project_id: &str) -> Harness {
    let root = tempfile::tempdir().unwrap();
    let port = {
        let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        port
    };
    let registry = Registry::open(root.path()).unwrap();
    let workspace = WorkspaceSettings {
        root: root.path().join("projects"),
        forbidden: vec![root.path().join("deployment")],
    };
    let profiles = ProvisionSettings {
        home_root: root.path().join("hermes-projects"),
        shared_auth: root.path().join("shared-auth.json"),
        port_range: port..=port,
        // The production endpoint is never a candidate.
        reserved_ports: vec![18642],
        production_home: root.path().join("hermes"),
        runtime_uid: unsafe { libc::getuid() },
    };
    std::fs::write(&profiles.shared_auth, b"{}").unwrap();
    let _ = project_id;
    Harness {
        _root: root,
        registry: Mutex::new(registry),
        workspace,
        profiles,
        port,
    }
}

fn request(project_id: &str, generation: u64) -> ProvisionRequest {
    ProvisionRequest {
        organization_id: "org_bootstrap".to_owned(),
        project_id: project_id.to_owned(),
        node_project_id: project_id.to_owned(),
        generation,
        mode: WorkspaceMode::Empty,
        repository_url: None,
        branch: None,
    }
}

fn manager(control: Arc<FakeSystemd>) -> WorkerManager {
    WorkerManager::new(
        control,
        // The real health client, so the credential and the endpoint are
        // exercised rather than described.
        Arc::new(HttpWorkerHealth),
        WorkerTimings {
            startup: std::time::Duration::from_secs(5),
            poll: std::time::Duration::from_millis(50),
        },
        unsafe { libc::getuid() },
    )
}

#[tokio::test]
async fn a_project_is_built_and_promoted_only_after_its_worker_answers() {
    let project_id = "prj_chain";
    let harness = harness(project_id).await;

    // The key does not exist until the chain generates it, so the worker is
    // started after provisioning has written it.
    let control = Arc::new(FakeSystemd::default());
    let manager = manager(Arc::clone(&control));

    // First pass: the worker is not listening, so health fails and the project
    // must not be promoted.
    let outcome = provision_project(
        &harness.registry,
        &harness.workspace,
        &harness.profiles,
        &manager,
        &request(project_id, 1),
    )
    .await;
    assert!(matches!(outcome, ProvisionOutcome::Failed { .. }));

    let stored = {
        let guard = harness.registry.lock().await;
        guard.project(project_id).unwrap().unwrap()
    };
    // Everything exists — workspace, home, key, port, and systemd was asked to
    // start the unit — and the project is still not ready.
    assert!(
        std::path::Path::new(&stored.workspace_path)
            .join(".git")
            .is_dir()
    );
    let home = stored.hermes_home.clone().unwrap();
    assert!(std::path::Path::new(&home).is_dir());
    assert_ne!(stored.profile_state, ProfileState::Ready);
    assert!(
        control
            .calls()
            .iter()
            .any(|call| call.starts_with("start asterism-hermes@asterism-project-")),
        "the exact owned unit was started: {:?}",
        control.calls()
    );

    // The endpoint is the one the allocator reserved, and never production.
    let endpoint = stored.runtime_endpoint.clone().unwrap();
    assert!(endpoint.ends_with(&format!(":{}", harness.port)));
    assert!(!endpoint.contains("18642"));

    // Now the worker answers, with the key provisioning wrote for it.
    let key_path = std::path::PathBuf::from(stored.hermes_api_key_ref.clone().unwrap());
    let key = read_worker_key(&key_path, unsafe { libc::getuid() }).unwrap();
    let worker = fake_worker(harness.port, key.clone(), true).await;

    let outcome = provision_project(
        &harness.registry,
        &harness.workspace,
        &harness.profiles,
        &manager,
        &request(project_id, 2),
    )
    .await;
    assert_eq!(
        outcome,
        ProvisionOutcome::Provisioned {
            workspace_created: false
        },
        "the second pass reused the workspace and reached a healthy worker"
    );

    let promoted = {
        let guard = harness.registry.lock().await;
        guard.project(project_id).unwrap().unwrap()
    };
    assert_eq!(promoted.profile_state, ProfileState::Ready);
    // Nothing moved between attempts: the home, the key and the port are the
    // ones the first pass created.
    assert_eq!(promoted.hermes_home, stored.hermes_home);
    assert_eq!(promoted.runtime_endpoint, stored.runtime_endpoint);
    assert_eq!(
        read_worker_key(&key_path, unsafe { libc::getuid() }).unwrap(),
        key
    );
    worker.abort();
}

#[tokio::test]
async fn a_worker_that_rejects_the_credential_never_promotes_the_project() {
    let project_id = "prj_wrongkey";
    let harness = harness(project_id).await;
    let control = Arc::new(FakeSystemd::default());
    let manager = manager(Arc::clone(&control));

    // Reserve first: the allocator skips a port that already answers, so the
    // listener has to arrive after the endpoint is committed.
    let _ = provision_project(
        &harness.registry,
        &harness.workspace,
        &harness.profiles,
        &manager,
        &request(project_id, 1),
    )
    .await;

    // A listener that answers only for a different key. The endpoint is
    // reachable, so nothing but the credential can distinguish it.
    let worker = fake_worker(harness.port, "a-different-key".to_owned(), true).await;

    let outcome = provision_project(
        &harness.registry,
        &harness.workspace,
        &harness.profiles,
        &manager,
        &request(project_id, 2),
    )
    .await;

    match outcome {
        ProvisionOutcome::Failed { failure, message } => {
            assert_eq!(failure.as_str(), "profile_worker_unhealthy");
            // Sanitized: no path, port or key in what leaves the Node.
            for secret in ["/var", "18", "key"] {
                assert!(
                    !message.contains(secret),
                    "message leaked {secret}: {message}"
                );
            }
        }
        other => panic!("expected a typed failure, got {other:?}"),
    }

    let stored = {
        let guard = harness.registry.lock().await;
        guard.project(project_id).unwrap().unwrap()
    };
    assert_ne!(stored.profile_state, ProfileState::Ready);
    // The completed work survives for a retry.
    assert!(
        std::path::Path::new(&stored.workspace_path)
            .join(".git")
            .is_dir()
    );
    assert!(std::path::Path::new(&stored.hermes_home.unwrap()).is_dir());
    worker.abort();
}

#[tokio::test]
async fn a_repeated_command_reuses_everything_it_already_built() {
    let project_id = "prj_replay";
    let harness = harness(project_id).await;
    let control = Arc::new(FakeSystemd::default());
    let manager = manager(Arc::clone(&control));

    // Build once against a listener that is not yet answering, then start it.
    let _ = provision_project(
        &harness.registry,
        &harness.workspace,
        &harness.profiles,
        &manager,
        &request(project_id, 1),
    )
    .await;
    let first = {
        let guard = harness.registry.lock().await;
        guard.project(project_id).unwrap().unwrap()
    };
    let key_path = std::path::PathBuf::from(first.hermes_api_key_ref.clone().unwrap());
    let key = read_worker_key(&key_path, unsafe { libc::getuid() }).unwrap();
    let worker = fake_worker(harness.port, key.clone(), true).await;

    // A marker in the profile's memory, the thing a rebuild would destroy.
    let memories = std::path::PathBuf::from(first.hermes_home.clone().unwrap()).join("memories");
    std::fs::write(memories.join("marker"), b"remembered").unwrap();

    for generation in [1u64, 2] {
        let outcome = provision_project(
            &harness.registry,
            &harness.workspace,
            &harness.profiles,
            &manager,
            &request(project_id, generation),
        )
        .await;
        assert_eq!(
            outcome,
            ProvisionOutcome::Provisioned {
                workspace_created: false
            }
        );
    }

    let after = {
        let guard = harness.registry.lock().await;
        guard.project(project_id).unwrap().unwrap()
    };
    assert_eq!(after.hermes_home, first.hermes_home);
    assert_eq!(after.runtime_endpoint, first.runtime_endpoint);
    assert_eq!(after.workspace_path, first.workspace_path);
    assert_eq!(
        read_worker_key(&key_path, unsafe { libc::getuid() }).unwrap(),
        key,
        "a replay must not rotate the worker's credential"
    );
    assert_eq!(
        std::fs::read_to_string(memories.join("marker")).unwrap(),
        "remembered",
        "a replay must not discard the project's memory"
    );
    worker.abort();
}

#[tokio::test]
async fn a_project_registered_against_another_workspace_is_refused() {
    let project_id = "prj_conflict";
    let harness = harness(project_id).await;
    let elsewhere = tempfile::tempdir().unwrap();
    {
        let mut guard = harness.registry.lock().await;
        guard
            .register_project(
                project_id,
                elsewhere.path(),
                None,
                None,
                None,
                RuntimeOwnership::ManagedContainer,
            )
            .unwrap();
    }

    let control = Arc::new(FakeSystemd::default());
    let outcome = provision_project(
        &harness.registry,
        &harness.workspace,
        &harness.profiles,
        &manager(Arc::clone(&control)),
        &request(project_id, 1),
    )
    .await;

    match outcome {
        ProvisionOutcome::Failed { failure, .. } => {
            assert_eq!(failure.as_str(), "workspace_conflict");
        }
        other => panic!("expected a conflict, got {other:?}"),
    }
    // Nothing was started for a project whose identity does not line up.
    assert!(control.calls().is_empty());
}
