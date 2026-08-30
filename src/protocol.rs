//! Asterism Node ↔ Control Plane wire protocol, version 1.
//!
//! Deliberately independent of the WebSocket implementation: this module knows
//! about envelopes, message types, canonical signing, and validation, and
//! nothing about sockets. `docs/protocol/v1.md` is the normative specification;
//! this file is its executable form.
//!
//! The connection is always **outbound** from the Node. Nothing here implies or
//! permits an inbound listener.

use std::collections::BTreeMap;

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// Protocol versions this build understands, newest first.
pub const SUPPORTED_VERSIONS: &[u16] = &[1];

/// Current version used when only one is possible.
pub const PROTOCOL_VERSION: u16 = 1;

/// Largest accepted frame. Anything larger is a protocol violation, not a
/// resource to be buffered.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// Largest accepted remote command payload.
pub const MAX_COMMAND_PAYLOAD_BYTES: usize = 128 * 1024;

/// Domain separator mixed into every authentication transcript so a signature
/// produced here can never be replayed as a signature for another purpose.
pub const AUTH_DOMAIN: &str = "asterism-node-auth/v1";

/// Default validity window a Control Plane should give a challenge.
pub const CHALLENGE_TTL_MS: i64 = 30_000;

// ---------------------------------------------------------------- envelope

/// Every frame on the wire is one of these.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Envelope {
    pub protocol_version: u16,
    /// Collision-resistant per-message identifier (UUID v4).
    pub message_id: String,
    #[serde(rename = "type")]
    pub message_type: String,
    /// Informational wall-clock milliseconds. **Never** a replay defence — that
    /// is the nonce's job.
    pub timestamp: i64,
    /// Links a response to the request that caused it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    pub payload: Value,
}

impl Envelope {
    pub fn new(message_type: &str, payload: Value) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            message_id: new_message_id(),
            message_type: message_type.to_owned(),
            timestamp: crate::registry::now_millis(),
            correlation_id: None,
            payload,
        }
    }

    pub fn correlate(mut self, correlation_id: impl Into<String>) -> Self {
        self.correlation_id = Some(correlation_id.into());
        self
    }

    pub fn encode(&self) -> Result<String> {
        let text = serde_json::to_string(self)?;
        if text.len() > MAX_FRAME_BYTES {
            bail!("outgoing frame of {} bytes exceeds the limit", text.len());
        }
        Ok(text)
    }

    /// Parse and validate one frame.
    ///
    /// Unknown *optional* fields are tolerated for forward compatibility;
    /// unknown message types are not silently dropped — the caller answers them
    /// with a typed protocol error.
    pub fn decode(text: &str) -> std::result::Result<Self, ProtocolError> {
        if text.len() > MAX_FRAME_BYTES {
            return Err(ProtocolError::new(
                ErrorCode::FrameTooLarge,
                format!("frame of {} bytes exceeds {MAX_FRAME_BYTES}", text.len()),
            ));
        }
        let envelope: Self = serde_json::from_str(text).map_err(|error| {
            ProtocolError::new(ErrorCode::MalformedFrame, format!("invalid frame: {error}"))
        })?;

        if !SUPPORTED_VERSIONS.contains(&envelope.protocol_version) {
            return Err(ProtocolError::new(
                ErrorCode::UnsupportedVersion,
                format!(
                    "protocol version {} is not supported",
                    envelope.protocol_version
                ),
            ));
        }
        if envelope.message_id.is_empty() || envelope.message_id.len() > 128 {
            return Err(ProtocolError::new(
                ErrorCode::MalformedFrame,
                "message_id must be 1..=128 characters".to_owned(),
            ));
        }
        if envelope.message_type.is_empty() || envelope.message_type.len() > 64 {
            return Err(ProtocolError::new(
                ErrorCode::MalformedFrame,
                "type must be 1..=64 characters".to_owned(),
            ));
        }
        Ok(envelope)
    }
}

