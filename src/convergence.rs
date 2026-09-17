//! Waiting for a restarted service to become the process it is meant to be.
//!
//! `systemctl restart` returning says systemd accepted the request. It does not
//! say the new process exists, and it certainly does not say which file that
//! process is executing. For a moment after the call the unit is `activating`,
//! or its MainPID is zero, or it is the forked child that has not called `exec`
//! yet -- whose executable is systemd itself.
//!
//! The update used to look exactly once, in that moment. On node-1 it saw
//! `/usr/lib/systemd/systemd`, declared the worker stale, and rolled a healthy
//! runtime back. So nothing here decides from one observation. A service is
//! converged when, for a settling period, it is `active`, has the same non-zero
//! MainPID, and that process executes the expected file -- proved by device and
//! inode, not by a path that happens to read right. Everything short of that is
//! an intermediate state until a bounded deadline turns it into a failure that
//! names the service and what was last seen.

use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::workers::ServiceControl;

/// systemd's `ActiveState`, as far as a verdict needs it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActiveState {
    Active,
    Activating,
    Deactivating,
    Reloading,
    Inactive,
    Failed,
    /// Anything else, or a state that could not be read.
    Unknown,
}

impl ActiveState {
    pub fn parse(raw: &str) -> Self {
        match raw.trim() {
            "active" => Self::Active,
            "activating" => Self::Activating,
            "deactivating" => Self::Deactivating,
            "reloading" => Self::Reloading,
            "inactive" => Self::Inactive,
            "failed" => Self::Failed,
            _ => Self::Unknown,
        }
    }
}

/// A unit's state and main process, read together.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnitStatus {
    pub active_state: ActiveState,
    /// `None` for systemd's `MainPID=0`.
    pub main_pid: Option<u32>,
}

/// The file a process is executing: the path the kernel reports for it, and
/// the device and inode actually mapped.
///
/// The path alone is not proof. A tree renamed away and a new one put in its
/// place can show the same string; the inode cannot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessImage {
    pub path: PathBuf,
    pub device: u64,
    pub inode: u64,
}

impl ProcessImage {
    /// Read `/proc/<pid>/exe`. `None` when the process is gone or unreadable.
    pub fn of_pid(pid: u32) -> Option<Self> {
        let link = format!("/proc/{pid}/exe");
        let path = std::fs::read_link(&link).ok()?;
        // `metadata` follows the magic link to the mapped inode, which exists
        // even when the file has been deleted or renamed.
        let metadata = std::fs::metadata(&link).ok()?;
        Some(Self {
            path,
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
}

/// What a service's process must be executing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expectation {
    /// Any file inside the live runtime tree, as it is on disk now.
    RuntimeTree(PathBuf),
    /// Exactly this file, as it is on disk now.
    File(PathBuf),
}

/// How an observed executable relates to the expectation. Typed, so a failure
/// can be reported without a path crossing the privilege boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutableClass {
    /// The expected file, same device and inode as the live one.
    Expected,
    /// Inside the tree an update parks the previous runtime in, or the binary
    /// it keeps beside the Node.
    Previous,
    /// A file that no longer exists at its path.
    Deleted,
    /// The expected path, but not the file that is there now.
    Replaced,
    /// Something else entirely -- systemd before `exec`, for one.
    Outside,
    /// There is a main process but its executable could not be read.
    Unreadable,
    /// There is no main process.
    NoProcess,
}

/// Where an update parks the runtime it replaced, beside the live one.
pub fn previous_runtime_root(opt: &Path) -> PathBuf {
    opt.parent()
        .unwrap_or(Path::new("/"))
        .join(".asterism-previous")
}

pub fn classify(expect: &Expectation, image: Option<&ProcessImage>) -> ExecutableClass {
    let Some(image) = image else {
        return ExecutableClass::Unreadable;
    };
    if image.path.to_string_lossy().ends_with(" (deleted)") {
        return ExecutableClass::Deleted;
    }
    let matches_disk = |path: &Path| {
        std::fs::metadata(path)
            .map(|live| live.dev() == image.device && live.ino() == image.inode)
            .unwrap_or(false)
    };
    match expect {
        Expectation::RuntimeTree(opt) => {
            if image.path.starts_with(previous_runtime_root(opt)) {
                ExecutableClass::Previous
            } else if image.path.starts_with(opt) {
                if matches_disk(&image.path) {
                    ExecutableClass::Expected
                } else {
                    ExecutableClass::Replaced
                }
            } else {
                ExecutableClass::Outside
            }
        }
        Expectation::File(file) => {
            if image.path == *file {
                if matches_disk(file) {
                    ExecutableClass::Expected
                } else {
                    ExecutableClass::Replaced
                }
            } else if image.path == file.with_extension("previous") {
                ExecutableClass::Previous
            } else {
                ExecutableClass::Outside
            }
        }
    }
}

/// Which service this is, in terms a report may carry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Role {
    Node,
    HostHermes,
    ProjectWorker { project_id: String },
}

