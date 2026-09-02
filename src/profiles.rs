//! Provisioning a project's own Hermes home.
//!
//! One Hermes installation serves every project. Separation comes from each
//! project owning a different `HERMES_HOME`, so its sessions, memory and state
//! database are separate files rather than rows filtered after retrieval — the
//! isolation is in the storage layout, not in a prompt.
//!
//! Nothing here accepts a path, port, profile name or key from the wire. The
//! Control Plane addresses a project by id; every local detail below is derived
//! or allocated by the Node, which is what keeps a remote caller from choosing
//! where work runs or whose state it touches.

use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use crate::inventory::{ProfileState, RegisteredProject};
use crate::registry::Registry;
use anyhow::{Context, Result, bail};

/// Reserved profile identity for host-level operations.
///
/// Held back so a project can never derive it and never be routed to it.
pub const HOST_PROFILE: &str = "asterism-host";

/// Where profile homes and their credentials live, and which ports may be used.
#[derive(Debug, Clone)]
pub struct ProvisionSettings {
    /// Parent of every project Hermes home. Never a project workspace and never
    /// the production home.
    pub home_root: PathBuf,
    /// Root-owned provider credential every worker reads and none may write.
    pub shared_auth: PathBuf,
    /// The one Codex credential this host has, reached by every worker through a
    /// link. Never copied: a copy would go stale the moment the token refreshes,
    /// and a project would keep presenting a credential the host has replaced.
    pub codex_auth: PathBuf,
    /// Lowest and highest loopback port a project worker may occupy.
    pub port_range: std::ops::RangeInclusive<u16>,
    /// Ports this Node must never hand out; the production endpoint above all.
    pub reserved_ports: Vec<u16>,
    /// The production Hermes home, refused as a project home.
    pub production_home: PathBuf,
    /// Uid the worker runs as, and therefore the only acceptable owner of its
    /// credential file.
    pub runtime_uid: u32,
}

impl ProvisionSettings {
    /// Just the parts reconciliation needs.
    pub fn credentials(&self) -> CredentialPaths {
        CredentialPaths {
            home_root: self.home_root.clone(),
            shared_auth: self.shared_auth.clone(),
            codex_auth: self.codex_auth.clone(),
        }
    }

    /// The layout for one profile.
    pub fn layout(&self, profile: &str) -> ProfileLayout {
        ProfileLayout {
            home: self.home_root.join(profile),
            profile: profile.to_owned(),
        }
    }
}

/// Paths belonging to one profile.
#[derive(Debug, Clone)]
pub struct ProfileLayout {
    pub home: PathBuf,
    pub profile: String,
}

impl ProfileLayout {
    pub fn config(&self) -> PathBuf {
        self.home.join("config.yaml")
    }

    /// Systemd reads this; it carries the worker's API key, so it is the file
    /// the inventory points at rather than a second copy of the same secret.
    pub fn runtime_env(&self) -> PathBuf {
        self.home.join("runtime.env")
    }

    pub fn auth(&self) -> PathBuf {
        self.home.join("auth.json")
    }

    /// This worker's own `CODEX_HOME`.
    ///
    /// Per worker rather than shared, because the Codex CLI keeps more than a
    /// credential here — it writes its own `log/` and temporary files — and none
    /// of that belongs to a second project. Only `auth.json` inside it is shared,
    /// and it is shared by reference.
    pub fn codex_home(&self) -> PathBuf {
        self.home.join(".codex")
    }

    pub fn codex_auth(&self) -> PathBuf {
        self.codex_home().join("auth.json")
    }

    /// Whether this home is finished. A home missing either file is a remnant
    /// of an interrupted attempt and must be rebuilt rather than trusted.
    pub fn complete(&self) -> bool {
        self.config().is_file() && self.runtime_env().is_file()
    }
}

/// What happened to one credential reference.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialLink {
    /// The link did not exist and now does.
    Created,
    /// Already pointing where it should.
    AlreadyCorrect,
    /// Pointed somewhere else and was repointed.
    Repaired,
    /// A real file is there, not a link. Left exactly as it was.
    KeptExistingFile,
}

