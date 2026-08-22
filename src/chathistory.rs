//! Short-term conversational history for a continued Hermes run.
//!
//! Hermes 0.20.0 `POST /v1/runs` never loads persisted session history: it
//! builds the transcript from an explicit `conversation_history` in the request
//! body, falling back to `previous_response_id`, and nothing else. A run that
//! supplies neither starts with an empty transcript, so every chat turn arrives
//! at the model with no memory of the previous one — and the agent then answers
//! from project-wide memory, confidently and with stale content.
//!
//! `conversation_history` is Hermes' own documented parameter and takes
//! precedence over everything else, so supplying it is a supported call rather
//! than a reimplementation: Hermes still owns the agent loop, tools, approvals,
//! cancellation, and streaming. This module decides *what* to send.
//!
//! What it deliberately does not send: tool events, approval events, reasoning,
//! SSE metadata, and diagnostics. Those are operator evidence, not conversation,
//! and replaying them would both bloat the prompt and change what the model
//! believes it already did.

use serde::Serialize;

use crate::registry::RunRecord;
use crate::runstate::RunStatus;

/// Turns kept, and the serialized byte ceiling for them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HistoryLimits {
    pub max_turns: usize,
    pub max_bytes: usize,
}

impl Default for HistoryLimits {
    fn default() -> Self {
        Self {
            max_turns: DEFAULT_MAX_TURNS,
            max_bytes: DEFAULT_MAX_BYTES,
        }
    }
}

pub const DEFAULT_MAX_TURNS: usize = 20;
pub const DEFAULT_MAX_BYTES: usize = 64 * 1024;

/// One transcript message, in the shape Hermes accepts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HistoryMessage {
    pub role: String,
    pub content: String,
}

/// The selected history plus what it took to fit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuiltHistory {
    pub messages: Vec<HistoryMessage>,
    /// Turns dropped because of either limit. Non-zero means the caller must
    /// record a durable `conversation.history_truncated` diagnostic.
    pub omitted_turns: usize,
    /// Serialized size of what is being sent.
    pub bytes: usize,
}

impl BuiltHistory {
    pub fn is_empty(&self) -> bool {
        self.messages.is_empty()
    }

    pub fn truncated(&self) -> bool {
        self.omitted_turns > 0
    }
}

/// One logical chat turn: the user message, and the answer that stood.
struct Turn {
    created_at: i64,
    user: String,
    assistant: String,
}

/// Build the history to send with a continued run.
///
/// `runs` is any set of runs from the local registry; ordering does not matter.
/// The current run is excluded by id so the input being submitted now is never
/// duplicated into the transcript.
pub fn build(
    runs: &[RunRecord],
    session_id: &str,
    current_run_id: &str,
    limits: HistoryLimits,
) -> BuiltHistory {
    let mut turns = collect_turns(runs, session_id, current_run_id);
    turns.sort_by_key(|turn| turn.created_at);

    // Older turns go first when something has to give: the immediate context is
    // what the next answer depends on.
    let mut omitted = turns.len().saturating_sub(limits.max_turns);
    if omitted > 0 {
        turns.drain(0..omitted);
    }

    // Whole turns are dropped rather than truncating a message. A half-cut
    // answer is worse than an absent one — the model treats it as what it said.
    while !turns.is_empty() && serialized_bytes(&turns) > limits.max_bytes {
        turns.remove(0);
        omitted += 1;
    }

    let bytes = serialized_bytes(&turns);
    let mut messages = Vec::with_capacity(turns.len() * 2);
    for turn in turns {
        messages.push(HistoryMessage {
            role: "user".to_owned(),
            content: turn.user,
        });
        messages.push(HistoryMessage {
            role: "assistant".to_owned(),
            content: turn.assistant,
        });
    }

    BuiltHistory {
        messages,
        omitted_turns: omitted,
        bytes,
    }
}

