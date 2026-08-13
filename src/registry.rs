//! Durable run registry and append-only event journal owned by Asterism Node.
//!
//! # Why Node owns this
//!
//! Hermes' run registry is in-memory: Phase A and Phase B both observed
//! `GET /v1/runs/{id}` returning 404 after a container restart, and a mid-run
//! restart destroying the SSE stream with no way to recover the outcome.
//! Asterism therefore stops treating Hermes as authoritative for externally
//! visible run state. Hermes remains the execution backend; this module is the
//! source of truth for what ran, when, how it ended, and what it emitted.
//!
//! # Placement
//!
//! The database lives under the Node state root at `node/registry.db`, outside
//! every path bound into a project container. A project container mounts only
//! its workspace and its Hermes data directory, so the registry is unreachable
//! from inside the trust domain that Phase C showed cannot protect secrets from
//! itself.
//!
//! # Durability model
//!
//! Durable **metadata** and durable **execution** are separate properties. This
//! module provides the first: records and events survive CLI exit, Node
//! restart, container restart, and host restart. It does not make an in-flight
//! Hermes run survive a container restart — nothing at this layer can.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OptionalExtension, Row, TransactionBehavior, params};
use serde::Serialize;
use serde_json::{Value, json};

use crate::redact;
use crate::runstate::{RunStatus, validate_transition};

/// Current schema version. Every change bumps this and adds a migration step.
pub const SCHEMA_VERSION: i64 = 4;

/// Registry location relative to the Node state root.
pub const REGISTRY_RELATIVE_PATH: &str = "node/registry.db";

/// Source label for events Asterism itself synthesises.
pub const SOURCE_ASTERISM: &str = "asterism";
/// Source label for events received from Hermes.
pub const SOURCE_HERMES: &str = "hermes";

/// Returned when an idempotency key is reused with a different request.
#[derive(Debug, Clone)]
pub struct IdempotencyConflict {
    pub project_id: String,
    pub idempotency_key: String,
    pub existing_run_id: String,
}

impl std::fmt::Display for IdempotencyConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "idempotency key {:?} for project {} was already used by run {} with a different request",
            self.idempotency_key, self.project_id, self.existing_run_id
        )
    }
}

impl std::error::Error for IdempotencyConflict {}

/// Stable error code for the conflict above.
pub const IDEMPOTENCY_CONFLICT_CODE: &str = "idempotency_conflict";

/// A run as stored by Asterism Node.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RunRecord {
    pub run_id: String,
    pub project_id: String,
    pub session_id: Option<String>,
    pub idempotency_key: Option<String>,
    pub runtime_kind: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub status: String,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub updated_at: i64,
    pub finished_at: Option<i64>,
    pub last_event_seq: i64,
    pub terminal_reason: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub hermes_run_id: Option<String>,
    pub request_payload: Value,
    pub result_payload: Option<Value>,
    pub recovery_note: Option<String>,
    /// Set when this run replaces a terminal `interrupted` or `lost` run.
    pub retry_of_run_id: Option<String>,
}

impl RunRecord {
    pub fn status(&self) -> Result<RunStatus> {
        RunStatus::parse(&self.status)
    }
}

/// Request to create a durable run record.
#[derive(Debug, Clone)]
pub struct NewRun {
    pub project_id: String,
    pub session_id: Option<String>,
    pub idempotency_key: Option<String>,
    pub runtime_kind: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub request_payload: Value,
    /// Original run this one replaces, for an explicit retry.
    pub retry_of_run_id: Option<String>,
}

/// Whether creation produced a new run or replayed an existing one.
#[derive(Debug, Clone, PartialEq)]
pub enum RunCreation {
    Created(RunRecord),
    /// The same project and idempotency key with an identical request.
    Existing(RunRecord),
}

impl RunCreation {
    pub fn record(&self) -> &RunRecord {
        match self {
            Self::Created(run) | Self::Existing(run) => run,
        }
    }

    pub fn is_new(&self) -> bool {
        matches!(self, Self::Created(_))
    }
}

/// Fields a state change may update alongside the status.
#[derive(Debug, Clone, Default)]
pub struct RunUpdate {
    pub status: Option<RunStatus>,
    pub hermes_run_id: Option<String>,
    pub terminal_reason: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub result_payload: Option<Value>,
    pub recovery_note: Option<String>,
}

impl RunUpdate {
    pub fn status(status: RunStatus) -> Self {
        Self {
            status: Some(status),
            ..Self::default()
        }
    }

    pub fn with_hermes_run_id(mut self, id: impl Into<String>) -> Self {
        self.hermes_run_id = Some(id.into());
        self
    }

    pub fn with_error(mut self, code: impl Into<String>, message: impl Into<String>) -> Self {
        self.error_code = Some(code.into());
        self.error_message = Some(message.into());
        self
    }

    pub fn with_terminal_reason(mut self, reason: impl Into<String>) -> Self {
        self.terminal_reason = Some(reason.into());
        self
    }

    pub fn with_result(mut self, payload: Value) -> Self {
        self.result_payload = Some(payload);
        self
    }

    pub fn with_recovery_note(mut self, note: impl Into<String>) -> Self {
        self.recovery_note = Some(note.into());
        self
    }
}

/// An event to append to the journal.
#[derive(Debug, Clone)]
pub struct JournalEvent {
    pub event_type: String,
    pub source: String,
    /// Normalized payload. Redacted before storage.
    pub payload: Value,
    /// Original backend payload, redacted and size-bounded before storage.
    pub raw: Option<Value>,
    /// Optional identity used to suppress duplicate delivery of the same
    /// backend event. `None` means "always append".
    pub dedupe_key: Option<String>,
}

impl JournalEvent {
    pub fn asterism(event_type: impl Into<String>, payload: Value) -> Self {
        Self {
            event_type: event_type.into(),
            source: SOURCE_ASTERISM.to_owned(),
            payload,
            raw: None,
            dedupe_key: None,
        }
    }
}

/// An event as stored, with its assigned sequence number.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StoredEvent {
    pub run_id: String,
    pub seq: i64,
    pub event_type: String,
    pub recorded_at: i64,
    pub source: String,
    pub payload: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_payload: Option<Value>,
    pub redacted: bool,
}

/// Result of appending an event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppendOutcome {
    /// Stored with this sequence number.
    Appended(i64),
    /// A previous append already carried this dedupe key; nothing was written.
    Duplicate(i64),
}

impl AppendOutcome {
    pub fn seq(self) -> i64 {
        match self {
            Self::Appended(seq) | Self::Duplicate(seq) => seq,
        }
    }
}

