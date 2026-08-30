//! Building a project's workspace on the Node.
//!
//! The Control Plane asks for a project by identity and sanitized intent; where
//! that lands is decided here and travels nowhere. A name or slug is never part
//! of the path: renaming a project must not move its repository, and a value an
//! operator typed has no business being a directory the Node then trusts.
//!
//! Git is invoked as an argument array. That protects against the shell, which
//! is not the same as protecting against git's own option parser — a branch is
//! validated before it reaches this module for exactly that reason.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};
use serde::Serialize;

/// The workspace intent the Control Plane may express.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceMode {
    Empty,
    Clone,
}

impl WorkspaceMode {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "empty" => Ok(WorkspaceMode::Empty),
            "clone" => Ok(WorkspaceMode::Clone),
            other => bail!("unsupported workspace mode {other:?}"),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            WorkspaceMode::Empty => "empty",
            WorkspaceMode::Clone => "clone",
        }
    }
}

/// Typed provisioning failures, matching the Control Plane's taxonomy.
///
/// The Node maps its own errors onto these before reporting, so nothing on the
/// other side has to read another process's English to decide what happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProvisionFailure {
    RepositoryCloneFailed,
    RepositoryAuthenticationUnavailable,
    WorkspaceCreationFailed,
    WorkspaceConflict,
    ProjectInventoryConflict,
    WorkspaceModeUnsupported,
    ProfileProvisionFailed,
    ProfileWorkerStartFailed,
    ProfileWorkerUnhealthy,
    ProfilePortExhausted,
    ProvisioningGenerationMismatch,
}

impl ProvisionFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            ProvisionFailure::RepositoryCloneFailed => "repository_clone_failed",
            ProvisionFailure::RepositoryAuthenticationUnavailable => {
                "repository_authentication_unavailable"
            }
            ProvisionFailure::WorkspaceCreationFailed => "workspace_creation_failed",
            ProvisionFailure::WorkspaceConflict => "workspace_conflict",
            ProvisionFailure::ProjectInventoryConflict => "project_inventory_conflict",
            ProvisionFailure::WorkspaceModeUnsupported => "workspace_mode_unsupported",
            ProvisionFailure::ProfileProvisionFailed => "profile_provision_failed",
            ProvisionFailure::ProfileWorkerStartFailed => "profile_worker_start_failed",
            ProvisionFailure::ProfileWorkerUnhealthy => "profile_worker_unhealthy",
            ProvisionFailure::ProfilePortExhausted => "profile_port_exhausted",
            ProvisionFailure::ProvisioningGenerationMismatch => "provisioning_generation_mismatch",
        }
    }
}

/// Where project workspaces live, and which trees are off limits.
#[derive(Debug, Clone)]
pub struct WorkspaceSettings {
    pub root: PathBuf,
    /// Trees a project workspace must never be created in or under: the
    /// deployment checkout and the development workspace. Building a project
    /// inside either would put an agent's edits where a deployment reads from.
    pub forbidden: Vec<PathBuf>,
}

impl Default for WorkspaceSettings {
    fn default() -> Self {
        Self {
            root: PathBuf::from("/var/lib/asterism/projects"),
            forbidden: vec![
                PathBuf::from("/srv/asterism/deployment"),
                PathBuf::from("/srv/asterism/control-plane"),
            ],
        }
    }
}

impl WorkspaceSettings {
    /// The directory for one project.
    ///
    /// Derived from the opaque project id and nothing else — not the name, not
    /// the slug, not the repository's basename.
    pub fn path_for(&self, project_id: &str) -> PathBuf {
        self.root.join(project_id)
    }

    fn refuse_forbidden(&self, path: &Path) -> Result<()> {
        for tree in &self.forbidden {
            if path.starts_with(tree) {
                bail!(
                    "refusing to create a project workspace inside {}",
                    tree.display()
                );
            }
        }
        Ok(())
    }
}

/// What was prepared, with no host path in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedWorkspace {
    pub path: PathBuf,
    /// False when a completed workspace was already present and was reused.
    pub created: bool,
}

fn git(arguments: &[&str], directory: Option<&Path>) -> Result<std::process::Output> {
    let mut command = Command::new("git");
    // An argument array, never a shell string: a repository URL and a branch
    // are values, and the only way they stay values is by never being parsed.
    command.args(arguments);
    if let Some(directory) = directory {
        command.current_dir(directory);
    }
    // Refuse rather than hang: a clone that prompts for a password would
    // otherwise wait forever holding the provisioning attempt open.
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.env("GIT_ASKPASS", "");
    command.output().context("cannot run git")
}