/// Group runs into logical turns.
///
/// A retry is another attempt at the *same* user message, so it joins the turn
/// it replaces instead of becoming a second question. The answer kept is the
/// latest attempt that actually completed; a turn whose every attempt failed,
/// was cancelled, interrupted, or lost contributes nothing, because there is no
/// answer the operator ever saw.
fn collect_turns(runs: &[RunRecord], session_id: &str, current_run_id: &str) -> Vec<Turn> {
    let mut turns: Vec<Turn> = Vec::new();

    for run in runs {
        if run.run_id == current_run_id {
            continue;
        }
        if run.session_id.as_deref() != Some(session_id) {
            continue;
        }
        // Only roots open a turn; retries are folded into their root below.
        if run.retry_of_run_id.is_some() {
            continue;
        }
        let Some(user) = text_field(&run.request_payload, "input") else {
            continue;
        };
        // Hermes stringifies conversation_history content, so an image part
        // cannot survive a replay. Naming the images keeps the model aware the
        // turn carried them instead of silently losing that fact.
        let attachments =
            crate::attachments::parse(run.request_payload.get("attachments")).unwrap_or_default();
        let user = format!("{user}{}", crate::attachments::history_suffix(&attachments));

        let attempts = attempt_chain(runs, &run.run_id);
        let Some(assistant) = latest_completed_answer(&attempts) else {
            continue;
        };

        turns.push(Turn {
            created_at: run.created_at,
            user,
            assistant,
        });
    }

    turns
}

/// A root run and every retry descending from it, oldest first.
fn attempt_chain<'a>(runs: &'a [RunRecord], root_id: &str) -> Vec<&'a RunRecord> {
    let mut chain: Vec<&RunRecord> = runs.iter().filter(|run| run.run_id == root_id).collect();
    let mut frontier = vec![root_id.to_owned()];

    while let Some(parent) = frontier.pop() {
        for run in runs {
            if run.retry_of_run_id.as_deref() == Some(parent.as_str()) {
                chain.push(run);
                frontier.push(run.run_id.clone());
            }
        }
    }

    chain.sort_by_key(|run| run.created_at);
    chain
}

/// The answer from the newest attempt that completed with output.
fn latest_completed_answer(attempts: &[&RunRecord]) -> Option<String> {
    attempts
        .iter()
        .rev()
        .filter(|run| matches!(run.status(), Ok(RunStatus::Completed)))
        .find_map(|run| {
            run.result_payload
                .as_ref()
                .and_then(|payload| text_field(payload, "output"))
        })
}

fn text_field(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned)
}

