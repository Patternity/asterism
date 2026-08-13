//! Run execution against Hermes, journalled into the Node-owned registry.
//!
//! # Worker ownership
//!
//! The client cannot be the thing that keeps a run observable. Phase B showed
//! that when the client goes away mid-run, the SSE stream is simply lost and the
//! run outcome becomes unrecoverable.
//!
//! Phase D solved that with a detached worker process per run. Phase E moves
//! ownership into the persistent daemon: [`execute_run`] now runs as a task
//! inside `node serve`, which owns the single-flight lock, consumes the Hermes
//! stream, and writes every event to the journal. A CLI or SSE client
//! disconnecting has no effect on it, and there is exactly one authority over
//! active runs instead of a process per run.
//!
//! This is durable **metadata and event capture**. It is not durable execution:
//! if the project container restarts mid-run, Hermes loses the run itself, and
//! reconciliation records that honestly rather than inventing an outcome.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde_json::{Value, json};

use crate::hermes::HermesClient;
use crate::hermes::StartRunRequest;
use crate::registry::{
    JournalEvent, Registry, RunRecord, RunUpdate, SOURCE_ASTERISM, SOURCE_HERMES, fingerprint_value,
};
use crate::runlock::{
    ActiveRun, ProjectState, RunConflict, classify_recorded_run, conflict_from_decision,
};
use crate::runstate::{RunStatus, from_hermes_status};
use crate::sse::SseEvent;

/// Error code stored when the single-flight slot was already taken.
pub const ERROR_RUN_CONFLICT: &str = "run_conflict";
/// Error code stored when Hermes refused or failed the submission.
pub const ERROR_SUBMISSION_FAILED: &str = "submission_failed";
/// Error code stored when the event stream broke before a terminal result.
pub const ERROR_STREAM_BROKEN: &str = "stream_broken";

/// Pause between SSE reconnect attempts while Hermes still reports the run live.
const STREAM_RESUME_DELAY: std::time::Duration = std::time::Duration::from_secs(1);

/// How long a run may produce no new events, while Hermes still calls it
/// active, before the worker stops waiting and records `interrupted`.
///
/// Must comfortably exceed the Hermes approval timeout (300s by default), since
/// a run parked on an approval legitimately emits nothing until a decision
/// arrives.
const STREAM_IDLE_BUDGET: std::time::Duration = std::time::Duration::from_secs(900);

/// Synthetic event types Asterism appends itself.
pub const EVENT_RUN_ACCEPTED: &str = "asterism.run.accepted";
pub const EVENT_RUN_SUBMITTED: &str = "asterism.run.submitted";
/// A new worker re-attached to a run Hermes was still executing.
pub const EVENT_RUN_RESUMED: &str = "asterism.run.resumed";
pub const EVENT_RUN_TERMINAL: &str = "asterism.run.terminal";
pub const EVENT_CANCEL_REQUESTED: &str = "asterism.cancel.requested";
pub const EVENT_APPROVAL_DECISION: &str = "asterism.approval.decision";
pub const EVENT_RECONCILED: &str = "asterism.reconciled";
/// A run was parked in `recovering` while the node reconnected to its backend.
pub const EVENT_RECOVERING: &str = "asterism.run.recovering";
/// Appended to the original run when a retry replaces it.
pub const EVENT_RETRY_CREATED: &str = "asterism.retry.created";
/// Appended to the replacement run, naming the run it retries.
pub const EVENT_RETRY_OF: &str = "asterism.retry.of";

/// A Hermes SSE event mapped onto the journal's shape.
#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedEvent {
    pub event_type: String,
    pub payload: Value,
    pub raw: Value,
    pub dedupe_key: String,
}