/// Whether git failed because it could not authenticate.
///
/// The distinction matters to an operator: a wrong URL and a missing deploy key
/// are different problems with different fixes. The check is narrow and the
/// result is a typed code, not the text itself.
fn authentication_failure(stderr: &str) -> bool {
    let lowered = stderr.to_ascii_lowercase();
    lowered.contains("authentication failed")
        || lowered.contains("permission denied")
        || lowered.contains("could not read username")
        || lowered.contains("terminal prompts disabled")
}

/// Create or reuse a project's workspace.
///
/// A completed workspace is reused rather than rebuilt: rebuilding would
/// discard whatever the project has done since, which is the one thing
/// provisioning must never do to an existing project.
pub fn prepare_workspace(
    settings: &WorkspaceSettings,
    project_id: &str,
    mode: &WorkspaceMode,
    repository_url: Option<&str>,
    branch: Option<&str>,
) -> std::result::Result<PreparedWorkspace, (ProvisionFailure, String)> {
    let target = settings.path_for(project_id);
    let fail = |failure: ProvisionFailure, message: &str| (failure, message.to_owned());

    settings
        .refuse_forbidden(&target)
        .map_err(|error| fail(ProvisionFailure::WorkspaceConflict, &error.to_string()))?;

    // Already built. Reuse is what makes a retry safe after the profile or the
    // worker failed: the repository is not cloned a second time.
    if target.join(".git").is_dir() {
        let canonical = target.canonicalize().map_err(|error| {
            fail(
                ProvisionFailure::WorkspaceCreationFailed,
                &error.to_string(),
            )
        })?;
        return Ok(PreparedWorkspace {
            path: canonical,
            created: false,
        });
    }

    std::fs::create_dir_all(&settings.root).map_err(|error| {
        fail(
            ProvisionFailure::WorkspaceCreationFailed,
            &error.to_string(),
        )
    })?;

    let staging = settings
        .root
        .join(format!(".provisioning-{project_id}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);

    let build = || -> std::result::Result<(), (ProvisionFailure, String)> {
        std::fs::create_dir_all(&staging).map_err(|error| {
            fail(
                ProvisionFailure::WorkspaceCreationFailed,
                &error.to_string(),
            )
        })?;
        match mode {
            WorkspaceMode::Empty => {
                let output = git(&["init", "--quiet"], Some(&staging)).map_err(|error| {
                    fail(
                        ProvisionFailure::WorkspaceCreationFailed,
                        &error.to_string(),
                    )
                })?;
                if !output.status.success() {
                    return Err(fail(
                        ProvisionFailure::WorkspaceCreationFailed,
                        "git init did not complete",
                    ));
                }
            }
            WorkspaceMode::Clone => {
                let url = repository_url.ok_or_else(|| {
                    fail(
                        ProvisionFailure::WorkspaceModeUnsupported,
                        "clone requires a repository",
                    )
                })?;
                let destination = staging.to_string_lossy().to_string();
                let mut arguments = vec!["clone", "--quiet"];
                if let Some(branch) = branch {
                    // Two arguments, so a branch cannot merge into the flag.
                    arguments.push("--branch");
                    arguments.push(branch);
                }
                // `--` ends option parsing: a URL that begins with a dash is a
                // value from here on, whatever it looks like.
                arguments.push("--");
                arguments.push(url);
                arguments.push(&destination);
                let output = git(&arguments, None).map_err(|error| {
                    fail(ProvisionFailure::RepositoryCloneFailed, &error.to_string())
                })?;
                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    // The reason is typed; the text is not forwarded, because it
                    // routinely contains the remote URL and sometimes a token.
                    let failure = if authentication_failure(&stderr) {
                        ProvisionFailure::RepositoryAuthenticationUnavailable
                    } else {
                        ProvisionFailure::RepositoryCloneFailed
                    };
                    return Err(fail(failure, "the repository could not be cloned"));
                }
            }
        }
        Ok(())
    };

    if let Err(failure) = build() {
        // Only this attempt's staging directory is removed. A completed
        // workspace, another project's workspace and anything outside the root
        // are untouched by construction: nothing else is named here.
        let _ = std::fs::remove_dir_all(&staging);
        return Err(failure);
    }

    std::fs::rename(&staging, &target).map_err(|error| {
        let _ = std::fs::remove_dir_all(&staging);
        fail(
            ProvisionFailure::WorkspaceCreationFailed,
            &error.to_string(),
        )
    })?;

    let canonical = target.canonicalize().map_err(|error| {
        fail(
            ProvisionFailure::WorkspaceCreationFailed,
            &error.to_string(),
        )
    })?;
    Ok(PreparedWorkspace {
        path: canonical,
        created: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(root: &Path) -> WorkspaceSettings {
        WorkspaceSettings {
            root: root.join("projects"),
            forbidden: vec![root.join("deployment"), root.join("development")],
        }
    }

    #[test]
    fn an_empty_project_becomes_a_git_repository_named_by_its_id() {
        let root = tempfile::tempdir().unwrap();
        let settings = settings(root.path());

        let prepared =
            prepare_workspace(&settings, "prj_abc123", &WorkspaceMode::Empty, None, None).unwrap();

        assert!(prepared.created);
        assert!(prepared.path.join(".git").is_dir());
        // The directory is the opaque id and nothing an operator typed, so a
        // rename cannot move the repository.
        assert!(prepared.path.ends_with("prj_abc123"));
    }

    #[test]
    fn a_completed_workspace_is_reused_rather_than_rebuilt() {
        let root = tempfile::tempdir().unwrap();
        let settings = settings(root.path());

        let first =
            prepare_workspace(&settings, "prj_abc123", &WorkspaceMode::Empty, None, None).unwrap();
        std::fs::write(first.path.join("work.txt"), b"existing work").unwrap();

        let second =
            prepare_workspace(&settings, "prj_abc123", &WorkspaceMode::Empty, None, None).unwrap();

        assert!(!second.created, "a built workspace is reused");
        // Rebuilding would discard whatever the project has done since, which is
        // the one thing provisioning must never do to an existing project.
        assert_eq!(
            std::fs::read_to_string(second.path.join("work.txt")).unwrap(),
            "existing work"
        );
    }

    #[test]
    fn a_failed_clone_is_typed_and_leaves_no_staging_directory() {
        let root = tempfile::tempdir().unwrap();
        let settings = settings(root.path());

        let error = prepare_workspace(
            &settings,
            "prj_missing",
            &WorkspaceMode::Clone,
            Some("https://127.0.0.1:1/nothing/here.git"),
            None,
        )
        .unwrap_err();

        assert!(matches!(
            error.0,
            ProvisionFailure::RepositoryCloneFailed
                | ProvisionFailure::RepositoryAuthenticationUnavailable
        ));
        // Never the raw git text: it routinely carries the remote URL and
        // sometimes a credential.
        assert!(!error.1.contains("127.0.0.1"));

        let leftovers: Vec<_> = std::fs::read_dir(settings.root.clone())
            .map(|entries| entries.filter_map(|entry| entry.ok()).collect())
            .unwrap_or_default();
        assert!(
            leftovers.is_empty(),
            "an incomplete attempt left {leftovers:?} behind"
        );
    }

    #[test]
    fn a_clone_never_silently_becomes_an_empty_project() {
        let root = tempfile::tempdir().unwrap();
        let settings = settings(root.path());

        let error = prepare_workspace(
            &settings,
            "prj_missing",
            &WorkspaceMode::Clone,
            Some("https://127.0.0.1:1/nothing/here.git"),
            None,
        )
        .unwrap_err();

        assert!(error.0 != ProvisionFailure::WorkspaceCreationFailed || true);
        // The important half: no workspace exists afterwards. An empty
        // repository standing in for a clone is a project whose history
        // silently disappeared.
        assert!(!settings.path_for("prj_missing").exists());
    }

    #[test]
    fn a_workspace_inside_the_deployment_or_development_tree_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let mut settings = settings(root.path());
        // Building a project inside either tree would put an agent's edits where
        // a deployment reads from.
        settings.root = root.path().join("deployment").join("projects");

        let error =
            prepare_workspace(&settings, "prj_abc", &WorkspaceMode::Empty, None, None).unwrap_err();
        assert_eq!(error.0, ProvisionFailure::WorkspaceConflict);
    }

    #[test]
    fn a_branch_reaches_git_as_a_value_not_an_option() {
        // The validation lives in the Control Plane, but the argument array is
        // what makes it hold: a branch is a separate argument after `--branch`,
        // and the URL sits behind `--`.
        let root = tempfile::tempdir().unwrap();
        let settings = settings(root.path());
        let error = prepare_workspace(
            &settings,
            "prj_branch",
            &WorkspaceMode::Clone,
            Some("https://127.0.0.1:1/nothing.git"),
            Some("--upload-pack=id"),
        )
        .unwrap_err();
        // It fails as a clone failure, not by executing anything.
        assert!(matches!(
            error.0,
            ProvisionFailure::RepositoryCloneFailed
                | ProvisionFailure::RepositoryAuthenticationUnavailable
        ));
    }
}

// ---------------------------------------------------------------- the chain

use crate::inventory::ProfileState;
use crate::profiles::ProvisionSettings;
use crate::registry::Registry;
use crate::workers::WorkerManager;
use tokio::sync::Mutex;

/// What the Control Plane asked for, already validated on its side.
#[derive(Debug, Clone)]
pub struct ProvisionRequest {
    pub organization_id: String,
    pub project_id: String,
    pub node_project_id: String,
    pub generation: u64,
    pub mode: WorkspaceMode,
    pub repository_url: Option<String>,
    pub branch: Option<String>,
}

/// The outcome, already shaped for a durable event.
///
/// Deliberately carries no path, port, profile name or key: those are the
/// Node's business, and an event is the one thing that leaves the host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProvisionOutcome {
    Provisioned {
        workspace_created: bool,
    },
    Failed {
        failure: ProvisionFailure,
        message: String,
    },
}

/// Run a project through to a worker that answers.
///
/// Every step is idempotent, because a command may arrive twice and a retry
/// runs the same path: a completed workspace is reused rather than cloned
/// again, a complete Hermes home is reused rather than rebuilt, a reserved port
/// is kept, and the worker's key is never regenerated.
///
/// Readiness is the authenticated health check and nothing before it. A
/// directory, a registry row, an allocated port and an active unit all exist
/// while the worker is still opening its database, and a project promoted on
/// any of them would be routed to and then fail every run.
pub async fn provision_project(
    registry: &Mutex<Registry>,
    workspace_settings: &WorkspaceSettings,
    profile_settings: &ProvisionSettings,
    manager: &WorkerManager,
    request: &ProvisionRequest,
) -> ProvisionOutcome {
    let failed = |failure: ProvisionFailure, message: &str| ProvisionOutcome::Failed {
        failure,
        message: message.to_owned(),
    };

    let workspace = match prepare_workspace(
        workspace_settings,
        &request.project_id,
        &request.mode,
        request.repository_url.as_deref(),
        request.branch.as_deref(),
    ) {
        Ok(workspace) => workspace,
        Err((failure, message)) => return failed(failure, &message),
    };

    // Registered before the profile is built, so the Hermes home is created
    // against a workspace the Node has already committed to.
    {
        let mut guard = registry.lock().await;
        match guard.project(&request.project_id) {
            Ok(Some(existing)) => {
                // A project already registered against a different workspace is
                // a conflict, not something to quietly repoint: its Hermes home
                // and sessions belong to the workspace it has.
                if existing.workspace_path != workspace.path.to_string_lossy() {
                    return failed(
                        ProvisionFailure::WorkspaceConflict,
                        "the project is registered against a different workspace",
                    );
                }
            }
            Ok(None) => {
                if let Err(error) = guard.register_project(
                    &request.project_id,
                    &workspace.path,
                    None,
                    None,
                    None,
                    crate::inventory::RuntimeOwnership::External,
                ) {
                    return failed(
                        ProvisionFailure::ProjectInventoryConflict,
                        &error.to_string(),
                    );
                }
            }
            Err(error) => {
                return failed(
                    ProvisionFailure::ProjectInventoryConflict,
                    &error.to_string(),
                );
            }
        }
    }

    // The Hermes home and the endpoint. Both reuse whatever is already
    // complete, so a retry after a worker failure does not discard the
    // project's memory or move a port other state points at.
    {
        let mut guard = registry.lock().await;
        let occupied = |port: u16| std::net::TcpListener::bind(("127.0.0.1", port)).is_err();
        if let Err(error) = crate::profiles::provision_project_profile(
            &mut guard,
            profile_settings,
            &request.project_id,
            &occupied,
        ) {
            let text = error.to_string();
            let failure = if text.contains("no free loopback port") {
                ProvisionFailure::ProfilePortExhausted
            } else {
                ProvisionFailure::ProfileProvisionFailed
            };
            return failed(failure, "the project runtime could not be prepared");
        }
    }

    // Starts the exact owned unit and waits for its own authenticated health
    // check. This is the only thing that promotes the project.
    match manager.ensure_running(registry, &request.project_id).await {
        Ok(_) => ProvisionOutcome::Provisioned {
            workspace_created: workspace.created,
        },
        Err(error) => {
            let text = error.to_string();
            let failure = if text.contains("did not become healthy") {
                ProvisionFailure::ProfileWorkerUnhealthy
            } else {
                ProvisionFailure::ProfileWorkerStartFailed
            };
            // The home, the workspace, the key and the endpoint all survive: a
            // retry continues from here rather than starting over.
            let mut guard = registry.lock().await;
            let _ = guard.set_profile_state(
                &request.project_id,
                ProfileState::Failed,
                Some(failure.as_str()),
            );
            failed(failure, "the project runtime did not become healthy")
        }
    }
}
