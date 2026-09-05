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

/// The Hermes profiles this Node has provisioned, from its registry.
///
/// One source of truth for what a project is. A host with no registry yet has
/// no projects — that is an installation that has not provisioned anything, not
/// a fault — but a registry that exists and cannot be read is reported as one.
fn registered_profiles(paths: &HostPaths) -> Result<Vec<String>, String> {
    let node_home = paths.node_home();
    if !crate::registry::Registry::path_for(&node_home).exists() {
        return Ok(Vec::new());
    }
    let registry =
        crate::registry::Registry::open(&node_home).map_err(|error| error.to_string())?;
    let workers = crate::workers::managed_workers(&registry).map_err(|error| error.to_string())?;
    Ok(workers.into_iter().map(|worker| worker.profile).collect())
}

/// Whether each project reads the host credential through a link.
///
/// The projects come from the registry, which is the only place that knows
/// which profiles this Node created. Listing the directory instead answered
/// with whatever happened to be sitting there: the security scanner's
/// `.local/share/tirith` and the Codex CLI's `.codex/tmp` are written by
/// processes whose `HOME` points into that root, and both became "projects"
/// with a missing credential link. The result was a permanent red check on a
/// healthy host, advising a `node repair` that could not fix it — because there
/// was nothing to fix.
///
/// Nothing here is an exception for two known names. A directory is a project
/// when the registry says so, and otherwise it is not, whatever it is called.
/// A registered profile whose link is missing or wrong is still a failure: that
/// is the fault this check exists to find.
fn credential_reference_check(paths: &HostPaths) -> Check {
    let canonical = paths.shared_provider_credential();
    let root = paths.hermes_project_home_root();

    let profiles = match registered_profiles(paths) {
        Ok(profiles) => profiles,
        // A registry that cannot be read is its own fault, and a louder one
        // than a credential link: say so rather than reporting "no projects".
        Err(error) => {
            return Check::fail(
                "credential_reference",
                format!("cannot read the project registry: {error}"),
            );
        }
    };

    let mut wrong = Vec::new();
    let mut checked = 0usize;
    for profile in profiles {
        let home = root.join(&profile);
        checked += 1;
        // `auth.json`, not `.codex/auth.json`. The second is the Codex CLI's
        // session, which a `hermes-loop` run never reads; checking it passed a
        // host whose workers could not reach the credential they actually use.
        let reference = home.join("auth.json");
        let Ok(metadata) = std::fs::symlink_metadata(&reference) else {
            wrong.push(profile);
            continue;
        };
        if !metadata.file_type().is_symlink() {
            // A real file here is a project pinned to a copy of a credential the
            // host may already have replaced -- and a second copy of a secret
            // that was meant to exist once.
            wrong.push(profile);
            continue;
        }
        // And pointing at the host's file rather than at some other one.
        match std::fs::read_link(&reference) {
            Ok(target) if target == canonical => {}
            _ => wrong.push(profile),
        }
    }

    if checked == 0 {
        return Check::ok("credential_reference", "no project homes on this host yet");
    }
    if wrong.is_empty() {
        Check::ok(
            "credential_reference",
            format!("all {checked} project(s) reach the host provider credential"),
        )
    } else {
        Check::fail(
            "credential_reference",
            format!(
                "shared credential reference invalid for {}; `node repair` restores it",
                wrong.join(", ")
            ),
        )
    }
}

/// Whether the SQLite compatibility layer is installed at all.
fn sqlite_shim_check(paths: &HostPaths) -> Check {
    let venv = paths.hermes_dir().join(".venv/lib");
    let Ok(entries) = std::fs::read_dir(&venv) else {
        return Check::warn(
            "sqlite_shim",
            "the Hermes environment is not present, so its SQLite cannot be checked",
        );
    };
    for entry in entries.filter_map(Result::ok) {
        let site = entry.path().join("site-packages");
        if !site.is_dir() {
            continue;
        }
        let module = site.join("asterism_sqlite3_shim.py");
        let pth = site.join("zz-asterism-sqlite3.pth");
        if module.is_file() && pth.is_file() {
            return Check::ok("sqlite_shim", "the SQLite compatibility layer is installed");
        }
        return Check::fail(
            "sqlite_shim",
            "SQLite compatibility layer inactive: Hermes will run its state databases \
             without WAL, and concurrent writers will contend",
        );
    }
    Check::warn(
        "sqlite_shim",
        "the Hermes environment has no site-packages, so its SQLite cannot be checked",
    )
}

