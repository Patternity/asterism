use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use asterism_node::approvals;
use asterism_node::client::{self, ApiError, NodeClient, NodeUnavailable};
use asterism_node::control;
use asterism_node::daemon::{self, DaemonConfig};
use asterism_node::docker::{
    AuthProvider, DEFAULT_HERMES_IMAGE, DockerRuntime, ProjectContainerSpec, TerminalSecurityMode,
    project_container_name,
};
use asterism_node::hermes::HermesClient;
use asterism_node::identity::NodeIdentity;
use asterism_node::inventory::RuntimeOwnership;
use asterism_node::nodehome;
use asterism_node::policy::{
    self, CodexApprovalBypassOverride, UnsafeRuntime, read_runtime_configuration,
};
use asterism_node::registry::Registry;
use asterism_node::service::Limits;
use asterism_node::sse::SseEvent;
use clap::{Args, Parser, Subcommand, ValueEnum};
use serde_json::{Value, json};
use tokio::time::sleep;

#[derive(Debug, Parser)]
#[command(name = "asterism-node")]
#[command(about = "Asterism Node Phase A architecture proof")]
// The installer pins a Node version and reports what it installed; without this
// the binary cannot answer which one it is.
#[command(version)]
struct Cli {
    #[arg(
        long,
        env = "ASTERISM_HERMES_API_KEY",
        hide_env_values = true,
        global = true
    )]
    api_key: Option<String>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Project {
        #[command(subcommand)]
        command: ProjectCommand,
    },
    Hermes {
        #[command(flatten)]
        endpoint: HermesEndpoint,
        #[command(subcommand)]
        command: HermesCommand,
    },
    /// Durable runs owned by the Asterism Node daemon.
    Run {
        #[command(subcommand)]
        command: RunCommand,
    },
    /// The persistent Asterism Node daemon.
    Node {
        #[command(subcommand)]
        command: NodeCommand,
    },
}

#[derive(Debug, Subcommand)]
enum NodeCommand {
    /// Run the daemon in the foreground. Meant to be supervised by a service
    /// manager; it never forks into the background itself.
    Serve(NodeServeArgs),
    /// Report whether a daemon is listening, and what it supports.
    Status(NodeStatusArgs),
    /// Show this Node's public identity. Never shows private material.
    Identity(NodeStatusArgs),
    /// One-time enrollment with a Control Plane.
    Enroll(NodeEnrollArgs),
    /// Replace this Node's key while keeping its enrolled identity.
    ///
    /// Requires a rotation token issued by an operator for this Node. The
    /// current key is only replaced after the Control Plane accepts the new one.
    RotateIdentity(NodeEnrollArgs),
}

#[derive(Debug, Args, Clone)]
struct NodeEnrollArgs {
    /// Control Plane base URL. https:// is required outside development.
    #[arg(long)]
    control_plane: String,

    #[arg(long)]
    node_home: Option<PathBuf>,

    /// Read the one-time token from stdin instead of prompting.
    ///
    /// The token is never accepted as a command-line value: an argument would
    /// be visible in the process table and in shell history.
    #[arg(long, default_value_t = false)]
    token_stdin: bool,

    /// Permit plaintext http:// to a loopback Control Plane. Development only.
    #[arg(long, default_value_t = false)]
    allow_plaintext_loopback: bool,
}

#[derive(Debug, Args, Clone)]
struct NodeServeArgs {
    /// Projects reconciled at startup and periodically. Adds to the configured
    /// inventory rather than replacing it.
    #[arg(long = "project")]
    project: Vec<String>,

    #[arg(long)]
    node_home: Option<PathBuf>,

    #[arg(
        long,
        default_value = "http://127.0.0.1:18642",
        env = "ASTERISM_HERMES_URL"
    )]
    base_url: String,
}

#[derive(Debug, Args, Clone)]
struct NodeStatusArgs {
    #[arg(long)]
    node_home: Option<PathBuf>,
}

#[derive(Debug, Subcommand)]
enum RunCommand {
    /// Create a durable run and execute it through a detached worker.
    Start(RunStartArgs),
    List(RunScopeArgs),
    Show(RunRefArgs),
    Events(RunEventsArgs),
    /// Replay stored events from a cursor, then follow live ones.
    Follow(RunEventsArgs),
    Cancel(RunRefArgs),
    Approve(RunApproveArgs),
    /// Create a replacement run for a terminal interrupted or lost run.
    Retry(RunRefArgs),
    /// Resolve non-terminal runs left behind by a restart.
    Reconcile(RunScopeArgs),
}

#[derive(Debug, Args, Clone)]
struct RunScopeArgs {
    #[arg(long)]
    project_id: String,

    #[arg(long, default_value = "./.asterism", env = "ASTERISM_STATE_ROOT")]
    state_root: PathBuf,

    #[arg(long, default_value_t = 50)]
    limit: i64,
}

#[derive(Debug, Args, Clone)]
struct RunRefArgs {
    #[arg(long)]
    project_id: String,

    #[arg(long)]
    run_id: String,

    #[arg(long, default_value = "./.asterism", env = "ASTERISM_STATE_ROOT")]
    state_root: PathBuf,
}

#[derive(Debug, Args, Clone)]
struct RunEventsArgs {
    #[command(flatten)]
    reference: RunRefArgs,

    /// Replay cursor. Only events with a greater sequence number are returned.
    #[arg(long, default_value_t = 0)]
    since_seq: i64,
}

#[derive(Debug, Args, Clone)]
struct RunApproveArgs {
    #[command(flatten)]
    reference: RunRefArgs,

    #[arg(long, value_enum)]
    choice: ApprovalChoice,
}

#[derive(Debug, Args, Clone)]
struct RunStartArgs {
    #[arg(long)]
    project_id: String,

    #[arg(long)]
    input: String,

    #[arg(long)]
    session_id: Option<String>,

    #[arg(long)]
    instructions: Option<String>,

    /// Reusing a key with an identical request returns the existing run instead
    /// of submitting a second execution.
    #[arg(long)]
    idempotency_key: Option<String>,

    /// Stream the journal until the run reaches a terminal state. The daemon
    /// owns execution, so the run continues regardless of this process.
    #[arg(long, default_value_t = false)]
    wait: bool,

    #[arg(long, default_value = "./.asterism", env = "ASTERISM_STATE_ROOT")]
    state_root: PathBuf,
}