/// Size of the payload as Hermes will receive it, so the budget means the same
/// thing here as on the wire.
fn serialized_bytes(turns: &[Turn]) -> usize {
    let messages: Vec<HistoryMessage> = turns
        .iter()
        .flat_map(|turn| {
            [
                HistoryMessage {
                    role: "user".to_owned(),
                    content: turn.user.clone(),
                },
                HistoryMessage {
                    role: "assistant".to_owned(),
                    content: turn.assistant.clone(),
                },
            ]
        })
        .collect();
    serde_json::to_vec(&messages)
        .map(|bytes| bytes.len())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Minimal run record; every test states only the fields it cares about.
    fn run(
        id: &str,
        session: Option<&str>,
        at: i64,
        status: &str,
        input: &str,
        output: Option<&str>,
    ) -> RunRecord {
        RunRecord {
            run_id: id.to_owned(),
            project_id: "p1".to_owned(),
            session_id: session.map(ToOwned::to_owned),
            idempotency_key: None,
            runtime_kind: "hermes-loop".to_owned(),
            provider: None,
            model: None,
            status: status.to_owned(),
            created_at: at,
            started_at: None,
            updated_at: at,
            finished_at: None,
            last_event_seq: 0,
            terminal_reason: None,
            error_code: None,
            error_message: None,
            hermes_run_id: None,
            request_payload: json!({ "input": input }),
            result_payload: output.map(|text| json!({ "output": text })),
            recovery_note: None,
            retry_of_run_id: None,
        }
    }

    fn retry_of(mut record: RunRecord, parent: &str) -> RunRecord {
        record.retry_of_run_id = Some(parent.to_owned());
        record
    }

    fn roles(built: &BuiltHistory) -> Vec<&str> {
        built.messages.iter().map(|m| m.role.as_str()).collect()
    }

    fn contents(built: &BuiltHistory) -> Vec<&str> {
        built.messages.iter().map(|m| m.content.as_str()).collect()
    }

    #[test]
    fn a_completed_turn_becomes_a_user_and_assistant_pair() {
        let runs = vec![run("r1", Some("s"), 10, "completed", "hello", Some("hi"))];
        let built = build(&runs, "s", "current", HistoryLimits::default());
        assert_eq!(roles(&built), vec!["user", "assistant"]);
        assert_eq!(contents(&built), vec!["hello", "hi"]);
        assert!(!built.truncated());
    }

    #[test]
    fn history_is_ordered_chronologically_regardless_of_input_order() {
        let runs = vec![
            run("r3", Some("s"), 30, "completed", "third", Some("c")),
            run("r1", Some("s"), 10, "completed", "first", Some("a")),
            run("r2", Some("s"), 20, "completed", "second", Some("b")),
        ];
        let built = build(&runs, "s", "current", HistoryLimits::default());
        assert_eq!(
            contents(&built),
            vec!["first", "a", "second", "b", "third", "c"]
        );
    }

    #[test]
    fn the_current_run_is_never_replayed_into_its_own_history() {
        // The input being submitted now travels in `input`; repeating it here
        // would show the model its own question twice.
        let runs = vec![
            run("r1", Some("s"), 10, "completed", "earlier", Some("a")),
            run(
                "cur",
                Some("s"),
                20,
                "running",
                "the question being asked now",
                None,
            ),
        ];
        let built = build(&runs, "s", "cur", HistoryLimits::default());
        assert_eq!(contents(&built), vec!["earlier", "a"]);
    }

    #[test]
    fn another_session_contributes_nothing() {
        let runs = vec![
            run(
                "r1",
                Some("other"),
                10,
                "completed",
                "their secret",
                Some("their answer"),
            ),
            run("r2", Some("s"), 20, "completed", "ours", Some("our answer")),
        ];
        let built = build(&runs, "s", "current", HistoryLimits::default());
        assert_eq!(contents(&built), vec!["ours", "our answer"]);
    }

    #[test]
    fn a_run_without_a_session_is_not_borrowed_by_one() {
        let runs = vec![run("r1", None, 10, "completed", "sessionless", Some("a"))];
        let built = build(&runs, "s", "current", HistoryLimits::default());
        assert!(built.is_empty());
    }

    // --- terminal-state filtering -------------------------------------------
    //
    // Only an answer the operator actually received belongs in the transcript.
    // Replaying a failed or abandoned attempt would tell the model it said
    // something it never said.

    #[test]
    fn unfinished_and_failed_outcomes_are_excluded() {
        for status in [
            "failed",
            "cancelled",
            "interrupted",
            "lost",
            "running",
            "queued",
        ] {
            let runs = vec![run("r1", Some("s"), 10, status, "q", Some("partial text"))];
            let built = build(&runs, "s", "current", HistoryLimits::default());
            assert!(built.is_empty(), "{status} must not enter the transcript");
        }
    }

    #[test]
    fn a_completed_run_with_no_output_is_excluded() {
        let runs = vec![run("r1", Some("s"), 10, "completed", "q", None)];
        assert!(build(&runs, "s", "current", HistoryLimits::default()).is_empty());
    }

    #[test]
    fn an_empty_or_blank_answer_is_excluded() {
        let runs = vec![run("r1", Some("s"), 10, "completed", "q", Some("   "))];
        assert!(build(&runs, "s", "current", HistoryLimits::default()).is_empty());
    }

    // --- retry grouping ------------------------------------------------------

    #[test]
    fn a_retry_is_the_same_turn_not_a_second_question() {
        let runs = vec![
            run("r1", Some("s"), 10, "interrupted", "do the thing", None),
            retry_of(
                run(
                    "r2",
                    Some("s"),
                    20,
                    "completed",
                    "do the thing",
                    Some("done"),
                ),
                "r1",
            ),
        ];
        let built = build(&runs, "s", "current", HistoryLimits::default());
        assert_eq!(
            roles(&built),
            vec!["user", "assistant"],
            "the user message appears once"
        );
        assert_eq!(contents(&built), vec!["do the thing", "done"]);
    }

    #[test]
    fn the_latest_completed_attempt_supplies_the_answer() {
        let runs = vec![
            run("r1", Some("s"), 10, "completed", "q", Some("first answer")),
            retry_of(
                run("r2", Some("s"), 20, "completed", "q", Some("better answer")),
                "r1",
            ),
        ];
        let built = build(&runs, "s", "current", HistoryLimits::default());
        assert_eq!(contents(&built), vec!["q", "better answer"]);
    }

    #[test]
    fn a_failed_retry_does_not_discard_an_earlier_good_answer() {
        let runs = vec![
            run("r1", Some("s"), 10, "completed", "q", Some("good answer")),
            retry_of(
                run("r2", Some("s"), 20, "failed", "q", Some("garbage")),
                "r1",
            ),
        ];
        let built = build(&runs, "s", "current", HistoryLimits::default());
        assert_eq!(contents(&built), vec!["q", "good answer"]);
    }

    #[test]
    fn a_chain_of_retries_still_forms_one_turn() {
        let runs = vec![
            run("r1", Some("s"), 10, "interrupted", "q", None),
            retry_of(run("r2", Some("s"), 20, "lost", "q", None), "r1"),
            retry_of(
                run("r3", Some("s"), 30, "completed", "q", Some("finally")),
                "r2",
            ),
        ];
        let built = build(&runs, "s", "current", HistoryLimits::default());
        assert_eq!(contents(&built), vec!["q", "finally"]);
    }

    #[test]
    fn a_turn_whose_every_attempt_failed_is_dropped_entirely() {
        let runs = vec![
            run("r1", Some("s"), 10, "interrupted", "q", None),
            retry_of(run("r2", Some("s"), 20, "failed", "q", None), "r1"),
        ];
        assert!(build(&runs, "s", "current", HistoryLimits::default()).is_empty());
    }

    // --- limits --------------------------------------------------------------

    #[test]
    fn only_the_most_recent_turns_are_kept_and_the_rest_are_counted() {
        let runs: Vec<RunRecord> = (0..25)
            .map(|i| {
                run(
                    &format!("r{i}"),
                    Some("s"),
                    i as i64,
                    "completed",
                    &format!("q{i}"),
                    Some(&format!("a{i}")),
                )
            })
            .collect();
        let limits = HistoryLimits {
            max_turns: 20,
            ..HistoryLimits::default()
        };
        let built = build(&runs, "s", "current", limits);

        assert_eq!(built.messages.len(), 40);
        assert_eq!(built.omitted_turns, 5);
        assert!(built.truncated());
        assert_eq!(
            built.messages[0].content, "q5",
            "the oldest kept turn follows the omitted ones"
        );
        assert_eq!(
            built.messages[39].content, "a24",
            "the newest turn is always kept"
        );
    }

    #[test]
    fn the_byte_budget_drops_whole_turns_from_the_oldest_end() {
        let big = "x".repeat(4000);
        let runs: Vec<RunRecord> = (0..10)
            .map(|i| {
                run(
                    &format!("r{i}"),
                    Some("s"),
                    i as i64,
                    "completed",
                    &format!("q{i}"),
                    Some(&big),
                )
            })
            .collect();
        let limits = HistoryLimits {
            max_turns: 20,
            max_bytes: 16 * 1024,
        };
        let built = build(&runs, "s", "current", limits);

        assert!(
            built.bytes <= 16 * 1024,
            "budget respected, got {}",
            built.bytes
        );
        assert!(built.truncated());
        // Messages survive whole: no message is a prefix of the original.
        for message in &built.messages {
            assert!(
                message.content.len() == big.len() || message.content.starts_with('q'),
                "messages must not be cut mid-content",
            );
        }
        assert_eq!(
            built.messages.last().unwrap().content,
            big,
            "the newest turn is kept"
        );
    }

    #[test]
    fn a_single_turn_larger_than_the_budget_yields_nothing_rather_than_a_fragment() {
        let huge = "y".repeat(200_000);
        let runs = vec![run("r1", Some("s"), 10, "completed", "q", Some(&huge))];
        let limits = HistoryLimits {
            max_turns: 20,
            max_bytes: 64 * 1024,
        };
        let built = build(&runs, "s", "current", limits);
        assert!(built.is_empty());
        assert_eq!(built.omitted_turns, 1);
    }

    #[test]
    fn nothing_to_say_is_not_a_truncation() {
        let built = build(&[], "s", "current", HistoryLimits::default());
        assert!(built.is_empty());
        assert!(
            !built.truncated(),
            "an empty conversation must not report omissions"
        );
        assert_eq!(
            built.bytes,
            serde_json::to_vec(&Vec::<HistoryMessage>::new())
                .unwrap()
                .len()
        );
    }

    #[test]
    fn the_defaults_are_twenty_turns_and_sixty_four_kibibytes() {
        let limits = HistoryLimits::default();
        assert_eq!(limits.max_turns, 20);
        assert_eq!(limits.max_bytes, 65_536);
    }
}

