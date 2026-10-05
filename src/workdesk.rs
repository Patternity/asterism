//! The Workdesk bridge: how an executing agent's structured reports reach the
//! Control Plane without the agent ever holding a Control Plane credential.
//!
//! Hermes 0.20.3 ships a kanban toolset — `kanban_heartbeat`, `kanban_comment`,
//! `kanban_block`, `kanban_request_review`, `kanban_complete` and the rest.
//! Those are real registered tools with JSON schemas, and they write to
//! `kanban.db` inside the agent's own Hermes home. Each Asterism project
//! already has its own home, and therefore its own board.
//!
//! So the path is: the agent calls a tool, the row lands in the project's
//! board, this Node reads it and forwards it over the channel it is already
//! authenticated on.
//!
//! # Why the board cannot be trusted about itself
//!
//! Everything with filesystem access to that home can write a row into
//! `kanban.db`, including the agent. A row can name any task it likes. So the
//! association between a card and an Asterism task is never read from the
//! board: the Node *mints* the card id, records
//! `(card_id, task_id, run_id, generation)` in its own registry — which the
//! agent's home cannot reach — and forwards reports stamped from that row.
//!
//! # Two independent protections against a second executor
//!
//! Every `hermes gateway` process starts a kanban dispatcher watcher, gated by
//! `kanban.dispatch_in_gateway`, which defaults to **true**. This Node runs a
//! gateway per project. A card in a claimable state would therefore be picked
//! up and executed by Hermes itself — outside Asterism's credential, model,
//! single-flight, approval and audit path.
//!
//! Both of these hold, and neither is allowed to be the reason the other works:
//!
//! 1. the project's configuration sets `kanban.dispatch_in_gateway: false`;
//! 2. the minted card is created `running`, which no dispatcher claims.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// Card states a Hermes dispatcher will claim and execute.
///
/// From `hermes_cli/kanban_db.py`: a dispatch tick looks for work that is
/// waiting, and `running` is what a claimed card already is.
pub const DISPATCHABLE_CARD_STATES: &[&str] = &["todo", "ready", "scheduled", "triage"];

/// The state a minted card is created in: already claimed, so there is nothing
/// for a dispatcher to pick up even if one is running.
pub const MINTED_CARD_STATE: &str = "running";

/// Does this state leave a card open to being claimed and executed by Hermes?
pub fn is_dispatchable_state(state: &str) -> bool {
    DISPATCHABLE_CARD_STATES.contains(&state)
}

/// The binding that makes a card answerable: minted here, never read from the
/// board.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CardBinding {
    pub card_id: String,
    pub project_id: String,
    pub task_id: String,
    pub run_id: String,
    pub generation: i64,
}

/// A task attached to a `runs.create` command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskBinding {
    pub task_id: String,
    pub generation: i64,
}

/// Why a task attachment could not be read.
///
/// Carried as a slug so the Control Plane can show the same reason against the
/// command and the Task rather than inventing its own wording.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MalformedTask {
    /// `task` is present but is not an object.
    NotAnObject,
    /// No `task_id`, or it is not a string.
    MissingTaskId,
    /// A `task_id` of whitespace.
    EmptyTaskId,
    /// No `generation`, or it is not an integer.
    MissingGeneration,
    /// A negative generation, which no attempt can have.
    NegativeGeneration,
}

impl MalformedTask {
    pub fn slug(self) -> &'static str {
        match self {
            Self::NotAnObject => "task_not_an_object",
            Self::MissingTaskId => "task_id_missing",
            Self::EmptyTaskId => "task_id_empty",
            Self::MissingGeneration => "task_generation_missing",
            Self::NegativeGeneration => "task_generation_negative",
        }
    }

    /// What a person reads against the command and the task.
    pub fn message(self) -> &'static str {
        match self {
            Self::NotAnObject => "The run named a task in a shape this Node cannot read.",
            Self::MissingTaskId => "The run named a task without an id.",
            Self::EmptyTaskId => "The run named a task whose id is empty.",
            Self::MissingGeneration => "The run named a task without an execution generation.",
            Self::NegativeGeneration => {
                "The run named a task with an impossible execution generation."
            }
        }
    }

    /// The task id the attachment named, when there was a readable one.
    ///
    /// The Control Plane needs it to show the failure against the right Task;
    /// without it the failure belongs to the command alone.
    pub fn identifiable(self) -> bool {
        matches!(self, Self::MissingGeneration | Self::NegativeGeneration)
    }
}

/// What a command's task attachment turned out to be.
///
/// Three outcomes, deliberately not two. An ordinary run and a broken task run
/// must never look alike: executing a malformed task-bound request as if no
/// task had been named would run somebody's work with no record of which task
/// it belonged to, and report success for a task that never moved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskAttachment {
    /// No `task` key: an ordinary run, which is the overwhelming majority.
    Absent,
    /// A `task` key that cannot be read. Refused before anything executes.
    Malformed {
        reason: MalformedTask,
        /// Present when the attachment named a task clearly enough to blame.
        task_id: Option<String>,
    },
    Present(TaskBinding),
}

impl TaskAttachment {
    /// Read the attachment out of a command payload.
    pub fn from_payload(payload: &serde_json::Value) -> Self {
        let Some(task) = payload.get("task") else {
            return Self::Absent;
        };
        // An explicit null is a caller saying "no task", which is the same
        // thing as not saying anything.
        if task.is_null() {
            return Self::Absent;
        }
        let Some(task) = task.as_object() else {
            return Self::Malformed {
                reason: MalformedTask::NotAnObject,
                task_id: None,
            };
        };
        let Some(raw_id) = task.get("task_id").and_then(serde_json::Value::as_str) else {
            return Self::Malformed {
                reason: MalformedTask::MissingTaskId,
                task_id: None,
            };
        };
        let task_id = raw_id.trim();
        if task_id.is_empty() {
            return Self::Malformed {
                reason: MalformedTask::EmptyTaskId,
                task_id: None,
            };
        }
        let Some(generation) = task.get("generation").and_then(serde_json::Value::as_i64) else {
            return Self::Malformed {
                reason: MalformedTask::MissingGeneration,
                task_id: Some(task_id.to_owned()),
            };
        };
        if generation < 0 {
            return Self::Malformed {
                reason: MalformedTask::NegativeGeneration,
                task_id: Some(task_id.to_owned()),
            };
        }
        Self::Present(TaskBinding {
            task_id: task_id.to_owned(),
            generation,
        })
    }
}

