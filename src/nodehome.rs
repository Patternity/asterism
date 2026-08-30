//! Node home resolution and on-disk configuration.
//!
//! Phase E derived every Node path from the process working directory, which is
//! fine for development but wrong for a system service: the same daemon started
//! from a different directory would silently adopt a different identity and a
//! different registry. Node home fixes that to one canonical absolute location.
//!
//! Resolution order:
//!
//! 1. an explicit `--node-home` argument;
//! 2. the `ASTERISM_NODE_HOME` environment variable;
//! 3. the existing `./.asterism` default, preserved so current development
//!    workflows keep working unchanged.
//!
//! Everything Node owns lives under it: the registry, the Unix socket, the
//! daemon lock, the Ed25519 identity, the remote configuration, and remote
//! command state. None of it is ever mounted into a project container.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

/// Environment variable that pins Node home.
pub const NODE_HOME_ENV: &str = "ASTERISM_NODE_HOME";

/// Development default, unchanged from Phase E.
pub const DEFAULT_NODE_HOME: &str = "./.asterism";

/// Configuration file name inside Node home.
pub const CONFIG_FILE: &str = "node/config.toml";

/// Resolve, create, and harden Node home.
///
/// The result is canonical, so nothing downstream can be influenced by a later
/// change of working directory.
pub fn resolve(explicit: Option<&Path>) -> Result<PathBuf> {
    let raw = match explicit {
        Some(path) => path.to_path_buf(),
        None => match std::env::var_os(NODE_HOME_ENV) {
            Some(value) if !value.is_empty() => PathBuf::from(value),
            _ => PathBuf::from(DEFAULT_NODE_HOME),
        },
    };

    validate_candidate(&raw)?;
    std::fs::create_dir_all(raw.join("node"))
        .with_context(|| format!("failed to create Node home {}", raw.display()))?;

    let canonical = raw
        .canonicalize()
        .with_context(|| format!("failed to canonicalize Node home {}", raw.display()))?;
    harden(&canonical.join("node"))?;
    Ok(canonical)
}

/// Reject paths that would make Node state ambiguous or unsafe.
fn validate_candidate(path: &Path) -> Result<()> {
    let text = path.as_os_str().to_string_lossy();
    if text.trim().is_empty() {
        bail!("Node home must not be empty");
    }
    if text.contains('\0') {
        bail!("Node home must not contain NUL bytes");
    }
    if path == Path::new("/") {
        bail!("Node home must not be the filesystem root");
    }
    // A relative path is only tolerated for the documented development default;
    // anything else must be explicit and absolute so a service cannot pick up a
    // different home depending on where it was started.
    if !path.is_absolute() && path != Path::new(DEFAULT_NODE_HOME) {
        bail!(
            "Node home {} must be absolute (only the development default {DEFAULT_NODE_HOME} may be relative)",
            path.display()
        );
    }
    Ok(())
}

fn harden(dir: &Path) -> Result<()> {
    let mut permissions = std::fs::metadata(dir)?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(dir, permissions)
        .with_context(|| format!("failed to restrict {}", dir.display()))
}

pub fn config_path(node_home: &Path) -> PathBuf {
    node_home.join(CONFIG_FILE)
}

/// Persistent Node configuration.
///
/// Deliberately holds no secrets: the enrollment token is never stored, and
/// provider credentials live inside the project container, not here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct NodeConfig {
    /// Control Plane base URL. `https://` is mandatory outside development.
    pub control_plane_url: Option<String>,
    /// Human-readable name reported to the Control Plane.
    pub display_name: String,
    /// Projects reconciled and supervised by this Node.
    pub projects: Vec<String>,
    /// Hermes endpoint used by run workers.
    pub hermes_url: String,
    /// The `HERMES_HOME` the endpoint above serves.
    ///
    /// Recorded so the project that predates project-scoped homes can be bound
    /// to the home it has in fact been using, rather than reaching it through a
    /// per-run fallback that would also catch projects nobody bound.
    pub hermes_home: String,
    pub log_level: String,
    pub reconnect: ReconnectConfig,
    pub heartbeat: HeartbeatConfig,
    pub history: HistoryConfig,
    pub development: DevelopmentConfig,
}