pub fn new_message_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

// ------------------------------------------------------------ error codes

/// Stable, machine-readable protocol error codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    MalformedFrame,
    FrameTooLarge,
    UnsupportedVersion,
    UnknownMessageType,
    NotAuthenticated,
    AuthenticationFailed,
    ChallengeExpired,
    ChallengeReplayed,
    UnknownNode,
    PayloadTooLarge,
    UnknownCommand,
    ForbiddenCommand,
    ProjectNotRegistered,
    DuplicatePayloadMismatch,
    CommandFailed,
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MalformedFrame => "malformed_frame",
            Self::FrameTooLarge => "frame_too_large",
            Self::UnsupportedVersion => "unsupported_version",
            Self::UnknownMessageType => "unknown_message_type",
            Self::NotAuthenticated => "not_authenticated",
            Self::AuthenticationFailed => "authentication_failed",
            Self::ChallengeExpired => "challenge_expired",
            Self::ChallengeReplayed => "challenge_replayed",
            Self::UnknownNode => "unknown_node",
            Self::PayloadTooLarge => "payload_too_large",
            Self::UnknownCommand => "unknown_command",
            Self::ForbiddenCommand => "forbidden_command",
            Self::ProjectNotRegistered => "project_not_registered",
            Self::DuplicatePayloadMismatch => "duplicate_payload_mismatch",
            Self::CommandFailed => "command_failed",
            Self::Internal => "internal",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProtocolError {
    pub code: ErrorCode,
    pub message: String,
}

impl ProtocolError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn into_envelope(self, correlation_id: Option<String>) -> Envelope {
        let envelope = Envelope::new(
            message_types::ERROR,
            json!({"code": self.code.as_str(), "message": self.message}),
        );
        match correlation_id {
            Some(id) => envelope.correlate(id),
            None => envelope,
        }
    }
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for ProtocolError {}

// --------------------------------------------------------- message types

pub mod message_types {
    // Handshake.
    pub const CLIENT_HELLO: &str = "client.hello";
    pub const SERVER_CHALLENGE: &str = "server.challenge";
    pub const CLIENT_AUTHENTICATE: &str = "client.authenticate";
    pub const SERVER_READY: &str = "server.ready";

    // Liveness.
    pub const CLIENT_HEARTBEAT: &str = "client.heartbeat";
    pub const SERVER_HEARTBEAT_ACK: &str = "server.heartbeat.ack";

    // Commands, Control Plane → Node.
    pub const SERVER_COMMAND: &str = "server.command";
    pub const CLIENT_COMMAND_ACCEPTED: &str = "client.command.accepted";
    pub const CLIENT_COMMAND_RESULT: &str = "client.command.result";
    pub const SERVER_COMMAND_RESULT_ACK: &str = "server.command.result.ack";

    // Events, Node → Control Plane.
    pub const CLIENT_EVENT: &str = "client.event";
    pub const SERVER_EVENT_ACK: &str = "server.event.ack";

    pub const ERROR: &str = "error";
}

/// Remote command names the Node will execute. Anything outside this list is
/// refused with `forbidden_command` — the Control Plane cannot reach past it.
pub const ALLOWED_COMMANDS: &[&str] = &[
    "capabilities.get",
    "projects.list",
    "runs.create",
    "runs.list",
    "runs.get",
    "runs.cancel",
    "runs.retry",
    // Run-scoped approval policy. Operator-initiated through the authenticated
    // channel; nothing the model produces can reach it.
    "runs.approval_policy",
    // Build a project's workspace and its own Hermes home. The command carries
    // product identity and sanitized workspace intent; every host detail — the
    // path, the home, the port, the key, the unit — is derived here and never
    // travels in either direction.
    "project.provision",
    "approvals.resolve",
    "events.subscribe",
    "events.unsubscribe",
    "node.drain",
];