/// What the agent reported, as this Node read it off the minted card.
///
/// Every variant is something a tool call produced. Nothing here is derived
/// from the assistant's prose, and nothing is inferred from a tool's name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
// Tagged `report` rather than `kind`: `kanban_block` has an argument of its
// own called `kind`, and keeping that name faithful to the tool matters more
// than the tag's.
#[serde(tag = "report", rename_all = "snake_case")]
pub enum AgentReport {
    /// `kanban_heartbeat`: the agent is alive and said what it is doing.
    Activity { note: String },
    /// `kanban_comment`: a durable note.
    Note { body: String },
    /// `kanban_block` with `kind = needs_input` and friends.
    Blocked { reason: String, kind: String },
    /// `kanban_request_review`: a result is ready for somebody to look at.
    ResultReady {
        summary: String,
        artifacts: Vec<String>,
    },
    /// `kanban_complete`: an explicit completion request.
    CompletionRequested {
        summary: String,
        artifacts: Vec<String>,
    },
    /// Linked child cards, read as an ordered plan.
    Plan { steps: Vec<String> },
}

/// The outbox kind a forwarded report is queued under.
pub const OUTBOX_TASK_REPORT: &str = "task.report";

/// One forwarded report, stamped from the Node's own binding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StampedReport {
    /// Deterministic identity: the same board row always produces the same id.
    ///
    /// This is what makes a retransmission safe. The outbox is at-least-once by
    /// design — a Node that committed a report and then lost the socket will
    /// send it again on reconnect — so the Control Plane must be able to
    /// recognise the second copy rather than hope it never arrives.
    pub report_id: String,
    pub task_id: String,
    pub run_id: String,
    pub generation: i64,
    /// Which row of the board this came from, within its stream.
    pub source_seq: i64,
    pub report: AgentReport,
}

/// Which board stream a row came from. Each has its own cursor, because they
/// advance independently.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportStream {
    Event,
    Comment,
}

impl ReportStream {
    fn tag(self) -> &'static str {
        match self {
            Self::Event => "event",
            Self::Comment => "comment",
        }
    }
}

/// Build the stamped report for one board row.
///
/// Everything identifying comes from the binding, which the Node minted; the
/// row supplies only its own sequence and what the agent wrote.
pub fn stamp(
    binding: &CardBinding,
    stream: ReportStream,
    source_seq: i64,
    report: AgentReport,
) -> StampedReport {
    StampedReport {
        report_id: format!(
            "{card}:{stream}:{seq}",
            card = binding.card_id,
            stream = stream.tag(),
            seq = source_seq
        ),
        task_id: binding.task_id.clone(),
        run_id: binding.run_id.clone(),
        generation: binding.generation,
        source_seq,
        report,
    }
}

/// Queue a report durably and move the cursor past it, in one transaction.
///
/// This is the delivery invariant, and the ordering is the whole point. A
/// successful socket write proves nothing: the process can die between the
/// write and the acknowledgement, and the Control Plane can drop the frame on a
/// reconnect. So the report goes into the outbox — the queue that already
/// survives a reconnect — and the cursor advances with it or not at all.
///
/// Either outcome is safe:
///
/// * commit — the report is durable and will be retransmitted until
///   acknowledged, and the board row will not be read again;
/// * rollback — neither happened, and the next read finds the row still there.
///
/// What cannot happen is the cursor moving past a report that was never queued,
/// which is the only way a `kanban_complete` could be lost for good.
pub fn enqueue_report(
    conn: &mut Connection,
    report: &StampedReport,
    stream: ReportStream,
    cursor: i64,
) -> Result<i64> {
    let payload = serde_json::to_string(report).context("cannot encode a task report")?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    // The card must still be bound, and the run must still be the one that
    // minted it. A report for a card whose binding has gone is not queued.
    let card_id = report
        .report_id
        .split(':')
        .next()
        .unwrap_or_default()
        .to_owned();
    let bound: i64 = tx.query_row(
        "SELECT count(*) FROM task_cards WHERE card_id = ?1 AND run_id = ?2 AND generation = ?3",
        rusqlite::params![card_id, report.run_id, report.generation],
        |row| row.get(0),
    )?;
    if bound == 0 {
        anyhow::bail!(
            "refusing to queue a report for card {card_id}: no binding for run {}",
            report.run_id
        );
    }

    tx.execute(
        "INSERT INTO outbox (kind, correlation_id, payload, created_at)
         VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![
            OUTBOX_TASK_REPORT,
            report.report_id,
            payload,
            crate::registry::now_millis(),
        ],
    )?;
    let id = tx.last_insert_rowid();

    match stream {
        ReportStream::Event => tx.execute(
            "UPDATE task_cards SET forwarded_event_seq = MAX(forwarded_event_seq, ?2)
              WHERE card_id = ?1",
            rusqlite::params![card_id, cursor],
        )?,
        ReportStream::Comment => tx.execute(
            "UPDATE task_cards SET forwarded_comment_seq = MAX(forwarded_comment_seq, ?2)
              WHERE card_id = ?1",
            rusqlite::params![card_id, cursor],
        )?,
    };

    tx.commit()?;
    Ok(id)
}

/// Whether the board must be read once more before a run's outcome is settled.
///
/// A `kanban_complete` is usually the last thing an agent does, so the row can
/// land after the final poll and before the run reports terminal. Resolving the
/// run first would lose exactly the report that matters most, so a successful
/// ending is always preceded by one more read.
///
/// A failed or cancelled run needs no final read for correctness — nothing
/// requested during it can produce completion — but it gets one anyway, because
/// the note the agent left about *why* it stopped is worth keeping.
pub fn final_read_required(terminal_status: &str) -> bool {
    !terminal_status.is_empty()
}

