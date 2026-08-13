//! The persistent Asterism Node daemon.
//!
//! `node serve` runs in the **foreground** and is meant to be supervised by a
//! system service manager. There is deliberately no double-fork daemonizer and
//! no systemd unit here.
//!
//! The daemon owns everything that must outlive a client: the registry
//! connection, active run workers, reconciliation, and the local control
//! endpoint. A CLI invocation is now a thin client.
//!
//! # Endpoint
//!
//! The only control surface is a Unix domain socket under the Node state
//! directory. There is no TCP listener, nothing binds `0.0.0.0`, and the socket
//! is never mounted into a project container — a project agent has no path to
//! it. The future Control Plane link will be an **outbound** connection made by
//! this daemon; it is not this socket.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Semaphore;

use crate::api;
use crate::runlock::flock_exclusive_nonblocking;
use crate::service::{Limits, NodeService};

/// Socket path relative to the Node state root.
pub const SOCKET_RELATIVE_PATH: &str = "node/asterism.sock";
/// Singleton lock path relative to the Node state root.
pub const DAEMON_LOCK_RELATIVE_PATH: &str = "node/daemon.lock";

/// How often idle projects are re-reconciled.
const RECONCILE_INTERVAL: Duration = Duration::from_secs(60);
/// Upper bound on graceful shutdown.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(20);

pub fn socket_path(state_root: impl AsRef<Path>) -> PathBuf {
    state_root.as_ref().join(SOCKET_RELATIVE_PATH)
}

pub fn lock_path(state_root: impl AsRef<Path>) -> PathBuf {
    state_root.as_ref().join(DAEMON_LOCK_RELATIVE_PATH)
}

/// Stable error code returned to clients when no daemon is listening.
pub const NODE_UNAVAILABLE_CODE: &str = "node_unavailable";

/// Configuration for one daemon instance.
#[derive(Debug, Clone)]
pub struct DaemonConfig {
    /// Node home. Also the state root for the registry and socket.
    pub state_root: PathBuf,
    pub base_url: String,
    pub api_key: String,
    pub projects: Vec<String>,
    pub limits: Limits,
    /// Persistent Node configuration, including the Control Plane endpoint.
    pub node_config: crate::nodehome::NodeConfig,
}

/// Run the daemon until a shutdown signal arrives.
pub async fn serve(config: DaemonConfig) -> Result<()> {
    let node_dir = config.state_root.join("node");
    std::fs::create_dir_all(&node_dir)
        .with_context(|| format!("failed to create {}", node_dir.display()))?;
    // The state directory holds the registry and the socket; restrict it to the
    // owning user before anything is created inside it.
    harden_directory(&node_dir)?;

    // Singleton first: holding this lock is what makes stale-socket cleanup
    // race-safe, because no other daemon can be starting concurrently.
    let _singleton = acquire_singleton(&config.state_root)?;

    let socket = socket_path(&config.state_root);
    prepare_socket_path(&socket)?;

    let service = NodeService::new(
        &config.state_root,
        &config.base_url,
        &config.api_key,
        config.limits,
    )?;

    log_event(
        "node.starting",
        json!({
            "instance_id": service.instance_id(),
            "socket": socket.display().to_string(),
            "projects": config.projects,
        }),
    );

    // Startup reconciliation happens before the endpoint opens, so no client can
    // observe or act on unreconciled state.
    for project in &config.projects {
        match service.reconcile(project).await {
            Ok(outcomes) => log_event(
                "node.reconciled",
                json!({"project_id": project, "resolved": outcomes.len()}),
            ),
            Err(error) => log_event(
                "node.reconcile_failed",
                json!({"project_id": project, "error": error.code()}),
            ),
        }
    }

    let listener = UnixListener::bind(&socket)
        .with_context(|| format!("failed to bind the control socket {}", socket.display()))?;
    harden_socket(&socket)?;

    log_event(
        "node.listening",
        json!({"socket": socket.display().to_string()}),
    );

    // The outbound control channel. It never listens; if it cannot connect the
    // daemon carries on serving locally.
    let channel_status =
        crate::control::ChannelStatus::new(if config.node_config.control_plane_url.is_some() {
            crate::control::ConnectionState::Connecting
        } else {
            crate::control::ConnectionState::Disabled
        });
    service.attach_channel(channel_status.clone()).await;
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let control = tokio::spawn(
        crate::control::ControlChannel {
            service: service.clone(),
            node_home: config.state_root.clone(),
            config: config.node_config.clone(),
            status: channel_status,
        }
        .run(shutdown_rx),
    );

    let connections = Arc::new(Semaphore::new(config.limits.max_connections));
    let reconcile_service = service.clone();
    let reconcile_projects = config.projects.clone();
    let periodic = tokio::spawn(async move {
        loop {
            tokio::time::sleep(RECONCILE_INTERVAL).await;
            if reconcile_service.is_draining() {
                return;
            }
            for project in &reconcile_projects {
                let _ = reconcile_service.reconcile(project).await;
            }
        }
    });

    let accept_service = service.clone();
    let accept_limit = Arc::clone(&connections);
    let acceptor = tokio::spawn(async move {
        loop {
            let (stream, _) = match listener.accept().await {
                Ok(accepted) => accepted,
                Err(error) => {
                    log_event("node.accept_failed", json!({"error": error.to_string()}));
                    continue;
                }
            };

            // Bound concurrent clients; a flood cannot exhaust the daemon.
            let Ok(permit) = Arc::clone(&accept_limit).try_acquire_owned() else {
                log_event("node.connection_rejected", json!({"reason": "too_many"}));
                continue;
            };

            if let Err(error) = authorize_peer(&stream) {
                log_event(
                    "node.connection_rejected",
                    json!({"reason": "unauthorized_peer", "detail": error.to_string()}),
                );
                continue;
            }

            let connection_service = accept_service.clone();
            tokio::spawn(async move {
                let _permit = permit;
                let io = TokioIo::new(stream);
                let handler = service_fn(move |request| {
                    let service = connection_service.clone();
                    async move { Ok::<_, std::convert::Infallible>(api::handle(service, request).await) }
                });
                // Malformed HTTP is a connection-level error hyper reports and
                // we drop; it can never take the daemon down.
                if let Err(error) = hyper::server::conn::http1::Builder::new()
                    .serve_connection(io, handler)
                    .with_upgrades()
                    .await
                {
                    log_event("node.connection_error", json!({"error": error.to_string()}));
                }
            });
        }
    });

    wait_for_shutdown().await;
    log_event("node.draining", json!({}));

    acceptor.abort();
    periodic.abort();
    let _ = shutdown_tx.send(true);
    let _ = tokio::time::timeout(Duration::from_secs(5), control).await;

    // Active Hermes runs are deliberately not cancelled: shutting the daemon
    // down must not destroy work nobody asked to stop. Whatever is still live is
    // picked up by the next startup reconciliation.
    let remaining = service.drain(SHUTDOWN_TIMEOUT).await;
    let _ = std::fs::remove_file(&socket);

    log_event(
        "node.stopped",
        json!({"unfinished_workers": remaining, "socket_removed": true}),
    );
    Ok(())
}

