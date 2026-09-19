//! What the runtime's own record says about one isolated credential.
//!
//! The runtime keeps its credentials in a store beside them, and that store is
//! the only place a *provider's* verdict is written down. This module reads the
//! few facts about a record that are not secrets -- whether it is there, what it
//! is called, how it was obtained, and what the runtime last concluded about it
//! -- and nothing else.
//!
//! **No token is ever held.** The store is parsed into types that have no field
//! for one, so a token is discarded by the parser and never reaches a value this
//! Node can print, copy, store or hand to anybody. Nothing here writes to the
//! store either: replacing a credential is a file swap, made elsewhere, by the
//! runtime's own material.
//!
//! **Absence and death are different answers.** A record the runtime reports
//! dead is the provider saying this grant is finished. A record that is simply
//! not there says nothing about any grant: the runtime prunes its own dead
//! entries after a quiet window, and a store can predate a credential. Reading
//! the second as the first would manufacture a revocation nobody reported, so
//! they are separate verdicts and stay separate all the way to the console.

use std::path::Path;

use serde::Deserialize;

/// The runtime's status word for a record it will not use again.
const STATUS_DEAD: &str = "dead";

/// The HTTP status the runtime requires before it will call a grant finished.
const TERMINAL_STATUS_CODE: i64 = 401;

/// The runtime's closed vocabulary of terminal OAuth failures.
///
/// Mirrored deliberately rather than pattern-matched: these are the only reasons
/// the runtime itself promotes to a dead record, and a Node that accepted
/// anything else -- a bare 401, a rate limit, a billing refusal, a sentence
/// containing the word "revoked" -- would be guessing where the runtime was
/// careful. A reason outside this set is not a revocation here either.
const TERMINAL_REASONS: &[&str] = &[
    "token_invalidated",
    "token_revoked",
    "invalid_token",
    "invalid_grant",
    "unauthorized_client",
    "refresh_token_reused",
];

/// One record, read for its metadata alone.
///
/// Every secret-bearing field of the real record is absent from this struct on
/// purpose. Serde drops what it has no field for.
#[derive(Debug, Clone, Deserialize)]
struct RecordMetadata {
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    auth_type: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    last_status: Option<String>,
    #[serde(default)]
    last_error_code: Option<i64>,
    #[serde(default)]
    last_error_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct StoreMetadata {
    #[serde(default)]
    credential_pool: std::collections::BTreeMap<String, Vec<RecordMetadata>>,
}

/// What the runtime's record says about one credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeVerdict {
    /// A record is there and the runtime has not written it off.
    Usable,
    /// The runtime has written it off, for one of its terminal reasons.
    Dead { reason: String },
    /// No record for this credential. Says nothing about the grant.
    Missing,
    /// A store that is there and cannot be read as one.
    Unreadable,
}

/// A record's label is the product credential id, by construction.
///
/// This Node creates every isolated credential with `--label <credential id>`,
/// which is what lets one home's single record be matched to the row that owns
/// it without reading anything private.
fn matches(record: &RecordMetadata, credential_id: &str) -> bool {
    record.label.as_deref() == Some(credential_id)
}

/// Whether the runtime has written this record off, and why.
fn dead_reason(record: &RecordMetadata) -> Option<String> {
    if record.last_status.as_deref() != Some(STATUS_DEAD) {
        return None;
    }
    if record.last_error_code != Some(TERMINAL_STATUS_CODE) {
        return None;
    }
    let reason = record
        .last_error_reason
        .as_deref()?
        .trim()
        .to_ascii_lowercase();
    TERMINAL_REASONS
        .contains(&reason.as_str())
        .then_some(reason)
}

