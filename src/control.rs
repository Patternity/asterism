//! Outbound control channel to the Asterism Control Plane.
//!
//! The direction is the security property: the Node **dials out** and never
//! listens. Nothing in this module opens a port, and the local Unix socket from
//! Phase E is untouched.
//!
//! Responsibilities: enrollment over HTTPS, a persistent authenticated
//! WebSocket session, heartbeats, remote command execution through
//! [`NodeService`], durable event subscriptions, and outbox retransmission.
//! Losing the Control Plane degrades nothing locally — the daemon keeps serving
//! its socket and keeps executing runs.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

use crate::identity::NodeIdentity;
use crate::nodehome::NodeConfig;
use crate::protocol::{
    self, AuthTranscriptInput, ClientHello, Envelope, ErrorCode, EventAck, ProtocolError,
    RemoteCommand, ServerChallenge, ServerReady, SubscribeRequest, message_types,
};
use crate::registry::Registry;
use crate::remote::{CommandAdmission, CommandState};
use crate::runpolicy::RunApprovalPolicy;
use crate::service::{CreateRun, NodeService};

/// Software version reported to the Control Plane.
pub const SOFTWARE_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Outbox entry kinds.
pub const OUTBOX_COMMAND_RESULT: &str = "command.result";
pub const OUTBOX_DRAIN_ACK: &str = "node.drain.ack";

/// Externally visible state of the control channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionState {
    /// No Control Plane URL is configured.
    Disabled,
    /// Configured but this Node has not enrolled.
    Unenrolled,
    Connecting,
    Authenticating,
    Connected,
    BackingOff,
    Draining,
    /// A configuration-level failure that retrying cannot fix.
    Failed,
}

impl ConnectionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Unenrolled => "unenrolled",
            Self::Connecting => "connecting",
            Self::Authenticating => "authenticating",
            Self::Connected => "connected",
            Self::BackingOff => "backing_off",
            Self::Draining => "draining",
            Self::Failed => "failed",
        }
    }

    /// A transient network problem is not a Node failure.
    pub fn is_healthy_for_local_use(self) -> bool {
        true
    }
}

/// Counters surfaced through the local API for diagnostics.
#[derive(Debug, Default)]
pub struct ChannelMetrics {
    pub connection_attempts: AtomicU64,
    pub sessions_established: AtomicU64,
    pub authentication_failures: AtomicU64,
    pub protocol_errors: AtomicU64,
    pub commands_received: AtomicU64,
    pub commands_duplicate: AtomicU64,
    pub commands_rejected: AtomicU64,
    pub responses_retransmitted: AtomicU64,
    pub events_sent: AtomicU64,
    pub heartbeat_timeouts: AtomicU64,
}

impl ChannelMetrics {
    fn bump(counter: &AtomicU64) {
        counter.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> Value {
        json!({
            "connection_attempts": self.connection_attempts.load(Ordering::Relaxed),
            "sessions_established": self.sessions_established.load(Ordering::Relaxed),
            "authentication_failures": self.authentication_failures.load(Ordering::Relaxed),
            "protocol_errors": self.protocol_errors.load(Ordering::Relaxed),
            "commands_received": self.commands_received.load(Ordering::Relaxed),
            "commands_duplicate": self.commands_duplicate.load(Ordering::Relaxed),
            "commands_rejected": self.commands_rejected.load(Ordering::Relaxed),
            "responses_retransmitted": self.responses_retransmitted.load(Ordering::Relaxed),
            "events_sent": self.events_sent.load(Ordering::Relaxed),
            "heartbeat_timeouts": self.heartbeat_timeouts.load(Ordering::Relaxed),
        })
    }
}

/// Shared, cheaply cloneable view of the channel for the local API.
#[derive(Debug, Clone)]
pub struct ChannelStatus {
    inner: Arc<StatusInner>,
}

#[derive(Debug)]
struct StatusInner {
    state: Mutex<ConnectionState>,
    session_id: Mutex<Option<String>>,
    last_error: Mutex<Option<String>>,
    metrics: ChannelMetrics,
}

impl Default for ChannelStatus {
    fn default() -> Self {
        Self::new(ConnectionState::Disabled)
    }
}

impl ChannelStatus {
    pub fn new(state: ConnectionState) -> Self {
        Self {
            inner: Arc::new(StatusInner {
                state: Mutex::new(state),
                session_id: Mutex::new(None),
                last_error: Mutex::new(None),
                metrics: ChannelMetrics::default(),
            }),
        }
    }

    pub async fn set_state(&self, state: ConnectionState) {
        *self.inner.state.lock().await = state;
    }

    pub async fn state(&self) -> ConnectionState {
        *self.inner.state.lock().await
    }

    pub async fn set_session(&self, session_id: Option<String>) {
        *self.inner.session_id.lock().await = session_id;
    }

    pub async fn set_error(&self, error: Option<String>) {
        *self.inner.last_error.lock().await = error;
    }

    pub fn metrics(&self) -> &ChannelMetrics {
        &self.inner.metrics
    }

    /// Safe diagnostic snapshot. Carries no payloads, paths, or credentials.
    pub async fn snapshot(&self) -> Value {
        json!({
            "state": self.state().await.as_str(),
            "session_id": *self.inner.session_id.lock().await,
            "last_error": *self.inner.last_error.lock().await,
            "metrics": self.inner.metrics.snapshot(),
        })
    }
}

// ------------------------------------------------------------ URL policy

/// Whether a host is loopback, the only place plaintext is ever tolerated.
pub fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(v4)) => v4.is_loopback(),
        Ok(std::net::IpAddr::V6(v6)) => v6.is_loopback(),
        Err(_) => false,
    }
}

