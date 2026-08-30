//! Node-owned project inventory.
//!
//! The Control Plane addresses work by **registered project id** and never by
//! host path. This is the boundary that makes that true: a remote command
//! carries an id, this module resolves it to a canonical workspace path that
//! only the operator ever supplied, and a path arriving from the wire is simply
//! not part of the data model.
//!
//! The inventory lives in the Node registry, which no project container binds.

use anyhow::{Context, Result, bail};
use rusqlite::{OptionalExtension, Row, params};
use serde::Serialize;
use serde_json::Value;

use crate::registry::Registry;

/// Who supervises a project's runtime.
///
/// Deliberately about *lifecycle ownership*, not transport: an external runtime
/// is a host process today and may be something else supervised later. What the
/// Node needs to know is only whether it may create and destroy the runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeOwnership {
    /// Asterism Node creates and supervises a project container.
    ManagedContainer,
    /// Something outside the Node owns the runtime. The Node only talks to it.
    External,
}

impl RuntimeOwnership {
    pub fn as_str(self) -> &'static str {
        match self {
            RuntimeOwnership::ManagedContainer => "managed_container",
            RuntimeOwnership::External => "external",
        }
    }

    /// Parse a stored value, refusing anything this build does not understand
    /// rather than defaulting to a behaviour the operator did not choose.
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "managed_container" => Ok(RuntimeOwnership::ManagedContainer),
            "external" => Ok(RuntimeOwnership::External),
            other => bail!(
                "unknown runtime ownership {other:?}; expected \"managed_container\" or \"external\""
            ),
        }
    }

    /// Whether the Node may run container lifecycle operations for this project.
    pub fn owns_container(self) -> bool {
        matches!(self, RuntimeOwnership::ManagedContainer)
    }
}

/// A project this Node is willing to act on.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RegisteredProject {
    pub project_id: String,
    /// Canonical host path. Never transmitted to the Control Plane.
    #[serde(skip_serializing)]
    pub workspace_path: String,
    pub display_name: String,
    pub enabled: bool,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
    /// Host-local Hermes endpoint for this project's runtime container.
    ///
    /// `None` means the Node-wide default. Each project runs its own container
    /// on its own port, so a Node that supervises more than one project must
    /// resolve the endpoint per project rather than per Node. Never transmitted:
    /// it is a host address, and the Control Plane addresses work by project id.
    #[serde(skip_serializing)]
    pub runtime_endpoint: Option<String>,
    /// Who supervises this project's runtime.
    pub runtime_ownership: RuntimeOwnership,
    /// The project's own `HERMES_HOME`.
    ///
    /// One Hermes installation serves every project; separation comes from each
    /// project owning a different home, so its sessions, memory and state
    /// database are separate files rather than rows filtered after retrieval.
    /// Never transmitted: it is a host path.
    #[serde(skip_serializing)]
    pub hermes_home: Option<String>,
    /// Generated stable worker identity, derived from the project id rather than
    /// its name: renaming a project must not rename its Hermes state.
    #[serde(skip_serializing)]
    pub hermes_profile: Option<String>,
    /// Path to the worker's API key, never the key.
    ///
    /// A registry row is read in far more places than the one that
    /// authenticates a request, and a secret in an ordinary row leaks by being
    /// ordinary.
    #[serde(skip_serializing)]
    pub hermes_api_key_ref: Option<String>,
    /// Provisioning state of the project's Hermes home and worker.
    pub profile_state: ProfileState,
    /// Why provisioning failed, for an operator and for a safe retry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_failure: Option<String>,
}

/// How far a project's Hermes home and worker have been provisioned.
///
/// A project is runnable only in `Ready`. Every other value fails a run closed
/// rather than routing it somewhere that happens to answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileState {
    Pending,
    Provisioning,
    Ready,
    Failed,
    Disabled,
}

impl ProfileState {
    pub fn as_str(self) -> &'static str {
        match self {
            ProfileState::Pending => "pending",
            ProfileState::Provisioning => "provisioning",
            ProfileState::Ready => "ready",
            ProfileState::Failed => "failed",
            ProfileState::Disabled => "disabled",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "pending" => Ok(ProfileState::Pending),
            "provisioning" => Ok(ProfileState::Provisioning),
            "ready" => Ok(ProfileState::Ready),
            "failed" => Ok(ProfileState::Failed),
            "disabled" => Ok(ProfileState::Disabled),
            other => bail!("unknown profile state {other:?}"),
        }
    }

    /// Whether a run may be dispatched to this project.
    pub fn runnable(self) -> bool {
        matches!(self, ProfileState::Ready)
    }
}

