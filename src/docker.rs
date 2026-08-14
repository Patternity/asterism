use std::fs;
use std::io::IsTerminal;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use anyhow::{Context, Result, bail};

pub const HERMES_CONTAINER_PORT: u16 = 8642;
/// Default project runtime image, pinned by manifest digest.
///
/// A digest rather than a tag because a tag can be repointed at different
/// content: two Nodes provisioning "the same" project would then run different
/// software. This reference is published by
/// `.github/workflows/project-runtime-image.yml` and verified to pull without
/// authentication before it is recorded here.
///
/// Platform: `linux/amd64` only. Nothing else is built or tested.
///
/// To move it, publish a new image from `master`, verify the digest pulls
/// anonymously, then update this constant — never a placeholder, never a tag.
pub const DEFAULT_HERMES_IMAGE: &str = "ghcr.io/patternity/asterism-project-runtime@sha256:1d280b6595e465909ab93759a4406688c7a156f3f556d90c7b22e58765cd3144";

/// Whether an image reference names immutable content.
///
/// Only a manifest digest does. A tag — including `latest` — is a moving
/// pointer, so two provisioning runs can produce different software from the
/// same command.
pub fn is_digest_pinned(image: &str) -> bool {
    match image.split_once('@') {
        Some((name, digest)) => {
            !name.is_empty()
                && digest.starts_with("sha256:")
                && digest.len() == "sha256:".len() + 64
                && digest["sha256:".len()..]
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit())
        }
        None => false,
    }
}

/// Hermes data bind mount inside the project container. Everything that must
/// survive a container rebuild lives under this path.
pub const CONTAINER_DATA_DIR: &str = "/opt/data";

/// Project workspace bind mount inside the project container.
pub const CONTAINER_WORKSPACE_DIR: &str = "/workspace";

/// Codex CLI state directory. Codex defaults to `$HOME/.codex`; Phase B pins it
/// to an explicit path inside the Hermes data mount so that Codex credentials
/// and thread state persist across container rebuilds and stay separate from
/// the Hermes provider credentials in `auth.json`.
pub const CONTAINER_CODEX_HOME: &str = "/opt/data/codex";

/// `CONTAINER_CODEX_HOME` relative to the Hermes data mount, used to pre-create
/// the directory host-side with the right ownership.
pub const CODEX_HOME_SUBDIR: &str = "codex";

/// Hermes terminal security mode. Hermes maps this onto the Codex permission
/// profile used by the native `codex app-server` runtime:
///
/// | Hermes mode         | Codex profile              |
/// |---------------------|----------------------------|
/// | `auto`              | `workspace-write`          |
/// | `approval-required` | `read-only-with-approval`  |
/// | `unrestricted`      | `full-access`              |
///
/// Phase A observed dangerous commands executing without an `approval.request`
/// event; the default `auto` mode is the reason. Phase B exposes the mode so an
/// approval-forwarding test can select `approval-required` deliberately.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalSecurityMode {
    Auto,
    ApprovalRequired,
    Unrestricted,
}

impl TerminalSecurityMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::ApprovalRequired => "approval-required",
            Self::Unrestricted => "unrestricted",
        }
    }
}

impl std::fmt::Display for TerminalSecurityMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone)]
pub struct ProjectContainerSpec {
    pub project_id: String,
    pub workspace: PathBuf,
    pub hermes_data: PathBuf,
    pub image: String,
    pub api_port: u16,
    pub memory: String,
    pub cpus: String,
    pub pids_limit: u32,
    pub runtime_uid: u32,
    pub runtime_gid: u32,
    pub terminal_security: TerminalSecurityMode,
}

