//! Approval policy for exactly one run.
//!
//! An operator running a long task does not want to answer the same approval
//! twenty times. Hermes' own answer to that is "always", which writes a
//! permanent category rule into its configuration and silences approvals for
//! every future run on that host — Asterism refuses it for exactly that reason.
//!
//! This is the narrow version of the same wish: stop asking *for this run*. The
//! policy lives on the run row, so it cannot outlive the run, cannot be
//! inherited by a retry, and cannot become a session or project default —
//! there is nowhere else for it to be stored.
//!
//! What it does **not** do: it approves the approval requests Hermes emits. It
//! does not bypass filesystem permissions, sudo policy, Docker restrictions, or
//! anything Hermes refuses without asking.

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

/// How approval requests from one run are answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RunApprovalPolicy {
    /// Every request waits for an operator decision. The default for every run.
    #[default]
    Manual,
    /// Every request from this one run is resolved automatically with `once`.
    AllowAllForRun,
}

impl RunApprovalPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::AllowAllForRun => "allow_all_for_run",
        }
    }

    /// Parse a stored or wire value.
    ///
    /// An unrecognised value is an error rather than a silent fallback: falling
    /// back to `manual` would hide a corrupt row, and falling back the other way
    /// would auto-approve on the strength of a typo.
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "manual" => Ok(Self::Manual),
            "allow_all_for_run" => Ok(Self::AllowAllForRun),
            other => bail!(
                "unknown run approval policy {other:?}; expected \"manual\" or \
                 \"allow_all_for_run\""
            ),
        }
    }

    pub fn bypasses_approval(self) -> bool {
        matches!(self, Self::AllowAllForRun)
    }
}

/// The policy on one run, with who set it and when.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RunPolicyState {
    pub policy: RunApprovalPolicy,
    /// Operator identity, never a token. Absent while the run is `manual`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
}

impl Default for RunPolicyState {
    fn default() -> Self {
        Self {
            policy: RunApprovalPolicy::Manual,
            enabled_by: None,
            enabled_at: None,
            updated_at: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_policy_is_manual() {
        assert_eq!(RunApprovalPolicy::default(), RunApprovalPolicy::Manual);
        assert!(!RunApprovalPolicy::default().bypasses_approval());
    }

    #[test]
    fn both_policies_round_trip_through_their_stored_form() {
        for policy in [RunApprovalPolicy::Manual, RunApprovalPolicy::AllowAllForRun] {
            assert_eq!(RunApprovalPolicy::parse(policy.as_str()).unwrap(), policy);
        }
    }

    #[test]
    fn only_the_run_scoped_policy_bypasses_approval() {
        assert!(RunApprovalPolicy::AllowAllForRun.bypasses_approval());
        assert!(!RunApprovalPolicy::Manual.bypasses_approval());
    }

    #[test]
    fn an_unknown_policy_fails_rather_than_guessing() {
        // Guessing either way is wrong: `manual` would hide a corrupt row, and
        // `allow_all_for_run` would auto-approve on the strength of a typo.
        for value in ["always", "allow_all", "ALLOW_ALL_FOR_RUN", "", "session"] {
            let error = RunApprovalPolicy::parse(value).unwrap_err().to_string();
            assert!(
                error.contains("unknown run approval policy"),
                "{value}: {error}"
            );
        }
    }

    #[test]
    fn the_persistent_hermes_choice_is_not_a_policy_name() {
        // "always" is the Hermes answer Asterism refuses; it must never be
        // accepted here under a different coat.
        assert!(RunApprovalPolicy::parse("always").is_err());
    }

    #[test]
    fn a_fresh_policy_state_names_nobody() {
        let state = RunPolicyState::default();
        assert_eq!(state.policy, RunApprovalPolicy::Manual);
        assert!(state.enabled_by.is_none());
        assert!(state.enabled_at.is_none());
    }
}
