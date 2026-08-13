//! Single-flight run admission for one project container.
//!
//! # Why this exists
//!
//! This is a **temporary Phase B constraint**, not a scheduler.
//!
//! The Hermes API server runs in `server_agent` runtime mode: every `POST
//! /v1/runs` is executed by one shared server-side `AIAgent`, and the
//! `session_id` field (and the `X-Hermes-Session-Id` header) only labels a run
//! — it does not partition conversation context. Phase A proved this by
//! observing a never-before-used session id recall tokens from two unrelated
//! sessions.
//!
//! Under that model a single persistent project agent executing tasks
//! sequentially is coherent, but two concurrent runs are not: they would
//! interleave tool calls and transcript state inside one agent. Until the
//! runtime provides real isolation, Asterism Node admits at most one
//! non-terminal run per project container and rejects the second deterministically.
//!
//! # Design
//!
//! Two cooperating mechanisms, because neither alone is sufficient:
//!
//! * An advisory `flock(2)` on `<state>/run.lock` provides mutual exclusion
//!   between concurrent Node processes. The kernel drops it when the process
//!   exits for any reason, so a crashed Node never leaves a permanent lock.
//! * A sidecar `<state>/active-run.json` records the run id that was handed to
//!   Hermes. `flock` disappears when the Node process exits, but a detached run
//!   started without `--wait` keeps executing inside Hermes; the sidecar is what
//!   survives a Node restart and lets the next invocation ask Hermes whether
//!   that run is still live.
//!
//! Container restart clears the Hermes in-memory run registry, so a recorded run
//! id resolves to "not found" and stops blocking admission — see
//! [`AdmissionDecision`].

use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::hermes::is_terminal_status;

/// Stable identifier reported when admission is refused, so callers can branch
/// on the outcome instead of matching on human-readable text.
pub const RUN_CONFLICT_CODE: &str = "run_conflict";

/// Refusal to admit a second concurrent run for one project container.
#[derive(Debug, Clone)]
pub struct RunConflict {
    pub project_id: String,
    pub reason: ConflictReason,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConflictReason {
    /// Another Node process currently holds the project lock.
    LockHeld,
    /// A previously started run is still non-terminal inside Hermes.
    ActiveRun { run_id: String, status: String },
}

impl std::fmt::Display for RunConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.reason {
            ConflictReason::LockHeld => write!(
                f,
                "project {} already has an active run: the run lock is held by another Asterism Node process",
                self.project_id
            ),
            ConflictReason::ActiveRun { run_id, status } => write!(
                f,
                "project {} already has an active run: {run_id} is {status}",
                self.project_id
            ),
        }
    }
}

impl std::error::Error for RunConflict {}

/// Whether a recorded run still blocks admission of a new one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdmissionDecision {
    /// No run recorded, the recorded run reached a terminal state, or Hermes no
    /// longer knows it (the run registry is in-memory and is cleared by a
    /// container restart).
    Admit,
    Reject {
        run_id: String,
        status: String,
    },
}

/// Persistent record of the run Asterism handed to Hermes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActiveRun {
    pub run_id: String,
    pub session_id: Option<String>,
    pub started_at_unix: u64,
}

/// Filesystem layout of one project's Asterism Node state.
#[derive(Debug, Clone)]
pub struct ProjectState {
    project_id: String,
    dir: PathBuf,
}

impl ProjectState {
    pub fn new(state_root: impl AsRef<Path>, project_id: impl Into<String>) -> Result<Self> {
        let project_id = project_id.into();
        let dir = state_root.as_ref().join(&project_id);
        fs::create_dir_all(&dir).with_context(|| {
            format!("failed to create project state directory {}", dir.display())
        })?;
        Ok(Self { project_id, dir })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn lock_path(&self) -> PathBuf {
        self.dir.join("run.lock")
    }

    pub fn active_run_path(&self) -> PathBuf {
        self.dir.join("active-run.json")
    }

    /// Take the project run lock, or fail with a [`RunConflict`].
    pub fn try_lock(&self) -> Result<ProjectRunLock> {
        let path = self.lock_path();
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .with_context(|| format!("failed to open run lock {}", path.display()))?;

        if !flock_exclusive_nonblocking(&file)? {
            return Err(RunConflict {
                project_id: self.project_id.clone(),
                reason: ConflictReason::LockHeld,
            }
            .into());
        }

        Ok(ProjectRunLock {
            state: self.clone(),
            _file: file,
        })
    }

    pub fn read_active_run(&self) -> Result<Option<ActiveRun>> {
        let path = self.active_run_path();
        let mut file = match File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(error).with_context(|| format!("failed to read {}", path.display()));
            }
        };