/// Split a URL into scheme, host, and the rest. Deliberately minimal — enough
/// to enforce transport policy without pulling in a URL parser.
fn split_url(url: &str) -> Result<(String, String)> {
    let (scheme, rest) = url
        .split_once("://")
        .context("Control Plane URL must include a scheme")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = match authority.rfind(':') {
        // Keep bracketed IPv6 literals intact.
        Some(index) if !authority[index + 1..].contains(']') => &authority[..index],
        _ => authority,
    };
    if host.is_empty() {
        bail!("Control Plane URL must include a host");
    }
    Ok((scheme.to_ascii_lowercase(), host.to_owned()))
}

/// Enforce transport security.
///
/// TLS is mandatory. Plaintext is permitted only for a loopback host **and**
/// only when development mode was explicitly enabled — it can never be turned
/// on implicitly, and never for a remote address.
pub fn validate_control_plane_url(url: &str, allow_plaintext_loopback: bool) -> Result<()> {
    let (scheme, host) = split_url(url)?;
    match scheme.as_str() {
        "https" | "wss" => Ok(()),
        "http" | "ws" => {
            if !allow_plaintext_loopback {
                bail!(
                    "plaintext {scheme}:// is refused; use https:// or wss://. \
                     Set development.allow_plaintext_loopback for loopback testing."
                );
            }
            if !is_loopback_host(&host) {
                bail!("plaintext {scheme}:// is only permitted for loopback hosts, not {host}");
            }
            Ok(())
        }
        other => bail!("unsupported Control Plane URL scheme {other:?}"),
    }
}

/// Derive the WebSocket URL from the configured base URL.
pub fn websocket_url(base: &str) -> Result<String> {
    let (scheme, _) = split_url(base)?;
    let websocket_scheme = match scheme.as_str() {
        "https" | "wss" => "wss",
        "http" | "ws" => "ws",
        other => bail!("unsupported scheme {other:?}"),
    };
    let rest = base.split_once("://").map(|(_, rest)| rest).unwrap_or(base);
    let trimmed = rest.trim_end_matches('/');
    Ok(format!("{websocket_scheme}://{trimmed}/v1/node/session"))
}

pub fn enrollment_url(base: &str) -> Result<String> {
    let (scheme, _) = split_url(base)?;
    let http_scheme = match scheme.as_str() {
        "https" | "wss" => "https",
        "http" | "ws" => "http",
        other => bail!("unsupported scheme {other:?}"),
    };
    let rest = base.split_once("://").map(|(_, rest)| rest).unwrap_or(base);
    let trimmed = rest.trim_end_matches('/');
    Ok(format!("{http_scheme}://{trimmed}/v1/node/enroll"))
}

// ------------------------------------------------------------- enrollment

#[derive(Debug, Clone)]
pub struct EnrollmentOutcome {
    pub node_id: String,
    pub protocol_version: u16,
    pub server_metadata: Value,
}

/// Perform one-time enrollment.
///
/// The token travels in an `Authorization` header, is used exactly once, and is
/// never written to disk — only the assigned `node_id` is persisted.
pub async fn enroll(
    identity: &mut NodeIdentity,
    control_plane_url: &str,
    token: &str,
    display_name: &str,
    allow_plaintext_loopback: bool,
) -> Result<EnrollmentOutcome> {
    if identity.metadata().is_enrolled() {
        bail!(
            "this Node is already enrolled as {}; re-enrolment requires an explicit reset",
            identity.node_id().unwrap_or("unknown")
        );
    }
    submit_identity(
        identity,
        control_plane_url,
        token,
        display_name,
        allow_plaintext_loopback,
    )
    .await
}

/// Present a replacement key for an already-enrolled Node.
///
/// Identical on the wire to enrollment — the Control Plane distinguishes the two
/// by the token's purpose — but it deliberately skips the "already enrolled"
/// guard, because being enrolled is the precondition rather than the obstacle.
pub async fn rotate(
    identity: &mut NodeIdentity,
    control_plane_url: &str,
    token: &str,
    display_name: &str,
    allow_plaintext_loopback: bool,
) -> Result<EnrollmentOutcome> {
    submit_identity(
        identity,
        control_plane_url,
        token,
        display_name,
        allow_plaintext_loopback,
    )
    .await
}

async fn submit_identity(
    identity: &mut NodeIdentity,
    control_plane_url: &str,
    token: &str,
    display_name: &str,
    allow_plaintext_loopback: bool,
) -> Result<EnrollmentOutcome> {
    validate_control_plane_url(control_plane_url, allow_plaintext_loopback)?;
    if token.trim().is_empty() {
        bail!("the enrollment token is empty");
    }

    let endpoint = enrollment_url(control_plane_url)?;
    // reqwest verifies server certificates through the platform trust store by
    // default; nothing here weakens that.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;

    let response = client
        .post(&endpoint)
        .header("Authorization", format!("Bearer {}", token.trim()))
        .json(&json!({
            "public_key": identity.public_key_base64(),
            "public_key_fingerprint": identity.fingerprint(),
            "display_name": display_name,
            "supported_protocol_versions": protocol::SUPPORTED_VERSIONS,
            "software_version": SOFTWARE_VERSION,
        }))
        .send()
        .await
        .with_context(|| format!("failed to reach the enrollment endpoint {endpoint}"))?;

    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        bail!(
            "enrollment was refused ({}): {}",
            status.as_u16(),
            body.get("message")
                .and_then(Value::as_str)
                .unwrap_or("no message")
        );
    }

    let node_id = body
        .get("node_id")
        .and_then(Value::as_str)
        .context("the Control Plane did not return a node_id")?
        .to_owned();
    let protocol_version = body
        .get("protocol_version")
        .and_then(Value::as_u64)
        .unwrap_or(u64::from(protocol::PROTOCOL_VERSION)) as u16;

    identity.record_enrollment(&node_id, control_plane_url)?;

    Ok(EnrollmentOutcome {
        node_id,
        protocol_version,
        server_metadata: body.get("server_metadata").cloned().unwrap_or(Value::Null),
    })
}

