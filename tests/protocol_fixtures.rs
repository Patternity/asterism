//! Cross-language protocol conformance, Rust side.
//!
//! Mirror image of `control-plane/test/unit/conformance.test.ts`:
//!
//!   1. computes every derived value from the shared, language-neutral inputs
//!      and writes them to `outputs.rust.json`;
//!   2. asserts that the TypeScript Control Plane's committed
//!      `outputs.typescript.json` matches what this implementation computed.
//!
//! The two implementations were written separately from `docs/protocol/v1.md`.
//! Anywhere they disagree is a defect in the specification, not a matter of
//! taste — which is the whole point of keeping them independent.
//!
//! The Ed25519 key used here is a dedicated test key with a published seed. It
//! has never protected anything.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use asterism_node::identity::{encode_base64, verify_signature};
use asterism_node::protocol::{
    ALLOWED_COMMANDS, AuthTranscriptInput, Envelope, ErrorCode, MAX_FRAME_BYTES, auth_transcript,
    digest_json, is_allowed_command, negotiate_version,
};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("docs/protocol/fixtures/v1")
}

fn inputs() -> Value {
    let path = fixture_dir().join("inputs.json");
    let body = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
    serde_json::from_str(&body).expect("inputs.json is valid JSON")
}

fn test_key(inputs: &Value) -> SigningKey {
    let seed_hex = inputs["test_key"]["seed_hex"].as_str().expect("seed_hex");
    let bytes: Vec<u8> = (0..seed_hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&seed_hex[index..index + 2], 16).expect("hex"))
        .collect();
    let seed: [u8; 32] = bytes.try_into().expect("seed is 32 bytes");
    SigningKey::from_bytes(&seed)
}

/// Build a transcript from the shared handshake inputs, with one field replaced.
fn transcript_with(inputs: &Value, field: Option<&str>, replacement: Option<&Value>) -> Vec<u8> {
    let handshake = &inputs["handshake"];
    let value_or = |name: &str| -> Value {
        match field {
            Some(target) if target == name => replacement.cloned().unwrap_or(Value::Null),
            _ => handshake[name].clone(),
        }
    };
    let protocol_version = match field {
        Some("protocol_version") => replacement
            .and_then(Value::as_u64)
            .expect("protocol_version variant") as u16,
        _ => inputs["protocol_version"].as_u64().expect("version") as u16,
    };

    let node_id = value_or("node_id");
    let instance_id = value_or("instance_id");
    let session_id = value_or("session_id");
    let client_nonce = value_or("client_nonce");
    let server_nonce = value_or("server_nonce");
    let capabilities_digest = value_or("capabilities_digest");

    auth_transcript(&AuthTranscriptInput {
        protocol_version,
        node_id: node_id.as_str().expect("node_id"),
        instance_id: instance_id.as_str().expect("instance_id"),
        session_id: session_id.as_str().expect("session_id"),
        client_nonce: client_nonce.as_str().expect("client_nonce"),
        server_nonce: server_nonce.as_str().expect("server_nonce"),
        issued_at: value_or("issued_at").as_i64().expect("issued_at"),
        expires_at: value_or("expires_at").as_i64().expect("expires_at"),
        capabilities_digest: capabilities_digest.as_str().expect("capabilities_digest"),
    })
}

