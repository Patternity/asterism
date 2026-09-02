//! What the host looks like, and whether it can run a Node.
//!
//! Read-only by construction. Nothing here creates, writes, starts or stops
//! anything: a diagnostic that repairs cannot be run safely on a machine that is
//! already misbehaving, and one that mutates cannot be trusted to describe what
//! it found.
//!
//! Every path it looks at comes from [`HostPaths`], so the same code inspects a
//! real machine and a temporary directory in a test. That is the only reason the
//! checks below are testable at all without root.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Stable process exit codes.
///
/// A coding agent driving these commands needs to distinguish "this host will
/// never work" from "try again" without reading English, so the number is part
/// of the interface and does not change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum ExitCode {
    Ok = 0,
    /// The command was called wrongly.
    Usage = 2,
    /// This host cannot run a Node: wrong OS, wrong architecture, no systemd.
    Unsupported = 3,
    /// Checks ran and something is wrong.
    Degraded = 4,
    /// Asked to act on an installation that is not there.
    NotInstalled = 5,
    /// Asked to install over an installation that already exists.
    AlreadyInstalled = 6,
    /// A downloaded artifact did not match its digest or signature.
    VerificationFailed = 7,
    /// Stopped part-way by a signal.
    Interrupted = 8,
}

impl ExitCode {
    pub fn code(self) -> i32 {
        self as i32
    }
}

/// Where everything lives.
///
/// `prefix` exists for the same reason the shell installer's does: the tests
/// drive the real functions against a temporary root rather than a fake
/// filesystem, so what they exercise is the code that runs on a host.
#[derive(Debug, Clone)]
pub struct HostPaths {
    pub prefix: PathBuf,
}

impl Default for HostPaths {
    fn default() -> Self {
        Self {
            prefix: PathBuf::new(),
        }
    }
}

impl HostPaths {
    pub fn with_prefix(prefix: impl Into<PathBuf>) -> Self {
        Self {
            prefix: prefix.into(),
        }
    }

    fn at(&self, absolute: &str) -> PathBuf {
        if self.prefix.as_os_str().is_empty() {
            PathBuf::from(absolute)
        } else {
            self.prefix.join(absolute.trim_start_matches('/'))
        }
    }

    pub fn node_binary(&self) -> PathBuf {
        self.at("/usr/local/bin/asterism-node")
    }
    pub fn env_file(&self) -> PathBuf {
        self.at("/etc/asterism/asterism.env")
    }
    pub fn state_root(&self) -> PathBuf {
        self.at("/var/lib/asterism")
    }
    pub fn hermes_home(&self) -> PathBuf {
        self.at("/var/lib/asterism/hermes")
    }
    pub fn project_root(&self) -> PathBuf {
        self.at("/var/lib/asterism/projects")
    }
    pub fn hermes_project_home_root(&self) -> PathBuf {
        self.at("/var/lib/asterism/hermes-projects")
    }
    pub fn worker_template(&self) -> PathBuf {
        self.at("/etc/systemd/system/asterism-hermes@.service")
    }
    pub fn node_unit(&self) -> PathBuf {
        self.at("/etc/systemd/system/asterism-node.service")
    }
    pub fn sudoers_policy(&self) -> PathBuf {
        self.at("/etc/sudoers.d/asterism-node")
    }
    pub fn shared_provider_credential(&self) -> PathBuf {
        self.at("/var/lib/asterism/hermes/auth.json")
    }
    pub fn etc_dir(&self) -> PathBuf {
        self.at("/etc/asterism")
    }
    pub fn opt_dir(&self) -> PathBuf {
        self.at("/opt/asterism")
    }
    pub fn hermes_dir(&self) -> PathBuf {
        self.at("/opt/asterism/hermes")
    }
    pub fn codex_dir(&self) -> PathBuf {
        self.at("/opt/asterism/codex")
    }
    /// What `--node-home` is given, and what `ASTERISM_NODE_HOME` holds.
    ///
    /// The state root itself, not the `node/` directory inside it: the Node
    /// creates and hardens that subdirectory for its own configuration and
    /// identity. Pointing `--node-home` at the subdirectory instead makes the
    /// daemon look for its identity one level below where enrolment wrote it,
    /// and the two names existing separately here is what keeps that straight.
    pub fn node_home(&self) -> PathBuf {
        self.at("/var/lib/asterism")
    }
    /// Where the Node keeps its configuration and identity, inside its home.
    pub fn node_state_dir(&self) -> PathBuf {
        self.at("/var/lib/asterism/node")
    }
    pub fn workspace(&self) -> PathBuf {
        self.at("/srv/asterism/workspace")
    }
    pub fn hermes_unit(&self) -> PathBuf {
        self.at("/etc/systemd/system/asterism-hermes.service")
    }
    /// The host's own Codex credential, outside every runtime's home.
    pub fn codex_root(&self) -> PathBuf {
        self.at("/var/lib/asterism/codex")
    }
    pub fn codex_auth(&self) -> PathBuf {
        self.at("/var/lib/asterism/codex/auth.json")
    }
    /// Where the legacy runtime has always kept it, and where an already
    /// authorized host still has one.
    pub fn legacy_codex_home(&self) -> PathBuf {
        self.at("/var/lib/asterism/hermes/.codex")
    }
    pub fn legacy_codex_auth(&self) -> PathBuf {
        self.at("/var/lib/asterism/hermes/.codex/auth.json")
    }
    pub fn hermes_config(&self) -> PathBuf {
        self.at("/var/lib/asterism/hermes/config.yaml")
    }
    pub fn systemd_dir(&self) -> PathBuf {
        self.at("/etc/systemd/system")
    }
}