// --------------------------------------------------------------- backoff

/// Delay before reconnect attempt `attempt` (0-based), with bounded jitter.
///
/// Pure so the growth and the ceiling can be asserted directly.
pub fn backoff_delay(attempt: u32, config: &crate::nodehome::ReconnectConfig) -> Duration {
    let exponent = attempt.min(16);
    let base = config
        .initial_backoff_ms
        .saturating_mul(1u64 << exponent)
        .min(config.max_backoff_ms);

    let jitter = config.jitter.clamp(0.0, 1.0);
    if jitter == 0.0 {
        return Duration::from_millis(base);
    }

    let mut bytes = [0u8; 8];
    let _ = getrandom::getrandom(&mut bytes);
    let fraction = (u64::from_le_bytes(bytes) % 10_000) as f64 / 10_000.0;
    // Jitter only ever shortens the delay, so the ceiling always holds.
    let scaled = base as f64 * (1.0 - jitter * fraction);
    Duration::from_millis(scaled.max(1.0) as u64)
}

// ------------------------------------------------------------ the channel

/// Everything the control channel needs.
pub struct ControlChannel {
    pub service: NodeService,
    pub node_home: std::path::PathBuf,
    pub config: NodeConfig,
    pub status: ChannelStatus,
}

impl ControlChannel {
    /// Maintain the session until `shutdown` resolves.
    ///
    /// Every failure is a reconnect, never a crash: a Control Plane that is
    /// down, unreachable, or misbehaving must not take the daemon with it.
    pub async fn run(self, mut shutdown: tokio::sync::watch::Receiver<bool>) {
        let Some(base_url) = self.config.control_plane_url.clone() else {
            self.status.set_state(ConnectionState::Disabled).await;
            return;
        };

        let identity = match NodeIdentity::load(&self.node_home) {
            Ok(identity) => identity,
            Err(error) => {
                self.status.set_state(ConnectionState::Failed).await;
                self.status.set_error(Some(error.to_string())).await;
                return;
            }
        };
        if !identity.metadata().is_enrolled() {
            self.status.set_state(ConnectionState::Unenrolled).await;
            return;
        }
        if let Err(error) =
            validate_control_plane_url(&base_url, self.config.development.allow_plaintext_loopback)
        {
            self.status.set_state(ConnectionState::Failed).await;
            self.status.set_error(Some(error.to_string())).await;
            crate::daemon::log_event(
                "control.configuration_rejected",
                json!({"error": error.to_string()}),
            );
            return;
        }

        let mut attempt: u32 = 0;
        loop {
            if *shutdown.borrow() {
                self.status.set_state(ConnectionState::Draining).await;
                return;
            }

            self.status.set_state(ConnectionState::Connecting).await;
            ChannelMetrics::bump(&self.status.metrics().connection_attempts);
            let started = std::time::Instant::now();

            match self.session(&base_url, &identity, &mut shutdown).await {
                Ok(()) => {}
                Err(error) => {
                    self.status.set_error(Some(error.to_string())).await;
                    crate::daemon::log_event(
                        "control.session_ended",
                        json!({"error": error.to_string()}),
                    );
                }
            }

            if *shutdown.borrow() {
                self.status.set_state(ConnectionState::Draining).await;
                return;
            }

            // A session that stayed up long enough is evidence the endpoint is
            // healthy, so the next failure starts from the shortest delay again.
            if started.elapsed() >= Duration::from_millis(self.config.reconnect.stable_session_ms) {
                attempt = 0;
            }

            let delay = backoff_delay(attempt, &self.config.reconnect);
            attempt = attempt.saturating_add(1);
            self.status.set_state(ConnectionState::BackingOff).await;
            self.status.set_session(None).await;

            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                _ = shutdown.changed() => {}
            }
        }
    }

    /// One connect → handshake → serve cycle.
    async fn session(
        &self,
        base_url: &str,
        identity: &NodeIdentity,
        shutdown: &mut tokio::sync::watch::Receiver<bool>,
    ) -> Result<()> {
        let url = websocket_url(base_url)?;
        let (mut socket, _) = tokio_tungstenite::connect_async(&url)
            .await
            .with_context(|| format!("failed to connect to {url}"))?;

        self.status.set_state(ConnectionState::Authenticating).await;
        let capabilities = self.service.capabilities().await;
        let capabilities_digest = protocol::digest_json(&capabilities);
        let client_nonce = protocol::new_nonce();
        let node_id = identity.node_id().unwrap_or_default().to_owned();
        let instance_id = self.service.instance_id().to_owned();

        let hello = ClientHello {
            supported_versions: protocol::SUPPORTED_VERSIONS.to_vec(),
            node_id: node_id.clone(),
            instance_id: instance_id.clone(),
            public_key_fingerprint: identity.fingerprint().to_owned(),
            client_nonce: client_nonce.clone(),
            capabilities_digest: capabilities_digest.clone(),
            software_version: SOFTWARE_VERSION.to_owned(),
        };
        send(
            &mut socket,
            Envelope::new(message_types::CLIENT_HELLO, serde_json::to_value(&hello)?),
        )
        .await?;

        let challenge_frame = expect_message(&mut socket, message_types::SERVER_CHALLENGE).await?;
        let challenge: ServerChallenge = serde_json::from_value(challenge_frame.payload)
            .context("malformed server.challenge")?;

        let transcript = protocol::auth_transcript(&AuthTranscriptInput {
            protocol_version: challenge.protocol_version,
            node_id: &node_id,
            instance_id: &instance_id,
            session_id: &challenge.session_id,
            client_nonce: &client_nonce,
            server_nonce: &challenge.server_nonce,
            issued_at: challenge.issued_at,
            expires_at: challenge.expires_at,
            capabilities_digest: &capabilities_digest,
        });
        send(
            &mut socket,
            Envelope::new(
                message_types::CLIENT_AUTHENTICATE,
                json!({
                    "session_id": challenge.session_id,
                    "signature": identity.sign(&transcript),
                }),
            ),
        )
        .await?;

        let ready_frame = match expect_message(&mut socket, message_types::SERVER_READY).await {
            Ok(frame) => frame,
            Err(error) => {
                ChannelMetrics::bump(&self.status.metrics().authentication_failures);
                return Err(error);
            }
        };
        let ready: ServerReady =
            serde_json::from_value(ready_frame.payload).context("malformed server.ready")?;

        self.status.set_state(ConnectionState::Connected).await;
        self.status
            .set_session(Some(ready.session_id.clone()))
            .await;
        self.status.set_error(None).await;
        ChannelMetrics::bump(&self.status.metrics().sessions_established);
        crate::daemon::log_event(
            "control.session_established",
            json!({
                "session_id": ready.session_id,
                "protocol_version": ready.protocol_version,
            }),
        );

        self.serve(socket, shutdown).await
    }

    /// Serve one authenticated session.
    async fn serve(
        &self,
        mut socket: WebSocket,
        shutdown: &mut tokio::sync::watch::Receiver<bool>,
    ) -> Result<()> {
        // Anything unacknowledged from a previous session goes out first.
        self.flush_outbox(&mut socket).await?;

        let heartbeat_interval = Duration::from_millis(self.config.heartbeat.interval_ms.max(1000));
        let mut heartbeat = tokio::time::interval(heartbeat_interval);
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut pump = tokio::time::interval(Duration::from_millis(250));
        // Monotonic: local timeout decisions never depend on wall-clock jumps.
        let mut last_pong = std::time::Instant::now();
        let missed_limit = u32::max(self.config.heartbeat.missed_limit, 1);

        loop {
            tokio::select! {
                biased;

                _ = shutdown.changed() => {
                    let _ = socket.close(None).await;
                    return Ok(());
                }

                incoming = socket.next() => {
                    match incoming {
                        Some(Ok(Message::Text(text))) => {
                            last_pong = std::time::Instant::now();
                            self.handle_frame(&mut socket, &text).await?;
                        }
                        Some(Ok(Message::Ping(payload))) => {
                            socket.send(Message::Pong(payload)).await?;
                        }
                        Some(Ok(Message::Pong(_))) => last_pong = std::time::Instant::now(),
                        Some(Ok(Message::Close(_))) | None => {
                            bail!("the Control Plane closed the session");
                        }
                        Some(Ok(_)) => {}
                        Some(Err(error)) => bail!("websocket error: {error}"),
                    }
                }

                _ = heartbeat.tick() => {
                    let elapsed = last_pong.elapsed();
                    if elapsed > heartbeat_interval * missed_limit {
                        ChannelMetrics::bump(&self.status.metrics().heartbeat_timeouts);
                        bail!("no Control Plane traffic for {elapsed:?}; dropping the session");
                    }
                    send(&mut socket, Envelope::new(
                        message_types::CLIENT_HEARTBEAT,
                        self.heartbeat_payload().await,
                    )).await?;
                }

                _ = pump.tick() => {
                    self.pump_subscriptions(&mut socket).await?;
                    self.flush_outbox(&mut socket).await?;
                }
            }
        }
    }

    /// Safe liveness summary. No paths, environments, prompts, or payloads.
    async fn heartbeat_payload(&self) -> Value {
        let registry = Registry::open(self.service.state_root());
        let projects = registry
            .as_ref()
            .ok()
            .and_then(|registry| registry.list_projects().ok())
            .map(|projects| projects.len())
            .unwrap_or(0);

        json!({
            "instance_id": self.service.instance_id(),
            "connection_state": self.status.state().await.as_str(),
            "registered_projects": projects,
            "active_runs": self.service.active_worker_count().await,
            "draining": self.service.is_draining(),
            "software_version": SOFTWARE_VERSION,
        })
    }

    async fn handle_frame(&self, socket: &mut WebSocket, text: &str) -> Result<()> {
        let envelope = match Envelope::decode(text) {
            Ok(envelope) => envelope,
            Err(error) => {
                ChannelMetrics::bump(&self.status.metrics().protocol_errors);
                send(socket, error.into_envelope(None)).await?;
                return Ok(());
            }
        };

        match envelope.message_type.as_str() {
            message_types::SERVER_HEARTBEAT_ACK => Ok(()),
            message_types::SERVER_COMMAND => self.handle_command(socket, envelope).await,
            message_types::SERVER_COMMAND_RESULT_ACK => {
                if let Some(command_id) = envelope.payload.get("command_id").and_then(Value::as_str)
                {
                    let mut registry = Registry::open(self.service.state_root())?;
                    registry.acknowledge_outbox_correlation(command_id)?;
                }
                Ok(())
            }
            message_types::SERVER_EVENT_ACK => {
                let ack: EventAck = serde_json::from_value(envelope.payload.clone())
                    .context("malformed server.event.ack")?;
                let mut registry = Registry::open(self.service.state_root())?;
                registry.acknowledge_events(&ack.run_id, ack.acked_seq)?;
                Ok(())
            }
            message_types::ERROR => {
                ChannelMetrics::bump(&self.status.metrics().protocol_errors);
                let code = envelope
                    .payload
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let message = envelope
                    .payload
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("no detail");
                bail!("the Control Plane reported protocol error {code}: {message}")
            }
            other => {
                ChannelMetrics::bump(&self.status.metrics().protocol_errors);
                send(
                    socket,
                    ProtocolError::new(
                        ErrorCode::UnknownMessageType,
                        format!("unsupported message type {other:?}"),
                    )
                    .into_envelope(Some(envelope.message_id)),
                )
                .await
            }
        }
    }

    /// Admit, execute, and durably answer one remote command.
    async fn handle_command(&self, socket: &mut WebSocket, envelope: Envelope) -> Result<()> {
        ChannelMetrics::bump(&self.status.metrics().commands_received);
        let correlation = envelope.message_id.clone();

        let command: RemoteCommand = match serde_json::from_value(envelope.payload.clone()) {
            Ok(command) => command,
            Err(error) => {
                ChannelMetrics::bump(&self.status.metrics().commands_rejected);
                return send(
                    socket,
                    ProtocolError::new(
                        ErrorCode::MalformedFrame,
                        format!("malformed command: {error}"),
                    )
                    .into_envelope(Some(correlation)),
                )
                .await;
            }
        };

        if let Err(error) = command.validate() {
            ChannelMetrics::bump(&self.status.metrics().commands_rejected);
            return send(socket, error.into_envelope(Some(correlation))).await;
        }

        let digest = command.fingerprint();
        let mut registry = Registry::open(self.service.state_root())?;

        // Fail closed: never accept work whose result could not be reported.
        if registry.outbox_depth()? >= crate::remote::MAX_OUTBOX_DEPTH {
            ChannelMetrics::bump(&self.status.metrics().commands_rejected);
            return send(
                socket,
                ProtocolError::new(
                    ErrorCode::Internal,
                    "the response outbox is full; refusing new commands",
                )
                .into_envelope(Some(correlation)),
            )
            .await;
        }

        let admission = registry.admit_remote_command(
            &command.command_id,
            &command.command,
            command.project_id.as_deref(),
            &digest,
        )?;

        match admission {
            CommandAdmission::PayloadMismatch { .. } => {
                ChannelMetrics::bump(&self.status.metrics().commands_rejected);
                return send(
                    socket,
                    ProtocolError::new(
                        ErrorCode::DuplicatePayloadMismatch,
                        "this command id was already used with a different payload",
                    )
                    .into_envelope(Some(correlation)),
                )
                .await;
            }
            CommandAdmission::Duplicate(record) => {
                // At-most-once: replay the stored outcome, never re-execute.
                ChannelMetrics::bump(&self.status.metrics().commands_duplicate);
                let result = json!({
                    "command_id": record.command_id,
                    "state": record.state,
                    "result": record.response_payload,
                    "error_code": record.error_code,
                    "error_message": record.error_message,
                    "deduplicated": true,
                });
                registry.enqueue_outbox(
                    OUTBOX_COMMAND_RESULT,
                    Some(&record.command_id),
                    &result,
                )?;
                drop(registry);
                return self.flush_outbox(socket).await;
            }
            CommandAdmission::Fresh(_) => {}
        }

        send(
            socket,
            Envelope::new(
                message_types::CLIENT_COMMAND_ACCEPTED,
                json!({"command_id": command.command_id}),
            )
            .correlate(correlation.clone()),
        )
        .await?;
        registry.set_remote_command_state(&command.command_id, CommandState::Executing)?;
        drop(registry);

        let outcome = self.execute(&command).await;
        let mut registry = Registry::open(self.service.state_root())?;
        let record = match &outcome {
            Ok(value) => registry.complete_remote_command(
                &command.command_id,
                CommandState::Completed,
                Some(value),
                None,
                None,
            )?,
            Err(error) => registry.complete_remote_command(
                &command.command_id,
                CommandState::Failed,
                None,
                Some(error.code.as_str()),
                Some(&error.message),
            )?,
        };

        let result = json!({
            "command_id": record.command_id,
            "state": record.state,
            "result": record.response_payload,
            "error_code": record.error_code,
            "error_message": record.error_message,
        });
        // Persisted before it is sent, so a disconnect cannot lose the answer.
        registry.enqueue_outbox(OUTBOX_COMMAND_RESULT, Some(&record.command_id), &result)?;
        drop(registry);
        self.flush_outbox(socket).await
    }

    /// Execute one command through `NodeService`.
    ///
    /// Every path goes through the same service the local API uses, so a remote
    /// caller cannot bypass single-flight, runtime policy, or state validation.
    /// Build a project: workspace, Hermes home, worker, health check.
    ///
    /// Every step is idempotent, because a command may be delivered more than
    /// once and a retry runs the same path: a completed workspace is reused
    /// rather than cloned again, a complete profile home is reused rather than
    /// rebuilt, and a reserved port is kept rather than reallocated.
    ///
    /// The project becomes ready here only after its own worker answers an
    /// authenticated health check. Nothing earlier is evidence: a directory, a
    /// registry row and an active unit all exist before anything can serve a run.
    async fn provision_project(
        &self,
        command: &RemoteCommand,
    ) -> std::result::Result<Value, ProtocolError> {
        use crate::provisioning::{WorkspaceMode, prepare_workspace};

        let field = |name: &str| -> Option<&str> {
            command.payload.get(name).and_then(|value| value.as_str())
        };
        let version = command
            .payload
            .get("version")
            .and_then(|value| value.as_u64())
            .unwrap_or(0);
        // An unknown newer version is refused rather than interpreted: guessing
        // what a future field means is how a project ends up built wrong.
        if version != 1 {
            return Err(ProtocolError::new(
                ErrorCode::CommandFailed,
                format!("unsupported project.provision version {version}"),
            ));
        }

        let project_id = field("project_id").ok_or_else(|| {
            ProtocolError::new(ErrorCode::CommandFailed, "project_id is required")
        })?;
        let generation = command
            .payload
            .get("provisioning_generation")
            .and_then(|value| value.as_u64())
            .unwrap_or(0);
        let mode_text = field("workspace_mode").unwrap_or("empty");
        let mode = WorkspaceMode::parse(mode_text)
            .map_err(|error| ProtocolError::new(ErrorCode::CommandFailed, error.to_string()))?;

        let failed = |failure: crate::provisioning::ProvisionFailure, message: &str| {
            json!({
                "outcome": "failed",
                "event_version": 1,
                "project_id": project_id,
                "provisioning_generation": generation,
                "failure": failure.as_str(),
                // Sanitized by construction: the Node never forwards git's own
                // text, which routinely carries the remote URL.
                "message": message,
            })
        };

        let settings = crate::provisioning::WorkspaceSettings::default();
        let workspace = match prepare_workspace(
            &settings,
            project_id,
            &mode,
            field("repository_url"),
            field("branch"),
        ) {
            Ok(workspace) => workspace,
            Err((failure, message)) => return Ok(failed(failure, &message)),
        };

        // Registered before the profile is built, so the Hermes home is created
        // against a workspace the Node has already committed to.
        {
            let mut registry = Registry::open(self.service.state_root())
                .map_err(|error| ProtocolError::new(ErrorCode::Internal, error.to_string()))?;
            if registry
                .project(project_id)
                .map_err(|error| ProtocolError::new(ErrorCode::Internal, error.to_string()))?
                .is_none()
                && let Err(error) = registry.register_project(
                    project_id,
                    &workspace.path,
                    None,
                    None,
                    None,
                    crate::inventory::RuntimeOwnership::External,
                )
            {
                return Ok(failed(
                    crate::provisioning::ProvisionFailure::ProjectInventoryConflict,
                    &error.to_string(),
                ));
            }
        }

        Ok(json!({
            "outcome": "workspace_ready",
            "event_version": 1,
            "project_id": project_id,
            "provisioning_generation": generation,
            "workspace_mode": mode.as_str(),
            "runtime_kind": "hermes_home",
            "workspace_created": workspace.created,
        }))
    }

    async fn execute(&self, command: &RemoteCommand) -> std::result::Result<Value, ProtocolError> {
        // Provisioning is the one command whose project does not exist yet, so
        // it runs before the resolution below rather than being refused by it.
        if command.command == "project.provision" {
            return self.provision_project(command).await;
        }

        let project = match &command.project_id {
            Some(project_id) => {
                let registry = Registry::open(self.service.state_root())
                    .map_err(|error| ProtocolError::new(ErrorCode::Internal, error.to_string()))?;
                let resolved = registry
                    .resolve_remote_project(project_id)
                    .map_err(|error| ProtocolError::new(ErrorCode::Internal, error.to_string()))?;
                match resolved {
                    Some(project) => Some(project),
                    None => {
                        return Err(ProtocolError::new(
                            ErrorCode::ProjectNotRegistered,
                            format!("project {project_id:?} is not registered on this Node"),
                        ));
                    }
                }
            }
            None => None,
        };

        let service_error = |error: crate::service::ServiceError| {
            ProtocolError::new(
                ErrorCode::CommandFailed,
                format!("{}: {}", error.code(), error.public_message()),
            )
        };

        match command.command.as_str() {
            "capabilities.get" => Ok(self.service.capabilities().await),
            "projects.list" => {
                let registry = Registry::open(self.service.state_root())
                    .map_err(|error| ProtocolError::new(ErrorCode::Internal, error.to_string()))?;
                let projects = registry
                    .list_projects()
                    .map_err(|error| ProtocolError::new(ErrorCode::Internal, error.to_string()))?;
                Ok(json!({
                    "projects": projects
                        .iter()
                        .map(|project| project.remote_view())
                        .collect::<Vec<_>>()
                }))
            }
            "runs.create" => {
                let project = project.expect("runs.create requires a project");
                let input = command
                    .payload
                    .get("input")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ProtocolError::new(ErrorCode::MalformedFrame, "input is required")
                    })?;
                let created = self
                    .service
                    .create_run(
                        &project.project_id,
                        CreateRun {
                            input: input.to_owned(),
                            session_id: string_field(&command.payload, "session_id"),
                            instructions: string_field(&command.payload, "instructions"),
                            idempotency_key: string_field(&command.payload, "idempotency_key"),
                            approval_policy: match string_field(&command.payload, "approval_policy")
                            {
                                None => None,
                                Some(value) => {
                                    Some(RunApprovalPolicy::parse(&value).map_err(|error| {
                                        ProtocolError::new(
                                            ErrorCode::MalformedFrame,
                                            error.to_string(),
                                        )
                                    })?)
                                }
                            },
                            actor: string_field(&command.payload, "actor"),
                            attachments: crate::attachments::parse(
                                command.payload.get("attachments"),
                            )
                            .map_err(|error| {
                                ProtocolError::new(ErrorCode::MalformedFrame, error.to_string())
                            })?,
                        },
                    )
                    .await
                    .map_err(service_error)?;
                Ok(json!({
                    "run_id": created.run.run_id,
                    "status": created.run.status,
                    "idempotent_replay": created.idempotent_replay,
                }))
            }
            "runs.approval_policy" => {
                let project = project.expect("runs.approval_policy requires a project");
                let run_id = command
                    .payload
                    .get("run_id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ProtocolError::new(ErrorCode::MalformedFrame, "run_id is required")
                    })?;
                let policy = command
                    .payload
                    .get("policy")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ProtocolError::new(ErrorCode::MalformedFrame, "policy is required")
                    })?;
                // An unknown policy is refused at the boundary; nothing
                // downstream has to decide what an unrecognised value means.
                let policy = RunApprovalPolicy::parse(policy).map_err(|error| {
                    ProtocolError::new(ErrorCode::MalformedFrame, error.to_string())
                })?;
                let outcome = self
                    .service
                    .set_run_approval_policy(
                        &project.project_id,
                        run_id,
                        policy,
                        string_field(&command.payload, "actor").as_deref(),
                    )
                    .await
                    .map_err(service_error)?;
                Ok(outcome)
            }
            "runs.list" => {
                let project = project.expect("runs.list requires a project");
                let limit = command
                    .payload
                    .get("limit")
                    .and_then(Value::as_i64)
                    .unwrap_or(50);
                let runs = self
                    .service
                    .list_runs(&project.project_id, limit)
                    .await
                    .map_err(service_error)?;
                Ok(json!({"runs": runs}))
            }
            "runs.get" => {
                let project = project.expect("runs.get requires a project");
                let run_id = required_str(&command.payload, "run_id")?;
                let record = self
                    .service
                    .get_run(&project.project_id, &run_id)
                    .await
                    .map_err(service_error)?;
                Ok(json!({"run": record}))
            }
            "runs.cancel" => {
                let project = project.expect("runs.cancel requires a project");
                let run_id = required_str(&command.payload, "run_id")?;
                self.service
                    .cancel_run(&project.project_id, &run_id)
                    .await
                    .map_err(service_error)
            }
            "runs.retry" => {
                let project = project.expect("runs.retry requires a project");
                let run_id = required_str(&command.payload, "run_id")?;
                let created = self
                    .service
                    .retry_run(&project.project_id, &run_id)
                    .await
                    .map_err(service_error)?;
                Ok(json!({
                    "run_id": created.run.run_id,
                    "retry_of_run_id": created.run.retry_of_run_id,
                }))
            }
            "approvals.resolve" => {
                let project = project.expect("approvals.resolve requires a project");
                let run_id = required_str(&command.payload, "run_id")?;
                let choice = required_str(&command.payload, "choice")?;
                self.service
                    .resolve_approval(&project.project_id, &run_id, &choice)
                    .await
                    .map_err(service_error)
            }
            "events.subscribe" => {
                let project = project.expect("events.subscribe requires a project");
                let request: SubscribeRequest = serde_json::from_value(json!({
                    "project_id": project.project_id,
                    "run_id": required_str(&command.payload, "run_id")?,
                    "from_seq": command.payload.get("from_seq").and_then(Value::as_i64).unwrap_or(0),
                }))
                .map_err(|error| {
                    ProtocolError::new(ErrorCode::MalformedFrame, error.to_string())
                })?;

                // Confirms the run exists and belongs to the project before any
                // subscription state is created.
                self.service
                    .get_run(&request.project_id, &request.run_id)
                    .await
                    .map_err(service_error)?;

                let mut registry = Registry::open(self.service.state_root())
                    .map_err(|error| ProtocolError::new(ErrorCode::Internal, error.to_string()))?;
                let subscription = registry
                    .upsert_subscription(&request.project_id, &request.run_id, request.from_seq)
                    .map_err(|error| ProtocolError::new(ErrorCode::Internal, error.to_string()))?;
                Ok(
                    json!({"subscribed": true, "run_id": subscription.run_id, "acked_seq": subscription.acked_seq}),
                )
            }
            "events.unsubscribe" => {
                let run_id = required_str(&command.payload, "run_id")?;
                let mut registry = Registry::open(self.service.state_root())
                    .map_err(|error| ProtocolError::new(ErrorCode::Internal, error.to_string()))?;
                registry
                    .remove_subscription(&run_id)
                    .map_err(|error| ProtocolError::new(ErrorCode::Internal, error.to_string()))?;
                Ok(json!({"unsubscribed": true, "run_id": run_id}))
            }
            "node.drain" => {
                // Stops new work. It cannot stop the daemon, Docker, or the host.
                self.service.begin_drain();
                self.status.set_state(ConnectionState::Draining).await;
                Ok(json!({
                    "draining": true,
                    "active_runs": self.service.active_worker_count().await,
                }))
            }
            other => Err(ProtocolError::new(
                ErrorCode::UnknownCommand,
                format!("command {other:?} is not implemented"),
            )),
        }
    }

    /// Send journal events for every subscription, strictly after its cursor.
    ///
    /// Reads SQLite directly, so nothing is lost to an in-memory queue and a
    /// slow Control Plane can never block a run: the worker writes to the
    /// journal and this pump lags behind at its own pace.
    async fn pump_subscriptions(&self, socket: &mut WebSocket) -> Result<()> {
        let registry = Registry::open(self.service.state_root())?;
        let subscriptions = registry.subscriptions()?;

        for subscription in subscriptions {
            // Bounded per pass: a long backlog is drained across iterations
            // rather than buffered whole.
            let events =
                registry.events_since(&subscription.run_id, subscription.acked_seq, 128)?;
            for event in events {
                let delivery = json!({
                    "project_id": subscription.project_id,
                    "run_id": event.run_id,
                    "seq": event.seq,
                    "event_type": event.event_type,
                    "recorded_at": event.recorded_at,
                    "payload": event.payload,
                });
                send(socket, Envelope::new(message_types::CLIENT_EVENT, delivery)).await?;
                ChannelMetrics::bump(&self.status.metrics().events_sent);
            }
        }
        Ok(())
    }

    /// Resend everything the Control Plane has not acknowledged.
    async fn flush_outbox(&self, socket: &mut WebSocket) -> Result<()> {
        let registry = Registry::open(self.service.state_root())?;
        let pending = registry.pending_outbox(64)?;
        drop(registry);

        for entry in pending {
            let mut envelope = Envelope::new(message_types::CLIENT_COMMAND_RESULT, entry.payload);
            if let Some(correlation) = entry.correlation_id {
                envelope = envelope.correlate(correlation);
            }
            send(socket, envelope).await?;
            ChannelMetrics::bump(&self.status.metrics().responses_retransmitted);
        }
        Ok(())
    }
}

