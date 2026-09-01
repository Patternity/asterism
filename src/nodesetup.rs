//! Writing what a Node needs onto a host.
//!
//! The shell installer renders the same files and remains the supported path for
//! the current release, so two implementations exist for a while. That is a
//! drift risk, and it is handled the only way that actually works: the tests
//! render the shell installer's version of the files the Node itself depends on
//! and compare them byte for byte with what this module produces. If either side
//! changes alone, the test says so.
//!
//! Everything here is driven by [`HostPaths`], so the same code writes a real
//! host and a temporary directory in a test.

use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use anyhow::{Context, Result, bail};

use crate::hostsetup::HostPaths;

/// The account the runtime is owned by, and the group of the same name.
pub const SERVICE_ACCOUNT: &str = "asterism";
/// Where the sudoers policy expects systemctl to be. The policy names an
/// absolute path because a rule matching a bare command name would match
/// whatever a caller's PATH resolved it to.
pub const SYSTEMCTL_BIN: &str = "/usr/bin/systemctl";
const REPO: &str = "Patternity/asterism";

/// What a Node is configured with.
///
/// No project appears here. A fresh Node is capacity: an identity, a runtime and
/// nothing running on it. Projects arrive afterwards and provision themselves.
#[derive(Debug, Clone)]
pub struct Settings {
    pub hermes_port: u16,
    pub control_plane: String,
}

/// The per-project worker template.
///
/// Installed, never enabled: instances are started by the Node by exact unit
/// name, so enabling the template would start a worker for a project that does
/// not exist.
pub fn worker_template(paths: &HostPaths) -> String {
    format!(
        r#"# One Hermes worker for one Asterism project.
#
# The instance name is the project's generated profile — never its display name,
# so renaming a project cannot orphan its Hermes state, and never anything that
# arrived from the wire. Each instance has its own HERMES_HOME, so its sessions,
# memory and state database are separate files rather than rows filtered after
# retrieval.
#
# Installed but not enabled: the Node starts and stops instances by exact unit
# name. Pattern matching is deliberately absent from that path — a `pkill -f`
# pattern in this project's history once matched an unrelated process.
[Unit]
Description=Asterism Hermes worker for project profile %i
Documentation=https://github.com/{REPO}/blob/master/docs/deployment.md
After=network-online.target
Wants=network-online.target
# A configuration error should fail visibly rather than retry forever.
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User={user}
Group={user}
# The profile home, not the project workspace: where tools run is Hermes'
# own terminal.cwd, set per profile in its generated config.
WorkingDirectory={homes}/%i
# HERMES_HOME, the loopback port and this worker's API key all arrive here, so
# the key stays out of ExecStart, out of the process table and out of
# `systemctl show`. Provisioning writes the file 0600, owned by the runtime user.
EnvironmentFile={homes}/%i/runtime.env
Environment=PATH={codex}/bin:{hermes}/.venv/bin:/usr/local/bin:/usr/bin:/bin
ExecStart={hermes}/.venv/bin/hermes gateway
# Hermes handles SIGTERM and then exits 1, which systemd would otherwise record
# as failed after an ordinary stop. Restart=always keeps crash recovery
# regardless of exit status, so accepting 1 as clean loses nothing.
Restart=always
SuccessExitStatus=1
RestartSec=5
TimeoutStartSec=90
TimeoutStopSec=30
KillSignal=SIGTERM
NoNewPrivileges=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
StandardOutput=journal
StandardError=journal
SyslogIdentifier=asterism-hermes-%i

[Install]
WantedBy=multi-user.target
"#,
        user = SERVICE_ACCOUNT,
        homes = paths.hermes_project_home_root().display(),
        codex = paths.codex_dir().display(),
        hermes = paths.hermes_dir().display(),
    )
}

/// The whole of the Node's escalation: four verbs on one template.
pub fn worker_sudoers() -> String {
    format!(
        r#"# Authority for the Asterism Node to supervise its own project workers.
#
# The Node runs as an unprivileged account and must start, stop, restart and
# query exactly one systemd template: the per-project Hermes worker. This file
# is the whole of that escalation, which is the point of writing it out rather
# than running the daemon as root.
#
# The unit argument is bounded twice over. The Node validates a profile name to
# lowercase letters, digits and dashes before it can become an instance name, and
# these rules accept nothing but that template. There is no shell in the path:
# the Node executes sudo directly with the unit as one argument.
#
# Install as /etc/sudoers.d/asterism-node with mode 0440, owned by root, and
# validate with `visudo -cf` before trusting it.
Cmnd_Alias ASTERISM_WORKER = \
    {systemctl} start asterism-hermes@*.service, \
    {systemctl} stop asterism-hermes@*.service, \
    {systemctl} restart asterism-hermes@*.service, \
    {systemctl} is-active asterism-hermes@*.service

{user} ALL=(root) NOPASSWD: ASTERISM_WORKER
"#,
        systemctl = SYSTEMCTL_BIN,
        user = SERVICE_ACCOUNT,
    )
}

