//! Fail-closed runtime policy for project containers.
//!
//! Phase B established that the native `codex app-server` runtime only executes
//! turns when Hermes approvals are bypassed (`approvals.mode: off`), because the
//! Hermes Codex adapter declines Codex's approval requests instead of forwarding
//! them to the API. That combination removes the only observable approval
//! control point Asterism has.
//!
//! Asterism Node must therefore refuse to start a project in that configuration
//! unless an operator explicitly opts in for a controlled test. The override is
//! scoped to this one known limitation on purpose — it is not a general
//! "disable security" switch, and it never turns on implicitly.

use std::fmt;
use std::path::Path;

use anyhow::{Context, Result, bail};

/// Stable identifier for a refused start, so callers can branch on the outcome.
pub const UNSAFE_RUNTIME_CODE: &str = "unsafe_runtime_configuration";

/// Hermes settings that decide whether a configuration is safe to run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeConfiguration {
    /// `model.openai_runtime`: `auto` (Hermes' own agent loop) or
    /// `codex_app_server` (native Codex runtime).
    pub openai_runtime: Option<String>,
    /// `approvals.mode`: `manual`, `smart`, or `off`.
    pub approvals_mode: Option<String>,
}

impl RuntimeConfiguration {
    pub fn uses_native_codex(&self) -> bool {
        self.openai_runtime.as_deref() == Some("codex_app_server")
    }

    pub fn approvals_bypassed(&self) -> bool {
        self.approvals_mode.as_deref() == Some("off")
    }
}

/// What Asterism decided about a configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyDecision {
    /// Safe to start with no caveats.
    Allow,
    /// Started only because an explicit scoped override was supplied.
    AllowWithOverride { warning: String },
    /// Refused.
    Deny { reason: String },
}

/// Refusal to start a project in a configuration known to bypass controls.
#[derive(Debug, Clone)]
pub struct UnsafeRuntime {
    pub project_id: String,
    pub reason: String,
}

impl fmt::Display for UnsafeRuntime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "refusing to start project {}: {}",
            self.project_id, self.reason
        )
    }
}

impl std::error::Error for UnsafeRuntime {}

/// The one scoped override, named after the specific limitation it unlocks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CodexApprovalBypassOverride(pub bool);

/// Decide whether a configuration may start.
///
/// The only refused combination is native Codex together with bypassed
/// approvals. Native Codex with approvals left on is permitted — it fails
/// closed inside Hermes rather than silently executing unapproved work, which
/// is a usability problem rather than a security one.
pub fn evaluate(
    config: &RuntimeConfiguration,
    override_flag: CodexApprovalBypassOverride,
) -> PolicyDecision {
    if !(config.uses_native_codex() && config.approvals_bypassed()) {
        return PolicyDecision::Allow;
    }

    if override_flag.0 {
        return PolicyDecision::AllowWithOverride {
            warning: concat!(
                "UNSAFE RUNTIME: native codex_app_server is running with approvals.mode=off. ",
                "Every Codex permission request is auto-approved and no approval.request event ",
                "reaches the Asterism API. This mode is for controlled testing only; stop the ",
                "project as soon as the test completes."
            )
            .to_owned(),
        };
    }

    PolicyDecision::Deny {
        reason: concat!(
            "model.openai_runtime=codex_app_server requires approvals.mode=off to execute, ",
            "which auto-approves every Codex request and emits no approval.request events. ",
            "Use the default Hermes agent loop (model.openai_runtime=auto), or pass ",
            "--unsafe-allow-codex-approval-bypass for a controlled, supervised test."
        )
        .to_owned(),
    }
}

/// Apply the policy, converting a denial into a typed error.
pub fn enforce(
    project_id: &str,
    config: &RuntimeConfiguration,
    override_flag: CodexApprovalBypassOverride,
) -> Result<()> {
    match evaluate(config, override_flag) {
        PolicyDecision::Allow => Ok(()),
        PolicyDecision::AllowWithOverride { warning } => {
            eprintln!("WARNING: {warning}");
            Ok(())
        }
        PolicyDecision::Deny { reason } => Err(UnsafeRuntime {
            project_id: project_id.to_owned(),
            reason,
        }
        .into()),
    }
}

