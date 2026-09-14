//! Supervising one Hermes worker per project.
//!
//! Every worker is a systemd instance of one template, addressed by its exact
//! unit name. That exactness is the safety property: the previous approach in
//! this codebase's history was pattern matching, and a `pkill -f` pattern once
//! matched an unrelated process and killed it. A unit name is unambiguous, so
//! stopping one project cannot reach production Hermes or another project.
//!
//! Nothing here takes a unit, endpoint, key or PID from a caller. Everything is
//! resolved from the trusted inventory, keyed by project id.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use tokio::sync::Mutex;

use crate::inventory::{ProfileState, RuntimeOwnership};
use crate::profiles::{HOST_PROFILE, read_worker_key, validate_profile_name};
use crate::registry::Registry;

/// The systemd template each project worker is an instance of.
pub const WORKER_UNIT_TEMPLATE: &str = "asterism-hermes@";

/// The unit name for one profile.
///
/// The profile is validated first: it is about to become a systemd instance
/// name, and a name the Node did not generate has no business becoming one.
pub fn unit_name(profile: &str) -> Result<String> {
    validate_profile_name(profile)?;
    Ok(format!("{WORKER_UNIT_TEMPLATE}{profile}.service"))
}

/// One project worker this Node supervises, named the way systemd names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedWorker {
    pub project_id: String,
    pub profile: String,
    pub unit: String,
}

/// Every project worker this Node owns, taken from the registry.
///
/// The registry, and not a directory listing or a `systemctl` glob. Both of
/// those answer with whatever happens to exist rather than with what this Node
/// created: a scratch directory beside the profile homes becomes a project, and
/// a glob over `asterism-hermes@*` would sweep in an instance this Node does not
/// supervise. The registry is the only place that knows which profiles this Node
/// provisioned and still owns.
///
/// A runtime owned outside the Node is excluded for the same reason it is
/// excluded from reconciliation: there is no unit here to act on. A managed row
/// that never reached provisioning has no profile yet and no unit either.
pub fn managed_workers(registry: &Registry) -> Result<Vec<ManagedWorker>> {
    let mut workers = Vec::new();
    for project in registry.list_projects()? {
        if !project.runtime_ownership.owns_container() {
            continue;
        }
        let Some(profile) = project.hermes_profile.as_deref() else {
            continue;
        };
        workers.push(ManagedWorker {
            project_id: project.project_id,
            profile: profile.to_owned(),
            unit: unit_name(profile)?,
        });
    }
    Ok(workers)
}

/// Starting and stopping units, abstracted so tests need no systemd.
pub trait ServiceControl: Send + Sync {
    fn start(&self, unit: &str) -> Result<()>;

    /// Start a unit without waiting for it to finish.
    ///
    /// `systemctl start` waits for a one-shot unit to complete, which is right
    /// for a worker -- the caller wants to know it came up -- and wrong for the
    /// updater, whose whole job is to replace and restart the very process that
    /// asked for it. A caller that waits is killed by what it is waiting for,
    /// and the command it was answering is recorded as a failure at the moment
    /// it succeeds.
    ///
    /// Defaults to `start`, so a control that cannot tell the difference (every
    /// test double) behaves as it always did.
    fn start_detached(&self, unit: &str) -> Result<()> {
        self.start(unit)
    }

    fn stop(&self, unit: &str) -> Result<()>;
    fn restart(&self, unit: &str) -> Result<()>;
    fn is_active(&self, unit: &str) -> Result<bool>;

    /// The executable the unit's main process is running, resolved through
    /// `/proc`, or `None` when the unit has no main process.
    ///
    /// "Active" is not the question an update needs answered. A worker that
    /// kept running while `/opt/asterism` was renamed out from under it is
    /// still active, still healthy, and still executing the runtime that was
    /// replaced — so the only honest check is which file it is running.
    fn main_executable(&self, unit: &str) -> Result<Option<PathBuf>> {
        let _ = unit;
        Ok(None)
    }

    /// The pid of the unit's main process, or `None` when it has none.
    ///
    /// What proves a restart happened. An active unit with a healthy endpoint
    /// could be the process from before a change, still reading what it read.
    fn main_pid(&self, unit: &str) -> Result<Option<u32>> {
        let _ = unit;
        Ok(None)
    }
}

/// Real systemd, addressed by exact unit name.
#[derive(Debug, Default, Clone)]
pub struct SystemdControl;

impl SystemdControl {
    fn run(&self, action: &str, unit: &str) -> Result<std::process::Output> {
        // The Node runs unprivileged, and managing a system unit needs
        // authority it does not have on its own. That authority is granted by a
        // sudoers rule narrow enough to name only these verbs and only this
        // template, so the escalation is auditable in one short file rather
        // than implied by running the daemon as root.
        //
        // `-n` never prompts: if the rule is missing the call fails immediately
        // instead of blocking a provisioning attempt on a password nobody will
        // type. The unit is one argument and no shell is involved.
        self.run_with(&[action], unit)
    }

    /// The same call with extra systemctl arguments between the verb and the
    /// unit. Every form produced here has to appear in the sudoers policy
    /// verbatim -- sudo matches the whole command line, not the verb.
    fn run_with(&self, args: &[&str], unit: &str) -> Result<std::process::Output> {
        let mut command = std::process::Command::new("sudo");
        command.arg("-n").arg("systemctl").args(args).arg(unit);
        command
            .output()
            .with_context(|| format!("cannot run systemctl {} {unit}", args.join(" ")))
    }
}