impl ProjectContainerSpec {
    pub fn new(
        project_id: impl Into<String>,
        workspace: impl AsRef<Path>,
        hermes_data: impl AsRef<Path>,
        image: impl Into<String>,
        api_port: u16,
    ) -> Result<Self> {
        let project_id = project_id.into();
        validate_project_id(&project_id)?;
        if api_port == 0 {
            bail!("API port must be non-zero");
        }

        let image = image.into();
        if image.trim().is_empty() {
            bail!("Hermes image reference must not be empty");
        }

        let workspace = workspace.as_ref();
        if !workspace.is_dir() {
            bail!(
                "workspace does not exist or is not a directory: {}",
                workspace.display()
            );
        }

        fs::create_dir_all(hermes_data.as_ref()).with_context(|| {
            format!(
                "failed to create Hermes data directory {}",
                hermes_data.as_ref().display()
            )
        })?;

        // Codex refuses to create PATH aliases when CODEX_HOME is missing, and
        // creating it from inside the container would produce a root-owned
        // directory. Create it host-side so it is owned by the same user as the
        // rest of the persistent state.
        let codex_home = hermes_data.as_ref().join(CODEX_HOME_SUBDIR);
        fs::create_dir_all(&codex_home).with_context(|| {
            format!(
                "failed to create Codex home directory {}",
                codex_home.display()
            )
        })?;

        let workspace = workspace
            .canonicalize()
            .context("failed to canonicalize project workspace")?;
        let hermes_data = hermes_data
            .as_ref()
            .canonicalize()
            .context("failed to canonicalize Hermes data directory")?;

        reject_ambiguous_bind_path(&workspace)?;
        reject_ambiguous_bind_path(&hermes_data)?;
        if workspace == Path::new("/") || hermes_data == Path::new("/") {
            bail!("project mounts must never target the host root directory");
        }
        if workspace.starts_with(&hermes_data) || hermes_data.starts_with(&workspace) {
            bail!("workspace and Hermes data directories must not overlap");
        }

        let workspace_metadata =
            fs::metadata(&workspace).context("failed to read project workspace ownership")?;

        Ok(Self {
            project_id,
            workspace,
            hermes_data,
            image,
            api_port,
            memory: "4g".to_owned(),
            cpus: "2".to_owned(),
            pids_limit: 512,
            runtime_uid: workspace_metadata.uid(),
            runtime_gid: workspace_metadata.gid(),
            terminal_security: TerminalSecurityMode::Auto,
        })
    }

    pub fn with_terminal_security(mut self, mode: TerminalSecurityMode) -> Self {
        self.terminal_security = mode;
        self
    }

    pub fn container_name(&self) -> String {
        format!("asterism-project-{}", self.project_id)
    }