impl RegisteredProject {
    /// The view sent to the Control Plane: identity and state only, no paths.
    pub fn remote_view(&self) -> Value {
        serde_json::json!({
            "project_id": self.project_id,
            "display_name": self.display_name,
            "enabled": self.enabled,
            "created_at": self.created_at,
            "runtime_ownership": self.runtime_ownership.as_str(),
            "profile_state": self.profile_state.as_str(),
            "profile_failure": self.profile_failure,
            "metadata": self.metadata,
        })
    }
}

impl Registry {
    /// Register a project, rejecting duplicates and unusable paths.
    pub fn register_project(
        &mut self,
        project_id: &str,
        workspace: &std::path::Path,
        display_name: Option<&str>,
        metadata: Option<&Value>,
        runtime_endpoint: Option<&str>,
        runtime_ownership: RuntimeOwnership,
    ) -> Result<RegisteredProject> {
        crate::service::validate_identifier("project_id", project_id)
            .map_err(|error| anyhow::anyhow!("{error}"))?;

        // Canonicalizing here is what removes `..` and symlink ambiguity before
        // anything is stored.
        let canonical = workspace.canonicalize().with_context(|| {
            format!(
                "workspace {} does not exist or is not reachable",
                workspace.display()
            )
        })?;
        if !canonical.is_dir() {
            bail!("workspace {} is not a directory", canonical.display());
        }
        if canonical == std::path::Path::new("/") {
            bail!("refusing to register the filesystem root as a workspace");
        }

        let existing: Option<String> = self
            .conn
            .query_row(
                "SELECT project_id FROM projects WHERE project_id = ?1",
                params![project_id],
                |row| row.get(0),
            )
            .optional()?;
        if existing.is_some() {
            bail!("project {project_id} is already registered");
        }

        if let Some(endpoint) = runtime_endpoint {
            validate_runtime_endpoint(endpoint)?;
        }
        // An external runtime has no container to fall back on, so the Node has
        // nowhere to send work unless it is told where the runtime listens.
        if runtime_ownership == RuntimeOwnership::External && runtime_endpoint.is_none() {
            bail!(
                "project {project_id} is externally managed and therefore requires \
                 --runtime-endpoint; the Node has no container to fall back to"
            );
        }

        let display_name = display_name.unwrap_or(project_id);
        let now = crate::registry::now_millis();
        self.conn.execute(
            "INSERT INTO projects (project_id, workspace_path, display_name, enabled,
                                   created_at, metadata, runtime_endpoint, runtime_ownership)
             VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7)",
            params![
                project_id,
                canonical.to_string_lossy(),
                display_name,
                now,
                metadata.map(serde_json::to_string).transpose()?,
                runtime_endpoint,
                runtime_ownership.as_str(),
            ],
        )?;

        self.project(project_id)?
            .context("registered project disappeared immediately")
    }

    pub fn project(&self, project_id: &str) -> Result<Option<RegisteredProject>> {
        Ok(self
            .conn
            .query_row(
                "SELECT project_id, workspace_path, display_name, enabled, created_at, metadata,
                        runtime_endpoint, runtime_ownership, hermes_home, hermes_profile,
                        hermes_api_key_ref, profile_state, profile_failure
                 FROM projects WHERE project_id = ?1",
                params![project_id],
                map_project,
            )
            .optional()?)
    }

    pub fn list_projects(&self) -> Result<Vec<RegisteredProject>> {
        let mut statement = self.conn.prepare(
            "SELECT project_id, workspace_path, display_name, enabled, created_at, metadata,
                    runtime_endpoint, runtime_ownership, hermes_home, hermes_profile,
                        hermes_api_key_ref, profile_state, profile_failure
             FROM projects ORDER BY project_id",
        )?;
        Ok(statement
            .query_map([], map_project)?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Remove a project. Refuses while it still has a non-terminal run, so a
    /// live execution can never be orphaned by a bookkeeping change.
    pub fn unregister_project(&mut self, project_id: &str) -> Result<()> {
        if self.project(project_id)?.is_none() {
            bail!("project {project_id} is not registered");
        }
        if let Some(active) = self.active_runs(project_id)?.into_iter().next() {
            bail!(
                "refusing to unregister project {project_id}: run {} is {}",
                active.run_id,
                active.status
            );
        }
        self.conn.execute(
            "DELETE FROM projects WHERE project_id = ?1",
            params![project_id],
        )?;
        Ok(())
    }

    /// Record where a project's Hermes state lives and how to reach its worker.
    ///
    /// Written once by provisioning and again by recovery; both call the same
    /// path so a retry cannot leave half a binding behind.
    pub fn set_profile_runtime(
        &mut self,
        project_id: &str,
        hermes_home: &str,
        hermes_profile: &str,
        endpoint: &str,
        api_key_ref: &str,
        state: ProfileState,
    ) -> Result<()> {
        validate_runtime_endpoint(endpoint)?;
        let changed = self.conn.execute(
            "UPDATE projects
                SET hermes_home = ?2, hermes_profile = ?3, runtime_endpoint = ?4,
                    hermes_api_key_ref = ?5, profile_state = ?6, profile_failure = NULL
              WHERE project_id = ?1",
            params![
                project_id,
                hermes_home,
                hermes_profile,
                endpoint,
                api_key_ref,
                state.as_str()
            ],
        )?;
        if changed == 0 {
            bail!("project {project_id} is not registered");
        }
        Ok(())
    }

    /// Move a project through provisioning, keeping the reason it failed.
    ///
    /// The reason is what makes a retry an informed action rather than a second
    /// guess, so it is stored rather than logged and discarded.
    pub fn set_profile_state(
        &mut self,
        project_id: &str,
        state: ProfileState,
        failure: Option<&str>,
    ) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE projects SET profile_state = ?2, profile_failure = ?3 WHERE project_id = ?1",
            params![project_id, state.as_str(), failure],
        )?;
        if changed == 0 {
            bail!("project {project_id} is not registered");
        }
        Ok(())
    }

    /// Bind a project that predates project-scoped Hermes homes to the home it
    /// has in fact been using.
    ///
    /// The alternative was a per-run fallback to the Node-wide endpoint, which
    /// is exactly the behaviour that would send an unknown project's work into
    /// the existing project's memory. Binding is explicit, recorded once, and
    /// never overwrites a project that already has a home.
    pub fn bind_existing_profile(
        &mut self,
        project_id: &str,
        hermes_home: &str,
        hermes_profile: &str,
        endpoint: &str,
        api_key_ref: &str,
    ) -> Result<bool> {
        let already: Option<Option<String>> = self
            .conn
            .query_row(
                "SELECT hermes_home FROM projects WHERE project_id = ?1",
                params![project_id],
                |row| row.get(0),
            )
            .optional()?;
        match already {
            None => bail!("project {project_id} is not registered"),
            Some(Some(_)) => Ok(false),
            Some(None) => {
                self.set_profile_runtime(
                    project_id,
                    hermes_home,
                    hermes_profile,
                    endpoint,
                    api_key_ref,
                    ProfileState::Ready,
                )?;
                Ok(true)
            }
        }
    }

    /// Every loopback port this Node has already committed to a project.
    ///
    /// Allocation reads this rather than probing listeners: a worker that is
    /// stopped still owns its port, and handing it to another project would
    /// swap two projects' state the next time both were running.
    pub fn allocated_endpoints(&self) -> Result<Vec<String>> {
        let mut statement = self
            .conn
            .prepare("SELECT runtime_endpoint FROM projects WHERE runtime_endpoint IS NOT NULL")?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Resolve a project id that arrived from the Control Plane.
    ///
    /// Returns `None` for anything unregistered or disabled, which is what keeps
    /// remote commands confined to projects the operator chose.
    pub fn resolve_remote_project(&self, project_id: &str) -> Result<Option<RegisteredProject>> {
        if crate::service::validate_identifier("project_id", project_id).is_err() {
            return Ok(None);
        }
        Ok(self.project(project_id)?.filter(|project| project.enabled))
    }
}