        let mut body = String::new();
        file.read_to_string(&mut body)
            .with_context(|| format!("failed to read {}", path.display()))?;
        if body.trim().is_empty() {
            return Ok(None);
        }

        // A truncated or hand-edited record must not wedge the project
        // permanently: treat it as "no active run" rather than a hard failure.
        Ok(serde_json::from_str(&body).ok())
    }
}

/// Held for as long as this process is responsible for the project's run slot.
///
/// Dropping the value releases the advisory lock. The kernel does the same if
/// the process dies, which is what keeps a crash from leaving a permanent lock.
#[derive(Debug)]
pub struct ProjectRunLock {
    state: ProjectState,
    _file: File,
}

impl ProjectRunLock {
    pub fn state(&self) -> &ProjectState {
        &self.state
    }

    pub fn record_active_run(&self, run: &ActiveRun) -> Result<()> {
        let path = self.state.active_run_path();
        let body = serde_json::to_string_pretty(run)?;
        fs::write(&path, body)
            .with_context(|| format!("failed to record active run in {}", path.display()))
    }

    /// Drop the recorded run once it reaches a terminal state, fails to start,
    /// or is cancelled. Missing file is success — clearing must be idempotent.
    pub fn clear_active_run(&self) -> Result<()> {
        let path = self.state.active_run_path();
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error).with_context(|| format!("failed to clear {}", path.display())),
        }
    }
}

/// Classify a recorded run against the status Hermes reports for it.
///
/// `status` is `None` when Hermes has no record of the run. That is the normal
/// state after a container restart, because the Hermes run registry lives in
/// memory only — a stale record must not block the project forever.
pub fn classify_recorded_run(run: Option<&ActiveRun>, status: Option<&str>) -> AdmissionDecision {
    let Some(run) = run else {
        return AdmissionDecision::Admit;
    };

    match status {
        None => AdmissionDecision::Admit,
        Some(status) if is_terminal_status(status) => AdmissionDecision::Admit,
        Some(status) => AdmissionDecision::Reject {
            run_id: run.run_id.clone(),
            status: status.to_owned(),
        },
    }
}

pub fn conflict_from_decision(
    project_id: &str,
    decision: AdmissionDecision,
) -> Option<RunConflict> {
    match decision {
        AdmissionDecision::Admit => None,
        AdmissionDecision::Reject { run_id, status } => Some(RunConflict {
            project_id: project_id.to_owned(),
            reason: ConflictReason::ActiveRun { run_id, status },
        }),
    }
}