#[derive(Debug, Subcommand)]
enum ProjectCommand {
    /// Register a project so it can be addressed by id, including remotely.
    Register(ProjectRegisterArgs),
    Unregister(ProjectRegistryRef),
    List(ProjectRegistryRef),
    Setup(ProjectArgs),
    Ensure(ProjectArgs),
    Auth(ProjectAuthArgs),
    Start(ProjectIdentity),
    Stop(ProjectIdentity),
    Remove(ProjectIdentity),
    Status(ProjectIdentity),
    /// Inspect and revoke Hermes' persistent approval rules. Local operator only.
    #[command(subcommand)]
    Approvals(ApprovalsCommand),
}

/// Persistent approval policy management.
///
/// Local only, and deliberately so: these commands read and edit the project's
/// Hermes configuration on this host. Nothing here is reachable through the
/// Control Plane command protocol, and no host path is ever reported upward.
#[derive(Debug, Subcommand, Clone)]
enum ApprovalsCommand {
    /// Show the effective approval mode and every persistent allowlist rule.
    Show(ApprovalsRef),
    /// Remove one persistent rule by its exact category.
    Revoke(ApprovalsRevokeArgs),
    /// Remove every persistent rule.
    Clear(ApprovalsClearArgs),
}

#[derive(Debug, Args, Clone)]
struct ApprovalsRef {
    #[arg(long)]
    project_id: String,

    #[arg(long)]
    node_home: Option<PathBuf>,

    /// Node-local installation metadata naming the Hermes CLI and home.
    #[arg(long, default_value = "/etc/asterism/install-metadata.json")]
    install_metadata: PathBuf,
}

#[derive(Debug, Args, Clone)]
struct ApprovalsRevokeArgs {
    #[command(flatten)]
    reference: ApprovalsRef,

    /// The exact category string, as printed by `approvals show`.
    #[arg(long)]
    category: String,
}

#[derive(Debug, Args, Clone)]
struct ApprovalsClearArgs {
    #[command(flatten)]
    reference: ApprovalsRef,

    /// Required when no terminal is attached to confirm interactively.
    #[arg(long)]
    yes: bool,
}

#[derive(Debug, Args, Clone)]
struct ProjectRegisterArgs {
    #[arg(long)]
    project_id: String,

    #[arg(long)]
    workspace: PathBuf,

    #[arg(long)]
    display_name: Option<String>,

    /// Host-local Hermes endpoint for this project's runtime.
    ///
    /// Required for an external runtime, and required once a Node supervises
    /// more than one managed container: each listens on its own port, so a
    /// single Node-wide endpoint cannot address them all.
    #[arg(long)]
    runtime_endpoint: Option<String>,

    /// The runtime is supervised outside Asterism Node.
    ///
    /// Use this for host-native Hermes. The Node will talk to the endpoint but
    /// never create, start, stop, or delete a container for this project.
    #[arg(long, default_value_t = false)]
    external_runtime: bool,

    #[arg(long)]
    node_home: Option<PathBuf>,
}

#[derive(Debug, Args, Clone)]
struct ProjectRegistryRef {
    #[arg(long)]
    project_id: Option<String>,

    #[arg(long)]
    node_home: Option<PathBuf>,
}

/// Interactive provider authentication inside an already running project
/// container. Credentials are written by the Hermes runtime user and land on
/// the persistent data mount; no token ever passes through an argument.
#[derive(Debug, Args)]
struct ProjectAuthArgs {
    #[arg(long)]
    project_id: String,

    #[arg(long, default_value = "openai-codex")]
    provider: String,

    #[arg(long, default_value = "./.asterism", env = "ASTERISM_STATE_ROOT")]
    state_root: PathBuf,
}

#[derive(Debug, Args)]
struct ProjectIdentity {
    #[arg(long)]
    project_id: String,

    #[arg(long, default_value = "./.asterism", env = "ASTERISM_STATE_ROOT")]
    state_root: PathBuf,

    /// Proceed even though the project has a durable active run. The run is
    /// left to be reconciled as interrupted; it is not silently completed.
    #[arg(long, default_value_t = false)]
    force_interrupt: bool,

    #[command(flatten)]
    unsafe_override: UnsafeOverride,
}

#[derive(Debug, Args)]
struct ProjectArgs {
    #[arg(long)]
    project_id: String,

    #[arg(long)]
    workspace: PathBuf,

    #[arg(long)]
    hermes_data: PathBuf,

    #[arg(long, default_value = DEFAULT_HERMES_IMAGE, env = "ASTERISM_HERMES_IMAGE")]
    image: String,

    #[arg(long, default_value_t = 18642)]
    api_port: u16,

    /// Pin the model this project's runtime uses.
    ///
    /// A container seeded from the image default boots with whatever model the
    /// image ships, which the configured provider may refuse to serve. Pinning
    /// makes the project's routing reproducible instead of image-dependent.
    #[arg(long)]
    model: Option<String>,

    /// Pin the inference provider this project's runtime routes through.
    #[arg(long)]
    model_provider: Option<String>,

    /// Hermes terminal security mode, mapped onto the Codex permission profile
    /// when the native codex_app_server runtime executes a turn.
    #[arg(long, value_enum, default_value_t = TerminalSecurity::Auto)]
    terminal_security: TerminalSecurity,

    #[command(flatten)]
    unsafe_override: UnsafeOverride,
}

/// Scoped opt-in for the one known-unsafe runtime combination. Deliberately not
/// a general security switch: it unlocks native Codex with bypassed approvals
/// and nothing else.
#[derive(Debug, Args)]
struct UnsafeOverride {
    /// Allow native codex_app_server to run with approvals.mode=off.
    /// Controlled testing only — every Codex request is auto-approved and no
    /// approval.request event reaches the Asterism API.
    #[arg(long, default_value_t = false)]
    unsafe_allow_codex_approval_bypass: bool,
}

impl UnsafeOverride {
    fn as_policy(&self) -> CodexApprovalBypassOverride {
        CodexApprovalBypassOverride(self.unsafe_allow_codex_approval_bypass)
    }
}