fn map_project(row: &Row<'_>) -> rusqlite::Result<RegisteredProject> {
    let enabled: i64 = row.get(3)?;
    let metadata: Option<String> = row.get(5)?;
    Ok(RegisteredProject {
        project_id: row.get(0)?,
        workspace_path: row.get(1)?,
        display_name: row.get(2)?,
        enabled: enabled != 0,
        created_at: row.get(4)?,
        metadata: metadata.and_then(|text| serde_json::from_str(&text).ok()),
        runtime_endpoint: row.get(6)?,
        hermes_home: row.get(8)?,
        hermes_profile: row.get(9)?,
        hermes_api_key_ref: row.get(10)?,
        profile_state: {
            let stored: String = row.get(11)?;
            ProfileState::parse(&stored).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    11,
                    rusqlite::types::Type::Text,
                    error.into(),
                )
            })?
        },
        profile_failure: row.get(12)?,
        runtime_ownership: {
            let stored: String = row.get(7)?;
            RuntimeOwnership::parse(&stored).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    7,
                    rusqlite::types::Type::Text,
                    error.into(),
                )
            })?
        },
    })
}

/// A runtime endpoint is a host-local HTTP address the Node dials itself.
///
/// It never arrives from the Control Plane, but it is still validated so a typo
/// in an operator command fails at registration rather than at the first run.
fn validate_runtime_endpoint(endpoint: &str) -> Result<()> {
    let trimmed = endpoint.trim();
    if trimmed.is_empty() {
        bail!("runtime endpoint must not be empty");
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        bail!("runtime endpoint {trimmed} must start with http:// or https://");
    }
    if trimmed.contains(char::is_whitespace) {
        bail!("runtime endpoint must not contain whitespace");
    }
    Ok(())
}