/// Point one worker-local name at the host's credential.
///
/// The target is deliberately allowed not to exist. A host is frequently
/// provisioned before anyone authorizes a provider, and a link created only when
/// the file already existed is what made authorization order-dependent: projects
/// created first never acquired one. A dangling link costs nothing and resolves
/// itself the moment the host is authorized.
///
/// A regular file found where the link belongs is never destroyed. It may be a
/// credential somebody put there, and losing one costs a person a browser round
/// trip they have already made.
pub fn link_to_host_credential(target: &Path, link: &Path) -> Result<CredentialLink> {
    if !target.is_absolute() {
        bail!(
            "the host credential path must be absolute, not {}",
            target.display()
        );
    }
    if target
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        bail!("the host credential path must not climb out of itself");
    }

    match std::fs::symlink_metadata(link) {
        Ok(found) if found.file_type().is_symlink() => {
            let current = std::fs::read_link(link)?;
            if current == target {
                return Ok(CredentialLink::AlreadyCorrect);
            }
            std::fs::remove_file(link)?;
            std::os::unix::fs::symlink(target, link)?;
            Ok(CredentialLink::Repaired)
        }
        Ok(_) => Ok(CredentialLink::KeptExistingFile),
        Err(_) => {
            if let Some(parent) = link.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::os::unix::fs::symlink(target, link).with_context(|| {
                format!("cannot point {} at the host credential", link.display())
            })?;
            Ok(CredentialLink::Created)
        }
    }
}

/// The three paths credential reconciliation needs.
///
/// Carried separately from the full provisioning settings because the worker
/// manager reconciles on every start and has no business knowing about port
/// ranges or workspace roots.
#[derive(Debug, Clone)]
pub struct CredentialPaths {
    pub home_root: PathBuf,
    pub shared_auth: PathBuf,
    pub codex_auth: PathBuf,
}

/// Bring one existing profile home up to the current credential arrangement.
///
/// Idempotent and safe to run on every start. It creates what is missing and
/// repairs what points elsewhere; it never replaces a credential that is already
/// there, and it never touches sessions, memories, configuration or the
/// workspace.
pub fn reconcile_credentials(
    paths: &CredentialPaths,
    profile: &str,
) -> Result<Vec<(&'static str, CredentialLink)>> {
    validate_profile_name(profile)?;
    let layout = ProfileLayout {
        home: paths.home_root.join(profile),
        profile: profile.to_owned(),
    };
    if !layout.home.is_dir() {
        return Ok(Vec::new());
    }

    let mut outcomes = Vec::new();
    outcomes.push((
        "hermes",
        link_to_host_credential(&paths.shared_auth, &layout.auth())?,
    ));

    let codex_home = layout.codex_home();
    if !codex_home.is_dir() {
        std::fs::create_dir_all(&codex_home)
            .with_context(|| format!("cannot create {}", codex_home.display()))?;
    }
    // Restated every time rather than only at creation: the Codex CLI writes its
    // own log here, and a home that drifted open would expose it.
    std::fs::set_permissions(&codex_home, std::fs::Permissions::from_mode(0o700))?;
    outcomes.push((
        "codex",
        link_to_host_credential(&paths.codex_auth, &layout.codex_auth())?,
    ));
    Ok(outcomes)
}

/// A profile name is about to become a systemd instance name and a directory.
///
/// Validated rather than escaped: a name that needs escaping is a name the Node
/// did not generate, and the only safe response to that is refusal.
pub fn validate_profile_name(profile: &str) -> Result<()> {
    if profile.is_empty() || profile.len() > 72 {
        bail!("profile name must be between 1 and 72 characters");
    }
    if !profile.chars().all(|character| {
        character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
    }) {
        bail!("profile name {profile:?} must be lowercase alphanumeric or dashes");
    }
    if profile.starts_with('-') || profile.ends_with('-') {
        bail!("profile name {profile:?} must not start or end with a dash");
    }
    Ok(())
}