/// How a single check came out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Ok,
    /// True but not fatal: something an operator should know and may not need
    /// to act on.
    Warn,
    Fail,
}

#[derive(Debug, Clone, Serialize)]
pub struct Check {
    /// Stable identifier. The sentence may be reworded; this may not.
    pub id: &'static str,
    pub outcome: Outcome,
    /// One sentence for a person. Never carries a credential.
    pub detail: String,
}

impl Check {
    fn ok(id: &'static str, detail: impl Into<String>) -> Self {
        Self {
            id,
            outcome: Outcome::Ok,
            detail: detail.into(),
        }
    }
    fn warn(id: &'static str, detail: impl Into<String>) -> Self {
        Self {
            id,
            outcome: Outcome::Warn,
            detail: detail.into(),
        }
    }
    fn fail(id: &'static str, detail: impl Into<String>) -> Self {
        Self {
            id,
            outcome: Outcome::Fail,
            detail: detail.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct HostReport {
    pub installed: bool,
    pub checks: Vec<Check>,
}

impl HostReport {
    pub fn failed(&self) -> usize {
        self.checks
            .iter()
            .filter(|check| check.outcome == Outcome::Fail)
            .count()
    }

    pub fn warned(&self) -> usize {
        self.checks
            .iter()
            .filter(|check| check.outcome == Outcome::Warn)
            .count()
    }

    /// What the process should exit with.
    ///
    /// A host with nothing installed is not a broken host; it is a host waiting
    /// for `install`, and saying so with its own code is what lets an agent tell
    /// the two apart.
    pub fn exit_code(&self) -> ExitCode {
        if !self.installed {
            return ExitCode::NotInstalled;
        }
        if self.failed() > 0 {
            ExitCode::Degraded
        } else {
            ExitCode::Ok
        }
    }
}

/// Read the host and describe it.
pub fn inspect(paths: &HostPaths) -> HostReport {
    let mut checks = Vec::new();

    let node_binary = paths.node_binary();
    let env_file = paths.env_file();
    let installed = node_binary.exists() && env_file.exists();

    if installed {
        checks.push(Check::ok("node_binary", "the Node binary is installed"));
    } else if node_binary.exists() {
        checks.push(Check::fail(
            "installation",
            "a Node binary is present but its configuration is missing",
        ));
    } else {
        checks.push(Check::warn(
            "installation",
            "no Asterism installation on this host",
        ));
        return HostReport { installed, checks };
    }

    // Mode before contents, always. This file carries the Hermes API key, so the
    // check is that nobody else can read it — never what is in it.
    checks.push(match file_mode(&env_file) {
        Some(mode) if mode & 0o007 == 0 => Check::ok(
            "credentials_mode",
            format!("the credentials file is {mode:o}, closed to other accounts"),
        ),
        Some(mode) => Check::fail(
            "credentials_mode",
            format!("the credentials file is {mode:o}, readable beyond its owner"),
        ),
        None => Check::fail("credentials_mode", "the credentials file cannot be read"),
    });

    for (id, path, label) in [
        (
            "project_root",
            paths.project_root(),
            "project workspaces root",
        ),
        (
            "hermes_project_home_root",
            paths.hermes_project_home_root(),
            "project Hermes homes root",
        ),
    ] {
        checks.push(directory_check(id, &path, label));
    }

    checks.push(managed_file_check(
        "worker_template",
        &paths.worker_template(),
        0o644,
        "the per-project worker template",
    ));
    checks.push(managed_file_check(
        "worker_policy",
        &paths.sudoers_policy(),
        0o440,
        "the Node worker policy",
    ));

    // The escalation the policy grants is only reachable while the Node's own
    // sandbox permits a setuid transition, and the directive that forbids it can
    // arrive implied by another. Reading the unit is the cheap check; the
    // running process is the true one and belongs to the live doctor.
    checks.push(match std::fs::read_to_string(paths.node_unit()) {
        Ok(unit) => {
            let offending: Vec<&str> = ["NoNewPrivileges", "ProtectKernelTunables"]
                .into_iter()
                .filter(|directive| {
                    unit.lines()
                        .any(|line| line.trim_start().starts_with(directive))
                })
                .collect();
            if offending.is_empty() {
                Check::ok(
                    "escalation_permitted",
                    "the Node unit permits the sudo rule its workers depend on",
                )
            } else {
                Check::fail(
                    "escalation_permitted",
                    format!(
                        "the Node unit sets {}, which forbids the sudo rule its workers depend on",
                        offending.join(" and ")
                    ),
                )
            }
        }
        Err(_) => Check::fail("escalation_permitted", "the Node unit is missing"),
    });

    // Hermes writes this when the provider is first authorized, so a correctly
    // installed host can legitimately not have one yet. Reported, never read.
    checks.push(if paths.shared_provider_credential().exists() {
        Check::ok(
            "provider_credential",
            "a shared provider credential is present",
        )
    } else {
        Check::warn(
            "provider_credential",
            "no shared provider credential yet; a new project would have none",
        )
    });

    HostReport { installed, checks }
}

fn directory_check(id: &'static str, path: &Path, label: &str) -> Check {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return Check::fail(id, format!("the {label} is missing")),
    };
    if metadata.file_type().is_symlink() {
        return Check::fail(id, format!("the {label} is a symlink"));
    }
    if !metadata.is_dir() {
        return Check::fail(id, format!("the {label} is not a directory"));
    }
    let mode = mode_of(&metadata);
    if mode & 0o007 != 0 {
        return Check::fail(
            id,
            format!("the {label} is {mode:o}, readable by every account on the host"),
        );
    }
    Check::ok(id, format!("the {label} is {mode:o}"))
}

fn managed_file_check(id: &'static str, path: &Path, expected: u32, label: &str) -> Check {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return Check::fail(id, format!("{label} is not installed")),
    };
    if !metadata.is_file() {
        return Check::fail(id, format!("{label} is not a regular file"));
    }
    let mode = mode_of(&metadata);
    if mode != expected {
        return Check::fail(id, format!("{label} is {mode:o}, expected {expected:o}"));
    }
    Check::ok(id, format!("{label} is installed ({mode:o})"))
}

fn mode_of(metadata: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o777
}

fn file_mode(path: &Path) -> Option<u32> {
    std::fs::symlink_metadata(path).ok().map(|m| mode_of(&m))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "x").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    fn directory(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(path).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    /// A host with a complete installation, so each test can break one thing.
    fn healthy(root: &Path) -> HostPaths {
        let paths = HostPaths::with_prefix(root);
        touch(&paths.node_binary(), 0o755);
        touch(&paths.env_file(), 0o640);
        directory(&paths.project_root(), 0o700);
        directory(&paths.hermes_project_home_root(), 0o700);
        touch(&paths.worker_template(), 0o644);
        touch(&paths.sudoers_policy(), 0o440);
        std::fs::write(
            paths.node_unit(),
            "[Service]\nUser=asterism\nPrivateTmp=yes\n",
        )
        .unwrap();
        touch(&paths.shared_provider_credential(), 0o600);
        paths
    }

    #[test]
    fn a_host_with_nothing_on_it_is_waiting_rather_than_broken() {
        let root = tempfile::tempdir().unwrap();
        let report = inspect(&HostPaths::with_prefix(root.path()));

        assert!(!report.installed);
        assert_eq!(report.exit_code(), ExitCode::NotInstalled);
        // And it says so once, rather than listing everything a missing
        // installation is missing.
        assert_eq!(report.checks.len(), 1);
    }

    #[test]
    fn a_complete_installation_passes() {
        let root = tempfile::tempdir().unwrap();
        let report = inspect(&healthy(root.path()));

        assert!(report.installed);
        assert_eq!(report.failed(), 0, "{:?}", report.checks);
        assert_eq!(report.exit_code(), ExitCode::Ok);
    }

    #[test]
    fn a_credentials_file_others_can_read_is_a_failure() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        std::fs::set_permissions(paths.env_file(), std::fs::Permissions::from_mode(0o644)).unwrap();

        let report = inspect(&paths);
        let check = report
            .checks
            .iter()
            .find(|check| check.id == "credentials_mode")
            .unwrap();
        assert_eq!(check.outcome, Outcome::Fail);
        assert_eq!(report.exit_code(), ExitCode::Degraded);
    }

