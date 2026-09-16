//! Handing a device code to the browser that asked for it, without keeping it.
//!
//! A device authorization produces two kinds of data with opposite lifecycles.
//! The *fact* that a login was started, and for which credential, is ordinary
//! command history: it is durable, it is replayed after a reconnect, and it is
//! safe to keep. The *link and short code* a person types into a browser are
//! delivery material: useful for a few minutes, dangerous for as long as they
//! remain valid, and worthless afterwards.
//!
//! They used to travel as one JSON object through the durable command record
//! and the outbox, so the code sat in the Node registry indefinitely and a
//! redelivered command replayed a code that had long expired. This module keeps
//! the two apart by type: [`durable_result`] is all command history ever sees,
//! and [`DeviceDelivery`] is sent once, as its own frame, and never written.
//!
//! **Delivery is confirmed or the attempt ends.** The Control Plane acknowledges
//! the frame once the code is in its relay. A delivery that is not acknowledged
//! within [`ACKNOWLEDGEMENT_TIMEOUT`], or whose session ends first, cancels the
//! login it belongs to: a person is never left with a login running on the host
//! and no code to approve it with, and starting again is always safe.

use std::fmt;
use std::time::Duration;

use serde_json::{Value, json};

use crate::redact::{SAFE_METADATA_KEY, SafeIdentifier, safe_metadata};

/// How long the Control Plane has to confirm it holds a delivered code.
///
/// Measured in seconds rather than the code's own lifetime: the relay is one
/// frame away, and a confirmation that has not arrived in this long is not
/// arriving over this session.
pub const ACKNOWLEDGEMENT_TIMEOUT: Duration = Duration::from_secs(20);

/// What a stored command result says in place of the pair it no longer holds.
pub const REDACTED_MARKER: &str = "device_authorization";

/// The two fields that are delivery material. Recognised only inside the result
/// of a `credentials.authorize` command -- never by name anywhere else.
const MATERIAL_FIELDS: [&str; 2] = ["user_code", "verification_uri"];

/// A device code on its way to the relay. Never serialized, never persisted.
///
/// Deliberately has no `Serialize` and a `Debug` that withholds the pair, so the
/// usual ways a value ends up in a log line or a database cannot reach it.
pub struct DeviceDelivery {
    command_id: String,
    credential_id: String,
    verification_uri: String,
    user_code: String,
    expires_in_seconds: u64,
}

impl fmt::Debug for DeviceDelivery {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DeviceDelivery")
            .field("command_id", &self.command_id)
            .field("credential_id", &self.credential_id)
            .field("verification_uri", &"<withheld>")
            .field("user_code", &"<withheld>")
            .field("expires_in_seconds", &self.expires_in_seconds)
            .finish()
    }
}

impl DeviceDelivery {
    pub fn new(command_id: &str, credential_id: &str, code: &crate::provider::DeviceCode) -> Self {
        Self {
            command_id: command_id.to_owned(),
            credential_id: credential_id.to_owned(),
            verification_uri: code.verification_uri.clone(),
            user_code: code.user_code.clone(),
            expires_in_seconds: code.expires_in_seconds,
        }
    }

    pub fn command_id(&self) -> &str {
        &self.command_id
    }

    pub fn credential_id(&self) -> &str {
        &self.credential_id
    }

    /// The command's durable result: the shape of the answer, not its content.
    pub fn durable_result(&self) -> Value {
        durable_result(&self.credential_id, Some(self.expires_in_seconds))
    }

    /// The payload of the one frame that carries the pair to the relay.
    pub fn frame_payload(&self) -> Value {
        let mut payload = json!({
            "command_id": self.command_id,
            "verification_uri": self.verification_uri,
            "user_code": self.user_code,
            "expires_in_seconds": self.expires_in_seconds,
        });
        if let Some(metadata) =
            safe_metadata(&[(SafeIdentifier::CredentialId, &self.credential_id)])
        {
            payload[SAFE_METADATA_KEY] = metadata;
        }
        payload
    }
}

/// What command history records for a device authorization.
///
/// The credential id travels only as validated safe metadata; one that does not
/// validate is left out rather than stored in some other form.
pub fn durable_result(credential_id: &str, expires_in_seconds: Option<u64>) -> Value {
    let mut result = json!({
        "redacted": REDACTED_MARKER,
        "delivery": "transient",
    });
    if let Some(seconds) = expires_in_seconds {
        result["expires_in_seconds"] = json!(seconds);
    }
    if let Some(metadata) = safe_metadata(&[(SafeIdentifier::CredentialId, credential_id)]) {
        result[SAFE_METADATA_KEY] = metadata;
    }
    result
}

