//! The local half of a durable update operation.
//!
//! An update destroys the process that was reporting it. The daemon that
//! accepted the command is stopped, its binary is replaced, and the thing that
//! comes back is a different process with no memory of what happened. Anything
//! held only in that process — a channel, a task, a counter — is gone at exactly
//! the moment it becomes interesting.
//!
//! So progress is written down first and sent second. The root updater appends
//! typed events to a journal on disk; the unprivileged daemon reads that journal
//! and forwards whatever the Control Plane has not acknowledged. A restart in
//! the middle loses nothing, because the restart is on the other side of the
//! write.
//!
//! **The privilege direction is one-way.** The updater *publishes* here. It
//! never reads instructions from this journal, and the only thing that travels
//! the other way — from the unprivileged daemon to root — remains what it always
//! was: a release tag and an operation id, both validated before they reach a
//! file, neither ever reaching a command line. No path, no URL, no shell
//! fragment crosses that boundary.

use std::io::Write as _;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

/// Longest an operation id may be. A UUID is 36; this leaves no room for a path.
const MAX_OPERATION_ID: usize = 64;

/// Journals older than this are removed when a new operation starts.
///
/// Kept for a while on purpose: a journal whose events were never delivered is
/// the only record that an update happened at all, and an operator looking at a
/// host after a failure should find it.
const KEEP_JOURNALS: usize = 8;

/// What the updater says happened, and the whole of it.
///
/// Deliberately narrow. Every field is either a typed vocabulary the Control
/// Plane already knows or a number; there is no free text, no path and no
/// command output, because this crosses a privilege boundary and then a network.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProgressEvent {
    pub operation_id: String,
    /// Monotonic within one operation, starting at 1.
    pub seq: u64,
    /// A stage from the installer's own vocabulary, as its wire string.
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes_done: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes_total: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_code: Option<String>,
    /// Unix seconds, so an event delivered after a restart still says when it
    /// actually happened rather than when it finally arrived.
    pub at: u64,
}

/// Whether a string names an operation, and only an operation.
///
/// The same reasoning as the release tag beside it: this value reaches a
/// filename, so the question is not "does it look plausible" but "could it mean
/// something else somewhere else". Anything outside the alphabet is refused
/// rather than escaped.
pub fn validate_operation_id(id: &str) -> Result<()> {
    if id.is_empty() {
        bail!("an operation id is required");
    }
    if id.len() > MAX_OPERATION_ID {
        bail!("the operation id is longer than {MAX_OPERATION_ID} characters");
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        bail!("the operation id may hold only letters, digits, dashes and underscores");
    }
    Ok(())
}

/// Names the operation when a binary hands an update to the one it installed.
///
/// The release travels beside it in `ASTERISM_UPDATE_HANDED_OVER`; this is the
/// other half of what the second process needs, and for the same reason: the
/// request file that carried both was consumed before the exec.
pub const HANDOVER_OPERATION_ENV: &str = "ASTERISM_UPDATE_OPERATION";

/// Where the journals live, given a Node home.
pub fn journal_root(node_home: &Path) -> PathBuf {
    node_home.join("node/update")
}

/// The journal for one operation.
pub fn journal_path(node_home: &Path, operation_id: &str) -> PathBuf {
    journal_root(node_home).join(format!("{operation_id}.jsonl"))
}

/// Where the daemon records what it has managed to deliver.
///
/// Beside the journals rather than inside them: the journals are root's, and the
/// account that forwards them needs somewhere it can write.
pub fn cursor_path(node_home: &Path) -> PathBuf {
    node_home.join("node/update-delivered.json")
}

/// An append-only journal, written by the updater and read by the daemon.
pub struct Journal {
    path: PathBuf,
    operation_id: String,
    next_seq: std::sync::atomic::AtomicU64,
}