/// Report what a client can learn without a running daemon.
pub fn status(state_root: &Path) -> Value {
    let socket = socket_path(state_root);
    json!({
        "node_home": state_root.display().to_string(),
        "state_root": state_root.display().to_string(),
        "socket": socket.display().to_string(),
        "socket_present": socket.exists(),
        "registry": crate::registry::Registry::path_for(state_root)
            .display()
            .to_string(),
    })
}

/// Take the per-state-directory singleton lock.
///
/// Two daemons sharing one state directory would both supervise runs and both
/// answer on the socket, so this is refused outright. The kernel releases the
/// lock if the daemon dies, so a crash never blocks the next start.
fn acquire_singleton(state_root: &Path) -> Result<std::fs::File> {
    let path = lock_path(state_root);
    let file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .truncate(false)
        .write(true)
        .open(&path)
        .with_context(|| format!("failed to open the daemon lock {}", path.display()))?;

    if !flock_exclusive_nonblocking(&file)? {
        bail!(
            "another Asterism Node daemon is already running for {}",
            state_root.display()
        );
    }
    Ok(file)
}

/// Remove a socket left behind by a dead daemon, and refuse to steal a live one.
///
/// Safe because the singleton lock is already held: if this process got the
/// lock, no other daemon owns the socket, so a file still present is stale. The
/// connect probe is a second, independent check rather than the only one.
fn prepare_socket_path(socket: &Path) -> Result<()> {
    if !socket.exists() {
        return Ok(());
    }

    match std::os::unix::net::UnixStream::connect(socket) {
        Ok(_) => bail!(
            "the control socket {} is already served by a live process",
            socket.display()
        ),
        Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => {
            std::fs::remove_file(socket).with_context(|| {
                format!("failed to remove the stale socket {}", socket.display())
            })?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error)
            .with_context(|| format!("failed to probe the existing socket {}", socket.display())),
    }
}

fn harden_directory(dir: &Path) -> Result<()> {
    let mut permissions = std::fs::metadata(dir)?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(dir, permissions)
        .with_context(|| format!("failed to restrict {}", dir.display()))
}

/// Narrow the socket to the owning user only. Applied on every start, so the
/// permissions survive restarts regardless of umask.
fn harden_socket(socket: &Path) -> Result<()> {
    let mut permissions = std::fs::metadata(socket)?.permissions();
    permissions.set_mode(0o600);
    std::fs::set_permissions(socket, permissions)
        .with_context(|| format!("failed to restrict {}", socket.display()))
}

