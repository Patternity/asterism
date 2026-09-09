//! Every provider credential this Node holds.
//!
//! Credentials belong to a Node. Not to an organization, not to a project: the
//! secret is a file on one host, usable only by processes on that host, and a
//! model that let it belong anywhere else would be describing something that is
//! not true. What the Control Plane keeps is a list of *facts about* credentials
//! — an id, a label, which provider, how it was obtained, what state it is in.
//! No token, no file, no path, no fingerprint.
//!
//! **The pool is where secrets already live.** Hermes keeps a pooled credential
//! store per provider and can hold several at once; `auth list` enumerates them,
//! `auth add` appends, `auth remove` takes one away by id or label. That is the
//! isolation this registry needs and it already exists, so nothing here copies a
//! credential anywhere. A copy is the one thing that must not happen: every
//! project on this host reads the pool, and a second file holding the same
//! credential would diverge the moment either was refreshed.
//!
//! So this module owns the *metadata*, keeps it beside the pool rather than
//! inside it, and reconciles the two. The pool is the authority on what exists;
//! the registry is the authority on what each one is called and how it got here.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

/// Most credentials one Node may hold. Generous for any real host, small enough
/// that a registry cannot become a denial of service.
pub const MAX_CREDENTIALS: usize = 16;

/// Longest a label may be. It reaches a page and a `hermes auth remove` target.
pub const MAX_LABEL_LENGTH: usize = 64;

/// Longest a credential id may be.
pub const MAX_ID_LENGTH: usize = 64;

/// What a credential is called when this Node adopted one it did not create.
pub const ADOPTED_LABEL: &str = "Existing credential";

/// Where a credential stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialState {
    /// Known to the registry, holding nothing. A completed attempt that left no
    /// credential, or one whose pool entry has since gone.
    Required,
    /// A code is out and somebody is expected to approve it in a browser.
    Authorizing,
    /// The pool holds it.
    Authorized,
    /// The last attempt did not finish. Starting again is safe.
    Failed,
    /// Taken away deliberately. Kept as a row so the removal is legible rather
    /// than a credential that silently stopped existing.
    Revoked,
}

impl CredentialState {
    pub fn wire(self) -> &'static str {
        match self {
            Self::Required => "required",
            Self::Authorizing => "authorizing",
            Self::Authorized => "authorized",
            Self::Failed => "failed",
            Self::Revoked => "revoked",
        }
    }
}

/// One credential, as this Node records it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Credential {
    pub id: String,
    pub provider_id: String,
    pub auth_method: String,
    pub label: String,
    pub state: CredentialState,
    /// Hermes's own name for this entry in its pool.
    ///
    /// Node-local and deliberately never reported: it is how this host finds the
    /// credential again, which makes it a locator, and locators belong to the
    /// host that can use them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pool_entry: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

/// What the Control Plane is told. Everything here is safe to store, log and
/// render; nothing here is derived from a secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialSummary {
    pub id: String,
    pub provider_id: String,
    pub auth_method: String,
    pub label: String,
    pub state: String,
    pub created_at: u64,
    pub updated_at: u64,
}

impl From<&Credential> for CredentialSummary {
    fn from(credential: &Credential) -> Self {
        Self {
            id: credential.id.clone(),
            provider_id: credential.provider_id.clone(),
            auth_method: credential.auth_method.clone(),
            label: credential.label.clone(),
            state: credential.state.wire().to_owned(),
            created_at: credential.created_at,
            updated_at: credential.updated_at,
        }
    }
}

/// One entry as Hermes reports it. Never carries a token: `auth list` prints an
/// index, an id and a type, which is all this needs and all it reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolEntry {
    pub id: String,
    pub kind: String,
}

/// The credential types Hermes prints, used to find where an id ends.
const POOL_KINDS: &[&str] = &["oauth", "api-key", "api_key"];