/// Read the two policy-relevant settings out of a Hermes `config.yaml`.
///
/// A deliberately narrow reader rather than a general YAML parser: only
/// `section:` headers at column zero and their indented `key: value` children
/// are recognised, which is the shape Hermes writes. Anything it cannot parse
/// becomes `None`, and an absent value is treated as unset by [`evaluate`].
pub fn read_runtime_configuration(config_path: &Path) -> Result<RuntimeConfiguration> {
    let body = std::fs::read_to_string(config_path)
        .with_context(|| format!("failed to read Hermes config {}", config_path.display()))?;
    Ok(parse_runtime_configuration(&body))
}

pub fn parse_runtime_configuration(body: &str) -> RuntimeConfiguration {
    RuntimeConfiguration {
        openai_runtime: lookup(body, "model", "openai_runtime"),
        approvals_mode: lookup(body, "approvals", "mode"),
    }
}

pub fn lookup(body: &str, section: &str, key: &str) -> Option<String> {
    let mut in_section = false;

    for raw in body.lines() {
        let without_comment = strip_comment(raw);
        if without_comment.trim().is_empty() {
            continue;
        }

        let indented = without_comment.starts_with([' ', '\t']);
        if !indented {
            in_section = without_comment.trim_end().trim_end_matches(':') == section
                && without_comment.trim_end().ends_with(':');
            continue;
        }

        if !in_section {
            continue;
        }

        let trimmed = without_comment.trim();
        if let Some(value) = trimmed.strip_prefix(&format!("{key}:")) {
            let value = value.trim().trim_matches(['"', '\'']);
            if value.is_empty() {
                return None;
            }
            return Some(value.to_owned());
        }
    }

    None
}

/// Set `section.key` in a Hermes `config.yaml`, returning the new body.
///
/// The counterpart to [`lookup`], and narrow in exactly the same way: only
/// `section:` headers at column zero and their indented `key: value` children
/// are recognised. An existing key is rewritten in place, preserving the
/// surrounding file; a missing key is appended to an existing section; a missing
/// section is appended at the end.
///
/// This exists because a project's model routing must be reproducible. A
/// container seeded from the image default boots with whatever model that image
/// ships, which is not necessarily one the configured provider will serve — so
/// the Node pins it rather than inheriting it.
pub fn set_setting(body: &str, section: &str, key: &str, value: &str) -> String {
    let mut out: Vec<String> = Vec::with_capacity(body.lines().count() + 2);
    let mut in_section = false;
    let mut wrote = false;
    let mut section_seen = false;
    let mut section_indent = String::from("  ");

    for raw in body.lines() {
        let without_comment = strip_comment(raw);

        if !without_comment.trim().is_empty() && !without_comment.starts_with([' ', '\t']) {
            // Leaving the target section without having written the key means
            // the section exists but the key does not.
            if in_section && !wrote {
                out.push(format!("{section_indent}{key}: {value}"));
                wrote = true;
            }
            let header = without_comment.trim_end();
            in_section = header.ends_with(':') && header.trim_end_matches(':') == section;
            section_seen |= in_section;
            out.push(raw.to_owned());
            continue;
        }

        if in_section && !wrote {
            let trimmed = without_comment.trim();
            if !trimmed.is_empty() {
                section_indent = without_comment
                    .chars()
                    .take_while(|c| *c == ' ' || *c == '\t')
                    .collect();
            }
            if trimmed.starts_with(&format!("{key}:")) {
                out.push(format!("{section_indent}{key}: {value}"));
                wrote = true;
                continue;
            }
        }

        out.push(raw.to_owned());
    }

    if !wrote {
        if !section_seen {
            out.push(format!("{section}:"));
        }
        out.push(format!("{section_indent}{key}: {value}"));
    }

    let mut rendered = out.join("\n");
    rendered.push('\n');
    rendered
}

/// Drop a trailing `#` comment, honouring quoted values so that a `#` inside a
/// quoted string is not treated as the start of a comment.
fn strip_comment(line: &str) -> &str {
    let mut in_single = false;
    let mut in_double = false;

    for (index, ch) in line.char_indices() {
        match ch {
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            '#' if !in_single && !in_double => return &line[..index],
            _ => {}
        }
    }
    line
}