/// Normalize one SSE frame.
///
/// Hermes carries the event name both in the SSE `event:` field and inside the
/// JSON body; either may be absent. Frames whose body is not JSON are preserved
/// as text rather than dropped, so an unknown or malformed event can never
/// silently disappear from the journal.
pub fn normalize_event(event: &SseEvent) -> NormalizedEvent {
    let parsed = event.json_data();
    let payload = match &parsed {
        Some(value) => value.clone(),
        None => json!({ "text": event.data }),
    };

    let event_type = event
        .event
        .clone()
        .or_else(|| {
            payload
                .get("event")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| "unknown".to_owned());

    // Hermes assigns no event identifier, so identity is derived from the event
    // name, its timestamp when present, and a digest of the body. Two genuinely
    // identical frames collapse; two distinct deltas do not.
    let timestamp = payload
        .get("timestamp")
        .map(|value| value.to_string())
        .unwrap_or_default();
    let dedupe_key = format!("{event_type}:{timestamp}:{}", fingerprint_value(&payload));

    NormalizedEvent {
        event_type,
        payload,
        raw: parsed.unwrap_or_else(|| Value::String(event.data.clone())),
        dedupe_key,
    }
}

/// Everything a worker needs to execute one run.
#[derive(Debug, Clone)]
pub struct WorkerContext {
    pub state_root: PathBuf,
    pub project_id: String,
    pub run_id: String,
    pub base_url: String,
    pub api_key: String,
    /// Wake-up bus for SSE followers. Purely a latency optimisation: SQLite
    /// remains the authoritative event source, so a dropped notification only
    /// delays delivery until the follower's next poll.
    pub notifier: Option<tokio::sync::broadcast::Sender<String>>,
}

impl WorkerContext {
    fn wake_followers(&self) {
        if let Some(notifier) = &self.notifier {
            let _ = notifier.send(self.run_id.clone());
        }
    }
}

/// Execute one run end to end, recording every step durably.
///
/// Returns the terminal record. Failures are recorded rather than propagated
/// wherever a durable, explainable state is the more useful outcome.
pub async fn execute_run(context: &WorkerContext) -> Result<RunRecord> {
    let mut registry = Registry::open(&context.state_root)?;
    let run = registry
        .run(&context.run_id)?
        .with_context(|| format!("unknown run {}", context.run_id))?;

    let state = ProjectState::new(&context.state_root, &context.project_id)?;

    // The worker owns the single-flight slot for the whole run, so the slot is
    // released by the kernel even if the worker is killed.
    let lock = match state.try_lock() {
        Ok(lock) => lock,
        Err(error) => {
            let message = error
                .downcast_ref::<RunConflict>()
                .map(ToString::to_string)
                .unwrap_or_else(|| error.to_string());
            return finalize(
                &mut registry,
                &context.run_id,
                RunStatus::Failed,
                RunUpdate::status(RunStatus::Failed)
                    .with_error(ERROR_RUN_CONFLICT, message.clone())
                    .with_terminal_reason("refused by single-flight admission"),
                json!({"error": ERROR_RUN_CONFLICT, "message": message}),
            );
        }
    };

    // A previous detached run may still be live inside Hermes.
    let client = HermesClient::new(context.base_url.clone(), context.api_key.clone())?;
    if let Some(recorded) = state.read_active_run()? {
        let backend_status = client
            .try_run_status(&recorded.run_id)
            .await?
            .and_then(|value| status_of(&value));
        let decision = classify_recorded_run(Some(&recorded), backend_status.as_deref());
        if let Some(conflict) = conflict_from_decision(&context.project_id, decision) {
            let message = conflict.to_string();
            return finalize(
                &mut registry,
                &context.run_id,
                RunStatus::Failed,
                RunUpdate::status(RunStatus::Failed)
                    .with_error(ERROR_RUN_CONFLICT, message.clone())
                    .with_terminal_reason("refused by single-flight admission"),
                json!({"error": ERROR_RUN_CONFLICT, "message": message}),
            );
        }
        lock.clear_active_run()?;
    }

    // Re-attach instead of resubmitting.
    //
    // A worker can die while Hermes keeps executing. The run then has a backend
    // id and a non-terminal status but no observer, and its events stop being
    // captured. Submitting again would run the task twice, so a worker that
    // finds an existing backend id simply resumes following it.
    let resumed = run.hermes_run_id.clone();
    if let Some(hermes_run_id) = resumed {
        registry.append_event(
            &context.run_id,
            &JournalEvent::asterism(
                EVENT_RUN_RESUMED,
                json!({
                    "hermes_run_id": hermes_run_id,
                    "resumed_from_seq": run.last_event_seq,
                }),
            ),
            None,
        )?;
        return follow_to_terminal(context, &mut registry, &client, &lock, &hermes_run_id).await;
    }

    registry.append_event(
        &context.run_id,
        &JournalEvent::asterism(
            EVENT_RUN_ACCEPTED,
            json!({"project_id": context.project_id}),
        ),
        Some(&RunUpdate::status(RunStatus::Starting)),
    )?;

    let input = run
        .request_payload
        .get("input")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let instructions = run
        .request_payload
        .get("instructions")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);

    let response = match client
        .start_run(&StartRunRequest {
            input: &input,
            session_id: run.session_id.as_deref(),
            instructions: instructions.as_deref(),
        })
        .await
    {
        Ok(response) => response,
        Err(error) => {
            let message = error.to_string();
            lock.clear_active_run()?;
            return finalize(
                &mut registry,
                &context.run_id,
                RunStatus::Failed,
                RunUpdate::status(RunStatus::Failed)
                    .with_error(ERROR_SUBMISSION_FAILED, message.clone())
                    .with_terminal_reason("Hermes rejected the submission"),
                json!({"error": ERROR_SUBMISSION_FAILED, "message": message}),
            );
        }
    };

    let hermes_run_id = response.run_id.clone();
    registry.append_event(
        &context.run_id,
        &JournalEvent::asterism(
            EVENT_RUN_SUBMITTED,
            json!({"hermes_run_id": hermes_run_id, "hermes_status": response.status}),
        ),
        Some(&RunUpdate::status(RunStatus::Running).with_hermes_run_id(hermes_run_id.clone())),
    )?;
    lock.record_active_run(&ActiveRun {
        run_id: hermes_run_id.clone(),
        session_id: run.session_id.clone(),
        started_at_unix: (crate::registry::now_millis() / 1000) as u64,
    })?;

    follow_to_terminal(context, &mut registry, &client, &lock, &hermes_run_id).await
}

