//! What must be true before an update may call itself finished, and how it puts
//! the previous installation back when that is not so.
//!
//! An installation is three things that have to agree: the Node binary, the
//! runtime tree under it, and the processes actually running from them. The
//! update used to check the first by its own version, never checked the second,
//! and checked the third with one instantaneous look -- which is how node-1 was
//! left with the alpha.30 binary on the alpha.29 runtime while the Control Plane
//! recorded success.
//!
//! [`verify_installation`] checks all three, from evidence rather than from
//! what anything says about itself:
//!
//! * the installed Node binary is byte-identical to the running updater, which
//!   is the target release by its compiled-in tag;
//! * the live runtime tree carries the release marker written from the manifest
//!   this update verified, naming the target version and revision;
//! * the Node, the host Hermes and every project worker that was serving before
//!   the update converge -- active, a stable non-zero MainPID, executing the
//!   live file by inode (see [`crate::convergence`]).
//!
//! The result is [`UpdateEvidence`], which travels to the Control Plane in the
//! journal event for this exact operation. Without it the Control Plane does not
//! call the update successful.
//!
//! When any of it fails, [`restore_previous_installation`] undoes the whole
//! update, not one part of it: the runtime tree, the configuration the update
//! wrote, and the Node binary the first half replaced. It then restarts the
//! services and verifies them on what was restored, and says whether that
//! worked. A new binary over an old runtime is not a state it can leave behind
//! while anything reports success.

use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::convergence::{
    self, Clock, Converged, Expectation, NotConverged, Policy, RestartFailure, Role, Target,
};
use crate::hostsetup::HostPaths;
use crate::nodeinstall::{RuntimeSwap, UNITS};
use crate::workers::{ManagedWorker, ServiceControl};

/// The Node's own unit, which runs the installed binary.
pub const NODE_UNIT: &str = "asterism-node.service";
/// The host-native Hermes, which runs from the runtime tree.
pub const HOST_HERMES_UNIT: &str = "asterism-hermes.service";

/// Carries the digest of the parked previous binary from the first half of an
/// update to the second, so the second restores exactly what the first kept.
pub const PREVIOUS_BINARY_SHA_ENV: &str = "ASTERISM_UPDATE_PREVIOUS_SHA256";

/// At most this many services are named in one failure report.
const MAX_REPORTED: usize = 16;

/// Proof that an update produced one coherent installation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateEvidence {
    pub target_release: String,
    /// The compiled-in release of the binary now installed.
    pub node_release: String,
    /// From the live runtime tree's marker.
    pub runtime_release: String,
    pub runtime_revision: String,
    /// Every service verified, with the process that was proved.
    pub services: Vec<Converged>,
}

/// Which check an update stopped at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailedCheck {
    /// Before verification: fetching, installing, starting.
    Install,
    NodeBinary,
    RuntimeRelease,
    Health,
    Services,
}

/// Whether the previous installation was put back and proved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RollbackOutcome {
    Restored,
    Incomplete,
    NotAttempted,
}

/// The typed account of a failed update. No paths and no command output: it
/// crosses a privilege boundary and then a network.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FailureDetail {
    pub check: FailedCheck,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub services: Vec<NotConverged>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub found_runtime_release: Option<String>,
    pub rollback: RollbackOutcome,
    /// Services that did not converge on the restored installation.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rollback_services: Vec<NotConverged>,
}

/// Why verification failed, with what is needed to report it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerificationFailure {
    NodeBinary(String),
    RuntimeRelease {
        found: Option<String>,
        message: String,
    },
    Services(RestartFailure),
}