/// Compute the complete output set from the shared inputs.
fn compute_outputs(inputs: &Value) -> Value {
    let key = test_key(inputs);
    let public_key = encode_base64(key.verifying_key().as_bytes());
    let fingerprint: String = Sha256::digest(key.verifying_key().as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();

    let transcript = transcript_with(inputs, None, None);
    let signature = encode_base64(&key.sign(&transcript).to_bytes());

    let mut variants = BTreeMap::new();
    for (field, value) in inputs["transcript_variants"]
        .as_object()
        .expect("transcript_variants")
    {
        if field.starts_with('$') {
            continue;
        }
        variants.insert(
            field.clone(),
            encode_base64(&transcript_with(inputs, Some(field), Some(value))),
        );
    }

    let mut digests = BTreeMap::new();
    for vector in inputs["digest_vectors"].as_array().expect("digest_vectors") {
        digests.insert(
            vector["name"].as_str().expect("name").to_owned(),
            digest_json(&vector["value"]),
        );
    }

    let mut command_fingerprints = BTreeMap::new();
    for vector in inputs["command_vectors"]
        .as_array()
        .expect("command_vectors")
    {
        // Mirrors RemoteCommand::fingerprint without depending on the struct,
        // so the fixture pins the documented shape rather than the code.
        let digest = digest_json(&json!({
            "command": vector["command"],
            "project_id": vector["project_id"],
            "payload": vector["payload"],
        }));
        command_fingerprints.insert(vector["name"].as_str().expect("name").to_owned(), digest);
    }

    json!({
        "public_key": public_key,
        "fingerprint": fingerprint,
        "transcript_utf8": String::from_utf8(transcript.clone()).expect("utf8"),
        "transcript_base64": encode_base64(&transcript),
        "signature": signature,
        "transcript_variants": variants,
        "digests": digests,
        "command_fingerprints": command_fingerprints,
        "allowed_commands": ALLOWED_COMMANDS,
    })
}

fn typescript_outputs() -> Value {
    let path = fixture_dir().join("outputs.typescript.json");
    let body = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "{} is missing ({error}). Generate it first with: \
             cd control-plane && npm run test:unit",
            path.display()
        )
    });
    serde_json::from_str(&body).expect("outputs.typescript.json is valid JSON")
}

#[test]
fn publishes_this_implementations_computed_outputs() {
    let inputs = inputs();
    let outputs = compute_outputs(&inputs);
    let path = fixture_dir().join("outputs.rust.json");
    std::fs::write(
        &path,
        format!("{}\n", serde_json::to_string_pretty(&outputs).unwrap()),
    )
    .unwrap_or_else(|error| panic!("failed to write {}: {error}", path.display()));

    assert_eq!(outputs["public_key"].as_str().unwrap().len(), 44);
}

#[test]
fn derives_the_same_public_key_and_fingerprint_as_the_control_plane() {
    let outputs = compute_outputs(&inputs());
    let typescript = typescript_outputs();

    assert_eq!(outputs["public_key"], typescript["public_key"]);
    assert_eq!(outputs["fingerprint"], typescript["fingerprint"]);
}

#[test]
fn produces_byte_identical_canonical_transcripts() {
    let outputs = compute_outputs(&inputs());
    let typescript = typescript_outputs();

    // A divergence here would make every cross-language signature unverifiable.
    assert_eq!(outputs["transcript_utf8"], typescript["transcript_utf8"]);
    assert_eq!(
        outputs["transcript_base64"],
        typescript["transcript_base64"]
    );
}

#[test]
fn verifies_the_signature_the_control_plane_produced() {
    let typescript = typescript_outputs();
    let transcript =
        asterism_node::identity::decode_base64(typescript["transcript_base64"].as_str().unwrap())
            .unwrap();

    assert!(verify_signature(
        typescript["public_key"].as_str().unwrap(),
        &transcript,
        typescript["signature"].as_str().unwrap(),
    ));
}

#[test]
fn changing_any_signed_field_invalidates_the_signature() {
    let inputs = inputs();
    let outputs = compute_outputs(&inputs);
    let public_key = outputs["public_key"].as_str().unwrap();
    let signature = outputs["signature"].as_str().unwrap();
    let base =
        asterism_node::identity::decode_base64(outputs["transcript_base64"].as_str().unwrap())
            .unwrap();

    for (field, encoded) in outputs["transcript_variants"].as_object().unwrap() {
        let variant = asterism_node::identity::decode_base64(encoded.as_str().unwrap()).unwrap();
        assert_ne!(variant, base, "{field} must change the transcript");
        assert!(
            !verify_signature(public_key, &variant, signature),
            "{field} must invalidate the signature"
        );
    }
}