/// Read the verdict for one credential from the store in its own home.
pub fn verdict(store: &Path, provider_id: &str, credential_id: &str) -> RuntimeVerdict {
    let raw = match std::fs::read(store) {
        Ok(raw) => raw,
        // A store that is not there holds no record, which is exactly what
        // `Missing` means. Anything else about the file -- unreadable, a
        // directory, a broken link -- is a store this Node cannot judge.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return RuntimeVerdict::Missing;
        }
        Err(_) => return RuntimeVerdict::Unreadable,
    };
    let Ok(parsed) = serde_json::from_slice::<StoreMetadata>(&raw) else {
        return RuntimeVerdict::Unreadable;
    };
    let Some(records) = parsed.credential_pool.get(provider_id) else {
        return RuntimeVerdict::Missing;
    };
    let Some(record) = records.iter().find(|record| matches(record, credential_id)) else {
        return RuntimeVerdict::Missing;
    };
    match dead_reason(record) {
        Some(reason) => RuntimeVerdict::Dead { reason },
        None => RuntimeVerdict::Usable,
    }
}

/// Why a staged store is not fit to replace a credential's own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StagedRejection {
    Unreadable,
    /// Not exactly one record. A home holding two credentials is a home no
    /// project can select one of, which is the whole point of isolating them.
    RecordCount(usize),
    WrongProvider,
    WrongLabel,
    WrongAuthMethod,
    /// Freshly written and already written off: nothing to swap in.
    NotUsable,
}

impl StagedRejection {
    /// A code for the operator, carrying no locator and no provider text.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unreadable => "staged_store_unreadable",
            Self::RecordCount(_) => "staged_store_record_count",
            Self::WrongProvider => "staged_store_wrong_provider",
            Self::WrongLabel => "staged_store_wrong_label",
            Self::WrongAuthMethod => "staged_store_wrong_auth_method",
            Self::NotUsable => "staged_store_not_usable",
        }
    }
}