impl Registry {
    /// Change a project's runtime endpoint after registration.
    ///
    /// Separate from registration because a container can be rebuilt on a new
    /// port without the project itself changing identity.
    pub fn set_project_runtime_endpoint(
        &mut self,
        project_id: &str,
        endpoint: Option<&str>,
    ) -> Result<RegisteredProject> {
        if let Some(value) = endpoint {
            validate_runtime_endpoint(value)?;
        }
        let changed = self.conn.execute(
            "UPDATE projects SET runtime_endpoint = ?2 WHERE project_id = ?1",
            params![project_id, endpoint],
        )?;
        if changed == 0 {
            bail!("project {project_id} is not registered");
        }
        self.project(project_id)?
            .context("project disappeared immediately after update")
    }
}

#[cfg(test)]
mod tests {

    #[test]
    fn a_project_registered_without_the_flag_is_container_managed() {
        let dir = tempfile::tempdir().unwrap();
        let mut registry = registry();
        let project = registry
            .register_project(
                "p1",
                dir.path(),
                None,
                None,
                None,
                RuntimeOwnership::ManagedContainer,
            )
            .unwrap();
        assert_eq!(
            project.runtime_ownership,
            RuntimeOwnership::ManagedContainer
        );
        assert!(project.runtime_ownership.owns_container());
    }

    #[test]
    fn an_external_project_records_its_ownership_and_endpoint() {
        let dir = tempfile::tempdir().unwrap();
        let mut registry = registry();
        let project = registry
            .register_project(
                "hostproof",
                dir.path(),
                Some("Host Proof"),
                None,
                Some("http://127.0.0.1:18742"),
                RuntimeOwnership::External,
            )
            .unwrap();
        assert_eq!(project.runtime_ownership, RuntimeOwnership::External);
        assert!(!project.runtime_ownership.owns_container());

        // It survives a reopen of the registry, which is what a Node restart is.
        let reloaded = registry.project("hostproof").unwrap().unwrap();
        assert_eq!(reloaded.runtime_ownership, RuntimeOwnership::External);
        assert_eq!(
            reloaded.runtime_endpoint.as_deref(),
            Some("http://127.0.0.1:18742")
        );
    }