/// Follow a live Hermes run to its terminal status, journalling every event.
///
/// Shared by the submit path and the re-attach path, so a resumed run is
/// observed exactly the same way as one this worker started itself.
async fn follow_to_terminal(
    context: &WorkerContext,
    registry: &mut Registry,
    client: &HermesClient,
    lock: &crate::runlock::ProjectRunLock,
    hermes_run_id: &str,
) -> Result<RunRecord> {
    // Stream, journal, and resume.
    //
    // Hermes ends the SSE stream whenever a run parks — most visibly when it
    // emits `approval.request` and waits for a decision — even though the run
    // is still very much alive. Treating the first stream end as the end of the
    // run recorded `interrupted` for runs Hermes went on to complete, so the
    // worker reconnects until Hermes reports a terminal status or forgets the
    // run entirely. Replayed frames are harmless: dedupe keys keep the journal
    // append-only and duplicate-free.
    let mut observed_status = RunStatus::Running;
    let mut last_progress = tokio::time::Instant::now();
    let mut last_seq = registry
        .run(&context.run_id)?
        .map(|record| record.last_event_seq)
        .unwrap_or_default();
    let mut last_stream_error: Option<String> = None;

    let record = loop {
        let stream_result = client
            .stream_events(hermes_run_id, |event| {
                let normalized = normalize_event(&event);
                let update = status_update_for(&normalized.event_type, observed_status);
                if let Some(status) = update {
                    observed_status = status;
                }

                let outcome = registry.append_event(
                    &context.run_id,
                    &JournalEvent {
                        event_type: normalized.event_type.clone(),
                        source: SOURCE_HERMES.to_owned(),
                        payload: normalized.payload.clone(),
                        raw: Some(normalized.raw.clone()),
                        dedupe_key: Some(normalized.dedupe_key.clone()),
                    },
                    update.map(RunUpdate::status).as_ref(),
                )?;

                context.wake_followers();

                if normalized.event_type == "approval.request" {
                    registry.record_approval_request(
                        &context.run_id,
                        outcome.seq(),
                        normalized.payload.get("command").and_then(Value::as_str),
                        normalized.payload.get("choices"),
                    )?;
                }
                Ok(())
            })
            .await;

        if let Err(error) = &stream_result {
            last_stream_error = Some(error.to_string());
        }

        // Hermes is the only authority on how the run actually ended.
        let backend = client.try_run_status(hermes_run_id).await.ok().flatten();

        let Some(value) = backend else {
            // Hermes no longer knows the run: the container restarted or its
            // in-memory registry was cleared. Never guess a result.
            let message = last_stream_error
                .clone()
                .unwrap_or_else(|| "Hermes no longer knows this run".to_owned());
            break finalize(
                registry,
                &context.run_id,
                RunStatus::Interrupted,
                RunUpdate::status(RunStatus::Interrupted)
                    .with_error(ERROR_STREAM_BROKEN, message.clone())
                    .with_terminal_reason("Hermes lost the run before a terminal status"),
                json!({"error": ERROR_STREAM_BROKEN, "message": message}),
            );
        };

        let status = status_of(&value)
            .map(|status| from_hermes_status(&status))
            .unwrap_or(RunStatus::Interrupted);

        if status.is_terminal() {
            let mut update = RunUpdate::status(status)
                .with_result(value.clone())
                .with_terminal_reason("terminal status reported by Hermes");
            if status == RunStatus::Failed
                && let Some(message) = value.get("error").and_then(Value::as_str)
            {
                update = update.with_error("hermes_run_failed", message);
            }
            break finalize(
                registry,
                &context.run_id,
                status,
                update,
                json!({"hermes_status": value.get("status")}),
            );
        }

        // Still live. Count progress so a genuinely wedged run cannot spin here
        // forever, then reconnect.
        let current_seq = registry
            .run(&context.run_id)?
            .map(|record| record.last_event_seq)
            .unwrap_or_default();
        if current_seq != last_seq {
            last_seq = current_seq;
            last_progress = tokio::time::Instant::now();
        }

        if last_progress.elapsed() >= STREAM_IDLE_BUDGET {
            let message = format!(
                "no new events for {}s while Hermes still reported the run as active",
                STREAM_IDLE_BUDGET.as_secs()
            );
            break finalize(
                registry,
                &context.run_id,
                RunStatus::Interrupted,
                RunUpdate::status(RunStatus::Interrupted)
                    .with_error(ERROR_STREAM_BROKEN, message.clone())
                    .with_terminal_reason("event stream stalled while the run was still active"),
                json!({"error": ERROR_STREAM_BROKEN, "message": message}),
            );
        }

        tokio::time::sleep(STREAM_RESUME_DELAY).await;
    };

    lock.clear_active_run()?;

    lock.clear_active_run()?;
    context.wake_followers();
    record
}