    pub fn api_base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.api_port)
    }

    pub fn create_args(&self) -> Vec<String> {
        vec![
            "create".to_owned(),
            "--name".to_owned(),
            self.container_name(),
            "--label".to_owned(),
            "io.asterism.managed=true".to_owned(),
            "--label".to_owned(),
            format!("io.asterism.project-id={}", self.project_id),
            "--restart".to_owned(),
            "unless-stopped".to_owned(),
            "--cap-drop".to_owned(),
            "ALL".to_owned(),
            "--cap-add".to_owned(),
            "SETUID".to_owned(),
            "--cap-add".to_owned(),
            "SETGID".to_owned(),
            "--cap-add".to_owned(),
            "CHOWN".to_owned(),
            "--cap-add".to_owned(),
            "DAC_OVERRIDE".to_owned(),
            "--cap-add".to_owned(),
            "FOWNER".to_owned(),
            "--security-opt".to_owned(),
            "no-new-privileges:true".to_owned(),
            "--pids-limit".to_owned(),
            self.pids_limit.to_string(),
            "--memory".to_owned(),
            self.memory.clone(),
            "--cpus".to_owned(),
            self.cpus.clone(),
            "--publish".to_owned(),
            format!("127.0.0.1:{}:{}", self.api_port, HERMES_CONTAINER_PORT),
            "--volume".to_owned(),
            format!("{}:/workspace:rw", self.workspace.display()),
            "--volume".to_owned(),
            format!("{}:/opt/data:rw", self.hermes_data.display()),
            "--workdir".to_owned(),
            "/workspace".to_owned(),
            "--env".to_owned(),
            "API_SERVER_ENABLED=true".to_owned(),
            "--env".to_owned(),
            "API_SERVER_HOST=0.0.0.0".to_owned(),
            "--env".to_owned(),
            format!("API_SERVER_PORT={HERMES_CONTAINER_PORT}"),
            "--env".to_owned(),
            "API_SERVER_KEY".to_owned(),
            "--env".to_owned(),
            "HOME=/opt/data".to_owned(),
            "--env".to_owned(),
            "HERMES_HOME=/opt/data".to_owned(),
            // The official image pins HERMES_WRITE_SAFE_ROOT to the Hermes data
            // directory, which makes the project workspace read-only for the
            // agent's write tools. Phase A needs the agent to edit the project,
            // so widen the write root to the workspace bind mount as well.
            "--env".to_owned(),
            "HERMES_WRITE_SAFE_ROOT=/workspace:/opt/data".to_owned(),
            // Codex CLI state (auth.json, thread history, config.toml) must
            // live on the persistent Hermes data mount, not in an image layer.
            "--env".to_owned(),
            format!("CODEX_HOME={CONTAINER_CODEX_HOME}"),
            // Maps to the Codex permission profile when the native
            // codex_app_server runtime drives a turn. See `TerminalSecurityMode`.
            "--env".to_owned(),
            format!("HERMES_TERMINAL_SECURITY_MODE={}", self.terminal_security),
            "--env".to_owned(),
            format!("HERMES_UID={}", self.runtime_uid),
            "--env".to_owned(),
            format!("HERMES_GID={}", self.runtime_gid),
            self.image.clone(),
            "gateway".to_owned(),
            "run".to_owned(),
        ]
    }

    pub fn setup_args(&self) -> Vec<String> {
        vec![
            "run".to_owned(),
            "--rm".to_owned(),
            "-it".to_owned(),
            "--cap-drop".to_owned(),
            "ALL".to_owned(),
            "--cap-add".to_owned(),
            "SETUID".to_owned(),
            "--cap-add".to_owned(),
            "SETGID".to_owned(),
            "--cap-add".to_owned(),
            "CHOWN".to_owned(),
            "--cap-add".to_owned(),
            "DAC_OVERRIDE".to_owned(),
            "--cap-add".to_owned(),
            "FOWNER".to_owned(),
            "--security-opt".to_owned(),
            "no-new-privileges:true".to_owned(),
            "--volume".to_owned(),
            format!("{}:/workspace:rw", self.workspace.display()),
            "--volume".to_owned(),
            format!("{}:/opt/data:rw", self.hermes_data.display()),
            "--workdir".to_owned(),
            "/workspace".to_owned(),
            "--env".to_owned(),
            "HOME=/opt/data".to_owned(),
            "--env".to_owned(),
            "HERMES_HOME=/opt/data".to_owned(),
            "--env".to_owned(),
            format!("HERMES_UID={}", self.runtime_uid),
            "--env".to_owned(),
            format!("HERMES_GID={}", self.runtime_gid),
            self.image.clone(),
            "setup".to_owned(),
        ]
    }
}

pub fn project_container_name(project_id: &str) -> Result<String> {
    validate_project_id(project_id)?;
    Ok(format!("asterism-project-{project_id}"))
}

/// Runtime user the Hermes services run as inside the project container.
///
/// Read back from the live container rather than re-derived from the host
/// workspace, so `project auth` always writes credentials as the user that
/// actually consumes them. Phase A wrote `auth.json` as root through a raw
/// `docker exec` and needed a manual `chown 1000:1000` repair.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeIdentity {
    pub uid: u32,
    pub gid: u32,
}

impl RuntimeIdentity {
    pub fn as_docker_user(&self) -> String {
        format!("{}:{}", self.uid, self.gid)
    }
}

/// Interactive credential flows `project auth` can drive inside the container.
///
/// The two providers are deliberately independent: Hermes authenticates its own
/// inference provider pool, while the native `codex app-server` runtime keeps a
/// separate ChatGPT session under `CODEX_HOME`. Authenticating one never
/// rewrites the other's credential file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthProvider {
    /// Hermes inference provider: `hermes auth add openai-codex --type oauth`.
    OpenAiCodex,
    /// Codex CLI ChatGPT session: `codex login --device-auth`.
    CodexCli,
}

