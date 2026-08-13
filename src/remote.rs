//! Durable remote state: command inbox, response outbox, event subscriptions.
//!
//! Delivery from the Control Plane is **at-least-once**; execution on the Node
//! must be **at-most-once**. The inbox is what bridges the two: a command is
//! persisted before it is acknowledged, and a redelivered command id returns
//! the stored outcome instead of running again.
//!
//! The outbox exists only for messages that cannot be re-derived from the event
//! journal — command results and protocol-critical notifications. Events
//! themselves are never copied here: the journal already provides durable
//! replay by `seq`, and a second copy would be a second source of truth.

use anyhow::{Context, Result, bail};
use rusqlite::{OptionalExtension, Row, params};
use serde::Serialize;
use serde_json::Value;

use crate::redact;
use crate::registry::Registry;

/// Largest stored response or outbox payload.
pub const MAX_STORED_PAYLOAD_BYTES: usize = 64 * 1024;

/// Maximum number of unacknowledged outbox entries.
///
/// Reaching it means the Control Plane has stopped acknowledging. New remote
/// commands are then refused rather than accepted with no way to report their
/// result — failing closed is the only honest option.
pub const MAX_OUTBOX_DEPTH: i64 = 1024;

/// Lifecycle of one remote command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandState {
    Received,
    Accepted,
    Executing,
    Completed,
    Rejected,
    Failed,
}

impl CommandState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Received => "received",
            Self::Accepted => "accepted",
            Self::Executing => "executing",
            Self::Completed => "completed",
            Self::Rejected => "rejected",
            Self::Failed => "failed",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        Ok(match value {
            "received" => Self::Received,
            "accepted" => Self::Accepted,
            "executing" => Self::Executing,
            "completed" => Self::Completed,
            "rejected" => Self::Rejected,
            "failed" => Self::Failed,
            other => bail!("unknown remote command state {other:?}"),
        })
    }

    /// A settled command is never executed again.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Rejected | Self::Failed)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RemoteCommandRecord {
    pub command_id: String,
    pub command: String,
    pub project_id: Option<String>,
    pub received_at: i64,
    pub payload_digest: String,
    pub state: String,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub response_payload: Option<Value>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