/// Take an exclusive advisory lock without blocking.
///
/// Returns `false` when another open file description already holds it. The
/// kernel releases the lock when the owning process exits, which is what keeps a
/// crash from leaving a permanent lock behind.
pub fn flock_exclusive_nonblocking(file: &File) -> Result<bool> {
    // SAFETY: `file` owns a valid descriptor for the duration of the call.
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc == 0 {
        return Ok(true);
    }

    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::EWOULDBLOCK) => Ok(false),
        _ => bail!("failed to acquire project run lock: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> (tempfile::TempDir, ProjectState) {
        let root = tempfile::tempdir().unwrap();
        let state = ProjectState::new(root.path(), "phase-b").unwrap();
        (root, state)
    }

    #[test]
    fn second_lock_attempt_reports_a_conflict() {
        let (_root, state) = state();
        let _held = state.try_lock().unwrap();

        let error = state.try_lock().unwrap_err();
        let conflict = error.downcast_ref::<RunConflict>().unwrap();
        assert_eq!(conflict.reason, ConflictReason::LockHeld);
    }

    #[test]
    fn lock_is_released_when_dropped() {
        let (_root, state) = state();
        {
            let _held = state.try_lock().unwrap();
        }

        // A process error unwinds the guard, which releases the advisory lock;
        // the next admission must succeed rather than stay wedged.
        assert!(state.try_lock().is_ok());
    }

    #[test]
    fn active_run_round_trips_through_the_sidecar() {
        let (_root, state) = state();
        let lock = state.try_lock().unwrap();
        let run = ActiveRun {
            run_id: "run_abc".to_owned(),
            session_id: Some("phase-b".to_owned()),
            started_at_unix: 42,
        };

        lock.record_active_run(&run).unwrap();
        assert_eq!(state.read_active_run().unwrap(), Some(run));

        lock.clear_active_run().unwrap();
        assert_eq!(state.read_active_run().unwrap(), None);
    }

    #[test]
    fn clearing_an_absent_active_run_is_idempotent() {
        let (_root, state) = state();
        let lock = state.try_lock().unwrap();

        lock.clear_active_run().unwrap();
        lock.clear_active_run().unwrap();
    }

    #[test]
    fn corrupt_active_run_record_does_not_wedge_the_project() {
        let (_root, state) = state();
        fs::write(state.active_run_path(), "{ not json").unwrap();

        assert_eq!(state.read_active_run().unwrap(), None);
    }

    #[test]
    fn recorded_run_blocks_admission_while_non_terminal() {
        let run = ActiveRun {
            run_id: "run_abc".to_owned(),
            session_id: None,
            started_at_unix: 0,
        };

        assert_eq!(
            classify_recorded_run(Some(&run), Some("running")),
            AdmissionDecision::Reject {
                run_id: "run_abc".to_owned(),
                status: "running".to_owned(),
            }
        );
        assert_eq!(
            classify_recorded_run(Some(&run), Some("waiting_for_approval")),
            AdmissionDecision::Reject {
                run_id: "run_abc".to_owned(),
                status: "waiting_for_approval".to_owned(),
            }
        );
    }

    #[test]
    fn terminal_recorded_run_does_not_block_admission() {
        let run = ActiveRun {
            run_id: "run_abc".to_owned(),
            session_id: None,
            started_at_unix: 0,
        };

        for status in ["completed", "failed", "cancelled"] {
            assert_eq!(
                classify_recorded_run(Some(&run), Some(status)),
                AdmissionDecision::Admit
            );
        }
    }

    #[test]
    fn run_unknown_to_hermes_does_not_block_admission() {
        // Container restart wipes the in-memory Hermes run registry, so the
        // recorded run id resolves to "not found" and must be forgotten.
        let run = ActiveRun {
            run_id: "run_abc".to_owned(),
            session_id: None,
            started_at_unix: 0,
        };

        assert_eq!(
            classify_recorded_run(Some(&run), None),
            AdmissionDecision::Admit
        );
    }

    #[test]
    fn no_recorded_run_admits() {
        assert_eq!(classify_recorded_run(None, None), AdmissionDecision::Admit);
        assert_eq!(
            classify_recorded_run(None, Some("running")),
            AdmissionDecision::Admit
        );
    }

    #[test]
    fn conflict_is_built_only_for_rejections() {
        assert!(conflict_from_decision("p", AdmissionDecision::Admit).is_none());

        let conflict = conflict_from_decision(
            "p",
            AdmissionDecision::Reject {
                run_id: "run_abc".to_owned(),
                status: "running".to_owned(),
            },
        )
        .unwrap();
        assert_eq!(
            conflict.reason,
            ConflictReason::ActiveRun {
                run_id: "run_abc".to_owned(),
                status: "running".to_owned(),
            }
        );
    }

    #[test]
    fn state_directories_are_per_project() {
        let root = tempfile::tempdir().unwrap();
        let a = ProjectState::new(root.path(), "alpha").unwrap();
        let b = ProjectState::new(root.path(), "beta").unwrap();

        assert_ne!(a.lock_path(), b.lock_path());
        // Two different projects must never contend for one lock.
        let _held = a.try_lock().unwrap();
        assert!(b.try_lock().is_ok());
    }
}
