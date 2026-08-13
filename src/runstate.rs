//! Run lifecycle states owned by Asterism Node.
//!
//! Hermes' own run registry is in-memory and disappears when the project
//! container restarts (proven in Phase A and Phase B). Asterism Node therefore
//! keeps its own state machine, and this module is its single source of truth
//! for which transitions are legal.
//!
//! Terminal states are immutable: once a run is `completed`, `failed`,
//! `cancelled`, `interrupted`, or `lost`, only recovery metadata may be
//! attached, never a new status. The one exception is a
//! terminal-to-identical-terminal no-op, which keeps operations such as
//! repeated cancellation idempotent.
//!
//! # Phase E correction
//!
//! Phase D used `interrupted` for two different things: "we lost our observer
//! but the run may still be alive" and "execution continuity is definitively
//! gone". That ambiguity left runs parked in a non-terminal state that nothing
//! would ever resolve.
//!
//! The states are now split:
//!
//! * [`RunStatus::Recovering`] — **non-terminal**. Asterism is reconnecting to a
//!   backend run whose final state is not yet known.
//! * [`RunStatus::Interrupted`] — **terminal**. Execution continuity was
//!   definitively lost, typically because the container restarted underneath a
//!   live run.
//! * [`RunStatus::Lost`] — **terminal**. The backend cannot find the run and its
//!   outcome cannot be determined.
//!
//! A permanently unactionable run is never left non-terminal. Recovery from a
//! terminal `interrupted` or `lost` run happens through an explicit retry, which
//! creates a *new* run linked by `retry_of_run_id` — the original is never
//! silently resubmitted.

use std::fmt;

use anyhow::{Result, bail};

/// Externally visible lifecycle status of a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RunStatus {
    /// Durable record exists; nothing has been submitted to Hermes yet.
    Created,
    /// The single-flight slot is held and submission is in flight.
    Starting,
    /// Hermes accepted the run and is executing it.
    Running,
    /// Hermes emitted `approval.request` and is blocked on a decision.
    WaitingForApproval,
    /// Asterism is reconnecting to a backend run whose outcome is not yet
    /// known — after a daemon restart, for example. Non-terminal by design.
    Recovering,
    Completed,
    Failed,
    Cancelled,
    /// Terminal: execution continuity was definitively lost. The task may or
    /// may not have had an effect; Asterism cannot tell and will not guess.
    Interrupted,
    /// Terminal: the backend cannot find the run and its outcome cannot be
    /// determined.
    Lost,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::WaitingForApproval => "waiting_for_approval",
            Self::Recovering => "recovering",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
            Self::Lost => "lost",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        Ok(match value {
            "created" => Self::Created,
            "starting" => Self::Starting,
            "running" => Self::Running,
            "waiting_for_approval" => Self::WaitingForApproval,
            "recovering" => Self::Recovering,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            "interrupted" => Self::Interrupted,
            "lost" => Self::Lost,
            other => bail!("unknown run status {other:?}"),
        })
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Cancelled | Self::Interrupted | Self::Lost
        )
    }

    pub fn is_active(self) -> bool {
        !self.is_terminal()
    }

    /// Whether an explicit retry may create a replacement run.
    ///
    /// Only outcomes Asterism could not determine are retryable. A run that
    /// genuinely completed, failed, or was cancelled has a real result, and
    /// re-running it is a new decision the caller must express as a new run.
    pub fn is_retryable(self) -> bool {
        matches!(self, Self::Interrupted | Self::Lost)
    }
}

impl fmt::Display for RunStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A rejected state change, reported instead of silently corrupting a record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidTransition {
    pub from: RunStatus,
    pub to: RunStatus,
}

impl fmt::Display for InvalidTransition {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid run transition {} -> {}", self.from, self.to)
    }
}

impl std::error::Error for InvalidTransition {}

/// Decide whether a status change is allowed.
pub fn validate_transition(from: RunStatus, to: RunStatus) -> Result<(), InvalidTransition> {
    use RunStatus::*;

    // Idempotent no-op. Keeps repeated cancellation and repeated reconciliation
    // from corrupting an already-settled record.
    if from == to {
        return Ok(());
    }

    // Terminal records never change status again.
    if from.is_terminal() {
        return Err(InvalidTransition { from, to });
    }

    let terminal =
        |to: RunStatus| matches!(to, Completed | Failed | Cancelled | Interrupted | Lost);

    let allowed = match from {
        Created => matches!(to, Starting | Failed | Cancelled | Lost),
        Starting => matches!(to, Running | Recovering) || terminal(to),
        Running => matches!(to, WaitingForApproval | Recovering) || terminal(to),
        WaitingForApproval => matches!(to, Running | Recovering) || terminal(to),
        // A daemon restart parks a run here while it reconnects. It leaves
        // either back into live execution or into a terminal state — it is
        // never a resting place.
        Recovering => matches!(to, Running | WaitingForApproval) || terminal(to),
        Completed | Failed | Cancelled | Interrupted | Lost => false,
    };

    if allowed {
        Ok(())
    } else {
        Err(InvalidTransition { from, to })
    }
}