/// What SQLite Hermes will actually get, asked of the interpreter that runs it.
///
/// The shim being on disk is not the same as it being in effect, and the
/// difference is the whole defect: a host was found serving every Hermes
/// database in `delete` mode with both shim files missing and nothing anywhere
/// saying so. Its SQLite was 3.50.4 -- inside the WAL-reset bug's range -- so
/// Hermes had correctly, silently, fallen back.
///
/// Each way this can be wrong gets its own sentence. "SQLite is not right" sends
/// a reader to the same three-hundred-line install log whichever of these it is.
fn sqlite_runtime_check(paths: &HostPaths) -> Check {
    let python = paths.hermes_dir().join(".venv/bin/python");
    if !python.is_file() {
        return Check::warn(
            "sqlite_runtime",
            "the Hermes interpreter is not installed, so its SQLite cannot be asked",
        );
    }

    // Bounded and unprivileged. `doctor` is run on hosts that are already
    // unwell, and a diagnostic that hangs is one more thing to diagnose.
    let output = std::process::Command::new("timeout")
        .arg("20")
        .arg(&python)
        .arg("-c")
        .arg(SQLITE_PROBE)
        .stdin(std::process::Stdio::null())
        .output();

    let Ok(output) = output else {
        return Check::warn(
            "sqlite_runtime",
            "the Hermes interpreter could not be run, so its SQLite cannot be asked",
        );
    };
    if output.status.code() == Some(124) {
        return Check::fail(
            "sqlite_runtime",
            "the Hermes interpreter did not answer within 20 seconds",
        );
    }
    let report = String::from_utf8_lossy(&output.stdout);
    let report = report.trim();
    if !output.status.success() || report.is_empty() {
        let detail = String::from_utf8_lossy(&output.stderr);
        let detail = detail
            .lines()
            .last()
            .unwrap_or("no output")
            .trim()
            .to_string();
        return Check::fail(
            "sqlite_runtime",
            format!("the Hermes interpreter cannot open a database: {detail}"),
        );
    }

    // driver|version|mode, in that order. Parsed rather than trusted: an
    // interpreter that printed something else is a fail, not a pass.
    let mut fields = report.split('|');
    let (Some(driver), Some(version), Some(mode)) = (fields.next(), fields.next(), fields.next())
    else {
        return Check::fail(
            "sqlite_runtime",
            "the Hermes interpreter did not report its SQLite in a form this can read",
        );
    };

    if driver != "pysqlite3" {
        return Check::fail(
            "sqlite_runtime",
            format!(
                "Hermes reads its databases through {driver} {version}, not the SQLite this \
                 installation supplies; `node repair` reinstalls it"
            ),
        );
    }
    if mode != "wal" {
        return Check::fail(
            "sqlite_runtime",
            format!(
                "SQLite {version} would not hold WAL (it reported {mode}); concurrent \
                 writers will contend and long runs will block each other"
            ),
        );
    }
    Check::ok(
        "sqlite_runtime",
        format!("Hermes uses pysqlite3 {version}, and WAL holds"),
    )
}

/// Asked of the interpreter, printed as one line, never more.
///
/// Reopening is the point: the WAL-reset bug is one where the mode is accepted
/// and then not kept, so a probe that only reads back its own connection would
/// pass on exactly the versions this exists to catch.
const SQLITE_PROBE: &str = "\
import os, sqlite3, tempfile
p = os.path.join(tempfile.mkdtemp(), 'probe.db')
c = sqlite3.connect(p)
c.execute('pragma journal_mode=wal')
c.execute('create table t(x)')
c.commit()
c.close()
mode = sqlite3.connect(p).execute('pragma journal_mode').fetchone()[0]
print('%s|%s|%s' % (sqlite3.__name__, sqlite3.sqlite_version, mode))
";