/// The Node's own unit.
///
/// Two directives are deliberately absent and the comment says why, because both
/// have reached production and both broke the same thing.
pub fn node_unit(paths: &HostPaths) -> String {
    format!(
        r#"[Unit]
Description=Asterism Node
Documentation=https://github.com/{REPO}/blob/master/docs/installation.md
# Hermes first: the Node dials it. Ordering is not readiness, so the Node also
# retries — a unit that merely starts second would still race the runtime.
After=network-online.target asterism-hermes.service
Wants=network-online.target
Requires=asterism-hermes.service

[Service]
Type=simple
User={user}
Group={user}
SupplementaryGroups=docker
WorkingDirectory={state}
EnvironmentFile={env}
# No project is named. A freshly installed Node is capacity: it reconciles
# whatever the Control Plane has assigned to it and starts with nothing.
ExecStart={binary} node serve --node-home {node_home}
Restart=always
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGTERM
# Two directives are deliberately absent here, and both would break the same
# thing. The Node supervises one systemd unit per project through the narrow
# sudoers rule in /etc/sudoers.d/asterism-node, and NoNewPrivileges makes every
# setuid binary inert for this process and its children: it does not narrow that
# escalation, it removes it, and every project worker then fails before it runs.
# ProtectKernelTunables implies NoNewPrivileges, so it forbids the escalation
# just as completely while looking like an unrelated hardening choice --
# `systemctl show -p NoNewPrivileges` still answers `no`, which is how this
# survived review. The boundary is the sudoers rule: four verbs, one template.
PrivateTmp=yes
ProtectControlGroups=yes
StandardOutput=journal
StandardError=journal
SyslogIdentifier=asterism-node

[Install]
WantedBy=multi-user.target
"#,
        user = SERVICE_ACCOUNT,
        state = paths.state_root().display(),
        env = paths.env_file().display(),
        binary = paths.node_binary().display(),
        node_home = paths.node_home().display(),
    )
}

/// The shared Hermes runtime the Node dials.
pub fn hermes_unit(paths: &HostPaths, settings: &Settings) -> String {
    format!(
        r#"[Unit]
Description=Asterism host-native Hermes agent runtime
Documentation=https://github.com/{REPO}/blob/master/docs/installation.md
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service
# Bound the restart loop so a configuration error fails visibly instead of
# retrying forever.
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User={user}
Group={user}
SupplementaryGroups=docker
WorkingDirectory={workspace}
# The API key reaches Hermes through the environment file, never through the
# command line, so it stays out of the process table and out of systemctl show.
EnvironmentFile={env}
Environment=HOME={state}
Environment=HERMES_HOME={hermes_home}
Environment=HERMES_CONFIG_DIR={hermes_home}
Environment=CODEX_HOME={hermes_home}/.codex
Environment=API_SERVER_ENABLED=true
Environment=API_SERVER_HOST=127.0.0.1
Environment=API_SERVER_PORT={port}
Environment=PYTHONUNBUFFERED=1
Environment=PATH={codex}/bin:{hermes}/.venv/bin:/usr/local/bin:/usr/bin:/bin
ExecStart={hermes}/.venv/bin/hermes gateway
# Hermes handles SIGTERM and then exits 1, which systemd would otherwise record
# as a failed unit after an ordinary `systemctl stop`. Restart=always keeps crash
# recovery regardless of exit status, so nothing is lost by accepting 1 as clean.
Restart=always
SuccessExitStatus=1
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGTERM
NoNewPrivileges=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
StandardOutput=journal
StandardError=journal
SyslogIdentifier=asterism-hermes

[Install]
WantedBy=multi-user.target
"#,
        user = SERVICE_ACCOUNT,
        workspace = paths.workspace().display(),
        env = paths.env_file().display(),
        state = paths.state_root().display(),
        hermes_home = paths.hermes_home().display(),
        port = settings.hermes_port,
        codex = paths.codex_dir().display(),
        hermes = paths.hermes_dir().display(),
    )
}