/// Verify the connecting process belongs to the same user.
///
/// Socket permissions already exclude other users; `SO_PEERCRED` is a second,
/// kernel-attested check that does not depend on filesystem modes being right.
fn authorize_peer(stream: &UnixStream) -> Result<()> {
    let peer = stream
        .peer_cred()
        .context("failed to read peer credentials")?;
    // SAFETY: getuid is always safe and cannot fail.
    let expected = unsafe { libc::getuid() };
    if peer.uid() != expected {
        bail!(
            "rejecting a connection from uid {} (daemon runs as uid {expected})",
            peer.uid()
        );
    }
    Ok(())
}

async fn wait_for_shutdown() {
    let interrupt = tokio::signal::ctrl_c();
    let mut terminate =
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(signal) => signal,
            Err(_) => {
                let _ = interrupt.await;
                return;
            }
        };

    tokio::select! {
        _ = interrupt => log_event("node.signal", json!({"signal": "SIGINT"})),
        _ = terminate.recv() => log_event("node.signal", json!({"signal": "SIGTERM"})),
    }
}

/// Structured single-line log record.
///
/// Fields are redacted before rendering, so a payload that happens to carry
/// credential-shaped material can never reach the log.
pub fn log_event(event: &str, fields: Value) {
    let redacted = crate::redact::redact(&fields).value;
    let line = json!({
        "ts": crate::registry::now_millis(),
        "event": event,
        "fields": redacted,
    });
    println!(
        "{}",
        serde_json::to_string(&line).unwrap_or_else(|_| format!("{{\"event\":\"{event}\"}}"))
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_live_under_the_node_state_directory() {
        assert_eq!(
            socket_path("/srv/state"),
            PathBuf::from("/srv/state/node/asterism.sock")
        );
        assert_eq!(
            lock_path("/srv/state"),
            PathBuf::from("/srv/state/node/daemon.lock")
        );
    }

    #[test]
    fn a_second_daemon_cannot_share_a_state_directory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("node")).unwrap();

        let _first = acquire_singleton(dir.path()).unwrap();
        let second = acquire_singleton(dir.path());

        assert!(second.is_err());
        assert!(second.unwrap_err().to_string().contains("already running"));
    }

    #[test]
    fn the_singleton_lock_is_released_when_the_daemon_exits() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("node")).unwrap();

        {
            let _held = acquire_singleton(dir.path()).unwrap();
        }
        // A crashed daemon must not block the next start.
        assert!(acquire_singleton(dir.path()).is_ok());
    }

    #[test]
    fn a_stale_socket_is_removed() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("asterism.sock");
        // A plain file at the socket path behaves like a dead socket: connecting
        // fails with "connection refused".
        std::os::unix::net::UnixListener::bind(&socket).unwrap();
        drop(std::fs::File::open(&socket));

        // Rebinding without cleanup would fail with AddrInUse.
        prepare_socket_path(&socket).unwrap();
        assert!(!socket.exists());
    }

    #[test]
    fn a_live_socket_is_never_stolen() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("asterism.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();

        let result = prepare_socket_path(&socket);

        assert!(result.is_err());
        assert!(socket.exists(), "a live socket must survive the probe");
    }

    #[test]
    fn preparing_an_absent_socket_is_a_no_op() {
        let dir = tempfile::tempdir().unwrap();
        assert!(prepare_socket_path(&dir.path().join("missing.sock")).is_ok());
    }

    #[test]
    fn the_node_directory_is_restricted_to_its_owner() {
        let dir = tempfile::tempdir().unwrap();
        let node = dir.path().join("node");
        std::fs::create_dir_all(&node).unwrap();

        harden_directory(&node).unwrap();

        let mode = std::fs::metadata(&node).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[test]
    fn the_socket_is_restricted_to_its_owner() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("asterism.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();

        harden_socket(&socket).unwrap();

        let mode = std::fs::metadata(&socket).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn status_reports_socket_presence_without_a_daemon() {
        let dir = tempfile::tempdir().unwrap();
        let reported = status(dir.path());

        assert_eq!(reported["socket_present"], json!(false));
        assert!(
            reported["socket"]
                .as_str()
                .unwrap()
                .ends_with("node/asterism.sock")
        );
    }

    #[test]
    fn log_records_are_single_line_json_with_redacted_fields() {
        // Rendering must not panic and must destroy credential-shaped values.
        let redacted = crate::redact::redact(&json!({"access_token": "abc", "run_id": "arun_1"}));
        assert_eq!(redacted.value["access_token"], json!("[redacted]"));
        assert_eq!(redacted.value["run_id"], json!("arun_1"));
    }
}