impl ServiceControl for SystemdControl {
    fn start(&self, unit: &str) -> Result<()> {
        let output = self.run("start", unit)?;
        if !output.status.success() {
            // stderr may name the unit but never its environment file contents,
            // which is where the worker's key lives.
            bail!(
                "systemctl start {unit} failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(())
    }

    fn start_detached(&self, unit: &str) -> Result<()> {
        let output = self.run_with(&["start", "--no-block"], unit)?;
        if !output.status.success() {
            bail!(
                "systemctl start --no-block {unit} failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(())
    }

    fn stop(&self, unit: &str) -> Result<()> {
        let output = self.run("stop", unit)?;
        if !output.status.success() {
            bail!(
                "systemctl stop {unit} failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(())
    }

    fn restart(&self, unit: &str) -> Result<()> {
        let output = self.run("restart", unit)?;
        if !output.status.success() {
            bail!(
                "systemctl restart {unit} failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(())
    }

    fn is_active(&self, unit: &str) -> Result<bool> {
        let output = self.run("is-active", unit)?;
        Ok(String::from_utf8_lossy(&output.stdout).trim() == "active")
    }

    fn main_pid(&self, unit: &str) -> Result<Option<u32>> {
        // Read directly, without `sudo`: querying a unit's properties needs no
        // privilege, and the sudoers rule this Node depends on is deliberately
        // narrow enough to name only the verbs that change something.
        let output = std::process::Command::new("systemctl")
            .arg("show")
            .arg(unit)
            .arg("-p")
            .arg("MainPID")
            .arg("--value")
            .output()
            .with_context(|| format!("cannot read the main pid of {unit}"))?;
        Ok(
            match String::from_utf8_lossy(&output.stdout)
                .trim()
                .parse::<u32>()
            {
                Ok(0) | Err(_) => None,
                Ok(pid) => Some(pid),
            },
        )
    }

    fn main_executable(&self, unit: &str) -> Result<Option<PathBuf>> {
        let Some(pid) = self.main_pid(unit)? else {
            return Ok(None);
        };
        // `read_link`, not `canonicalize`: a process running a file that has
        // since been renamed away has an `exe` link ending in " (deleted)",
        // and canonicalising it would either fail or silently resolve to
        // whatever now occupies the path. The suffix is the evidence.
        match std::fs::read_link(format!("/proc/{pid}/exe")) {
            Ok(path) => Ok(Some(path)),
            Err(_) => Ok(None),
        }
    }
}

/// An authenticated liveness check against one worker.
///
/// Separate from `ServiceControl` so tests can drive readiness without a
/// listener, and so the check is never a provider-backed run: a health probe
/// that costs a model call is a health probe nobody runs often enough.
pub trait WorkerHealth: Send + Sync {
    /// Boxed rather than `async fn` so the trait stays usable behind `dyn`,
    /// which is what lets a test supply readiness without a listener.
    fn healthy<'a>(
        &'a self,
        endpoint: &'a str,
        api_key: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + 'a>>;
}

/// The real check: Hermes' own health endpoint, with the worker's key.
#[derive(Debug, Default, Clone)]
pub struct HttpWorkerHealth;

impl WorkerHealth for HttpWorkerHealth {
    fn healthy<'a>(
        &'a self,
        endpoint: &'a str,
        api_key: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + 'a>> {
        Box::pin(async move {
            let Ok(client) = reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
            else {
                return false;
            };
            client
                .get(format!("{endpoint}/health"))
                .bearer_auth(api_key)
                .send()
                .await
                .map(|response| response.status().is_success())
                .unwrap_or(false)
        })
    }
}

/// What a project's worker needs, resolved from inventory alone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerBinding {
    pub project_id: String,
    pub profile: String,
    pub unit: String,
    pub endpoint: String,
    pub api_key_ref: PathBuf,
    /// The isolated credential this worker reads, or `None` for the shared pool.
    pub credential_id: Option<String>,
}

/// What a credential reassignment did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reassignment {
    /// The worker already read exactly that credential and answered; nothing
    /// was restarted.
    Unchanged,
    /// The worker was restarted on the requested credential and verified.
    Applied,
}

/// Why a reassignment did not take, and whether the one before it is back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReassignFailure {
    /// Typed and safe to send.
    pub code: &'static str,
    /// True when the worker reads exactly what it read before, in the state it
    /// was in before.
    pub restored: bool,
    /// For this Node's journal only. Never sent: it can name a host path.
    pub detail: String,
}

impl ReassignFailure {
    /// A refusal from before anything was changed.
    fn untouched(code: &'static str, detail: impl std::fmt::Display) -> Self {
        Self {
            code,
            restored: true,
            detail: detail.to_string(),
        }
    }
}

/// Point a stopped worker's links at the store for `assignment`.
fn apply_links(
    paths: &crate::profiles::CredentialPaths,
    layout: &crate::profiles::ProfileLayout,
    assignment: Option<&str>,
) -> Result<()> {
    let store = paths.store_for(assignment)?;
    crate::credential_homes::swap_link(&store, &layout.auth(), false)?;
    match assignment {
        Some(id) => crate::credential_homes::swap_link(
            &crate::credential_homes::lock_file(&paths.credential_root, id)?,
            &layout.auth_lock(),
            true,
        )?,
        None => crate::credential_homes::remove_link(&layout.auth_lock())?,
    }
    Ok(())
}

/// How long to wait for a worker to answer before giving up.
#[derive(Debug, Clone)]
pub struct WorkerTimings {
    pub startup: Duration,
    pub poll: Duration,
}

impl Default for WorkerTimings {
    fn default() -> Self {
        Self {
            startup: Duration::from_secs(60),
            poll: Duration::from_millis(500),
        }
    }
}

/// Starts, stops and verifies project workers.
pub struct WorkerManager {
    control: Arc<dyn ServiceControl>,
    health: Arc<dyn WorkerHealth>,
    timings: WorkerTimings,
    runtime_uid: u32,
    /// One lock per project, so a slow start in one project does not block
    /// another. A single global lock here would serialize every project behind
    /// the slowest worker, which is the opposite of what multiple projects are
    /// for.
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Where the host keeps its provider credentials, when this manager was
    /// given them. Reconciled before every start, so a profile provisioned by an
    /// older Node — or before the host was authorized — acquires its references
    /// without anyone rebuilding it.
    credentials: Option<crate::profiles::CredentialPaths>,
}

impl WorkerManager {
    pub fn new(
        control: Arc<dyn ServiceControl>,
        health: Arc<dyn WorkerHealth>,
        timings: WorkerTimings,
        runtime_uid: u32,
    ) -> Self {
        Self {
            credentials: None,
            control,
            health,
            timings,
            runtime_uid,
            locks: Mutex::new(HashMap::new()),
        }
    }

    async fn project_lock(&self, project_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.locks.lock().await;
        Arc::clone(
            locks
                .entry(project_id.to_owned())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        )
    }

    /// Resolve a project's worker from the inventory, refusing anything that is
    /// not a complete, enabled, project-owned binding.
    pub fn binding(registry: &Registry, project_id: &str) -> Result<WorkerBinding> {
        let project = registry
            .project(project_id)?
            .with_context(|| format!("project {project_id} is not registered"))?;
        if !project.enabled {
            bail!("project {project_id} is disabled");
        }
        let profile = project
            .hermes_profile
            .clone()
            .with_context(|| format!("project {project_id} has no Hermes profile"))?;
        if profile == HOST_PROFILE {
            bail!("project {project_id} must not be routed to the reserved host profile");
        }
        let endpoint = project
            .runtime_endpoint
            .clone()
            .with_context(|| format!("project {project_id} has no endpoint"))?;
        let api_key_ref = project
            .hermes_api_key_ref
            .clone()
            .filter(|reference| !reference.is_empty())
            .with_context(|| format!("project {project_id} has no worker credential"))?;
        Ok(WorkerBinding {
            project_id: project_id.to_owned(),
            unit: unit_name(&profile)?,
            profile,
            endpoint,
            api_key_ref: PathBuf::from(api_key_ref),
            credential_id: project.credential_id.clone(),
        })
    }

    /// Start the project's worker if needed and wait for it to answer.
    ///
    /// Readiness is the authenticated health check, not the unit becoming
    /// active: systemd reports a process, and a process that has not finished
    /// opening its database is not something to route a run into.
    /// Tell this manager where the host's provider credentials live.
    pub fn with_credentials(mut self, credentials: crate::profiles::CredentialPaths) -> Self {
        self.credentials = Some(credentials);
        self
    }

    /// Repair this profile's credential references before its worker starts.
    ///
    /// Failure here is reported and not fatal: a worker that starts without a
    /// provider credential is honestly unauthorized, which the product now says
    /// out loud, while refusing to start it would take a working project offline
    /// over a link.
    fn reconcile_credentials(&self, binding: &WorkerBinding, live: bool) {
        let Some(paths) = self.credentials.as_ref() else {
            return;
        };
        let profile = binding.profile.as_str();
        match crate::profiles::reconcile_credentials(
            paths,
            profile,
            binding.credential_id.as_deref(),
            live,
        ) {
            Ok(outcomes) => {
                for (kind, outcome) in outcomes {
                    if outcome != crate::profiles::CredentialLink::AlreadyCorrect {
                        crate::daemon::log_event(
                            "worker.credential_reconciled",
                            serde_json::json!({
                                "profile": profile,
                                "credential": kind,
                                "outcome": format!("{outcome:?}"),
                            }),
                        );
                    }
                }
            }
            Err(error) => crate::daemon::log_event(
                "worker.credential_reconcile_failed",
                serde_json::json!({ "profile": profile, "detail": error.to_string() }),
            ),
        }
    }

    pub async fn ensure_running(
        &self,
        registry: &Mutex<Registry>,
        project_id: &str,
    ) -> Result<WorkerBinding> {
        let guard = self.project_lock(project_id).await;
        let _held = guard.lock().await;

        let binding = {
            let registry = registry.lock().await;
            Self::binding(&registry, project_id)?
        };

        let api_key = read_worker_key(&binding.api_key_ref, self.runtime_uid)?;

        // Before the unit, not after: a worker started without its credential
        // reference reaches a model only after another restart, and nothing in
        // the product would have said why it failed in between. A running
        // worker's reference is only checked, never repointed under it.
        let active = self.control.is_active(&binding.unit)?;
        self.reconcile_credentials(&binding, active);

        if !active {
            self.control.start(&binding.unit)?;
        }

        let deadline = std::time::Instant::now() + self.timings.startup;
        loop {
            if self.health.healthy(&binding.endpoint, &api_key).await {
                let mut registry = registry.lock().await;
                registry.set_profile_state(project_id, ProfileState::Ready, None)?;
                return Ok(binding);
            }
            if std::time::Instant::now() >= deadline {
                let mut registry = registry.lock().await;
                registry.set_profile_state(
                    project_id,
                    ProfileState::Failed,
                    Some("worker_unhealthy"),
                )?;
                bail!("worker for project {project_id} did not become healthy");
            }
            tokio::time::sleep(self.timings.poll).await;
        }
    }

    /// Move one project's worker onto a different credential, or back to the
    /// shared pool.
    ///
    /// The whole transition runs with the worker stopped and this project's lock
    /// held: stop, repoint, record, start -- and only then believe it, once the
    /// worker answers its authenticated health check, its link reads back as
    /// exactly the requested target, and the process serving is a new one. The
    /// worker is stopped first because Hermes writes a refreshed token through
    /// the link: a worker still running when the link moved would write the
    /// credential it holds into the store of the one replacing it.
    ///
    /// Any failure after that puts back exactly what was there -- the link, the
    /// lock, the recorded assignment, and a running worker if there was one --
    /// and says whether that worked. Only this project's unit is ever touched.
    pub async fn reassign_credential(
        &self,
        registry: &Mutex<Registry>,
        project_id: &str,
        requested: Option<&str>,
    ) -> std::result::Result<Reassignment, ReassignFailure> {
        let guard = self.project_lock(project_id).await;
        let _held = guard.lock().await;

        let paths = self.credentials.as_ref().ok_or_else(|| {
            ReassignFailure::untouched(
                "credential_paths_unavailable",
                "this worker manager was not given credential paths",
            )
        })?;
        let binding = {
            let registry = registry.lock().await;
            Self::binding(&registry, project_id)
        }
        .map_err(|error| ReassignFailure::untouched("project_not_ready", error))?;
        let api_key = read_worker_key(&binding.api_key_ref, self.runtime_uid)
            .map_err(|error| ReassignFailure::untouched("project_not_ready", error))?;
        let desired = paths
            .store_for(requested)
            .map_err(|error| ReassignFailure::untouched("credential_id_invalid", error))?;

        let layout = crate::profiles::ProfileLayout {
            home: paths.home_root.join(&binding.profile),
            profile: binding.profile.clone(),
        };
        let link = layout.auth();
        let previous_target = match std::fs::symlink_metadata(&link) {
            Ok(found) if found.file_type().is_symlink() => {
                Some(std::fs::read_link(&link).map_err(|error| {
                    ReassignFailure::untouched("credential_link_invalid", error)
                })?)
            }
            // A real file is somebody's credential. It is never replaced.
            Ok(_) => {
                return Err(ReassignFailure::untouched(
                    "credential_link_occupied",
                    "the project's credential reference is a file, not a link",
                ));
            }
            Err(_) => None,
        };
        let previous = binding.credential_id.clone();

        let active = self
            .control
            .is_active(&binding.unit)
            .map_err(|error| ReassignFailure::untouched("worker_restart_failed", error))?;
        if active
            && previous_target.as_deref() == Some(desired.as_path())
            && previous.as_deref() == requested
            && self.health.healthy(&binding.endpoint, &api_key).await
        {
            return Ok(Reassignment::Unchanged);
        }
        let pid_before = if active {
            self.control.main_pid(&binding.unit).ok().flatten()
        } else {
            None
        };

        match self
            .switch_credential(
                registry, paths, &binding, &layout, &api_key, requested, &desired, active,
                pid_before,
            )
            .await
        {
            Ok(()) => Ok(Reassignment::Applied),
            Err((code, detail)) => {
                let restored = self
                    .restore_credential(
                        registry,
                        paths,
                        &binding,
                        &layout,
                        &api_key,
                        previous.as_deref(),
                        previous_target.as_deref(),
                        active,
                    )
                    .await;
                Err(ReassignFailure {
                    code,
                    restored,
                    detail,
                })
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn switch_credential(
        &self,
        registry: &Mutex<Registry>,
        paths: &crate::profiles::CredentialPaths,
        binding: &WorkerBinding,
        layout: &crate::profiles::ProfileLayout,
        api_key: &str,
        requested: Option<&str>,
        desired: &std::path::Path,
        active: bool,
        pid_before: Option<u32>,
    ) -> std::result::Result<(), (&'static str, String)> {
        if active {
            self.control
                .stop(&binding.unit)
                .map_err(|error| ("worker_restart_failed", error.to_string()))?;
        }
        apply_links(paths, layout, requested)
            .map_err(|error| ("credential_link_invalid", error.to_string()))?;
        registry
            .lock()
            .await
            .set_project_credential(&binding.project_id, requested)
            .map_err(|error| ("assignment_not_recorded", error.to_string()))?;
        self.control
            .start(&binding.unit)
            .map_err(|error| ("worker_restart_failed", error.to_string()))?;
        if !self.wait_healthy(&binding.endpoint, api_key).await {
            return Err((
                "worker_unhealthy",
                "the worker did not answer its health check".to_owned(),
            ));
        }
        match std::fs::read_link(layout.auth()) {
            Ok(target) if target == desired => {}
            _ => {
                return Err((
                    "credential_link_invalid",
                    "the credential reference did not read back as requested".to_owned(),
                ));
            }
        }
        if let (Some(before), Ok(Some(after))) = (pid_before, self.control.main_pid(&binding.unit))
            && before == after
        {
            return Err((
                "worker_not_restarted",
                "the process serving is the one from before the change".to_owned(),
            ));
        }
        Ok(())
    }

    /// Put a worker back exactly as it was before a reassignment started.
    #[allow(clippy::too_many_arguments)]
    async fn restore_credential(
        &self,
        registry: &Mutex<Registry>,
        paths: &crate::profiles::CredentialPaths,
        binding: &WorkerBinding,
        layout: &crate::profiles::ProfileLayout,
        api_key: &str,
        previous: Option<&str>,
        previous_target: Option<&std::path::Path>,
        was_active: bool,
    ) -> bool {
        let _ = self.control.stop(&binding.unit);
        let link_back = match previous_target {
            Some(target) => {
                crate::credential_homes::swap_link(target, &layout.auth(), false).is_ok()
            }
            None => crate::credential_homes::remove_link(&layout.auth()).is_ok(),
        };
        let lock_back = match previous {
            Some(id) => crate::credential_homes::lock_file(&paths.credential_root, id)
                .and_then(|lock| {
                    crate::credential_homes::swap_link(&lock, &layout.auth_lock(), true)
                })
                .is_ok(),
            None => crate::credential_homes::remove_link(&layout.auth_lock()).is_ok(),
        };
        let recorded = registry
            .lock()
            .await
            .set_project_credential(&binding.project_id, previous)
            .is_ok();
        let running = if was_active {
            self.control.start(&binding.unit).is_ok()
                && self.wait_healthy(&binding.endpoint, api_key).await
        } else {
            true
        };
        let restored = link_back && lock_back && recorded && running;
        if !restored {
            // Not routed to until something makes it healthy again.
            let _ = registry.lock().await.set_profile_state(
                &binding.project_id,
                ProfileState::Failed,
                Some("worker_unhealthy"),
            );
        }
        restored
    }

    async fn wait_healthy(&self, endpoint: &str, api_key: &str) -> bool {
        let deadline = std::time::Instant::now() + self.timings.startup;
        loop {
            if self.health.healthy(endpoint, api_key).await {
                return true;
            }
            if std::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(self.timings.poll).await;
        }
    }

    /// Stop exactly this project's worker.
    pub async fn stop_owned_worker(
        &self,
        registry: &Mutex<Registry>,
        project_id: &str,
    ) -> Result<()> {
        let guard = self.project_lock(project_id).await;
        let _held = guard.lock().await;
        let binding = {
            let registry = registry.lock().await;
            Self::binding(&registry, project_id)?
        };
        self.control.stop(&binding.unit)
    }

    /// Restart exactly this project's worker.
    pub async fn restart_owned_worker(
        &self,
        registry: &Mutex<Registry>,
        project_id: &str,
    ) -> Result<()> {
        let guard = self.project_lock(project_id).await;
        let _held = guard.lock().await;
        let binding = {
            let registry = registry.lock().await;
            Self::binding(&registry, project_id)?
        };
        self.control.restart(&binding.unit)
    }

    /// Whether this project's worker currently answers.
    pub async fn health_check(&self, registry: &Mutex<Registry>, project_id: &str) -> Result<bool> {
        let binding = {
            let registry = registry.lock().await;
            Self::binding(&registry, project_id)?
        };
        let api_key = read_worker_key(&binding.api_key_ref, self.runtime_uid)?;
        Ok(self.health.healthy(&binding.endpoint, &api_key).await)
    }

    /// Bring systemd back in line with the inventory after a Node restart.
    ///
    /// Projects are handled independently and a failure is recorded rather than
    /// propagated: one project whose worker will not start must not stop the
    /// others from being restored.
    pub async fn reconcile_workers(&self, registry: &Mutex<Registry>) -> Vec<(String, String)> {
        let projects = {
            let registry = registry.lock().await;
            registry.list_projects().unwrap_or_default()
        };
        let mut failures = Vec::new();
        for project in projects {
            if !project.enabled || project.profile_state != ProfileState::Ready {
                continue;
            }
            // A runtime owned outside the Node has no unit here to supervise.
            // The projects that predate provisioning are bound that way: they
            // answer on an endpoint someone else started, and they carry no
            // worker credential. Attempting them anyway made every boot report
            // a restoration failure for a healthy project, which is how an
            // operator learns to ignore the one name that eventually matters.
            if project.runtime_ownership == RuntimeOwnership::External {
                continue;
            }
            if let Err(error) = self.ensure_running(registry, &project.project_id).await {
                failures.push((project.project_id, error.to_string()));
            }
        }
        failures
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::sync::Mutex as StdMutex;

    /// Records what was asked of systemd, so a test can assert the exact unit
    /// rather than trusting that nothing else was touched.
    #[derive(Default)]
    struct FakeSystemd {
        calls: StdMutex<Vec<String>>,
        active: StdMutex<Vec<String>>,
        fail_start: bool,
        /// What each unit's main process is executing, so a test can describe a
        /// worker that stayed active on a runtime that was renamed away.
        executables: StdMutex<Vec<(String, PathBuf)>>,
    }

    impl FakeSystemd {
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl ServiceControl for FakeSystemd {
        fn start(&self, unit: &str) -> Result<()> {
            self.calls.lock().unwrap().push(format!("start {unit}"));
            if self.fail_start {
                bail!("unit failed to start");
            }
            self.active.lock().unwrap().push(unit.to_owned());
            Ok(())
        }
        fn stop(&self, unit: &str) -> Result<()> {
            self.calls.lock().unwrap().push(format!("stop {unit}"));
            self.active.lock().unwrap().retain(|held| held != unit);
            Ok(())
        }
        fn restart(&self, unit: &str) -> Result<()> {
            self.calls.lock().unwrap().push(format!("restart {unit}"));
            Ok(())
        }
        fn is_active(&self, unit: &str) -> Result<bool> {
            Ok(self.active.lock().unwrap().iter().any(|held| held == unit))
        }
        fn main_pid(&self, unit: &str) -> Result<Option<u32>> {
            if !self.is_active(unit)? {
                return Ok(None);
            }
            // A new process for every start, as systemd would give it.
            let starts = self
                .calls
                .lock()
                .unwrap()
                .iter()
                .filter(|call| **call == format!("start {unit}"))
                .count();
            Ok(Some(1000 + starts as u32))
        }
        fn main_executable(&self, unit: &str) -> Result<Option<PathBuf>> {
            Ok(self
                .executables
                .lock()
                .unwrap()
                .iter()
                .find(|(name, _)| name == unit)
                .map(|(_, path)| path.clone()))
        }
    }

    struct FixedHealth(bool);

    impl WorkerHealth for FixedHealth {
        fn healthy<'a>(
            &'a self,
            _endpoint: &'a str,
            _api_key: &'a str,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + 'a>> {
            let answer = self.0;
            Box::pin(async move { answer })
        }
    }

    fn provisioned_registry(root: &Path, project_id: &str) -> (Registry, tempfile::TempDir) {
        let workspace = tempfile::tempdir().unwrap();
        let mut registry = Registry::open(root).unwrap();
        registry
            .register_project(
                project_id,
                workspace.path(),
                None,
                None,
                None,
                RuntimeOwnership::ManagedContainer,
            )
            .unwrap();
        let settings = crate::profiles::ProvisionSettings {
            home_root: root.join("hermes-projects"),
            shared_auth: root.join("shared/auth.json"),
            codex_auth: root.join("shared/codex/auth.json"),
            credential_root: root.join("credentials"),
            port_range: 18700..=18705,
            reserved_ports: vec![18642],
            production_home: root.join("hermes"),
            runtime_uid: unsafe { libc::getuid() },
        };
        crate::profiles::provision_project_profile(&mut registry, &settings, project_id, &|_| {
            false
        })
        .unwrap();
        (registry, workspace)
    }

    fn manager(control: Arc<FakeSystemd>, healthy: bool) -> WorkerManager {
        WorkerManager::new(
            control,
            Arc::new(FixedHealth(healthy)),
            WorkerTimings {
                startup: Duration::from_millis(50),
                poll: Duration::from_millis(10),
            },
            unsafe { libc::getuid() },
        )
    }

    /// The set an update acts on comes from the registry, so a directory that
    /// merely sits beside the profile homes is not a project.
    #[test]
    fn managed_workers_come_from_the_registry_not_from_the_disk() {
        let root = tempfile::tempdir().unwrap();
        let (registry, _workspace) = provisioned_registry(root.path(), "prj-managed");

        // Scratch directories of exactly the kind a runtime leaves behind.
        let homes = root.path().join("hermes-projects");
        for stray in [".codex", ".local", "leftover"] {
            std::fs::create_dir_all(homes.join(stray)).unwrap();
        }

        let workers = managed_workers(&registry).unwrap();
        assert_eq!(workers.len(), 1, "only the registered project is a project");
        assert_eq!(workers[0].project_id, "prj-managed");
        assert!(workers[0].unit.starts_with("asterism-hermes@"));
        assert!(workers[0].unit.ends_with(".service"));
    }

    /// A runtime the Node does not own has no unit here, so an update must not
    /// invent one for it.
    #[test]
    fn a_runtime_the_node_does_not_own_is_never_a_managed_worker() {
        let root = tempfile::tempdir().unwrap();
        let (mut registry, _workspace) = provisioned_registry(root.path(), "prj-managed");
        let external = tempfile::tempdir().unwrap();
        registry
            .register_project(
                "prj-external",
                external.path(),
                None,
                None,
                Some("http://127.0.0.1:19999"),
                RuntimeOwnership::External,
            )
            .unwrap();

        let workers = managed_workers(&registry).unwrap();
        let ids: Vec<_> = workers.iter().map(|w| w.project_id.as_str()).collect();
        assert_eq!(ids, vec!["prj-managed"]);
    }

    /// A managed project that never finished provisioning has no profile, and
    /// therefore no unit to restart.
    #[test]
    fn a_managed_project_without_a_profile_has_no_unit() {
        let root = tempfile::tempdir().unwrap();
        let mut registry = Registry::open(root.path()).unwrap();
        let workspace = tempfile::tempdir().unwrap();
        registry
            .register_project(
                "prj-unprovisioned",
                workspace.path(),
                None,
                None,
                None,
                RuntimeOwnership::ManagedContainer,
            )
            .unwrap();
        assert!(managed_workers(&registry).unwrap().is_empty());
    }

    #[test]
    fn a_unit_name_is_only_ever_built_from_a_validated_profile() {
        assert_eq!(
            unit_name("asterism-project-abc").unwrap(),
            "asterism-hermes@asterism-project-abc.service"
        );
        // A name that could carry a second argument or escape the instance must
        // never reach systemctl.
        for hostile in ["a b", "a;b", "../etc", "UPPER", ""] {
            assert!(unit_name(hostile).is_err(), "{hostile:?} must be refused");
        }
    }

    #[tokio::test]
    async fn a_healthy_worker_is_started_by_exact_unit_and_promoted_to_ready() {
        let root = tempfile::tempdir().unwrap();
        let (registry, _workspace) = provisioned_registry(root.path(), "alpha");
        let registry = Mutex::new(registry);
        let control = Arc::new(FakeSystemd::default());
        let manager = manager(Arc::clone(&control), true);

        let binding = manager.ensure_running(&registry, "alpha").await.unwrap();

        assert_eq!(
            control.calls(),
            vec!["start asterism-hermes@asterism-project-alpha.service".to_owned()]
        );
        assert_eq!(
            binding.unit,
            "asterism-hermes@asterism-project-alpha.service"
        );
        assert_eq!(
            registry
                .lock()
                .await
                .project("alpha")
                .unwrap()
                .unwrap()
                .profile_state,
            ProfileState::Ready
        );
    }

    #[tokio::test]
    async fn a_worker_that_never_answers_leaves_the_project_unusable() {
        let root = tempfile::tempdir().unwrap();
        let (registry, _workspace) = provisioned_registry(root.path(), "alpha");
        let registry = Mutex::new(registry);
        let manager = manager(Arc::new(FakeSystemd::default()), false);

        assert!(manager.ensure_running(&registry, "alpha").await.is_err());

        // Recorded rather than left pending: a project that failed to come up
        // must not be routed to, and an operator needs to know why.
        let project = registry.lock().await.project("alpha").unwrap().unwrap();
        assert_eq!(project.profile_state, ProfileState::Failed);
        assert_eq!(project.profile_failure.as_deref(), Some("worker_unhealthy"));
    }

    #[tokio::test]
    async fn stopping_one_project_names_only_that_projects_unit() {
        let root = tempfile::tempdir().unwrap();
        let (mut registry, _first) = provisioned_registry(root.path(), "alpha");
        let second = tempfile::tempdir().unwrap();
        registry
            .register_project(
                "beta",
                second.path(),
                None,
                None,
                None,
                RuntimeOwnership::ManagedContainer,
            )
            .unwrap();
        let settings = crate::profiles::ProvisionSettings {
            home_root: root.path().join("hermes-projects"),
            shared_auth: root.path().join("shared/auth.json"),
            codex_auth: root.path().join("shared/codex/auth.json"),
            credential_root: root.path().join("credentials"),
            port_range: 18700..=18705,
            reserved_ports: vec![18642],
            production_home: root.path().join("hermes"),
            runtime_uid: unsafe { libc::getuid() },
        };
        crate::profiles::provision_project_profile(&mut registry, &settings, "beta", &|_| false)
            .unwrap();

        let registry = Mutex::new(registry);
        let control = Arc::new(FakeSystemd::default());
        let manager = manager(Arc::clone(&control), true);

        manager.ensure_running(&registry, "alpha").await.unwrap();
        manager.ensure_running(&registry, "beta").await.unwrap();
        manager.stop_owned_worker(&registry, "alpha").await.unwrap();

        let calls = control.calls();
        assert!(calls.contains(&"stop asterism-hermes@asterism-project-alpha.service".to_owned()));
        // Nothing addressed the other project or the production service.
        assert!(
            !calls
                .iter()
                .any(|call| call.starts_with("stop") && call.contains("beta"))
        );
        assert!(
            !calls
                .iter()
                .any(|call| call.contains("asterism-hermes.service"))
        );
    }

    #[tokio::test]
    async fn a_project_with_no_binding_is_refused_rather_than_started() {
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let mut registry = Registry::open(root.path()).unwrap();
        registry
            .register_project(
                "unprovisioned",
                workspace.path(),
                None,
                None,
                None,
                RuntimeOwnership::ManagedContainer,
            )
            .unwrap();
        let registry = Mutex::new(registry);
        let control = Arc::new(FakeSystemd::default());
        let manager = manager(Arc::clone(&control), true);

        assert!(
            manager
                .ensure_running(&registry, "unprovisioned")
                .await
                .is_err()
        );
        // Nothing was started: an unprovisioned project has no unit to start,
        // and guessing one is how a project ends up inside another's home.
        assert!(control.calls().is_empty());
    }

    #[tokio::test]
    async fn reconciliation_leaves_projects_that_were_never_ready_alone() {
        let root = tempfile::tempdir().unwrap();
        let (registry, _workspace) = provisioned_registry(root.path(), "alpha");
        let registry = Mutex::new(registry);
        // Provisioned but never promoted: nothing answered a health check, so
        // starting its worker at boot would assert a readiness nobody proved.
        let control = Arc::new(FakeSystemd::default());
        let manager = manager(Arc::clone(&control), true);

        let failures = manager.reconcile_workers(&registry).await;

        assert!(failures.is_empty());
        assert!(
            control.calls().is_empty(),
            "a project that was not ready must not be started: {:?}",
            control.calls()
        );
    }

    #[tokio::test]
    async fn one_project_that_cannot_be_restored_does_not_stop_the_others() {
        let root = tempfile::tempdir().unwrap();
        let (mut registry, _first) = provisioned_registry(root.path(), "alpha");
        let second = tempfile::tempdir().unwrap();
        registry
            .register_project(
                "beta",
                second.path(),
                None,
                None,
                None,
                RuntimeOwnership::ManagedContainer,
            )
            .unwrap();
        let settings = crate::profiles::ProvisionSettings {
            home_root: root.path().join("hermes-projects"),
            shared_auth: root.path().join("shared/auth.json"),
            codex_auth: root.path().join("shared/codex/auth.json"),
            credential_root: root.path().join("credentials"),
            port_range: 18700..=18705,
            reserved_ports: vec![18642],
            production_home: root.path().join("hermes"),
            runtime_uid: unsafe { libc::getuid() },
        };
        crate::profiles::provision_project_profile(&mut registry, &settings, "beta", &|_| false)
            .unwrap();
        for id in ["alpha", "beta"] {
            registry
                .set_profile_state(id, ProfileState::Ready, None)
                .unwrap();
        }
        let registry = Mutex::new(registry);

        // Nothing answers, so every restoration fails. The point is that the
        // second project is still attempted after the first one failed.
        let control = Arc::new(FakeSystemd::default());
        let manager = manager(Arc::clone(&control), false);
        let failures = manager.reconcile_workers(&registry).await;

        assert_eq!(
            failures.len(),
            2,
            "both projects were attempted: {failures:?}"
        );
        let attempted: Vec<_> = failures.iter().map(|(id, _)| id.as_str()).collect();
        assert!(attempted.contains(&"alpha") && attempted.contains(&"beta"));
    }

    #[tokio::test]
    async fn reconciliation_leaves_a_runtime_the_node_does_not_own_alone() {
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let mut registry = Registry::open(root.path().join("registry.db")).unwrap();
        registry
            .register_project(
                "legacy",
                workspace.path(),
                None,
                None,
                Some("http://127.0.0.1:18642"),
                RuntimeOwnership::External,
            )
            .unwrap();
        // Exactly how a project that predates provisioning is bound: it is
        // ready, it is enabled, it names a profile, and it carries no worker
        // credential because nothing here ever started its runtime.
        registry
            .bind_existing_profile(
                "legacy",
                "/var/lib/asterism/hermes",
                "asterism-project-legacy",
                "http://127.0.0.1:18642",
                "",
            )
            .unwrap();
        let registry = Mutex::new(registry);

        let control = Arc::new(FakeSystemd::default());
        let manager = manager(Arc::clone(&control), true);
        let failures = manager.reconcile_workers(&registry).await;

        assert!(
            failures.is_empty(),
            "a healthy externally-owned runtime must not be reported as a restoration failure: {failures:?}"
        );
        assert!(
            control.calls().is_empty(),
            "nothing may be started for a runtime the Node does not own: {:?}",
            control.calls()
        );
    }

    /// Healthy unless the worker's link points at `refused`: a worker that cannot
    /// come up on one particular credential.
    struct RefuseTarget {
        link: PathBuf,
        refused: PathBuf,
    }

    impl WorkerHealth for RefuseTarget {
        fn healthy<'a>(
            &'a self,
            _endpoint: &'a str,
            _api_key: &'a str,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + 'a>> {
            let answer = std::fs::read_link(&self.link)
                .map(|target| target != self.refused)
                .unwrap_or(true);
            Box::pin(async move { answer })
        }
    }

    fn credential_paths(root: &Path) -> crate::profiles::CredentialPaths {
        crate::profiles::CredentialPaths {
            home_root: root.join("hermes-projects"),
            shared_auth: root.join("shared/auth.json"),
            codex_auth: root.join("shared/codex/auth.json"),
            credential_root: root.join("credentials"),
        }
    }

    fn ready_credential(root: &Path, id: &str) {
        use std::os::unix::fs::PermissionsExt;
        let home = crate::credential_homes::create_home(&root.join("credentials"), id, unsafe {
            libc::getuid()
        })
        .unwrap();
        std::fs::write(home.join("auth.json"), b"{}").unwrap();
        std::fs::set_permissions(
            home.join("auth.json"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
    }

    const ALPHA_UNIT: &str = "asterism-hermes@asterism-project-alpha.service";

    #[tokio::test]
    async fn reassigning_moves_only_this_worker_and_can_move_it_back() {
        let root = tempfile::tempdir().unwrap();
        let (mut registry, _alpha) = provisioned_registry(root.path(), "alpha");
        let beta_workspace = tempfile::tempdir().unwrap();
        registry
            .register_project(
                "beta",
                beta_workspace.path(),
                None,
                None,
                None,
                RuntimeOwnership::ManagedContainer,
            )
            .unwrap();
        let settings = crate::profiles::ProvisionSettings {
            home_root: root.path().join("hermes-projects"),
            shared_auth: root.path().join("shared/auth.json"),
            codex_auth: root.path().join("shared/codex/auth.json"),
            credential_root: root.path().join("credentials"),
            port_range: 18700..=18705,
            reserved_ports: vec![18642],
            production_home: root.path().join("hermes"),
            runtime_uid: unsafe { libc::getuid() },
        };
        crate::profiles::provision_project_profile(&mut registry, &settings, "beta", &|_| false)
            .unwrap();
        let registry = Mutex::new(registry);
        let paths = credential_paths(root.path());
        ready_credential(root.path(), "cred-alpha");
        let control = Arc::new(FakeSystemd::default());
        let workers = manager(Arc::clone(&control), true).with_credentials(paths.clone());

        workers.ensure_running(&registry, "alpha").await.unwrap();
        workers.ensure_running(&registry, "beta").await.unwrap();
        let alpha = root.path().join("hermes-projects/asterism-project-alpha");
        let beta = root.path().join("hermes-projects/asterism-project-beta");
        assert_eq!(
            std::fs::read_link(alpha.join("auth.json")).unwrap(),
            paths.shared_auth
        );

        let outcome = workers
            .reassign_credential(&registry, "alpha", Some("cred-alpha"))
            .await
            .unwrap();
        assert_eq!(outcome, Reassignment::Applied);
        assert_eq!(
            std::fs::read_link(alpha.join("auth.json")).unwrap(),
            root.path().join("credentials/cred-alpha/auth.json")
        );
        assert_eq!(
            std::fs::read_link(alpha.join("auth.lock")).unwrap(),
            root.path().join("credentials/cred-alpha/auth.lock")
        );
        assert_eq!(
            registry
                .lock()
                .await
                .project("alpha")
                .unwrap()
                .unwrap()
                .credential_id
                .as_deref(),
            Some("cred-alpha")
        );
        // Stopped and started by exact unit; the other project was not touched.
        let calls = control.calls();
        assert_eq!(
            calls[2..],
            [format!("stop {ALPHA_UNIT}"), format!("start {ALPHA_UNIT}")]
        );
        assert_eq!(
            std::fs::read_link(beta.join("auth.json")).unwrap(),
            paths.shared_auth,
            "another project's reference moved"
        );
        assert!(
            calls
                .iter()
                .filter(|call| call.contains("beta"))
                .all(|call| call.starts_with("start"))
        );

        // Asking again changes nothing and restarts nothing.
        assert_eq!(
            workers
                .reassign_credential(&registry, "alpha", Some("cred-alpha"))
                .await
                .unwrap(),
            Reassignment::Unchanged
        );
        assert_eq!(control.calls().len(), calls.len());

        // And back to the shared pool, lock link and all.
        assert_eq!(
            workers
                .reassign_credential(&registry, "alpha", None)
                .await
                .unwrap(),
            Reassignment::Applied
        );
        assert_eq!(
            std::fs::read_link(alpha.join("auth.json")).unwrap(),
            paths.shared_auth
        );
        assert!(std::fs::symlink_metadata(alpha.join("auth.lock")).is_err());
        assert_eq!(
            registry
                .lock()
                .await
                .project("alpha")
                .unwrap()
                .unwrap()
                .credential_id,
            None
        );
    }

    #[tokio::test]
    async fn a_worker_that_will_not_come_up_on_the_new_credential_is_put_back() {
        let root = tempfile::tempdir().unwrap();
        let (registry, _workspace) = provisioned_registry(root.path(), "alpha");
        let registry = Mutex::new(registry);
        let paths = credential_paths(root.path());
        ready_credential(root.path(), "cred-broken");
        let home = root.path().join("hermes-projects/asterism-project-alpha");
        let control = Arc::new(FakeSystemd::default());
        let workers = WorkerManager::new(
            Arc::clone(&control) as Arc<dyn ServiceControl>,
            Arc::new(RefuseTarget {
                link: home.join("auth.json"),
                refused: root.path().join("credentials/cred-broken/auth.json"),
            }),
            WorkerTimings {
                startup: Duration::from_millis(50),
                poll: Duration::from_millis(10),
            },
            unsafe { libc::getuid() },
        )
        .with_credentials(paths.clone());
        workers.ensure_running(&registry, "alpha").await.unwrap();

        let failure = workers
            .reassign_credential(&registry, "alpha", Some("cred-broken"))
            .await
            .unwrap_err();
        assert_eq!(failure.code, "worker_unhealthy");
        assert!(failure.restored, "{failure:?}");

        assert_eq!(
            std::fs::read_link(home.join("auth.json")).unwrap(),
            paths.shared_auth
        );
        assert!(std::fs::symlink_metadata(home.join("auth.lock")).is_err());
        let project = registry.lock().await.project("alpha").unwrap().unwrap();
        assert_eq!(project.credential_id, None);
        assert_eq!(project.profile_state, ProfileState::Ready);
        assert!(control.is_active(ALPHA_UNIT).unwrap());
        assert_eq!(
            control.calls(),
            vec![
                format!("start {ALPHA_UNIT}"),
                format!("stop {ALPHA_UNIT}"),
                format!("start {ALPHA_UNIT}"),
                format!("stop {ALPHA_UNIT}"),
                format!("start {ALPHA_UNIT}"),
            ]
        );
    }

    #[tokio::test]
    async fn a_real_file_where_the_reference_belongs_is_never_replaced() {
        let root = tempfile::tempdir().unwrap();
        let (registry, _workspace) = provisioned_registry(root.path(), "alpha");
        let registry = Mutex::new(registry);
        ready_credential(root.path(), "cred-alpha");
        let control = Arc::new(FakeSystemd::default());
        let workers =
            manager(Arc::clone(&control), true).with_credentials(credential_paths(root.path()));
        workers.ensure_running(&registry, "alpha").await.unwrap();

        let reference = root
            .path()
            .join("hermes-projects/asterism-project-alpha/auth.json");
        std::fs::remove_file(&reference).unwrap();
        std::fs::write(&reference, b"somebody's credential").unwrap();

        let failure = workers
            .reassign_credential(&registry, "alpha", Some("cred-alpha"))
            .await
            .unwrap_err();
        assert_eq!(failure.code, "credential_link_occupied");
        assert!(failure.restored);
        assert_eq!(std::fs::read(&reference).unwrap(), b"somebody's credential");
        assert_eq!(control.calls().len(), 1, "nothing was stopped");
    }

    #[tokio::test]
    async fn restoring_workers_after_a_restart_keeps_their_assignment() {
        let root = tempfile::tempdir().unwrap();
        let (registry, _workspace) = provisioned_registry(root.path(), "alpha");
        let registry = Mutex::new(registry);
        let paths = credential_paths(root.path());
        ready_credential(root.path(), "cred-alpha");
        let home = root.path().join("hermes-projects/asterism-project-alpha");
        let isolated = root.path().join("credentials/cred-alpha/auth.json");

        let before =
            manager(Arc::new(FakeSystemd::default()), true).with_credentials(paths.clone());
        before.ensure_running(&registry, "alpha").await.unwrap();
        before
            .reassign_credential(&registry, "alpha", Some("cred-alpha"))
            .await
            .unwrap();

        // The host restarts: every unit is down, and something repointed the
        // stopped worker's reference at the shared pool in between.
        crate::credential_homes::swap_link(&paths.shared_auth, &home.join("auth.json"), false)
            .unwrap();
        let control = Arc::new(FakeSystemd::default());
        let restarted = self::manager(Arc::clone(&control), true).with_credentials(paths.clone());
        assert!(restarted.reconcile_workers(&registry).await.is_empty());
        assert_eq!(
            std::fs::read_link(home.join("auth.json")).unwrap(),
            isolated
        );

        // A running worker's reference is reported, never repointed under it.
        crate::credential_homes::swap_link(&paths.shared_auth, &home.join("auth.json"), false)
            .unwrap();
        restarted.ensure_running(&registry, "alpha").await.unwrap();
        assert_eq!(
            std::fs::read_link(home.join("auth.json")).unwrap(),
            paths.shared_auth
        );
    }

    #[tokio::test]
    async fn reconciliation_restores_ready_projects_and_survives_one_failure() {
        let root = tempfile::tempdir().unwrap();
        let (registry, _workspace) = provisioned_registry(root.path(), "alpha");
        let registry = Mutex::new(registry);
        {
            let mut guard = registry.lock().await;
            guard
                .set_profile_state("alpha", ProfileState::Ready, None)
                .unwrap();
        }

        let control = Arc::new(FakeSystemd::default());
        let manager = manager(Arc::clone(&control), true);
        let failures = manager.reconcile_workers(&registry).await;

        assert!(failures.is_empty());
        assert_eq!(
            control.calls(),
            vec!["start asterism-hermes@asterism-project-alpha.service".to_owned()]
        );
    }
}