/// What accepting a command produced.
#[derive(Debug, Clone, PartialEq)]
pub enum CommandAdmission {
    /// First time seen; the caller should execute it.
    Fresh(RemoteCommandRecord),
    /// Already known with the same payload. Replay the stored outcome.
    Duplicate(RemoteCommandRecord),
    /// The id was reused with different work — a protocol violation.
    PayloadMismatch { stored_digest: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OutboxEntry {
    pub id: i64,
    pub kind: String,
    pub correlation_id: Option<String>,
    pub payload: Value,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EventSubscription {
    pub run_id: String,
    pub project_id: String,
    pub acked_seq: i64,
}

impl Registry {
    // ------------------------------------------------------------- inbox

    /// Record a command before it is acknowledged or executed.
    pub fn admit_remote_command(
        &mut self,
        command_id: &str,
        command: &str,
        project_id: Option<&str>,
        payload_digest: &str,
    ) -> Result<CommandAdmission> {
        let tx = self.conn.transaction()?;

        let existing: Option<(String, String)> = tx
            .query_row(
                "SELECT payload_digest, state FROM remote_commands WHERE command_id = ?1",
                params![command_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;

        if let Some((stored_digest, _)) = existing {
            if stored_digest != payload_digest {
                return Ok(CommandAdmission::PayloadMismatch { stored_digest });
            }
            let record = load_command(&tx, command_id)?
                .context("remote command vanished between lookup and load")?;
            tx.commit()?;
            return Ok(CommandAdmission::Duplicate(record));
        }

        tx.execute(
            "INSERT INTO remote_commands (command_id, command, project_id, received_at,
                                          payload_digest, state)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                command_id,
                command,
                project_id,
                crate::registry::now_millis(),
                payload_digest,
                CommandState::Received.as_str(),
            ],
        )?;
        let record =
            load_command(&tx, command_id)?.context("remote command vanished after insert")?;
        tx.commit()?;
        Ok(CommandAdmission::Fresh(record))
    }

    pub fn set_remote_command_state(
        &mut self,
        command_id: &str,
        state: CommandState,
    ) -> Result<()> {
        let now = crate::registry::now_millis();
        self.conn.execute(
            "UPDATE remote_commands SET
                 state = ?2,
                 started_at = CASE WHEN ?3 = 1 AND started_at IS NULL THEN ?4 ELSE started_at END
             WHERE command_id = ?1",
            params![
                command_id,
                state.as_str(),
                (state == CommandState::Executing) as i64,
                now
            ],
        )?;
        Ok(())
    }

    /// Store a terminal outcome. Redacted and size-bounded before persistence.
    pub fn complete_remote_command(
        &mut self,
        command_id: &str,
        state: CommandState,
        response: Option<&Value>,
        error_code: Option<&str>,
        error_message: Option<&str>,
    ) -> Result<RemoteCommandRecord> {
        let encoded = response.map(bounded_payload).transpose()?.flatten();

        self.conn.execute(
            "UPDATE remote_commands SET
                 state = ?2, completed_at = ?3, response_payload = ?4,
                 error_code = ?5, error_message = ?6
             WHERE command_id = ?1",
            params![
                command_id,
                state.as_str(),
                crate::registry::now_millis(),
                encoded,
                error_code,
                error_message,
            ],
        )?;

        load_command(&self.conn, command_id)?
            .with_context(|| format!("unknown remote command {command_id}"))
    }

    pub fn remote_command(&self, command_id: &str) -> Result<Option<RemoteCommandRecord>> {
        load_command(&self.conn, command_id)
    }

    /// Commands interrupted mid-execution by a daemon restart.
    ///
    /// They are never replayed automatically: a command that was executing may
    /// already have had an effect, and repeating it without evidence could
    /// duplicate work.
    pub fn interrupted_remote_commands(&self) -> Result<Vec<RemoteCommandRecord>> {
        let mut statement = self.conn.prepare(
            "SELECT command_id, command, project_id, received_at, payload_digest, state,
                    started_at, completed_at, response_payload, error_code, error_message
             FROM remote_commands WHERE state IN ('received', 'accepted', 'executing')
             ORDER BY received_at",
        )?;
        Ok(statement
            .query_map([], map_command)?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // ------------------------------------------------------------ outbox

    pub fn outbox_depth(&self) -> Result<i64> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM outbox WHERE acknowledged_at IS NULL",
            [],
            |row| row.get(0),
        )?)
    }

    /// Persist a message that must survive a reconnect.
    ///
    /// Fails when the outbox is full, which is what makes the caller refuse new
    /// remote commands rather than accept work whose result it could not report.
    pub fn enqueue_outbox(
        &mut self,
        kind: &str,
        correlation_id: Option<&str>,
        payload: &Value,
    ) -> Result<i64> {
        if self.outbox_depth()? >= MAX_OUTBOX_DEPTH {
            bail!(
                "outbox is full ({MAX_OUTBOX_DEPTH} unacknowledged entries); \
                 refusing to accept more work until the Control Plane acknowledges"
            );
        }
        let encoded = bounded_payload(payload)?.unwrap_or_else(|| "{}".to_owned());
        self.conn.execute(
            "INSERT INTO outbox (kind, correlation_id, payload, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![kind, correlation_id, encoded, crate::registry::now_millis()],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Unacknowledged entries in insertion order, so correlation is preserved.
    pub fn pending_outbox(&self, limit: i64) -> Result<Vec<OutboxEntry>> {
        let mut statement = self.conn.prepare(
            "SELECT id, kind, correlation_id, payload, created_at
             FROM outbox WHERE acknowledged_at IS NULL ORDER BY id ASC LIMIT ?1",
        )?;
        Ok(statement
            .query_map(params![limit], map_outbox)?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Mark delivered. Acknowledging twice is harmless.
    pub fn acknowledge_outbox(&mut self, id: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE outbox SET acknowledged_at = ?2
             WHERE id = ?1 AND acknowledged_at IS NULL",
            params![id, crate::registry::now_millis()],
        )?;
        Ok(())
    }

    /// Acknowledge by correlation id, which is what a Control Plane naturally
    /// knows when confirming a command result.
    pub fn acknowledge_outbox_correlation(&mut self, correlation_id: &str) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE outbox SET acknowledged_at = ?2
             WHERE correlation_id = ?1 AND acknowledged_at IS NULL",
            params![correlation_id, crate::registry::now_millis()],
        )?)
    }

    // ------------------------------------------------------ subscriptions

    /// Record or update an event subscription cursor.
    pub fn upsert_subscription(
        &mut self,
        project_id: &str,
        run_id: &str,
        from_seq: i64,
    ) -> Result<EventSubscription> {
        let now = crate::registry::now_millis();
        self.conn.execute(
            "INSERT INTO event_subscriptions (run_id, project_id, acked_seq, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(run_id) DO UPDATE SET updated_at = ?4",
            params![run_id, project_id, from_seq.max(0), now],
        )?;
        self.subscription(run_id)?
            .context("subscription vanished immediately after upsert")
    }

    /// Advance the acknowledged cursor. Never moves backwards, so a late or
    /// duplicated acknowledgement cannot cause events to be resent forever.
    pub fn acknowledge_events(&mut self, run_id: &str, acked_seq: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE event_subscriptions SET acked_seq = MAX(acked_seq, ?2), updated_at = ?3
             WHERE run_id = ?1",
            params![run_id, acked_seq, crate::registry::now_millis()],
        )?;
        Ok(())
    }

    pub fn subscription(&self, run_id: &str) -> Result<Option<EventSubscription>> {
        Ok(self
            .conn
            .query_row(
                "SELECT run_id, project_id, acked_seq FROM event_subscriptions WHERE run_id = ?1",
                params![run_id],
                |row| {
                    Ok(EventSubscription {
                        run_id: row.get(0)?,
                        project_id: row.get(1)?,
                        acked_seq: row.get(2)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn subscriptions(&self) -> Result<Vec<EventSubscription>> {
        let mut statement = self.conn.prepare(
            "SELECT run_id, project_id, acked_seq FROM event_subscriptions ORDER BY run_id",
        )?;
        Ok(statement
            .query_map([], |row| {
                Ok(EventSubscription {
                    run_id: row.get(0)?,
                    project_id: row.get(1)?,
                    acked_seq: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn remove_subscription(&mut self, run_id: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM event_subscriptions WHERE run_id = ?1",
            params![run_id],
        )?;
        Ok(())
    }
}

/// Redact, then drop anything still oversized.
fn bounded_payload(value: &Value) -> Result<Option<String>> {
    let redacted = redact::redact(value).value;
    let encoded = serde_json::to_string(&redacted)?;
    if encoded.len() > MAX_STORED_PAYLOAD_BYTES {
        return Ok(Some(
            serde_json::json!({"truncated": true, "bytes": encoded.len()}).to_string(),
        ));
    }
    Ok(Some(encoded))
}

fn load_command(
    conn: &rusqlite::Connection,
    command_id: &str,
) -> Result<Option<RemoteCommandRecord>> {
    Ok(conn
        .query_row(
            "SELECT command_id, command, project_id, received_at, payload_digest, state,
                    started_at, completed_at, response_payload, error_code, error_message
             FROM remote_commands WHERE command_id = ?1",
            params![command_id],
            map_command,
        )
        .optional()?)
}

fn map_command(row: &Row<'_>) -> rusqlite::Result<RemoteCommandRecord> {
    let response: Option<String> = row.get(8)?;
    Ok(RemoteCommandRecord {
        command_id: row.get(0)?,
        command: row.get(1)?,
        project_id: row.get(2)?,
        received_at: row.get(3)?,
        payload_digest: row.get(4)?,
        state: row.get(5)?,
        started_at: row.get(6)?,
        completed_at: row.get(7)?,
        response_payload: response.and_then(|text| serde_json::from_str(&text).ok()),
        error_code: row.get(9)?,
        error_message: row.get(10)?,
    })
}

fn map_outbox(row: &Row<'_>) -> rusqlite::Result<OutboxEntry> {
    let payload: String = row.get(3)?;
    Ok(OutboxEntry {
        id: row.get(0)?,
        kind: row.get(1)?,
        correlation_id: row.get(2)?,
        payload: serde_json::from_str(&payload).unwrap_or(Value::Null),
        created_at: row.get(4)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn registry() -> Registry {
        Registry::open_in_memory().unwrap()
    }

    #[test]
    fn a_new_command_is_admitted_once() {
        let mut registry = registry();
        let admission = registry
            .admit_remote_command("c1", "runs.create", Some("p1"), "digest-1")
            .unwrap();

        match admission {
            CommandAdmission::Fresh(record) => {
                assert_eq!(record.state, "received");
                assert_eq!(record.command, "runs.create");
            }
            other => panic!("expected a fresh admission, got {other:?}"),
        }
    }

    #[test]
    fn a_redelivered_command_returns_the_stored_outcome_instead_of_running_again() {
        let mut registry = registry();
        registry
            .admit_remote_command("c1", "runs.create", Some("p1"), "digest-1")
            .unwrap();
        registry
            .complete_remote_command(
                "c1",
                CommandState::Completed,
                Some(&json!({"run_id": "arun_1"})),
                None,
                None,
            )
            .unwrap();

        let again = registry
            .admit_remote_command("c1", "runs.create", Some("p1"), "digest-1")
            .unwrap();

        match again {
            CommandAdmission::Duplicate(record) => {
                assert_eq!(record.state, "completed");
                assert_eq!(record.response_payload.unwrap()["run_id"], json!("arun_1"));
            }
            other => panic!("expected a duplicate, got {other:?}"),
        }
    }

    #[test]
    fn reusing_a_command_id_with_different_work_is_a_protocol_violation() {
        let mut registry = registry();
        registry
            .admit_remote_command("c1", "runs.create", Some("p1"), "digest-1")
            .unwrap();

        let conflicting = registry
            .admit_remote_command("c1", "runs.create", Some("p1"), "digest-DIFFERENT")
            .unwrap();

        assert!(matches!(
            conflicting,
            CommandAdmission::PayloadMismatch { .. }
        ));
    }

    #[test]
    fn a_completed_command_is_not_re_executed_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut registry = Registry::open(dir.path()).unwrap();
            registry
                .admit_remote_command("c1", "runs.create", Some("p1"), "d")
                .unwrap();
            registry
                .complete_remote_command("c1", CommandState::Completed, None, None, None)
                .unwrap();
        }

        // A fresh process re-admitting the same id sees it as settled.
        let mut registry = Registry::open(dir.path()).unwrap();
        let admission = registry
            .admit_remote_command("c1", "runs.create", Some("p1"), "d")
            .unwrap();
        assert!(matches!(admission, CommandAdmission::Duplicate(_)));
        assert!(registry.interrupted_remote_commands().unwrap().is_empty());
    }

    #[test]
    fn commands_interrupted_mid_execution_are_reported_for_reconciliation() {
        let mut registry = registry();
        registry
            .admit_remote_command("c1", "runs.create", Some("p1"), "d")
            .unwrap();
        registry
            .set_remote_command_state("c1", CommandState::Executing)
            .unwrap();
        registry
            .admit_remote_command("c2", "runs.list", None, "d2")
            .unwrap();
        registry
            .complete_remote_command("c2", CommandState::Completed, None, None, None)
            .unwrap();

        let interrupted = registry.interrupted_remote_commands().unwrap();
        assert_eq!(interrupted.len(), 1);
        assert_eq!(interrupted[0].command_id, "c1");
        assert!(interrupted[0].started_at.is_some());
    }

    #[test]
    fn stored_responses_are_redacted_and_bounded() {
        let mut registry = registry();
        registry
            .admit_remote_command("c1", "runs.create", None, "d")
            .unwrap();
        registry
            .complete_remote_command(
                "c1",
                CommandState::Completed,
                Some(&json!({"access_token": "super-secret-value"})),
                None,
                None,
            )
            .unwrap();

        let stored = serde_json::to_string(&registry.remote_command("c1").unwrap()).unwrap();
        assert!(!stored.contains("super-secret-value"));

        // Oversized responses are bounded: redaction truncates long strings
        // before storage, so a huge blob can never occupy the row whole.
        registry
            .admit_remote_command("c2", "runs.list", None, "d")
            .unwrap();
        registry
            .complete_remote_command(
                "c2",
                CommandState::Completed,
                Some(&json!({"blob": "x".repeat(MAX_STORED_PAYLOAD_BYTES + 1)})),
                None,
                None,
            )
            .unwrap();
        let big = registry.remote_command("c2").unwrap().unwrap();
        let stored_blob = big.response_payload.unwrap()["blob"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(stored_blob.ends_with("…[truncated]"));
        assert!(stored_blob.len() < MAX_STORED_PAYLOAD_BYTES);
    }

    #[test]
    fn outbox_entries_survive_until_acknowledged_and_keep_their_order() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut registry = Registry::open(dir.path()).unwrap();
            registry
                .enqueue_outbox("command.result", Some("c1"), &json!({"n": 1}))
                .unwrap();
            registry
                .enqueue_outbox("command.result", Some("c2"), &json!({"n": 2}))
                .unwrap();
        }

        let mut registry = Registry::open(dir.path()).unwrap();
        let pending = registry.pending_outbox(10).unwrap();
        assert_eq!(pending.len(), 2);
        assert_eq!(pending[0].correlation_id.as_deref(), Some("c1"));
        assert!(pending[0].id < pending[1].id, "ordering must be preserved");

        registry.acknowledge_outbox_correlation("c1").unwrap();
        let remaining = registry.pending_outbox(10).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].correlation_id.as_deref(), Some("c2"));
    }

    #[test]
    fn acknowledging_twice_is_harmless() {
        let mut registry = registry();
        let id = registry.enqueue_outbox("x", None, &json!({})).unwrap();

        registry.acknowledge_outbox(id).unwrap();
        registry.acknowledge_outbox(id).unwrap();

        assert_eq!(registry.outbox_depth().unwrap(), 0);
    }

    #[test]
    fn outbox_payloads_are_redacted() {
        let mut registry = registry();
        registry
            .enqueue_outbox(
                "x",
                None,
                &json!({"authorization": "Bearer abcdefghijklmn"}),
            )
            .unwrap();

        let rendered = serde_json::to_string(&registry.pending_outbox(1).unwrap()).unwrap();
        assert!(!rendered.contains("abcdefghijklmn"));
    }

    #[test]
    fn a_full_outbox_refuses_new_work_rather_than_dropping_results() {
        let mut registry = registry();
        for _ in 0..MAX_OUTBOX_DEPTH {
            registry.enqueue_outbox("x", None, &json!({})).unwrap();
        }

        let error = registry.enqueue_outbox("x", None, &json!({})).unwrap_err();
        assert!(error.to_string().contains("outbox is full"));
    }

    #[test]
    fn subscription_cursors_persist_and_never_move_backwards() {
        let dir = tempfile::tempdir().unwrap();
        let run_id;
        {
            let mut registry = Registry::open(dir.path()).unwrap();
            let run = registry
                .create_run(&crate::registry::NewRun {
                    project_id: "p1".into(),
                    session_id: None,
                    idempotency_key: None,
                    runtime_kind: "hermes-loop".into(),
                    provider: None,
                    model: None,
                    request_payload: json!({"input": "x"}),
                    retry_of_run_id: None,
                })
                .unwrap()
                .record()
                .clone();
            run_id = run.run_id.clone();
            registry.upsert_subscription("p1", &run_id, 0).unwrap();
            registry.acknowledge_events(&run_id, 12).unwrap();
            // A late, lower acknowledgement must not rewind the cursor.
            registry.acknowledge_events(&run_id, 5).unwrap();
        }

        let registry = Registry::open(dir.path()).unwrap();
        let subscription = registry.subscription(&run_id).unwrap().unwrap();
        assert_eq!(subscription.acked_seq, 12);
        assert_eq!(registry.subscriptions().unwrap().len(), 1);
    }

    #[test]
    fn subscriptions_can_be_removed() {
        let mut registry = registry();
        let run = registry
            .create_run(&crate::registry::NewRun {
                project_id: "p1".into(),
                session_id: None,
                idempotency_key: None,
                runtime_kind: "hermes-loop".into(),
                provider: None,
                model: None,
                request_payload: json!({"input": "x"}),
                retry_of_run_id: None,
            })
            .unwrap()
            .record()
            .clone();
        registry.upsert_subscription("p1", &run.run_id, 3).unwrap();

        registry.remove_subscription(&run.run_id).unwrap();

        assert!(registry.subscription(&run.run_id).unwrap().is_none());
    }

    #[test]
    fn command_states_round_trip_and_classify_terminality() {
        for state in [
            CommandState::Received,
            CommandState::Accepted,
            CommandState::Executing,
            CommandState::Completed,
            CommandState::Rejected,
            CommandState::Failed,
        ] {
            assert_eq!(CommandState::parse(state.as_str()).unwrap(), state);
        }
        assert!(CommandState::Completed.is_terminal());
        assert!(CommandState::Rejected.is_terminal());
        assert!(CommandState::Failed.is_terminal());
        assert!(!CommandState::Executing.is_terminal());
        assert!(CommandState::parse("nonsense").is_err());
    }
}
