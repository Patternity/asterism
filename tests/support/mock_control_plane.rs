//! A **mock** Control Plane used only by integration tests.
//!
//! This is a test harness, not the production Control Plane and not a preview
//! of one. It implements exactly enough of the v1 protocol to exercise the
//! Node: one-time enrollment, the authentication handshake, remote commands,
//! event subscriptions and acknowledgements, and the adversarial behaviours the
//! Node must survive — intentional disconnects, malformed and oversized frames,
//! delayed acknowledgements, and replayed commands.
//!
//! It binds loopback only, and only while a test is running.

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::Arc;

use asterism_node::identity::verify_signature;
use asterism_node::protocol::{
    self, AuthTranscriptInput, ClientHello, Envelope, ErrorCode, ProtocolError, message_types,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex, mpsc};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;

/// What the mock observed, so tests can assert on protocol behaviour.
#[derive(Debug, Default)]
pub struct Observations {
    pub enrollments: Vec<String>,
    pub hellos: Vec<ClientHello>,
    pub authentications: usize,
    pub authentication_failures: usize,
    pub heartbeats: usize,
    pub command_results: Vec<Value>,
    pub events: Vec<Value>,
    pub protocol_errors: Vec<Value>,
}

/// Behaviour switches a test can flip to provoke the Node.
#[derive(Debug, Clone, Default)]
pub struct Behaviour {
    /// Close the socket after this many frames from the Node.
    pub disconnect_after_frames: Option<usize>,
    /// Send a challenge that already expired.
    pub expired_challenge: bool,
    /// Reuse the previous session's nonce, simulating a replay.
    pub replay_challenge: bool,
    /// Never acknowledge command results, so retransmission can be observed.
    pub withhold_result_acks: bool,
    /// Never acknowledge events.
    pub withhold_event_acks: bool,
    /// Send a malformed frame right after the handshake.
    pub send_malformed_frame: bool,
    /// Send an oversized frame right after the handshake.
    pub send_oversized_frame: bool,
    /// Refuse the signature even when it verifies, to test the failure path.
    pub reject_authentication: bool,
}

pub struct MockControlPlane {
    pub http_addr: std::net::SocketAddr,
    pub observations: Arc<Mutex<Observations>>,
    behaviour: Arc<Mutex<Behaviour>>,
    /// One-time enrollment tokens, consumed on first use.
    tokens: Arc<Mutex<HashMap<String, bool>>>,
    /// Public keys registered at enrollment, keyed by assigned node id.
    nodes: Arc<Mutex<HashMap<String, String>>>,
    /// Commands queued to push at the next opportunity.
    outgoing: Arc<Mutex<Vec<Value>>>,
    /// Fires when a session completes its handshake.
    connected_tx: mpsc::UnboundedSender<String>,
    connected_rx: Arc<Mutex<mpsc::UnboundedReceiver<String>>>,
    last_server_nonce: Arc<Mutex<Option<String>>>,
    _server: tokio::task::JoinHandle<()>,
}

impl MockControlPlane {
    /// Bind on loopback and start serving.
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let http_addr = listener.local_addr().unwrap();

        let observations = Arc::new(Mutex::new(Observations::default()));
        let behaviour = Arc::new(Mutex::new(Behaviour::default()));
        let tokens = Arc::new(Mutex::new(HashMap::new()));
        let nodes = Arc::new(Mutex::new(HashMap::new()));
        let outgoing = Arc::new(Mutex::new(Vec::new()));
        let last_server_nonce = Arc::new(Mutex::new(None));
        let (connected_tx, connected_rx) = mpsc::unbounded_channel();

        let state = ServerState {
            observations: Arc::clone(&observations),
            behaviour: Arc::clone(&behaviour),
            tokens: Arc::clone(&tokens),
            nodes: Arc::clone(&nodes),
            outgoing: Arc::clone(&outgoing),
            connected: connected_tx.clone(),
            last_server_nonce: Arc::clone(&last_server_nonce),
        };