#[cfg(test)]
mod attachment_tests {
    use super::*;
    use serde_json::json;

    fn run_with(
        id: &str,
        at: i64,
        status: &str,
        input: &str,
        attachments: serde_json::Value,
        output: Option<&str>,
    ) -> RunRecord {
        RunRecord {
            run_id: id.to_owned(),
            project_id: "p1".to_owned(),
            session_id: Some("s".to_owned()),
            idempotency_key: None,
            runtime_kind: "hermes-loop".to_owned(),
            provider: None,
            model: None,
            status: status.to_owned(),
            created_at: at,
            started_at: None,
            updated_at: at,
            finished_at: None,
            last_event_seq: 0,
            terminal_reason: None,
            error_code: None,
            error_message: None,
            hermes_run_id: None,
            request_payload: json!({"input": input, "attachments": attachments}),
            result_payload: output.map(|text| json!({"output": text})),
            recovery_note: None,
            retry_of_run_id: None,
        }
    }

    #[test]
    fn a_replayed_turn_names_the_images_it_carried() {
        let runs = vec![run_with(
            "r1",
            10,
            "completed",
            "what is this",
            json!([{"type": "image_url", "url": "https://example.com/a.png", "alt": "chart"}]),
            Some("a chart"),
        )];
        let built = build(&runs, "s", "current", HistoryLimits::default());
        assert_eq!(
            built.messages[0].content,
            "what is this\n[attached images: chart <https://example.com/a.png>]"
        );
        assert_eq!(built.messages[1].content, "a chart");
    }