/// One service to bring to a verified state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub unit: String,
    pub role: Role,
    pub expect: Expectation,
}

/// One look at a service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Observation {
    pub active_state: ActiveState,
    pub main_pid: Option<u32>,
    pub executable: ExecutableClass,
    #[serde(skip)]
    pub identity: Option<(u64, u64)>,
}

/// A main process and the device and inode it executes.
type Held = (u32, (u64, u64));

impl Observation {
    fn good(&self) -> bool {
        self.active_state == ActiveState::Active
            && self.main_pid.is_some()
            && self.executable == ExecutableClass::Expected
    }

    /// What must not change while the service settles: the process and the
    /// file it runs. A restart or an `exec` changes one of them.
    fn key(&self) -> Option<Held> {
        Some((self.main_pid?, self.identity?))
    }
}

pub fn observe(control: &dyn ServiceControl, target: &Target) -> Observation {
    let status = control.unit_status(&target.unit).unwrap_or(UnitStatus {
        active_state: ActiveState::Unknown,
        main_pid: None,
    });
    let Some(pid) = status.main_pid else {
        return Observation {
            active_state: status.active_state,
            main_pid: None,
            executable: ExecutableClass::NoProcess,
            identity: None,
        };
    };
    let image = control.process_image(pid).ok().flatten();
    Observation {
        active_state: status.active_state,
        main_pid: Some(pid),
        executable: classify(&target.expect, image.as_ref()),
        identity: image.map(|image| (image.device, image.inode)),
    }
}

/// How long to wait, how often to look, and how long a good state must hold.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Policy {
    pub deadline: Duration,
    pub interval: Duration,
    pub settle: Duration,
}

impl Default for Policy {
    /// Hermes takes a few seconds to start on node-1; two minutes is generous
    /// without holding a host in an unproved state indefinitely.
    fn default() -> Self {
        Self {
            deadline: Duration::from_secs(120),
            interval: Duration::from_millis(500),
            settle: Duration::from_secs(5),
        }
    }
}

/// Time, injectable so convergence is tested without sleeping.
pub trait Clock {
    fn now(&self) -> Instant;
    fn sleep(&self, duration: Duration);
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

/// A service that reached and held the expected state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Converged {
    pub role: Role,
    pub main_pid: u32,
}

/// Why a service did not converge, from its last observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    NotActive,
    NoMainProcess,
    WrongExecutable,
    /// Every look was good, but the process or its file kept changing.
    Unsettled,
}

/// A service that did not converge before the deadline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotConverged {
    pub role: Role,
    pub reason: Reason,
    pub last: Observation,
}

impl NotConverged {
    fn from_last(role: Role, last: Observation) -> Self {
        let reason = if last.active_state != ActiveState::Active {
            Reason::NotActive
        } else if last.main_pid.is_none() {
            Reason::NoMainProcess
        } else if last.executable != ExecutableClass::Expected {
            Reason::WrongExecutable
        } else {
            Reason::Unsettled
        };
        Self { role, reason, last }
    }
}

impl std::fmt::Display for NotConverged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{:?} did not converge ({:?}): state {:?}, main pid {}, executable {:?}",
            self.role,
            self.reason,
            self.last.active_state,
            self.last
                .main_pid
                .map_or_else(|| "none".to_owned(), |pid| pid.to_string()),
            self.last.executable,
        )
    }
}