        let server = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let state = state.clone();
                tokio::spawn(async move {
                    let _ = serve_connection(stream, state).await;
                });
            }
        });

        Self {
            http_addr,
            observations,
            behaviour,
            tokens,
            nodes,
            outgoing,
            connected_tx,
            connected_rx: Arc::new(Mutex::new(connected_rx)),
            last_server_nonce,
            _server: server,
        }
    }

    pub fn base_url(&self) -> String {
        format!("http://{}", self.http_addr)
    }

    /// Issue a one-time enrollment token.
    pub async fn issue_token(&self, token: &str) {
        self.tokens.lock().await.insert(token.to_owned(), false);
    }

    pub async fn set_behaviour(&self, behaviour: Behaviour) {
        *self.behaviour.lock().await = behaviour;
    }

    /// Queue a command for delivery on the active session.
    pub async fn push_command(
        &self,
        command_id: &str,
        command: &str,
        project_id: Option<&str>,
        payload: Value,
    ) {
        self.outgoing.lock().await.push(json!({
            "command_id": command_id,
            "command": command,
            "project_id": project_id,
            "payload": payload,
        }));
    }

    /// Wait until a session finishes its handshake.
    pub async fn wait_connected(&self, timeout: std::time::Duration) -> Option<String> {
        tokio::time::timeout(timeout, async {
            self.connected_rx.lock().await.recv().await
        })
        .await
        .ok()
        .flatten()
    }

    /// Wait for a command result with the given id.
    pub async fn wait_result(
        &self,
        command_id: &str,
        timeout: std::time::Duration,
    ) -> Option<Value> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            {
                let observed = self.observations.lock().await;
                if let Some(found) = observed
                    .command_results
                    .iter()
                    .find(|result| result["command_id"] == json!(command_id))
                {
                    return Some(found.clone());
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    /// Wait until at least `count` events have arrived for a run.
    pub async fn wait_events(
        &self,
        run_id: &str,
        count: usize,
        timeout: std::time::Duration,
    ) -> Vec<Value> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            {
                let observed = self.observations.lock().await;
                let matching: Vec<Value> = observed
                    .events
                    .iter()
                    .filter(|event| event["run_id"] == json!(run_id))
                    .cloned()
                    .collect();
                if matching.len() >= count {
                    return matching;
                }
            }
            if tokio::time::Instant::now() >= deadline {
                let observed = self.observations.lock().await;
                return observed
                    .events
                    .iter()
                    .filter(|event| event["run_id"] == json!(run_id))
                    .cloned()
                    .collect();
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    pub async fn registered_node_count(&self) -> usize {
        self.nodes.lock().await.len()
    }
}

#[derive(Clone)]
struct ServerState {
    observations: Arc<Mutex<Observations>>,
    behaviour: Arc<Mutex<Behaviour>>,
    tokens: Arc<Mutex<HashMap<String, bool>>>,
    nodes: Arc<Mutex<HashMap<String, String>>>,
    outgoing: Arc<Mutex<Vec<Value>>>,
    connected: mpsc::UnboundedSender<String>,
    last_server_nonce: Arc<Mutex<Option<String>>>,
}

/// Dispatch one TCP connection to either the enrollment endpoint or a session.
async fn serve_connection(stream: TcpStream, state: ServerState) -> anyhow::Result<()> {
    // Peek at the request line to decide without consuming the stream.
    let mut peeked = [0u8; 1024];
    let read = stream.peek(&mut peeked).await?;
    let head = String::from_utf8_lossy(&peeked[..read]).to_string();

    if head.starts_with("POST /v1/node/enroll") {
        return serve_enrollment(stream, state, head).await;
    }
    let websocket = tokio_tungstenite::accept_async(stream).await?;
    serve_session(websocket, state).await
}

async fn serve_enrollment(
    mut stream: TcpStream,
    state: ServerState,
    head: String,
) -> anyhow::Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let content_length = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())?
        })
        .unwrap_or(0);
    let header_len = head
        .find("\r\n\r\n")
        .map(|index| index + 4)
        .unwrap_or(head.len());

    let mut buffer = vec![0u8; header_len + content_length];
    stream.read_exact(&mut buffer).await?;
    let text = String::from_utf8_lossy(&buffer);
    let body_text = text.split("\r\n\r\n").nth(1).unwrap_or("{}");
    let body: Value = serde_json::from_str(body_text).unwrap_or(Value::Null);

    let token = text
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case("authorization")
                .then(|| value.trim().trim_start_matches("Bearer ").to_owned())
        })
        .unwrap_or_default();

    let mut tokens = state.tokens.lock().await;
    let (status, response) = match tokens.get(&token) {
        // One-time: a consumed token can never enroll a second Node.
        Some(true) | None => (
            401,
            json!({"message": "unknown or already-consumed enrollment token"}),
        ),
        Some(false) => {
            tokens.insert(token.clone(), true);
            let node_id = format!("node-{}", state.nodes.lock().await.len() + 1);
            let public_key = body
                .get("public_key")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            state.nodes.lock().await.insert(node_id.clone(), public_key);
            state
                .observations
                .lock()
                .await
                .enrollments
                .push(node_id.clone());
            (
                200,
                json!({
                    "node_id": node_id,
                    "protocol_version": protocol::PROTOCOL_VERSION,
                    "server_metadata": {"mock": true},
                }),
            )
        }
    };
    drop(tokens);

    let body = serde_json::to_string(&response)?;
    let reason = if status == 200 { "OK" } else { "Unauthorized" };
    stream
        .write_all(
            format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await?;
    stream.flush().await?;
    Ok(())
}