/// Write the model pins into a project's Hermes configuration.
///
/// Returns whether anything changed, so the caller only pays for a restart when
/// the running container is actually stale.
fn pin_model_configuration(
    hermes_data: &Path,
    model: Option<&str>,
    provider: Option<&str>,
) -> Result<bool> {
    let config_path = hermes_data.join("config.yaml");
    if !config_path.is_file() {
        bail!(
            "cannot pin the model: {} does not exist yet",
            config_path.display()
        );
    }

    let original = std::fs::read_to_string(&config_path)
        .with_context(|| format!("failed to read {}", config_path.display()))?;
    let mut updated = original.clone();
    if let Some(model) = model {
        updated = policy::set_setting(&updated, "model", "default", model);
    }
    if let Some(provider) = provider {
        updated = policy::set_setting(&updated, "model", "provider", provider);
    }
    // The image ships `terminal.cwd: "."`, which resolves to the Hermes data
    // directory rather than the project workspace. A project whose agent cannot
    // see its own files is not provisioned, so this is pinned unconditionally
    // alongside the model rather than left to the image default.
    updated = policy::set_setting(
        &updated,
        "terminal",
        "cwd",
        asterism_node::docker::CONTAINER_WORKSPACE_DIR,
    );
    if updated == original {
        return Ok(false);
    }

    std::fs::write(&config_path, updated)
        .with_context(|| format!("failed to write {}", config_path.display()))?;
    Ok(true)
}

/// Refuse to start a project whose persisted Hermes configuration is known to
/// bypass the approval control point. A missing config file is not a policy
/// failure: a first-run project has not been configured yet.
fn enforce_runtime_policy(
    project_id: &str,
    hermes_data: &Path,
    override_flag: CodexApprovalBypassOverride,
) -> Result<()> {
    let config_path = hermes_data.join("config.yaml");
    if !config_path.is_file() {
        return Ok(());
    }
    let config = read_runtime_configuration(&config_path)?;
    policy::enforce(project_id, &config, override_flag)
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum TerminalSecurity {
    Auto,
    ApprovalRequired,
    Unrestricted,
}

impl From<TerminalSecurity> for TerminalSecurityMode {
    fn from(value: TerminalSecurity) -> Self {
        match value {
            TerminalSecurity::Auto => Self::Auto,
            TerminalSecurity::ApprovalRequired => Self::ApprovalRequired,
            TerminalSecurity::Unrestricted => Self::Unrestricted,
        }
    }
}

#[derive(Debug, Args, Clone)]
struct HermesEndpoint {
    #[arg(
        long,
        default_value = "http://127.0.0.1:18642",
        env = "ASTERISM_HERMES_URL"
    )]
    base_url: String,
}

#[derive(Debug, Subcommand)]
enum HermesCommand {
    Health {
        #[arg(long)]
        detailed: bool,
    },
    Capabilities,
    Status {
        #[arg(long)]
        run_id: String,
    },
    Events {
        #[arg(long)]
        run_id: String,
    },
    Approve {
        #[arg(long)]
        run_id: String,
        #[arg(long, value_enum)]
        choice: ApprovalChoice,
        #[arg(long, default_value_t = false)]
        resolve_all: bool,
    },
    Stop {
        #[arg(long)]
        run_id: String,
    },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum ApprovalChoice {
    Once,
    Session,
    Always,
    Deny,
}

impl ApprovalChoice {
    fn as_str(self) -> &'static str {
        match self {
            Self::Once => "once",
            Self::Session => "session",
            Self::Always => "always",
            Self::Deny => "deny",
        }
    }
}

/// Exit code reserved for a refused run admission, so callers can distinguish a
/// single-flight conflict from an operational failure without parsing stderr.
const EXIT_RUN_CONFLICT: u8 = 2;

/// Exit code reserved for a project refused by the fail-closed runtime policy.
const EXIT_UNSAFE_RUNTIME: u8 = 3;

/// Exit code reserved for an idempotency key reused with a different request.
const EXIT_IDEMPOTENCY_CONFLICT: u8 = 4;

/// Exit code reserved for run commands issued while no daemon is listening.
const EXIT_NODE_UNAVAILABLE: u8 = 5;

/// Exit code reserved for a lifecycle command refused by an active run.
const EXIT_PROJECT_BUSY: u8 = 6;

/// A container lifecycle command was used on a runtime the Node does not own.
/// Distinct from a generic failure so a caller can branch on it.
const EXIT_EXTERNALLY_MANAGED_RUNTIME: u8 = 7;

/// Stable machine-readable code for that refusal.
const EXTERNALLY_MANAGED_RUNTIME_CODE: &str = "externally_managed_runtime";

/// Map an API error code onto the CLI's stable exit codes.
fn exit_code_for(code: &str, status: u16) -> u8 {
    match code {
        "run_conflict" => EXIT_RUN_CONFLICT,
        "idempotency_conflict" => EXIT_IDEMPOTENCY_CONFLICT,
        crate::daemon_codes::NODE_UNAVAILABLE => EXIT_NODE_UNAVAILABLE,
        PROJECT_BUSY_CODE => EXIT_PROJECT_BUSY,
        _ if status >= 500 => 1,
        _ => 1,
    }
}

mod daemon_codes {
    pub const NODE_UNAVAILABLE: &str = asterism_node::daemon::NODE_UNAVAILABLE_CODE;
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    let api_key = cli.api_key;