impl Default for NodeConfig {
    fn default() -> Self {
        Self {
            control_plane_url: None,
            display_name: default_display_name(),
            projects: Vec::new(),
            hermes_url: "http://127.0.0.1:18642".to_owned(),
            hermes_home: "/var/lib/asterism/hermes".to_owned(),
            log_level: "info".to_owned(),
            reconnect: ReconnectConfig::default(),
            heartbeat: HeartbeatConfig::default(),
            history: HistoryConfig::default(),
            development: DevelopmentConfig::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ReconnectConfig {
    pub initial_backoff_ms: u64,
    pub max_backoff_ms: u64,
    /// Fractional jitter applied to each delay, 0.0..=1.0.
    pub jitter: f64,
    /// A session that stays up this long resets the backoff to its initial value.
    pub stable_session_ms: u64,
}

impl Default for ReconnectConfig {
    fn default() -> Self {
        Self {
            initial_backoff_ms: 500,
            max_backoff_ms: 60_000,
            jitter: 0.25,
            stable_session_ms: 30_000,
        }
    }
}

/// How much of a conversation is replayed to Hermes on each turn.
///
/// A long task outgrows these and the earliest turns are dropped, which the run
/// records as `conversation.history_truncated`. The right ceiling depends on the
/// model's context window and on what the operator is willing to spend per turn,
/// so it is a setting rather than a constant — but a bounded one: an unbounded
/// history would eventually exceed what Hermes accepts in a single request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct HistoryConfig {
    pub max_turns: usize,
    pub max_bytes: usize,
}

impl Default for HistoryConfig {
    fn default() -> Self {
        Self {
            max_turns: crate::chathistory::DEFAULT_MAX_TURNS,
            max_bytes: crate::chathistory::DEFAULT_MAX_BYTES,
        }
    }
}

impl HistoryConfig {
    /// Clamp rather than refuse: a Node that will not start because of a typo in
    /// a tuning value is worse than one that runs with a sane bound.
    pub fn bounded(&self) -> (usize, usize) {
        (
            self.max_turns.clamp(1, 500),
            self.max_bytes.clamp(4 * 1024, 4 * 1024 * 1024),
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct HeartbeatConfig {
    pub interval_ms: u64,
    /// Missing this many consecutive heartbeat responses drops the session.
    pub missed_limit: u32,
}

impl Default for HeartbeatConfig {
    fn default() -> Self {
        Self {
            interval_ms: 15_000,
            missed_limit: 3,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct DevelopmentConfig {
    /// Permit plaintext `http://` and `ws://` — loopback only, and never
    /// implicitly. Exists so the mock Control Plane can be tested without TLS.
    pub allow_plaintext_loopback: bool,
}

impl NodeConfig {
    pub fn load(node_home: &Path) -> Result<Self> {
        let path = config_path(node_home);
        if !path.is_file() {
            return Ok(Self::default());
        }
        let body = std::fs::read_to_string(&path)
            .with_context(|| format!("failed to read {}", path.display()))?;
        toml::from_str(&body).with_context(|| format!("failed to parse {}", path.display()))
    }

    pub fn save(&self, node_home: &Path) -> Result<()> {
        let path = config_path(node_home);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let body = toml::to_string_pretty(self)?;
        std::fs::write(&path, body)
            .with_context(|| format!("failed to write {}", path.display()))?;
        let mut permissions = std::fs::metadata(&path)?.permissions();
        permissions.set_mode(0o600);
        std::fs::set_permissions(&path, permissions)?;
        Ok(())
    }
}

fn default_display_name() -> String {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "asterism-node".to_owned())
}

#[cfg(test)]
mod history_config_tests {
    use super::HistoryConfig;

    #[test]
    fn defaults_match_the_shipped_limits() {
        let (turns, bytes) = HistoryConfig::default().bounded();
        assert_eq!(turns, crate::chathistory::DEFAULT_MAX_TURNS);
        assert_eq!(bytes, crate::chathistory::DEFAULT_MAX_BYTES);
    }

    #[test]
    fn a_larger_history_is_honoured() {
        // The reason this is configurable: a long task otherwise loses its
        // earliest turns to `conversation.history_truncated`.
        let config = HistoryConfig {
            max_turns: 60,
            max_bytes: 256 * 1024,
        };
        assert_eq!(config.bounded(), (60, 256 * 1024));
    }

    #[test]
    fn absurd_values_are_clamped_rather_than_fatal() {
        let zero = HistoryConfig {
            max_turns: 0,
            max_bytes: 1,
        };
        assert_eq!(zero.bounded(), (1, 4 * 1024));

        let enormous = HistoryConfig {
            max_turns: 100_000,
            max_bytes: 900 * 1024 * 1024,
        };
        assert_eq!(enormous.bounded(), (500, 4 * 1024 * 1024));
    }

    #[test]
    fn a_config_without_the_section_still_loads() {
        // Every Node in the field has a config.toml written before this setting
        // existed; those must keep working untouched.
        let config: super::NodeConfig = toml::from_str(
            r#"
            display_name = "node"
            hermes_url = "http://127.0.0.1:18642"
            log_level = "info"
            projects = []
            "#,
        )
        .unwrap();
        assert_eq!(config.history, HistoryConfig::default());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_explicit_path_wins_over_the_environment() {
        let dir = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var(NODE_HOME_ENV, other.path()) };

        let resolved = resolve(Some(dir.path())).unwrap();

        unsafe { std::env::remove_var(NODE_HOME_ENV) };
        assert_eq!(resolved, dir.path().canonicalize().unwrap());
    }

    #[test]
    fn resolution_is_canonical_and_creates_the_node_directory() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("state").join("..").join("state");
        std::fs::create_dir_all(dir.path().join("state")).unwrap();

        let resolved = resolve(Some(&nested)).unwrap();

        assert!(resolved.is_absolute());
        assert!(!resolved.to_string_lossy().contains(".."));
        assert!(resolved.join("node").is_dir());
    }

    #[test]
    fn the_node_directory_is_restricted_to_its_owner() {
        let dir = tempfile::tempdir().unwrap();
        let resolved = resolve(Some(dir.path())).unwrap();

        let mode = std::fs::metadata(resolved.join("node"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[test]
    fn unsafe_or_ambiguous_paths_are_rejected() {
        assert!(validate_candidate(Path::new("")).is_err());
        assert!(validate_candidate(Path::new("/")).is_err());
        // A relative path other than the documented development default would
        // make Node identity depend on the working directory.
        assert!(validate_candidate(Path::new("some/relative/path")).is_err());
        assert!(validate_candidate(Path::new(DEFAULT_NODE_HOME)).is_ok());
        assert!(validate_candidate(Path::new("/srv/asterism")).is_ok());
    }

    #[test]
    fn an_absent_configuration_yields_safe_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let config = NodeConfig::load(dir.path()).unwrap();

        assert_eq!(config.control_plane_url, None);
        assert!(config.projects.is_empty());
        assert!(
            !config.development.allow_plaintext_loopback,
            "plaintext must never be enabled implicitly"
        );
        assert!(config.reconnect.max_backoff_ms >= config.reconnect.initial_backoff_ms);
    }

    #[test]
    fn configuration_round_trips_through_toml() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("node")).unwrap();

        let config = NodeConfig {
            control_plane_url: Some("https://control.example".to_owned()),
            projects: vec!["phase-a".to_owned()],
            display_name: "test-node".to_owned(),
            ..NodeConfig::default()
        };
        config.save(dir.path()).unwrap();

        let loaded = NodeConfig::load(dir.path()).unwrap();
        assert_eq!(loaded, config);
    }

    #[test]
    fn the_configuration_file_is_owner_only() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("node")).unwrap();
        NodeConfig::default().save(dir.path()).unwrap();

        let mode = std::fs::metadata(config_path(dir.path()))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn unknown_configuration_keys_are_rejected() {
        // A typo in a service configuration must fail loudly rather than being
        // silently ignored.
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("node")).unwrap();
        std::fs::write(
            config_path(dir.path()),
            "display_name = \"x\"\nnot_a_real_key = 1\n",
        )
        .unwrap();

        assert!(NodeConfig::load(dir.path()).is_err());
    }

    #[test]
    fn configuration_never_carries_secret_fields() {
        let rendered = toml::to_string_pretty(&NodeConfig::default()).unwrap();
        for forbidden in ["token", "secret", "password", "private_key"] {
            assert!(
                !rendered.contains(forbidden),
                "configuration must not define a {forbidden} field"
            );
        }
    }
}