impl AuthProvider {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "openai-codex" => Ok(Self::OpenAiCodex),
            "codex-cli" => Ok(Self::CodexCli),
            other => bail!(
                "unsupported provider {other:?}; supported providers: openai-codex, codex-cli"
            ),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenAiCodex => "openai-codex",
            Self::CodexCli => "codex-cli",
        }
    }

    /// Credential file the flow must leave readable by the runtime user.
    pub fn credential_path(self) -> String {
        match self {
            Self::OpenAiCodex => format!("{CONTAINER_DATA_DIR}/auth.json"),
            Self::CodexCli => format!("{CONTAINER_CODEX_HOME}/auth.json"),
        }
    }

    /// Argv executed inside the container. Device-code OAuth only — no token or
    /// API-key argument is ever accepted, so secrets cannot reach the process
    /// table or the shell history of the host.
    pub fn auth_command(self) -> Vec<String> {
        match self {
            Self::OpenAiCodex => vec![
                "/opt/hermes/.venv/bin/hermes".to_owned(),
                "auth".to_owned(),
                "add".to_owned(),
                "openai-codex".to_owned(),
                "--type".to_owned(),
                "oauth".to_owned(),
                "--no-browser".to_owned(),
            ],
            Self::CodexCli => vec![
                "codex".to_owned(),
                "login".to_owned(),
                "--device-auth".to_owned(),
            ],
        }
    }
}

/// Build the `docker exec` argv for an interactive provider login.
///
/// The command runs as the Hermes runtime user with the container's persistent
/// data paths in the environment, so every credential file it creates is
/// already owned correctly and lands on the bind mount rather than in the
/// container's ephemeral layer.
pub fn auth_exec_args(
    container_name: &str,
    identity: RuntimeIdentity,
    provider: AuthProvider,
    interactive_tty: bool,
) -> Vec<String> {
    let mut args = vec![
        "exec".to_owned(),
        "--interactive".to_owned(),
        "--user".to_owned(),
        identity.as_docker_user(),
        "--workdir".to_owned(),
        CONTAINER_DATA_DIR.to_owned(),
        "--env".to_owned(),
        format!("HOME={CONTAINER_DATA_DIR}"),
        "--env".to_owned(),
        format!("HERMES_HOME={CONTAINER_DATA_DIR}"),
        "--env".to_owned(),
        format!("CODEX_HOME={CONTAINER_CODEX_HOME}"),
    ];

    if interactive_tty {
        args.push("--tty".to_owned());
    }

    args.push(container_name.to_owned());
    args.extend(provider.auth_command());
    args
}

#[derive(Debug, Clone)]
pub struct DockerRuntime {
    executable: String,
}

impl Default for DockerRuntime {
    fn default() -> Self {
        Self {
            executable: "docker".to_owned(),
        }
    }
}

impl DockerRuntime {
    pub fn check(&self) -> Result<()> {
        let output = self.capture(["version", "--format", "{{.Server.Version}}"], None)?;
        ensure_success("docker version", output).map(|_| ())
    }

    pub fn setup_hermes(&self, spec: &ProjectContainerSpec) -> Result<()> {
        ensure_non_root_runtime(spec)?;
        let mut command = Command::new(&self.executable);
        command
            .args(spec.setup_args())
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        let status = command
            .status()
            .context("failed to launch Hermes setup container")?;
        if !status.success() {
            bail!("Hermes setup container exited with status {status}");
        }
        Ok(())
    }

    pub fn ensure_project(&self, spec: &ProjectContainerSpec, api_key: &str) -> Result<()> {
        ensure_non_root_runtime(spec)?;
        match self.container_exists(&spec.container_name())? {
            true => self.start_project(&spec.container_name()),
            false => {
                let output = self.capture(spec.create_args(), Some(("API_SERVER_KEY", api_key)))?;
                ensure_success("docker create", output)?;
                self.start_project(&spec.container_name())
            }
        }
    }

    pub fn start_project(&self, container_name: &str) -> Result<()> {
        let output = self.capture(["start", container_name], None)?;
        ensure_success("docker start", output).map(|_| ())
    }

    pub fn stop_project(&self, container_name: &str) -> Result<()> {
        let output = self.capture(["stop", "--time", "10", container_name], None)?;
        ensure_success("docker stop", output).map(|_| ())
    }

    pub fn remove_project(&self, container_name: &str) -> Result<()> {
        let output = self.capture(["rm", "--force", container_name], None)?;
        ensure_success("docker rm", output).map(|_| ())
    }

