//! Visibility and revocation for Hermes' persistent approval allowlist.
//!
//! Answering an approval with "always" makes Hermes write the matched command
//! *category* into `command_allowlist` in its own config, and
//! `is_command_allowlisted()` then skips the approval prompt for everything in
//! that category, permanently and across restarts. One click can therefore
//! disable prompting for a whole class of dangerous commands — `recursive
//! delete` among them — with nothing in Asterism showing that it happened.
//!
//! This module gives the local operator the two things that were missing: a way
//! to see the rules that exist, and a way to remove them.
//!
//! Reading and clearing go through Hermes' own `hermes config` CLI, which is a
//! supported interface with the exact semantics Hermes itself uses. Revoking a
//! single entry does not: `hermes config set` writes scalars, so a list cannot
//! be rebuilt through it. Only that one path edits the file, and it edits
//! exactly one key.
//!
//! Everything here is local-operator only. None of it is reachable through the
//! Control Plane command protocol, and no host path is ever reported upward.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};
use serde::Serialize;

/// Where the policy came from, so an operator can tell "nothing is allowlisted"
/// apart from "this runtime is not one we can inspect".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicySource {
    /// A Hermes this Node's installer provisioned, whose CLI and home are known.
    InstallerManaged,
    /// Someone else's Hermes. Its configuration location is not ours to guess.
    ExternalUnmanaged,
}

/// What `project approvals show` reports.
#[derive(Debug, Clone, Serialize)]
pub struct ApprovalPolicy {
    pub project_id: String,
    pub runtime_ownership: String,
    /// `available` when the policy could be read, `unavailable` otherwise.
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approvals_mode: Option<String>,
    pub persistent_allowlist: Vec<String>,
    pub persistent_allowlist_count: usize,
    /// Hermes loads the allowlist at startup, so a mutation is not in force
    /// until it restarts. Saying so is the difference between a revocation an
    /// operator believes in and one that is still being bypassed.
    pub restart_required: bool,
    pub source: PolicySource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

/// How to reach one project's Hermes configuration.
#[derive(Debug, Clone)]
pub struct HermesCli {
    pub binary: PathBuf,
    pub home: PathBuf,
}

impl HermesCli {
    /// Resolve from Node-local installation metadata.
    ///
    /// The path comes from the Node's own disk, never from the wire: a runtime
    /// endpoint may be remote-supplied, but a filesystem path is not part of
    /// the data model and must not become one.
    pub fn from_metadata(metadata_path: &Path) -> Option<Self> {
        let text = std::fs::read_to_string(metadata_path).ok()?;
        let value: serde_json::Value = serde_json::from_str(&text).ok()?;
        let binary = value.get("hermes_cli")?.as_str()?;
        let home = value.get("hermes_home")?.as_str()?;
        let cli = Self {
            binary: PathBuf::from(binary),
            home: PathBuf::from(home),
        };
        cli.binary.is_file().then_some(cli)
    }