/// Whether a staged store may replace the one in a credential's home.
///
/// Checked before the canonical file is touched, and every check is about
/// identity rather than content: exactly one record, for this provider, called
/// by this credential's id, obtained the way this credential was, and not
/// already written off. A staged store that fails any of them is discarded and
/// the credential keeps what it had.
pub fn accept_staged(
    store: &Path,
    provider_id: &str,
    credential_id: &str,
    auth_method: &str,
) -> Result<(), StagedRejection> {
    let Ok(raw) = std::fs::read(store) else {
        return Err(StagedRejection::Unreadable);
    };
    let Ok(parsed) = serde_json::from_slice::<StoreMetadata>(&raw) else {
        return Err(StagedRejection::Unreadable);
    };
    let total: usize = parsed.credential_pool.values().map(Vec::len).sum();
    if total != 1 {
        return Err(StagedRejection::RecordCount(total));
    }
    let Some(records) = parsed.credential_pool.get(provider_id) else {
        return Err(StagedRejection::WrongProvider);
    };
    let Some(record) = records.first() else {
        return Err(StagedRejection::WrongProvider);
    };
    if !matches(record, credential_id) {
        return Err(StagedRejection::WrongLabel);
    }
    // The product speaks of `device_authorization`; the runtime records the
    // record's own type and the source it came from. A device login produces an
    // OAuth record from a device-code source, and nothing else this Node asks
    // for does.
    if auth_method == "device_authorization" {
        if record.auth_type.as_deref() != Some("oauth") {
            return Err(StagedRejection::WrongAuthMethod);
        }
        if !record
            .source
            .as_deref()
            .is_some_and(|source| source.contains("device_code"))
        {
            return Err(StagedRejection::WrongAuthMethod);
        }
    }
    if dead_reason(record).is_some() {
        return Err(StagedRejection::NotUsable);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CRED: &str = "cred-0011aabbccddeeff";
    const PROVIDER: &str = "openai-codex";

    /// A store shaped like the runtime's own, including the fields this module
    /// refuses to have a home for.
    fn store(record: serde_json::Value) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let body = serde_json::json!({
            "version": 1,
            "updated_at": 1_700_000_000,
            "credential_pool": { PROVIDER: [record] },
        });
        std::fs::write(dir.path().join("auth.json"), body.to_string()).unwrap();
        dir
    }

    fn record(extra: serde_json::Value) -> serde_json::Value {
        let mut base = serde_json::json!({
            "id": "be042b",
            "label": CRED,
            "auth_type": "oauth",
            "source": "manual:device_code",
            // Present in every real record and deliberately unreachable here.
            "access_token": "tok-secret",
            "refresh_token": "ref-secret",
        });
        for (key, value) in extra.as_object().unwrap() {
            base[key] = value.clone();
        }
        base
    }

    fn read(dir: &tempfile::TempDir) -> RuntimeVerdict {
        verdict(&dir.path().join("auth.json"), PROVIDER, CRED)
    }

    #[test]
    fn a_live_record_is_usable() {
        assert_eq!(
            read(&store(record(serde_json::json!({})))),
            RuntimeVerdict::Usable
        );
    }

    #[test]
    fn the_exact_terminal_verdict_is_a_revocation() {
        for reason in TERMINAL_REASONS {
            let dir = store(record(serde_json::json!({
                "last_status": "dead",
                "last_error_code": 401,
                "last_error_reason": reason,
            })));
            assert_eq!(
                read(&dir),
                RuntimeVerdict::Dead {
                    reason: (*reason).to_owned()
                },
                "{reason} is one the runtime writes off"
            );
        }
    }

    /// Everything a careless reader would have called a revocation.
    #[test]
    fn nothing_else_is_a_revocation() {
        let cases = vec![
            // A bare 401: the runtime keeps this retryable on purpose.
            serde_json::json!({"last_status": "exhausted", "last_error_code": 401}),
            // 401 with a reason outside the closed set.
            serde_json::json!({
                "last_status": "dead", "last_error_code": 401,
                "last_error_reason": "server_error"}),
            // The right reason on the wrong status: rate limiting.
            serde_json::json!({
                "last_status": "dead", "last_error_code": 429,
                "last_error_reason": "token_revoked"}),
            // Billing, which is not about the grant at all.
            serde_json::json!({
                "last_status": "exhausted", "last_error_code": 402,
                "last_error_reason": "insufficient_quota"}),
            // A message that says the word and a status that does not.
            serde_json::json!({
                "last_status": "exhausted", "last_error_code": 401,
                "last_error_message": "your token was revoked"}),
            // Written off without saying why.
            serde_json::json!({"last_status": "dead", "last_error_code": 401}),
        ];
        for case in cases {
            assert_eq!(
                read(&store(record(case.clone()))),
                RuntimeVerdict::Usable,
                "{case} must not be read as a revocation"
            );
        }
    }

    /// The distinction the console depends on.
    #[test]
    fn an_absent_record_is_missing_and_not_revoked() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            verdict(&dir.path().join("auth.json"), PROVIDER, CRED),
            RuntimeVerdict::Missing
        );

        // A store the runtime pruned this credential out of.
        std::fs::write(
            dir.path().join("auth.json"),
            serde_json::json!({"credential_pool": {PROVIDER: []}}).to_string(),
        )
        .unwrap();
        assert_eq!(read(&dir), RuntimeVerdict::Missing);

        // A store holding somebody else's record only.
        std::fs::write(
            dir.path().join("auth.json"),
            serde_json::json!({"credential_pool": {PROVIDER: [
                record(serde_json::json!({"label": "cred-ffffffffffffffff"}))]}})
            .to_string(),
        )
        .unwrap();
        assert_eq!(read(&dir), RuntimeVerdict::Missing);
    }

    #[test]
    fn a_store_that_is_not_one_is_unreadable() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("auth.json"), b"{not json").unwrap();
        assert_eq!(read(&dir), RuntimeVerdict::Unreadable);
    }

    /// No value this module produces can carry a token, by construction.
    #[test]
    fn no_verdict_carries_credential_material() {
        let dir = store(record(serde_json::json!({
            "last_status": "dead", "last_error_code": 401,
            "last_error_reason": "token_revoked"})));
        let rendered = format!("{:?}", read(&dir));
        assert!(!rendered.contains("tok-secret"));
        assert!(!rendered.contains("ref-secret"));
        assert_eq!(rendered, "Dead { reason: \"token_revoked\" }");
    }

    fn staged(records: serde_json::Value) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("auth.json"),
            serde_json::json!({"credential_pool": records}).to_string(),
        )
        .unwrap();
        dir
    }

    fn check(dir: &tempfile::TempDir) -> Result<(), StagedRejection> {
        accept_staged(
            &dir.path().join("auth.json"),
            PROVIDER,
            CRED,
            "device_authorization",
        )
    }

    #[test]
    fn one_matching_record_may_replace_a_credential() {
        let dir = staged(serde_json::json!({PROVIDER: [record(serde_json::json!({}))]}));
        assert_eq!(check(&dir), Ok(()));
    }

    /// A home holding two credentials is a home no project can select one of.
    #[test]
    fn more_than_one_record_is_refused() {
        let two = staged(serde_json::json!({PROVIDER: [
            record(serde_json::json!({})),
            record(serde_json::json!({"id": "other"})),
        ]}));
        assert_eq!(check(&two), Err(StagedRejection::RecordCount(2)));

        let none = staged(serde_json::json!({PROVIDER: []}));
        assert_eq!(check(&none), Err(StagedRejection::RecordCount(0)));

        // Two providers, one record each: still two credentials in one home.
        let split = staged(serde_json::json!({
            PROVIDER: [record(serde_json::json!({}))],
            "anthropic": [record(serde_json::json!({}))],
        }));
        assert_eq!(check(&split), Err(StagedRejection::RecordCount(2)));
    }

    #[test]
    fn a_record_that_is_not_this_credential_is_refused() {
        let wrong_label = staged(serde_json::json!({
            PROVIDER: [record(serde_json::json!({"label": "cred-ffffffffffffffff"}))]}));
        assert_eq!(check(&wrong_label), Err(StagedRejection::WrongLabel));

        let no_label = staged(serde_json::json!({
            PROVIDER: [record(serde_json::json!({"label": serde_json::Value::Null}))]}));
        assert_eq!(check(&no_label), Err(StagedRejection::WrongLabel));

        let wrong_provider =
            staged(serde_json::json!({"anthropic": [record(serde_json::json!({}))]}));
        assert_eq!(check(&wrong_provider), Err(StagedRejection::WrongProvider));
    }

    #[test]
    fn a_record_obtained_another_way_is_refused() {
        let api_key = staged(serde_json::json!({PROVIDER: [
            record(serde_json::json!({"auth_type": "api_key", "source": "manual"}))]}));
        assert_eq!(check(&api_key), Err(StagedRejection::WrongAuthMethod));

        let wrong_source = staged(serde_json::json!({PROVIDER: [
            record(serde_json::json!({"source": "manual"}))]}));
        assert_eq!(check(&wrong_source), Err(StagedRejection::WrongAuthMethod));
    }

    /// Freshly written and already written off: nothing worth swapping in.
    #[test]
    fn a_staged_record_the_runtime_wrote_off_is_refused() {
        let dir = staged(serde_json::json!({PROVIDER: [record(serde_json::json!({
            "last_status": "dead", "last_error_code": 401,
            "last_error_reason": "token_revoked"}))]}));
        assert_eq!(check(&dir), Err(StagedRejection::NotUsable));
    }

    #[test]
    fn an_unreadable_staged_store_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("auth.json"), b"{nope").unwrap();
        assert_eq!(check(&dir), Err(StagedRejection::Unreadable));
        let absent = tempfile::tempdir().unwrap();
        assert_eq!(check(&absent), Err(StagedRejection::Unreadable));
    }
}