    /// Interactive provider login inside a running project container.
    ///
    /// Never parses, echoes, or persists the credential material itself: stdio
    /// is inherited so the device-code URL and one-time code are rendered by
    /// the provider CLI directly to the operator's terminal.
    pub fn authenticate_provider(
        &self,
        container_name: &str,
        provider: AuthProvider,
    ) -> Result<()> {
        let status = self.project_status(container_name).with_context(|| {
            format!(
                "project container {container_name} was not found; run `project ensure` before `project auth`"
            )
        })?;
        if status != "running" {
            bail!(
                "project container {container_name} is {status}; start it before authenticating a provider"
            );
        }

        let identity = self.runtime_identity(container_name)?;
        if identity.uid == 0 || identity.gid == 0 {
            bail!(
                "refusing to authenticate as root inside {container_name}; the container must declare a non-root HERMES_UID/HERMES_GID"
            );
        }

        self.ensure_provider_available(container_name, identity, provider)?;

        let interactive_tty = std::io::stdin().is_terminal() && std::io::stdout().is_terminal();
        let args = auth_exec_args(container_name, identity, provider, interactive_tty);

        let status = Command::new(&self.executable)
            .args(&args)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()
            .with_context(|| {
                format!(
                    "failed to start interactive {} authentication in {container_name}",
                    provider.as_str()
                )
            })?;
        if !status.success() {
            bail!(
                "{} authentication exited with status {status}",
                provider.as_str()
            );
        }

        self.verify_credential_readable(container_name, identity, provider)
    }

    /// Fail before the OAuth flow starts when the provider CLI is missing, so
    /// the operator never burns a device code on a container that cannot use it.
    fn ensure_provider_available(
        &self,
        container_name: &str,
        identity: RuntimeIdentity,
        provider: AuthProvider,
    ) -> Result<()> {
        let probe = match provider {
            AuthProvider::OpenAiCodex => "/opt/hermes/.venv/bin/hermes",
            AuthProvider::CodexCli => "codex",
        };
        let output = self.capture(
            [
                "exec",
                "--user",
                &identity.as_docker_user(),
                container_name,
                "sh",
                "-lc",
                &format!("command -v {probe}"),
            ],
            None,
        )?;
        if !output.status.success() {
            bail!(
                "provider {} cannot be authenticated in {container_name}: {probe} is not installed in the image",
                provider.as_str()
            );
        }
        Ok(())
    }

    /// Confirm the runtime user can actually read what the flow wrote.
    ///
    /// Guards the Phase A failure mode where a root-owned `auth.json` left the
    /// non-root Hermes process unable to read its own credentials.
    fn verify_credential_readable(
        &self,
        container_name: &str,
        identity: RuntimeIdentity,
        provider: AuthProvider,
    ) -> Result<()> {
        let credential_path = provider.credential_path();
        let output = self.capture(
            [
                "exec",
                "--user",
                &identity.as_docker_user(),
                container_name,
                "sh",
                "-lc",
                &format!("test -r {credential_path}"),
            ],
            None,
        )?;
        if !output.status.success() {
            bail!(
                "{} reported success but {credential_path} is not readable by uid {} inside {container_name}",
                provider.as_str(),
                identity.uid
            );
        }
        Ok(())
    }

    /// Host path bound to the Hermes data directory of an existing container.
    ///
    /// Lets lifecycle commands that only receive a project id still locate the
    /// Hermes configuration they must validate before starting.
    pub fn hermes_data_path(&self, container_name: &str) -> Result<PathBuf> {
        let output = self.capture(
            [
                "inspect",
                "--format",
                "{{range .HostConfig.Binds}}{{println .}}{{end}}",
                container_name,
            ],
            None,
        )?;
        let output = ensure_success("docker inspect", output)?;
        let binds = String::from_utf8_lossy(&output.stdout);
        parse_hermes_data_bind(&binds).with_context(|| {
            format!("container {container_name} has no {CONTAINER_DATA_DIR} bind mount")
        })
    }

    /// Read HERMES_UID/HERMES_GID back from the container configuration.
    pub fn runtime_identity(&self, container_name: &str) -> Result<RuntimeIdentity> {
        let output = self.capture(
            [
                "inspect",
                "--format",
                "{{range .Config.Env}}{{println .}}{{end}}",
                container_name,
            ],
            None,
        )?;
        let output = ensure_success("docker inspect", output)?;
        let env = String::from_utf8_lossy(&output.stdout);
        parse_runtime_identity(&env).with_context(|| {
            format!("container {container_name} does not declare HERMES_UID/HERMES_GID")
        })
    }

    pub fn project_status(&self, container_name: &str) -> Result<String> {
        let output = self.capture(
            ["inspect", "--format", "{{.State.Status}}", container_name],
            None,
        )?;
        let output = ensure_success("docker inspect", output)?;
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
    }