impl Journal {
    /// Open the journal for an operation, creating the directory if needed.
    ///
    /// The directory is `0755` and the file `0644`: root writes, and the service
    /// account reads. It is deliberately not group-writable — the daemon
    /// forwards these events, and a journal it could edit would be a journal it
    /// could forge, which is the one thing the split is for.
    pub fn open(node_home: &Path, operation_id: &str) -> Result<Self> {
        validate_operation_id(operation_id)?;
        let root = journal_root(node_home);
        std::fs::create_dir_all(&root)
            .with_context(|| format!("cannot create {}", root.display()))?;
        set_mode(&root, 0o755);

        let path = journal_path(node_home, operation_id);
        // Resuming rather than restarting: a handover runs this process twice,
        // and the second half must not begin its sequence again at 1.
        let next_seq = read_journal(&path).last().map_or(1, |event| event.seq + 1);
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .with_context(|| format!("cannot open {}", path.display()))?;
        drop(file);
        set_mode(&path, 0o644);

        Ok(Self {
            path,
            operation_id: operation_id.to_owned(),
            next_seq: std::sync::atomic::AtomicU64::new(next_seq),
        })
    }

    /// Append one event.
    ///
    /// One line, one `write`, on a descriptor opened for append: the kernel
    /// places it at the end whatever else is happening, so a reader never sees
    /// half of a record. Failures are returned rather than raised into the
    /// update — a journal that cannot be written is a lost progress bar, and
    /// stopping an update that is otherwise fine over one would be the worse
    /// trade.
    pub fn append(
        &self,
        state: &str,
        bytes: Option<(u64, Option<u64>)>,
        failure_code: Option<&str>,
    ) -> Result<ProgressEvent> {
        let event = ProgressEvent {
            operation_id: self.operation_id.clone(),
            seq: self
                .next_seq
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst),
            state: state.to_owned(),
            bytes_done: bytes.map(|(done, _)| done),
            bytes_total: bytes.and_then(|(_, total)| total),
            failure_code: failure_code.map(str::to_owned),
            at: now(),
        };
        let mut line = serde_json::to_string(&event)?;
        line.push('\n');
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .with_context(|| format!("cannot open {}", self.path.display()))?;
        file.write_all(line.as_bytes())
            .with_context(|| format!("cannot append to {}", self.path.display()))?;
        Ok(event)
    }
}

/// Every event in one journal, in order.
///
/// A malformed line is skipped rather than fatal. The journal is appended to by
/// a process that is being replaced mid-write by design; a torn final line is a
/// thing that happens, and losing one progress report is not a reason to lose
/// the rest of the history.
pub fn read_journal(path: &Path) -> Vec<ProgressEvent> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut events: Vec<ProgressEvent> = raw
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    events.sort_by_key(|event| event.seq);
    events.dedup_by_key(|event| event.seq);
    events
}

/// Operation ids that have a journal on this host, oldest first.
pub fn journalled_operations(node_home: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(journal_root(node_home)) else {
        return Vec::new();
    };
    let mut found: Vec<(std::time::SystemTime, String)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_stem()?.to_str()?.to_owned();
            if path.extension().is_none_or(|ext| ext != "jsonl") {
                return None;
            }
            validate_operation_id(&name).ok()?;
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, name))
        })
        .collect();
    found.sort();
    found.into_iter().map(|(_, name)| name).collect()
}

/// Remove all but the most recent journals.
pub fn prune_journals(node_home: &Path) {
    let operations = journalled_operations(node_home);
    let excess = operations.len().saturating_sub(KEEP_JOURNALS);
    for operation in operations.into_iter().take(excess) {
        let _ = std::fs::remove_file(journal_path(node_home, &operation));
    }
}

/// What the daemon has managed to hand to the Control Plane.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Delivered {
    /// Operation id to the highest sequence the Control Plane acknowledged.
    #[serde(default)]
    pub acked: std::collections::BTreeMap<String, u64>,
}

impl Delivered {
    pub fn load(path: &Path) -> Self {
        std::fs::read(path)
            .ok()
            .and_then(|raw| serde_json::from_slice(&raw).ok())
            .unwrap_or_default()
    }

    pub fn seq_for(&self, operation_id: &str) -> u64 {
        self.acked.get(operation_id).copied().unwrap_or(0)
    }