    let result = match cli.command {
        Command::Project { command } => handle_project(command, api_key.as_deref()).await,
        Command::Hermes { endpoint, command } => {
            handle_hermes(endpoint, command, api_key.as_deref()).await
        }
        Command::Run { command } => handle_run(command).await,
        Command::Node { command } => handle_node(command, api_key.as_deref()).await,
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            // Typed API failures keep their machine-readable code and map onto
            // a stable exit code, so scripts can branch without parsing text.
            if let Some(api_error) = error.downcast_ref::<ApiError>() {
                let rendered = serde_json::to_string_pretty(&json!({
                    "error": api_error.code,
                    "status": api_error.status,
                    "message": api_error.message,
                }))
                .unwrap_or_else(|_| api_error.to_string());
                println!("{rendered}");
                return ExitCode::from(exit_code_for(&api_error.code, api_error.status));
            }
            if let Some(unavailable) = error.downcast_ref::<NodeUnavailable>() {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&client::unavailable_json(unavailable))
                        .unwrap_or_else(|_| unavailable.to_string())
                );
                return ExitCode::from(EXIT_NODE_UNAVAILABLE);
            }
            if let Some(busy) = error.downcast_ref::<ProjectBusy>() {
                let rendered = serde_json::to_string_pretty(&json!({
                    "error": PROJECT_BUSY_CODE,
                    "project_id": busy.project_id,
                    "run_id": busy.run_id,
                    "status": busy.status,
                    "message": busy.to_string(),
                }))
                .unwrap_or_else(|_| busy.to_string());
                println!("{rendered}");
                return ExitCode::from(EXIT_PROJECT_BUSY);
            }
            if let Some(external) = error.downcast_ref::<ExternallyManagedRuntime>() {
                let rendered = serde_json::to_string_pretty(&json!({
                    "error": EXTERNALLY_MANAGED_RUNTIME_CODE,
                    "project_id": external.project_id,
                    "message": external.to_string(),
                }))
                .unwrap_or_else(|_| external.to_string());
                println!("{rendered}");
                return ExitCode::from(EXIT_EXTERNALLY_MANAGED_RUNTIME);
            }
            if let Some(unsafe_runtime) = error.downcast_ref::<UnsafeRuntime>() {
                let rendered = serde_json::to_string_pretty(&json!({
                    "error": policy::UNSAFE_RUNTIME_CODE,
                    "project_id": unsafe_runtime.project_id,
                    "message": unsafe_runtime.reason,
                }))
                .unwrap_or_else(|_| unsafe_runtime.to_string());
                println!("{rendered}");
                return ExitCode::from(EXIT_UNSAFE_RUNTIME);
            }
            eprintln!("Error: {error:?}");
            ExitCode::FAILURE
        }
    }
}

/// Docker preflight, run only by the operations that actually drive Docker.
///
/// Registering, listing, or unregistering a project touches the registry alone,
/// and an external runtime never involves Docker at all — requiring a daemon for
/// those made a host-native project impossible to manage on a machine without
/// Docker installed.
/// Local operator management of Hermes' persistent approval rules.
///
/// Answering an approval with "always" makes Hermes record the whole command
/// category in `command_allowlist` and stop prompting for it — permanently, and
/// invisibly to Asterism. These commands are how an operator sees such a rule
/// and takes it back.
fn handle_project_approvals(command: ApprovalsCommand) -> Result<()> {
    let reference = match &command {
        ApprovalsCommand::Show(reference) => reference,
        ApprovalsCommand::Revoke(args) => &args.reference,
        ApprovalsCommand::Clear(args) => &args.reference,
    };

    let node_home = nodehome::resolve(reference.node_home.as_deref())?;
    let registry = Registry::open(&node_home)?;
    let project = registry
        .project(&reference.project_id)?
        .with_context(|| format!("unknown project {}", reference.project_id))?;
    let ownership = project.runtime_ownership.as_str();
    let cli = approvals::HermesCli::from_metadata(&reference.install_metadata);

    match command {
        ApprovalsCommand::Show(_) => {
            let policy = approvals::show(cli.as_ref(), &reference.project_id, ownership);
            print_json(&serde_json::to_value(&policy)?)
        }
        ApprovalsCommand::Revoke(ref args) => {
            let cli = cli.with_context(|| {
                "this project's Hermes was not provisioned by this Node's installer, so its \
                 configuration location is unknown and will not be guessed"
            })?;
            let remaining = approvals::revoke(&cli, &args.category)?;
            print_json(&json!({
                "project_id": reference.project_id,
                "revoked": args.category,
                "persistent_allowlist": remaining,
                "restart_required": true,
                "message": "Hermes reads this policy at startup; restart it to put the \
                            revocation into force",
            }))
        }
        ApprovalsCommand::Clear(ref args) => {
            let cli = cli.with_context(|| {
                "this project's Hermes was not provisioned by this Node's installer, so its \
                 configuration location is unknown and will not be guessed"
            })?;
            // Clearing removes every standing grant at once, so it asks first
            // unless the caller has already said yes in a script.
            if !args.yes {
                if !std::io::IsTerminal::is_terminal(&std::io::stdin()) {
                    bail!("refusing to clear every persistent approval rule without --yes");
                }
                eprint!(
                    "Remove every persistent approval rule for {}? [y/N]: ",
                    reference.project_id
                );
                use std::io::Write;
                std::io::stderr().flush()?;
                let mut reply = String::new();
                std::io::stdin().read_line(&mut reply)?;
                if !matches!(reply.trim(), "y" | "Y" | "yes" | "YES") {
                    bail!("cancelled; nothing was changed");
                }
            }
            let removed = approvals::clear(&cli)?;
            print_json(&json!({
                "project_id": reference.project_id,
                "cleared": removed,
                "persistent_allowlist": Vec::<String>::new(),
                "restart_required": removed > 0,
                "message": "Hermes reads this policy at startup; restart it to put the \
                            change into force",
            }))
        }
    }
}

fn docker_runtime() -> Result<DockerRuntime> {
    let docker = DockerRuntime::default();
    docker.check()?;
    Ok(docker)
}

/// Refuse a container lifecycle operation on a runtime the Node does not own.
///
/// The registry entry and the runtime are separate things: `project unregister`
/// still works, and nothing here deletes an external runtime or its data.
fn require_managed_container(registry: &Registry, project_id: &str) -> Result<()> {
    let Some(project) = registry.project(project_id)? else {
        return Ok(());
    };
    if !project.runtime_ownership.owns_container() {
        bail!(ExternallyManagedRuntime {
            project_id: project_id.to_owned(),
        });
    }
    Ok(())
}

/// Typed refusal for container lifecycle commands on an external runtime.
#[derive(Debug)]
struct ExternallyManagedRuntime {
    project_id: String,
}

impl std::fmt::Display for ExternallyManagedRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "This project's runtime lifecycle is managed outside Asterism Node."
        )
    }
}

impl std::error::Error for ExternallyManagedRuntime {}