impl VerificationFailure {
    pub fn detail(&self, rollback: RollbackOutcome) -> FailureDetail {
        let mut detail = FailureDetail {
            check: FailedCheck::Services,
            services: Vec::new(),
            found_runtime_release: None,
            rollback,
            rollback_services: Vec::new(),
        };
        match self {
            Self::NodeBinary(_) => detail.check = FailedCheck::NodeBinary,
            Self::RuntimeRelease { found, .. } => {
                detail.check = FailedCheck::RuntimeRelease;
                detail.found_runtime_release = found.clone();
            }
            Self::Services(RestartFailure::NotConverged(all)) => {
                detail.services = all.iter().take(MAX_REPORTED).cloned().collect();
            }
            Self::Services(RestartFailure::Refused { .. }) => {}
        }
        detail
    }
}

impl std::fmt::Display for VerificationFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NodeBinary(message) | Self::RuntimeRelease { message, .. } => {
                write!(f, "{message}")
            }
            Self::Services(failure) => write!(f, "services did not converge: {failure}"),
        }
    }
}

/// The release an update is installing, as its verified manifest names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetRelease {
    pub version: String,
    pub revision: String,
}

/// The binary the running updater is, and where it was installed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinaryIdentity {
    /// The file the Node unit executes.
    pub installed: PathBuf,
    /// The file this process is executing.
    pub running_image: PathBuf,
    /// The release this process was compiled as.
    pub running_release: String,
}

impl BinaryIdentity {
    pub fn of_this_process(installed: PathBuf) -> Result<Self> {
        Ok(Self {
            installed,
            running_image: PathBuf::from("/proc/self/exe"),
            running_release: crate::control::software_version().to_owned(),
        })
    }
}

/// Everything the Node, host Hermes and managed workers must be running.
pub fn service_targets(paths: &HostPaths, binary: &Path, workers: &[ManagedWorker]) -> Vec<Target> {
    let mut targets = vec![
        Target {
            unit: NODE_UNIT.to_owned(),
            role: Role::Node,
            expect: Expectation::File(binary.to_path_buf()),
        },
        Target {
            unit: HOST_HERMES_UNIT.to_owned(),
            role: Role::HostHermes,
            expect: Expectation::RuntimeTree(paths.opt_dir()),
        },
    ];
    targets.extend(worker_targets(paths, workers));
    targets
}

fn worker_targets(paths: &HostPaths, workers: &[ManagedWorker]) -> Vec<Target> {
    workers
        .iter()
        .map(|worker| Target {
            unit: worker.unit.clone(),
            role: Role::ProjectWorker {
                project_id: worker.project_id.clone(),
            },
            expect: Expectation::RuntimeTree(paths.opt_dir()),
        })
        .collect()
}

/// Prove the installation is the target release throughout, restarting the
/// displaced project workers onto it on the way.
pub fn verify_installation(
    control: &dyn ServiceControl,
    clock: &dyn Clock,
    policy: Policy,
    paths: &HostPaths,
    target: &TargetRelease,
    binary: &BinaryIdentity,
    displaced: &[ManagedWorker],
) -> Result<UpdateEvidence, VerificationFailure> {
    // The binary: compiled as the target, and the installed file is this one.
    if binary.running_release != target.version {
        return Err(VerificationFailure::NodeBinary(format!(
            "the updater is {} but the update targets {}",
            binary.running_release, target.version
        )));
    }
    let digest = |path: &Path| crate::bundle::sha256_file(path).ok();
    match (digest(&binary.installed), digest(&binary.running_image)) {
        (Some(installed), Some(running)) if installed == running => {}
        _ => {
            return Err(VerificationFailure::NodeBinary(format!(
                "the installed Node binary is not the {} binary",
                target.version
            )));
        }
    }

    // The runtime: the live tree says, by the marker written from the verified
    // manifest, that it is the target.
    let marker = crate::runtimerelease::read(&paths.opt_dir());
    let found = marker.as_ref().ok().and_then(|m| m.as_ref()).cloned();
    match &found {
        Some(release)
            if release.version == target.version && release.source_revision == target.revision => {}
        _ => {
            return Err(VerificationFailure::RuntimeRelease {
                found: found.as_ref().map(|release| release.version.clone()),
                message: format!(
                    "the live runtime is {} rather than {} at {}",
                    found
                        .as_ref()
                        .map_or("unmarked", |release| release.version.as_str()),
                    target.version,
                    target.revision
                ),
            });
        }
    }

    // The processes. The Node and host Hermes were restarted by the update
    // already; the workers are restarted here. All are waited for together.
    for worker in displaced {
        if let Err(error) = control.restart(&worker.unit) {
            return Err(VerificationFailure::Services(RestartFailure::Refused {
                role: Role::ProjectWorker {
                    project_id: worker.project_id.clone(),
                },
                error: format!("{error:#}"),
            }));
        }
    }
    let targets = service_targets(paths, &binary.installed, displaced);
    let services = convergence::converge(control, clock, policy, &targets)
        .map_err(|all| VerificationFailure::Services(RestartFailure::NotConverged(all)))?;

    Ok(UpdateEvidence {
        target_release: target.version.clone(),
        node_release: binary.running_release.clone(),
        runtime_release: target.version.clone(),
        runtime_revision: target.revision.clone(),
        services,
    })
}