    #[test]
    fn a_world_readable_project_root_is_a_failure() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        std::fs::set_permissions(
            paths.hermes_project_home_root(),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();

        let report = inspect(&paths);
        let check = report
            .checks
            .iter()
            .find(|check| check.id == "hermes_project_home_root")
            .unwrap();
        assert_eq!(check.outcome, Outcome::Fail);
        // The reason is in the sentence, because "check failed" is not a reason.
        assert!(check.detail.contains("every account"));
    }

    #[test]
    fn a_symlinked_project_root_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        let elsewhere = root.path().join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::remove_dir_all(paths.project_root()).unwrap();
        std::os::unix::fs::symlink(&elsewhere, paths.project_root()).unwrap();

        let report = inspect(&paths);
        let check = report
            .checks
            .iter()
            .find(|check| check.id == "project_root")
            .unwrap();
        assert_eq!(check.outcome, Outcome::Fail);
        assert!(check.detail.contains("symlink"));
    }

    #[test]
    fn the_worker_policy_must_have_exactly_its_mode() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        std::fs::set_permissions(
            paths.sudoers_policy(),
            std::fs::Permissions::from_mode(0o444),
        )
        .unwrap();

        let report = inspect(&paths);
        let check = report
            .checks
            .iter()
            .find(|check| check.id == "worker_policy")
            .unwrap();
        assert_eq!(check.outcome, Outcome::Fail);
    }

    #[test]
    fn a_unit_that_forbids_the_sudo_rule_is_named_precisely() {
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        // Both spellings of the same mistake: one explicit, one implied.
        std::fs::write(
            paths.node_unit(),
            "[Service]\nUser=asterism\nProtectKernelTunables=yes\n",
        )
        .unwrap();

        let report = inspect(&paths);
        let check = report
            .checks
            .iter()
            .find(|check| check.id == "escalation_permitted")
            .unwrap();
        assert_eq!(check.outcome, Outcome::Fail);
        assert!(check.detail.contains("ProtectKernelTunables"));
    }

    #[test]
    fn a_missing_provider_credential_is_reported_but_not_a_failure() {
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        std::fs::remove_file(paths.shared_provider_credential()).unwrap();

        let report = inspect(&paths);
        let check = report
            .checks
            .iter()
            .find(|check| check.id == "provider_credential")
            .unwrap();
        // Hermes writes it on first authorization, so a correctly installed host
        // can legitimately not have one yet.
        assert_eq!(check.outcome, Outcome::Warn);
        assert_eq!(report.exit_code(), ExitCode::Ok);
    }

    #[test]
    fn no_check_ever_reads_a_credential() {
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        std::fs::write(paths.env_file(), "API_SERVER_KEY=a-real-looking-secret\n").unwrap();
        std::fs::write(
            paths.shared_provider_credential(),
            "{\"access_token\":\"another-secret\"}",
        )
        .unwrap();

        let rendered = serde_json::to_string(&inspect(&paths)).unwrap();
        assert!(!rendered.contains("a-real-looking-secret"));
        assert!(!rendered.contains("another-secret"));
        assert!(!rendered.contains("API_SERVER_KEY"));
    }

    #[test]
    fn exit_codes_are_stable_numbers() {
        // An agent reads the number, not the name, and a renumbering would
        // silently change what every caller believes happened.
        assert_eq!(ExitCode::Ok.code(), 0);
        assert_eq!(ExitCode::Usage.code(), 2);
        assert_eq!(ExitCode::Unsupported.code(), 3);
        assert_eq!(ExitCode::Degraded.code(), 4);
        assert_eq!(ExitCode::NotInstalled.code(), 5);
        assert_eq!(ExitCode::AlreadyInstalled.code(), 6);
        assert_eq!(ExitCode::VerificationFailed.code(), 7);
        assert_eq!(ExitCode::Interrupted.code(), 8);
    }
}