/// Whether a stored `credentials.authorize` result still carries the pair.
pub fn carries_material(result: &Value) -> bool {
    result.as_object().is_some_and(|object| {
        MATERIAL_FIELDS
            .iter()
            .any(|field| object.contains_key(*field))
    })
}

/// The durable form of a historical result that carried the pair.
///
/// Keeps a credential id only if it validates as safe metadata -- the form
/// results have carried it in since the redactor stopped destroying it -- and an
/// expiry only if it is a plain number. Everything else in the old result is
/// dropped, whatever it was called.
pub fn scrubbed(result: &Value) -> Value {
    let credential_id = result
        .get(SAFE_METADATA_KEY)
        .and_then(|metadata| metadata.get(SafeIdentifier::CredentialId.key()))
        .and_then(Value::as_str)
        .filter(|id| SafeIdentifier::CredentialId.accepts(id))
        .unwrap_or_default();
    let expires = result.get("expires_in_seconds").and_then(Value::as_u64);
    let mut scrubbed = durable_result(credential_id, expires);
    scrubbed["delivery"] = json!("scrubbed");
    scrubbed
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "cred-0011aabbccddeeff";

    fn delivery() -> DeviceDelivery {
        DeviceDelivery::new(
            "cmd-1",
            ID,
            &crate::provider::DeviceCode {
                verification_uri: "https://auth.openai.com/codex/device".to_owned(),
                user_code: "QZXW-7Y3K".to_owned(),
                expires_in_seconds: 900,
            },
        )
    }

    #[test]
    fn command_history_never_sees_the_pair_and_keeps_the_credential_id() {
        let durable = delivery().durable_result();
        let text = durable.to_string();
        assert!(!text.contains("QZXW-7Y3K"), "{text}");
        assert!(!text.contains("auth.openai.com"), "{text}");
        assert!(!carries_material(&durable));
        assert_eq!(durable[SAFE_METADATA_KEY]["credential_id"], ID);
        assert_eq!(durable["redacted"], REDACTED_MARKER);
    }

    #[test]
    fn the_frame_carries_the_pair_and_the_safe_credential_id() {
        let frame = delivery().frame_payload();
        assert_eq!(frame["user_code"], "QZXW-7Y3K");
        assert_eq!(
            frame["verification_uri"],
            "https://auth.openai.com/codex/device"
        );
        assert_eq!(frame["command_id"], "cmd-1");
        assert_eq!(frame[SAFE_METADATA_KEY]["credential_id"], ID);
    }

    #[test]
    fn debug_output_withholds_the_pair() {
        let rendered = format!("{:?}", delivery());
        assert!(!rendered.contains("QZXW-7Y3K"), "{rendered}");
        assert!(!rendered.contains("auth.openai.com"), "{rendered}");
        assert!(rendered.contains(ID));
    }

    #[test]
    fn an_invalid_credential_id_is_left_out_rather_than_stored() {
        for bad in ["[redacted]", "cred-XYZ", "", "../etc"] {
            let durable = durable_result(bad, Some(900));
            assert!(durable.get(SAFE_METADATA_KEY).is_none(), "{bad}");
        }
    }

    #[test]
    fn a_historical_result_is_scrubbed_to_its_safe_shape() {
        let old = json!({
            "verification_uri": "https://auth.openai.com/codex/device",
            "user_code": "QZXW-7Y3K",
            "expires_in_seconds": 900,
            "credential_id": "[redacted]",
            "safe_metadata": {"credential_id": ID},
            "anything_else": "dropped",
        });
        assert!(carries_material(&old));
        let clean = scrubbed(&old);
        let text = clean.to_string();
        for gone in [
            "QZXW-7Y3K",
            "auth.openai.com",
            "anything_else",
            "[redacted]",
        ] {
            assert!(!text.contains(gone), "{gone} survived: {text}");
        }
        assert_eq!(clean[SAFE_METADATA_KEY]["credential_id"], ID);
        assert_eq!(clean["expires_in_seconds"], 900);
        assert!(!carries_material(&clean));

        // A forged id in the old metadata is not carried forward.
        let forged =
            json!({"user_code": "QZXW-7Y3K", "safe_metadata": {"credential_id": "not-an-id"}});
        assert!(scrubbed(&forged).get(SAFE_METADATA_KEY).is_none());
    }
}