async fn serve_session(
    mut socket: WebSocketStream<TcpStream>,
    state: ServerState,
) -> anyhow::Result<()> {
    let behaviour = state.behaviour.lock().await.clone();

    // --- handshake -------------------------------------------------------
    let hello_frame = next_envelope(&mut socket).await?;
    if hello_frame.message_type != message_types::CLIENT_HELLO {
        return Ok(());
    }
    let hello: ClientHello = serde_json::from_value(hello_frame.payload)?;
    state.observations.lock().await.hellos.push(hello.clone());

    let Some(version) =
        protocol::negotiate_version(&hello.supported_versions, protocol::SUPPORTED_VERSIONS)
    else {
        send(
            &mut socket,
            ProtocolError::new(ErrorCode::UnsupportedVersion, "no shared protocol version")
                .into_envelope(None),
        )
        .await?;
        return Ok(());
    };

    let session_id = format!("sess-{}", protocol::new_message_id());
    let now = asterism_node::registry::now_millis();
    let server_nonce = if behaviour.replay_challenge {
        state
            .last_server_nonce
            .lock()
            .await
            .clone()
            .unwrap_or_else(protocol::new_nonce)
    } else {
        protocol::new_nonce()
    };
    *state.last_server_nonce.lock().await = Some(server_nonce.clone());

    let (issued_at, expires_at) = if behaviour.expired_challenge {
        (now - 120_000, now - 60_000)
    } else {
        (now, now + protocol::CHALLENGE_TTL_MS)
    };

    send(
        &mut socket,
        Envelope::new(
            message_types::SERVER_CHALLENGE,
            json!({
                "protocol_version": version,
                "session_id": session_id,
                "server_nonce": server_nonce,
                "issued_at": issued_at,
                "expires_at": expires_at,
            }),
        ),
    )
    .await?;

    let auth_frame = next_envelope(&mut socket).await?;
    if auth_frame.message_type != message_types::CLIENT_AUTHENTICATE {
        return Ok(());
    }
    let signature = auth_frame.payload["signature"].as_str().unwrap_or_default();

    let public_key = state
        .nodes
        .lock()
        .await
        .get(&hello.node_id)
        .cloned()
        .unwrap_or_default();

    let transcript = protocol::auth_transcript(&AuthTranscriptInput {
        protocol_version: version,
        node_id: &hello.node_id,
        instance_id: &hello.instance_id,
        session_id: &session_id,
        client_nonce: &hello.client_nonce,
        server_nonce: &server_nonce,
        issued_at,
        expires_at,
        capabilities_digest: &hello.capabilities_digest,
    });

    let expired = asterism_node::registry::now_millis() > expires_at;
    let signature_ok =
        !public_key.is_empty() && verify_signature(&public_key, &transcript, signature);

    if expired || !signature_ok || behaviour.reject_authentication {
        state.observations.lock().await.authentication_failures += 1;
        let code = if expired {
            ErrorCode::ChallengeExpired
        } else if public_key.is_empty() {
            ErrorCode::UnknownNode
        } else {
            ErrorCode::AuthenticationFailed
        };
        send(
            &mut socket,
            ProtocolError::new(code, "authentication refused")
                .into_envelope(Some(auth_frame.message_id)),
        )
        .await?;
        return Ok(());
    }

    state.observations.lock().await.authentications += 1;
    send(
        &mut socket,
        Envelope::new(
            message_types::SERVER_READY,
            json!({
                "session_id": session_id,
                "protocol_version": version,
                "server_metadata": {"mock": true},
            }),
        ),
    )
    .await?;
    let _ = state.connected.send(session_id.clone());

    // --- adversarial frames ---------------------------------------------
    if behaviour.send_malformed_frame {
        socket
            .send(Message::Text("{ this is not valid json".to_owned()))
            .await?;
    }
    if behaviour.send_oversized_frame {
        let huge = "x".repeat(protocol::MAX_FRAME_BYTES + 1024);
        socket.send(Message::Text(huge)).await?;
    }

    // --- session ---------------------------------------------------------
    let mut frames_seen = 0usize;
    let mut push = tokio::time::interval(std::time::Duration::from_millis(100));

    // Behaviour is re-read on every frame rather than snapshotted, so a test can
    // change how the mock behaves while a session is already established.

    loop {
        tokio::select! {
            incoming = socket.next() => {
                let Some(Ok(message)) = incoming else { return Ok(()); };
                let Message::Text(text) = message else { continue };
                frames_seen += 1;
                let behaviour = state.behaviour.lock().await.clone();

                if let Some(limit) = behaviour.disconnect_after_frames
                    && frames_seen >= limit
                {
                    // An abrupt disconnect mid-stream: the Node must reconnect
                    // and resume from the acknowledged cursor.
                    let _ = socket.close(None).await;
                    return Ok(());
                }

                let Ok(envelope) = Envelope::decode(&text) else { continue };
                match envelope.message_type.as_str() {
                    message_types::CLIENT_HEARTBEAT => {
                        state.observations.lock().await.heartbeats += 1;
                        send(&mut socket, Envelope::new(
                            message_types::SERVER_HEARTBEAT_ACK, json!({}),
                        ).correlate(envelope.message_id)).await?;
                    }
                    message_types::CLIENT_COMMAND_RESULT => {
                        let payload = envelope.payload.clone();
                        state.observations.lock().await.command_results.push(payload.clone());
                        if !behaviour.withhold_result_acks
                            && let Some(command_id) = payload["command_id"].as_str()
                        {
                            send(&mut socket, Envelope::new(
                                message_types::SERVER_COMMAND_RESULT_ACK,
                                json!({"command_id": command_id}),
                            )).await?;
                        }
                    }
                    message_types::CLIENT_EVENT => {
                        let payload = envelope.payload.clone();
                        state.observations.lock().await.events.push(payload.clone());
                        if !behaviour.withhold_event_acks
                            && let (Some(run_id), Some(seq)) =
                                (payload["run_id"].as_str(), payload["seq"].as_i64())
                        {
                            send(&mut socket, Envelope::new(
                                message_types::SERVER_EVENT_ACK,
                                json!({"run_id": run_id, "acked_seq": seq}),
                            )).await?;
                        }
                    }
                    message_types::CLIENT_COMMAND_ACCEPTED => {}
                    "error" => {
                        state.observations.lock().await.protocol_errors.push(envelope.payload);
                    }
                    _ => {}
                }
            }

            _ = push.tick() => {
                let queued: Vec<Value> = std::mem::take(&mut *state.outgoing.lock().await);
                for command in queued {
                    send(&mut socket, Envelope::new(message_types::SERVER_COMMAND, command)).await?;
                }
            }
        }
    }
}

async fn send(socket: &mut WebSocketStream<TcpStream>, envelope: Envelope) -> anyhow::Result<()> {
    socket.send(Message::Text(envelope.encode()?)).await?;
    Ok(())
}

async fn next_envelope(socket: &mut WebSocketStream<TcpStream>) -> anyhow::Result<Envelope> {
    loop {
        match socket.next().await {
            Some(Ok(Message::Text(text))) => {
                return Envelope::decode(&text).map_err(|error| anyhow::anyhow!("{error}"));
            }
            Some(Ok(_)) => continue,
            Some(Err(error)) => return Err(error.into()),
            None => anyhow::bail!("connection closed"),
        }
    }
}