/// Which journal mode the host's real databases are actually in.
///
/// Not the same question as "can this runtime do WAL", and the difference is
/// where the fault hid. A host was found whose runtime had just been upgraded to
/// a SQLite well past the WAL-reset bug, whose fresh databases would have been
/// WAL, and whose twelve existing ones were all still in `delete` because the
/// mode lives in the file and nothing had revisited it.
///
/// Read from the file header rather than by connecting: byte 18 of every SQLite
/// database is the write format version, and 2 means WAL. It takes no lock,
/// needs no interpreter, and cannot disturb a service that is mid-write.
fn hermes_journal_mode_check(paths: &HostPaths) -> Check {
    let mut roots = vec![paths.hermes_home()];
    if let Ok(entries) = std::fs::read_dir(paths.hermes_project_home_root()) {
        roots.extend(entries.filter_map(Result::ok).map(|entry| entry.path()));
    }

    let mut wal = 0usize;
    let mut rollback = Vec::new();
    for root in roots {
        for database in databases_under(&root) {
            match journal_mode_of(&database) {
                Some(true) => wal += 1,
                Some(false) => rollback.push(database),
                None => {}
            }
        }
    }

    if wal == 0 && rollback.is_empty() {
        return Check::warn(
            "hermes_journal_mode",
            "no Hermes databases yet, so their journal mode cannot be checked",
        );
    }
    if rollback.is_empty() {
        return Check::ok(
            "hermes_journal_mode",
            format!("all {wal} Hermes databases are in WAL"),
        );
    }
    // Named, and counted. "Some databases are wrong" sends a reader looking; the
    // first few names say whether this is the legacy instance, one project, or
    // the whole host.
    let named: Vec<String> = rollback
        .iter()
        .take(3)
        .map(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        })
        .collect();
    Check::fail(
        "hermes_journal_mode",
        format!(
            "{} of {} Hermes databases are still on a rollback journal ({}{}); \
             every writer on this host contends on one lock",
            rollback.len(),
            rollback.len() + wal,
            named.join(", "),
            if rollback.len() > named.len() {
                ", …"
            } else {
                ""
            }
        ),
    )
}

/// Every `.db` under a Hermes home, one level of nesting included: `cron/` keeps
/// its own, and a check that missed it would pass a host that is half converted.
fn databases_under(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return found;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.extension().is_some_and(|extension| extension == "db") {
            found.push(path);
        } else if path.is_dir()
            && let Ok(nested) = std::fs::read_dir(&path)
        {
            found.extend(
                nested
                    .filter_map(Result::ok)
                    .map(|entry| entry.path())
                    .filter(|path| path.extension().is_some_and(|e| e == "db")),
            );
        }
    }
    found
}

/// `Some(true)` for WAL, `Some(false)` for a rollback journal, `None` for a file
/// that is not a SQLite database at all.
///
/// https://sqlite.org/fileformat.html#the_database_header: bytes 0..16 are a
/// fixed string, and byte 18 is the write format version -- 1 legacy, 2 WAL.
fn journal_mode_of(path: &Path) -> Option<bool> {
    use std::io::Read;
    let mut header = [0u8; 20];
    let mut file = std::fs::File::open(path).ok()?;
    file.read_exact(&mut header).ok()?;
    if &header[..16] != b"SQLite format 3\0" {
        return None;
    }
    match header[18] {
        2 => Some(true),
        1 => Some(false),
        _ => None,
    }
}