async fn handle_project(command: ProjectCommand, api_key: Option<&str>) -> Result<()> {
    match command {
        ProjectCommand::Register(args) => {
            let node_home = nodehome::resolve(args.node_home.as_deref())?;
            let mut registry = Registry::open(&node_home)?;
            let ownership = if args.external_runtime {
                RuntimeOwnership::External
            } else {
                RuntimeOwnership::ManagedContainer
            };
            // Changing who owns a runtime is not a re-registration: it would
            // orphan a live container or start managing something the Node does
            // not own. Say so instead of silently switching.
            if let Some(existing) = registry.project(&args.project_id)?
                && existing.runtime_ownership != ownership
            {
                bail!(
                    "project {} is already registered as {} and cannot be re-registered as {}; \
                     unregister it first if the change is intended",
                    args.project_id,
                    existing.runtime_ownership.as_str(),
                    ownership.as_str()
                );
            }
            let project = registry.register_project(
                &args.project_id,
                &args.workspace,
                args.display_name.as_deref(),
                None,
                args.runtime_endpoint.as_deref(),
                ownership,
            )?;
            print_json(&json!({"registered": true, "project": project.remote_view()}))
        }
        ProjectCommand::Approvals(command) => handle_project_approvals(command),
        ProjectCommand::Unregister(args) => {
            let node_home = nodehome::resolve(args.node_home.as_deref())?;
            let project_id = args
                .project_id
                .clone()
                .context("--project-id is required")?;
            let mut registry = Registry::open(&node_home)?;
            registry.unregister_project(&project_id)?;
            print_json(&json!({"unregistered": true, "project_id": project_id}))
        }
        ProjectCommand::List(args) => {
            let node_home = nodehome::resolve(args.node_home.as_deref())?;
            let registry = Registry::open(&node_home)?;
            let projects = registry.list_projects()?;
            print_json(&json!({
                "projects": projects.iter().map(|p| p.remote_view()).collect::<Vec<_>>()
            }))
        }
        ProjectCommand::Setup(args) => {
            {
                let node_home = nodehome::resolve(None)?;
                let registry = Registry::open(&node_home)?;
                require_managed_container(&registry, &args.project_id)?;
            }
            let docker = docker_runtime()?;
            warn_unpinned_image(&args.image);
            let spec = project_spec(args)?;
            docker.setup_hermes(&spec)
        }
        ProjectCommand::Ensure(args) => {
            {
                let node_home = nodehome::resolve(None)?;
                let registry = Registry::open(&node_home)?;
                require_managed_container(&registry, &args.project_id)?;
            }
            let docker = docker_runtime()?;
            warn_unpinned_image(&args.image);
            let api_key = required_api_key(api_key)?;
            let override_flag = args.unsafe_override.as_policy();
            let model = args.model.clone();
            let model_provider = args.model_provider.clone();
            let spec = project_spec(args)?;
            enforce_runtime_policy(&spec.project_id, &spec.hermes_data, override_flag)?;
            docker.ensure_project(&spec, api_key)?;
            let client = HermesClient::new(spec.api_base_url(), api_key)?;
            wait_for_hermes(&client, Duration::from_secs(45)).await?;

            // Hermes seeds config.yaml on first boot, so the pins can only be
            // applied once it exists. A change restarts the container, because
            // the running process already read the file.
            let pinned = pin_model_configuration(
                &spec.hermes_data,
                model.as_deref(),
                model_provider.as_deref(),
            )?;
            if pinned {
                let container = spec.container_name();
                docker.stop_project(&container)?;
                docker.start_project(&container)?;
                wait_for_hermes(&client, Duration::from_secs(45)).await?;
            }
            let capabilities = client.capabilities().await.context(
                "Hermes is live but authenticated API access failed; recreate the container if the API key changed",
            )?;
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "project_id": spec.project_id,
                    "container": spec.container_name(),
                    "api_url": spec.api_base_url(),
                    "model_pinned": pinned,
                    "capabilities": capabilities,
                }))?
            );
            Ok(())
        }
        ProjectCommand::Auth(args) => {
            {
                let node_home = nodehome::resolve(None)?;
                let registry = Registry::open(&node_home)?;
                require_managed_container(&registry, &args.project_id)?;
            }
            let docker = docker_runtime()?;
            // Rotating credentials under a live run would break it mid-flight.
            ensure_project_idle(&args.state_root, &args.project_id, "authenticate").await?;
            let provider = AuthProvider::parse(&args.provider)?;
            let container = project_container_name(&args.project_id)?;
            docker.authenticate_provider(&container, provider)?;
            println!(
                "{} credentials for project {} are stored in the persistent Hermes data mount.",
                provider.as_str(),
                args.project_id
            );
            Ok(())
        }
        ProjectCommand::Start(identity) => {
            {
                let node_home = nodehome::resolve(None)?;
                let registry = Registry::open(&node_home)?;
                require_managed_container(&registry, &identity.project_id)?;
            }
            let docker = docker_runtime()?;
            let container = project_container_name(&identity.project_id)?;
            let hermes_data = docker.hermes_data_path(&container)?;
            enforce_runtime_policy(
                &identity.project_id,
                &hermes_data,
                identity.unsafe_override.as_policy(),
            )?;
            docker.start_project(&container)?;
            // The backend just changed underneath any recorded run; ask the
            // daemon to reconcile. Its absence is not an error here.
            notify_reconcile(&identity.state_root, &identity.project_id).await;
            Ok(())
        }
        ProjectCommand::Stop(identity) => {
            {
                let node_home = nodehome::resolve(None)?;
                let registry = Registry::open(&node_home)?;
                require_managed_container(&registry, &identity.project_id)?;
            }
            let docker = docker_runtime()?;
            if !identity.force_interrupt {
                ensure_project_idle(&identity.state_root, &identity.project_id, "stop").await?;
            }
            docker.stop_project(&project_container_name(&identity.project_id)?)
        }
        ProjectCommand::Remove(identity) => {
            {
                let node_home = nodehome::resolve(None)?;
                let registry = Registry::open(&node_home)?;
                require_managed_container(&registry, &identity.project_id)?;
            }
            let docker = docker_runtime()?;
            // Removing a container under a live run would destroy the execution
            // without ever recording an outcome.
            if !identity.force_interrupt {
                ensure_project_idle(&identity.state_root, &identity.project_id, "remove").await?;
            }
            let name = project_container_name(&identity.project_id)?;
            docker.remove_project(&name)?;
            println!("Removed container {name}. Workspace and Hermes data were preserved.");
            Ok(())
        }
        ProjectCommand::Status(identity) => {
            let node_home = nodehome::resolve(None)?;
            let registry = Registry::open(&node_home)?;
            let project = registry.project(&identity.project_id)?;

            // An external runtime has no container to inspect, so reachability
            // is the only honest signal — and a failed probe means the runtime
            // is unavailable, never a reason to fall through to Docker.
            if let Some(project) = project.as_ref()
                && !project.runtime_ownership.owns_container()
            {
                let endpoint = project.runtime_endpoint.clone().unwrap_or_default();
                // Three outcomes, kept distinct: the probe succeeded, the probe
                // ran and failed, or no probe was possible. Reporting "not
                // probed" as "unavailable" would blame the runtime for a
                // missing API key.
                let (health, reachable) = match api_key {
                    Some(key) => match HermesClient::new(endpoint.clone(), key) {
                        Ok(client) => match client.health().await {
                            Ok(_) => ("ok", Some(true)),
                            Err(_) => ("unavailable", Some(false)),
                        },
                        Err(_) => ("not_probed", None),
                    },
                    None => ("not_probed", None),
                };
                print_json(&json!({
                    "project_id": project.project_id,
                    "runtime_ownership": project.runtime_ownership.as_str(),
                    "runtime_endpoint": endpoint,
                    "enabled": project.enabled,
                    "runtime_reachable": reachable,
                    "runtime_health": health,
                }))?;
                return Ok(());
            }

            let docker = docker_runtime()?;
            let name = project_container_name(&identity.project_id)?;
            let container_status = docker.project_status(&name)?;
            print_json(&json!({
                "project_id": identity.project_id,
                "runtime_ownership": project
                    .as_ref()
                    .map(|project| project.runtime_ownership.as_str())
                    .unwrap_or(RuntimeOwnership::ManagedContainer.as_str()),
                "runtime_endpoint": project.as_ref().and_then(|p| p.runtime_endpoint.clone()),
                "enabled": project.as_ref().map(|project| project.enabled),
                "container": name,
                "container_status": container_status.trim(),
            }))
        }
    }
}

