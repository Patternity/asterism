//! `asterism-node node doctor`, run as a process.
//!
//! The library tests cover what the checks decide. These cover what a caller
//! actually receives: the exit code, which is the part an installing agent reads
//! instead of the English, and the JSON, which is the part it parses.

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_asterism-node");

fn doctor(prefix: &Path, json: bool) -> std::process::Output {
    let mut command = Command::new(BIN);
    command
        .args(["node", "doctor"])
        .env("ASTERISM_PREFIX", prefix);
    if json {
        command.arg("--json");
    }
    command.output().expect("doctor must run")
}

fn touch(path: &Path, mode: u32) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, "x").unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

fn directory(path: &Path, mode: u32) {
    std::fs::create_dir_all(path).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

fn complete_host(root: &Path) {
    touch(&root.join("usr/local/bin/asterism-node"), 0o755);
    touch(&root.join("etc/asterism/asterism.env"), 0o640);
    directory(&root.join("var/lib/asterism/projects"), 0o700);
    directory(&root.join("var/lib/asterism/hermes-projects"), 0o700);
    touch(
        &root.join("etc/systemd/system/asterism-hermes@.service"),
        0o644,
    );
    touch(&root.join("etc/sudoers.d/asterism-node"), 0o440);
    std::fs::write(
        root.join("etc/systemd/system/asterism-node.service"),
        "[Service]\nUser=asterism\nPrivateTmp=yes\n",
    )
    .unwrap();
    touch(&root.join("var/lib/asterism/hermes/auth.json"), 0o600);
}

#[test]
fn a_bare_host_says_so_with_its_own_code() {
    let root = tempfile::tempdir().unwrap();
    let output = doctor(root.path(), false);

    // Not 4. "Nothing is installed" and "the installation is broken" are
    // different situations, and an agent choosing between `install` and `repair`
    // needs to tell them apart without reading the message.
    assert_eq!(output.status.code(), Some(5));
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("node install"), "{text}");
}

#[test]
fn a_complete_host_exits_zero() {
    let root = tempfile::tempdir().unwrap();
    complete_host(root.path());

    let output = doctor(root.path(), false);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("All checks passed"));
}

#[test]
fn a_broken_host_exits_degraded_and_names_what_broke() {
    let root = tempfile::tempdir().unwrap();
    complete_host(root.path());
    // The failure that reached production once: a Node unit whose hardening
    // forbids the escalation its workers depend on.
    std::fs::write(
        root.path().join("etc/systemd/system/asterism-node.service"),
        "[Service]\nUser=asterism\nProtectKernelTunables=yes\n",
    )
    .unwrap();

    let output = doctor(root.path(), false);
    assert_eq!(output.status.code(), Some(4));
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("ProtectKernelTunables"), "{text}");
}

#[test]
fn the_json_form_is_parseable_and_carries_the_same_verdict() {
    let root = tempfile::tempdir().unwrap();
    complete_host(root.path());
    std::fs::set_permissions(
        root.path().join("etc/asterism/asterism.env"),
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();

    let output = doctor(root.path(), true);
    assert_eq!(output.status.code(), Some(4));

    let report: serde_json::Value = serde_json::from_slice(&output.stdout).expect("valid JSON");
    assert_eq!(report["installed"], serde_json::json!(true));
    let checks = report["checks"].as_array().expect("checks array");
    let failing: Vec<&str> = checks
        .iter()
        .filter(|check| check["outcome"] == "fail")
        .filter_map(|check| check["id"].as_str())
        .collect();
    assert_eq!(failing, vec!["credentials_mode"]);
}

#[test]
fn doctor_changes_nothing_on_the_host_it_inspects() {
    let root = tempfile::tempdir().unwrap();
    complete_host(root.path());

    let before = snapshot(root.path());
    doctor(root.path(), false);
    doctor(root.path(), true);
    assert_eq!(before, snapshot(root.path()), "doctor mutated the host");
}

/// Every path under the root with its mode, so a mutation of any kind shows up.
fn snapshot(root: &Path) -> Vec<String> {
    fn walk(dir: &Path, into: &mut Vec<String>) {
        let mut entries: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        entries.sort_by_key(std::fs::DirEntry::path);
        for entry in entries {
            let metadata = entry.metadata().unwrap();
            into.push(format!(
                "{} {:o} {}",
                entry.path().display(),
                metadata.permissions().mode(),
                metadata.len()
            ));
            if metadata.is_dir() {
                walk(&entry.path(), into);
            }
        }
    }
    let mut paths = Vec::new();
    walk(root, &mut paths);
    paths
}