/// The Hermes configuration a shared runtime starts with.
pub fn hermes_config(paths: &HostPaths, settings: &Settings, journal_mode: &str) -> String {
    format!(
        r#"# Asterism-managed Hermes configuration.
#
# The API binds to loopback only: Asterism Node reaches it over 127.0.0.1 and
# nothing else may. No inbound public port is introduced by this installation.
api_server:
  enabled: true
  host: 127.0.0.1
  port: {port}

terminal:
  backend: local
  cwd: {workspace}

model:
  provider: openai-codex

approvals:
  mode: manual

database:
  # Chosen from the SQLite the runtime actually links, not from what it ought to
  # link. See docs/installation.md for the threshold and why it matters.
  journal_mode: {journal_mode}
"#,
        port = settings.hermes_port,
        workspace = paths.workspace().display(),
    )
}

/// Write a file only root should be able to change, atomically.
///
/// Written to a neighbouring temporary name and renamed, so a reader never sees
/// a half-written unit, and a failed write leaves the previous one intact.
pub fn write_file(path: &Path, contents: &str, mode: u32) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("cannot create {}", parent.display()))?;
    }
    let temporary = path.with_extension("asterism-new");
    {
        let mut file = std::fs::File::create(&temporary)
            .with_context(|| format!("cannot write {}", temporary.display()))?;
        file.write_all(contents.as_bytes())?;
        file.set_permissions(std::fs::Permissions::from_mode(mode))?;
        file.sync_all()?;
    }
    std::fs::rename(&temporary, path)
        .with_context(|| format!("cannot install {}", path.display()))?;
    Ok(())
}

/// Create a directory with an exact mode, correcting one that already exists.
///
/// Refuses a symlink outright: state that a Node owns must live on a real
/// directory, or a later `chown -R` follows the link somewhere it should not go.
pub fn ensure_directory(path: &Path, mode: u32) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path);
    match metadata {
        Ok(found) if found.file_type().is_symlink() => {
            bail!(
                "{} is a symlink; Node state must live on a real directory",
                path.display()
            )
        }
        Ok(found) if !found.is_dir() => {
            bail!(
                "{} exists but is not a directory; move it aside and try again",
                path.display()
            )
        }
        Ok(_) => {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))?;
        }
        Err(_) => {
            std::fs::create_dir_all(path)
                .with_context(|| format!("cannot create {}", path.display()))?;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))?;
        }
    }
    Ok(())
}

/// The environment file, which carries the Hermes API key.
///
/// An existing key is preserved rather than regenerated: rotating it would
/// silently break a Hermes that is already running with it, and repairing an
/// installation is not a reason to invalidate its credentials.
pub fn write_env_file(paths: &HostPaths, settings: &Settings) -> Result<()> {
    let path = paths.env_file();
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let key = match existing
        .lines()
        .find_map(|line| line.strip_prefix("ASTERISM_HERMES_API_KEY="))
    {
        Some(found) if !found.trim().is_empty() => found.trim().to_string(),
        _ => generate_key()?,
    };

    // One key under two names. The Node reads ASTERISM_HERMES_API_KEY; the
    // Hermes API server reads API_SERVER_KEY and refuses to start without it,
    // loopback bind included. Both must be the same value or the Node
    // authenticates to nothing.
    let contents = format!(
        "# Asterism runtime environment. Contains a secret: keep mode 0640, root:{user}.\n\
         #\n\
         # One key under two names. The Node reads ASTERISM_HERMES_API_KEY; the Hermes API\n\
         # server reads API_SERVER_KEY and refuses to start without it, loopback bind\n\
         # included. Both must be the same value or the Node authenticates to nothing.\n\
         ASTERISM_HERMES_API_KEY={key}\n\
         API_SERVER_KEY={key}\n\
         ASTERISM_HERMES_PORT={port}\n\
         ASTERISM_HERMES_URL=http://127.0.0.1:{port}\n\
         ASTERISM_NODE_HOME={node_home}\n",
        user = SERVICE_ACCOUNT,
        port = settings.hermes_port,
        node_home = paths.node_home().display(),
    );
    write_file(&path, &contents, 0o640)
}