/// The Node binary the first half of an update parked, verified by digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviousBinary {
    path: PathBuf,
    sha256: String,
}

impl PreviousBinary {
    /// Where the first half parks the binary it replaces.
    pub fn parked_beside(binary: &Path) -> PathBuf {
        binary.with_extension("previous")
    }

    /// The parked binary, which must exist and, when the first half recorded
    /// its digest, must still match it.
    pub fn find(binary: &Path, recorded_sha256: Option<&str>) -> Result<Self> {
        let path = Self::parked_beside(binary);
        let sha256 = crate::bundle::sha256_file(&path)
            .with_context(|| format!("the previous Node binary {} is missing", path.display()))?;
        if let Some(recorded) = recorded_sha256
            && recorded != sha256
        {
            bail!(
                "the previous Node binary {} is not the one this update parked",
                path.display()
            );
        }
        Ok(Self { path, sha256 })
    }

    /// Put the parked binary back at `binary`, atomically.
    pub fn restore(&self, binary: &Path) -> Result<()> {
        let now = crate::bundle::sha256_file(&self.path)?;
        if now != self.sha256 {
            bail!("the previous Node binary changed after it was parked");
        }
        let staged = binary.with_extension("incoming");
        std::fs::copy(&self.path, &staged)
            .with_context(|| format!("cannot stage {}", staged.display()))?;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))?;
        std::fs::rename(&staged, binary)
            .with_context(|| format!("cannot restore {}", binary.display()))?;
        Ok(())
    }

    pub fn sha256(&self) -> &str {
        &self.sha256
    }
}

/// A file as it was before the update wrote it: its bytes, mode and owner, or
/// its absence.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SavedFile {
    path: PathBuf,
    saved: Option<(Vec<u8>, u32, u32, u32)>,
}

/// The configuration an update rewrites, as it was before.
///
/// Units, the environment file and the sudoers policy are regenerated from the
/// running binary's templates, so they are saved whole. Hermes configurations
/// are not: Hermes edits them itself, and restoring old bytes would discard its
/// changes. Only the one key an update sets -- the journal mode -- is saved and
/// set back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigSnapshot {
    files: Vec<SavedFile>,
    journal_modes: Vec<(PathBuf, String)>,
}