    fn container_exists(&self, container_name: &str) -> Result<bool> {
        let output = self.capture(["container", "inspect", container_name], None)?;
        if output.status.success() {
            return Ok(true);
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("No such container") || stderr.contains("No such object") {
            return Ok(false);
        }

        bail!("docker inspect failed: {}", stderr.trim())
    }

    fn capture<I, S>(&self, args: I, env: Option<(&str, &str)>) -> Result<Output>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let mut command = Command::new(&self.executable);
        command.args(args);
        if let Some((name, value)) = env {
            command.env(name, value);
        }
        command
            .output()
            .with_context(|| format!("failed to execute {}", self.executable))
    }
}

fn parse_hermes_data_bind(binds: &str) -> Result<PathBuf> {
    for line in binds.lines() {
        let line = line.trim();
        let Some((host_path, rest)) = line.split_once(':') else {
            continue;
        };
        let container_path = rest.split(':').next().unwrap_or_default();
        if container_path == CONTAINER_DATA_DIR {
            return Ok(PathBuf::from(host_path));
        }
    }
    bail!("no bind mount targets {CONTAINER_DATA_DIR}")
}

fn parse_runtime_identity(env: &str) -> Result<RuntimeIdentity> {
    let mut uid = None;
    let mut gid = None;
    for line in env.lines() {
        if let Some(value) = line.strip_prefix("HERMES_UID=") {
            uid = value.trim().parse::<u32>().ok();
        } else if let Some(value) = line.strip_prefix("HERMES_GID=") {
            gid = value.trim().parse::<u32>().ok();
        }
    }

    match (uid, gid) {
        (Some(uid), Some(gid)) => Ok(RuntimeIdentity { uid, gid }),
        _ => bail!("HERMES_UID/HERMES_GID are missing or not numeric"),
    }
}

fn ensure_non_root_runtime(spec: &ProjectContainerSpec) -> Result<()> {
    if spec.runtime_uid == 0 || spec.runtime_gid == 0 {
        bail!(
            "project workspace must be owned by a dedicated non-root user; detected uid={} gid={}",
            spec.runtime_uid,
            spec.runtime_gid
        );
    }
    Ok(())
}

fn ensure_success(operation: &str, output: Output) -> Result<Output> {
    if output.status.success() {
        return Ok(output);
    }

    bail!(
        "{} failed with status {}: {}",
        operation,
        output.status,
        String::from_utf8_lossy(&output.stderr).trim()
    )
}

fn validate_project_id(project_id: &str) -> Result<()> {
    if project_id.is_empty() || project_id.len() > 63 {
        bail!("project id must contain between 1 and 63 characters");
    }

    let mut chars = project_id.chars();
    let first = chars.next().expect("project id is not empty");
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        bail!("project id must start with a lowercase ASCII letter or digit");
    }

    if !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_') {
        bail!("project id may only contain lowercase ASCII letters, digits, '-' and '_'");
    }

    Ok(())
}

