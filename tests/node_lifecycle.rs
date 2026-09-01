//! `node install`, `node update` and `node repair`, run as processes.
//!
//! These assert the refusals rather than a successful installation: a real
//! install needs root, a Control Plane and half a gigabyte of network, and the
//! clean-host acceptance covers that on a disposable machine. What matters here
//! is that the verbs cannot be used wrongly in silence — each refusal has its
//! own exit code, because the bootstrap script and any agent driving these read
//! the number rather than the sentence.

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_asterism-node");

fn lifecycle(verb: &str, prefix: &Path, extra: &[&str]) -> std::process::Output {
    run(verb, prefix, extra, None)
}

/// `code` is written to stdin, which is how `--code-stdin` receives it. It is a
/// throwaway string: none of these tests reach a Control Plane.
fn run(verb: &str, prefix: &Path, extra: &[&str], code: Option<&str>) -> std::process::Output {
    let mut command = Command::new(BIN);
    command
        .args(["node", verb])
        .args(extra)
        .env("ASTERISM_PREFIX", prefix)
        // Never inherited from whoever runs the tests: a stray value would make
        // the process try to reach a real Control Plane.
        .env_remove("ASTERISM_CONTROL_PLANE");
    match code {
        Some(_) => command.stdin(Stdio::piped()),
        None => command.stdin(Stdio::null()),
    };
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the lifecycle command must run");
    if let Some(code) = code {
        use std::io::Write;
        child
            .stdin
            .as_mut()
            .expect("stdin must be piped")
            .write_all(format!("{code}\n").as_bytes())
            .unwrap();
    }
    child.wait_with_output().expect("the command must finish")
}

fn installed_host(root: &Path) {
    for (path, contents, mode) in [
        ("usr/local/bin/asterism-node", "binary", 0o755),
        (
            "etc/asterism/asterism.env",
            "ASTERISM_HERMES_API_KEY=x\n",
            0o640,
        ),
    ] {
        let path = root.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, contents).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
    }
    std::fs::create_dir_all(root.join("etc/systemd/system")).unwrap();
}

#[test]
fn installing_over_an_installation_is_refused_with_its_own_code() {
    let root = tempfile::tempdir().unwrap();
    installed_host(root.path());

    let output = lifecycle(
        "install",
        root.path(),
        &["--control-plane", "https://example.invalid"],
    );
    // Not 4, and not a silent reinstall over a working host: the operator is
    // told which of `update` and `repair` they meant.
    assert_eq!(output.status.code(), Some(6));
    let text = String::from_utf8_lossy(&output.stderr);
    assert!(text.contains("node update"), "{text}");
    assert!(text.contains("node repair"), "{text}");
}

#[test]
fn updating_a_host_with_nothing_installed_is_refused_with_its_own_code() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join("etc/systemd/system")).unwrap();

    for verb in ["update", "repair"] {
        let output = lifecycle(
            verb,
            root.path(),
            &["--control-plane", "https://example.invalid"],
        );
        assert_eq!(output.status.code(), Some(5), "{verb}");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("node install"),
            "{verb}"
        );
    }
}

#[test]
fn an_install_without_a_control_plane_says_so_rather_than_guessing_one() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join("etc/systemd/system")).unwrap();

    let output = lifecycle("install", root.path(), &[]);
    assert_eq!(output.status.code(), Some(2));
    let text = String::from_utf8_lossy(&output.stderr);
    assert!(text.contains("--control-plane"), "{text}");
}

#[test]
fn a_host_without_systemd_is_refused_before_anything_is_downloaded() {
    let root = tempfile::tempdir().unwrap();
    // No /etc/systemd/system. Reaching the download would mean the host check
    // happened too late to be worth making.
    let output = run(
        "install",
        root.path(),
        &["--control-plane", "https://example.invalid", "--code-stdin"],
        Some("throwaway-code"),
    );
    assert_eq!(output.status.code(), Some(3));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("systemd"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn an_install_with_no_code_at_all_is_a_usage_error_rather_than_a_crash() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join("etc/systemd/system")).unwrap();

    let output = lifecycle(
        "install",
        root.path(),
        &["--control-plane", "https://example.invalid", "--code-stdin"],
    );
    assert_eq!(output.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("connection code"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn the_connection_code_is_never_accepted_as_an_argument() {
    // There is no `--code`, and there must never be one: an argument is visible
    // in the process table and in shell history for as long as it runs.
    let output = Command::new(BIN)
        .args(["node", "install", "--help"])
        .output()
        .expect("help must run");
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("--code-stdin"), "{text}");
    assert!(
        !text.contains("--code <"),
        "the code must not be a command-line value"
    );
}