#[test]
fn agrees_with_the_control_plane_on_every_transcript_variant() {
    let outputs = compute_outputs(&inputs());
    let typescript = typescript_outputs();

    for (field, value) in outputs["transcript_variants"].as_object().unwrap() {
        assert_eq!(
            &typescript["transcript_variants"][field], value,
            "variant {field}"
        );
    }
}

#[test]
fn agrees_on_digests_including_key_order_and_unicode() {
    let outputs = compute_outputs(&inputs());
    let typescript = typescript_outputs();

    for (name, digest) in outputs["digests"].as_object().unwrap() {
        assert_eq!(&typescript["digests"][name], digest, "digest {name}");
    }
    // Object key order must not change the digest.
    assert_eq!(
        outputs["digests"]["key_order"].as_str().unwrap(),
        digest_json(&json!({"a": 1, "b": 2}))
    );
}

#[test]
fn agrees_on_command_fingerprints() {
    let outputs = compute_outputs(&inputs());
    let typescript = typescript_outputs();

    for (name, digest) in outputs["command_fingerprints"].as_object().unwrap() {
        assert_eq!(
            &typescript["command_fingerprints"][name], digest,
            "command {name}"
        );
    }
    assert_ne!(
        outputs["command_fingerprints"]["runs_create"],
        outputs["command_fingerprints"]["runs_create_other_payload"]
    );
}

#[test]
fn agrees_on_the_allowed_command_set() {
    let typescript = typescript_outputs();
    let mut theirs: Vec<&str> = typescript["allowed_commands"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();
    let mut ours: Vec<&str> = ALLOWED_COMMANDS.to_vec();
    theirs.sort_unstable();
    ours.sort_unstable();

    assert_eq!(ours, theirs);
}

#[test]
fn rejects_every_invalid_frame_with_the_specified_error_code() {
    let inputs = inputs();
    for frame in inputs["invalid_frames"].as_array().unwrap() {
        let raw = frame["raw"].as_str().unwrap();
        let expected = frame["expected_error"].as_str().unwrap();
        let name = frame["name"].as_str().unwrap();

        let error = Envelope::decode(raw)
            .err()
            .unwrap_or_else(|| panic!("frame {name} should have been rejected"));
        assert_eq!(error.code.as_str(), expected, "frame {name}");
    }
}

#[test]
fn accepts_a_frame_carrying_fields_added_by_a_newer_peer() {
    let inputs = inputs();
    let raw = inputs["forward_compatible_frame"]["raw"].as_str().unwrap();

    let envelope = Envelope::decode(raw).expect("a forward-compatible frame must be accepted");
    assert_eq!(envelope.message_type, "client.hello");
    assert_eq!(envelope.payload["added_later"], json!(true));
}

#[test]
fn rejects_oversized_frames_before_parsing_them() {
    let huge = "x".repeat(MAX_FRAME_BYTES + 1);
    let error = Envelope::decode(&huge).unwrap_err();
    assert_eq!(error.code, ErrorCode::FrameTooLarge);
}

#[test]
fn refuses_every_forbidden_command() {
    let inputs = inputs();
    for command in inputs["forbidden_commands"].as_array().unwrap() {
        let name = command.as_str().unwrap();
        assert!(!is_allowed_command(name), "{name} must be refused");
    }
}

#[test]
fn negotiates_the_highest_shared_protocol_version() {
    assert_eq!(negotiate_version(&[1, 2, 3], &[2, 3, 4]), Some(3));
    assert_eq!(negotiate_version(&[1], &[1]), Some(1));
    assert_eq!(negotiate_version(&[1, 2], &[3, 4]), None);
    assert_eq!(negotiate_version(&[], &[1]), None);
}

#[test]
fn follows_the_documented_replay_cursor_rules() {
    let inputs = inputs();
    let replay = &inputs["replay"];
    let acked = replay["acked_seq"].as_i64().unwrap();

    let delivered: Vec<i64> = replay["journal_seqs"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_i64)
        .filter(|seq| *seq > acked)
        .collect();
    let expected: Vec<i64> = replay["expected_delivery"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_i64)
        .collect();

    assert_eq!(delivered, expected);
}