/// Map a Hermes-reported status onto the Asterism state machine.
///
/// Hermes statuses observed in Phase A/B: `started`, `queued`, `running`,
/// `waiting_for_approval`, `stopping`, `completed`, `failed`, `cancelled`.
/// Anything unrecognised is treated as still running rather than invented as a
/// terminal result — Asterism must never fabricate an outcome.
pub fn from_hermes_status(status: &str) -> RunStatus {
    match status {
        "completed" => RunStatus::Completed,
        "failed" => RunStatus::Failed,
        "cancelled" => RunStatus::Cancelled,
        "waiting_for_approval" => RunStatus::WaitingForApproval,
        _ => RunStatus::Running,
    }
}

#[cfg(test)]
mod tests {
    use super::RunStatus::*;
    use super::*;

    const ALL: [RunStatus; 10] = [
        Created,
        Starting,
        Running,
        WaitingForApproval,
        Recovering,
        Completed,
        Failed,
        Cancelled,
        Interrupted,
        Lost,
    ];

    #[test]
    fn status_round_trips_through_its_string_form() {
        for status in ALL {
            assert_eq!(RunStatus::parse(status.as_str()).unwrap(), status);
        }
        assert!(RunStatus::parse("nonsense").is_err());
    }

    #[test]
    fn accepts_the_normal_lifecycle() {
        assert!(validate_transition(Created, Starting).is_ok());
        assert!(validate_transition(Starting, Running).is_ok());
        assert!(validate_transition(Running, WaitingForApproval).is_ok());
        assert!(validate_transition(WaitingForApproval, Running).is_ok());
        assert!(validate_transition(Running, Completed).is_ok());
    }

    #[test]
    fn rejects_backwards_transitions() {
        assert!(validate_transition(Running, Created).is_err());
        assert!(validate_transition(Running, Starting).is_err());
        assert!(validate_transition(Starting, Created).is_err());
        assert!(validate_transition(Recovering, Created).is_err());
        assert!(validate_transition(Recovering, Starting).is_err());
    }

    #[test]
    fn the_terminal_set_is_exactly_the_documented_five() {
        for status in ALL {
            let expected = matches!(status, Completed | Failed | Cancelled | Interrupted | Lost);
            assert_eq!(
                status.is_terminal(),
                expected,
                "{status} terminal classification"
            );
            assert_eq!(status.is_active(), !expected);
        }
    }

    #[test]
    fn terminal_states_are_immutable() {
        for terminal in [Completed, Failed, Cancelled, Interrupted, Lost] {
            for target in ALL {
                if target == terminal {
                    continue;
                }
                assert!(
                    validate_transition(terminal, target).is_err(),
                    "{terminal} -> {target} must be rejected"
                );
            }
        }
    }

    #[test]
    fn identical_status_is_an_idempotent_no_op() {
        for status in ALL {
            assert!(validate_transition(status, status).is_ok());
        }
    }

    #[test]
    fn recovering_is_non_terminal_and_always_has_a_way_out() {
        assert!(!Recovering.is_terminal());
        // Reconnection either resumes live execution ...
        assert!(validate_transition(Recovering, Running).is_ok());
        assert!(validate_transition(Recovering, WaitingForApproval).is_ok());
        // ... or settles the run for good.
        for terminal in [Completed, Failed, Cancelled, Interrupted, Lost] {
            assert!(
                validate_transition(Recovering, terminal).is_ok(),
                "recovering -> {terminal} must be reachable"
            );
        }
    }

    #[test]
    fn live_states_can_enter_recovery_after_a_daemon_restart() {
        for from in [Starting, Running, WaitingForApproval] {
            assert!(
                validate_transition(from, Recovering).is_ok(),
                "{from} -> recovering must be allowed"
            );
        }
        // A run that was never submitted has nothing to reconnect to.
        assert!(validate_transition(Created, Recovering).is_err());
    }

    #[test]
    fn interrupted_and_lost_are_terminal_not_resting_places() {
        // The Phase D model let these transition onwards; they no longer can,
        // which is what stops a run from being parked forever.
        assert!(Interrupted.is_terminal());
        assert!(Lost.is_terminal());
        assert!(validate_transition(Interrupted, Running).is_err());
        assert!(validate_transition(Lost, Running).is_err());
        assert!(validate_transition(Interrupted, Completed).is_err());
    }

    #[test]
    fn only_undetermined_outcomes_are_retryable() {
        for status in ALL {
            let expected = matches!(status, Interrupted | Lost);
            assert_eq!(
                status.is_retryable(),
                expected,
                "{status} retry classification"
            );
        }
    }

    #[test]
    fn a_created_run_can_be_abandoned_without_ever_starting() {
        assert!(validate_transition(Created, Failed).is_ok());
        assert!(validate_transition(Created, Cancelled).is_ok());
        assert!(validate_transition(Created, Lost).is_ok());
        assert!(validate_transition(Created, Running).is_err());
    }

    #[test]
    fn unknown_hermes_statuses_never_become_a_terminal_result() {
        assert_eq!(from_hermes_status("completed"), Completed);
        assert_eq!(from_hermes_status("failed"), Failed);
        assert_eq!(from_hermes_status("cancelled"), Cancelled);
        assert_eq!(
            from_hermes_status("waiting_for_approval"),
            WaitingForApproval
        );
        for unknown in ["started", "queued", "stopping", "something-new", ""] {
            assert_eq!(from_hermes_status(unknown), Running);
        }
    }
}