/// The project's board.
pub fn board_path(home: &Path) -> PathBuf {
    home.join("kanban.db")
}

/// Configuration this Node adds to a project's Hermes home for the bridge.
///
/// Returned as lines rather than written here so the one place that composes a
/// project's configuration keeps composing all of it.
///
/// `toolsets` is deliberately **not** set. In Hermes that key is a whitelist
/// that replaces the default tool set, so naming `kanban` there would take the
/// terminal, the file tools and everything else away from the agent. The tools
/// are enabled through the worker's environment instead; see
/// [`KANBAN_TASK_ENV`].
pub fn config_lines() -> String {
    "kanban:\n  dispatch_in_gateway: false\n".to_owned()
}

/// The variable that puts the kanban tools into the agent's schema.
///
/// Hermes enables them when this is set and the process is not a delegated
/// child. The value is a sentinel rather than a live card id: the worker is a
/// long-lived process shared by every run on this project, and rewriting its
/// environment per run would mean restarting it per run. The real card id
/// reaches the agent as addressing in the turn, and is checked against the
/// minted binding on the way back.
pub const KANBAN_TASK_ENV: &str = "HERMES_KANBAN_TASK";

/// What the sentinel is set to for a project.
pub fn kanban_env_value(project_id: &str) -> String {
    format!("asterism-project-{project_id}")
}

/// Record a minted card. The id is generated by the caller and must not come
/// from anywhere the agent can write.
pub fn record_binding(conn: &Connection, binding: &CardBinding, now: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO task_cards (card_id, project_id, task_id, run_id, generation, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            binding.card_id,
            binding.project_id,
            binding.task_id,
            binding.run_id,
            binding.generation,
            now,
        ],
    )
    .with_context(|| format!("cannot record the card for run {}", binding.run_id))?;
    Ok(())
}

/// The binding for one run, or nothing.
///
/// A report about a run with no binding is not forwarded: there is nothing to
/// stamp it with, and stamping it from the board would be the forgery this
/// whole arrangement exists to prevent.
pub fn binding_for_run(conn: &Connection, run_id: &str) -> Result<Option<CardBinding>> {
    let mut statement = conn.prepare(
        "SELECT card_id, project_id, task_id, run_id, generation
           FROM task_cards WHERE run_id = ?1",
    )?;
    let mut rows = statement.query([run_id])?;
    if let Some(row) = rows.next()? {
        return Ok(Some(CardBinding {
            card_id: row.get(0)?,
            project_id: row.get(1)?,
            task_id: row.get(2)?,
            run_id: row.get(3)?,
            generation: row.get(4)?,
        }));
    }
    Ok(None)
}

/// The binding for a card id, used when reading the board.
pub fn binding_for_card(conn: &Connection, card_id: &str) -> Result<Option<CardBinding>> {
    let mut statement = conn.prepare(
        "SELECT card_id, project_id, task_id, run_id, generation
           FROM task_cards WHERE card_id = ?1",
    )?;
    let mut rows = statement.query([card_id])?;
    if let Some(row) = rows.next()? {
        return Ok(Some(CardBinding {
            card_id: row.get(0)?,
            project_id: row.get(1)?,
            task_id: row.get(2)?,
            run_id: row.get(3)?,
            generation: row.get(4)?,
        }));
    }
    Ok(None)
}

/// Close a card once its run has ended, so the reader stops watching it.
pub fn close_card(conn: &Connection, run_id: &str, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE task_cards SET closed_at = ?2 WHERE run_id = ?1 AND closed_at IS NULL",
        rusqlite::params![run_id, now],
    )?;
    Ok(())
}

/// How far this card has been forwarded.
pub fn forwarded_marks(conn: &Connection, card_id: &str) -> Result<(i64, i64)> {
    let mut statement = conn.prepare(
        "SELECT forwarded_event_seq, forwarded_comment_seq FROM task_cards WHERE card_id = ?1",
    )?;
    let mut rows = statement.query([card_id])?;
    if let Some(row) = rows.next()? {
        return Ok((row.get(0)?, row.get(1)?));
    }
    Ok((0, 0))
}

/// Advance the forwarding marks. Monotonic: a lower mark is ignored, so a
/// reader that ran twice cannot rewind and resend.
pub fn advance_marks(conn: &Connection, card_id: &str, events: i64, comments: i64) -> Result<()> {
    conn.execute(
        "UPDATE task_cards
            SET forwarded_event_seq = MAX(forwarded_event_seq, ?2),
                forwarded_comment_seq = MAX(forwarded_comment_seq, ?3)
          WHERE card_id = ?1",
        rusqlite::params![card_id, events, comments],
    )?;
    Ok(())
}

/// Write the mirror card into the project's own board.
///
/// Created in [`MINTED_CARD_STATE`], which no dispatcher claims. The columns
/// are the ones Hermes requires; everything else is left to its defaults so a
/// future Hermes schema addition does not have to be mirrored here.
pub fn mint_card(
    board: &Path,
    binding: &CardBinding,
    title: &str,
    goal: &str,
    now: i64,
) -> Result<()> {
    let conn = Connection::open(board)
        .with_context(|| format!("cannot open the project board at {}", board.display()))?;
    // The board is created by the gateway at startup. If its tables are not
    // there yet, there is nothing to mint into and nothing to report; that is a
    // missing card, not a broken run.
    let has_tasks: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'tasks'",
        [],
        |row| row.get(0),
    )?;
    if has_tasks == 0 {
        anyhow::bail!("the project board has no tasks table yet");
    }
    conn.execute(
        "INSERT INTO tasks (id, title, body, status, created_by, created_at, workspace_kind)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'scratch')",
        rusqlite::params![
            binding.card_id,
            title,
            goal,
            MINTED_CARD_STATE,
            "asterism",
            now,
        ],
    )
    .with_context(|| format!("cannot mint the card for run {}", binding.run_id))?;
    Ok(())
}