    #[test]
    fn a_turn_without_attachments_replays_unchanged() {
        let runs = vec![run_with(
            "r1",
            10,
            "completed",
            "plain question",
            json!([]),
            Some("answer"),
        )];
        let built = build(&runs, "s", "current", HistoryLimits::default());
        assert_eq!(built.messages[0].content, "plain question");
    }

    #[test]
    fn a_retry_does_not_duplicate_the_message_or_its_images() {
        // The retry carries the same payload, and history must still show one
        // user message with one set of images.
        let mut retry = run_with(
            "r2",
            20,
            "completed",
            "read this",
            json!([{"type": "image_url", "url": "https://example.com/a.png"}]),
            Some("done"),
        );
        retry.retry_of_run_id = Some("r1".to_owned());
        let runs = vec![
            run_with(
                "r1",
                10,
                "interrupted",
                "read this",
                json!([{"type": "image_url", "url": "https://example.com/a.png"}]),
                None,
            ),
            retry,
        ];
        let built = build(&runs, "s", "current", HistoryLimits::default());
        assert_eq!(built.messages.len(), 2, "one user message and one answer");
        assert_eq!(
            built.messages[0].content,
            "read this\n[attached images: <https://example.com/a.png>]",
        );
    }

    #[test]
    fn another_session_receives_no_attachment_reference() {
        let mut theirs = run_with(
            "r1",
            10,
            "completed",
            "their question",
            json!([{"type": "image_url", "url": "https://example.com/secret.png"}]),
            Some("their answer"),
        );
        theirs.session_id = Some("other".to_owned());
        let built = build(&[theirs], "s", "current", HistoryLimits::default());
        assert!(built.is_empty(), "a different session must see nothing");
    }

    #[test]
    fn a_corrupt_attachment_payload_replays_the_text_rather_than_failing_the_turn() {
        // History is best-effort context, not the run itself; losing the whole
        // conversation because one stored attachment is malformed would be a
        // worse outcome than replaying the words without the image reference.
        let runs = vec![run_with(
            "r1",
            10,
            "completed",
            "question",
            json!("not-an-array"),
            Some("answer"),
        )];
        let built = build(&runs, "s", "current", HistoryLimits::default());
        assert_eq!(built.messages[0].content, "question");
    }
}
