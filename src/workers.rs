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

/// Starting and stopping units, abstracted so tests need no systemd.
pub trait ServiceControl: Send + Sync {
    fn start(&self, unit: &str) -> Result<()>;
    fn stop(&self, unit: &str) -> Result<()>;
    fn restart(&self, unit: &str) -> Result<()>;
    fn is_active(&self, unit: &str) -> Result<bool>;
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
        std::process::Command::new("sudo")
            .arg("-n")
            .arg("systemctl")
            .arg(action)
            .arg(unit)
            .output()
            .with_context(|| format!("cannot run systemctl {action} {unit}"))
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
}

impl WorkerManager {
    pub fn new(
        control: Arc<dyn ServiceControl>,
        health: Arc<dyn WorkerHealth>,
        timings: WorkerTimings,
        runtime_uid: u32,
    ) -> Self {
        Self {
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
        })
    }

    /// Start the project's worker if needed and wait for it to answer.
    ///
    /// Readiness is the authenticated health check, not the unit becoming
    /// active: systemd reports a process, and a process that has not finished
    /// opening its database is not something to route a run into.
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

        if !self.control.is_active(&binding.unit)? {
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
