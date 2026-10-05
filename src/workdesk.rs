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
use rusqlite::Connection;
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
///
/// Absent on an ordinary run, which is how a Node that is asked to run a task
/// it cannot report on still runs the work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskBinding {
    pub task_id: String,
    pub generation: i64,
}

impl TaskBinding {
    /// Read the binding out of a command payload.
    ///
    /// Returns `None` rather than failing for anything malformed: a run whose
    /// task attachment cannot be read is still a run worth executing, and
    /// refusing it would turn a reporting problem into a work stoppage.
    pub fn from_payload(payload: &serde_json::Value) -> Option<Self> {
        let task = payload.get("task")?.as_object()?;
        let task_id = task.get("task_id")?.as_str()?.trim();
        if task_id.is_empty() {
            return None;
        }
        let generation = task.get("generation")?.as_i64()?;
        if generation < 0 {
            return None;
        }
        Some(Self {
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

/// One forwarded report, stamped from the Node's own binding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StampedReport {
    pub task_id: String,
    pub run_id: String,
    pub generation: i64,
    /// Monotonic per card, so a replayed delivery collides instead of repeating.
    pub seq: i64,
    pub report: AgentReport,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn registry(path: &Path) -> Connection {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE projects (project_id TEXT PRIMARY KEY);
             INSERT INTO projects (project_id) VALUES ('p1');
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
    fn a_task_binding_is_read_from_a_payload_or_ignored() {
        let good = serde_json::json!({"input": "x", "task": {"task_id": "tsk_1", "generation": 3}});
        assert_eq!(
            TaskBinding::from_payload(&good),
            Some(TaskBinding {
                task_id: "tsk_1".to_owned(),
                generation: 3
            })
        );

        // Every malformed shape is "no task", never an error: a run whose
        // attachment cannot be read is still a run worth executing.
        for payload in [
            serde_json::json!({"input": "x"}),
            serde_json::json!({"task": {}}),
            serde_json::json!({"task": {"task_id": "", "generation": 1}}),
            serde_json::json!({"task": {"task_id": "tsk_1"}}),
            serde_json::json!({"task": {"task_id": "tsk_1", "generation": -1}}),
            serde_json::json!({"task": "tsk_1"}),
            serde_json::json!({"task": []}),
        ] {
            assert_eq!(TaskBinding::from_payload(&payload), None, "{payload}");
        }
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