/// What the agent is told about its card, appended to the turn it is given.
///
/// Addressing, not authority: it names the card so the tools have somewhere to
/// write, and the Node checks every report against the minted binding whatever
/// this says.
pub fn addressing_note(card_id: &str) -> String {
    format!(
        "You are working on Asterism task card `{card_id}`. Report progress with the kanban \
         tools, always passing task_id=\"{card_id}\": kanban_heartbeat for what you are doing \
         now, kanban_comment for a durable note, kanban_block with kind=\"needs_input\" when you \
         need something answered, kanban_request_review when a result is ready to be looked at, \
         and kanban_complete when the work is done. Nothing you write in an ordinary reply is \
         read as task state."
    )
}

/// What one pass over a card's board rows found, with the cursors to store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoardPass {
    pub reports: Vec<(ReportStream, i64, AgentReport)>,
    pub event_cursor: i64,
    pub comment_cursor: i64,
}

/// Read everything new on one minted card.
///
/// Only this card is read. A row naming another task is not this card's
/// business, and a card the agent invented has no binding, so nothing about it
/// can be stamped and nothing about it is read.
///
/// The event *kinds* come from Hermes — `heartbeat`, `commented`, `blocked`,
/// `review`, `completed`, `done` — and the content comes from the card's own
/// columns rather than from the event payload, because the card is where the
/// tool actually wrote the result.
pub fn read_board(
    board: &Path,
    card_id: &str,
    after_event: i64,
    after_comment: i64,
) -> Result<BoardPass> {
    let conn = Connection::open_with_flags(
        board,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .with_context(|| format!("cannot read the project board at {}", board.display()))?;

    let mut reports: Vec<(ReportStream, i64, AgentReport)> = Vec::new();
    let mut event_cursor = after_event;
    let mut comment_cursor = after_comment;

    // The card's own columns: what the tools wrote.
    let card: Option<(String, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT status, result, block_kind FROM tasks WHERE id = ?1",
            [card_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let (_status, result, block_kind) = match card {
        Some(found) => found,
        // No card: nothing to read, and nothing to advance past.
        None => {
            return Ok(BoardPass {
                reports,
                event_cursor,
                comment_cursor,
            });
        }
    };

    {
        let mut statement = conn.prepare(
            "SELECT id, kind, payload FROM task_events
              WHERE task_id = ?1 AND id > ?2 ORDER BY id",
        )?;
        let mut rows = statement.query(rusqlite::params![card_id, after_event])?;
        while let Some(row) = rows.next()? {
            let id: i64 = row.get(0)?;
            let kind: String = row.get(1)?;
            let payload: Option<String> = row.get(2)?;
            event_cursor = event_cursor.max(id);
            if let Some(report) = report_for_event(
                &kind,
                payload.as_deref(),
                result.as_deref(),
                block_kind.as_deref(),
            ) {
                reports.push((ReportStream::Event, id, report));
            }
        }
    }

    {
        let mut statement = conn.prepare(
            "SELECT id, body FROM task_comments WHERE task_id = ?1 AND id > ?2 ORDER BY id",
        )?;
        let mut rows = statement.query(rusqlite::params![card_id, after_comment])?;
        while let Some(row) = rows.next()? {
            let id: i64 = row.get(0)?;
            let body: String = row.get(1)?;
            comment_cursor = comment_cursor.max(id);
            if !body.trim().is_empty() {
                reports.push((ReportStream::Comment, id, AgentReport::Note { body }));
            }
        }
    }

    Ok(BoardPass {
        reports,
        event_cursor,
        comment_cursor,
    })
}

/// Which report a board event becomes, if any.
///
/// An unrecognised kind advances the cursor and produces nothing. That is the
/// right default: a future Hermes event this build does not understand must not
/// be guessed at, and must not be read again forever either.
fn report_for_event(
    kind: &str,
    payload: Option<&str>,
    result: Option<&str>,
    block_kind: Option<&str>,
) -> Option<AgentReport> {
    let field = |name: &str| -> Option<String> {
        let raw = payload?;
        let value: serde_json::Value = serde_json::from_str(raw).ok()?;
        value
            .get(name)
            .and_then(serde_json::Value::as_str)
            .map(|text| text.trim().to_owned())
            .filter(|text| !text.is_empty())
    };
    let artifacts = || -> Vec<String> {
        payload
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
            .and_then(|value| value.get("artifacts").cloned())
            .and_then(|value| value.as_array().cloned())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(ToOwned::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    };
    let summary = || field("summary").or_else(|| result.map(ToOwned::to_owned));

    match kind {
        "heartbeat" => Some(AgentReport::Activity {
            note: field("note").unwrap_or_else(|| "still working".to_owned()),
        }),
        "blocked" => Some(AgentReport::Blocked {
            reason: field("reason")
                .unwrap_or_else(|| "The agent stopped without saying why.".to_owned()),
            // The card's own typed reason, which is what routes it; an absent
            // one is the general case rather than a guess at a specific wall.
            kind: block_kind.unwrap_or("needs_input").to_owned(),
        }),
        "review" => Some(AgentReport::ResultReady {
            summary: summary()?,
            artifacts: artifacts(),
        }),
        "completed" | "done" => Some(AgentReport::CompletionRequested {
            summary: summary()?,
            artifacts: artifacts(),
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry(path: &Path) -> Connection {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE projects (project_id TEXT PRIMARY KEY);
             INSERT INTO projects (project_id) VALUES ('p1');
             CREATE TABLE outbox (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                kind            TEXT NOT NULL,
                correlation_id  TEXT,
                payload         TEXT NOT NULL,
                created_at      INTEGER NOT NULL,
                acknowledged_at INTEGER
             );
             CREATE TABLE task_cards (
                card_id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects (project_id) ON DELETE CASCADE,
                task_id TEXT NOT NULL,
                run_id TEXT NOT NULL UNIQUE,
                generation INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                forwarded_event_seq INTEGER NOT NULL DEFAULT 0,
                forwarded_comment_seq INTEGER NOT NULL DEFAULT 0,
                closed_at INTEGER
             );",
        )
        .unwrap();
        conn
    }

    fn binding(card: &str, run: &str, generation: i64) -> CardBinding {
        CardBinding {
            card_id: card.to_owned(),
            project_id: "p1".to_owned(),
            task_id: "tsk_1".to_owned(),
            run_id: run.to_owned(),
            generation,
        }
    }

    #[test]
    fn a_minted_card_is_created_in_a_state_no_dispatcher_claims() {
        // Protection two, on its own terms: this must hold even if the
        // configuration that disables the dispatcher were missing entirely.
        assert!(!is_dispatchable_state(MINTED_CARD_STATE));
        for state in DISPATCHABLE_CARD_STATES {
            assert!(is_dispatchable_state(state), "{state} should be claimable");
        }
    }

    #[test]
    fn the_configuration_disables_the_gateway_dispatcher() {
        // Protection one, on its own terms: this must hold even if a future
        // card were minted in a claimable state by mistake.
        let lines = config_lines();
        assert!(lines.contains("dispatch_in_gateway: false"));
        // And it must not reach for the toolsets whitelist, which would strip
        // every other tool from the agent.
        assert!(!lines.contains("toolsets"));
    }

    #[test]
    fn the_tools_are_enabled_through_the_environment_instead() {
        assert_eq!(KANBAN_TASK_ENV, "HERMES_KANBAN_TASK");
        assert_eq!(kanban_env_value("p1"), "asterism-project-p1");
    }

    #[test]
    fn a_valid_attachment_is_read() {
        let good = serde_json::json!({"input": "x", "task": {"task_id": "tsk_1", "generation": 3}});
        assert_eq!(
            TaskAttachment::from_payload(&good),
            TaskAttachment::Present(TaskBinding {
                task_id: "tsk_1".to_owned(),
                generation: 3,
            })
        );
        // Surrounding whitespace is addressing noise, not a different task.
        let padded = serde_json::json!({"task": {"task_id": "  tsk_1  ", "generation": 0}});
        assert_eq!(
            TaskAttachment::from_payload(&padded),
            TaskAttachment::Present(TaskBinding {
                task_id: "tsk_1".to_owned(),
                generation: 0,
            })
        );
    }

    #[test]
    fn no_attachment_at_all_is_an_ordinary_run() {
        // The overwhelming majority of runs, and the shape every Node that
        // predates Workdesk sends.
        for payload in [
            serde_json::json!({"input": "x"}),
            serde_json::json!({"input": "x", "task": null}),
            serde_json::json!({}),
        ] {
            assert_eq!(
                TaskAttachment::from_payload(&payload),
                TaskAttachment::Absent,
                "{payload}"
            );
        }
    }

    #[test]
    fn a_malformed_attachment_is_refused_rather_than_quietly_downgraded() {
        // This is the distinction that matters. Treating any of these as "no
        // task" would run somebody's work with no record of which task it
        // belonged to, and the Task would sit untouched while the run reported
        // success. Each one is a typed refusal instead.
        let cases = [
            (
                serde_json::json!({"task": "tsk_1"}),
                MalformedTask::NotAnObject,
                None,
            ),
            (
                serde_json::json!({"task": []}),
                MalformedTask::NotAnObject,
                None,
            ),
            (
                serde_json::json!({"task": 7}),
                MalformedTask::NotAnObject,
                None,
            ),
            (
                serde_json::json!({"task": {}}),
                MalformedTask::MissingTaskId,
                None,
            ),
            (
                serde_json::json!({"task": {"task_id": 7, "generation": 1}}),
                MalformedTask::MissingTaskId,
                None,
            ),
            (
                serde_json::json!({"task": {"task_id": "   ", "generation": 1}}),
                MalformedTask::EmptyTaskId,
                None,
            ),
            (
                serde_json::json!({"task": {"task_id": "tsk_1"}}),
                MalformedTask::MissingGeneration,
                Some("tsk_1"),
            ),
            (
                serde_json::json!({"task": {"task_id": "tsk_1", "generation": "3"}}),
                MalformedTask::MissingGeneration,
                Some("tsk_1"),
            ),
            (
                serde_json::json!({"task": {"task_id": "tsk_1", "generation": -1}}),
                MalformedTask::NegativeGeneration,
                Some("tsk_1"),
            ),
        ];
        for (payload, expected, blamed) in cases {
            match TaskAttachment::from_payload(&payload) {
                TaskAttachment::Malformed { reason, task_id } => {
                    assert_eq!(reason, expected, "{payload}");
                    assert_eq!(task_id.as_deref(), blamed, "{payload}");
                    // Every refusal carries something the Control Plane can
                    // show, in both a stable slug and a readable sentence.
                    assert!(!reason.slug().is_empty());
                    assert!(reason.message().ends_with('.'));
                }
                other => panic!("{payload} should be malformed, got {other:?}"),
            }
        }
    }

    #[test]
    fn a_refusal_that_names_a_task_can_be_shown_against_it() {
        assert!(MalformedTask::MissingGeneration.identifiable());
        assert!(MalformedTask::NegativeGeneration.identifiable());
        // Without a readable id the failure belongs to the command alone, and
        // claiming otherwise would blame some other task.
        assert!(!MalformedTask::NotAnObject.identifiable());
        assert!(!MalformedTask::MissingTaskId.identifiable());
        assert!(!MalformedTask::EmptyTaskId.identifiable());
    }

    #[test]
    fn every_refusal_slug_is_distinct() {
        let slugs = [
            MalformedTask::NotAnObject,
            MalformedTask::MissingTaskId,
            MalformedTask::EmptyTaskId,
            MalformedTask::MissingGeneration,
            MalformedTask::NegativeGeneration,
        ]
        .map(MalformedTask::slug);
        let mut unique = slugs.to_vec();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), slugs.len(), "a slug cannot be ambiguous");
    }

    #[test]
    fn a_report_is_stamped_from_the_registry_and_not_from_the_board() {
        let dir = tempfile::tempdir().unwrap();
        let conn = registry(&dir.path().join("registry.db"));
        record_binding(&conn, &binding("card-a", "run-1", 1), 100).unwrap();

        let found = binding_for_run(&conn, "run-1").unwrap().unwrap();
        assert_eq!(found.card_id, "card-a");
        assert_eq!(found.task_id, "tsk_1");

        // A card the agent invented has no binding, so nothing can be stamped
        // for it and nothing is forwarded.
        assert!(
            binding_for_card(&conn, "card-the-agent-made-up")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn successive_runs_of_one_task_mint_separate_cards() {
        let dir = tempfile::tempdir().unwrap();
        let conn = registry(&dir.path().join("registry.db"));
        record_binding(&conn, &binding("card-a", "run-1", 1), 100).unwrap();
        record_binding(&conn, &binding("card-b", "run-2", 2), 200).unwrap();

        let first = binding_for_card(&conn, "card-a").unwrap().unwrap();
        let second = binding_for_card(&conn, "card-b").unwrap().unwrap();
        assert_eq!(first.run_id, "run-1");
        assert_eq!(first.generation, 1);
        assert_eq!(second.run_id, "run-2");
        assert_eq!(second.generation, 2);
        // Which is what makes a late report from the first attempt identifiable
        // rather than merely plausible.
        assert_ne!(first.card_id, second.card_id);
    }

    #[test]
    fn one_run_cannot_hold_two_cards() {
        let dir = tempfile::tempdir().unwrap();
        let conn = registry(&dir.path().join("registry.db"));
        record_binding(&conn, &binding("card-a", "run-1", 1), 100).unwrap();
        assert!(record_binding(&conn, &binding("card-b", "run-1", 1), 100).is_err());
    }

    #[test]
    fn forwarding_marks_only_move_forward() {
        let dir = tempfile::tempdir().unwrap();
        let conn = registry(&dir.path().join("registry.db"));
        record_binding(&conn, &binding("card-a", "run-1", 1), 100).unwrap();

        advance_marks(&conn, "card-a", 5, 2).unwrap();
        assert_eq!(forwarded_marks(&conn, "card-a").unwrap(), (5, 2));

        // A reader that replayed the board cannot rewind and resend.
        advance_marks(&conn, "card-a", 3, 1).unwrap();
        assert_eq!(forwarded_marks(&conn, "card-a").unwrap(), (5, 2));

        advance_marks(&conn, "card-a", 9, 2).unwrap();
        assert_eq!(forwarded_marks(&conn, "card-a").unwrap(), (9, 2));
    }

    #[test]
    fn a_closed_card_stays_closed() {
        let dir = tempfile::tempdir().unwrap();
        let conn = registry(&dir.path().join("registry.db"));
        record_binding(&conn, &binding("card-a", "run-1", 1), 100).unwrap();
        close_card(&conn, "run-1", 300).unwrap();
        close_card(&conn, "run-1", 400).unwrap();
        let closed: i64 = conn
            .query_row(
                "SELECT closed_at FROM task_cards WHERE run_id = 'run-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(closed, 300, "a second close must not move the timestamp");
    }

    fn pending_outbox(conn: &Connection) -> Vec<(String, String)> {
        let mut statement = conn
            .prepare(
                "SELECT correlation_id, payload FROM outbox
                  WHERE acknowledged_at IS NULL ORDER BY id",
            )
            .unwrap();
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap();
        rows.map(|row| row.unwrap()).collect()
    }

    fn completion() -> AgentReport {
        AgentReport::CompletionRequested {
            summary: "did the thing".to_owned(),
            artifacts: vec!["/tmp/out.txt".to_owned()],
        }
    }

    #[test]
    fn a_report_is_queued_durably_and_the_cursor_moves_with_it() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = registry(&dir.path().join("registry.db"));
        let card = binding("card-a", "run-1", 1);
        record_binding(&conn, &card, 100).unwrap();

        let report = stamp(&card, ReportStream::Event, 7, completion());
        enqueue_report(&mut conn, &report, ReportStream::Event, 7).unwrap();

        // Durable: it is in the queue that survives a reconnect, not merely
        // written to a socket.
        let queued = pending_outbox(&conn);
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].0, "card-a:event:7");
        assert!(queued[0].1.contains("completion_requested"));
        // And the cursor moved past the row, in the same breath.
        assert_eq!(forwarded_marks(&conn, "card-a").unwrap(), (7, 0));
    }

    #[test]
    fn a_crash_cannot_move_the_cursor_past_a_report_that_was_never_queued() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = registry(&dir.path().join("registry.db"));
        let card = binding("card-a", "run-1", 1);
        record_binding(&conn, &card, 100).unwrap();

        // The binding is gone -- the run was cleaned up, or never minted this
        // card. The enqueue refuses, and because both writes live in one
        // transaction the cursor is exactly where it was.
        conn.execute("DELETE FROM task_cards WHERE card_id = 'card-a'", [])
            .unwrap();
        let report = stamp(&card, ReportStream::Event, 7, completion());
        assert!(enqueue_report(&mut conn, &report, ReportStream::Event, 7).is_err());
        assert!(pending_outbox(&conn).is_empty());

        // Put it back and the row is still unread, so the completion is found
        // on the next pass rather than lost.
        record_binding(&conn, &card, 100).unwrap();
        assert_eq!(forwarded_marks(&conn, "card-a").unwrap(), (0, 0));
        enqueue_report(&mut conn, &report, ReportStream::Event, 7).unwrap();
        assert_eq!(pending_outbox(&conn).len(), 1);
    }

    #[test]
    fn a_completion_survives_a_reconnect_because_it_is_queued_not_written() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.db");
        let mut conn = registry(&path);
        let card = binding("card-a", "run-1", 1);
        record_binding(&conn, &card, 100).unwrap();
        let report = stamp(&card, ReportStream::Event, 3, completion());
        enqueue_report(&mut conn, &report, ReportStream::Event, 3).unwrap();
        drop(conn);

        // A new process, as after a crash or a restart: the completion request
        // is still waiting to be delivered.
        let reopened = Connection::open(&path).unwrap();
        let queued = pending_outbox(&reopened);
        assert_eq!(queued.len(), 1);
        assert!(queued[0].1.contains("completion_requested"));
    }

    #[test]
    fn a_replayed_board_row_carries_the_same_identity_so_it_can_be_recognised() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = registry(&dir.path().join("registry.db"));
        let card = binding("card-a", "run-1", 1);
        record_binding(&conn, &card, 100).unwrap();

        // The same row read twice stamps identically, which is what lets the
        // Control Plane recognise the second copy instead of applying it.
        let first = stamp(&card, ReportStream::Event, 3, completion());
        let again = stamp(&card, ReportStream::Event, 3, completion());
        assert_eq!(first.report_id, again.report_id);

        enqueue_report(&mut conn, &first, ReportStream::Event, 3).unwrap();
        enqueue_report(&mut conn, &again, ReportStream::Event, 3).unwrap();
        let queued = pending_outbox(&conn);
        // Both are queued -- the Node does not pretend to dedupe what it cannot
        // see acknowledged -- but they are the same report by identity.
        assert_eq!(queued.len(), 2);
        assert_eq!(queued[0].0, queued[1].0);
        // And the cursor did not go backwards.
        assert_eq!(forwarded_marks(&conn, "card-a").unwrap(), (3, 0));
    }

    #[test]
    fn two_streams_keep_separate_cursors() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = registry(&dir.path().join("registry.db"));
        let card = binding("card-a", "run-1", 1);
        record_binding(&conn, &card, 100).unwrap();

        let event = stamp(&card, ReportStream::Event, 5, completion());
        let note = stamp(
            &card,
            ReportStream::Comment,
            2,
            AgentReport::Note {
                body: "partial findings".to_owned(),
            },
        );
        enqueue_report(&mut conn, &event, ReportStream::Event, 5).unwrap();
        enqueue_report(&mut conn, &note, ReportStream::Comment, 2).unwrap();

        assert_eq!(forwarded_marks(&conn, "card-a").unwrap(), (5, 2));
        // Distinct identities, so one cannot be mistaken for the other.
        assert_ne!(event.report_id, note.report_id);
    }

    #[test]
    fn a_report_from_a_superseded_run_is_not_queued_at_all() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = registry(&dir.path().join("registry.db"));
        record_binding(&conn, &binding("card-b", "run-2", 2), 200).unwrap();

        // Stamped as if it belonged to the earlier attempt. There is no
        // binding for it, so it never reaches the queue -- the stale report is
        // stopped at the Node, before it can argue with the Control Plane.
        let stale = stamp(
            &binding("card-a", "run-1", 1),
            ReportStream::Event,
            1,
            completion(),
        );
        assert!(enqueue_report(&mut conn, &stale, ReportStream::Event, 1).is_err());
        assert!(pending_outbox(&conn).is_empty());
    }

    #[test]
    fn the_board_is_read_once_more_before_a_run_is_settled() {
        // The last kanban_complete lands between the final poll and the run
        // reporting terminal, so every ending gets one more read.
        for status in ["completed", "failed", "cancelled", "interrupted"] {
            assert!(final_read_required(status), "{status}");
        }
        // Nothing has ended, so nothing to settle.
        assert!(!final_read_required(""));
    }

    /// A board shaped like Hermes's own, so the reader is exercised against
    /// the real column and table names rather than a convenient invention.
    fn hermes_board(path: &Path) -> Connection {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE tasks (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                body TEXT,
                assignee TEXT,
                status TEXT NOT NULL,
                created_by TEXT,
                created_at INTEGER NOT NULL,
                workspace_kind TEXT NOT NULL DEFAULT 'scratch',
                result TEXT,
                block_kind TEXT
             );
             CREATE TABLE task_comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL,
                author TEXT NOT NULL,
                body TEXT NOT NULL,
                created_at INTEGER NOT NULL
             );
             CREATE TABLE task_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL,
                run_id INTEGER,
                kind TEXT NOT NULL,
                payload TEXT,
                created_at INTEGER NOT NULL
             );",
        )
        .unwrap();
        conn
    }

    fn put_card(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO tasks (id, title, status, created_at) VALUES (?1, 'Do it', 'running', 1)",
            [id],
        )
        .unwrap();
    }

    fn put_event(conn: &Connection, card: &str, kind: &str, payload: Option<&str>) {
        conn.execute(
            "INSERT INTO task_events (task_id, kind, payload, created_at) VALUES (?1, ?2, ?3, 1)",
            rusqlite::params![card, kind, payload],
        )
        .unwrap();
    }

    #[test]
    fn the_reader_turns_real_board_rows_into_reports() {
        let dir = tempfile::tempdir().unwrap();
        let board = dir.path().join("kanban.db");
        let conn = hermes_board(&board);
        put_card(&conn, "card-a");

        put_event(
            &conn,
            "card-a",
            "heartbeat",
            Some(r#"{"note":"reading the code"}"#),
        );
        conn.execute(
            "INSERT INTO task_comments (task_id, author, body, created_at)
             VALUES ('card-a', 'agent', 'partial findings', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE tasks SET result = 'did the thing' WHERE id = 'card-a'",
            [],
        )
        .unwrap();
        put_event(
            &conn,
            "card-a",
            "completed",
            Some(r#"{"artifacts":["/tmp/a.txt"]}"#),
        );
        drop(conn);

        let pass = read_board(&board, "card-a", 0, 0).unwrap();
        assert_eq!(pass.event_cursor, 2);
        assert_eq!(pass.comment_cursor, 1);
        assert_eq!(
            pass.reports,
            vec![
                (
                    ReportStream::Event,
                    1,
                    AgentReport::Activity {
                        note: "reading the code".to_owned()
                    }
                ),
                (
                    ReportStream::Event,
                    2,
                    AgentReport::CompletionRequested {
                        summary: "did the thing".to_owned(),
                        artifacts: vec!["/tmp/a.txt".to_owned()],
                    }
                ),
                (
                    ReportStream::Comment,
                    1,
                    AgentReport::Note {
                        body: "partial findings".to_owned()
                    }
                ),
            ]
        );
    }

    #[test]
    fn the_reader_reads_only_its_own_card() {
        let dir = tempfile::tempdir().unwrap();
        let board = dir.path().join("kanban.db");
        let conn = hermes_board(&board);
        put_card(&conn, "card-a");
        put_card(&conn, "card-the-agent-made-up");
        // The agent writes a completion against a card it invented, naming
        // whatever it likes. It is not the minted card, so it is not read.
        conn.execute(
            "UPDATE tasks SET result = 'trust me' WHERE id = 'card-the-agent-made-up'",
            [],
        )
        .unwrap();
        put_event(&conn, "card-the-agent-made-up", "completed", None);
        drop(conn);

        let pass = read_board(&board, "card-a", 0, 0).unwrap();
        assert!(pass.reports.is_empty());
        // And the cursor did not swallow the other card's row either.
        assert_eq!(pass.event_cursor, 0);
    }

    #[test]
    fn a_cursor_skips_what_was_already_forwarded() {
        let dir = tempfile::tempdir().unwrap();
        let board = dir.path().join("kanban.db");
        let conn = hermes_board(&board);
        put_card(&conn, "card-a");
        put_event(&conn, "card-a", "heartbeat", Some(r#"{"note":"first"}"#));
        put_event(&conn, "card-a", "heartbeat", Some(r#"{"note":"second"}"#));
        drop(conn);

        let pass = read_board(&board, "card-a", 1, 0).unwrap();
        assert_eq!(pass.reports.len(), 1);
        assert_eq!(
            pass.reports[0].2,
            AgentReport::Activity {
                note: "second".to_owned()
            }
        );
    }

    #[test]
    fn an_unknown_event_kind_advances_the_cursor_and_reports_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let board = dir.path().join("kanban.db");
        let conn = hermes_board(&board);
        put_card(&conn, "card-a");
        // A future Hermes event this build has never heard of. Guessing at it
        // would invent progress; reading it again forever would stall the
        // cursor behind it.
        put_event(&conn, "card-a", "quantum_entangled", Some("{}"));
        drop(conn);

        let pass = read_board(&board, "card-a", 0, 0).unwrap();
        assert!(pass.reports.is_empty());
        assert_eq!(pass.event_cursor, 1);
    }

    #[test]
    fn a_block_carries_the_cards_own_typed_reason() {
        let dir = tempfile::tempdir().unwrap();
        let board = dir.path().join("kanban.db");
        let conn = hermes_board(&board);
        put_card(&conn, "card-a");
        conn.execute(
            "UPDATE tasks SET block_kind = 'capability' WHERE id = 'card-a'",
            [],
        )
        .unwrap();
        put_event(
            &conn,
            "card-a",
            "blocked",
            Some(r#"{"reason":"no access to the repo"}"#),
        );
        drop(conn);

        let pass = read_board(&board, "card-a", 0, 0).unwrap();
        assert_eq!(
            pass.reports[0].2,
            AgentReport::Blocked {
                reason: "no access to the repo".to_owned(),
                kind: "capability".to_owned(),
            }
        );
    }

    #[test]
    fn a_block_with_no_typed_reason_is_treated_as_needing_input() {
        let dir = tempfile::tempdir().unwrap();
        let board = dir.path().join("kanban.db");
        let conn = hermes_board(&board);
        put_card(&conn, "card-a");
        put_event(
            &conn,
            "card-a",
            "blocked",
            Some(r#"{"reason":"which branch?"}"#),
        );
        drop(conn);

        let pass = read_board(&board, "card-a", 0, 0).unwrap();
        match &pass.reports[0].2 {
            AgentReport::Blocked { kind, .. } => assert_eq!(kind, "needs_input"),
            other => panic!("expected a block, got {other:?}"),
        }
    }

    #[test]
    fn a_missing_card_reads_as_nothing_rather_than_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let board = dir.path().join("kanban.db");
        drop(hermes_board(&board));
        let pass = read_board(&board, "card-gone", 4, 2).unwrap();
        assert!(pass.reports.is_empty());
        // Cursors unchanged: there was nothing to move past.
        assert_eq!(pass.event_cursor, 4);
        assert_eq!(pass.comment_cursor, 2);
    }

    #[test]
    fn the_addressing_note_names_the_card_and_claims_no_authority() {
        let note = addressing_note("card-a");
        assert!(note.contains("card-a"));
        assert!(note.contains("kanban_complete"));
        // The agent is told plainly that prose is not state.
        assert!(note.contains("ordinary reply"));
    }

    #[test]
    fn minting_refuses_a_board_that_has_no_tables_yet() {
        let dir = tempfile::tempdir().unwrap();
        let board = dir.path().join("kanban.db");
        let result = mint_card(&board, &binding("card-a", "run-1", 1), "t", "g", 100);
        assert!(result.is_err());
    }

    #[test]
    fn minting_writes_a_claimed_card_into_the_projects_own_board() {
        let dir = tempfile::tempdir().unwrap();
        let board = dir.path().join("kanban.db");
        let conn = Connection::open(&board).unwrap();
        conn.execute_batch(
            "CREATE TABLE tasks (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                body TEXT,
                assignee TEXT,
                status TEXT NOT NULL,
                created_by TEXT,
                created_at INTEGER NOT NULL,
                workspace_kind TEXT NOT NULL DEFAULT 'scratch'
             );",
        )
        .unwrap();
        drop(conn);

        mint_card(
            &board,
            &binding("card-a", "run-1", 1),
            "Do it",
            "Make it true",
            100,
        )
        .unwrap();

        let conn = Connection::open(&board).unwrap();
        let (id, status, title): (String, String, String) = conn
            .query_row("SELECT id, status, title FROM tasks", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
        assert_eq!(id, "card-a");
        assert_eq!(status, MINTED_CARD_STATE);
        assert!(!is_dispatchable_state(&status));
        assert_eq!(title, "Do it");
    }
}