fn string_field(payload: &Value, name: &str) -> Option<String> {
    payload
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn required_str(payload: &Value, name: &str) -> std::result::Result<String, ProtocolError> {
    payload
        .get(name)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| ProtocolError::new(ErrorCode::MalformedFrame, format!("{name} is required")))
}

type WebSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn send(socket: &mut WebSocket, envelope: Envelope) -> Result<()> {
    socket.send(Message::Text(envelope.encode()?)).await?;
    Ok(())
}

async fn expect_message(socket: &mut WebSocket, expected: &str) -> Result<Envelope> {
    loop {
        match socket.next().await {
            Some(Ok(Message::Text(text))) => {
                let envelope =
                    Envelope::decode(&text).map_err(|error| anyhow::anyhow!("{error}"))?;
                if envelope.message_type == expected {
                    return Ok(envelope);
                }
                if envelope.message_type == message_types::ERROR {
                    bail!(
                        "the Control Plane rejected the handshake: {}",
                        envelope.payload
                    );
                }
                // Ignore anything else while the handshake is in progress.
            }
            Some(Ok(Message::Ping(payload))) => socket.send(Message::Pong(payload)).await?,
            Some(Ok(_)) => {}
            Some(Err(error)) => bail!("websocket error during handshake: {error}"),
            None => bail!("the Control Plane closed the connection during the handshake"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nodehome::ReconnectConfig;

    #[test]
    fn tls_is_required_for_remote_endpoints() {
        assert!(validate_control_plane_url("https://control.example", false).is_ok());
        assert!(validate_control_plane_url("wss://control.example", false).is_ok());

        // Plaintext to a remote host is refused even in development mode.
        assert!(validate_control_plane_url("http://control.example", false).is_err());
        assert!(validate_control_plane_url("http://control.example", true).is_err());
        assert!(validate_control_plane_url("ws://10.0.0.5:8080", true).is_err());
    }

    #[test]
    fn plaintext_loopback_requires_an_explicit_opt_in() {
        // Never implicit.
        assert!(validate_control_plane_url("http://127.0.0.1:9000", false).is_err());
        // Explicitly enabled, loopback only.
        assert!(validate_control_plane_url("http://127.0.0.1:9000", true).is_ok());
        assert!(validate_control_plane_url("ws://localhost:9000", true).is_ok());
        assert!(validate_control_plane_url("ws://[::1]:9000", true).is_ok());
    }

    #[test]
    fn unsupported_or_malformed_urls_are_refused() {
        for bad in ["ftp://x", "control.example", "https://", "", "://nohost"] {
            assert!(
                validate_control_plane_url(bad, true).is_err(),
                "{bad:?} must be refused"
            );
        }
    }

    #[test]
    fn loopback_detection_covers_the_usual_spellings() {
        for host in [
            "127.0.0.1",
            "127.5.5.5",
            "localhost",
            "LOCALHOST",
            "::1",
            "[::1]",
        ] {
            assert!(is_loopback_host(host), "{host} should be loopback");
        }
        for host in ["example.com", "10.0.0.1", "0.0.0.0", "192.168.1.1"] {
            assert!(!is_loopback_host(host), "{host} should not be loopback");
        }
    }

    #[test]
    fn endpoint_urls_are_derived_from_the_base() {
        assert_eq!(
            websocket_url("https://control.example").unwrap(),
            "wss://control.example/v1/node/session"
        );
        assert_eq!(
            websocket_url("http://127.0.0.1:9000/").unwrap(),
            "ws://127.0.0.1:9000/v1/node/session"
        );
        assert_eq!(
            enrollment_url("https://control.example").unwrap(),
            "https://control.example/v1/node/enroll"
        );
    }

    #[test]
    fn backoff_grows_and_respects_its_ceiling() {
        let config = ReconnectConfig {
            initial_backoff_ms: 100,
            max_backoff_ms: 5_000,
            jitter: 0.0,
            stable_session_ms: 1_000,
        };

        assert_eq!(backoff_delay(0, &config), Duration::from_millis(100));
        assert_eq!(backoff_delay(1, &config), Duration::from_millis(200));
        assert_eq!(backoff_delay(2, &config), Duration::from_millis(400));
        // Ceiling holds, including for absurd attempt counts.
        assert_eq!(backoff_delay(30, &config), Duration::from_millis(5_000));
        assert_eq!(
            backoff_delay(u32::MAX, &config),
            Duration::from_millis(5_000)
        );
    }

    #[test]
    fn jitter_only_shortens_a_delay_so_the_ceiling_always_holds() {
        let config = ReconnectConfig {
            initial_backoff_ms: 1_000,
            max_backoff_ms: 4_000,
            jitter: 0.5,
            stable_session_ms: 1_000,
        };

        for attempt in 0..8 {
            let delay = backoff_delay(attempt, &config);
            assert!(delay <= Duration::from_millis(4_000), "{delay:?}");
            assert!(delay >= Duration::from_millis(1), "{delay:?}");
        }
    }

    #[test]
    fn connection_states_render_stably() {
        let states = [
            (ConnectionState::Disabled, "disabled"),
            (ConnectionState::Unenrolled, "unenrolled"),
            (ConnectionState::Connecting, "connecting"),
            (ConnectionState::Authenticating, "authenticating"),
            (ConnectionState::Connected, "connected"),
            (ConnectionState::BackingOff, "backing_off"),
            (ConnectionState::Draining, "draining"),
            (ConnectionState::Failed, "failed"),
        ];
        for (state, text) in states {
            assert_eq!(state.as_str(), text);
            // A remote problem never makes the local daemon unusable.
            assert!(state.is_healthy_for_local_use());
        }
    }

    #[tokio::test]
    async fn the_status_snapshot_carries_only_safe_fields() {
        let status = ChannelStatus::new(ConnectionState::Connected);
        status.set_session(Some("sess-1".to_owned())).await;
        ChannelMetrics::bump(&status.metrics().commands_received);

        let snapshot = status.snapshot().await;

        assert_eq!(snapshot["state"], json!("connected"));
        assert_eq!(snapshot["session_id"], json!("sess-1"));
        assert_eq!(snapshot["metrics"]["commands_received"], json!(1));
        let rendered = snapshot.to_string();
        for forbidden in ["token", "private", "authorization", "payload"] {
            assert!(!rendered.contains(forbidden), "{forbidden} must not appear");
        }
    }
}