    #[test]
    fn an_external_project_requires_an_endpoint() {
        let dir = tempfile::tempdir().unwrap();
        let mut registry = registry();
        let error = registry
            .register_project(
                "x",
                dir.path(),
                None,
                None,
                None,
                RuntimeOwnership::External,
            )
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("runtime-endpoint"),
            "the error must say what is missing: {error}"
        );
        assert!(registry.project("x").unwrap().is_none());
    }

    #[test]
    fn ownership_is_reported_in_the_remote_view() {
        let dir = tempfile::tempdir().unwrap();
        let mut registry = registry();
        let project = registry
            .register_project(
                "p1",
                dir.path(),
                None,
                None,
                Some("http://127.0.0.1:18742"),
                RuntimeOwnership::External,
            )
            .unwrap();
        let rendered = serde_json::to_string(&project.remote_view()).unwrap();
        assert!(rendered.contains("\"runtime_ownership\":\"external\""));
        // The endpoint is a host address and still never leaves the Node.
        assert!(!rendered.contains("18742"));
    }

    #[test]
    fn an_unknown_stored_ownership_fails_clearly() {
        for bad in ["", "managed", "container", "EXTERNAL", "host"] {
            let error = RuntimeOwnership::parse(bad).unwrap_err().to_string();
            assert!(
                error.contains("unknown runtime ownership"),
                "value {bad:?} produced: {error}"
            );
        }
        assert_eq!(
            RuntimeOwnership::parse("managed_container").unwrap(),
            RuntimeOwnership::ManagedContainer
        );
        assert_eq!(
            RuntimeOwnership::parse("external").unwrap(),
            RuntimeOwnership::External
        );
    }

    #[test]
    fn ownership_survives_reopening_the_registry_from_disk() {
        let home = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        {
            let mut registry = Registry::open(home.path()).unwrap();
            registry
                .register_project(
                    "ext",
                    dir.path(),
                    None,
                    None,
                    Some("http://127.0.0.1:18742"),
                    RuntimeOwnership::External,
                )
                .unwrap();
            registry
                .register_project(
                    "man",
                    second.path(),
                    None,
                    None,
                    None,
                    RuntimeOwnership::ManagedContainer,
                )
                .unwrap();
        }
        // A fresh handle is what the daemon gets after a restart.
        let reopened = Registry::open(home.path()).unwrap();
        assert_eq!(
            reopened.project("ext").unwrap().unwrap().runtime_ownership,
            RuntimeOwnership::External
        );
        assert_eq!(
            reopened.project("man").unwrap().unwrap().runtime_ownership,
            RuntimeOwnership::ManagedContainer
        );
    }
    use super::*;
    use serde_json::json;

    #[test]
    fn a_project_registered_without_an_endpoint_falls_back_to_the_node_default() {
        let dir = tempfile::tempdir().unwrap();
        let mut registry = registry();
        let project = registry
            .register_project(
                "p1",
                dir.path(),
                None,
                None,
                None,
                RuntimeOwnership::ManagedContainer,
            )
            .unwrap();
        assert_eq!(project.runtime_endpoint, None);
    }

    #[test]
    fn each_project_keeps_its_own_runtime_endpoint() {
        // Two projects on one Node listen on different host ports; resolving a
        // single Node-wide endpoint would send work to the wrong container.
        let dir = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let mut registry = registry();
        registry
            .register_project(
                "p1",
                dir.path(),
                None,
                None,
                Some("http://127.0.0.1:18642"),
                RuntimeOwnership::ManagedContainer,
            )
            .unwrap();
        registry
            .register_project(
                "p2",
                second.path(),
                None,
                None,
                Some("http://127.0.0.1:18643"),
                RuntimeOwnership::ManagedContainer,
            )
            .unwrap();

        assert_eq!(
            registry.project("p1").unwrap().unwrap().runtime_endpoint,
            Some("http://127.0.0.1:18642".to_owned())
        );
        assert_eq!(
            registry.project("p2").unwrap().unwrap().runtime_endpoint,
            Some("http://127.0.0.1:18643".to_owned())
        );
    }

    #[test]
    fn a_runtime_endpoint_is_never_sent_to_the_control_plane() {
        // It is a host address; the Control Plane addresses work by project id.
        let dir = tempfile::tempdir().unwrap();
        let mut registry = registry();
        let project = registry
            .register_project(
                "p1",
                dir.path(),
                None,
                None,
                Some("http://127.0.0.1:18642"),
                RuntimeOwnership::ManagedContainer,
            )
            .unwrap();

        let remote = serde_json::to_string(&project.remote_view()).unwrap();
        assert!(!remote.contains("18642"));
        assert!(!remote.contains("runtime_endpoint"));
        assert!(!serde_json::to_string(&project).unwrap().contains("18642"));
    }

    #[test]
    fn a_malformed_runtime_endpoint_is_refused_at_registration() {
        let dir = tempfile::tempdir().unwrap();
        let mut registry = registry();
        for bad in ["", "127.0.0.1:18642", "http://host with space"] {
            assert!(
                registry
                    .register_project(
                        "p1",
                        dir.path(),
                        None,
                        None,
                        Some(bad),
                        RuntimeOwnership::ManagedContainer
                    )
                    .is_err(),
                "endpoint {bad:?} should have been refused"
            );
        }
    }

    #[test]
    fn a_runtime_endpoint_can_be_changed_after_registration() {
        // A container rebuilt on a new port does not change project identity.
        let dir = tempfile::tempdir().unwrap();
        let mut registry = registry();
        registry
            .register_project(
                "p1",
                dir.path(),
                None,
                None,
                Some("http://127.0.0.1:18642"),
                RuntimeOwnership::ManagedContainer,
            )
            .unwrap();

        let updated = registry
            .set_project_runtime_endpoint("p1", Some("http://127.0.0.1:19000"))
            .unwrap();
        assert_eq!(
            updated.runtime_endpoint,
            Some("http://127.0.0.1:19000".to_owned())
        );

        let cleared = registry.set_project_runtime_endpoint("p1", None).unwrap();
        assert_eq!(cleared.runtime_endpoint, None);
        assert!(
            registry
                .set_project_runtime_endpoint("missing", None)
                .is_err()
        );
    }

    fn registry() -> Registry {
        Registry::open_in_memory().unwrap()
    }

    #[test]
    fn a_project_is_registered_with_a_canonical_path() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("work");
        std::fs::create_dir_all(&nested).unwrap();
        let mut registry = registry();

        let project = registry
            .register_project(
                "phase-a",
                &nested.join("..").join("work"),
                None,
                None,
                None,
                RuntimeOwnership::ManagedContainer,
            )
            .unwrap();

        assert_eq!(project.project_id, "phase-a");
        assert_eq!(project.display_name, "phase-a");
        assert!(project.enabled);
        assert!(!project.workspace_path.contains(".."));
        assert_eq!(
            project.workspace_path,
            nested.canonicalize().unwrap().to_string_lossy()
        );
    }

    #[test]
    fn duplicate_ids_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let mut registry = registry();
        registry
            .register_project(
                "p1",
                dir.path(),
                None,
                None,
                None,
                RuntimeOwnership::ManagedContainer,
            )
            .unwrap();

        assert!(
            registry
                .register_project(
                    "p1",
                    dir.path(),
                    None,
                    None,
                    None,
                    RuntimeOwnership::ManagedContainer
                )
                .is_err()
        );
    }

    #[test]
    fn traversal_and_nonexistent_paths_are_refused() {
        let mut registry = registry();

        assert!(
            registry
                .register_project(
                    "p1",
                    std::path::Path::new("/definitely/not/here"),
                    None,
                    None,
                    None,
                    RuntimeOwnership::ManagedContainer
                )
                .is_err()
        );
        // An identifier that could escape its storage namespace never reaches
        // the database.
        let dir = tempfile::tempdir().unwrap();
        assert!(
            registry
                .register_project(
                    "../escape",
                    dir.path(),
                    None,
                    None,
                    None,
                    RuntimeOwnership::ManagedContainer
                )
                .is_err()
        );
        assert!(
            registry
                .register_project(
                    "a/b",
                    dir.path(),
                    None,
                    None,
                    None,
                    RuntimeOwnership::ManagedContainer
                )
                .is_err()
        );
    }

    #[test]
    fn the_filesystem_root_cannot_be_registered() {
        let mut registry = registry();
        assert!(
            registry
                .register_project(
                    "root",
                    std::path::Path::new("/"),
                    None,
                    None,
                    None,
                    RuntimeOwnership::ManagedContainer
                )
                .is_err()
        );
    }

    #[test]
    fn projects_persist_and_list_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let mut registry = registry();
        registry
            .register_project(
                "beta",
                dir.path(),
                Some("Beta"),
                None,
                None,
                RuntimeOwnership::ManagedContainer,
            )
            .unwrap();
        let second = tempfile::tempdir().unwrap();
        registry
            .register_project(
                "alpha",
                second.path(),
                None,
                None,
                None,
                RuntimeOwnership::ManagedContainer,
            )
            .unwrap();

        let listed = registry.list_projects().unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].project_id, "alpha");
        assert_eq!(listed[1].display_name, "Beta");
    }

    #[test]
    fn a_workspace_belongs_to_exactly_one_project() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let mut registry = Registry::open(dir.path()).unwrap();
        registry
            .register_project(
                "first",
                workspace.path(),
                None,
                None,
                Some("http://127.0.0.1:18643"),
                RuntimeOwnership::External,
            )
            .unwrap();

        // Two projects sharing a directory would be two conversations editing
        // one repository while each believed it was alone.
        let second = registry.register_project(
            "second",
            workspace.path(),
            None,
            None,
            Some("http://127.0.0.1:18644"),
            RuntimeOwnership::External,
        );
        assert!(second.is_err());
    }

    #[test]
    fn binding_an_existing_project_happens_once_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let mut registry = Registry::open(dir.path()).unwrap();
        registry
            .register_project(
                "legacy",
                workspace.path(),
                None,
                None,
                None,
                // The shape a project had before endpoints were per project.
                RuntimeOwnership::ManagedContainer,
            )
            .unwrap();

        let first = registry
            .bind_existing_profile(
                "legacy",
                "/var/lib/asterism/hermes",
                "asterism-project-legacy",
                "http://127.0.0.1:18642",
                "",
            )
            .unwrap();
        assert!(first, "an unbound project is bound");

        // A second pass must be inert: re-binding would move a running project
        // onto whatever home the caller happened to pass.
        let again = registry
            .bind_existing_profile(
                "legacy",
                "/some/other/home",
                "asterism-project-other",
                "http://127.0.0.1:19999",
                "",
            )
            .unwrap();
        assert!(!again, "an already bound project is left alone");

        let project = registry.project("legacy").unwrap().unwrap();
        assert_eq!(
            project.hermes_home.as_deref(),
            Some("/var/lib/asterism/hermes")
        );
        assert_eq!(
            project.runtime_endpoint.as_deref(),
            Some("http://127.0.0.1:18642")
        );
    }

    #[test]
    fn profile_state_gates_whether_a_project_may_run() {
        assert!(ProfileState::Ready.runnable());
        for state in [
            ProfileState::Pending,
            ProfileState::Provisioning,
            ProfileState::Failed,
            ProfileState::Disabled,
        ] {
            assert!(!state.runnable(), "{} must not accept runs", state.as_str());
        }
    }

    #[test]
    fn a_failed_provisioning_keeps_the_reason_for_a_retry() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let mut registry = Registry::open(dir.path()).unwrap();
        registry
            .register_project(
                "p",
                workspace.path(),
                None,
                None,
                Some("http://127.0.0.1:18643"),
                RuntimeOwnership::External,
            )
            .unwrap();

        registry
            .set_profile_state("p", ProfileState::Failed, Some("clone_failed"))
            .unwrap();
        let project = registry.project("p").unwrap().unwrap();
        assert_eq!(project.profile_state, ProfileState::Failed);
        assert_eq!(project.profile_failure.as_deref(), Some("clone_failed"));

        // Succeeding clears the reason rather than leaving a stale one beside a
        // healthy project.
        registry
            .set_profile_runtime(
                "p",
                "/var/lib/asterism/projects/p/hermes",
                "asterism-project-p",
                "http://127.0.0.1:18643",
                "/etc/asterism/workers/p.key",
                ProfileState::Ready,
            )
            .unwrap();
        let project = registry.project("p").unwrap().unwrap();
        assert_eq!(project.profile_state, ProfileState::Ready);
        assert!(project.profile_failure.is_none());
    }

    #[test]
    fn the_remote_view_carries_state_but_never_a_home_endpoint_or_key() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let mut registry = Registry::open(dir.path()).unwrap();
        registry
            .register_project(
                "p",
                workspace.path(),
                None,
                None,
                Some("http://127.0.0.1:18643"),
                RuntimeOwnership::External,
            )
            .unwrap();
        registry
            .set_profile_runtime(
                "p",
                "/var/lib/asterism/projects/p/hermes",
                "asterism-project-p",
                "http://127.0.0.1:18643",
                "/etc/asterism/workers/p.key",
                ProfileState::Ready,
            )
            .unwrap();

        let rendered =
            serde_json::to_string(&registry.project("p").unwrap().unwrap().remote_view()).unwrap();
        assert!(rendered.contains("\"profile_state\":\"ready\""));
        for secret in [
            "/var/lib/asterism/projects",
            "18643",
            "/etc/asterism/workers",
            "asterism-project-p",
        ] {
            assert!(
                !rendered.contains(secret),
                "the remote view leaked {secret}: {rendered}"
            );
        }
    }

    #[test]
    fn inventory_survives_reopening_the_database() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        {
            let mut registry = Registry::open(dir.path()).unwrap();
            registry
                .register_project(
                    "p1",
                    workspace.path(),
                    None,
                    None,
                    None,
                    RuntimeOwnership::ManagedContainer,
                )
                .unwrap();
        }

        let registry = Registry::open(dir.path()).unwrap();
        assert_eq!(registry.list_projects().unwrap().len(), 1);
    }

    #[test]
    fn the_remote_view_never_carries_a_host_path() {
        let dir = tempfile::tempdir().unwrap();
        let mut registry = registry();
        let project = registry
            .register_project(
                "p1",
                dir.path(),
                Some("Demo"),
                Some(&json!({"env": "dev"})),
                None,
                RuntimeOwnership::ManagedContainer,
            )
            .unwrap();

        let rendered = serde_json::to_string(&project.remote_view()).unwrap();

        assert!(rendered.contains("p1"));
        assert!(rendered.contains("Demo"));
        assert!(
            !rendered.contains(&*dir.path().to_string_lossy()),
            "a host path must never be transmitted"
        );
        // The serialized record itself also hides the path.
        let record = serde_json::to_string(&project).unwrap();
        assert!(!record.contains("workspace_path"));
    }

    #[test]
    fn unregistered_and_unknown_ids_do_not_resolve() {
        let registry = registry();

        assert!(registry.resolve_remote_project("nope").unwrap().is_none());
        // A malicious id is rejected rather than reaching SQL.
        assert!(
            registry
                .resolve_remote_project("../../etc")
                .unwrap()
                .is_none()
        );
        assert!(registry.resolve_remote_project("").unwrap().is_none());
    }

    #[test]
    fn a_disabled_project_does_not_resolve_for_remote_commands() {
        let dir = tempfile::tempdir().unwrap();
        let mut registry = registry();
        registry
            .register_project(
                "p1",
                dir.path(),
                None,
                None,
                None,
                RuntimeOwnership::ManagedContainer,
            )
            .unwrap();
        registry
            .conn
            .execute(
                "UPDATE projects SET enabled = 0 WHERE project_id = 'p1'",
                [],
            )
            .unwrap();

        assert!(registry.resolve_remote_project("p1").unwrap().is_none());
    }

    #[test]
    fn unregistering_is_refused_while_a_run_is_active() {
        let dir = tempfile::tempdir().unwrap();
        let mut registry = registry();
        registry
            .register_project(
                "p1",
                dir.path(),
                None,
                None,
                None,
                RuntimeOwnership::ManagedContainer,
            )
            .unwrap();
        registry
            .create_run(&crate::registry::NewRun {
                project_id: "p1".into(),
                session_id: None,
                idempotency_key: None,
                runtime_kind: "hermes-loop".into(),
                provider: None,
                model: None,
                request_payload: json!({"input": "x"}),
                retry_of_run_id: None,
            })
            .unwrap();

        let error = registry.unregister_project("p1").unwrap_err();
        assert!(error.to_string().contains("refusing to unregister"));
        assert!(registry.project("p1").unwrap().is_some());
    }

    #[test]
    fn unregistering_an_idle_project_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let mut registry = registry();
        registry
            .register_project(
                "p1",
                dir.path(),
                None,
                None,
                None,
                RuntimeOwnership::ManagedContainer,
            )
            .unwrap();

        registry.unregister_project("p1").unwrap();

        assert!(registry.project("p1").unwrap().is_none());
        assert!(registry.unregister_project("p1").is_err());
    }
}