/// 32 bytes of kernel randomness, hex-encoded.
///
/// Never echoed, never an argument, never sent to the Control Plane and never in
/// a unit's command line.
fn generate_key() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).context("cannot read randomness for the Hermes API key")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Renders a function from the shell installer against the same prefix.
    ///
    /// This is what keeps two implementations of one file honest while both
    /// exist. It calls the installer's own renderer rather than a copy of it.
    fn shell_render(function: &str, prefix: &Path) -> String {
        let script = format!(
            "set -euo pipefail
             export ASTERISM_INSTALL_LIB_ONLY=1
             export ASTERISM_PREFIX={prefix}
             . {here}/scripts/install.sh
             {function}",
            prefix = prefix.display(),
            here = env!("CARGO_MANIFEST_DIR"),
        );
        let output = std::process::Command::new("bash")
            .arg("-c")
            .arg(&script)
            .output()
            .expect("bash must run");
        assert!(
            output.status.success(),
            "the shell installer failed to render {function}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).expect("the rendered file must be UTF-8")
    }

    #[test]
    fn the_worker_template_matches_the_one_the_shell_installer_writes() {
        let root = tempfile::tempdir().unwrap();
        let paths = HostPaths::with_prefix(root.path());
        assert_eq!(
            worker_template(&paths),
            shell_render("render_worker_unit", root.path()),
        );
    }

    #[test]
    fn the_worker_policy_matches_the_one_the_shell_installer_writes() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            worker_sudoers(),
            shell_render("render_worker_sudoers", root.path()),
        );
    }

    #[test]
    fn the_node_unit_does_not_forbid_the_escalation_its_workers_depend_on() {
        let root = tempfile::tempdir().unwrap();
        let unit = node_unit(&HostPaths::with_prefix(root.path()));
        for directive in ["NoNewPrivileges", "ProtectKernelTunables"] {
            assert!(
                !unit
                    .lines()
                    .any(|line| line.trim_start().starts_with(directive)),
                "the Node unit sets {directive}, which removes the sudo rule its workers need"
            );
        }
    }

    #[test]
    fn the_node_unit_names_no_project() {
        let root = tempfile::tempdir().unwrap();
        let unit = node_unit(&HostPaths::with_prefix(root.path()));
        assert!(
            !unit.contains("--project"),
            "a freshly installed Node must start with no project"
        );
    }

    #[test]
    fn an_existing_api_key_survives_a_repair() {
        let root = tempfile::tempdir().unwrap();
        let paths = HostPaths::with_prefix(root.path());
        let settings = Settings {
            hermes_port: 18642,
            control_plane: "https://example.invalid".into(),
        };

        write_env_file(&paths, &settings).unwrap();
        let first = std::fs::read_to_string(paths.env_file()).unwrap();
        let key = first
            .lines()
            .find_map(|line| line.strip_prefix("ASTERISM_HERMES_API_KEY="))
            .unwrap()
            .to_string();

        write_env_file(&paths, &settings).unwrap();
        let second = std::fs::read_to_string(paths.env_file()).unwrap();
        assert!(
            second.contains(&format!("ASTERISM_HERMES_API_KEY={key}")),
            "the key was rotated by a repair"
        );
        assert!(second.contains(&format!("API_SERVER_KEY={key}")));
    }

    #[test]
    fn the_environment_file_is_closed_to_other_accounts() {
        let root = tempfile::tempdir().unwrap();
        let paths = HostPaths::with_prefix(root.path());
        write_env_file(
            &paths,
            &Settings {
                hermes_port: 18642,
                control_plane: "https://example.invalid".into(),
            },
        )
        .unwrap();
        let mode = std::fs::metadata(paths.env_file())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o640, "the credentials file is {mode:o}");
    }

    #[test]
    fn a_generated_key_is_not_the_same_twice() {
        assert_ne!(generate_key().unwrap(), generate_key().unwrap());
        assert_eq!(generate_key().unwrap().len(), 64);
    }

    #[test]
    fn state_that_is_a_symlink_is_refused_rather_than_followed() {
        let root = tempfile::tempdir().unwrap();
        let elsewhere = root.path().join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        let link = root.path().join("projects");
        std::os::unix::fs::symlink(&elsewhere, &link).unwrap();

        let error = ensure_directory(&link, 0o700).unwrap_err().to_string();
        assert!(error.contains("symlink"), "{error}");
    }

    #[test]
    fn a_directory_that_already_exists_is_corrected_rather_than_recreated() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("projects");
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("keep-me"), "state").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o777)).unwrap();

        ensure_directory(&path, 0o700).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::read_to_string(path.join("keep-me")).unwrap(),
            "state"
        );
    }

    #[test]
    fn a_unit_is_never_visible_half_written() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("etc/systemd/system/asterism-node.service");
        write_file(&path, "[Service]\n", 0o644).unwrap();
        write_file(&path, "[Service]\nExecStart=/bin/true\n", 0o644).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "[Service]\nExecStart=/bin/true\n"
        );
        // The temporary neighbour is renamed, never left behind.
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains("asterism-new"))
            .collect();
        assert!(leftovers.is_empty(), "a temporary file was left behind");
    }
}