/// Refuse a home that would sit somewhere it must never sit.
fn validate_home(settings: &ProvisionSettings, home: &Path, workspace: &Path) -> Result<()> {
    if home == settings.production_home {
        bail!("refusing to use the production Hermes home for a project");
    }
    // Canonicalize what exists: a home nested in a workspace would put Hermes
    // state inside the repository the agent edits, where a commit could carry
    // sessions and memory into version control.
    let workspace = workspace
        .canonicalize()
        .unwrap_or_else(|_| workspace.to_path_buf());
    if home.starts_with(&workspace) {
        bail!("refusing to place a Hermes home inside a project workspace");
    }
    if !home.starts_with(&settings.home_root) {
        bail!("refusing a Hermes home outside the configured root");
    }
    Ok(())
}

/// A fresh worker key: 256 bits, independent of the project id.
///
/// Derivation from the id would make every Node with the same project able to
/// mint the same key, and would leak with the id.
fn generate_api_key() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("OS randomness is available");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The worker credential, read from the file the inventory points at.
///
/// Refuses anything a secret should not be: a symlink that could be repointed,
/// a file another account owns, or a mode that lets anyone else read it.
pub fn read_worker_key(path: &Path, expected_uid: u32) -> Result<String> {
    let metadata = std::fs::symlink_metadata(path)
        .with_context(|| format!("cannot read the worker credential at {}", path.display()))?;
    if metadata.file_type().is_symlink() {
        bail!("worker credential must be a regular file, not a symlink");
    }
    if !metadata.is_file() {
        bail!("worker credential must be a regular file");
    }
    if metadata.uid() != expected_uid {
        bail!(
            "worker credential is owned by uid {}, not {expected_uid}",
            metadata.uid()
        );
    }
    let mode = metadata.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        bail!("worker credential mode {mode:o} is readable beyond its owner");
    }
    let contents = std::fs::read_to_string(path)?;
    for line in contents.lines() {
        if let Some(value) = line.strip_prefix("API_SERVER_KEY=") {
            return Ok(value.trim().to_owned());
        }
    }
    bail!("worker credential contains no API_SERVER_KEY")
}

/// Everything a worker needs, written into one protected file.
///
/// The key lives here and nowhere else: systemd reads it as an environment
/// file, so it never reaches `ExecStart`, argv or `systemctl status`.
fn render_runtime_env(layout: &ProfileLayout, port: u16, api_key: &str) -> String {
    format!(
        "# Generated by Asterism. One project's Hermes worker.\n\
         HOME={home_parent}\n\
         HERMES_HOME={home}\n\
         HERMES_CONFIG_DIR={home}\n\
         CODEX_HOME={home}/.codex\n\
         API_SERVER_ENABLED=true\n\
         API_SERVER_HOST=127.0.0.1\n\
         API_SERVER_PORT={port}\n\
         API_SERVER_KEY={api_key}\n\
         PYTHONUNBUFFERED=1\n",
        home_parent = layout.home.parent().unwrap_or(&layout.home).display(),
        home = layout.home.display(),
        port = port,
    )
}

/// A project's Hermes configuration.
///
/// Deliberately small. Everything absent is a Hermes default; everything
/// present is something this project must not inherit from anywhere else — its
/// working directory above all, which is what makes a run edit the right
/// repository.
fn render_config(workspace: &Path, port: u16) -> String {
    format!(
        "# Generated by Asterism. Do not edit: provisioning rewrites this file.\n\
         model:\n  provider: openai-codex\n\
         database:\n  journal_mode: wal\n\
         terminal:\n  backend: local\n  cwd: {workspace}\n\
         approvals:\n  mode: manual\n\
         api_server:\n  enabled: true\n  host: 127.0.0.1\n  port: {port}\n",
        workspace = workspace.display(),
        port = port,
    )
}

/// Outcome of provisioning, so a caller can tell a fresh home from a reused one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProvisionedProfile {
    pub profile: String,
    pub home: PathBuf,
    pub endpoint: String,
    pub api_key_ref: PathBuf,
    /// False when a complete home was already present and was reused.
    pub created: bool,
}