    /// Never moves backwards: an out-of-order acknowledgement must not cause an
    /// event to be sent a second time, and the Control Plane refuses replays
    /// anyway.
    pub fn record(&mut self, operation_id: &str, seq: u64) {
        let entry = self.acked.entry(operation_id.to_owned()).or_insert(0);
        if seq > *entry {
            *entry = seq;
        }
    }

    /// Written through a temporary file and renamed, so a crash mid-save leaves
    /// the previous cursor rather than a truncated one. Losing a cursor costs a
    /// redelivery, which the Control Plane discards; a corrupt one would cost
    /// the whole history.
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let staging = path.with_extension("tmp");
        std::fs::write(&staging, serde_json::to_vec(self)?)
            .with_context(|| format!("cannot write {}", staging.display()))?;
        std::fs::rename(&staging, path)
            .with_context(|| format!("cannot put {} in place", path.display()))?;
        Ok(())
    }
}

/// Everything not yet acknowledged, across every journal on this host.
///
/// This is what makes a restart invisible to an operator: the events written
/// while the daemon was being replaced are still on disk, and the process that
/// comes back sends them before anything else.
pub fn undelivered(node_home: &Path) -> Vec<ProgressEvent> {
    let delivered = Delivered::load(&cursor_path(node_home));
    let mut pending = Vec::new();
    for operation in journalled_operations(node_home) {
        let acked = delivered.seq_for(&operation);
        for event in read_journal(&journal_path(node_home, &operation)) {
            if event.seq > acked {
                pending.push(event);
            }
        }
    }
    pending
}

fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("node")).unwrap();
        dir
    }

    /// The id reaches a filename, so it is checked for what it could mean
    /// elsewhere rather than for whether it looks plausible.
    #[test]
    fn nothing_but_an_operation_id_is_accepted() {
        for good in ["a9ae2360-caab-4eeb-9ee9-031cfe4eae11", "op_1", "ABC-123"] {
            assert!(
                validate_operation_id(good).is_ok(),
                "{good} must be accepted"
            );
        }
        for bad in [
            "",
            "../etc/passwd",
            "op/../x",
            "op id",
            "op;reboot",
            "$(id)",
            "a/b",
            &"x".repeat(MAX_OPERATION_ID + 1),
        ] {
            assert!(
                validate_operation_id(bad).is_err(),
                "{bad:?} must be refused"
            );
        }
    }

    #[test]
    fn events_are_numbered_from_one_and_read_back_in_order() {
        let dir = home();
        let journal = Journal::open(dir.path(), "op-1").unwrap();
        journal
            .append("bundle_downloading", Some((10, Some(100))), None)
            .unwrap();
        journal.append("runtime_installing", None, None).unwrap();
        journal.append("complete", None, None).unwrap();

        let events = read_journal(&journal_path(dir.path(), "op-1"));
        assert_eq!(
            events.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![1, 2, 3],
            "sequences must be monotonic and start at one"
        );
        assert_eq!(events[0].bytes_done, Some(10));
        assert_eq!(events[0].bytes_total, Some(100));
        assert_eq!(events[2].state, "complete");
    }

    /// An update runs the updater twice. The second process reopens the same
    /// journal, and must continue the sequence rather than restart it -- two
    /// events numbered 1 would make the Control Plane discard the second as a
    /// replay of the first.
    #[test]
    fn reopening_a_journal_continues_the_sequence() {
        let dir = home();
        let first = Journal::open(dir.path(), "op-1").unwrap();
        first.append("bundle_verified", None, None).unwrap();
        drop(first);

        let second = Journal::open(dir.path(), "op-1").unwrap();
        let event = second.append("runtime_installing", None, None).unwrap();
        assert_eq!(event.seq, 2);
    }

    /// The updater is replaced mid-write by design, so a torn last line is a
    /// thing that happens. Losing one report must not lose the history.
    #[test]
    fn a_torn_line_costs_one_event_and_not_the_rest() {
        let dir = home();
        let journal = Journal::open(dir.path(), "op-1").unwrap();
        journal.append("bundle_verified", None, None).unwrap();
        let path = journal_path(dir.path(), "op-1");
        let mut raw = std::fs::read_to_string(&path).unwrap();
        raw.push_str("{\"operation_id\":\"op-1\",\"seq\":2,\"sta");
        std::fs::write(&path, raw).unwrap();

        let events = read_journal(&path);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].state, "bundle_verified");
    }

    /// One journal per operation, so an event from a previous update cannot be
    /// mistaken for one belonging to this one.
    #[test]
    fn events_from_an_earlier_operation_stay_with_that_operation() {
        let dir = home();
        Journal::open(dir.path(), "old")
            .unwrap()
            .append("failed", None, Some("download_failed"))
            .unwrap();
        Journal::open(dir.path(), "new")
            .unwrap()
            .append("bundle_downloading", None, None)
            .unwrap();

        let pending = undelivered(dir.path());
        let for_old: Vec<_> = pending.iter().filter(|e| e.operation_id == "old").collect();
        let for_new: Vec<_> = pending.iter().filter(|e| e.operation_id == "new").collect();
        assert_eq!(for_old.len(), 1);
        assert_eq!(for_new.len(), 1);
        assert_eq!(for_old[0].failure_code.as_deref(), Some("download_failed"));
        // Every event names the operation it belongs to, which is what the
        // Control Plane matches on before applying one.
        assert!(pending.iter().all(|e| !e.operation_id.is_empty()));
    }

    /// The restart case, which is the reason any of this is on disk: events
    /// written while nothing could send them are still there afterwards.
    #[test]
    fn everything_unacknowledged_is_offered_again_after_a_restart() {
        let dir = home();
        let journal = Journal::open(dir.path(), "op-1").unwrap();
        for state in ["bundle_downloading", "runtime_installing", "complete"] {
            journal.append(state, None, None).unwrap();
        }
        assert_eq!(undelivered(dir.path()).len(), 3);

        // The Control Plane acknowledged the first two.
        let cursor = cursor_path(dir.path());
        let mut delivered = Delivered::load(&cursor);
        delivered.record("op-1", 2);
        delivered.save(&cursor).unwrap();

        let pending = undelivered(dir.path());
        assert_eq!(pending.len(), 1, "only what was never acknowledged");
        assert_eq!(pending[0].seq, 3);
    }

    #[test]
    fn a_cursor_never_moves_backwards() {
        let mut delivered = Delivered::default();
        delivered.record("op-1", 5);
        delivered.record("op-1", 2);
        assert_eq!(delivered.seq_for("op-1"), 5);
        assert_eq!(delivered.seq_for("unknown"), 0);
    }

    /// A cursor that cannot be parsed is a redelivery, never a lost history.
    #[test]
    fn an_unreadable_cursor_replays_rather_than_forgets() {
        let dir = home();
        let journal = Journal::open(dir.path(), "op-1").unwrap();
        journal.append("complete", None, None).unwrap();
        std::fs::write(cursor_path(dir.path()), b"{ not json").unwrap();
        assert_eq!(undelivered(dir.path()).len(), 1);
    }

    /// Root writes, the service account reads, and cannot write back: a journal
    /// the forwarder could edit would be a journal it could forge.
    #[test]
    fn the_journal_is_readable_by_the_account_that_forwards_it() {
        use std::os::unix::fs::PermissionsExt;
        let dir = home();
        Journal::open(dir.path(), "op-1").unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&journal_root(dir.path())), 0o755);
        assert_eq!(mode(&journal_path(dir.path(), "op-1")), 0o644);
    }

    #[test]
    fn only_the_most_recent_journals_are_kept() {
        let dir = home();
        for index in 0..KEEP_JOURNALS + 3 {
            Journal::open(dir.path(), &format!("op-{index}"))
                .unwrap()
                .append("complete", None, None)
                .unwrap();
            // Distinct modification times, which is what the ordering uses.
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        prune_journals(dir.path());
        assert_eq!(journalled_operations(dir.path()).len(), KEEP_JOURNALS);
    }
}