/// Whether this host holds the credential a run consumes.
///
/// There are two credentials on an installed host and they are not
/// interchangeable. `<hermes home>/auth.json` is the pooled credential a
/// `hermes-loop` run executes against; `<codex root>/auth.json` is the Codex
/// CLI's own ChatGPT session, linked into each runtime's `.codex` home for the
/// separate `codex-app-server` runtime. Different formats, different sizes,
/// different flows.
///
/// This check used to read the second and report the first. A host that had
/// authorized the Codex CLI and nothing else answered "this host holds a
/// provider credential" while every run failed with "No Codex credentials
/// stored" -- a green line standing directly in front of the fault it was there
/// to find. So the presence of a Codex session is now said out loud, and it
/// never makes the result healthy.
///
/// Existence and shape only. Opening the file would put a credential in this
/// process for no reason, and whether the provider still accepts it is a
/// question only a run can answer.
fn provider_credential_check(paths: &HostPaths) -> Check {
    let canonical = paths.shared_provider_credential();
    let codex_only =
        !canonical.exists() && (paths.codex_auth().exists() || paths.legacy_codex_auth().exists());

    let Ok(metadata) = std::fs::symlink_metadata(&canonical) else {
        if codex_only {
            // Named precisely, because the difference is the whole fault: this
            // host has *a* credential and not *the* credential, and an operator
            // who reads "not authorized" while looking at an auth.json they
            // created themselves will reasonably conclude the check is wrong.
            return Check::warn(
                "provider_credential",
                "provider authorization required: this host holds a Codex CLI session, \
                 which a run cannot use. Authorize the provider from the console.",
            );
        }
        // A warning, not a failure: the installation is correct and complete.
        // What it cannot do is execute a model run, and the sentence says so
        // rather than describing the host as broken.
        return Check::warn(
            "provider_credential",
            "provider authorization required: no model credential, so runs cannot execute",
        );
    };

    if !metadata.is_file() {
        return Check::fail(
            "provider_credential",
            format!(
                "{} is not a regular file; the host credential must be the file itself, \
                 not a link to one",
                canonical.display()
            ),
        );
    }
    if metadata.len() == 0 {
        return Check::fail(
            "provider_credential",
            "the host provider credential is empty; authorize the provider again",
        );
    }
    let mode = std::os::unix::fs::PermissionsExt::mode(&metadata.permissions()) & 0o777;
    if mode & 0o077 != 0 {
        return Check::fail(
            "provider_credential",
            format!("the host provider credential is {mode:o}; it must not be readable by others"),
        );
    }
    Check::ok(
        "provider_credential",
        "this host holds the provider credential a run consumes",
    )
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

    checks.push(provider_credential_check(paths));

    // Every project reads the host credential through a reference of its own. A
    // reference that is a real file instead of a link is a project pinned to a
    // credential the host may already have replaced.
    checks.push(credential_reference_check(paths));

    // The compatibility layer that supplies a SQLite past the WAL-reset bug. Its
    // absence is not cosmetic: Hermes then turns WAL off, and every Hermes writer
    // on the host contends on one lock.
    checks.push(sqlite_shim_check(paths));
    checks.push(sqlite_runtime_check(paths));
    checks.push(hermes_journal_mode_check(paths));

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
    /// The host provider credential, with bytes in it and closed to others.
    /// Never real material: the checks read metadata and nothing else.
    fn credential(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "{\"pooled\": \"placeholder\"}").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }

    fn provider_check(paths: &HostPaths) -> Check {
        inspect(paths)
            .checks
            .into_iter()
            .find(|check| check.id == "provider_credential")
            .expect("the report must always carry this check")
    }

    /// Register a project and bind it to a profile, which is what makes a
    /// directory under the profile-home root a project at all.
    fn register(paths: &HostPaths, project_id: &str, profile: &str) {
        let node_home = paths.node_home();
        std::fs::create_dir_all(&node_home).unwrap();
        let workspace = paths.project_root().join(project_id);
        std::fs::create_dir_all(&workspace).unwrap();
        let mut registry = crate::registry::Registry::open(&node_home).unwrap();
        registry
            .register_project(
                project_id,
                &workspace,
                None,
                None,
                None,
                crate::inventory::RuntimeOwnership::ManagedContainer,
            )
            .unwrap();
        registry
            .set_profile_runtime(
                project_id,
                &paths
                    .hermes_project_home_root()
                    .join(profile)
                    .to_string_lossy(),
                profile,
                "http://127.0.0.1:18700",
                &node_home.join("key").to_string_lossy(),
                crate::inventory::ProfileState::Ready,
            )
            .unwrap();
    }

    fn reference_check(paths: &HostPaths) -> Check {
        inspect(paths)
            .checks
            .into_iter()
            .find(|check| check.id == "credential_reference")
            .expect("the report must always carry this check")
    }

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
        credential(&paths.shared_provider_credential());
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

    /// A stand-in for the Hermes interpreter that answers exactly what a real
    /// one would, so each way SQLite can be wrong is exercised as a separate
    /// outcome rather than as one "SQLite is not right".
    fn interpreter_answering(paths: &HostPaths, line: &str) {
        use std::os::unix::fs::PermissionsExt;
        let python = paths.hermes_dir().join(".venv/bin/python");
        std::fs::create_dir_all(python.parent().unwrap()).unwrap();
        std::fs::write(&python, format!("#!/bin/sh\nprintf '%s\\n' '{line}'\n")).unwrap();
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn sqlite_runtime_of(paths: &HostPaths) -> Check {
        inspect(paths)
            .checks
            .into_iter()
            .find(|check| check.id == "sqlite_runtime")
            .expect("the report must always carry this check")
    }

    /// A real SQLite header, built by hand so the test does not need SQLite to
    /// test a check that deliberately does not use SQLite.
    fn database_file(path: &Path, wal: bool) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut header = vec![0u8; 100];
        header[..16].copy_from_slice(b"SQLite format 3\0");
        header[18] = if wal { 2 } else { 1 };
        header[19] = header[18];
        std::fs::write(path, header).unwrap();
    }

    fn journal_check_of(paths: &HostPaths) -> Check {
        inspect(paths)
            .checks
            .into_iter()
            .find(|check| check.id == "hermes_journal_mode")
            .expect("the report must always carry this check")
    }

    #[test]
    fn databases_left_on_a_rollback_journal_are_counted_and_named() {
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        // Exactly the shape found on the host: the legacy instance and both
        // projects, every database still on a rollback journal after the runtime
        // that would have supported WAL was installed.
        database_file(&paths.hermes_home().join("state.db"), false);
        database_file(&paths.hermes_home().join("cron/executions.db"), false);
        let project = paths
            .hermes_project_home_root()
            .join("asterism-project-prj-1");
        database_file(&project.join("kanban.db"), false);

        let check = journal_check_of(&paths);
        assert_eq!(check.outcome, Outcome::Fail);
        assert!(check.detail.contains("3 of 3"), "{}", check.detail);
        // The nested one counts too: a check that stopped at the top level would
        // have called a half-converted host healthy.
        assert!(check.detail.contains("executions.db"), "{}", check.detail);
    }

    #[test]
    fn a_host_whose_databases_are_all_wal_passes() {
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        database_file(&paths.hermes_home().join("state.db"), true);
        database_file(&paths.hermes_home().join("cron/executions.db"), true);
        database_file(
            &paths
                .hermes_project_home_root()
                .join("asterism-project-prj-1/kanban.db"),
            true,
        );

        let check = journal_check_of(&paths);
        assert_eq!(check.outcome, Outcome::Ok);
        assert!(check.detail.contains("all 3"), "{}", check.detail);
    }

    #[test]
    fn one_project_left_behind_is_still_a_failure() {
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        database_file(&paths.hermes_home().join("state.db"), true);
        database_file(
            &paths
                .hermes_project_home_root()
                .join("asterism-project-prj-2/state.db"),
            false,
        );

        let check = journal_check_of(&paths);
        assert_eq!(check.outcome, Outcome::Fail);
        assert!(check.detail.contains("1 of 2"), "{}", check.detail);
    }

    #[test]
    fn a_file_that_is_not_a_database_is_ignored_rather_than_judged() {
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        std::fs::create_dir_all(paths.hermes_home()).unwrap();
        std::fs::write(paths.hermes_home().join("notes.db"), "not a database").unwrap();

        // Nothing readable as a database, so the honest answer is that this
        // cannot be checked -- not that the host passed.
        assert_eq!(journal_check_of(&paths).outcome, Outcome::Warn);
    }

    #[test]
    fn the_supplied_sqlite_holding_wal_is_the_only_healthy_answer() {
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        interpreter_answering(&paths, "pysqlite3|3.53.4|wal");

        let check = sqlite_runtime_of(&paths);
        assert_eq!(check.outcome, Outcome::Ok);
        assert!(check.detail.contains("3.53.4"), "{}", check.detail);
    }

    #[test]
    fn falling_back_to_the_interpreters_own_sqlite_is_named_as_that() {
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        // Exactly the production host that prompted this: the shim never
        // installed, so the stdlib driver answers and Hermes never says a word.
        interpreter_answering(&paths, "sqlite3|3.50.4|wal");

        let check = sqlite_runtime_of(&paths);
        assert_eq!(check.outcome, Outcome::Fail);
        assert!(check.detail.contains("sqlite3"), "{}", check.detail);
        assert!(check.detail.contains("repair"), "{}", check.detail);
    }

    #[test]
    fn a_journal_mode_that_does_not_hold_is_a_different_fault_from_the_wrong_driver() {
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        interpreter_answering(&paths, "pysqlite3|3.44.0|delete");

        let check = sqlite_runtime_of(&paths);
        assert_eq!(check.outcome, Outcome::Fail);
        assert!(check.detail.contains("delete"), "{}", check.detail);
        assert!(check.detail.contains("WAL"), "{}", check.detail);
    }

    #[test]
    fn an_interpreter_that_cannot_open_a_database_says_so_rather_than_passing() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        let python = paths.hermes_dir().join(".venv/bin/python");
        std::fs::create_dir_all(python.parent().unwrap()).unwrap();
        std::fs::write(
            &python,
            "#!/bin/sh\necho 'ImportError: no _sqlite3' >&2\nexit 1\n",
        )
        .unwrap();
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).unwrap();

        let check = sqlite_runtime_of(&paths);
        assert_eq!(check.outcome, Outcome::Fail);
        assert!(check.detail.contains("ImportError"), "{}", check.detail);
    }

    #[test]
    fn a_host_with_no_interpreter_is_unknown_rather_than_broken() {
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());

        let check = sqlite_runtime_of(&paths);
        assert_eq!(check.outcome, Outcome::Warn);
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

    /// A project pinned to its own copy of a credential the host may already
    /// have replaced. The doctor has to name it, because nothing else will:
    /// the worker starts, reports healthy, and fails only when a model is asked
    /// for.
    #[test]
    fn a_project_holding_its_own_credential_file_is_named() {
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        register(&paths, "prj-one", "project-one");
        let home = paths.hermes_project_home_root().join("project-one/.codex");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("auth.json"), "a private copy").unwrap();

        let report = inspect(&paths);
        let check = report
            .checks
            .iter()
            .find(|check| check.id == "credential_reference")
            .expect("the reference must be checked");
        assert_eq!(check.outcome, Outcome::Fail);
        assert!(check.detail.contains("project-one"), "{}", check.detail);
        assert!(check.detail.contains("node repair"), "{}", check.detail);
    }

    /// The regression. `.codex/tmp` and `.local/share/tirith` are written by
    /// processes whose `HOME` points into the profile-home root; before this
    /// they were counted as projects, and their missing credential link turned
    /// a healthy host permanently red with advice that could not help.
    #[test]
    fn service_directories_beside_the_profile_homes_are_not_projects() {
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        register(&paths, "prj-one", "project-one");
        let home = paths.hermes_project_home_root().join("project-one");
        std::fs::create_dir_all(&home).unwrap();
        std::os::unix::fs::symlink(paths.shared_provider_credential(), home.join("auth.json"))
            .unwrap();

        // Exactly what node-1 carried, plus one nobody has seen: the fix is not
        // an exception list for two known names.
        let stray = paths.hermes_project_home_root();
        std::fs::create_dir_all(stray.join(".codex/tmp")).unwrap();
        std::fs::create_dir_all(stray.join(".local/share/tirith")).unwrap();
        std::fs::create_dir_all(stray.join("something-nobody-registered")).unwrap();

        let check = reference_check(&paths);
        assert_eq!(check.outcome, Outcome::Ok, "{}", check.detail);
        for name in [".codex", ".local", "something-nobody-registered"] {
            assert!(!check.detail.contains(name), "{}", check.detail);
        }
    }

    /// A registered project is still diagnosed. The fix narrows what counts as
    /// a project; it does not stop the check finding the fault it exists for.
    #[test]
    fn a_registered_profile_with_a_broken_link_is_still_a_failure() {
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        register(&paths, "prj-one", "project-one");
        std::fs::create_dir_all(paths.hermes_project_home_root().join(".codex/tmp")).unwrap();
        // The profile home was never created at all, which is as broken as a
        // link pointing somewhere else.

        let check = reference_check(&paths);
        assert_eq!(check.outcome, Outcome::Fail);
        assert!(check.detail.contains("project-one"), "{}", check.detail);
        assert!(!check.detail.contains(".codex"), "{}", check.detail);
    }

    /// A host that has provisioned nothing has no projects, and that is not a
    /// fault — even when the root is full of whatever else lives there.
    #[test]
    fn a_host_with_no_registered_projects_reports_none() {
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        std::fs::create_dir_all(paths.hermes_project_home_root().join(".codex")).unwrap();
        std::fs::create_dir_all(paths.hermes_project_home_root().join(".local")).unwrap();

        assert_eq!(reference_check(&paths).outcome, Outcome::Ok);
    }

    #[test]
    fn a_project_reaching_the_host_credential_by_link_passes() {
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        register(&paths, "prj-one", "project-one");
        let home = paths.hermes_project_home_root().join("project-one");
        std::fs::create_dir_all(&home).unwrap();
        std::os::unix::fs::symlink(paths.shared_provider_credential(), home.join("auth.json"))
            .unwrap();

        assert_eq!(reference_check(&paths).outcome, Outcome::Ok);
    }

    #[test]
    fn a_project_with_no_reference_at_all_is_named() {
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        register(&paths, "prj-one", "project-one");
        std::fs::create_dir_all(paths.hermes_project_home_root().join("project-one")).unwrap();

        let check = reference_check(&paths);
        assert_eq!(check.outcome, Outcome::Fail);
        assert!(check.detail.contains("project-one"), "{}", check.detail);
    }

    #[test]
    fn a_project_linked_to_the_wrong_file_is_named() {
        // Specifically: linked to the Codex CLI session, which is exactly what a
        // host built by the previous installer looked like.
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        register(&paths, "prj-one", "project-one");
        credential(&paths.codex_auth());
        let home = paths.hermes_project_home_root().join("project-one");
        std::fs::create_dir_all(&home).unwrap();
        std::os::unix::fs::symlink(paths.codex_auth(), home.join("auth.json")).unwrap();

        assert_eq!(reference_check(&paths).outcome, Outcome::Fail);
    }

    /// Losing the compatibility layer is not cosmetic: Hermes then turns WAL off
    /// and every writer on the host contends on one lock. The doctor says which
    /// of those two facts it found rather than reporting "unhealthy".
    #[test]
    fn a_runtime_without_the_sqlite_layer_says_what_that_costs() {
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        std::fs::create_dir_all(
            paths
                .hermes_dir()
                .join(".venv/lib/python3.13/site-packages"),
        )
        .unwrap();

        let report = inspect(&paths);
        let check = report
            .checks
            .iter()
            .find(|check| check.id == "sqlite_shim")
            .expect("the layer must be checked");
        assert_eq!(check.outcome, Outcome::Fail);
        assert!(check.detail.contains("without WAL"), "{}", check.detail);
    }

    #[test]
    fn a_runtime_with_the_sqlite_layer_passes() {
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        let site = paths
            .hermes_dir()
            .join(".venv/lib/python3.13/site-packages");
        std::fs::create_dir_all(&site).unwrap();
        std::fs::write(site.join("asterism_sqlite3_shim.py"), "").unwrap();
        std::fs::write(site.join("zz-asterism-sqlite3.pth"), "").unwrap();

        let report = inspect(&paths);
        let check = report
            .checks
            .iter()
            .find(|check| check.id == "sqlite_shim")
            .unwrap();
        assert_eq!(check.outcome, Outcome::Ok, "{}", check.detail);
    }

    /// The sentence a person reads when the host is installed correctly and
    /// simply has no model credential yet. It must not read as a broken host.
    #[test]
    fn a_host_with_neither_credential_is_told_what_it_cannot_do_rather_than_called_broken() {
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        std::fs::remove_file(paths.shared_provider_credential()).unwrap();

        let check = provider_check(&paths);
        assert_eq!(check.outcome, Outcome::Warn);
        assert!(
            check.detail.contains("runs cannot execute"),
            "{}",
            check.detail
        );
    }

    #[test]
    fn a_codex_session_alone_is_never_an_authorized_provider() {
        // The fault this whole check exists for. A host that authorized the Codex
        // CLI and nothing else answered "this host holds a provider credential"
        // while every run failed with "No Codex credentials stored" -- a green
        // line standing directly in front of the fault it was there to find.
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        std::fs::remove_file(paths.shared_provider_credential()).unwrap();
        credential(&paths.codex_auth());

        let check = provider_check(&paths);
        assert_ne!(check.outcome, Outcome::Ok, "{}", check.detail);
        assert!(
            check.detail.contains("Codex CLI session"),
            "{}",
            check.detail
        );
        assert!(check.detail.contains("console"), "{}", check.detail);
    }

    #[test]
    fn the_same_is_true_of_a_session_left_at_the_legacy_place() {
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        std::fs::remove_file(paths.shared_provider_credential()).unwrap();
        credential(&paths.legacy_codex_auth());

        let check = provider_check(&paths);
        assert_ne!(check.outcome, Outcome::Ok, "{}", check.detail);
        assert!(
            check.detail.contains("Codex CLI session"),
            "{}",
            check.detail
        );
    }

    #[test]
    fn the_canonical_credential_is_recognised() {
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());

        let check = provider_check(&paths);
        assert_eq!(check.outcome, Outcome::Ok, "{}", check.detail);
        assert!(check.detail.contains("a run consumes"), "{}", check.detail);
    }

    #[test]
    fn a_credential_others_can_read_is_a_failure_not_a_pass() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        std::fs::set_permissions(
            paths.shared_provider_credential(),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();

        let check = provider_check(&paths);
        assert_eq!(check.outcome, Outcome::Fail);
        assert!(
            check.detail.contains("readable by others"),
            "{}",
            check.detail
        );
    }

    #[test]
    fn an_empty_credential_is_a_failure_rather_than_a_credential() {
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        std::fs::write(paths.shared_provider_credential(), "").unwrap();

        let check = provider_check(&paths);
        assert_eq!(check.outcome, Outcome::Fail);
        assert!(check.detail.contains("empty"), "{}", check.detail);
    }

    #[test]
    fn the_host_credential_must_be_the_file_and_not_a_link_to_one() {
        // A link here means the host's own copy is somewhere else, and rotating
        // the credential would leave whatever is on the far end of it behind.
        let root = tempfile::tempdir().unwrap();
        let paths = healthy(root.path());
        let elsewhere = root.path().join("elsewhere.json");
        credential(&elsewhere);
        std::fs::remove_file(paths.shared_provider_credential()).unwrap();
        std::os::unix::fs::symlink(&elsewhere, paths.shared_provider_credential()).unwrap();

        let check = provider_check(&paths);
        assert_eq!(check.outcome, Outcome::Fail);
        assert!(check.detail.contains("not a link"), "{}", check.detail);
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