fn reject_ambiguous_bind_path(path: &Path) -> Result<()> {
    if path.as_os_str().to_string_lossy().contains(':') {
        bail!("bind mount path must not contain ':': {}", path.display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {

    #[test]
    fn the_default_image_is_digest_pinned() {
        // A tag default would make every Node's runtime silently divergent.
        assert!(
            is_digest_pinned(DEFAULT_HERMES_IMAGE),
            "default image {DEFAULT_HERMES_IMAGE} must be pinned by manifest digest"
        );
    }

    #[test]
    fn the_default_image_is_the_published_ghcr_package() {
        assert!(
            DEFAULT_HERMES_IMAGE.starts_with("ghcr.io/patternity/asterism-project-runtime@sha256:"),
            "default image must be the published package, got {DEFAULT_HERMES_IMAGE}"
        );
    }

    #[test]
    fn a_tag_override_is_not_digest_pinned() {
        // Overriding stays possible; it just cannot claim reproducibility.
        for image in [
            "nousresearch/hermes-agent:latest",
            "asterism/project-runtime:hermes-0.20.0-codex-0.147.0",
            "ghcr.io/patternity/asterism-project-runtime:sha-d5d8bf3c1b28",
            "local-build",
        ] {
            assert!(!is_digest_pinned(image), "{image} must not count as pinned");
        }
    }

    #[test]
    fn a_malformed_digest_is_not_accepted_as_pinned() {
        for image in [
            "name@sha256:short",
            "name@sha512:0000000000000000000000000000000000000000000000000000000000000000",
            "name@sha256:zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
            "@sha256:1d280b6595e465909ab93759a4406688c7a156f3f556d90c7b22e58765cd3144",
        ] {
            assert!(!is_digest_pinned(image), "{image} must not count as pinned");
        }
    }
    use super::*;

    fn spec() -> (tempfile::TempDir, ProjectContainerSpec) {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let data = root.path().join("hermes");
        fs::create_dir_all(&workspace).unwrap();
        let spec = ProjectContainerSpec::new(
            "phase-a",
            &workspace,
            &data,
            "nousresearch/hermes-agent@sha256:test",
            18642,
        )
        .unwrap();
        (root, spec)
    }

    #[test]
    fn create_args_apply_phase_a_security_boundary() {
        let (_root, spec) = spec();
        let args = spec.create_args();
        let rendered = args.join(" ");

        assert!(rendered.contains("--cap-drop ALL"));
        assert!(rendered.contains("--cap-add SETUID"));
        assert!(rendered.contains("--cap-add SETGID"));
        assert!(rendered.contains("--security-opt no-new-privileges:true"));
        assert!(rendered.contains("--pids-limit 512"));
        assert!(rendered.contains("--memory 4g"));
        assert!(rendered.contains("--cpus 2"));
        assert!(rendered.contains("--publish 127.0.0.1:18642:8642"));
        assert!(rendered.contains("HERMES_UID="));
        assert!(rendered.contains("HERMES_GID="));
        assert!(rendered.contains("HERMES_WRITE_SAFE_ROOT=/workspace:/opt/data"));
        assert!(!rendered.contains("docker.sock"));
        assert!(!rendered.contains("--privileged"));
    }

    #[test]
    fn api_key_is_inherited_from_process_environment() {
        let (_root, spec) = spec();
        let rendered = spec.create_args().join(" ");

        assert!(rendered.contains("--env API_SERVER_KEY"));
        assert!(!rendered.contains("API_SERVER_KEY="));
    }

    #[test]
    fn rejects_unsafe_project_ids() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();

        assert!(
            ProjectContainerSpec::new(
                "../../escape",
                &workspace,
                root.path().join("data"),
                "image",
                8642,
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_overlapping_workspace_and_hermes_state() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();

        assert!(
            ProjectContainerSpec::new(
                "phase-a",
                &workspace,
                workspace.join(".hermes"),
                "image",
                8642,
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_root_runtime_identity() {
        let (_root, mut spec) = spec();
        spec.runtime_uid = 0;
        spec.runtime_gid = 0;
        assert!(ensure_non_root_runtime(&spec).is_err());
    }

    #[test]
    fn create_args_pin_codex_state_to_the_persistent_mount() {
        let (_root, spec) = spec();
        let rendered = spec.create_args().join(" ");

        assert!(rendered.contains("CODEX_HOME=/opt/data/codex"));
        assert!(rendered.contains("HERMES_TERMINAL_SECURITY_MODE=auto"));
    }

    #[test]
    fn codex_home_is_created_inside_the_hermes_data_mount() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let data = root.path().join("hermes");
        fs::create_dir_all(&workspace).unwrap();

        ProjectContainerSpec::new("phase-b", &workspace, &data, "image", 18642).unwrap();

        assert!(data.join(CODEX_HOME_SUBDIR).is_dir());
    }

    #[test]
    fn create_args_mount_only_the_workspace_and_hermes_data() {
        let (_root, spec) = spec();
        let args = spec.create_args();

        let mounts: Vec<&String> = args
            .iter()
            .enumerate()
            .filter(|(index, _)| *index > 0 && args[index - 1] == "--volume")
            .map(|(_, value)| value)
            .collect();

        assert_eq!(mounts.len(), 2, "exactly two bind mounts are expected");
        assert!(mounts.iter().any(|mount| mount.ends_with(":/workspace:rw")));
        assert!(mounts.iter().any(|mount| mount.ends_with(":/opt/data:rw")));
        // Codex state must live inside an existing mount, never in a third one.
        assert!(CONTAINER_CODEX_HOME.starts_with(CONTAINER_DATA_DIR));
        for mount in mounts {
            assert!(!mount.starts_with("/:"), "host root must never be mounted");
            assert!(!mount.contains("docker.sock"));
        }
    }

    #[test]
    fn terminal_security_mode_is_configurable() {
        let (_root, spec) = spec();
        let spec = spec.with_terminal_security(TerminalSecurityMode::ApprovalRequired);
        let rendered = spec.create_args().join(" ");

        assert!(rendered.contains("HERMES_TERMINAL_SECURITY_MODE=approval-required"));
    }

    #[test]
    fn auth_exec_args_run_as_the_runtime_user_with_persistent_paths() {
        let identity = RuntimeIdentity {
            uid: 1000,
            gid: 1000,
        };
        let args = auth_exec_args(
            "asterism-project-phase-a",
            identity,
            AuthProvider::OpenAiCodex,
            true,
        );
        let rendered = args.join(" ");

        assert!(rendered.contains("--user 1000:1000"));
        assert!(rendered.contains("--tty"));
        assert!(rendered.contains("--interactive"));
        assert!(rendered.contains("HOME=/opt/data"));
        assert!(rendered.contains("HERMES_HOME=/opt/data"));
        assert!(rendered.contains("CODEX_HOME=/opt/data/codex"));
        assert!(rendered.contains("hermes auth add openai-codex --type oauth --no-browser"));
    }

    #[test]
    fn auth_exec_args_omit_tty_for_non_interactive_callers() {
        let identity = RuntimeIdentity {
            uid: 1000,
            gid: 1000,
        };
        let args = auth_exec_args("c", identity, AuthProvider::CodexCli, false);

        assert!(!args.iter().any(|arg| arg == "--tty"));
        assert!(args.iter().any(|arg| arg == "--interactive"));
    }

    #[test]
    fn codex_cli_provider_uses_device_code_login() {
        let args = AuthProvider::CodexCli.auth_command().join(" ");
        assert_eq!(args, "codex login --device-auth");
    }

    #[test]
    fn auth_commands_never_accept_token_arguments() {
        for provider in [AuthProvider::OpenAiCodex, AuthProvider::CodexCli] {
            let rendered = provider.auth_command().join(" ");
            assert!(!rendered.contains("--api-key"));
            assert!(!rendered.contains("token"));
        }
    }

    #[test]
    fn providers_use_independent_credential_files() {
        assert_eq!(
            AuthProvider::OpenAiCodex.credential_path(),
            "/opt/data/auth.json"
        );
        assert_eq!(
            AuthProvider::CodexCli.credential_path(),
            "/opt/data/codex/auth.json"
        );
    }

    #[test]
    fn rejects_unknown_auth_providers() {
        assert!(AuthProvider::parse("openai-codex").is_ok());
        assert!(AuthProvider::parse("codex-cli").is_ok());
        assert!(AuthProvider::parse("anthropic").is_err());
        assert!(AuthProvider::parse("").is_err());
    }

    #[test]
    fn parses_runtime_identity_from_container_environment() {
        let env = "PATH=/usr/bin\nHERMES_UID=1000\nHERMES_HOME=/opt/data\nHERMES_GID=1001\n";
        let identity = parse_runtime_identity(env).unwrap();

        assert_eq!(identity.uid, 1000);
        assert_eq!(identity.gid, 1001);
        assert_eq!(identity.as_docker_user(), "1000:1001");
    }

    #[test]
    fn locates_the_hermes_data_bind_among_several_mounts() {
        let binds = "/host/work:/workspace:rw\n/host/state:/opt/data:rw\n";
        assert_eq!(
            parse_hermes_data_bind(binds).unwrap(),
            PathBuf::from("/host/state")
        );
    }

    #[test]
    fn rejects_bind_lists_without_a_hermes_data_mount() {
        assert!(parse_hermes_data_bind("/host/work:/workspace:rw\n").is_err());
        assert!(parse_hermes_data_bind("").is_err());
    }

    #[test]
    fn rejects_container_environment_without_runtime_identity() {
        assert!(parse_runtime_identity("PATH=/usr/bin\n").is_err());
        assert!(parse_runtime_identity("HERMES_UID=root\nHERMES_GID=root\n").is_err());
    }
}