async fn handle_hermes(
    endpoint: HermesEndpoint,
    command: HermesCommand,
    api_key: Option<&str>,
) -> Result<()> {
    let api_key = required_api_key(api_key)?;
    let client = HermesClient::new(endpoint.base_url, api_key)?;

    match command {
        HermesCommand::Health { detailed } => {
            let value = if detailed {
                client.detailed_health().await?
            } else {
                client.health().await?
            };
            print_json(&value)
        }
        HermesCommand::Capabilities => print_json(&client.capabilities().await?),
        HermesCommand::Status { run_id } => print_json(&client.run_status(&run_id).await?),
        HermesCommand::Events { run_id } => {
            client
                .stream_events(&run_id, |event| print_sse_event(&event))
                .await
        }
        HermesCommand::Approve {
            run_id,
            choice,
            resolve_all,
        } => print_json(
            &client
                .resolve_approval(&run_id, choice.as_str(), resolve_all)
                .await?,
        ),
        HermesCommand::Stop { run_id } => print_json(&client.stop_run(&run_id).await?),
    }
}

// ---------------------------------------------------------------- daemon

async fn handle_node(command: NodeCommand, api_key: Option<&str>) -> Result<()> {
    match command {
        NodeCommand::Serve(args) => {
            let api_key = required_api_key(api_key)?;
            let node_home = nodehome::resolve(args.node_home.as_deref())?;
            let config = nodehome::NodeConfig::load(&node_home)?;

            // Registered projects and configured ones are both supervised; the
            // registry is the authority on which ids exist.
            let mut projects = config.projects.clone();
            projects.extend(args.project.clone());
            if let Ok(registry) = Registry::open(&node_home) {
                for project in registry.list_projects().unwrap_or_default() {
                    projects.push(project.project_id);
                }
            }
            projects.sort();
            projects.dedup();

            daemon::serve(DaemonConfig {
                state_root: node_home,
                base_url: args.base_url,
                api_key: api_key.to_owned(),
                projects,
                limits: Limits::default(),
                node_config: config,
            })
            .await
        }
        NodeCommand::Identity(args) => {
            let node_home = nodehome::resolve(args.node_home.as_deref())?;
            let identity = NodeIdentity::load_or_create(&node_home)?;
            let metadata = identity.metadata();
            print_json(&json!({
                "node_id": metadata.node_id,
                "public_key_fingerprint": metadata.fingerprint,
                "enrollment_state": metadata.enrollment_state(),
                "control_plane_url": metadata.control_plane_url,
                "enrolled_at": metadata.enrolled_at,
                "node_home": node_home.display().to_string(),
            }))
        }
        NodeCommand::Enroll(args) => {
            let node_home = nodehome::resolve(args.node_home.as_deref())?;
            let mut config = nodehome::NodeConfig::load(&node_home)?;
            let allow_plaintext =
                args.allow_plaintext_loopback || config.development.allow_plaintext_loopback;

            let token = read_enrollment_token(args.token_stdin)?;
            let mut identity = NodeIdentity::load_or_create(&node_home)?;
            let outcome = control::enroll(
                &mut identity,
                &args.control_plane,
                &token,
                &config.display_name,
                allow_plaintext,
            )
            .await?;
            // The token is dropped here and never written anywhere.
            drop(token);

            config.control_plane_url = Some(args.control_plane.clone());
            config.development.allow_plaintext_loopback = allow_plaintext;
            config.save(&node_home)?;

            print_json(&json!({
                "enrolled": true,
                "node_id": outcome.node_id,
                "protocol_version": outcome.protocol_version,
                "public_key_fingerprint": identity.fingerprint(),
                "control_plane_url": args.control_plane,
            }))
        }
        NodeCommand::RotateIdentity(args) => {
            let node_home = nodehome::resolve(args.node_home.as_deref())?;
            let mut config = nodehome::NodeConfig::load(&node_home)?;
            let allow_plaintext =
                args.allow_plaintext_loopback || config.development.allow_plaintext_loopback;

            let current = NodeIdentity::load(&node_home)?;
            let Some(node_id) = current.node_id().map(str::to_owned) else {
                bail!("this Node is not enrolled; use `node enroll` instead of rotating");
            };
            let previous_fingerprint = current.fingerprint().to_owned();

            // A daemon holding the old key would keep signing with it.
            let socket = daemon::socket_path(&node_home);
            let daemon_reachable = socket.exists()
                && NodeClient::new(&node_home)
                    .request("GET", "/v1/health", None)
                    .await
                    .is_ok();
            if daemon_reachable {
                bail!(
                    "the Node daemon is running; stop it before rotating so no session \
                     continues under the superseded key"
                );
            }

            let token = read_enrollment_token(args.token_stdin)?;
            // Proposed in memory only: the key on disk stays valid until the
            // Control Plane has accepted the replacement.
            let mut proposed = current.propose_rotation()?;
            let outcome = control::rotate(
                &mut proposed,
                &args.control_plane,
                &token,
                &config.display_name,
                allow_plaintext,
            )
            .await?;
            drop(token);

            if outcome.node_id != node_id {
                bail!(
                    "the Control Plane returned node id {} but this Node is {node_id}; \
                     refusing to adopt a different identity",
                    outcome.node_id
                );
            }
            proposed.commit_rotation()?;

            config.control_plane_url = Some(args.control_plane.clone());
            config.development.allow_plaintext_loopback = allow_plaintext;
            config.save(&node_home)?;

            print_json(&json!({
                "rotated": true,
                "node_id": outcome.node_id,
                "previous_public_key_fingerprint": previous_fingerprint,
                "public_key_fingerprint": proposed.fingerprint(),
                "control_plane_url": args.control_plane,
            }))
        }
        NodeCommand::Status(args) => {
            let node_home = nodehome::resolve(args.node_home.as_deref())?;
            let client = NodeClient::new(&node_home);
            let local = daemon::status(&node_home);

            match client.request("GET", "/v1/health", None).await {
                Ok(health) => {
                    let capabilities = client
                        .request("GET", "/v1/capabilities", None)
                        .await
                        .unwrap_or(Value::Null);
                    print_json(&json!({
                        "running": true,
                        "local": local,
                        "health": health,
                        "capabilities": capabilities,
                    }))
                }
                Err(error) => {
                    let detail = error
                        .downcast_ref::<NodeUnavailable>()
                        .map(client::unavailable_json)
                        .unwrap_or_else(|| json!({"message": error.to_string()}));
                    print_json(&json!({"running": false, "local": local, "detail": detail}))
                }
            }
        }
    }
}

