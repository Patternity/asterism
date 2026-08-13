//! Recursive redaction applied before anything reaches the durable journal.
//!
//! Phase C established that the project container is one trust domain and that
//! credentials are readable inside it. The Node registry lives **outside** that
//! domain, so it must never become a second copy of any secret: an operator
//! reading the journal, or a future Control Plane replicating it, must not be
//! able to recover a token from it.
//!
//! Redaction is deliberately conservative — it prefers destroying a harmless
//! value to preserving a secret one.

use serde_json::{Map, Value};

/// Replacement written in place of a redacted value.
pub const REDACTED: &str = "[redacted]";

/// Replacement for a whole captured process environment.
pub const REDACTED_ENVIRONMENT: &str = "[redacted-environment]";

/// Longest string kept verbatim inside a journalled payload. Longer strings are
/// truncated with an explicit marker so an oversized tool output cannot bloat
/// the database.
pub const MAX_STRING_BYTES: usize = 8 * 1024;

/// Longest serialized raw payload retained. Beyond this the raw copy is dropped
/// and only the normalized form is kept.
pub const MAX_RAW_PAYLOAD_BYTES: usize = 64 * 1024;

/// Deepest structure walked. Anything deeper is replaced wholesale, which also
/// bounds work on hostile input.
const MAX_DEPTH: usize = 32;

/// Field names whose value is always destroyed, matched case-insensitively
/// against the key with separators normalized away.
const SECRET_KEY_FRAGMENTS: &[&str] = &[
    "accesstoken",
    "refreshtoken",
    "idtoken",
    "apikey",
    "apisecret",
    "authorization",
    "clientsecret",
    "cookie",
    "credential",
    "password",
    "passwd",
    "privatekey",
    "secret",
    "sessionkey",
    "setcookie",
    "token",
];

/// Field names holding a whole process environment.
const ENVIRONMENT_KEY_FRAGMENTS: &[&str] = &["environ", "environment", "envvars"];

/// Outcome of redacting a payload.
#[derive(Debug, Clone, PartialEq)]
pub struct Redacted {
    pub value: Value,
    /// True when at least one value was destroyed or truncated.
    pub modified: bool,
}

/// Redact a JSON payload in place, recursively.
pub fn redact(value: &Value) -> Redacted {
    let mut modified = false;
    let redacted = walk(value, 0, &mut modified);
    Redacted {
        value: redacted,
        modified,
    }
}

/// Serialize a raw payload for storage, or drop it when it exceeds the bound.
///
/// Returns `None` when the payload is too large to retain, in which case the
/// caller keeps only the normalized form.
pub fn bounded_raw(value: &Value) -> Option<String> {
    let redacted = redact(value);
    let encoded = serde_json::to_string(&redacted.value).ok()?;
    if encoded.len() > MAX_RAW_PAYLOAD_BYTES {
        return None;
    }
    Some(encoded)
}

/// Wrap text that is not valid JSON so it can still be journalled safely.
///
/// SSE data is decoded lossily upstream, so invalid UTF-8 has already been
/// replaced; this bounds the length and keeps the value redacted.
pub fn text_payload(text: &str) -> Value {
    let mut modified = false;
    Value::String(bound_string(text, &mut modified))
}

fn walk(value: &Value, depth: usize, modified: &mut bool) -> Value {
    if depth >= MAX_DEPTH {
        *modified = true;
        return Value::String(REDACTED.to_owned());
    }

    match value {
        Value::Object(map) => {
            let mut out = Map::with_capacity(map.len());
            for (key, child) in map {
                if is_environment_key(key) {
                    *modified = true;
                    out.insert(key.clone(), Value::String(REDACTED_ENVIRONMENT.to_owned()));
                } else if is_secret_key(key) && can_carry_secret(child) {
                    *modified = true;
                    out.insert(key.clone(), Value::String(REDACTED.to_owned()));
                } else {
                    out.insert(key.clone(), walk(child, depth + 1, modified));
                }
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| walk(item, depth + 1, modified))
                .collect(),
        ),
        Value::String(text) => {
            if looks_like_secret(text) {
                *modified = true;
                Value::String(REDACTED.to_owned())
            } else {
                Value::String(bound_string(text, modified))
            }
        }
        other => other.clone(),
    }
}

fn bound_string(text: &str, modified: &mut bool) -> String {
    if text.len() <= MAX_STRING_BYTES {
        return text.to_owned();
    }
    *modified = true;
    // Cut on a character boundary so the result stays valid UTF-8.
    let mut end = MAX_STRING_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…[truncated]", &text[..end])
}