    fn run(&self, args: &[&str]) -> Result<String> {
        let output = Command::new(&self.binary)
            .args(args)
            .env("HOME", &self.home)
            .env("HERMES_HOME", &self.home)
            .output()
            .with_context(|| format!("cannot run {}", self.binary.display()))?;
        if !output.status.success() {
            bail!(
                "hermes {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    fn config_path(&self) -> Result<PathBuf> {
        Ok(PathBuf::from(self.run(&["config", "path"])?.trim()))
    }
}

/// Strip the ANSI colouring the Hermes CLI writes even when piped.
fn plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            for skip in chars.by_ref() {
                if skip.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Parse the YAML-ish list `hermes config get` prints for a sequence value.
pub fn parse_allowlist(output: &str) -> Vec<String> {
    plain(output)
        .lines()
        .map(str::trim)
        .filter_map(|line| line.strip_prefix("- "))
        .map(|entry| entry.trim().trim_matches('"').to_owned())
        .filter(|entry| !entry.is_empty())
        .collect()
}

/// Read the effective policy.
pub fn show(cli: Option<&HermesCli>, project_id: &str, ownership: &str) -> ApprovalPolicy {
    let Some(cli) = cli else {
        return ApprovalPolicy {
            project_id: project_id.to_owned(),
            runtime_ownership: ownership.to_owned(),
            state: "unavailable",
            approvals_mode: None,
            persistent_allowlist: Vec::new(),
            persistent_allowlist_count: 0,
            restart_required: false,
            source: PolicySource::ExternalUnmanaged,
            unavailable_reason: Some(
                "this runtime was not provisioned by this Node's installer, so its \
                 configuration location is unknown and will not be guessed"
                    .to_owned(),
            ),
        };
    };

    let mode = cli
        .run(&["config", "get", "approvals.mode"])
        .ok()
        .map(|text| plain(&text).trim().to_owned());
    let allowlist = cli
        .run(&["config", "get", "command_allowlist"])
        .map(|text| parse_allowlist(&text))
        .unwrap_or_default();

    ApprovalPolicy {
        project_id: project_id.to_owned(),
        runtime_ownership: ownership.to_owned(),
        state: if mode.is_some() {
            "available"
        } else {
            "unavailable"
        },
        approvals_mode: mode,
        persistent_allowlist_count: allowlist.len(),
        persistent_allowlist: allowlist,
        restart_required: false,
        source: PolicySource::InstallerManaged,
        unavailable_reason: None,
    }
}

/// Remove every persistent rule, through Hermes' own CLI.
pub fn clear(cli: &HermesCli) -> Result<usize> {
    let before = parse_allowlist(&cli.run(&["config", "get", "command_allowlist"])?);
    if before.is_empty() {
        return Ok(0);
    }
    cli.run(&["config", "unset", "command_allowlist"])?;
    Ok(before.len())
}

/// Remove one category.
///
/// `hermes config set` writes scalars, so the list is rewritten here. This is
/// the only place Asterism edits the file, and it touches exactly one key.
pub fn revoke(cli: &HermesCli, category: &str) -> Result<Vec<String>> {
    let path = cli.config_path()?;
    let before = parse_allowlist(&cli.run(&["config", "get", "command_allowlist"])?);
    if !before.iter().any(|entry| entry == category) {
        bail!(
            "no persistent approval category {category:?} is configured; \
             run `project approvals show` to list what exists"
        );
    }
    let after: Vec<String> = before
        .into_iter()
        .filter(|entry| entry != category)
        .collect();

    if after.is_empty() {
        // Removing the last entry is exactly what the supported CLI does best.
        cli.run(&["config", "unset", "command_allowlist"])?;
        return Ok(after);
    }

    rewrite_allowlist(&path, &after)?;
    Ok(after)
}

/// Replace the `command_allowlist` block in place, leaving every other line
/// byte-identical.
///
/// A YAML round-trip would reformat and reorder a file Asterism does not own
/// and cannot fully model; rewriting one block keeps the blast radius to the
/// key being changed.
fn rewrite_allowlist(path: &Path, entries: &[String]) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path)
        .with_context(|| format!("cannot inspect {}", path.display()))?;
    // A symlink here would let a compromised target redirect the write to a
    // file chosen by whoever created the link.
    if metadata.file_type().is_symlink() {
        bail!(
            "{} is a symlink; refusing to write through it",
            path.display()
        );
    }
    if !metadata.file_type().is_file() {
        bail!("{} is not a regular file", path.display());
    }

    let original =
        std::fs::read_to_string(path).with_context(|| format!("cannot read {}", path.display()))?;

    let mut out = String::with_capacity(original.len());
    let mut lines = original.lines().peekable();
    let mut replaced = false;
    while let Some(line) = lines.next() {
        if line.trim_start().starts_with("command_allowlist:") && !replaced {
            out.push_str("command_allowlist:\n");
            for entry in entries {
                out.push_str(&format!("- {entry}\n"));
            }
            // Drop the old sequence items that followed the key.
            while let Some(next) = lines.peek() {
                if next.trim_start().starts_with("- ") {
                    lines.next();
                } else {
                    break;
                }
            }
            replaced = true;
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    if !replaced {
        bail!("no command_allowlist block found in {}", path.display());
    }

    // Written beside the target and renamed, so a crash leaves the original
    // intact rather than a half-written policy.
    let temp = path.with_extension("asterism-tmp");
    std::fs::write(&temp, &out).with_context(|| format!("cannot write {}", temp.display()))?;
    std::fs::set_permissions(
        &temp,
        std::fs::Permissions::from_mode(metadata.permissions().mode()),
    )?;
    std::fs::rename(&temp, path).with_context(|| format!("cannot replace {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_allowlist_listing_is_parsed_into_exact_categories() {
        let output = "- script execution via heredoc\n- recursive delete\n";
        assert_eq!(
            parse_allowlist(output),
            vec!["script execution via heredoc", "recursive delete"],
        );
    }

    #[test]
    fn an_empty_listing_yields_no_categories() {
        assert!(parse_allowlist("[]\n").is_empty());
        assert!(parse_allowlist("").is_empty());
    }

    #[test]
    fn colour_codes_do_not_become_part_of_a_category() {
        let output = "\u{1b}[32m- recursive delete\u{1b}[0m\n";
        assert_eq!(parse_allowlist(output), vec!["recursive delete"]);
    }

    fn config_fixture(dir: &Path, allowlist: &[&str]) -> PathBuf {
        let mut text = String::from(
            "model:\n  provider: openai-codex\napprovals:\n  mode: manual\ncommand_allowlist:\n",
        );
        for entry in allowlist {
            text.push_str(&format!("- {entry}\n"));
        }
        text.push_str("_config_version: 34\napi_server:\n  port: 18642\n");
        let path = dir.join("config.yaml");
        std::fs::write(&path, text).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        path
    }

    #[test]
    fn rewriting_removes_only_the_named_category() {
        let dir = tempfile::tempdir().unwrap();
        let path = config_fixture(dir.path(), &["heredoc", "recursive delete", "flags"]);
        rewrite_allowlist(&path, &["heredoc".into(), "flags".into()]).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("- heredoc"));
        assert!(text.contains("- flags"));
        assert!(!text.contains("recursive delete"));
    }

    #[test]
    fn unrelated_configuration_survives_a_rewrite() {
        let dir = tempfile::tempdir().unwrap();
        let path = config_fixture(dir.path(), &["a", "b"]);
        rewrite_allowlist(&path, &["a".into()]).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        for expected in [
            "provider: openai-codex",
            "mode: manual",
            "_config_version: 34",
            "port: 18642",
        ] {
            assert!(text.contains(expected), "{expected} was lost");
        }
    }

    #[test]
    fn the_file_mode_is_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let path = config_fixture(dir.path(), &["a", "b"]);
        rewrite_allowlist(&path, &["a".into()]).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "a policy file must not become more readable");
    }

    #[test]
    fn a_symlinked_config_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let real = config_fixture(dir.path(), &["a"]);
        let link = dir.path().join("linked.yaml");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let error = rewrite_allowlist(&link, &[]).unwrap_err().to_string();
        assert!(error.contains("symlink"), "got {error}");
        // The target must be untouched by the refusal.
        assert!(std::fs::read_to_string(&real).unwrap().contains("- a"));
    }