/// Read the one-time enrollment token without ever putting it in argv.
///
/// stdin keeps it out of the process table and shell history; the interactive
/// path disables terminal echo so it does not appear on screen either.
fn read_enrollment_token(from_stdin: bool) -> Result<String> {
    use std::io::{BufRead, IsTerminal, Write};

    if from_stdin || !std::io::stdin().is_terminal() {
        let mut token = String::new();
        std::io::stdin().lock().read_line(&mut token)?;
        let token = token.trim().to_owned();
        if token.is_empty() {
            bail!("no enrollment token was provided on stdin");
        }
        return Ok(token);
    }

    eprint!("Enrollment token (input hidden): ");
    std::io::stderr().flush()?;
    let restore = disable_terminal_echo()?;
    let mut token = String::new();
    let read = std::io::stdin().lock().read_line(&mut token);
    restore();
    eprintln!();
    read?;

    let token = token.trim().to_owned();
    if token.is_empty() {
        bail!("no enrollment token was entered");
    }
    Ok(token)
}

/// Turn off terminal echo, returning a closure that restores it.
fn disable_terminal_echo() -> Result<impl FnOnce()> {
    use std::os::fd::AsRawFd;

    let fd = std::io::stdin().as_raw_fd();
    let mut term: libc::termios = unsafe { std::mem::zeroed() };
    // SAFETY: `fd` is a valid descriptor and `term` is a live termios value.
    if unsafe { libc::tcgetattr(fd, &mut term) } != 0 {
        bail!("failed to read terminal settings");
    }
    let original = term;
    term.c_lflag &= !libc::ECHO;
    unsafe { libc::tcsetattr(fd, libc::TCSANOW, &term) };

    Ok(move || {
        unsafe { libc::tcsetattr(fd, libc::TCSANOW, &original) };
    })
}

// ------------------------------------------------------------------- runs

/// Every run command is a daemon call. There is deliberately no standalone
/// fallback: a second path into run state would restore the split ownership and
/// races that owning supervision in one process exists to remove.
async fn handle_run(command: RunCommand) -> Result<()> {
    match &command {
        RunCommand::Start(args) => run_start(args).await,
        RunCommand::List(args) => {
            let client = NodeClient::new(&args.state_root);
            let path = format!("/v1/projects/{}/runs?limit={}", args.project_id, args.limit);
            print_json(&client.request("GET", &path, None).await?)
        }
        RunCommand::Show(args) => {
            let client = NodeClient::new(&args.state_root);
            print_json(&client.request("GET", &run_path(args, ""), None).await?)
        }
        RunCommand::Events(args) => {
            let client = NodeClient::new(&args.reference.state_root);
            let path = format!(
                "{}?since_seq={}",
                run_path(&args.reference, "/events"),
                args.since_seq
            );
            print_json(&client.request("GET", &path, None).await?)
        }
        RunCommand::Follow(args) => follow_run(args).await,
        RunCommand::Cancel(args) => {
            let client = NodeClient::new(&args.state_root);
            print_json(
                &client
                    .request("POST", &run_path(args, "/cancel"), None)
                    .await?,
            )
        }
        RunCommand::Retry(args) => {
            let client = NodeClient::new(&args.state_root);
            print_json(
                &client
                    .request("POST", &run_path(args, "/retry"), None)
                    .await?,
            )
        }
        RunCommand::Approve(args) => {
            let client = NodeClient::new(&args.reference.state_root);
            let body = json!({"choice": args.choice.as_str()});
            print_json(
                &client
                    .request("POST", &run_path(&args.reference, "/approval"), Some(&body))
                    .await?,
            )
        }
        RunCommand::Reconcile(args) => {
            let client = NodeClient::new(&args.state_root);
            let path = format!("/v1/projects/{}/reconcile", args.project_id);
            print_json(&client.request("POST", &path, None).await?)
        }
    }
}

fn run_path(reference: &RunRefArgs, suffix: &str) -> String {
    format!(
        "/v1/projects/{}/runs/{}{suffix}",
        reference.project_id, reference.run_id
    )
}