/// Which status an incoming event implies, if any.
fn status_update_for(event_type: &str, current: RunStatus) -> Option<RunStatus> {
    if event_type == "approval.request" {
        return Some(RunStatus::WaitingForApproval);
    }
    // Any other traffic means Hermes resumed work after an approval decision.
    if current == RunStatus::WaitingForApproval && !event_type.starts_with("approval.") {
        return Some(RunStatus::Running);
    }
    None
}

fn status_of(value: &Value) -> Option<String> {
    value
        .get("status")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn finalize(
    registry: &mut Registry,
    run_id: &str,
    status: RunStatus,
    update: RunUpdate,
    payload: Value,
) -> Result<RunRecord> {
    let mut payload = payload;
    if let Value::Object(map) = &mut payload {
        map.insert("status".to_owned(), json!(status.as_str()));
    }
    registry.append_event(
        run_id,
        &JournalEvent::asterism(EVENT_RUN_TERMINAL, payload),
        Some(&update),
    )?;
    registry
        .run(run_id)?
        .with_context(|| format!("run {run_id} vanished while finalizing"))
}

/// Outcome of reconciling one previously non-terminal run.
#[derive(Debug, Clone, PartialEq)]
pub struct Reconciliation {
    pub run_id: String,
    pub previous_status: String,
    pub new_status: String,
    pub note: String,
}

/// Decide what a non-terminal run should become, given what Hermes reports.
///
/// Kept pure so the decision table is directly testable.
///
/// * Hermes still knows the run → adopt its status.
/// * Hermes forgot it and events were journalled → `interrupted`: execution was
///   cut short and the outcome is unknown.
/// * Hermes forgot it and nothing was ever journalled → `lost`: there is no
///   evidence it ever ran.
///
/// A run is never silently completed.
pub fn reconcile_decision(
    current: RunStatus,
    backend_status: Option<&str>,
    journalled_events: i64,
) -> (RunStatus, String) {
    match backend_status {
        Some(status) => {
            let mapped = from_hermes_status(status);
            (
                mapped,
                format!("Hermes still reports this run as {status:?}; adopted its status"),
            )
        }
        None if current == RunStatus::Created => (
            RunStatus::Lost,
            "run was never submitted to Hermes and no worker claimed it".to_owned(),
        ),
        None if journalled_events > 0 => (
            RunStatus::Interrupted,
            "Hermes no longer knows this run; events were journalled but no terminal status was observed".to_owned(),
        ),
        None => (
            RunStatus::Lost,
            "Hermes no longer knows this run and no events were ever journalled".to_owned(),
        ),
    }
}

/// Reconcile every non-terminal run of a project.
///
/// Skipped entirely when a worker currently holds the project lock: an active
/// worker is authoritative and must not be second-guessed.
pub async fn reconcile_project(
    state_root: &Path,
    project_id: &str,
    client: &HermesClient,
) -> Result<Vec<Reconciliation>> {
    let state = ProjectState::new(state_root, project_id)?;
    let Ok(lock) = state.try_lock() else {
        return Ok(Vec::new());
    };

    let mut registry = Registry::open(state_root)?;
    let mut outcomes = Vec::new();

    for run in registry.active_runs(project_id)? {
        let current = run.status()?;

        // Park the run in `recovering` while its backend is queried, so its
        // externally visible state says what is actually happening instead of
        // claiming it is still running.
        if run.hermes_run_id.is_some()
            && current != RunStatus::Recovering
            && crate::runstate::validate_transition(current, RunStatus::Recovering).is_ok()
        {
            registry.append_event(
                &run.run_id,
                &JournalEvent::asterism(
                    EVENT_RECOVERING,
                    json!({"previous_status": current.as_str()}),
                ),
                Some(&RunUpdate::status(RunStatus::Recovering)),
            )?;
        }

        let backend_status = match run.hermes_run_id.as_deref() {
            Some(hermes_run_id) => client
                .try_run_status(hermes_run_id)
                .await
                .ok()
                .flatten()
                .and_then(|value| status_of(&value)),
            None => None,
        };

        let (new_status, note) =
            reconcile_decision(current, backend_status.as_deref(), run.last_event_seq);
        if new_status == current {
            continue;
        }

        let mut update = RunUpdate::status(new_status).with_recovery_note(note.clone());
        if new_status.is_terminal() && new_status != RunStatus::Completed {
            update = update.with_terminal_reason("resolved by Asterism reconciliation");
        }

        registry.append_event(
            &run.run_id,
            &JournalEvent::asterism(
                EVENT_RECONCILED,
                json!({
                    "previous_status": current.as_str(),
                    "new_status": new_status.as_str(),
                    "reason": note,
                    "backend_status": backend_status,
                }),
            ),
            Some(&update),
        )?;

        outcomes.push(Reconciliation {
            run_id: run.run_id.clone(),
            previous_status: current.as_str().to_owned(),
            new_status: new_status.as_str().to_owned(),
            note,
        });
    }

    // Stale single-flight metadata is safe to drop now that every non-terminal
    // run has been resolved.
    lock.clear_active_run()?;
    Ok(outcomes)
}

/// Append an Asterism-sourced event without changing the run status.
pub fn append_note(
    registry: &mut Registry,
    run_id: &str,
    event_type: &str,
    payload: Value,
) -> Result<i64> {
    Ok(registry
        .append_event(
            run_id,
            &JournalEvent {
                event_type: event_type.to_owned(),
                source: SOURCE_ASTERISM.to_owned(),
                payload,
                raw: None,
                dedupe_key: None,
            },
            None,
        )?
        .seq())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sse::SseEvent;

    fn sse(event: Option<&str>, data: &str) -> SseEvent {
        SseEvent {
            event: event.map(ToOwned::to_owned),
            data: data.to_owned(),
        }
    }

    #[test]
    fn normalizes_a_hermes_event_using_the_body_type() {
        let normalized = normalize_event(&sse(
            None,
            r#"{"event":"tool.started","tool":"terminal","timestamp":1.5}"#,
        ));

        assert_eq!(normalized.event_type, "tool.started");
        assert_eq!(normalized.payload["tool"], json!("terminal"));
        assert!(normalized.dedupe_key.starts_with("tool.started:"));
    }

    #[test]
    fn prefers_the_sse_event_field_when_present() {
        let normalized = normalize_event(&sse(Some("sse.name"), r#"{"event":"body.name"}"#));
        assert_eq!(normalized.event_type, "sse.name");
    }

    #[test]
    fn preserves_malformed_event_bodies_as_text() {
        let normalized = normalize_event(&sse(None, "this is not json"));

        assert_eq!(normalized.event_type, "unknown");
        assert_eq!(normalized.payload["text"], json!("this is not json"));
        assert_eq!(normalized.raw, json!("this is not json"));
    }

    #[test]
    fn identical_frames_share_a_dedupe_key_and_distinct_ones_do_not() {
        let a = normalize_event(&sse(
            None,
            r#"{"event":"message.delta","delta":"a","timestamp":1}"#,
        ));
        let b = normalize_event(&sse(
            None,
            r#"{"event":"message.delta","delta":"a","timestamp":1}"#,
        ));
        let c = normalize_event(&sse(
            None,
            r#"{"event":"message.delta","delta":"b","timestamp":1}"#,
        ));

        assert_eq!(a.dedupe_key, b.dedupe_key);
        assert_ne!(a.dedupe_key, c.dedupe_key);
    }

    #[test]
    fn approval_requests_park_the_run_and_other_events_resume_it() {
        assert_eq!(
            status_update_for("approval.request", RunStatus::Running),
            Some(RunStatus::WaitingForApproval)
        );
        assert_eq!(
            status_update_for("tool.started", RunStatus::WaitingForApproval),
            Some(RunStatus::Running)
        );
        assert_eq!(status_update_for("tool.started", RunStatus::Running), None);
        // An approval-family event must not itself resume the run.
        assert_eq!(
            status_update_for("approval.resolved", RunStatus::WaitingForApproval),
            None
        );
    }

    #[test]
    fn reconciliation_adopts_a_status_hermes_still_reports() {
        let (status, note) = reconcile_decision(RunStatus::Running, Some("completed"), 12);
        assert_eq!(status, RunStatus::Completed);
        assert!(note.contains("adopted"));

        let (status, _) = reconcile_decision(RunStatus::Running, Some("running"), 12);
        assert_eq!(status, RunStatus::Running);
    }

    #[test]
    fn a_forgotten_run_with_events_is_interrupted() {
        let (status, note) = reconcile_decision(RunStatus::Running, None, 42);
        assert_eq!(status, RunStatus::Interrupted);
        assert!(note.contains("no terminal status"));
    }

    #[test]
    fn a_forgotten_run_without_events_is_lost() {
        let (status, _) = reconcile_decision(RunStatus::Running, None, 0);
        assert_eq!(status, RunStatus::Lost);
    }

    #[test]
    fn a_never_submitted_run_is_lost_rather_than_completed() {
        let (status, note) = reconcile_decision(RunStatus::Created, None, 0);
        assert_eq!(status, RunStatus::Lost);
        assert!(note.contains("never submitted"));
    }

    #[test]
    fn reconciliation_never_invents_a_completed_result() {
        for (current, events) in [
            (RunStatus::Running, 0),
            (RunStatus::Running, 5),
            (RunStatus::Starting, 0),
            (RunStatus::WaitingForApproval, 3),
            (RunStatus::Interrupted, 9),
        ] {
            let (status, _) = reconcile_decision(current, None, events);
            assert_ne!(
                status,
                RunStatus::Completed,
                "{current} with {events} events must not become completed"
            );
        }
    }
}