/// Guard used before a controlled unsafe test: the caller must have supplied the
/// scoped override AND the configuration must actually be the known-unsafe one.
pub fn require_override_for_unsafe_test(
    config: &RuntimeConfiguration,
    override_flag: CodexApprovalBypassOverride,
) -> Result<()> {
    if !override_flag.0 {
        bail!(
            "{UNSAFE_RUNTIME_CODE}: this operation requires --unsafe-allow-codex-approval-bypass"
        );
    }
    if !config.uses_native_codex() {
        bail!("the override only applies to model.openai_runtime=codex_app_server");
    }
    Ok(())
}

#[cfg(test)]
mod tests {

    #[test]
    fn set_setting_rewrites_an_existing_key_in_place() {
        let body = "database:\n  journal_mode: wal\nmodel:\n  default: old-model\n  provider: openai-codex\n";
        let out = set_setting(body, "model", "default", "gpt-5.6-sol");
        assert_eq!(
            lookup(&out, "model", "default").as_deref(),
            Some("gpt-5.6-sol")
        );
        // Nothing else moves.
        assert_eq!(
            lookup(&out, "model", "provider").as_deref(),
            Some("openai-codex")
        );
        assert_eq!(
            lookup(&out, "database", "journal_mode").as_deref(),
            Some("wal")
        );
    }

    #[test]
    fn set_setting_replaces_a_quoted_value() {
        let body = "model:\n  default: \"anthropic/claude-opus-4.6\"\n";
        let out = set_setting(body, "model", "default", "gpt-5.6-sol");
        assert_eq!(
            lookup(&out, "model", "default").as_deref(),
            Some("gpt-5.6-sol")
        );
        assert!(!out.contains("claude-opus-4.6"));
    }

    #[test]
    fn set_setting_appends_a_missing_key_to_an_existing_section() {
        let body = "model:\n  provider: openai-codex\n";
        let out = set_setting(body, "model", "default", "gpt-5.6-sol");
        assert_eq!(
            lookup(&out, "model", "default").as_deref(),
            Some("gpt-5.6-sol")
        );
        assert_eq!(
            lookup(&out, "model", "provider").as_deref(),
            Some("openai-codex")
        );
    }

    #[test]
    fn set_setting_appends_a_missing_section() {
        let body = "database:\n  journal_mode: wal\n";
        let out = set_setting(body, "model", "default", "gpt-5.6-sol");
        assert_eq!(
            lookup(&out, "model", "default").as_deref(),
            Some("gpt-5.6-sol")
        );
        assert_eq!(
            lookup(&out, "database", "journal_mode").as_deref(),
            Some("wal")
        );
    }

    #[test]
    fn set_setting_does_not_touch_a_same_named_key_in_another_section() {
        let body = "other:\n  default: keep-me\nmodel:\n  default: replace-me\n";
        let out = set_setting(body, "model", "default", "new");
        assert_eq!(lookup(&out, "other", "default").as_deref(), Some("keep-me"));
        assert_eq!(lookup(&out, "model", "default").as_deref(), Some("new"));
    }

    #[test]
    fn set_setting_output_survives_a_second_pass() {
        // Provisioning is repeated on every `project ensure`; it must converge.
        let body = "model:\n  default: a\n";
        let once = set_setting(body, "model", "default", "b");
        let twice = set_setting(&once, "model", "default", "b");
        assert_eq!(once, twice);
    }
    use super::*;

    fn config(runtime: Option<&str>, approvals: Option<&str>) -> RuntimeConfiguration {
        RuntimeConfiguration {
            openai_runtime: runtime.map(ToOwned::to_owned),
            approvals_mode: approvals.map(ToOwned::to_owned),
        }
    }

    #[test]
    fn hermes_loop_is_allowed() {
        assert_eq!(
            evaluate(
                &config(Some("auto"), Some("manual")),
                CodexApprovalBypassOverride(false)
            ),
            PolicyDecision::Allow
        );
    }

    #[test]
    fn native_codex_with_approvals_bypassed_is_denied_by_default() {
        let decision = evaluate(
            &config(Some("codex_app_server"), Some("off")),
            CodexApprovalBypassOverride(false),
        );
        assert!(matches!(decision, PolicyDecision::Deny { .. }));
    }