async fn run_start(args: &RunStartArgs) -> Result<()> {
    let client = NodeClient::new(&args.state_root);
    let body = json!({
        "input": args.input,
        "session_id": args.session_id,
        "instructions": args.instructions,
        "idempotency_key": args.idempotency_key,
    });
    let created = client
        .request(
            "POST",
            &format!("/v1/projects/{}/runs", args.project_id),
            Some(&body),
        )
        .await?;

    if !args.wait {
        return print_json(&created);
    }

    // The run belongs to the daemon; waiting here only tails its journal.
    let run_id = created["run"]["run_id"]
        .as_str()
        .context("the node did not return a run id")?
        .to_owned();
    stream_journal(&client, &args.project_id, &run_id, 0).await?;

    let final_state = client
        .request(
            "GET",
            &format!("/v1/projects/{}/runs/{run_id}", args.project_id),
            None,
        )
        .await?;
    print_json(&final_state["run"])
}

async fn follow_run(args: &RunEventsArgs) -> Result<()> {
    let client = NodeClient::new(&args.reference.state_root);
    stream_journal(
        &client,
        &args.reference.project_id,
        &args.reference.run_id,
        args.since_seq,
    )
    .await?;

    let final_state = client
        .request("GET", &run_path(&args.reference, ""), None)
        .await?;
    print_json(&final_state["run"])
}

/// Stream a run's journal, resuming from `since_seq`.
///
/// The server closes the stream once the run is terminal, so this returns
/// naturally at the end of a run and immediately for one that already finished.
async fn stream_journal(
    client: &NodeClient,
    project_id: &str,
    run_id: &str,
    since_seq: i64,
) -> Result<()> {
    let path = format!("/v1/projects/{project_id}/runs/{run_id}/events/stream");
    let cursor = (since_seq > 0).then_some(since_seq);

    client
        .stream(&path, cursor, |frame| {
            println!("{}", frame.data);
            Ok(true)
        })
        .await
}

// -------------------------------------------------- lifecycle coordination

/// Refuse a lifecycle action while the project has a durable active run.
///
/// Coordination goes through the daemon when it is reachable, because only the
/// daemon knows what it is currently supervising. When it is not reachable the
/// durable registry is consulted directly and the command still fails closed —
/// an unreachable daemon must never be read as "nothing is running".
async fn ensure_project_idle(state_root: &Path, project_id: &str, action: &str) -> Result<()> {
    let client = NodeClient::new(state_root);
    let path = format!("/v1/projects/{project_id}/activity");

    let activity = match client.request("GET", &path, None).await {
        Ok(value) => value,
        Err(error) if error.downcast_ref::<NodeUnavailable>().is_some() => {
            // Fall back to the durable record rather than assuming idleness.
            match Registry::open(state_root).and_then(|registry| registry.active_runs(project_id)) {
                Ok(active) => match active.into_iter().next() {
                    Some(run) => json!({
                        "active_run_id": run.run_id,
                        "active_status": run.status,
                    }),
                    None => json!({"active_run_id": Value::Null}),
                },
                Err(registry_error) => bail!(
                    "cannot determine whether project {project_id} is busy, so refusing to {action}: {registry_error:#}"
                ),
            }
        }
        Err(error) => return Err(error),
    };

    if let Some(run_id) = activity["active_run_id"].as_str() {
        let status = activity["active_status"].as_str().unwrap_or("active");
        return Err(ProjectBusy {
            project_id: project_id.to_owned(),
            run_id: run_id.to_owned(),
            status: status.to_owned(),
            action: action.to_owned(),
        }
        .into());
    }
    Ok(())
}

/// Ask the daemon to reconcile a project, ignoring its absence.
///
/// Used after `project start`, where reconciliation is desirable but a missing
/// daemon is not an error: the daemon reconciles at its own startup anyway.
async fn notify_reconcile(state_root: &Path, project_id: &str) {
    let client = NodeClient::new(state_root);
    let path = format!("/v1/projects/{project_id}/reconcile");
    let _ = client.request("POST", &path, None).await;
}

/// A lifecycle command was refused because the project has work in flight.
#[derive(Debug, Clone)]
struct ProjectBusy {
    project_id: String,
    run_id: String,
    status: String,
    action: String,
}

impl std::fmt::Display for ProjectBusy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "refusing to {} project {}: run {} is {}. Cancel it first with `run cancel`, or pass --force-interrupt.",
            self.action, self.project_id, self.run_id, self.status
        )
    }
}

impl std::error::Error for ProjectBusy {}

const PROJECT_BUSY_CODE: &str = "project_busy";

fn project_spec(args: ProjectArgs) -> Result<ProjectContainerSpec> {
    let terminal_security = args.terminal_security.into();
    ProjectContainerSpec::new(
        args.project_id,
        args.workspace,
        args.hermes_data,
        args.image,
        args.api_port,
    )
    .map(|spec| spec.with_terminal_security(terminal_security))
}

fn required_api_key(api_key: Option<&str>) -> Result<&str> {
    api_key.context("Hermes API key is required; set ASTERISM_HERMES_API_KEY or pass --api-key")
}

async fn wait_for_hermes(client: &HermesClient, timeout: Duration) -> Result<()> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut last_error = None;

    while tokio::time::Instant::now() < deadline {
        match client.health().await {
            Ok(_) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
        sleep(Duration::from_millis(500)).await;
    }

    match last_error {
        Some(error) => Err(error).context("Hermes did not become healthy before timeout"),
        None => bail!("Hermes did not become healthy before timeout"),
    }
}

fn print_json(value: &Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn print_sse_event(event: &SseEvent) -> Result<()> {
    let data = event
        .json_data()
        .unwrap_or_else(|| Value::String(event.data.clone()));
    let event_name = event.event.clone().or_else(|| {
        data.get("event")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    });
    println!(
        "{}",
        serde_json::to_string(&json!({
            "source": "hermes",
            "event": event_name,
            "data": data,
        }))?
    );
    Ok(())
}

/// Warn when the operator overrides the image with a mutable reference.
///
/// The default is digest-pinned and therefore silent. A tag is accepted — it is
/// useful while developing against a locally built image — but it makes the
/// result unreproducible, and saying so is the whole point of the warning.
fn warn_unpinned_image(image: &str) {
    if !asterism_node::docker::is_digest_pinned(image) {
        eprintln!(
            "WARNING: project runtime image {image} is not digest-pinned. \
             A tag can be repointed at different content, so this container is \
             not reproducible. Pass a reference of the form \
             name@sha256:<digest> for a reproducible runtime."
        );
    }
}