impl ConfigSnapshot {
    pub fn capture(paths: &HostPaths) -> Result<Self> {
        let mut files = Vec::new();
        for path in [
            paths.env_file(),
            paths.hermes_unit(),
            paths.node_unit(),
            paths.worker_template(),
            paths.update_unit(),
            paths.sudoers_policy(),
        ] {
            let saved = match std::fs::read(&path) {
                Ok(bytes) => {
                    let metadata = std::fs::metadata(&path)?;
                    Some((
                        bytes,
                        metadata.mode() & 0o7777,
                        metadata.uid(),
                        metadata.gid(),
                    ))
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => {
                    return Err(error).with_context(|| format!("cannot save {}", path.display()));
                }
            };
            files.push(SavedFile { path, saved });
        }

        let mut configs = vec![paths.hermes_config()];
        if let Ok(entries) = std::fs::read_dir(paths.hermes_project_home_root()) {
            configs.extend(
                entries
                    .filter_map(Result::ok)
                    .map(|entry| entry.path().join("config.yaml")),
            );
        }
        let journal_modes = configs
            .into_iter()
            .filter_map(|config| {
                let body = std::fs::read_to_string(&config).ok()?;
                let mode = crate::policy::lookup(&body, "database", "journal_mode")?;
                Some((config, mode))
            })
            .collect();
        Ok(Self {
            files,
            journal_modes,
        })
    }

    /// Put every saved file and journal mode back. Every item is attempted; the
    /// first error is returned after all of them were.
    pub fn restore(&self) -> Result<()> {
        let mut first: Option<anyhow::Error> = None;
        let mut note = |result: Result<()>| {
            if let Err(error) = result
                && first.is_none()
            {
                first = Some(error);
            }
        };
        for file in &self.files {
            note(match &file.saved {
                Some((bytes, mode, uid, gid)) => write_as(&file.path, bytes, *mode, *uid, *gid),
                None => match std::fs::remove_file(&file.path) {
                    Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
                    _ => Ok(()),
                },
            });
        }
        for (config, mode) in &self.journal_modes {
            note((|| {
                let body = std::fs::read_to_string(config)?;
                if crate::policy::lookup(&body, "database", "journal_mode").as_deref()
                    == Some(mode.as_str())
                {
                    return Ok(());
                }
                let metadata = std::fs::metadata(config)?;
                let updated = crate::policy::set_setting(&body, "database", "journal_mode", mode);
                write_as(
                    config,
                    updated.as_bytes(),
                    metadata.mode() & 0o7777,
                    metadata.uid(),
                    metadata.gid(),
                )
            })());
        }
        first.map_or(Ok(()), Err)
    }
}

fn write_as(path: &Path, bytes: &[u8], mode: u32, uid: u32, gid: u32) -> Result<()> {
    let staged = path.with_extension("asterism-restore");
    std::fs::write(&staged, bytes).with_context(|| format!("cannot write {}", staged.display()))?;
    std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(mode))?;
    // As it was. Unprivileged (the tests), a file can only be given to its own
    // account, which is what it already has.
    let _ = std::os::unix::fs::chown(&staged, Some(uid), Some(gid));
    std::fs::rename(&staged, path).with_context(|| format!("cannot restore {}", path.display()))
}

/// Everything an update has changed so far, to be undone together.
pub struct Rollback {
    pub swap: Option<RuntimeSwap>,
    pub config: Option<ConfigSnapshot>,
    /// Present only when this update replaced the binary.
    pub binary: Option<PreviousBinary>,
    /// Whether the Node and host Hermes were restarted onto the new installation.
    pub services_restarted: bool,
    pub workers: Vec<ManagedWorker>,
}

/// What restoring achieved, for the report and for the operator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreReport {
    pub outcome: RollbackOutcome,
    pub problems: Vec<String>,
    pub not_converged: Vec<NotConverged>,
}