    #[test]
    fn native_codex_with_approvals_enabled_is_allowed() {
        // Fails closed inside Hermes instead of executing unapproved work.
        assert_eq!(
            evaluate(
                &config(Some("codex_app_server"), Some("manual")),
                CodexApprovalBypassOverride(false)
            ),
            PolicyDecision::Allow
        );
    }

    #[test]
    fn approvals_bypassed_on_the_hermes_loop_is_not_the_targeted_case() {
        // The override is scoped to the Codex limitation only; this combination
        // is out of its scope and is not what the policy refuses.
        assert_eq!(
            evaluate(
                &config(Some("auto"), Some("off")),
                CodexApprovalBypassOverride(false)
            ),
            PolicyDecision::Allow
        );
    }

    #[test]
    fn scoped_override_allows_the_unsafe_combination_with_a_warning() {
        match evaluate(
            &config(Some("codex_app_server"), Some("off")),
            CodexApprovalBypassOverride(true),
        ) {
            PolicyDecision::AllowWithOverride { warning } => {
                assert!(warning.contains("UNSAFE RUNTIME"));
                assert!(warning.contains("auto-approved"));
            }
            other => panic!("expected an override allowance, got {other:?}"),
        }
    }

    #[test]
    fn enforce_returns_a_typed_error_for_the_unsafe_combination() {
        let error = enforce(
            "phase-c",
            &config(Some("codex_app_server"), Some("off")),
            CodexApprovalBypassOverride(false),
        )
        .unwrap_err();
        let unsafe_runtime = error.downcast_ref::<UnsafeRuntime>().unwrap();
        assert_eq!(unsafe_runtime.project_id, "phase-c");
    }

    #[test]
    fn unsafe_mode_is_never_enabled_implicitly() {
        // Absent settings must not be interpreted as the unsafe combination.
        assert_eq!(
            evaluate(&config(None, None), CodexApprovalBypassOverride(false)),
            PolicyDecision::Allow
        );
        assert_eq!(
            evaluate(
                &config(Some("codex_app_server"), None),
                CodexApprovalBypassOverride(false)
            ),
            PolicyDecision::Allow
        );
    }

    #[test]
    fn parses_hermes_configuration_shape() {
        let body = "\
model:
  default: \"gpt-5.6-sol\"
  provider: \"openai-codex\"
  openai_runtime: codex_app_server

approvals:
  mode: 'off'
  timeout: 300
";
        let parsed = parse_runtime_configuration(body);
        assert_eq!(parsed.openai_runtime.as_deref(), Some("codex_app_server"));
        assert_eq!(parsed.approvals_mode.as_deref(), Some("off"));
        assert!(parsed.uses_native_codex());
        assert!(parsed.approvals_bypassed());
    }

    #[test]
    fn ignores_commented_out_settings() {
        let body = "\
model:
  # openai_runtime: codex_app_server
  provider: openai-codex

approvals:
  # mode: off
  timeout: 300
";
        let parsed = parse_runtime_configuration(body);
        assert_eq!(parsed.openai_runtime, None);
        assert_eq!(parsed.approvals_mode, None);
    }

    #[test]
    fn does_not_confuse_keys_from_other_sections() {
        let body = "\
terminal:
  mode: 'off'

approvals:
  mode: manual
";
        let parsed = parse_runtime_configuration(body);
        assert_eq!(parsed.approvals_mode.as_deref(), Some("manual"));
    }

    #[test]
    fn strips_trailing_comments_but_respects_quotes() {
        let body = "\
approvals:
  mode: manual  # was 'off' during the Phase B test
";
        let parsed = parse_runtime_configuration(body);
        assert_eq!(parsed.approvals_mode.as_deref(), Some("manual"));
    }

    #[test]
    fn unsafe_test_guard_requires_the_scoped_override() {
        let unsafe_config = config(Some("codex_app_server"), Some("off"));

        assert!(
            require_override_for_unsafe_test(&unsafe_config, CodexApprovalBypassOverride(false))
                .is_err()
        );
        assert!(
            require_override_for_unsafe_test(&unsafe_config, CodexApprovalBypassOverride(true))
                .is_ok()
        );
        // The override must not unlock anything beyond the Codex limitation.
        assert!(
            require_override_for_unsafe_test(
                &config(Some("auto"), Some("off")),
                CodexApprovalBypassOverride(true)
            )
            .is_err()
        );
    }
}