/// Persisted approval request and its decision.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ApprovalRecord {
    pub run_id: String,
    pub request_seq: i64,
    pub requested_at: i64,
    pub command: Option<String>,
    pub choices: Option<Value>,
    pub decision: Option<String>,
    pub decided_at: Option<i64>,
    pub resolution_seq: Option<i64>,
}

/// Handle to the Node-owned registry database.
#[derive(Debug)]
pub struct Registry {
    /// Visible to sibling modules that add inherent methods for remote state
    /// (`inventory`, `remote`); never exposed outside the crate.
    pub(crate) conn: Connection,
}

impl Registry {
    /// Database path for a given Node state root.
    pub fn path_for(state_root: impl AsRef<Path>) -> PathBuf {
        state_root.as_ref().join(REGISTRY_RELATIVE_PATH)
    }

    /// Open (creating if needed) and migrate the registry.
    pub fn open(state_root: impl AsRef<Path>) -> Result<Self> {
        let path = Self::path_for(state_root);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).with_context(|| {
                format!("failed to create Node state directory {}", parent.display())
            })?;
        }
        Self::open_at(&path)
    }

    pub fn open_at(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)
            .with_context(|| format!("failed to open run registry {}", path.display()))?;
        Self::configure(&conn, path)?;
        let registry = Self { conn };
        registry.migrate()?;
        Ok(registry)
    }

    /// In-memory registry, used by tests.
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let registry = Self { conn };
        registry.migrate()?;
        Ok(registry)
    }

    fn configure(conn: &Connection, path: &Path) -> Result<()> {
        // A corrupt or non-database file must fail closed with a clear error
        // rather than silently behaving as an empty registry.
        // Setting journal_mode takes an exclusive lock even when the database
        // is already in WAL mode. Workers open short-lived connections while
        // another project may be starting, so avoid that needless write-lock
        // race on every open.
        let current_mode: String = conn
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .with_context(|| {
                format!(
                    "run registry {} is unreadable or corrupt; refusing to continue",
                    path.display()
                )
            })?;
        let journal_mode = if current_mode.eq_ignore_ascii_case("wal") {
            current_mode
        } else {
            conn.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))?
        };
        if !journal_mode.eq_ignore_ascii_case("wal") {
            bail!(
                "run registry {} could not be switched to WAL mode (got {journal_mode})",
                path.display()
            );
        }
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(())
    }

    /// Apply every migration step between the stored version and the current one.
    fn migrate(&self) -> Result<()> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_version (
                 version INTEGER NOT NULL
             );",
        )?;

        let current: Option<i64> = self
            .conn
            .query_row("SELECT version FROM schema_version LIMIT 1", [], |row| {
                row.get(0)
            })
            .optional()?;

        let mut version = match current {
            Some(version) => version,
            None => {
                self.conn
                    .execute("INSERT INTO schema_version (version) VALUES (0)", [])?;
                0
            }
        };

        if version > SCHEMA_VERSION {
            bail!(
                "run registry schema version {version} is newer than this build supports ({SCHEMA_VERSION})"
            );
        }

        while version < SCHEMA_VERSION {
            version += 1;
            self.apply_migration(version)?;
            self.conn
                .execute("UPDATE schema_version SET version = ?1", params![version])?;
        }

        Ok(())
    }

    fn apply_migration(&self, version: i64) -> Result<()> {
        match version {
            1 => self.conn.execute_batch(MIGRATION_001)?,
            2 => self.conn.execute_batch(MIGRATION_002)?,
            3 => self.conn.execute_batch(MIGRATION_003)?,
            4 => self.conn.execute_batch(MIGRATION_004)?,
            other => bail!("no migration defined for schema version {other}"),
        }
        Ok(())
    }

    pub fn schema_version(&self) -> Result<i64> {
        Ok(self
            .conn
            .query_row("SELECT version FROM schema_version LIMIT 1", [], |row| {
                row.get(0)
            })?)
    }

    /// Create a durable run record, honouring an optional idempotency key.
    pub fn create_run(&mut self, request: &NewRun) -> Result<RunCreation> {
        let fingerprint = request_fingerprint(request);
        let now = now_millis();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;

        if let Some(key) = request.idempotency_key.as_deref() {
            let existing: Option<(String, String)> = tx
                .query_row(
                    "SELECT run_id, request_fingerprint FROM runs
                     WHERE project_id = ?1 AND idempotency_key = ?2",
                    params![request.project_id, key],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;

            if let Some((run_id, stored_fingerprint)) = existing {
                if stored_fingerprint != fingerprint {
                    return Err(IdempotencyConflict {
                        project_id: request.project_id.clone(),
                        idempotency_key: key.to_owned(),
                        existing_run_id: run_id,
                    }
                    .into());
                }
                let record = load_run(&tx, &run_id)?
                    .context("idempotent run disappeared between lookup and load")?;
                tx.commit()?;
                return Ok(RunCreation::Existing(record));
            }
        }

        let run_id = new_run_id();
        let request_payload = redact::redact(&request.request_payload).value;

        tx.execute(
            "INSERT INTO runs (
                 run_id, project_id, session_id, idempotency_key, runtime_kind,
                 provider, model, status, created_at, updated_at, last_event_seq,
                 request_payload, request_fingerprint, retry_of_run_id
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, 0, ?10, ?11, ?12)",
            params![
                run_id,
                request.project_id,
                request.session_id,
                request.idempotency_key,
                request.runtime_kind,
                request.provider,
                request.model,
                RunStatus::Created.as_str(),
                now,
                serde_json::to_string(&request_payload)?,
                fingerprint,
                request.retry_of_run_id,
            ],
        )?;

        let record = load_run(&tx, &run_id)?.context("run vanished immediately after insert")?;
        tx.commit()?;
        Ok(RunCreation::Created(record))
    }

    pub fn run(&self, run_id: &str) -> Result<Option<RunRecord>> {
        load_run(&self.conn, run_id)
    }

    /// Look up by the backend identifier, used during reconciliation.
    pub fn run_by_hermes_id(&self, hermes_run_id: &str) -> Result<Option<RunRecord>> {
        let run_id: Option<String> = self
            .conn
            .query_row(
                "SELECT run_id FROM runs WHERE hermes_run_id = ?1",
                params![hermes_run_id],
                |row| row.get(0),
            )
            .optional()?;
        match run_id {
            Some(run_id) => load_run(&self.conn, &run_id),
            None => Ok(None),
        }
    }

    pub fn list_runs(&self, project_id: &str, limit: i64) -> Result<Vec<RunRecord>> {
        let mut statement = self.conn.prepare(
            "SELECT run_id FROM runs WHERE project_id = ?1
             ORDER BY created_at DESC, rowid DESC LIMIT ?2",
        )?;
        let ids: Vec<String> = statement
            .query_map(params![project_id, limit], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;

        let mut runs = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(run) = load_run(&self.conn, &id)? {
                runs.push(run);
            }
        }
        Ok(runs)
    }

    /// Runs that have not reached a terminal state, oldest first.
    pub fn active_runs(&self, project_id: &str) -> Result<Vec<RunRecord>> {
        Ok(self
            .list_runs(project_id, 1000)?
            .into_iter()
            .filter(|run| {
                run.status()
                    .map(|status| status.is_active())
                    .unwrap_or(false)
            })
            .rev()
            .collect())
    }

    /// Apply a state change, rejecting transitions the state machine forbids.
    pub fn update_run(&mut self, run_id: &str, update: &RunUpdate) -> Result<RunRecord> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        apply_update(&tx, run_id, update)?;
        let record = load_run(&tx, run_id)?.context("run disappeared during update")?;
        tx.commit()?;
        Ok(record)
    }

    /// Append an event, optionally applying a state change in the same
    /// transaction so the journal and the run record can never disagree.
    pub fn append_event(
        &mut self,
        run_id: &str,
        event: &JournalEvent,
        update: Option<&RunUpdate>,
    ) -> Result<AppendOutcome> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;

        let exists: bool = tx
            .query_row(
                "SELECT 1 FROM runs WHERE run_id = ?1",
                params![run_id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !exists {
            bail!("cannot append an event to unknown run {run_id}");
        }

        if let Some(key) = event.dedupe_key.as_deref() {
            let existing: Option<i64> = tx
                .query_row(
                    "SELECT seq FROM run_events WHERE run_id = ?1 AND dedupe_key = ?2",
                    params![run_id, key],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(seq) = existing {
                // Duplicate delivery is harmless: the journal is unchanged and
                // the caller still learns where the event lives.
                tx.commit()?;
                return Ok(AppendOutcome::Duplicate(seq));
            }
        }

        let next_seq: i64 = tx.query_row(
            "SELECT last_event_seq + 1 FROM runs WHERE run_id = ?1",
            params![run_id],
            |row| row.get(0),
        )?;

        let payload = redact::redact(&event.payload);
        let raw_encoded = event.raw.as_ref().and_then(redact::bounded_raw);
        let redacted_flag = payload.modified || (event.raw.is_some() && raw_encoded.is_none());

        tx.execute(
            "INSERT INTO run_events (
                 run_id, seq, event_type, recorded_at, source, payload, raw_payload,
                 redacted, dedupe_key
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                run_id,
                next_seq,
                event.event_type,
                now_millis(),
                event.source,
                serde_json::to_string(&payload.value)?,
                raw_encoded,
                redacted_flag as i64,
                event.dedupe_key,
            ],
        )?;

        tx.execute(
            "UPDATE runs SET last_event_seq = ?2, updated_at = ?3 WHERE run_id = ?1",
            params![run_id, next_seq, now_millis()],
        )?;

        if let Some(update) = update {
            apply_update(&tx, run_id, update)?;
        }

        tx.commit()?;
        Ok(AppendOutcome::Appended(next_seq))
    }

    /// Replay stored events after a cursor, in append order.
    pub fn events_since(
        &self,
        run_id: &str,
        after_seq: i64,
        limit: i64,
    ) -> Result<Vec<StoredEvent>> {
        let mut statement = self.conn.prepare(
            "SELECT run_id, seq, event_type, recorded_at, source, payload, raw_payload, redacted
             FROM run_events WHERE run_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT ?3",
        )?;
        let events = statement
            .query_map(params![run_id, after_seq, limit], map_event)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(events)
    }

    /// Persist an approval request observed on the event stream.
    pub fn record_approval_request(
        &mut self,
        run_id: &str,
        request_seq: i64,
        command: Option<&str>,
        choices: Option<&Value>,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO run_approvals (
                 run_id, request_seq, requested_at, command, choices
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                run_id,
                request_seq,
                now_millis(),
                command,
                choices.map(serde_json::to_string).transpose()?,
            ],
        )?;
        Ok(())
    }

    /// Record a decision exactly once.
    ///
    /// Returns `false` when a decision was already stored, which is what makes
    /// approval application at-most-once even if a client retries.
    pub fn record_approval_decision(
        &mut self,
        run_id: &str,
        request_seq: i64,
        decision: &str,
    ) -> Result<bool> {
        let changed = self.conn.execute(
            "UPDATE run_approvals SET decision = ?3, decided_at = ?4
             WHERE run_id = ?1 AND request_seq = ?2 AND decision IS NULL",
            params![run_id, request_seq, decision, now_millis()],
        )?;
        Ok(changed == 1)
    }

    pub fn record_approval_resolution(
        &mut self,
        run_id: &str,
        request_seq: i64,
        resolution_seq: i64,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE run_approvals SET resolution_seq = ?3
             WHERE run_id = ?1 AND request_seq = ?2",
            params![run_id, request_seq, resolution_seq],
        )?;
        Ok(())
    }

    /// Most recent approval request that has no decision yet.
    pub fn pending_approval(&self, run_id: &str) -> Result<Option<ApprovalRecord>> {
        let record = self
            .conn
            .query_row(
                "SELECT run_id, request_seq, requested_at, command, choices, decision,
                        decided_at, resolution_seq
                 FROM run_approvals
                 WHERE run_id = ?1 AND decision IS NULL
                 ORDER BY request_seq DESC LIMIT 1",
                params![run_id],
                map_approval,
            )
            .optional()?;
        Ok(record)
    }

    pub fn approvals(&self, run_id: &str) -> Result<Vec<ApprovalRecord>> {
        let mut statement = self.conn.prepare(
            "SELECT run_id, request_seq, requested_at, command, choices, decision,
                    decided_at, resolution_seq
             FROM run_approvals WHERE run_id = ?1 ORDER BY request_seq ASC",
        )?;
        Ok(statement
            .query_map(params![run_id], map_approval)?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

fn apply_update(tx: &Connection, run_id: &str, update: &RunUpdate) -> Result<()> {
    let current: String = tx
        .query_row(
            "SELECT status FROM runs WHERE run_id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .optional()?
        .with_context(|| format!("unknown run {run_id}"))?;
    let current = RunStatus::parse(&current)?;

    let target = update.status.unwrap_or(current);
    validate_transition(current, target)?;

    let now = now_millis();
    let started_at_marker = matches!(target, RunStatus::Starting | RunStatus::Running);
    let finished = target.is_terminal();

    tx.execute(
        "UPDATE runs SET
             status = ?2,
             updated_at = ?3,
             started_at = CASE WHEN started_at IS NULL AND ?4 = 1 THEN ?3 ELSE started_at END,
             finished_at = CASE WHEN ?5 = 1 THEN COALESCE(finished_at, ?3) ELSE finished_at END,
             hermes_run_id = COALESCE(?6, hermes_run_id),
             terminal_reason = COALESCE(?7, terminal_reason),
             error_code = COALESCE(?8, error_code),
             error_message = COALESCE(?9, error_message),
             result_payload = COALESCE(?10, result_payload),
             recovery_note = COALESCE(?11, recovery_note)
         WHERE run_id = ?1",
        params![
            run_id,
            target.as_str(),
            now,
            started_at_marker as i64,
            finished as i64,
            update.hermes_run_id,
            update.terminal_reason,
            update.error_code,
            update.error_message,
            update
                .result_payload
                .as_ref()
                .map(|value| serde_json::to_string(&redact::redact(value).value))
                .transpose()?,
            update.recovery_note,
        ],
    )?;

    Ok(())
}

fn load_run(conn: &Connection, run_id: &str) -> Result<Option<RunRecord>> {
    let record = conn
        .query_row(
            "SELECT run_id, project_id, session_id, idempotency_key, runtime_kind, provider,
                    model, status, created_at, started_at, updated_at, finished_at,
                    last_event_seq, terminal_reason, error_code, error_message, hermes_run_id,
                    request_payload, result_payload, recovery_note, retry_of_run_id
             FROM runs WHERE run_id = ?1",
            params![run_id],
            map_run,
        )
        .optional()?;
    Ok(record)
}

fn map_run(row: &Row<'_>) -> rusqlite::Result<RunRecord> {
    let request_payload: String = row.get(17)?;
    let result_payload: Option<String> = row.get(18)?;
    Ok(RunRecord {
        run_id: row.get(0)?,
        project_id: row.get(1)?,
        session_id: row.get(2)?,
        idempotency_key: row.get(3)?,
        runtime_kind: row.get(4)?,
        provider: row.get(5)?,
        model: row.get(6)?,
        status: row.get(7)?,
        created_at: row.get(8)?,
        started_at: row.get(9)?,
        updated_at: row.get(10)?,
        finished_at: row.get(11)?,
        last_event_seq: row.get(12)?,
        terminal_reason: row.get(13)?,
        error_code: row.get(14)?,
        error_message: row.get(15)?,
        hermes_run_id: row.get(16)?,
        request_payload: serde_json::from_str(&request_payload).unwrap_or(Value::Null),
        result_payload: result_payload.and_then(|encoded| serde_json::from_str(&encoded).ok()),
        recovery_note: row.get(19)?,
        retry_of_run_id: row.get(20)?,
    })
}

fn map_event(row: &Row<'_>) -> rusqlite::Result<StoredEvent> {
    let payload: String = row.get(5)?;
    let raw_payload: Option<String> = row.get(6)?;
    let redacted: i64 = row.get(7)?;
    Ok(StoredEvent {
        run_id: row.get(0)?,
        seq: row.get(1)?,
        event_type: row.get(2)?,
        recorded_at: row.get(3)?,
        source: row.get(4)?,
        payload: serde_json::from_str(&payload).unwrap_or(Value::Null),
        raw_payload: raw_payload.and_then(|encoded| serde_json::from_str(&encoded).ok()),
        redacted: redacted != 0,
    })
}

fn map_approval(row: &Row<'_>) -> rusqlite::Result<ApprovalRecord> {
    let choices: Option<String> = row.get(4)?;
    Ok(ApprovalRecord {
        run_id: row.get(0)?,
        request_seq: row.get(1)?,
        requested_at: row.get(2)?,
        command: row.get(3)?,
        choices: choices.and_then(|encoded| serde_json::from_str(&encoded).ok()),
        decision: row.get(5)?,
        decided_at: row.get(6)?,
        resolution_seq: row.get(7)?,
    })
}

pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// Asterism-owned run identifier, independent of the Hermes run id.
fn new_run_id() -> String {
    let mut bytes = [0u8; 12];
    if std::fs::File::open("/dev/urandom")
        .and_then(|mut file| std::io::Read::read_exact(&mut file, &mut bytes))
        .is_err()
    {
        // Deterministic fallback; the uniqueness that matters is enforced by the
        // primary key, which would reject a collision outright.
        let stamp = now_millis().to_le_bytes();
        bytes[..8].copy_from_slice(&stamp);
        bytes[8..].copy_from_slice(&std::process::id().to_le_bytes());
    }
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("arun_{hex}")
}

/// Stable digest of the parts of a request that make it "the same request".
///
/// FNV-1a over canonical JSON. This is a change detector for idempotency, not a
/// security control, so a non-cryptographic hash is appropriate.
fn request_fingerprint(request: &NewRun) -> String {
    let canonical = json!({
        "project_id": request.project_id,
        "session_id": request.session_id,
        "runtime_kind": request.runtime_kind,
        "request": redact::redact(&request.request_payload).value,
    });
    fingerprint_value(&canonical)
}

/// FNV-1a digest of a JSON value's canonical encoding.
///
/// `serde_json` orders object keys, so the encoding is stable for equal values.
/// Used for change detection and event identity, never as a security control.
pub fn fingerprint_value(value: &Value) -> String {
    let encoded = serde_json::to_string(value).unwrap_or_default();

    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in encoded.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

const MIGRATION_001: &str = "
CREATE TABLE runs (
    run_id              TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    session_id          TEXT,
    idempotency_key     TEXT,
    runtime_kind        TEXT NOT NULL,
    provider            TEXT,
    model               TEXT,
    status              TEXT NOT NULL,
    created_at          INTEGER NOT NULL,
    started_at          INTEGER,
    updated_at          INTEGER NOT NULL,
    finished_at         INTEGER,
    last_event_seq      INTEGER NOT NULL DEFAULT 0,
    terminal_reason     TEXT,
    error_code          TEXT,
    error_message       TEXT,
    hermes_run_id       TEXT,
    request_payload     TEXT NOT NULL,
    result_payload      TEXT,
    recovery_note       TEXT,
    request_fingerprint TEXT NOT NULL
);

-- One run per (project, idempotency key). Enforced by the database so that two
-- concurrent Node processes cannot both create an execution for one key.
CREATE UNIQUE INDEX runs_idempotency
    ON runs (project_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX runs_hermes_run_id
    ON runs (hermes_run_id)
    WHERE hermes_run_id IS NOT NULL;

CREATE INDEX runs_project_created ON runs (project_id, created_at DESC);

CREATE TABLE run_events (
    run_id      TEXT NOT NULL REFERENCES runs (run_id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,
    event_type  TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    source      TEXT NOT NULL,
    payload     TEXT NOT NULL,
    raw_payload TEXT,
    redacted    INTEGER NOT NULL DEFAULT 0,
    dedupe_key  TEXT,
    PRIMARY KEY (run_id, seq)
);

-- Suppresses duplicate delivery of the same backend event.
CREATE UNIQUE INDEX run_events_dedupe
    ON run_events (run_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL;

CREATE TABLE run_approvals (
    run_id         TEXT NOT NULL REFERENCES runs (run_id) ON DELETE CASCADE,
    request_seq    INTEGER NOT NULL,
    requested_at   INTEGER NOT NULL,
    command        TEXT,
    choices        TEXT,
    decision       TEXT,
    decided_at     INTEGER,
    resolution_seq INTEGER,
    PRIMARY KEY (run_id, request_seq)
);
";

/// Phase E: the corrected run state model.
///
/// `interrupted` and `lost` become terminal, and recovery happens through an
/// explicit retry that creates a new run linked back to the original. Existing
/// Phase D records are preserved: none is deleted or re-statused. The only
/// repair is backfilling `finished_at` for rows that are terminal under the new
/// model but were written while `interrupted` was still considered active, so
/// that "terminal implies finished" holds for every row.
const MIGRATION_002: &str = "
ALTER TABLE runs ADD COLUMN retry_of_run_id TEXT REFERENCES runs (run_id);

CREATE INDEX runs_retry_of ON runs (retry_of_run_id)
    WHERE retry_of_run_id IS NOT NULL;

UPDATE runs
   SET finished_at = COALESCE(finished_at, updated_at),
       recovery_note = COALESCE(
           recovery_note,
           'reclassified by schema v2: interrupted and lost are terminal states'
       )
 WHERE status IN ('interrupted', 'lost')
   AND finished_at IS NULL;
";

/// Phase F: Node-owned remote state.
///
/// All four tables live in the Node registry, which no project container binds,
/// so a project agent can reach none of it.
const MIGRATION_003: &str = "
-- Projects the Control Plane may address. A remote command names a project id;
-- the host path is resolved here and is never accepted from the wire.
CREATE TABLE projects (
    project_id     TEXT PRIMARY KEY,
    workspace_path TEXT NOT NULL,
    display_name   TEXT NOT NULL,
    enabled        INTEGER NOT NULL DEFAULT 1,
    created_at     INTEGER NOT NULL,
    metadata       TEXT
);

-- At-least-once remote delivery, executed at most once. The command id is the
-- deduplication key; the digest detects a reused id carrying different work.
CREATE TABLE remote_commands (
    command_id       TEXT PRIMARY KEY,
    command          TEXT NOT NULL,
    project_id       TEXT,
    received_at      INTEGER NOT NULL,
    payload_digest   TEXT NOT NULL,
    state            TEXT NOT NULL,
    started_at       INTEGER,
    completed_at     INTEGER,
    response_payload TEXT,
    error_code       TEXT,
    error_message    TEXT
);

CREATE INDEX remote_commands_state ON remote_commands (state);

-- Messages that must survive a reconnect because they cannot be re-derived
-- from the event journal.
CREATE TABLE outbox (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    kind            TEXT NOT NULL,
    correlation_id  TEXT,
    payload         TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    acknowledged_at INTEGER
);

CREATE INDEX outbox_pending ON outbox (id) WHERE acknowledged_at IS NULL;

-- Only the cursor is persisted. Events themselves stay in the journal, which
-- already provides durable replay; duplicating them would create a second
-- source of truth.
CREATE TABLE event_subscriptions (
    run_id     TEXT PRIMARY KEY REFERENCES runs (run_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    acked_seq  INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
";

// A Node supervises several projects, and each project has its own runtime
// container listening on its own host port. Without a per-project endpoint the
// Node can only ever address one of them, so multi-project operation is
// impossible. NULL means "use the Node-wide default", which is what every
// project registered before this migration was implicitly doing.
const MIGRATION_004: &str = "
ALTER TABLE projects ADD COLUMN runtime_endpoint TEXT;
";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runstate::RunStatus;

    #[test]
    fn reopening_a_wal_registry_waits_for_an_active_writer() {
        let dir = tempfile::tempdir().unwrap();
        let writer = Registry::open(dir.path()).unwrap();
        writer.conn.execute_batch("BEGIN IMMEDIATE").unwrap();

        let path = dir.path().to_owned();
        let reopening = std::thread::spawn(move || Registry::open(path).map(|_| ()));
        std::thread::sleep(std::time::Duration::from_millis(100));
        writer.conn.execute_batch("COMMIT").unwrap();

        reopening.join().unwrap().unwrap();
    }

    #[test]
    fn appending_to_a_wal_registry_waits_for_an_active_writer() {
        let dir = tempfile::tempdir().unwrap();
        let mut registry = Registry::open(dir.path()).unwrap();
        let run = registry
            .create_run(&new_run("p1"))
            .unwrap()
            .record()
            .clone();
        let writer = Registry::open(dir.path()).unwrap();
        writer.conn.execute_batch("BEGIN IMMEDIATE").unwrap();

        let path = dir.path().to_owned();
        let run_id = run.run_id.clone();
        let appending = std::thread::spawn(move || {
            let mut concurrent = Registry::open(path)?;
            concurrent.append_event(
                &run_id,
                &JournalEvent::asterism("test.concurrent", json!({})),
                None,
            )?;
            Ok::<(), anyhow::Error>(())
        });
        std::thread::sleep(std::time::Duration::from_millis(100));
        writer.conn.execute_batch("COMMIT").unwrap();

        appending.join().unwrap().unwrap();
        assert_eq!(registry.events_since(&run.run_id, 0, 10).unwrap().len(), 1);
    }

    fn new_run(project: &str) -> NewRun {
        NewRun {
            project_id: project.to_owned(),
            session_id: Some("s1".to_owned()),
            idempotency_key: None,
            runtime_kind: "hermes-loop".to_owned(),
            provider: Some("openai-codex".to_owned()),
            model: Some("gpt-5.6-sol".to_owned()),
            request_payload: json!({"input": "do the thing"}),
            retry_of_run_id: None,
        }
    }

    fn registry() -> Registry {
        Registry::open_in_memory().unwrap()
    }

    #[test]
    fn schema_is_created_at_the_current_version() {
        let registry = registry();
        assert_eq!(registry.schema_version().unwrap(), SCHEMA_VERSION);
    }

    #[test]
    fn migrations_are_idempotent_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = Registry::path_for(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();

        let first = Registry::open_at(&path).unwrap();
        assert_eq!(first.schema_version().unwrap(), SCHEMA_VERSION);
        drop(first);

        let second = Registry::open_at(&path).unwrap();
        assert_eq!(second.schema_version().unwrap(), SCHEMA_VERSION);
    }

    #[test]
    fn schema_v2_preserves_phase_d_records_and_settles_terminal_timestamps() {
        let dir = tempfile::tempdir().unwrap();
        let path = Registry::path_for(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();

        // Build a v1 database by hand, exactly as Phase D left it.
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE schema_version (version INTEGER NOT NULL);
                 INSERT INTO schema_version (version) VALUES (0);",
            )
            .unwrap();
            conn.execute_batch(MIGRATION_001).unwrap();
            conn.execute("UPDATE schema_version SET version = 1", [])
                .unwrap();
            // One run left non-terminal under the old meaning of `interrupted`,
            // and one already-settled run that must not be touched.
            conn.execute(
                "INSERT INTO runs (run_id, project_id, runtime_kind, status, created_at,
                                   updated_at, last_event_seq, request_payload, request_fingerprint)
                 VALUES ('arun_old', 'p1', 'hermes-loop', 'interrupted', 10, 20, 5, '{}', 'fp')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO runs (run_id, project_id, runtime_kind, status, created_at,
                                   updated_at, finished_at, last_event_seq, request_payload,
                                   request_fingerprint, recovery_note)
                 VALUES ('arun_done', 'p1', 'hermes-loop', 'completed', 10, 20, 30, 9, '{}',
                         'fp2', 'original note')",
                [],
            )
            .unwrap();
        }

        let registry = Registry::open_at(&path).unwrap();
        assert_eq!(registry.schema_version().unwrap(), SCHEMA_VERSION);

        // Both records survive.
        let old = registry.run("arun_old").unwrap().unwrap();
        let done = registry.run("arun_done").unwrap().unwrap();
        assert_eq!(old.status, "interrupted");
        assert_eq!(old.last_event_seq, 5);
        assert_eq!(done.status, "completed");

        // The now-terminal record gains a finish timestamp and an explanation.
        assert_eq!(old.finished_at, Some(20));
        assert!(old.recovery_note.unwrap().contains("schema v2"));

        // An already-settled record keeps its own values.
        assert_eq!(done.finished_at, Some(30));
        assert_eq!(done.recovery_note.as_deref(), Some("original note"));

        // The new column exists and defaults to unset.
        assert_eq!(old.retry_of_run_id, None);
    }

    #[test]
    fn a_retry_links_back_to_the_run_it_replaces() {
        let mut registry = registry();
        let original = registry
            .create_run(&new_run("p1"))
            .unwrap()
            .record()
            .clone();

        let mut replacement = new_run("p1");
        replacement.retry_of_run_id = Some(original.run_id.clone());
        let retry = registry.create_run(&replacement).unwrap().record().clone();

        assert_ne!(retry.run_id, original.run_id);
        assert_eq!(
            retry.retry_of_run_id.as_deref(),
            Some(original.run_id.as_str())
        );
        // The original is untouched by the retry.
        let original_after = registry.run(&original.run_id).unwrap().unwrap();
        assert_eq!(original_after, original);
    }

    #[test]
    fn refuses_a_schema_newer_than_this_build() {
        let dir = tempfile::tempdir().unwrap();
        let path = Registry::path_for(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        {
            let registry = Registry::open_at(&path).unwrap();
            registry
                .conn
                .execute("UPDATE schema_version SET version = 99", [])
                .unwrap();
        }

        assert!(Registry::open_at(&path).is_err());
    }

    #[test]
    fn corrupt_database_files_fail_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.db");
        std::fs::write(&path, b"this is definitely not a sqlite database").unwrap();

        assert!(Registry::open_at(&path).is_err());
    }

    #[test]
    fn creates_a_run_in_the_created_state() {
        let mut registry = registry();
        let creation = registry.create_run(&new_run("p1")).unwrap();

        assert!(creation.is_new());
        let record = creation.record();
        assert_eq!(record.status, RunStatus::Created.as_str());
        assert_eq!(record.project_id, "p1");
        assert_eq!(record.last_event_seq, 0);
        assert!(record.run_id.starts_with("arun_"));
    }

    #[test]
    fn run_identifiers_are_unique() {
        let mut registry = registry();
        let a = registry.create_run(&new_run("p1")).unwrap();
        let b = registry.create_run(&new_run("p1")).unwrap();
        assert_ne!(a.record().run_id, b.record().run_id);
    }

    #[test]
    fn valid_transitions_are_applied() {
        let mut registry = registry();
        let run = registry
            .create_run(&new_run("p1"))
            .unwrap()
            .record()
            .clone();

        registry
            .update_run(&run.run_id, &RunUpdate::status(RunStatus::Starting))
            .unwrap();
        let record = registry
            .update_run(
                &run.run_id,
                &RunUpdate::status(RunStatus::Running).with_hermes_run_id("run_hermes_1"),
            )
            .unwrap();

        assert_eq!(record.status, "running");
        assert_eq!(record.hermes_run_id.as_deref(), Some("run_hermes_1"));
        assert!(record.started_at.is_some());
        assert!(record.finished_at.is_none());
    }

    #[test]
    fn invalid_transitions_are_rejected_deterministically() {
        let mut registry = registry();
        let run = registry
            .create_run(&new_run("p1"))
            .unwrap()
            .record()
            .clone();

        // created -> running skips submission and must be refused.
        assert!(
            registry
                .update_run(&run.run_id, &RunUpdate::status(RunStatus::Running))
                .is_err()
        );
        assert_eq!(
            registry.run(&run.run_id).unwrap().unwrap().status,
            "created"
        );
    }

    #[test]
    fn terminal_runs_are_immutable() {
        let mut registry = registry();
        let run = registry
            .create_run(&new_run("p1"))
            .unwrap()
            .record()
            .clone();
        registry
            .update_run(&run.run_id, &RunUpdate::status(RunStatus::Starting))
            .unwrap();
        registry
            .update_run(&run.run_id, &RunUpdate::status(RunStatus::Completed))
            .unwrap();

        assert!(
            registry
                .update_run(&run.run_id, &RunUpdate::status(RunStatus::Failed))
                .is_err()
        );
        let record = registry.run(&run.run_id).unwrap().unwrap();
        assert_eq!(record.status, "completed");
        assert!(record.finished_at.is_some());
    }

    #[test]
    fn recovery_metadata_can_be_attached_to_a_terminal_run() {
        let mut registry = registry();
        let run = registry
            .create_run(&new_run("p1"))
            .unwrap()
            .record()
            .clone();
        registry
            .update_run(&run.run_id, &RunUpdate::status(RunStatus::Starting))
            .unwrap();
        registry
            .update_run(&run.run_id, &RunUpdate::status(RunStatus::Completed))
            .unwrap();

        let record = registry
            .update_run(
                &run.run_id,
                &RunUpdate::default().with_recovery_note("events were missed"),
            )
            .unwrap();

        assert_eq!(record.status, "completed");
        assert_eq!(record.recovery_note.as_deref(), Some("events were missed"));
    }

    #[test]
    fn events_receive_monotonic_sequence_numbers() {
        let mut registry = registry();
        let run = registry
            .create_run(&new_run("p1"))
            .unwrap()
            .record()
            .clone();

        for index in 0..5 {
            let outcome = registry
                .append_event(
                    &run.run_id,
                    &JournalEvent::asterism("test.event", json!({"index": index})),
                    None,
                )
                .unwrap();
            assert_eq!(outcome, AppendOutcome::Appended(index + 1));
        }

        let events = registry.events_since(&run.run_id, 0, 100).unwrap();
        assert_eq!(events.len(), 5);
        let seqs: Vec<i64> = events.iter().map(|event| event.seq).collect();
        assert_eq!(seqs, vec![1, 2, 3, 4, 5]);
        assert_eq!(
            registry.run(&run.run_id).unwrap().unwrap().last_event_seq,
            5
        );
    }

    #[test]
    fn duplicate_backend_events_do_not_create_duplicate_entries() {
        let mut registry = registry();
        let run = registry
            .create_run(&new_run("p1"))
            .unwrap()
            .record()
            .clone();

        let mut event = JournalEvent::asterism("hermes.event", json!({"a": 1}));
        event.dedupe_key = Some("hermes-seq-7".to_owned());

        let first = registry.append_event(&run.run_id, &event, None).unwrap();
        let second = registry.append_event(&run.run_id, &event, None).unwrap();

        assert_eq!(first, AppendOutcome::Appended(1));
        assert_eq!(second, AppendOutcome::Duplicate(1));
        assert_eq!(registry.events_since(&run.run_id, 0, 100).unwrap().len(), 1);
    }

    #[test]
    fn event_append_and_status_change_share_one_transaction() {
        let mut registry = registry();
        let run = registry
            .create_run(&new_run("p1"))
            .unwrap()
            .record()
            .clone();
        registry
            .update_run(&run.run_id, &RunUpdate::status(RunStatus::Starting))
            .unwrap();

        // An illegal transition must roll the append back with it.
        let result = registry.append_event(
            &run.run_id,
            &JournalEvent::asterism("test.event", json!({})),
            Some(&RunUpdate::status(RunStatus::Created)),
        );

        assert!(result.is_err());
        assert_eq!(registry.events_since(&run.run_id, 0, 10).unwrap().len(), 0);
        assert_eq!(
            registry.run(&run.run_id).unwrap().unwrap().last_event_seq,
            0
        );
    }

    #[test]
    fn events_cannot_be_appended_to_an_unknown_run() {
        let mut registry = registry();
        assert!(
            registry
                .append_event(
                    "arun_does_not_exist",
                    &JournalEvent::asterism("x", json!({})),
                    None
                )
                .is_err()
        );
    }

    #[test]
    fn secrets_are_redacted_before_reaching_storage() {
        let mut registry = registry();
        let run = registry
            .create_run(&new_run("p1"))
            .unwrap()
            .record()
            .clone();

        registry
            .append_event(
                &run.run_id,
                &JournalEvent {
                    event_type: "tool.completed".to_owned(),
                    source: SOURCE_HERMES.to_owned(),
                    payload: json!({"authorization": "Bearer supersecretvalue123"}),
                    raw: Some(json!({"access_token": "tok_supersecret"})),
                    dedupe_key: None,
                },
                None,
            )
            .unwrap();

        let events = registry.events_since(&run.run_id, 0, 10).unwrap();
        let encoded = serde_json::to_string(&events).unwrap();
        assert!(!encoded.contains("supersecretvalue123"));
        assert!(!encoded.contains("tok_supersecret"));
        assert!(events[0].redacted);
    }

    #[test]
    fn replay_from_a_cursor_returns_only_later_events_in_order() {
        let mut registry = registry();
        let run = registry
            .create_run(&new_run("p1"))
            .unwrap()
            .record()
            .clone();
        for index in 0..6 {
            registry
                .append_event(
                    &run.run_id,
                    &JournalEvent::asterism("e", json!({"i": index})),
                    None,
                )
                .unwrap();
        }

        let tail = registry.events_since(&run.run_id, 3, 100).unwrap();
        assert_eq!(
            tail.iter().map(|event| event.seq).collect::<Vec<_>>(),
            vec![4, 5, 6]
        );

        let bounded = registry.events_since(&run.run_id, 0, 2).unwrap();
        assert_eq!(bounded.len(), 2);
        assert_eq!(bounded[0].seq, 1);
    }

    #[test]
    fn idempotent_creation_returns_the_existing_run() {
        let mut registry = registry();
        let mut request = new_run("p1");
        request.idempotency_key = Some("key-1".to_owned());

        let first = registry.create_run(&request).unwrap();
        let second = registry.create_run(&request).unwrap();

        assert!(first.is_new());
        assert!(!second.is_new());
        assert_eq!(first.record().run_id, second.record().run_id);
        assert_eq!(registry.list_runs("p1", 10).unwrap().len(), 1);
    }

    #[test]
    fn idempotency_key_reused_with_a_different_request_is_a_conflict() {
        let mut registry = registry();
        let mut request = new_run("p1");
        request.idempotency_key = Some("key-1".to_owned());
        registry.create_run(&request).unwrap();

        request.request_payload = json!({"input": "something else entirely"});
        let error = registry.create_run(&request).unwrap_err();

        assert!(error.downcast_ref::<IdempotencyConflict>().is_some());
        assert_eq!(registry.list_runs("p1", 10).unwrap().len(), 1);
    }

    #[test]
    fn idempotency_keys_are_scoped_per_project() {
        let mut registry = registry();
        let mut a = new_run("p1");
        a.idempotency_key = Some("shared".to_owned());
        let mut b = new_run("p2");
        b.idempotency_key = Some("shared".to_owned());

        let first = registry.create_run(&a).unwrap();
        let second = registry.create_run(&b).unwrap();

        assert!(first.is_new());
        assert!(second.is_new());
        assert_ne!(first.record().run_id, second.record().run_id);
    }

    #[test]
    fn runs_are_listed_per_project_newest_first() {
        let mut registry = registry();
        let first = registry
            .create_run(&new_run("p1"))
            .unwrap()
            .record()
            .clone();
        let second = registry
            .create_run(&new_run("p1"))
            .unwrap()
            .record()
            .clone();
        registry.create_run(&new_run("other")).unwrap();

        let runs = registry.list_runs("p1", 10).unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].run_id, second.run_id);
        assert_eq!(runs[1].run_id, first.run_id);
    }

    #[test]
    fn active_runs_exclude_terminal_records() {
        let mut registry = registry();
        let done = registry
            .create_run(&new_run("p1"))
            .unwrap()
            .record()
            .clone();
        registry
            .update_run(&done.run_id, &RunUpdate::status(RunStatus::Starting))
            .unwrap();
        registry
            .update_run(&done.run_id, &RunUpdate::status(RunStatus::Completed))
            .unwrap();
        let live = registry
            .create_run(&new_run("p1"))
            .unwrap()
            .record()
            .clone();

        let active = registry.active_runs("p1").unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].run_id, live.run_id);
    }

    #[test]
    fn terminal_records_persist_their_outcome() {
        let mut registry = registry();
        for (status, code) in [
            (RunStatus::Completed, None),
            (RunStatus::Failed, Some("provider_error")),
            (RunStatus::Cancelled, None),
        ] {
            let run = registry
                .create_run(&new_run("p1"))
                .unwrap()
                .record()
                .clone();
            registry
                .update_run(&run.run_id, &RunUpdate::status(RunStatus::Starting))
                .unwrap();
            let mut update = RunUpdate::status(status).with_terminal_reason("test");
            if let Some(code) = code {
                update = update.with_error(code, "boom");
            }
            registry.update_run(&run.run_id, &update).unwrap();

            let record = registry.run(&run.run_id).unwrap().unwrap();
            assert_eq!(record.status, status.as_str());
            assert!(record.finished_at.is_some());
            assert_eq!(record.terminal_reason.as_deref(), Some("test"));
            assert_eq!(record.error_code.as_deref(), code);
        }
    }

    #[test]
    fn approval_decisions_are_applied_at_most_once() {
        let mut registry = registry();
        let run = registry
            .create_run(&new_run("p1"))
            .unwrap()
            .record()
            .clone();
        registry
            .append_event(
                &run.run_id,
                &JournalEvent::asterism("approval.request", json!({"command": "rm -rf x"})),
                None,
            )
            .unwrap();
        registry
            .record_approval_request(
                &run.run_id,
                1,
                Some("rm -rf x"),
                Some(&json!(["once", "deny"])),
            )
            .unwrap();

        assert!(registry.pending_approval(&run.run_id).unwrap().is_some());
        assert!(
            registry
                .record_approval_decision(&run.run_id, 1, "deny")
                .unwrap()
        );
        // A retry must not overwrite the first decision.
        assert!(
            !registry
                .record_approval_decision(&run.run_id, 1, "once")
                .unwrap()
        );

        let approvals = registry.approvals(&run.run_id).unwrap();
        assert_eq!(approvals.len(), 1);
        assert_eq!(approvals[0].decision.as_deref(), Some("deny"));
        assert!(registry.pending_approval(&run.run_id).unwrap().is_none());
    }

    #[test]
    fn approval_requests_are_recorded_once_per_sequence() {
        let mut registry = registry();
        let run = registry
            .create_run(&new_run("p1"))
            .unwrap()
            .record()
            .clone();
        registry
            .append_event(
                &run.run_id,
                &JournalEvent::asterism("approval.request", json!({})),
                None,
            )
            .unwrap();

        registry
            .record_approval_request(&run.run_id, 1, Some("cmd"), None)
            .unwrap();
        registry
            .record_approval_request(&run.run_id, 1, Some("cmd"), None)
            .unwrap();

        assert_eq!(registry.approvals(&run.run_id).unwrap().len(), 1);
    }

    #[test]
    fn state_survives_reopening_the_database() {
        let dir = tempfile::tempdir().unwrap();
        let run_id;
        {
            let mut registry = Registry::open(dir.path()).unwrap();
            let run = registry
                .create_run(&new_run("p1"))
                .unwrap()
                .record()
                .clone();
            run_id = run.run_id.clone();
            registry
                .update_run(&run_id, &RunUpdate::status(RunStatus::Starting))
                .unwrap();
            registry
                .append_event(&run_id, &JournalEvent::asterism("e", json!({"i": 1})), None)
                .unwrap();
        }

        // Simulates a Node restart: a brand-new process opens the same file.
        let registry = Registry::open(dir.path()).unwrap();
        let record = registry.run(&run_id).unwrap().unwrap();
        assert_eq!(record.status, "starting");
        assert_eq!(record.last_event_seq, 1);
        assert_eq!(registry.events_since(&run_id, 0, 10).unwrap().len(), 1);
    }

    #[test]
    fn registry_path_sits_under_the_node_state_root() {
        let path = Registry::path_for("/srv/asterism/state");
        assert_eq!(path, PathBuf::from("/srv/asterism/state/node/registry.db"));
        // Must not live under a project directory that a container binds.
        assert!(!path.to_string_lossy().contains("/hermes"));
        assert!(!path.to_string_lossy().contains("/workspace"));
    }

    #[test]
    fn lookup_by_hermes_run_id_finds_the_owning_record() {
        let mut registry = registry();
        let run = registry
            .create_run(&new_run("p1"))
            .unwrap()
            .record()
            .clone();
        registry
            .update_run(&run.run_id, &RunUpdate::status(RunStatus::Starting))
            .unwrap();
        registry
            .update_run(
                &run.run_id,
                &RunUpdate::status(RunStatus::Running).with_hermes_run_id("run_backend_9"),
            )
            .unwrap();

        let found = registry.run_by_hermes_id("run_backend_9").unwrap().unwrap();
        assert_eq!(found.run_id, run.run_id);
        assert!(registry.run_by_hermes_id("run_nope").unwrap().is_none());
    }

    #[test]
    fn unknown_event_types_are_preserved_verbatim() {
        let mut registry = registry();
        let run = registry
            .create_run(&new_run("p1"))
            .unwrap()
            .record()
            .clone();
        registry
            .append_event(
                &run.run_id,
                &JournalEvent {
                    event_type: "some.future.event".to_owned(),
                    source: SOURCE_HERMES.to_owned(),
                    payload: json!({"unknown_field": [1, 2, 3]}),
                    raw: Some(json!({"unknown_field": [1, 2, 3]})),
                    dedupe_key: None,
                },
                None,
            )
            .unwrap();

        let events = registry.events_since(&run.run_id, 0, 10).unwrap();
        assert_eq!(events[0].event_type, "some.future.event");
        assert_eq!(events[0].payload["unknown_field"], json!([1, 2, 3]));
        assert!(!events[0].redacted);
    }
}