pub fn is_allowed_command(name: &str) -> bool {
    ALLOWED_COMMANDS.contains(&name)
}

// ------------------------------------------------------------- handshake

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClientHello {
    pub supported_versions: Vec<u16>,
    pub node_id: String,
    pub instance_id: String,
    pub public_key_fingerprint: String,
    pub client_nonce: String,
    pub capabilities_digest: String,
    pub software_version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ServerChallenge {
    pub protocol_version: u16,
    pub session_id: String,
    pub server_nonce: String,
    pub issued_at: i64,
    pub expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClientAuthenticate {
    pub session_id: String,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ServerReady {
    pub session_id: String,
    pub protocol_version: u16,
    #[serde(default)]
    pub server_metadata: Value,
}

/// Pick the highest version both sides support.
pub fn negotiate_version(client: &[u16], server: &[u16]) -> Option<u16> {
    let mut shared: Vec<u16> = client
        .iter()
        .copied()
        .filter(|version| server.contains(version))
        .collect();
    shared.sort_unstable();
    shared.pop()
}

/// Build the canonical authentication transcript.
///
/// # Canonical form
///
/// A JSON object with **sorted keys** and no insignificant whitespace, produced
/// from a `BTreeMap<&str, String>`. Every value is rendered as a string so the
/// encoding cannot depend on numeric formatting. The exact field set is:
///
/// `capabilities_digest`, `client_nonce`, `domain`, `expires_at`, `instance_id`,
/// `issued_at`, `node_id`, `protocol_version`, `server_nonce`, `session_id`.
///
/// `domain` is [`AUTH_DOMAIN`], which is what stops a signature made here from
/// being valid anywhere else. Both sides build these bytes independently and
/// must agree byte-for-byte; the Node signs them with Ed25519 and the Control
/// Plane verifies against the public key registered at enrollment.
pub fn auth_transcript(input: &AuthTranscriptInput<'_>) -> Vec<u8> {
    let mut fields: BTreeMap<&str, String> = BTreeMap::new();
    fields.insert("domain", AUTH_DOMAIN.to_owned());
    fields.insert("protocol_version", input.protocol_version.to_string());
    fields.insert("node_id", input.node_id.to_owned());
    fields.insert("instance_id", input.instance_id.to_owned());
    fields.insert("session_id", input.session_id.to_owned());
    fields.insert("client_nonce", input.client_nonce.to_owned());
    fields.insert("server_nonce", input.server_nonce.to_owned());
    fields.insert("issued_at", input.issued_at.to_string());
    fields.insert("expires_at", input.expires_at.to_string());
    fields.insert("capabilities_digest", input.capabilities_digest.to_owned());

    serde_json::to_vec(&fields).expect("a map of strings always serializes")
}

/// Every field that goes into the signed transcript.
#[derive(Debug, Clone, Copy)]
pub struct AuthTranscriptInput<'a> {
    pub protocol_version: u16,
    pub node_id: &'a str,
    pub instance_id: &'a str,
    pub session_id: &'a str,
    pub client_nonce: &'a str,
    pub server_nonce: &'a str,
    pub issued_at: i64,
    pub expires_at: i64,
    pub capabilities_digest: &'a str,
}

/// Fresh 256-bit nonce, base64-encoded.
pub fn new_nonce() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("OS randomness is available");
    crate::identity::encode_base64(&bytes)
}

/// SHA-256 digest of a JSON value, lowercase hex.
///
/// Used for capability digests and command payload fingerprints. SHA-256 is the
/// only digest in the protocol; the non-cryptographic hash used for run
/// idempotency never appears on the wire.
pub fn digest_json(value: &Value) -> String {
    let canonical = serde_json::to_vec(value).unwrap_or_default();
    let digest = Sha256::digest(&canonical);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

// ------------------------------------------------------------- commands

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RemoteCommand {
    /// Control-Plane-assigned identifier. The deduplication key.
    pub command_id: String,
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default)]
    pub payload: Value,
}