/// Watch every target until each has held a good state for `settle`, or the
/// deadline passes. Every target is reported: one that converged does not hide
/// one that did not.
pub fn converge(
    control: &dyn ServiceControl,
    clock: &dyn Clock,
    policy: Policy,
    targets: &[Target],
) -> Result<Vec<Converged>, Vec<NotConverged>> {
    struct Watch {
        last: Option<Observation>,
        since: Option<(Instant, Held)>,
        done: Option<u32>,
    }
    let started = clock.now();
    let mut watches: Vec<Watch> = targets
        .iter()
        .map(|_| Watch {
            last: None,
            since: None,
            done: None,
        })
        .collect();

    loop {
        let now = clock.now();
        for (target, watch) in targets.iter().zip(watches.iter_mut()) {
            if watch.done.is_some() {
                continue;
            }
            let seen = observe(control, target);
            match (seen.good(), seen.key()) {
                (true, Some(key)) => match watch.since {
                    Some((since, held)) if held == key => {
                        if now.duration_since(since) >= policy.settle {
                            watch.done = Some(key.0);
                        }
                    }
                    // First good look, or a different process or file than the
                    // last one: settling starts again from here.
                    _ => watch.since = Some((now, key)),
                },
                _ => watch.since = None,
            }
            watch.last = Some(seen);
        }

        if watches.iter().all(|watch| watch.done.is_some()) {
            return Ok(targets
                .iter()
                .zip(watches)
                .map(|(target, watch)| Converged {
                    role: target.role.clone(),
                    main_pid: watch.done.unwrap_or_default(),
                })
                .collect());
        }
        if now.duration_since(started) >= policy.deadline {
            return Err(targets
                .iter()
                .zip(watches)
                .filter(|(_, watch)| watch.done.is_none())
                .map(|(target, watch)| {
                    NotConverged::from_last(
                        target.role.clone(),
                        watch.last.unwrap_or(Observation {
                            active_state: ActiveState::Unknown,
                            main_pid: None,
                            executable: ExecutableClass::NoProcess,
                            identity: None,
                        }),
                    )
                })
                .collect());
        }
        clock.sleep(policy.interval);
    }
}

/// Restart each target once, in order, then wait for all of them together.
pub fn restart_and_converge(
    control: &dyn ServiceControl,
    clock: &dyn Clock,
    policy: Policy,
    targets: &[Target],
) -> Result<Vec<Converged>, RestartFailure> {
    for target in targets {
        if let Err(error) = control.restart(&target.unit) {
            return Err(RestartFailure::Refused {
                role: target.role.clone(),
                error: format!("{error:#}"),
            });
        }
    }
    converge(control, clock, policy, targets).map_err(RestartFailure::NotConverged)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestartFailure {
    /// systemd refused the restart itself.
    Refused {
        role: Role,
        error: String,
    },
    NotConverged(Vec<NotConverged>),
}

impl std::fmt::Display for RestartFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused { role, error } => write!(f, "cannot restart {role:?}: {error}"),
            Self::NotConverged(all) => {
                let said: Vec<String> = all.iter().map(ToString::to_string).collect();
                write!(f, "{}", said.join("; "))
            }
        }
    }
}

