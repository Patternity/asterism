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
}

impl RegisteredProject {
    /// The view sent to the Control Plane: identity and state only, no paths.
    pub fn remote_view(&self) -> Value {
        serde_json::json!({
            "project_id": self.project_id,
            "display_name": self.display_name,
            "enabled": self.enabled,
            "created_at": self.created_at,
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

        let display_name = display_name.unwrap_or(project_id);
        let now = crate::registry::now_millis();
        self.conn.execute(
            "INSERT INTO projects (project_id, workspace_path, display_name, enabled,
                                   created_at, metadata, runtime_endpoint)
             VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6)",
            params![
                project_id,
                canonical.to_string_lossy(),
                display_name,
                now,
                metadata.map(serde_json::to_string).transpose()?,
                runtime_endpoint,
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
                        runtime_endpoint
                 FROM projects WHERE project_id = ?1",
                params![project_id],
                map_project,
            )
            .optional()?)
    }

    pub fn list_projects(&self) -> Result<Vec<RegisteredProject>> {
        let mut statement = self.conn.prepare(
            "SELECT project_id, workspace_path, display_name, enabled, created_at, metadata,
                    runtime_endpoint
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
    use super::*;
    use serde_json::json;

    #[test]
    fn a_project_registered_without_an_endpoint_falls_back_to_the_node_default() {
        let dir = tempfile::tempdir().unwrap();
        let mut registry = registry();
        let project = registry
            .register_project("p1", dir.path(), None, None, None)
            .unwrap();
        assert_eq!(project.runtime_endpoint, None);
    }

    #[test]
    fn each_project_keeps_its_own_runtime_endpoint() {
        // Two projects on one Node listen on different host ports; resolving a
        // single Node-wide endpoint would send work to the wrong container.
        let dir = tempfile::tempdir().unwrap();
        let mut registry = registry();
        registry
            .register_project("p1", dir.path(), None, None, Some("http://127.0.0.1:18642"))
            .unwrap();
        registry
            .register_project("p2", dir.path(), None, None, Some("http://127.0.0.1:18643"))
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
            .register_project("p1", dir.path(), None, None, Some("http://127.0.0.1:18642"))
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
                    .register_project("p1", dir.path(), None, None, Some(bad))
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
            .register_project("p1", dir.path(), None, None, Some("http://127.0.0.1:18642"))
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
            .register_project("phase-a", &nested.join("..").join("work"), None, None, None)
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
            .register_project("p1", dir.path(), None, None, None)
            .unwrap();

        assert!(
            registry
                .register_project("p1", dir.path(), None, None, None)
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
                    None
                )
                .is_err()
        );
        // An identifier that could escape its storage namespace never reaches
        // the database.
        let dir = tempfile::tempdir().unwrap();
        assert!(
            registry
                .register_project("../escape", dir.path(), None, None, None)
                .is_err()
        );
        assert!(
            registry
                .register_project("a/b", dir.path(), None, None, None)
                .is_err()
        );
    }

    #[test]
    fn the_filesystem_root_cannot_be_registered() {
        let mut registry = registry();
        assert!(
            registry
                .register_project("root", std::path::Path::new("/"), None, None, None)
                .is_err()
        );
    }

    #[test]
    fn projects_persist_and_list_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let mut registry = registry();
        registry
            .register_project("beta", dir.path(), Some("Beta"), None, None)
            .unwrap();
        registry
            .register_project("alpha", dir.path(), None, None, None)
            .unwrap();

        let listed = registry.list_projects().unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].project_id, "alpha");
        assert_eq!(listed[1].display_name, "Beta");
    }

    #[test]
    fn inventory_survives_reopening_the_database() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        {
            let mut registry = Registry::open(dir.path()).unwrap();
            registry
                .register_project("p1", workspace.path(), None, None, None)
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
            .register_project("p1", dir.path(), None, None, None)
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
            .register_project("p1", dir.path(), None, None, None)
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
            .register_project("p1", dir.path(), None, None, None)
            .unwrap();

        registry.unregister_project("p1").unwrap();

        assert!(registry.project("p1").unwrap().is_none());
        assert!(registry.unregister_project("p1").is_err());
    }
}