impl RemoteCommand {
    pub fn validate(&self) -> std::result::Result<(), ProtocolError> {
        if self.command_id.is_empty() || self.command_id.len() > 128 {
            return Err(ProtocolError::new(
                ErrorCode::MalformedFrame,
                "command_id must be 1..=128 characters",
            ));
        }
        if !is_allowed_command(&self.command) {
            return Err(ProtocolError::new(
                ErrorCode::ForbiddenCommand,
                format!("command {:?} is not permitted", self.command),
            ));
        }
        let encoded = serde_json::to_vec(&self.payload).unwrap_or_default();
        if encoded.len() > MAX_COMMAND_PAYLOAD_BYTES {
            return Err(ProtocolError::new(
                ErrorCode::PayloadTooLarge,
                format!(
                    "payload of {} bytes exceeds {MAX_COMMAND_PAYLOAD_BYTES}",
                    encoded.len()
                ),
            ));
        }
        Ok(())
    }

    /// SHA-256 over the parts that define "the same command".
    pub fn fingerprint(&self) -> String {
        digest_json(&json!({
            "command": self.command,
            "project_id": self.project_id,
            "payload": self.payload,
        }))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandResult {
    pub command_id: String,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

// --------------------------------------------------------------- events

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventDelivery {
    pub project_id: String,
    pub run_id: String,
    pub seq: i64,
    pub event_type: String,
    pub recorded_at: i64,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventAck {
    pub run_id: String,
    /// Highest contiguous sequence the Control Plane has durably stored.
    pub acked_seq: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubscribeRequest {
    pub project_id: String,
    pub run_id: String,
    #[serde(default)]
    pub from_seq: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelopes_round_trip() {
        let envelope =
            Envelope::new(message_types::CLIENT_HELLO, json!({"a": 1})).correlate("corr-1");
        let decoded = Envelope::decode(&envelope.encode().unwrap()).unwrap();

        assert_eq!(decoded, envelope);
        assert_eq!(decoded.correlation_id.as_deref(), Some("corr-1"));
    }

    #[test]
    fn message_ids_are_unique() {
        let a = Envelope::new("x", json!({}));
        let b = Envelope::new("x", json!({}));
        assert_ne!(a.message_id, b.message_id);
        assert_eq!(a.message_id.len(), 36, "UUID v4 text form");
    }

    #[test]
    fn oversized_frames_are_refused_before_parsing() {
        let huge = "x".repeat(MAX_FRAME_BYTES + 1);
        let error = Envelope::decode(&huge).unwrap_err();
        assert_eq!(error.code, ErrorCode::FrameTooLarge);
    }

    #[test]
    fn malformed_frames_produce_a_typed_error() {
        for bad in ["", "not json", "{", "[]", "{\"protocol_version\":1}"] {
            let error = Envelope::decode(bad).unwrap_err();
            assert!(
                matches!(
                    error.code,
                    ErrorCode::MalformedFrame | ErrorCode::UnsupportedVersion
                ),
                "{bad:?} produced {:?}",
                error.code
            );
        }
    }

    #[test]
    fn unsupported_versions_are_rejected() {
        let frame = json!({
            "protocol_version": 99,
            "message_id": "m",
            "type": "client.hello",
            "timestamp": 1,
            "payload": {}
        })
        .to_string();

        let error = Envelope::decode(&frame).unwrap_err();
        assert_eq!(error.code, ErrorCode::UnsupportedVersion);
    }

    #[test]
    fn unknown_optional_fields_are_tolerated() {
        // Forward compatibility: a newer peer may add fields we do not know.
        let frame = json!({
            "protocol_version": 1,
            "message_id": "m",
            "type": "client.hello",
            "timestamp": 1,
            "payload": {"known": 1, "added_by_a_newer_peer": true},
            "future_field": "ignored"
        })
        .to_string();

        let decoded = Envelope::decode(&frame).unwrap();
        assert_eq!(decoded.payload["added_by_a_newer_peer"], json!(true));
    }

    #[test]
    fn version_negotiation_picks_the_highest_shared_version() {
        assert_eq!(negotiate_version(&[1, 2, 3], &[2, 3, 4]), Some(3));
        assert_eq!(negotiate_version(&[1], &[1]), Some(1));
        assert_eq!(negotiate_version(&[1, 2], &[3, 4]), None);
        assert_eq!(negotiate_version(&[], &[1]), None);
    }

    #[test]
    fn the_transcript_is_canonical_and_order_independent() {
        let a = auth_transcript(&AuthTranscriptInput {
            protocol_version: 1,
            node_id: "n",
            instance_id: "i",
            session_id: "s",
            client_nonce: "cn",
            server_nonce: "sn",
            issued_at: 10,
            expires_at: 20,
            capabilities_digest: "cap",
        });
        let b = auth_transcript(&AuthTranscriptInput {
            protocol_version: 1,
            node_id: "n",
            instance_id: "i",
            session_id: "s",
            client_nonce: "cn",
            server_nonce: "sn",
            issued_at: 10,
            expires_at: 20,
            capabilities_digest: "cap",
        });

        assert_eq!(a, b);
        let text = String::from_utf8(a).unwrap();
        // Sorted keys, no whitespace.
        assert!(text.starts_with("{\"capabilities_digest\":"));
        assert!(!text.contains(' '));
        assert!(text.contains(AUTH_DOMAIN));
    }

    #[test]
    fn every_transcript_field_changes_the_signed_bytes() {
        let base = auth_transcript(&AuthTranscriptInput {
            protocol_version: 1,
            node_id: "n",
            instance_id: "i",
            session_id: "s",
            client_nonce: "cn",
            server_nonce: "sn",
            issued_at: 10,
            expires_at: 20,
            capabilities_digest: "cap",
        });
        let variants = [
            auth_transcript(&AuthTranscriptInput {
                protocol_version: 1,
                node_id: "OTHER",
                instance_id: "i",
                session_id: "s",
                client_nonce: "cn",
                server_nonce: "sn",
                issued_at: 10,
                expires_at: 20,
                capabilities_digest: "cap",
            }),
            auth_transcript(&AuthTranscriptInput {
                protocol_version: 1,
                node_id: "n",
                instance_id: "OTHER",
                session_id: "s",
                client_nonce: "cn",
                server_nonce: "sn",
                issued_at: 10,
                expires_at: 20,
                capabilities_digest: "cap",
            }),
            auth_transcript(&AuthTranscriptInput {
                protocol_version: 1,
                node_id: "n",
                instance_id: "i",
                session_id: "OTHER",
                client_nonce: "cn",
                server_nonce: "sn",
                issued_at: 10,
                expires_at: 20,
                capabilities_digest: "cap",
            }),
            auth_transcript(&AuthTranscriptInput {
                protocol_version: 1,
                node_id: "n",
                instance_id: "i",
                session_id: "s",
                client_nonce: "OTHER",
                server_nonce: "sn",
                issued_at: 10,
                expires_at: 20,
                capabilities_digest: "cap",
            }),
            auth_transcript(&AuthTranscriptInput {
                protocol_version: 1,
                node_id: "n",
                instance_id: "i",
                session_id: "s",
                client_nonce: "cn",
                server_nonce: "OTHER",
                issued_at: 10,
                expires_at: 20,
                capabilities_digest: "cap",
            }),
            auth_transcript(&AuthTranscriptInput {
                protocol_version: 1,
                node_id: "n",
                instance_id: "i",
                session_id: "s",
                client_nonce: "cn",
                server_nonce: "sn",
                issued_at: 11,
                expires_at: 20,
                capabilities_digest: "cap",
            }),
            auth_transcript(&AuthTranscriptInput {
                protocol_version: 1,
                node_id: "n",
                instance_id: "i",
                session_id: "s",
                client_nonce: "cn",
                server_nonce: "sn",
                issued_at: 10,
                expires_at: 21,
                capabilities_digest: "cap",
            }),
            auth_transcript(&AuthTranscriptInput {
                protocol_version: 1,
                node_id: "n",
                instance_id: "i",
                session_id: "s",
                client_nonce: "cn",
                server_nonce: "sn",
                issued_at: 10,
                expires_at: 20,
                capabilities_digest: "OTHER",
            }),
        ];
        for variant in variants {
            assert_ne!(base, variant);
        }
    }

    #[test]
    fn nonces_are_fresh_and_long() {
        let a = new_nonce();
        let b = new_nonce();
        assert_ne!(a, b);
        assert_eq!(crate::identity::decode_base64(&a).unwrap().len(), 32);
    }

    #[test]
    fn digests_are_sha256_hex_and_stable() {
        let digest = digest_json(&json!({"b": 2, "a": 1}));
        assert_eq!(digest.len(), 64);
        assert!(digest.chars().all(|c| c.is_ascii_hexdigit()));
        // serde_json orders object keys, so the digest does not depend on the
        // order the caller wrote them in.
        assert_eq!(digest, digest_json(&json!({"a": 1, "b": 2})));
    }

    #[test]
    fn only_the_documented_command_set_is_permitted() {
        for allowed in ALLOWED_COMMANDS {
            assert!(is_allowed_command(allowed));
        }
        for forbidden in [
            "shell.exec",
            "docker.run",
            "project.remove",
            "project.auth",
            "identity.export",
            "runs.create.unsafe",
            "",
        ] {
            assert!(
                !is_allowed_command(forbidden),
                "{forbidden:?} must be refused"
            );
        }
    }

    #[test]
    fn commands_outside_the_allow_list_are_rejected_with_a_typed_code() {
        let command = RemoteCommand {
            command_id: "c1".into(),
            command: "shell.exec".into(),
            project_id: None,
            payload: json!({"cmd": "rm -rf /"}),
        };
        assert_eq!(
            command.validate().unwrap_err().code,
            ErrorCode::ForbiddenCommand
        );
    }

    #[test]
    fn oversized_command_payloads_are_rejected() {
        let command = RemoteCommand {
            command_id: "c1".into(),
            command: "runs.create".into(),
            project_id: Some("p".into()),
            payload: json!({"input": "x".repeat(MAX_COMMAND_PAYLOAD_BYTES + 1)}),
        };
        assert_eq!(
            command.validate().unwrap_err().code,
            ErrorCode::PayloadTooLarge
        );
    }

    #[test]
    fn command_fingerprints_detect_a_changed_payload() {
        let base = RemoteCommand {
            command_id: "c1".into(),
            command: "runs.create".into(),
            project_id: Some("p".into()),
            payload: json!({"input": "one"}),
        };
        let same = RemoteCommand {
            command_id: "c1-different-id".into(),
            ..base.clone()
        };
        let different = RemoteCommand {
            payload: json!({"input": "two"}),
            ..base.clone()
        };

        // The id is not part of the fingerprint: identity is the work itself.
        assert_eq!(base.fingerprint(), same.fingerprint());
        assert_ne!(base.fingerprint(), different.fingerprint());
        assert_eq!(base.fingerprint().len(), 64);
    }

    #[test]
    fn protocol_errors_render_as_correlated_envelopes() {
        let envelope = ProtocolError::new(ErrorCode::UnknownCommand, "nope")
            .into_envelope(Some("corr-9".to_owned()));

        assert_eq!(envelope.message_type, message_types::ERROR);
        assert_eq!(envelope.payload["code"], json!("unknown_command"));
        assert_eq!(envelope.correlation_id.as_deref(), Some("corr-9"));
    }
}