/// Parse `hermes auth list <provider>`.
///
/// The observed output, with two credentials in the pool:
///
/// ```text
/// openai-codex (2 credentials):
///   #1  openai-codex-oauth-1 oauth   device_code ←
///   #2  Second account       oauth   device_code
/// ```
///
/// **An entry id can contain spaces and capitals.** Hermes names an entry after
/// the `--label` it was given, so a credential called `Second account` has that
/// as its id. A parser that took the second whitespace-separated field read
/// `Second`, refused it as unusable, and reported a pool with one credential in
/// it -- which marked a login that had just succeeded as failed. Found in live
/// acceptance, on the first credential ever created this way.
///
/// So the id is everything between the index and the *type*, which comes from a
/// small closed vocabulary and is therefore the one field that can be located
/// from the right. Matched on shape rather than on the heading's prose, which is
/// a human-facing sentence and not a contract; a line that does not parse is
/// skipped, because half a listing beats none and the pool is asked again on
/// every list.
pub fn parse_pool_listing(text: &str) -> Vec<PoolEntry> {
    let mut entries = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix('#') else {
            continue;
        };
        let fields: Vec<&str> = rest.split_whitespace().collect();
        let Some(index) = fields.first() else {
            continue;
        };
        if !index.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        // From the right: the last field that names a type and has an id in
        // front of it. Scanning from the left would stop at an id that merely
        // contains the word, like `openai-codex-oauth-1`.
        let Some(kind_at) = (2..fields.len())
            .rev()
            .find(|position| POOL_KINDS.contains(&fields[*position]))
        else {
            continue;
        };
        let id = fields[1..kind_at].join(" ");
        if !is_usable_pool_id(&id) {
            continue;
        }
        entries.push(PoolEntry {
            id,
            kind: fields[kind_at].to_owned(),
        });
    }
    entries
}

/// Whether a pool id is one this Node can carry and hand back to Hermes.
///
/// Deliberately looser than a credential id of our own: this name is Hermes's,
/// not ours, and refusing a legitimate one costs a credential. It travels as a
/// single argument to `hermes auth remove` and never through a shell, so a space
/// is harmless; a control character is not, and neither is something unbounded.
fn is_usable_pool_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_LABEL_LENGTH && !id.chars().any(char::is_control)
}

/// A credential id this Node will accept.
///
/// The alphabet is closed rather than escaped. This value reaches a filename in
/// a future phase, a database key, and a URL, and refusing is a claim about one
/// string where escaping would be a claim about every consumer.
pub fn validate_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > MAX_ID_LENGTH {
        bail!("a credential id must be between 1 and {MAX_ID_LENGTH} characters");
    }
    if !is_safe_token(id) {
        bail!("a credential id may hold only lowercase letters, digits and dashes");
    }
    Ok(())
}

/// A label a person typed. Bounded, and free of the control characters that
/// would let it lie about which line of a listing it is on.
pub fn validate_label(label: &str) -> Result<()> {
    let trimmed = label.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_LABEL_LENGTH {
        bail!("a label must be between 1 and {MAX_LABEL_LENGTH} characters");
    }
    if trimmed.chars().any(|c| c.is_control()) {
        bail!("a label may not hold control characters");
    }
    Ok(())
}