    #[test]
    fn a_config_without_the_block_fails_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        std::fs::write(&path, "model:\n  provider: openai-codex\n").unwrap();
        let before = std::fs::read_to_string(&path).unwrap();
        assert!(rewrite_allowlist(&path, &["x".into()]).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    #[test]
    fn a_missing_config_fails_rather_than_creating_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("absent.yaml");
        assert!(rewrite_allowlist(&path, &["x".into()]).is_err());
        assert!(!path.exists(), "a policy file must never be conjured");
    }

    #[test]
    fn an_unknown_runtime_reports_policy_state_as_unavailable() {
        let policy = show(None, "demo", "external");
        assert_eq!(policy.state, "unavailable");
        assert_eq!(policy.source, PolicySource::ExternalUnmanaged);
        assert_eq!(policy.persistent_allowlist_count, 0);
        assert!(policy.approvals_mode.is_none());
        assert!(
            policy
                .unavailable_reason
                .unwrap()
                .contains("will not be guessed"),
            "the report must say why, not just that",
        );
    }

    #[test]
    fn metadata_without_hermes_paths_yields_no_cli() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("install-metadata.json");
        std::fs::write(&path, r#"{"project_id":"demo","workspace":"/srv/x"}"#).unwrap();
        assert!(HermesCli::from_metadata(&path).is_none());
    }

    #[test]
    fn metadata_pointing_at_a_missing_binary_yields_no_cli() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("install-metadata.json");
        std::fs::write(
            &path,
            r#"{"hermes_cli":"/nonexistent/hermes","hermes_home":"/nonexistent"}"#,
        )
        .unwrap();
        assert!(HermesCli::from_metadata(&path).is_none());
    }
}

/// Strip "always" from the choices an approval request offers.
///
/// Filtered where the event is journalled, so every surface downstream — the
/// local API, the Control Plane, the browser — sees the same supported set and
/// a replayed approval card cannot resurrect the option.
pub fn supported_choices(raw: Option<&serde_json::Value>) -> Option<serde_json::Value> {
    let list = raw?.as_array()?;
    let kept: Vec<serde_json::Value> = list
        .iter()
        .filter(|choice| choice.as_str() != Some("always"))
        .cloned()
        .collect();
    Some(serde_json::Value::Array(kept))
}

#[cfg(test)]
mod choice_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn always_is_removed_from_the_offered_choices() {
        let raw = json!(["once", "session", "always", "deny"]);
        assert_eq!(
            supported_choices(Some(&raw)).unwrap(),
            json!(["once", "session", "deny"]),
        );
    }

    #[test]
    fn the_remaining_choices_keep_their_order_and_meaning() {
        let raw = json!(["deny", "once"]);
        assert_eq!(
            supported_choices(Some(&raw)).unwrap(),
            json!(["deny", "once"])
        );
    }

    #[test]
    fn a_request_offering_only_always_is_left_with_nothing_rather_than_a_substitute() {
        // Silently inserting "once" here would grant something Hermes never
        // offered for this command.
        let raw = json!(["always"]);
        assert_eq!(supported_choices(Some(&raw)).unwrap(), json!([]));
    }

    #[test]
    fn absent_choices_stay_absent() {
        assert!(supported_choices(None).is_none());
        assert!(supported_choices(Some(&json!("not-a-list"))).is_none());
    }
}