/// Build a project's Hermes home and reserve its endpoint.
///
/// Readiness is deliberately *not* set here. A home on disk proves nothing
/// about a worker answering on a port, and a project marked ready without one
/// would be routed to and then fail every run. The worker manager promotes the
/// project after an authenticated health check.
pub fn provision_project_profile(
    registry: &mut Registry,
    settings: &ProvisionSettings,
    project_id: &str,
    occupied: &dyn Fn(u16) -> bool,
) -> Result<ProvisionedProfile> {
    let project: RegisteredProject = registry
        .project(project_id)?
        .with_context(|| format!("project {project_id} is not registered"))?;

    let profile = crate::service::default_profile_name(project_id);
    validate_profile_name(&profile)?;
    if profile == HOST_PROFILE {
        bail!("project {project_id} resolves to the reserved host profile name");
    }

    let layout = settings.layout(&profile);
    let workspace = PathBuf::from(&project.workspace_path);
    validate_home(settings, &layout.home, &workspace)?;

    registry.set_profile_state(project_id, ProfileState::Provisioning, None)?;

    let endpoint = registry.reserve_endpoint(
        project_id,
        settings.port_range.clone(),
        &settings.reserved_ports,
        occupied,
    )?;
    let port = crate::inventory::endpoint_port(&endpoint)
        .with_context(|| format!("reserved endpoint {endpoint} names no port"))?;

    // A complete home is reused rather than rebuilt: rebuilding would discard
    // the project's sessions and memory, which is the one thing provisioning
    // must never do to an existing project.
    if layout.complete() {
        registry.set_profile_runtime(
            project_id,
            &layout.home.to_string_lossy(),
            &profile,
            &endpoint,
            &layout.runtime_env().to_string_lossy(),
            ProfileState::Provisioning,
        )?;
        let api_key_ref = layout.runtime_env();
        return Ok(ProvisionedProfile {
            profile,
            home: layout.home,
            endpoint,
            api_key_ref,
            created: false,
        });
    }

    std::fs::create_dir_all(&settings.home_root)?;
    let staging = settings
        .home_root
        .join(format!(".provisioning-{profile}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);

    // Built beside the target and renamed into place, so an interrupted attempt
    // leaves a staging directory rather than a half-built home that `complete()`
    // would later accept.
    let build = || -> Result<()> {
        std::fs::create_dir_all(&staging)?;
        std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o700))?;
        for directory in ["sessions", "memories", "logs"] {
            std::fs::create_dir_all(staging.join(directory))?;
        }

        let staged_layout = ProfileLayout {
            home: staging.clone(),
            profile: profile.clone(),
        };
        std::fs::write(staged_layout.config(), render_config(&workspace, port))?;
        std::fs::set_permissions(
            staged_layout.config(),
            std::fs::Permissions::from_mode(0o600),
        )?;

        // The provider credentials are host-owned, and both links are created
        // whether or not the target exists yet. Creating them only when the file
        // was already there made authorization order-dependent: a project
        // provisioned before the host was authorized never acquired the link, so
        // it stayed unable to reach a model until somebody rebuilt its home —
        // silently, with nothing in the interface to say why.
        link_to_host_credential(&settings.shared_auth, &staged_layout.auth())?;
        std::fs::create_dir_all(staged_layout.codex_home())?;
        std::fs::set_permissions(
            staged_layout.codex_home(),
            std::fs::Permissions::from_mode(0o700),
        )?;
        link_to_host_credential(&settings.codex_auth, &staged_layout.codex_auth())?;

        // Written last: `complete()` tests for it, so a crash before this point
        // leaves a home that will be rebuilt rather than trusted.
        let final_layout = settings.layout(&profile);
        std::fs::write(
            staged_layout.runtime_env(),
            render_runtime_env(&final_layout, port, &generate_api_key()),
        )?;
        std::fs::set_permissions(
            staged_layout.runtime_env(),
            std::fs::Permissions::from_mode(0o600),
        )?;
        Ok(())
    };

    if let Err(error) = build() {
        let _ = std::fs::remove_dir_all(&staging);
        registry.release_endpoint(project_id)?;
        registry.set_profile_state(
            project_id,
            ProfileState::Failed,
            Some("profile_home_failed"),
        )?;
        return Err(error);
    }

    if let Err(error) = std::fs::rename(&staging, &layout.home) {
        let _ = std::fs::remove_dir_all(&staging);
        registry.release_endpoint(project_id)?;
        registry.set_profile_state(
            project_id,
            ProfileState::Failed,
            Some("profile_home_failed"),
        )?;
        return Err(error).context("cannot commit the profile home");
    }

    registry.set_profile_runtime(
        project_id,
        &layout.home.to_string_lossy(),
        &profile,
        &endpoint,
        &layout.runtime_env().to_string_lossy(),
        ProfileState::Provisioning,
    )?;

    let api_key_ref = layout.runtime_env();
    Ok(ProvisionedProfile {
        profile,
        home: layout.home,
        endpoint,
        api_key_ref,
        created: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inventory::RuntimeOwnership;

    fn settings(root: &Path) -> ProvisionSettings {
        ProvisionSettings {
            home_root: root.join("hermes-projects"),
            shared_auth: root.join("shared/auth.json"),
            codex_auth: root.join("shared/codex/auth.json"),
            port_range: 18700..=18705,
            reserved_ports: vec![18642],
            production_home: root.join("hermes"),
            runtime_uid: nix_uid(),
        }
    }

    fn nix_uid() -> u32 {
        // The tests run as whoever invoked cargo; the credential check compares
        // against that rather than a hardcoded service account.
        unsafe { libc::getuid() }
    }

    fn registry_with_project(root: &Path, project_id: &str, workspace: &Path) -> Registry {
        let mut registry = Registry::open(root).unwrap();
        registry
            .register_project(
                project_id,
                workspace,
                None,
                None,
                None,
                RuntimeOwnership::ManagedContainer,
            )
            .unwrap();
        registry
    }

    #[test]
    fn a_profile_name_that_could_become_a_shell_or_unit_argument_is_refused() {
        for bad in [
            "",
            "UPPER",
            "has space",
            "semi;colon",
            "-leading",
            "trailing-",
            "sub/dir",
            "dot.dot",
        ] {
            assert!(
                validate_profile_name(bad).is_err(),
                "{bad:?} must be refused"
            );
        }
        assert!(validate_profile_name("asterism-project-abc123").is_ok());
    }

    #[test]
    fn provisioning_creates_a_clean_home_with_the_projects_own_workspace() {
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let mut registry = registry_with_project(root.path(), "alpha", workspace.path());
        let settings = settings(root.path());

        let provisioned =
            provision_project_profile(&mut registry, &settings, "alpha", &|_| false).unwrap();

        assert!(provisioned.created);
        assert!(provisioned.home.join("sessions").is_dir());
        assert!(provisioned.home.join("memories").is_dir());

        // Fresh state: nothing is copied from anywhere, so there is no database
        // and no session to inherit.
        assert!(!provisioned.home.join("state.db").exists());
        assert_eq!(
            std::fs::read_dir(provisioned.home.join("sessions"))
                .unwrap()
                .count(),
            0
        );

        let config = std::fs::read_to_string(provisioned.home.join("config.yaml")).unwrap();
        assert!(config.contains(&format!("cwd: {}", workspace.path().display())));
        assert!(config.contains("journal_mode: wal"));
    }

    #[test]
    fn the_worker_credential_is_owner_only_and_never_reaches_the_inventory_row() {
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let mut registry = registry_with_project(root.path(), "alpha", workspace.path());
        let settings = settings(root.path());

        let provisioned =
            provision_project_profile(&mut registry, &settings, "alpha", &|_| false).unwrap();

        let mode = std::fs::metadata(&provisioned.api_key_ref)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "credential mode {mode:o} is too permissive");

        let key = read_worker_key(&provisioned.api_key_ref, settings.runtime_uid).unwrap();
        assert_eq!(key.len(), 64, "expected 256 bits of hex");

        // The row points at the file and never carries the value.
        let project = registry.project("alpha").unwrap().unwrap();
        let row = format!("{project:?}");
        assert!(!row.contains(&key), "the inventory row carries the key");
    }

    #[test]
    fn two_projects_receive_different_homes_keys_and_ports() {
        let root = tempfile::tempdir().unwrap();
        let first_workspace = tempfile::tempdir().unwrap();
        let second_workspace = tempfile::tempdir().unwrap();
        let settings = settings(root.path());
        let mut registry = registry_with_project(root.path(), "alpha", first_workspace.path());
        registry
            .register_project(
                "beta",
                second_workspace.path(),
                None,
                None,
                None,
                RuntimeOwnership::ManagedContainer,
            )
            .unwrap();

        let alpha =
            provision_project_profile(&mut registry, &settings, "alpha", &|_| false).unwrap();
        let beta = provision_project_profile(&mut registry, &settings, "beta", &|_| false).unwrap();

        assert_ne!(alpha.home, beta.home);
        assert_ne!(alpha.endpoint, beta.endpoint);
        let alpha_key = read_worker_key(&alpha.api_key_ref, settings.runtime_uid).unwrap();
        let beta_key = read_worker_key(&beta.api_key_ref, settings.runtime_uid).unwrap();
        assert_ne!(alpha_key, beta_key, "workers must not share a credential");
    }

    #[test]
    fn re_provisioning_reuses_a_complete_home_rather_than_rebuilding_it() {
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let mut registry = registry_with_project(root.path(), "alpha", workspace.path());
        let settings = settings(root.path());

        let first =
            provision_project_profile(&mut registry, &settings, "alpha", &|_| false).unwrap();
        let key_before = read_worker_key(&first.api_key_ref, settings.runtime_uid).unwrap();
        std::fs::write(first.home.join("memories/marker"), b"remembered").unwrap();

        let second =
            provision_project_profile(&mut registry, &settings, "alpha", &|_| false).unwrap();

        assert!(!second.created, "a complete home is reused");
        assert_eq!(first.home, second.home);
        assert_eq!(first.endpoint, second.endpoint, "a reserved port is stable");
        // Rebuilding would have discarded the project's memory and rotated a key
        // other state already points at.
        assert!(second.home.join("memories/marker").exists());
        assert_eq!(
            key_before,
            read_worker_key(&second.api_key_ref, settings.runtime_uid).unwrap()
        );
    }

    #[test]
    fn provisioning_never_touches_the_project_workspace() {
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("README.md"), b"existing work").unwrap();
        let mut registry = registry_with_project(root.path(), "alpha", workspace.path());
        let settings = settings(root.path());

        provision_project_profile(&mut registry, &settings, "alpha", &|_| false).unwrap();

        assert_eq!(
            std::fs::read_to_string(workspace.path().join("README.md")).unwrap(),
            "existing work"
        );
    }

    #[test]
    fn a_home_inside_the_workspace_or_at_the_production_home_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let mut settings = settings(root.path());

        // Hermes state inside the repository would let a commit carry sessions
        // and memory into version control.
        settings.home_root = workspace.path().to_path_buf();
        assert!(
            validate_home(
                &settings,
                &workspace.path().join("asterism-project-a"),
                workspace.path()
            )
            .is_err()
        );

        let mut settings = self::tests::settings(root.path());
        settings.production_home = settings.home_root.join("asterism-project-a");
        assert!(
            validate_home(
                &settings,
                &settings.home_root.join("asterism-project-a"),
                workspace.path()
            )
            .is_err()
        );
    }

    #[test]
    fn a_credential_that_is_a_symlink_or_world_readable_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("runtime.env");
        std::fs::write(&real, "API_SERVER_KEY=abc\n").unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(read_worker_key(&real, nix_uid()).is_ok());

        // A symlink can be repointed by anyone who can write its directory.
        let link = root.path().join("linked.env");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(read_worker_key(&link, nix_uid()).is_err());

        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_worker_key(&real, nix_uid()).is_err());
    }
}