fn is_safe_token(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// The id this Node gives a credential it adopted rather than created.
///
/// Derived from the pool entry, so adopting the same credential twice produces
/// the same id — on a second reconnect, after a restart, and even if the
/// registry file were lost entirely. That is what makes the migration
/// idempotent rather than merely usually-idempotent.
pub fn adopted_id(provider_id: &str, pool_entry: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(provider_id.as_bytes());
    hasher.update(b"/");
    hasher.update(pool_entry.as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("cred-{hex}")
}

/// The metadata this Node keeps about its credentials.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Registry {
    #[serde(default)]
    pub credentials: Vec<Credential>,
}

/// Where the registry lives, given a Node home.
pub fn registry_path(node_home: &Path) -> PathBuf {
    node_home.join("node/credentials.json")
}

impl Registry {
    /// Read the registry, or start an empty one.
    ///
    /// A registry that cannot be parsed is treated as absent rather than fatal:
    /// the pool is the authority on what exists, so a lost registry costs labels
    /// and nothing else — every credential is adopted again under the same id.
    pub fn load(path: &Path) -> Self {
        std::fs::read(path)
            .ok()
            .and_then(|raw| serde_json::from_slice(&raw).ok())
            .unwrap_or_default()
    }

    /// Write it through a temporary file and rename.
    ///
    /// `0600`, owned by the account that runs the Node. It holds no secret, but
    /// it holds the labels a person chose and the shape of what this host can
    /// reach, and neither is anybody else's on a shared machine.
    pub fn save(&self, path: &Path) -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let staging = path.with_extension("tmp");
        std::fs::write(&staging, serde_json::to_vec_pretty(self)?)
            .with_context(|| format!("cannot write {}", staging.display()))?;
        std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o600))?;
        std::fs::rename(&staging, path)
            .with_context(|| format!("cannot put {} in place", path.display()))?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<&Credential> {
        self.credentials.iter().find(|entry| entry.id == id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut Credential> {
        self.credentials.iter_mut().find(|entry| entry.id == id)
    }

    /// Bring the registry into agreement with what the pool actually holds.
    ///
    /// Three things happen, and the order matters:
    ///
    /// 1. A pool entry nobody has a row for is **adopted** — given a
    ///    deterministic id and a plain label. This is the migration, and it runs
    ///    on every reconcile rather than once, which is what makes it idempotent
    ///    instead of a one-shot that has to be got right.
    /// 2. A row whose pool entry is gone becomes `Revoked` if this Node took it
    ///    away, or `Required` if it simply is not there any more.
    /// 3. A row whose pool entry is present is `Authorized`.
    ///
    /// Nothing is read from the credential itself at any point, and nothing is
    /// written to the pool. This function only ever changes labels and states.
    pub fn reconcile(&mut self, provider_id: &str, pool: &[PoolEntry], now: u64) -> bool {
        let mut changed = false;
        let present: BTreeMap<&str, &PoolEntry> = pool
            .iter()
            .map(|entry| (entry.id.as_str(), entry))
            .collect();

        for entry in pool {
            let already = self.credentials.iter().any(|credential| {
                credential.pool_entry.as_deref() == Some(entry.id.as_str())
                    && credential.provider_id == provider_id
            });
            if already {
                continue;
            }

            // Hermes names an entry after the `--label` it was given, so a
            // credential this Node created and is still waiting on can be
            // matched exactly rather than guessed at. This is what binds a login
            // to the credential a person actually asked for, instead of adopting
            // it as an anonymous one beside the row that started it.
            let waiting = self.credentials.iter_mut().find(|credential| {
                credential.provider_id == provider_id
                    && credential.pool_entry.is_none()
                    && credential.label == entry.id
                    && matches!(
                        credential.state,
                        CredentialState::Authorizing | CredentialState::Failed
                    )
            });
            if let Some(credential) = waiting {
                credential.pool_entry = Some(entry.id.clone());
                credential.state = CredentialState::Authorized;
                credential.updated_at = now;
                changed = true;
                continue;
            }
            if self.credentials.len() >= MAX_CREDENTIALS {
                break;
            }
            self.credentials.push(Credential {
                id: adopted_id(provider_id, &entry.id),
                provider_id: provider_id.to_owned(),
                // The pool records how it was obtained; `device_code` is the
                // only source this Node can produce today.
                auth_method: "device_authorization".to_owned(),
                label: ADOPTED_LABEL.to_owned(),
                state: CredentialState::Authorized,
                pool_entry: Some(entry.id.clone()),
                created_at: now,
                updated_at: now,
            });
            changed = true;
        }

        for credential in &mut self.credentials {
            if credential.provider_id != provider_id {
                continue;
            }
            let holds = credential
                .pool_entry
                .as_deref()
                .is_some_and(|id| present.contains_key(id));
            let wanted = match (holds, credential.state) {
                (true, CredentialState::Authorized) => continue,
                (true, _) => CredentialState::Authorized,
                // A deliberate removal keeps its meaning; anything else that
                // vanished is simply not there.
                (false, CredentialState::Revoked) => continue,
                (false, CredentialState::Authorizing) => continue,
                (false, CredentialState::Failed) => continue,
                (false, CredentialState::Required) => continue,
                (false, CredentialState::Authorized) => CredentialState::Required,
            };
            credential.state = wanted;
            credential.updated_at = now;
            changed = true;
        }

        changed
    }

    /// What the Control Plane is told.
    pub fn summaries(&self) -> Vec<CredentialSummary> {
        self.credentials
            .iter()
            .map(CredentialSummary::from)
            .collect()
    }

    /// The one state a whole provider is in, derived from its credentials.
    ///
    /// Derived rather than stored beside them. Two facts about the same thing
    /// disagree eventually, and the one that disagrees silently is the one a
    /// console shows.
    pub fn provider_state(&self, provider_id: &str) -> Option<CredentialState> {
        let mut best: Option<CredentialState> = None;
        for credential in self
            .credentials
            .iter()
            .filter(|entry| entry.provider_id == provider_id)
        {
            let rank = |state: CredentialState| match state {
                CredentialState::Authorized => 4,
                CredentialState::Authorizing => 3,
                CredentialState::Failed => 2,
                CredentialState::Required => 1,
                CredentialState::Revoked => 0,
            };
            if best.is_none_or(|current| rank(credential.state) > rank(current)) {
                best = Some(credential.state);
            }
        }
        best
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str) -> PoolEntry {
        PoolEntry {
            id: id.to_owned(),
            kind: "oauth".to_owned(),
        }
    }

    /// The exact output observed on the production host.
    #[test]
    fn the_pool_listing_is_read_as_hermes_prints_it() {
        let observed =
            "openai-codex (1 credentials):\n  #1  openai-codex-oauth-1 oauth   device_code ←\n";
        assert_eq!(
            parse_pool_listing(observed),
            vec![PoolEntry {
                id: "openai-codex-oauth-1".to_owned(),
                kind: "oauth".to_owned(),
            }]
        );
    }

    /// Also observed on production, on the first credential ever created this
    /// way: Hermes names an entry after the label it was given, so the id has a
    /// capital and a space in it. Reading only the second field gave `Second`,
    /// which was refused -- and a login that had just been approved was recorded
    /// as failed.
    #[test]
    fn an_entry_named_after_its_label_is_read_whole() {
        let observed = concat!(
            "openai-codex (2 credentials):\n",
            "  #1  openai-codex-oauth-1 oauth   device_code \u{2190}\n",
            "  #2  Second account       oauth   device_code\n",
        );
        assert_eq!(
            parse_pool_listing(observed),
            vec![
                PoolEntry {
                    id: "openai-codex-oauth-1".to_owned(),
                    kind: "oauth".to_owned(),
                },
                PoolEntry {
                    id: "Second account".to_owned(),
                    kind: "oauth".to_owned(),
                },
            ]
        );
    }

    /// The type is found from the right, so an id that merely contains the word
    /// is not mistaken for it.
    #[test]
    fn an_id_containing_the_type_word_is_not_cut_short() {
        assert_eq!(
            parse_pool_listing("  #1  my-oauth-account oauth   device_code")[0].id,
            "my-oauth-account"
        );
        assert_eq!(
            parse_pool_listing("  #2  oauth oauth   device_code")[0].id,
            "oauth"
        );
    }

    #[test]
    fn an_api_key_entry_is_read_too() {
        assert_eq!(
            parse_pool_listing("  #1  Work key api-key   env"),
            vec![PoolEntry {
                id: "Work key".to_owned(),
                kind: "api-key".to_owned(),
            }]
        );
    }

    #[test]
    fn several_entries_are_all_read() {
        let listing = "openai-codex (2 credentials):\n  #1  openai-codex-oauth-1 oauth   device_code ←\n  #2  openai-codex-oauth-2 oauth   device_code\n";
        let entries = parse_pool_listing(listing);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1].id, "openai-codex-oauth-2");
    }

    /// The heading is prose and may be reworded; nothing depends on it.
    #[test]
    fn anything_that_is_not_an_entry_line_is_ignored() {
        assert!(parse_pool_listing("no credentials configured").is_empty());
        assert!(parse_pool_listing("").is_empty());
        assert!(parse_pool_listing("#  oauth").is_empty());
        // No type field to anchor the id against.
        assert!(parse_pool_listing("  #1  something").is_empty());
        assert!(parse_pool_listing("  #1  oauth").is_empty());
        // Bounded and free of control characters, which is all this Node asks of
        // a name that is Hermes's rather than its own. Nothing here becomes a
        // path: it is hashed for an id and handed back to `hermes auth remove`
        // as a single argument, never through a shell.
        let too_long = format!(
            "  #1  {} oauth device_code\n",
            "x".repeat(MAX_LABEL_LENGTH + 1)
        );
        assert!(parse_pool_listing(&too_long).is_empty());
        assert!(parse_pool_listing("  #1  a\u{7}b oauth device_code").is_empty());
    }

    #[test]
    fn an_adopted_id_is_the_same_every_time_it_is_derived() {
        let first = adopted_id("openai-codex", "openai-codex-oauth-1");
        assert_eq!(first, adopted_id("openai-codex", "openai-codex-oauth-1"));
        assert!(validate_id(&first).is_ok());
        assert!(first.starts_with("cred-"));
        // Different entries, different ids.
        assert_ne!(first, adopted_id("openai-codex", "openai-codex-oauth-2"));
        assert_ne!(first, adopted_id("other", "openai-codex-oauth-1"));
    }

    /// The migration, run twice, changes nothing the second time.
    #[test]
    fn adopting_the_existing_credential_is_idempotent() {
        let mut registry = Registry::default();
        let pool = vec![entry("openai-codex-oauth-1")];

        assert!(registry.reconcile("openai-codex", &pool, 100));
        assert_eq!(registry.credentials.len(), 1);
        let adopted = registry.credentials[0].clone();
        assert_eq!(adopted.label, ADOPTED_LABEL);
        assert_eq!(adopted.state, CredentialState::Authorized);
        assert_eq!(adopted.pool_entry.as_deref(), Some("openai-codex-oauth-1"));

        // Every later reconcile is a no-op.
        for _ in 0..3 {
            assert!(!registry.reconcile("openai-codex", &pool, 200));
            assert_eq!(registry.credentials.len(), 1);
            assert_eq!(registry.credentials[0], adopted);
        }
    }

    /// Even a registry that was lost entirely re-adopts to the same identity.
    #[test]
    fn a_lost_registry_re_adopts_under_the_same_id() {
        let pool = vec![entry("openai-codex-oauth-1")];
        let mut first = Registry::default();
        first.reconcile("openai-codex", &pool, 100);
        let mut second = Registry::default();
        second.reconcile("openai-codex", &pool, 900);
        assert_eq!(first.credentials[0].id, second.credentials[0].id);
    }

    #[test]
    fn a_second_credential_is_adopted_beside_the_first_and_not_over_it() {
        let mut registry = Registry::default();
        registry.reconcile("openai-codex", &[entry("openai-codex-oauth-1")], 100);
        let first = registry.credentials[0].clone();

        registry.reconcile(
            "openai-codex",
            &[entry("openai-codex-oauth-1"), entry("openai-codex-oauth-2")],
            200,
        );
        assert_eq!(registry.credentials.len(), 2);
        // The first is untouched, down to its timestamps.
        assert_eq!(registry.credentials[0], first);
        assert_ne!(registry.credentials[1].id, first.id);
        assert_eq!(registry.credentials[1].state, CredentialState::Authorized);
    }

    /// The repair for what live acceptance found: a login that was approved
    /// binds to the credential a person actually asked for, keeping its label,
    /// rather than being adopted as an anonymous one beside it.
    #[test]
    fn an_approved_login_binds_to_the_credential_that_started_it() {
        let mut registry = Registry::default();
        registry.reconcile("openai-codex", &[entry("openai-codex-oauth-1")], 100);
        registry.credentials.push(Credential {
            id: "cred-second".to_owned(),
            provider_id: "openai-codex".to_owned(),
            auth_method: "device_authorization".to_owned(),
            label: "Second account".to_owned(),
            state: CredentialState::Authorizing,
            pool_entry: None,
            created_at: 200,
            updated_at: 200,
        });

        // Hermes names the new entry after the label it was given.
        registry.reconcile(
            "openai-codex",
            &[entry("openai-codex-oauth-1"), entry("Second account")],
            300,
        );

        assert_eq!(registry.credentials.len(), 2, "no anonymous third row");
        let second = registry.get("cred-second").unwrap();
        assert_eq!(second.state, CredentialState::Authorized);
        assert_eq!(second.label, "Second account", "the chosen name survives");
        assert_eq!(second.pool_entry.as_deref(), Some("Second account"));
        // And the first is untouched.
        assert_eq!(registry.credentials[0].label, ADOPTED_LABEL);
    }

    /// The same repair applies to one already recorded as failed, which is the
    /// state production reached before this existed.
    #[test]
    fn a_login_recorded_as_failed_is_repaired_when_the_pool_shows_it_worked() {
        let mut registry = Registry::default();
        registry.credentials.push(Credential {
            id: "cred-second".to_owned(),
            provider_id: "openai-codex".to_owned(),
            auth_method: "device_authorization".to_owned(),
            label: "Second account".to_owned(),
            state: CredentialState::Failed,
            pool_entry: None,
            created_at: 200,
            updated_at: 200,
        });
        registry.reconcile("openai-codex", &[entry("Second account")], 300);
        assert_eq!(registry.credentials.len(), 1);
        assert_eq!(registry.credentials[0].state, CredentialState::Authorized);
    }

    /// Binding is by exact label, so a pool entry nobody was waiting for is
    /// adopted rather than handed to an unrelated credential.
    #[test]
    fn an_entry_nobody_asked_for_is_adopted_and_not_given_away() {
        let mut registry = Registry::default();
        registry.credentials.push(Credential {
            id: "cred-second".to_owned(),
            provider_id: "openai-codex".to_owned(),
            auth_method: "device_authorization".to_owned(),
            label: "Second account".to_owned(),
            state: CredentialState::Authorizing,
            pool_entry: None,
            created_at: 200,
            updated_at: 200,
        });
        registry.reconcile("openai-codex", &[entry("added-by-hand")], 300);

        assert_eq!(registry.credentials.len(), 2);
        assert_eq!(
            registry.get("cred-second").unwrap().state,
            CredentialState::Authorizing
        );
        assert_eq!(registry.credentials[1].label, ADOPTED_LABEL);
        assert_eq!(
            registry.credentials[1].pool_entry.as_deref(),
            Some("added-by-hand")
        );
    }

    /// A revoked credential is not a slot for a later entry to fall into.
    #[test]
    fn a_revoked_credential_does_not_reclaim_an_entry_by_name() {
        let mut registry = Registry::default();
        registry.credentials.push(Credential {
            id: "cred-gone".to_owned(),
            provider_id: "openai-codex".to_owned(),
            auth_method: "device_authorization".to_owned(),
            label: "Second account".to_owned(),
            state: CredentialState::Revoked,
            pool_entry: None,
            created_at: 200,
            updated_at: 200,
        });
        registry.reconcile("openai-codex", &[entry("Second account")], 300);
        assert_eq!(
            registry.get("cred-gone").unwrap().state,
            CredentialState::Revoked
        );
        assert_eq!(
            registry.credentials.len(),
            2,
            "adopted as its own row instead"
        );
    }

    #[test]
    fn a_credential_that_left_the_pool_is_no_longer_authorized() {
        let mut registry = Registry::default();
        registry.reconcile("openai-codex", &[entry("openai-codex-oauth-1")], 100);
        assert!(registry.reconcile("openai-codex", &[], 200));
        assert_eq!(registry.credentials[0].state, CredentialState::Required);
    }

    /// A deliberate removal keeps its meaning rather than decaying into "not
    /// there", which is what an operator would see for a credential that never
    /// existed.
    #[test]
    fn a_revoked_credential_stays_revoked() {
        let mut registry = Registry::default();
        registry.reconcile("openai-codex", &[entry("openai-codex-oauth-1")], 100);
        registry.credentials[0].state = CredentialState::Revoked;
        registry.reconcile("openai-codex", &[], 200);
        assert_eq!(registry.credentials[0].state, CredentialState::Revoked);
    }

    #[test]
    fn a_fresh_node_has_an_empty_registry_and_that_is_valid() {
        let mut registry = Registry::default();
        assert!(!registry.reconcile("openai-codex", &[], 100));
        assert!(registry.credentials.is_empty());
        assert!(registry.summaries().is_empty());
        assert_eq!(registry.provider_state("openai-codex"), None);
    }

    #[test]
    fn the_registry_never_grows_past_its_bound() {
        let mut registry = Registry::default();
        let pool: Vec<PoolEntry> = (0..MAX_CREDENTIALS + 5)
            .map(|n| entry(&format!("openai-codex-oauth-{n}")))
            .collect();
        registry.reconcile("openai-codex", &pool, 100);
        assert_eq!(registry.credentials.len(), MAX_CREDENTIALS);
    }

    /// Nothing a locator could be reached through leaves this host.
    #[test]
    fn what_is_reported_carries_no_locator_and_no_secret() {
        let mut registry = Registry::default();
        registry.reconcile("openai-codex", &[entry("openai-codex-oauth-1")], 100);
        let reported = serde_json::to_string(&registry.summaries()).unwrap();
        assert!(!reported.contains("pool_entry"));
        assert!(!reported.contains("openai-codex-oauth-1"));
        assert!(!reported.contains("auth.json"));
        assert!(!reported.contains("/var/lib"));
        // And what it does carry.
        assert!(reported.contains("openai-codex"));
        assert!(reported.contains(ADOPTED_LABEL));
        assert!(reported.contains("device_authorization"));
        assert!(reported.contains("authorized"));
    }

    #[test]
    fn the_provider_state_is_the_strongest_thing_any_credential_says() {
        let mut registry = Registry::default();
        registry.reconcile("openai-codex", &[entry("a"), entry("b")], 100);
        assert_eq!(
            registry.provider_state("openai-codex"),
            Some(CredentialState::Authorized)
        );

        registry.credentials[0].state = CredentialState::Revoked;
        assert_eq!(
            registry.provider_state("openai-codex"),
            Some(CredentialState::Authorized),
            "one revoked credential does not un-authorize a host that still holds another"
        );

        registry.credentials[1].state = CredentialState::Failed;
        assert_eq!(
            registry.provider_state("openai-codex"),
            Some(CredentialState::Failed)
        );
        assert_eq!(registry.provider_state("nothing-here"), None);
    }

    #[test]
    fn ids_and_labels_are_bounded_and_refuse_what_they_should() {
        assert!(validate_id("cred-0011aabb").is_ok());
        for bad in ["", "../etc", "Cred", "a b", "a_b", &"x".repeat(65)] {
            assert!(validate_id(bad).is_err(), "{bad:?}");
        }

        assert!(validate_label("Personal account").is_ok());
        assert!(validate_label(ADOPTED_LABEL).is_ok());
        for bad in ["", "   ", &"x".repeat(65), "two\nlines", "bell\u{7}"] {
            assert!(validate_label(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_registry_survives_a_round_trip_through_disk() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("node")).unwrap();
        let path = registry_path(dir.path());

        let mut registry = Registry::default();
        registry.reconcile("openai-codex", &[entry("openai-codex-oauth-1")], 100);
        registry.save(&path).unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "the registry is nobody else's on a shared host"
        );
        assert_eq!(Registry::load(&path).credentials, registry.credentials);
    }

    /// The pool is the authority on what exists, so a registry that cannot be
    /// read costs labels and nothing else.
    #[test]
    fn an_unreadable_registry_starts_empty_rather_than_failing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("credentials.json");
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(Registry::load(&path).credentials.is_empty());
    }
}