/// Put the previous installation back as one thing, restart what the update
/// touched onto it, and prove the services run from what was restored.
pub fn restore_previous_installation(
    rollback: Rollback,
    control: &dyn ServiceControl,
    clock: &dyn Clock,
    policy: Policy,
    paths: &HostPaths,
    installed_binary: &Path,
    reload_units: &dyn Fn() -> Result<()>,
) -> RestoreReport {
    let mut problems = Vec::new();
    let runtime_changed = rollback.swap.is_some();
    if let Some(swap) = rollback.swap {
        swap.roll_back_now();
    }
    if let Some(config) = &rollback.config
        && let Err(error) = config.restore()
    {
        problems.push(format!("configuration: {error:#}"));
    }
    if let Some(binary) = &rollback.binary
        && let Err(error) = binary.restore(installed_binary)
    {
        problems.push(format!("node binary: {error:#}"));
    }

    let touched = rollback.services_restarted || runtime_changed || rollback.binary.is_some();
    if touched {
        if let Err(error) = reload_units() {
            problems.push(format!("daemon-reload: {error:#}"));
        }
        for unit in UNITS {
            if let Err(error) = control.restart(unit) {
                problems.push(format!("{unit}: {error:#}"));
            }
        }
        // The workers were moved onto the new runtime, or are about to find it
        // gone: either way they come back onto the restored one.
        if rollback.services_restarted || runtime_changed {
            for worker in &rollback.workers {
                if let Err(error) = control.restart(&worker.unit) {
                    problems.push(format!("{}: {error:#}", worker.unit));
                }
            }
        }
    }

    let targets = service_targets(paths, installed_binary, &rollback.workers);
    let not_converged = match convergence::converge(control, clock, policy, &targets) {
        Ok(_) => Vec::new(),
        Err(all) => all,
    };
    let outcome = if problems.is_empty() && not_converged.is_empty() {
        RollbackOutcome::Restored
    } else {
        RollbackOutcome::Incomplete
    };
    RestoreReport {
        outcome,
        problems,
        not_converged,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::convergence::testing::*;
    use crate::convergence::{ActiveState, ExecutableClass, Reason};
    use std::time::Duration;

    const NEW: &str = "v0.1.0-alpha.31";
    const OLD: &str = "v0.1.0-alpha.30";
    const NEW_REV: &str = "1111111111111111111111111111111111111111";
    const OLD_REV: &str = "0000000000000000000000000000000000000000";

    fn marker(version: &str, revision: &str) -> crate::runtimerelease::RuntimeRelease {
        crate::runtimerelease::RuntimeRelease {
            schema: 1,
            version: version.to_owned(),
            source_revision: revision.to_owned(),
            platform: "linux/amd64".to_owned(),
            archive_sha256: "b".repeat(64),
        }
    }

    /// A host under a prefix: a live runtime tree, a parked previous tree, the
    /// Node binary and its parked previous copy, and the configuration files.
    struct Host {
        _dir: tempfile::TempDir,
        paths: HostPaths,
        binary: PathBuf,
        updater: PathBuf,
    }

    fn host(live: &str, live_rev: &str) -> Host {
        let dir = tempfile::tempdir().unwrap();
        let paths = HostPaths::with_prefix(dir.path());
        let opt = paths.opt_dir();
        std::fs::create_dir_all(opt.join("python/bin")).unwrap();
        std::fs::write(opt.join("python/bin/python3.13"), format!("python {live}")).unwrap();
        crate::runtimerelease::write_into(&opt, &marker(live, live_rev)).unwrap();

        let binary = paths.node_binary();
        std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
        std::fs::write(&binary, format!("node {NEW}")).unwrap();
        std::fs::write(
            PreviousBinary::parked_beside(&binary),
            format!("node {OLD}"),
        )
        .unwrap();
        let updater = dir.path().join("updater");
        std::fs::write(&updater, format!("node {NEW}")).unwrap();

        for (path, body) in [
            (paths.node_unit(), "node unit before"),
            (paths.hermes_unit(), "hermes unit before"),
            (paths.env_file(), "ASTERISM_HERMES_PORT=18642\n"),
        ] {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, body).unwrap();
        }
        Host {
            _dir: dir,
            paths,
            binary,
            updater,
        }
    }

    fn identity(host: &Host) -> BinaryIdentity {
        BinaryIdentity {
            installed: host.binary.clone(),
            running_image: host.updater.clone(),
            running_release: NEW.to_owned(),
        }
    }

    fn target() -> TargetRelease {
        TargetRelease {
            version: NEW.to_owned(),
            revision: NEW_REV.to_owned(),
        }
    }

    fn workers(ids: &[&str]) -> Vec<ManagedWorker> {
        ids.iter()
            .map(|id| ManagedWorker {
                project_id: (*id).to_owned(),
                profile: format!("asterism-project-{id}"),
                unit: format!("asterism-hermes@asterism-project-{id}.service"),
            })
            .collect()
    }

    fn policy() -> Policy {
        Policy {
            deadline: Duration::from_secs(20),
            interval: Duration::from_millis(500),
            settle: Duration::from_secs(2),
        }
    }

    /// Everything running where it should: the Node from the installed binary,
    /// Hermes and each worker from the live tree.
    fn all_running(control: &ScriptedSystemd, host: &Host, workers: &[ManagedWorker]) {
        let python = host.paths.opt_dir().join("python/bin/python3.13");
        control.script(NODE_UNIT, vec![running(10, image_of(&host.binary))]);
        control.script(HOST_HERMES_UNIT, vec![running(11, image_of(&python))]);
        for (n, worker) in workers.iter().enumerate() {
            control.script(
                &worker.unit,
                vec![running(20 + n as u32, image_of(&python))],
            );
        }
    }

    #[test]
    fn a_coherent_installation_produces_evidence_for_every_service() {
        let host = host(NEW, NEW_REV);
        let displaced = workers(&["a", "b"]);
        let control = ScriptedSystemd::default();
        all_running(&control, &host, &displaced);

        let evidence = verify_installation(
            &control,
            &FakeClock::default(),
            policy(),
            &host.paths,
            &target(),
            &identity(&host),
            &displaced,
        )
        .unwrap();

        assert_eq!(evidence.target_release, NEW);
        assert_eq!(evidence.node_release, NEW);
        assert_eq!(evidence.runtime_release, NEW);
        assert_eq!(evidence.runtime_revision, NEW_REV);
        assert_eq!(
            evidence
                .services
                .iter()
                .map(|s| s.role.clone())
                .collect::<Vec<_>>(),
            vec![
                Role::Node,
                Role::HostHermes,
                Role::ProjectWorker {
                    project_id: "a".to_owned()
                },
                Role::ProjectWorker {
                    project_id: "b".to_owned()
                },
            ]
        );
        // The workers were restarted exactly once each; the rest were not.
        assert_eq!(
            control.calls(),
            displaced
                .iter()
                .map(|w| format!("restart {}", w.unit))
                .collect::<Vec<_>>()
        );
    }

    /// The state node-1 was left in: the target binary over the previous
    /// runtime. It cannot produce evidence, whatever the processes look like.
    #[test]
    fn the_target_binary_on_the_previous_runtime_is_not_an_installation() {
        let host = host(OLD, OLD_REV);
        let displaced = workers(&["a"]);
        let control = ScriptedSystemd::default();
        all_running(&control, &host, &displaced);

        let failure = verify_installation(
            &control,
            &FakeClock::default(),
            policy(),
            &host.paths,
            &target(),
            &identity(&host),
            &displaced,
        )
        .unwrap_err();
        assert_eq!(
            failure,
            VerificationFailure::RuntimeRelease {
                found: Some(OLD.to_owned()),
                message: failure.to_string(),
            }
        );
        let detail = failure.detail(RollbackOutcome::Restored);
        assert_eq!(detail.check, FailedCheck::RuntimeRelease);
        assert_eq!(detail.found_runtime_release.as_deref(), Some(OLD));
        assert!(
            control.calls().is_empty(),
            "nothing is restarted onto a wrong runtime"
        );
    }

    #[test]
    fn an_unmarked_runtime_is_not_the_target_either() {
        let host = host(NEW, NEW_REV);
        std::fs::remove_file(host.paths.opt_dir().join(crate::runtimerelease::MARKER)).unwrap();
        let control = ScriptedSystemd::default();
        let failure = verify_installation(
            &control,
            &FakeClock::default(),
            policy(),
            &host.paths,
            &target(),
            &identity(&host),
            &[],
        )
        .unwrap_err();
        assert!(matches!(
            failure,
            VerificationFailure::RuntimeRelease { found: None, .. }
        ));
    }

    #[test]
    fn a_binary_that_is_not_the_updater_is_refused() {
        let host = host(NEW, NEW_REV);
        std::fs::write(&host.binary, "node something else").unwrap();
        let failure = verify_installation(
            &ScriptedSystemd::default(),
            &FakeClock::default(),
            policy(),
            &host.paths,
            &target(),
            &identity(&host),
            &[],
        )
        .unwrap_err();
        assert!(matches!(failure, VerificationFailure::NodeBinary(_)));

        let mut other = identity(&host);
        other.running_release = OLD.to_owned();
        assert!(matches!(
            verify_installation(
                &ScriptedSystemd::default(),
                &FakeClock::default(),
                policy(),
                &host.paths,
                &target(),
                &other,
                &[],
            ),
            Err(VerificationFailure::NodeBinary(_))
        ));
    }

    /// One worker of two never comes back: the update fails and names it, with
    /// the state it was last seen in.
    #[test]
    fn a_worker_that_never_converges_fails_verification_and_is_named() {
        let host = host(NEW, NEW_REV);
        let displaced = workers(&["a", "b"]);
        let control = ScriptedSystemd::default();
        all_running(&control, &host, &displaced);
        control.script(
            &displaced[1].unit,
            vec![Frame {
                state: ActiveState::Activating,
                pid: None,
                image: None,
            }],
        );

        let failure = verify_installation(
            &control,
            &FakeClock::default(),
            policy(),
            &host.paths,
            &target(),
            &identity(&host),
            &displaced,
        )
        .unwrap_err();
        let detail = failure.detail(RollbackOutcome::Restored);
        assert_eq!(detail.check, FailedCheck::Services);
        assert_eq!(detail.services.len(), 1);
        assert_eq!(
            detail.services[0].role,
            Role::ProjectWorker {
                project_id: "b".to_owned()
            }
        );
        assert_eq!(detail.services[0].reason, Reason::NotActive);
        assert_eq!(
            detail.services[0].last.active_state,
            ActiveState::Activating
        );
        assert_eq!(
            detail.services[0].last.executable,
            ExecutableClass::NoProcess
        );

        // It crosses a network as typed data with no path in it.
        let wire = serde_json::to_string(&detail).unwrap();
        assert!(!wire.contains('/'), "{wire}");
        let back: FailureDetail = serde_json::from_str(&wire).unwrap();
        assert_eq!(back, detail);
    }

    /// The rollback puts back one installation: the previous tree with its own
    /// marker, the previous binary, the previous configuration -- and restarts
    /// and verifies every service on it.
    #[test]
    fn rollback_restores_one_coherent_previous_installation() {
        let host = host(OLD, OLD_REV);
        let opt = host.paths.opt_dir();
        let config_before = ConfigSnapshot::capture(&host.paths).unwrap();

        // The update: the first half parked the old binary and installed the
        // new one; the second half swapped in the new tree and rewrote a unit.
        std::fs::write(&host.binary, format!("node {NEW}")).unwrap();
        let parked = PreviousBinary::find(&host.binary, None).unwrap();
        let retired = convergence::previous_runtime_root(&opt);
        std::fs::rename(&opt, &retired).unwrap();
        std::fs::create_dir_all(opt.join("python/bin")).unwrap();
        std::fs::write(opt.join("python/bin/python3.13"), "python new").unwrap();
        crate::runtimerelease::write_into(&opt, &marker(NEW, NEW_REV)).unwrap();
        let swap = RuntimeSwap::for_tests(opt.clone(), Some(retired));
        std::fs::write(host.paths.node_unit(), "node unit after").unwrap();
        std::fs::write(host.paths.update_unit(), "a unit that did not exist").unwrap();

        let displaced = workers(&["a", "b"]);
        let control = ScriptedSystemd::default();
        let reloads = std::cell::Cell::new(0);
        // What the services will be once restarted onto the restored tree. The
        // script is read after the rollback has put the files back.
        let report = {
            let reload = || {
                reloads.set(reloads.get() + 1);
                all_running(&control, &host, &displaced);
                Ok(())
            };
            restore_previous_installation(
                Rollback {
                    swap: Some(swap),
                    config: Some(config_before),
                    binary: Some(parked),
                    services_restarted: true,
                    workers: displaced.clone(),
                },
                &control,
                &FakeClock::default(),
                policy(),
                &host.paths,
                &host.binary,
                &reload,
            )
        };

        assert_eq!(report.outcome, RollbackOutcome::Restored, "{report:?}");
        assert!(report.problems.is_empty());
        assert_eq!(reloads.get(), 1);
        // One installation: tree, marker and binary are all the previous release.
        assert_eq!(
            crate::runtimerelease::read(&opt).unwrap().unwrap().version,
            OLD
        );
        assert_eq!(
            std::fs::read_to_string(opt.join("python/bin/python3.13")).unwrap(),
            format!("python {OLD}")
        );
        assert!(!convergence::previous_runtime_root(&opt).exists());
        assert_eq!(
            std::fs::read_to_string(&host.binary).unwrap(),
            format!("node {OLD}")
        );
        assert_eq!(
            std::fs::read_to_string(host.paths.node_unit()).unwrap(),
            "node unit before"
        );
        assert!(
            !host.paths.update_unit().exists(),
            "a file the update created is removed again"
        );
        let calls = control.calls();
        for unit in UNITS
            .iter()
            .map(|u| (*u).to_owned())
            .chain(displaced.iter().map(|w| w.unit.clone()))
        {
            assert_eq!(
                calls
                    .iter()
                    .filter(|c| **c == format!("restart {unit}"))
                    .count(),
                1,
                "{unit} is restarted onto the restored installation once: {calls:?}"
            );
        }
    }

    /// A rollback whose services do not come back says so, rather than
    /// reporting a restored installation that is not running.
    #[test]
    fn a_rollback_whose_worker_does_not_come_back_is_incomplete() {
        let host = host(OLD, OLD_REV);
        let displaced = workers(&["a"]);
        let control = ScriptedSystemd::default();
        all_running(&control, &host, &displaced);
        control.script(
            &displaced[0].unit,
            vec![running(
                30,
                image_of(&PreviousBinary::parked_beside(&host.binary)),
            )],
        );
        let report = restore_previous_installation(
            Rollback {
                swap: None,
                config: None,
                binary: None,
                services_restarted: true,
                workers: displaced.clone(),
            },
            &control,
            &FakeClock::default(),
            policy(),
            &host.paths,
            &host.binary,
            &|| Ok(()),
        );
        assert_eq!(report.outcome, RollbackOutcome::Incomplete);
        assert_eq!(report.not_converged.len(), 1);
    }

    #[test]
    fn a_parked_binary_that_is_not_the_recorded_one_is_refused() {
        let host = host(OLD, OLD_REV);
        assert!(PreviousBinary::find(&host.binary, Some(&"0".repeat(64))).is_err());
        let found = PreviousBinary::find(&host.binary, None).unwrap();
        std::fs::write(PreviousBinary::parked_beside(&host.binary), "tampered").unwrap();
        assert!(found.restore(&host.binary).is_err());
        assert_eq!(
            std::fs::read_to_string(&host.binary).unwrap(),
            format!("node {NEW}"),
            "a refused restore leaves the binary alone"
        );
    }

    #[test]
    fn journal_modes_are_set_back_without_discarding_hermes_edits() {
        let host = host(OLD, OLD_REV);
        let config = host.paths.hermes_config();
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::write(&config, "database:\n  journal_mode: delete\nmodel: a\n").unwrap();
        let snapshot = ConfigSnapshot::capture(&host.paths).unwrap();

        std::fs::write(&config, "database:\n  journal_mode: wal\nmodel: b\n").unwrap();
        snapshot.restore().unwrap();

        let body = std::fs::read_to_string(&config).unwrap();
        assert_eq!(
            crate::policy::lookup(&body, "database", "journal_mode").as_deref(),
            Some("delete")
        );
        assert!(body.contains("model: b"), "{body}");
    }
}