fn normalize_key(key: &str) -> String {
    key.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

fn is_secret_key(key: &str) -> bool {
    let normalized = normalize_key(key);
    SECRET_KEY_FRAGMENTS
        .iter()
        .any(|fragment| normalized.contains(fragment))
}

/// A number or boolean cannot carry credential content, so redacting one
/// destroys telemetry and buys no protection. Token *counts* (`input_tokens`,
/// `total_tokens`) are the case that matters: they match the `token` fragment
/// but are usage metrics an operator needs.
fn can_carry_secret(value: &Value) -> bool {
    !matches!(value, Value::Number(_) | Value::Bool(_))
}

fn is_environment_key(key: &str) -> bool {
    let normalized = normalize_key(key);
    ENVIRONMENT_KEY_FRAGMENTS
        .iter()
        .any(|fragment| normalized == *fragment)
}

/// Value-shaped detection for secrets that arrive without a telling key name.
fn looks_like_secret(text: &str) -> bool {
    let trimmed = text.trim();

    // JWT / OAuth tokens as emitted by the providers used here.
    if trimmed.starts_with("eyJ") && trimmed.len() >= 32 {
        return true;
    }
    // OpenAI-style keys.
    if trimmed.starts_with("sk-") && trimmed.len() >= 24 {
        return true;
    }
    // An Authorization header carried as a bare value.
    let lowered = trimmed.to_ascii_lowercase();
    if lowered.starts_with("bearer ") && trimmed.len() > 16 {
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn destroys_values_behind_secret_key_names() {
        let input = json!({
            "access_token": "abc",
            "refresh_token": "def",
            "api_key": "ghi",
            "Authorization": "Bearer xyz",
            "Set-Cookie": "a=b",
            "client_secret": "s",
            "password": "p",
            "keep": "visible"
        });
        let out = redact(&input);

        assert!(out.modified);
        for key in [
            "access_token",
            "refresh_token",
            "api_key",
            "Authorization",
            "Set-Cookie",
            "client_secret",
            "password",
        ] {
            assert_eq!(out.value[key], json!(REDACTED), "{key} must be redacted");
        }
        assert_eq!(out.value["keep"], json!("visible"));
    }

    #[test]
    fn matches_key_names_regardless_of_case_and_separators() {
        let input = json!({
            "ACCESS-TOKEN": "a",
            "Api_Key": "b",
            "sessionKey": "c"
        });
        let out = redact(&input);

        for key in ["ACCESS-TOKEN", "Api_Key", "sessionKey"] {
            assert_eq!(out.value[key], json!(REDACTED));
        }
    }

    #[test]
    fn redacts_nested_structures_recursively() {
        let input = json!({
            "outer": {"list": [{"token": "secret"}, {"safe": 1}]}
        });
        let out = redact(&input);

        assert_eq!(out.value["outer"]["list"][0]["token"], json!(REDACTED));
        assert_eq!(out.value["outer"]["list"][1]["safe"], json!(1));
    }

    #[test]
    fn destroys_whole_captured_environments() {
        let input = json!({"environ": {"PATH": "/usr/bin", "API_SERVER_KEY": "k"}});
        let out = redact(&input);

        assert_eq!(out.value["environ"], json!(REDACTED_ENVIRONMENT));
    }

    #[test]
    fn numeric_token_counts_survive_redaction() {
        // Regression: `usage.input_tokens` matched the `token` fragment and was
        // redacted, which destroyed usage telemetry without protecting anything.
        let out = redact(&json!({
            "usage": {"input_tokens": 91, "output_tokens": 12, "total_tokens": 103},
            "streaming": {"token_budget_exhausted": false}
        }));
        assert_eq!(out.value["usage"]["input_tokens"], json!(91));
        assert_eq!(out.value["usage"]["total_tokens"], json!(103));
        assert_eq!(
            out.value["streaming"]["token_budget_exhausted"],
            json!(false)
        );
        assert!(!out.modified);
    }

    #[test]
    fn string_secrets_are_still_redacted_under_the_same_keys() {
        // The numeric exemption must not weaken the string case.
        let out = redact(&json!({"access_token": "abc", "api_token": "def"}));
        assert_eq!(out.value["access_token"], json!(REDACTED));
        assert_eq!(out.value["api_token"], json!(REDACTED));
        assert!(out.modified);
    }

    #[test]
    fn detects_secret_shaped_values_without_a_telling_key() {
        let jwt = format!("eyJ{}", "a".repeat(40));
        let input = json!({
            "note": jwt,
            "other": "sk-0123456789abcdef01234567",
            "header": "Bearer 0123456789abcdef",
            "plain": "eyJ"
        });
        let out = redact(&input);

        assert_eq!(out.value["note"], json!(REDACTED));
        assert_eq!(out.value["other"], json!(REDACTED));
        assert_eq!(out.value["header"], json!(REDACTED));
        // Too short to be a token; must not be destroyed needlessly.
        assert_eq!(out.value["plain"], json!("eyJ"));
    }

    #[test]
    fn truncates_oversized_strings_on_a_character_boundary() {
        let input = json!({ "output": "é".repeat(MAX_STRING_BYTES) });
        let out = redact(&input);

        assert!(out.modified);
        let text = out.value["output"].as_str().unwrap();
        assert!(text.ends_with("…[truncated]"));
        assert!(text.len() < MAX_STRING_BYTES + 64);
    }

    #[test]
    fn leaves_clean_payloads_untouched() {
        let input = json!({"event": "tool.started", "tool": "terminal", "seq": 3});
        let out = redact(&input);

        assert!(!out.modified);
        assert_eq!(out.value, input);
    }

    #[test]
    fn bounds_recursion_depth_on_hostile_input() {
        let mut value = json!("leaf");
        for _ in 0..(MAX_DEPTH + 10) {
            value = json!({ "nested": value });
        }
        let out = redact(&value);

        assert!(out.modified);
        assert!(serde_json::to_string(&out.value).is_ok());
    }

    #[test]
    fn drops_raw_payloads_that_exceed_the_storage_bound() {
        let small = json!({"a": 1});
        assert!(bounded_raw(&small).is_some());

        let huge = json!({ "a": vec!["x".repeat(1024); 128] });
        assert!(bounded_raw(&huge).is_none());
    }

    #[test]
    fn raw_payloads_are_redacted_before_being_bounded() {
        let encoded = bounded_raw(&json!({"access_token": "abc"})).unwrap();
        assert!(encoded.contains(REDACTED));
        assert!(!encoded.contains("abc"));
    }

    #[test]
    fn non_json_text_is_stored_bounded() {
        let value = text_payload("not json at all");
        assert_eq!(value, json!("not json at all"));

        let long = text_payload(&"x".repeat(MAX_STRING_BYTES * 2));
        assert!(long.as_str().unwrap().ends_with("…[truncated]"));
    }
}
