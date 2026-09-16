//! Device codes and the Node registry's command history.
//!
//! These drive the real registry through its public API and then read the
//! database and its write-ahead log as raw bytes, because the property that
//! matters is not what a query returns but what is left on disk.

use std::path::Path;

use asterism_node::control::OUTBOX_COMMAND_RESULT;
use asterism_node::device_delivery::DeviceDelivery;
use asterism_node::inventory::RuntimeOwnership;
use asterism_node::provider::DeviceCode;
use asterism_node::registry::Registry;
use asterism_node::remote::{CommandAdmission, CommandState};
use serde_json::{Value, json};

const CODE: &str = "QZXW-7Y3K";
const LINK: &str = "https://auth.openai.com/codex/device";
const ID: &str = "cred-0011aabbccddeeff";

/// The database and its write-ahead log, as bytes.
fn on_disk(state_root: &Path) -> Vec<u8> {
    let database = Registry::path_for(state_root);
    let mut bytes = std::fs::read(&database).unwrap();
    let mut wal = database.as_os_str().to_owned();
    wal.push("-wal");
    if let Ok(more) = std::fs::read(wal) {
        bytes.extend(more);
    }
    bytes
}

fn holds(bytes: &[u8], needle: &str) -> bool {
    bytes
        .windows(needle.len())
        .any(|window| window == needle.as_bytes())
}

/// Command history exactly as a build before transient delivery wrote it.
fn seed_history_with_a_device_code(registry: &mut Registry) {
    let old = json!({
        "verification_uri": LINK,
        "user_code": CODE,
        "expires_in_seconds": 900,
        "safe_metadata": {"credential_id": ID},
    });
    registry
        .admit_remote_command("cmd-old", "credentials.authorize", None, "digest-old")
        .unwrap();
    registry
        .complete_remote_command("cmd-old", CommandState::Completed, Some(&old), None, None)
        .unwrap();
    // Delivered once and acknowledged: ordinary outbox history.
    let delivered = registry
        .enqueue_outbox(
            OUTBOX_COMMAND_RESULT,
            Some("cmd-old"),
            &json!({"command_id": "cmd-old", "state": "completed", "result": old}),
        )
        .unwrap();
    registry.acknowledge_outbox(delivered).unwrap();
    // Replayed after a redelivery and never acknowledged.
    registry
        .enqueue_outbox(
            OUTBOX_COMMAND_RESULT,
            Some("cmd-old"),
            &json!({"command_id": "cmd-old", "state": "completed", "result": old, "deduplicated": true}),
        )
        .unwrap();

    // Another command whose result merely uses the same names. Not this
    // cleanup's business.
    registry
        .admit_remote_command("cmd-other", "runs.get", None, "digest-other")
        .unwrap();
    registry
        .complete_remote_command(
            "cmd-other",
            CommandState::Completed,
            Some(&json!({"user_code": "not-a-device-code"})),
            None,
            None,
        )
        .unwrap();
}

fn stored_result(registry: &mut Registry, command_id: &str) -> Value {
    match registry
        .admit_remote_command(command_id, "credentials.authorize", None, "digest-old")
        .unwrap()
    {
        CommandAdmission::Duplicate(record) => record.response_payload.unwrap(),
        other => panic!("expected a duplicate, got {other:?}"),
    }
}

#[test]
fn opening_the_registry_removes_a_stored_device_code_from_history_and_from_disk() {
    let root = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    {
        let mut registry = Registry::open(root.path()).unwrap();
        registry
            .register_project(
                "prj-assigned",
                workspace.path(),
                None,
                None,
                None,
                RuntimeOwnership::ManagedContainer,
            )
            .unwrap();
        registry
            .set_project_credential("prj-assigned", Some(ID))
            .unwrap();
        seed_history_with_a_device_code(&mut registry);
    }
    // The precondition, so the assertion below cannot pass vacuously.
    let before = on_disk(root.path());
    assert!(holds(&before, CODE), "the seeded code is not on disk");

    let mut registry = Registry::open(root.path()).unwrap();

    let after = on_disk(root.path());
    assert!(!holds(&after, CODE), "the device code is still on disk");
    assert!(
        !holds(&after, LINK),
        "the verification link is still on disk"
    );

    // A redelivered command replays the redacted shape, never the code.
    let replayed = stored_result(&mut registry, "cmd-old");
    assert_eq!(replayed["redacted"], "device_authorization");
    assert_eq!(replayed["safe_metadata"]["credential_id"], ID);
    assert!(replayed.get("user_code").is_none());
    assert!(replayed.get("verification_uri").is_none());

    // Both outbox entries, delivered and pending, carry the same redacted shape.
    let pending = registry.pending_outbox(10).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(
        pending[0].payload["result"]["redacted"],
        "device_authorization"
    );
    assert_eq!(
        pending[0].payload["result"]["safe_metadata"]["credential_id"],
        ID
    );

    // Nothing else moved.
    match registry
        .admit_remote_command("cmd-other", "runs.get", None, "digest-other")
        .unwrap()
    {
        CommandAdmission::Duplicate(record) => assert_eq!(
            record.response_payload.unwrap(),
            json!({"user_code": "not-a-device-code"})
        ),
        other => panic!("expected a duplicate, got {other:?}"),
    }
    let project = registry.project("prj-assigned").unwrap().unwrap();
    assert_eq!(project.credential_id.as_deref(), Some(ID));

    // Idempotent: nothing left to do, and nothing done.
    let again = registry.scrub_device_authorization_history().unwrap();
    assert_eq!(again.commands + again.outbox_entries, 0);
}

#[test]
fn the_new_path_never_writes_a_device_code_to_the_registry() {
    let root = tempfile::tempdir().unwrap();
    {
        let mut registry = Registry::open(root.path()).unwrap();
        let delivery = DeviceDelivery::new(
            "cmd-new",
            ID,
            &DeviceCode {
                verification_uri: LINK.to_owned(),
                user_code: CODE.to_owned(),
                expires_in_seconds: 900,
            },
        );
        registry
            .admit_remote_command("cmd-new", "credentials.authorize", None, "digest-new")
            .unwrap();
        let record = registry
            .complete_remote_command(
                "cmd-new",
                CommandState::Completed,
                Some(&delivery.durable_result()),
                None,
                None,
            )
            .unwrap();
        registry
            .enqueue_outbox(
                OUTBOX_COMMAND_RESULT,
                Some("cmd-new"),
                &json!({"command_id": "cmd-new", "state": "completed", "result": record.response_payload}),
            )
            .unwrap();
        // The frame is the only place the pair exists, and it stays in memory.
        assert_eq!(delivery.frame_payload()["user_code"], CODE);
        assert!(!holds(&on_disk(root.path()), CODE));
    }
    let bytes = on_disk(root.path());
    assert!(!holds(&bytes, CODE));
    assert!(!holds(&bytes, LINK));
    assert!(holds(&bytes, ID), "the safe credential id is kept");
}