#[cfg(test)]
pub mod testing {
    //! A scripted systemd and a clock that only moves when asked to sleep.

    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Debug, Clone)]
    pub struct Frame {
        pub state: ActiveState,
        pub pid: Option<u32>,
        pub image: Option<ProcessImage>,
    }

    /// Each unit plays its frames one per observation and then holds the last.
    #[derive(Default)]
    pub struct ScriptedSystemd {
        pub frames: Mutex<HashMap<String, Vec<Frame>>>,
        pub cursor: Mutex<HashMap<String, usize>>,
        pub calls: Mutex<Vec<String>>,
        pub refuse_restart: Mutex<Vec<String>>,
    }

    impl ScriptedSystemd {
        pub fn script(&self, unit: &str, frames: Vec<Frame>) {
            self.frames.lock().unwrap().insert(unit.to_owned(), frames);
            self.cursor.lock().unwrap().insert(unit.to_owned(), 0);
        }
        pub fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
        fn current(&self, unit: &str) -> Option<Frame> {
            let frames = self.frames.lock().unwrap();
            let frames = frames.get(unit)?;
            let cursor = *self.cursor.lock().unwrap().get(unit).unwrap_or(&0);
            frames
                .get(cursor.min(frames.len().saturating_sub(1)))
                .cloned()
        }
    }

    impl ServiceControl for ScriptedSystemd {
        fn start(&self, unit: &str) -> anyhow::Result<()> {
            self.calls.lock().unwrap().push(format!("start {unit}"));
            Ok(())
        }
        fn stop(&self, unit: &str) -> anyhow::Result<()> {
            self.calls.lock().unwrap().push(format!("stop {unit}"));
            Ok(())
        }
        fn restart(&self, unit: &str) -> anyhow::Result<()> {
            self.calls.lock().unwrap().push(format!("restart {unit}"));
            if self
                .refuse_restart
                .lock()
                .unwrap()
                .iter()
                .any(|u| u == unit)
            {
                anyhow::bail!("unit refused to restart");
            }
            Ok(())
        }
        fn is_active(&self, unit: &str) -> anyhow::Result<bool> {
            Ok(self
                .current(unit)
                .is_some_and(|frame| frame.state == ActiveState::Active))
        }
        fn unit_status(&self, unit: &str) -> anyhow::Result<UnitStatus> {
            // One observation advances the script by one frame.
            let frame = self.current(unit);
            if let Some(cursor) = self.cursor.lock().unwrap().get_mut(unit) {
                *cursor += 1;
            }
            Ok(frame.map_or(
                UnitStatus {
                    active_state: ActiveState::Inactive,
                    main_pid: None,
                },
                |frame| UnitStatus {
                    active_state: frame.state,
                    main_pid: frame.pid,
                },
            ))
        }
        fn process_image(&self, pid: u32) -> anyhow::Result<Option<ProcessImage>> {
            // The frame just consumed is the one this pid came from.
            let frames = self.frames.lock().unwrap();
            let cursor = self.cursor.lock().unwrap();
            for (unit, frames) in frames.iter() {
                let at = cursor.get(unit).copied().unwrap_or(0).saturating_sub(1);
                if let Some(frame) = frames.get(at.min(frames.len().saturating_sub(1)))
                    && frame.pid == Some(pid)
                {
                    return Ok(frame.image.clone());
                }
            }
            Ok(None)
        }
    }

    /// Starts at an arbitrary instant and advances only by what is slept.
    pub struct FakeClock {
        pub start: Instant,
        pub elapsed: Mutex<Duration>,
    }

    impl Default for FakeClock {
        fn default() -> Self {
            Self {
                start: Instant::now(),
                elapsed: Mutex::new(Duration::ZERO),
            }
        }
    }

    impl Clock for FakeClock {
        fn now(&self) -> Instant {
            self.start + *self.elapsed.lock().unwrap()
        }
        fn sleep(&self, duration: Duration) {
            *self.elapsed.lock().unwrap() += duration;
        }
    }

    /// The image of a real file, so inode comparisons are genuine.
    pub fn image_of(path: &Path) -> ProcessImage {
        let metadata = std::fs::metadata(path).unwrap();
        ProcessImage {
            path: path.to_path_buf(),
            device: metadata.dev(),
            inode: metadata.ino(),
        }
    }

    pub fn running(pid: u32, image: ProcessImage) -> Frame {
        Frame {
            state: ActiveState::Active,
            pid: Some(pid),
            image: Some(image),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;

    const WORKER: &str = "asterism-hermes@asterism-project-a.service";

    struct Tree {
        _dir: tempfile::TempDir,
        opt: PathBuf,
        python: PathBuf,
        previous_python: PathBuf,
        systemd: PathBuf,
    }

    fn tree() -> Tree {
        let dir = tempfile::tempdir().unwrap();
        let opt = dir.path().join("opt/asterism");
        let python = opt.join("python/bin/python3.13");
        let previous_python = dir
            .path()
            .join("opt/.asterism-previous/python/bin/python3.13");
        let systemd = dir.path().join("usr/lib/systemd/systemd");
        for file in [&python, &previous_python, &systemd] {
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, file.to_string_lossy().as_bytes()).unwrap();
        }
        Tree {
            _dir: dir,
            opt,
            python,
            previous_python,
            systemd,
        }
    }

    fn worker(tree: &Tree) -> Target {
        Target {
            unit: WORKER.to_owned(),
            role: Role::ProjectWorker {
                project_id: "prj-a".to_owned(),
            },
            expect: Expectation::RuntimeTree(tree.opt.clone()),
        }
    }

    fn policy() -> Policy {
        Policy {
            deadline: Duration::from_secs(30),
            interval: Duration::from_millis(500),
            settle: Duration::from_secs(2),
        }
    }

    /// The production failure: the first look after the restart is the forked
    /// child still running systemd, then there is no main process for a beat,
    /// then the worker is up. Waited for, not failed.
    #[test]
    fn a_worker_seen_between_fork_and_exec_converges_without_failing() {
        let tree = tree();
        let control = ScriptedSystemd::default();
        control.script(
            WORKER,
            vec![
                running(4100, image_of(&tree.systemd)),
                Frame {
                    state: ActiveState::Active,
                    pid: None,
                    image: None,
                },
                running(4101, image_of(&tree.python)),
            ],
        );
        let clock = FakeClock::default();

        let converged = restart_and_converge(&control, &clock, policy(), &[worker(&tree)]).unwrap();

        assert_eq!(converged.len(), 1);
        assert_eq!(converged[0].main_pid, 4101);
        assert_eq!(control.calls(), vec![format!("restart {WORKER}")]);
    }

    #[test]
    fn a_delayed_main_pid_eventually_converges() {
        let tree = tree();
        let control = ScriptedSystemd::default();
        let mut frames = vec![
            Frame {
                state: ActiveState::Active,
                pid: None,
                image: None,
            };
            10
        ];
        frames.push(running(77, image_of(&tree.python)));
        control.script(WORKER, frames);

        let converged =
            converge(&control, &FakeClock::default(), policy(), &[worker(&tree)]).unwrap();
        assert_eq!(converged[0].main_pid, 77);
    }

    #[test]
    fn activating_becomes_a_stable_active_worker() {
        let tree = tree();
        let control = ScriptedSystemd::default();
        control.script(
            WORKER,
            vec![
                Frame {
                    state: ActiveState::Activating,
                    pid: Some(80),
                    image: Some(image_of(&tree.python)),
                },
                Frame {
                    state: ActiveState::Activating,
                    pid: Some(80),
                    image: Some(image_of(&tree.python)),
                },
                running(80, image_of(&tree.python)),
            ],
        );
        let clock = FakeClock::default();
        let converged = converge(&control, &clock, policy(), &[worker(&tree)]).unwrap();
        assert_eq!(converged[0].main_pid, 80);
        assert!(
            *clock.elapsed.lock().unwrap() >= policy().settle,
            "a good state must hold for the settling period, not be taken on one look"
        );
    }

    #[test]
    fn a_worker_that_never_starts_times_out_and_says_what_was_seen() {
        let tree = tree();
        let control = ScriptedSystemd::default();
        control.script(
            WORKER,
            vec![Frame {
                state: ActiveState::Failed,
                pid: None,
                image: None,
            }],
        );
        let clock = FakeClock::default();
        let failed = converge(&control, &clock, policy(), &[worker(&tree)]).unwrap_err();
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].reason, Reason::NotActive);
        assert_eq!(failed[0].last.active_state, ActiveState::Failed);
        assert_eq!(failed[0].last.executable, ExecutableClass::NoProcess);
        assert_eq!(
            failed[0].role,
            Role::ProjectWorker {
                project_id: "prj-a".to_owned()
            }
        );
        assert!(*clock.elapsed.lock().unwrap() >= policy().deadline);
        assert!(
            *clock.elapsed.lock().unwrap() < policy().deadline + policy().interval * 2,
            "the deadline bounds the wait"
        );
    }

    #[test]
    fn a_worker_on_the_previous_tree_is_rejected() {
        let tree = tree();
        let control = ScriptedSystemd::default();
        control.script(WORKER, vec![running(90, image_of(&tree.previous_python))]);
        let failed =
            converge(&control, &FakeClock::default(), policy(), &[worker(&tree)]).unwrap_err();
        assert_eq!(failed[0].reason, Reason::WrongExecutable);
        assert_eq!(failed[0].last.executable, ExecutableClass::Previous);
    }

    #[test]
    fn a_deleted_executable_is_rejected() {
        let tree = tree();
        let mut image = image_of(&tree.python);
        image.path = PathBuf::from(format!("{} (deleted)", tree.python.display()));
        let control = ScriptedSystemd::default();
        control.script(WORKER, vec![running(91, image)]);
        let failed =
            converge(&control, &FakeClock::default(), policy(), &[worker(&tree)]).unwrap_err();
        assert_eq!(failed[0].last.executable, ExecutableClass::Deleted);
    }

    /// The right path, the wrong file: the process maps an inode that is no
    /// longer the one at that path. A string comparison would accept it.
    #[test]
    fn an_executable_replaced_under_the_same_path_is_rejected() {
        let tree = tree();
        let stale = image_of(&tree.python);
        std::fs::remove_file(&tree.python).unwrap();
        std::fs::write(&tree.python, b"a different file").unwrap();
        let control = ScriptedSystemd::default();
        control.script(WORKER, vec![running(92, stale)]);
        let failed =
            converge(&control, &FakeClock::default(), policy(), &[worker(&tree)]).unwrap_err();
        assert_eq!(failed[0].last.executable, ExecutableClass::Replaced);
    }

    #[test]
    fn an_executable_outside_the_runtime_is_rejected() {
        let tree = tree();
        let control = ScriptedSystemd::default();
        control.script(WORKER, vec![running(93, image_of(&tree.systemd))]);
        let failed =
            converge(&control, &FakeClock::default(), policy(), &[worker(&tree)]).unwrap_err();
        assert_eq!(failed[0].last.executable, ExecutableClass::Outside);
    }

    /// A process that keeps being replaced is never settled, however good each
    /// individual look is.
    #[test]
    fn a_process_replaced_during_settling_starts_settling_again() {
        let tree = tree();
        let control = ScriptedSystemd::default();
        let frames = (0..200)
            .map(|n| running(1000 + (n / 3), image_of(&tree.python)))
            .collect();
        control.script(WORKER, frames);
        let failed =
            converge(&control, &FakeClock::default(), policy(), &[worker(&tree)]).unwrap_err();
        assert_eq!(failed[0].reason, Reason::Unsettled);
    }

    #[test]
    fn every_worker_is_verified_and_every_failure_is_named() {
        let tree = tree();
        let control = ScriptedSystemd::default();
        let units = ["w-a.service", "w-b.service", "w-c.service"];
        control.script(units[0], vec![running(1, image_of(&tree.python))]);
        control.script(units[1], vec![running(2, image_of(&tree.previous_python))]);
        control.script(
            units[2],
            vec![Frame {
                state: ActiveState::Inactive,
                pid: None,
                image: None,
            }],
        );
        let targets: Vec<Target> = units
            .iter()
            .enumerate()
            .map(|(n, unit)| Target {
                unit: (*unit).to_owned(),
                role: Role::ProjectWorker {
                    project_id: format!("prj-{n}"),
                },
                expect: Expectation::RuntimeTree(tree.opt.clone()),
            })
            .collect();

        let failed = converge(&control, &FakeClock::default(), policy(), &targets).unwrap_err();
        let named: Vec<_> = failed.iter().map(|f| f.role.clone()).collect();
        assert_eq!(
            named,
            vec![
                Role::ProjectWorker {
                    project_id: "prj-1".to_owned()
                },
                Role::ProjectWorker {
                    project_id: "prj-2".to_owned()
                },
            ]
        );

        // And all three good: all three reported.
        control.script(units[1], vec![running(2, image_of(&tree.python))]);
        control.script(units[2], vec![running(3, image_of(&tree.python))]);
        control.script(units[0], vec![running(1, image_of(&tree.python))]);
        let converged = converge(&control, &FakeClock::default(), policy(), &targets).unwrap();
        assert_eq!(
            converged.iter().map(|c| c.main_pid).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
    }

    #[test]
    fn a_refused_restart_fails_before_any_waiting() {
        let tree = tree();
        let control = ScriptedSystemd::default();
        control
            .refuse_restart
            .lock()
            .unwrap()
            .push(WORKER.to_owned());
        let clock = FakeClock::default();
        let failure =
            restart_and_converge(&control, &clock, policy(), &[worker(&tree)]).unwrap_err();
        assert!(matches!(failure, RestartFailure::Refused { .. }));
        assert_eq!(*clock.elapsed.lock().unwrap(), Duration::ZERO);
    }

    #[test]
    fn the_node_binary_is_matched_by_file_and_its_previous_copy_is_named() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("asterism-node");
        let previous = dir.path().join("asterism-node.previous");
        std::fs::write(&binary, b"new").unwrap();
        std::fs::write(&previous, b"old").unwrap();
        let expect = Expectation::File(binary.clone());
        assert_eq!(
            classify(&expect, Some(&image_of(&binary))),
            ExecutableClass::Expected
        );
        assert_eq!(
            classify(&expect, Some(&image_of(&previous))),
            ExecutableClass::Previous
        );
        assert_eq!(classify(&expect, None), ExecutableClass::Unreadable);
    }

    #[test]
    fn systemd_states_parse_and_anything_else_is_unknown() {
        assert_eq!(ActiveState::parse("active\n"), ActiveState::Active);
        assert_eq!(ActiveState::parse("activating"), ActiveState::Activating);
        assert_eq!(ActiveState::parse("maintenance"), ActiveState::Unknown);
    }
}
