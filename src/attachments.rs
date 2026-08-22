//! Image attachments on a chat turn.
//!
//! One attachment type, `image_url`, carrying an ordinary `http`/`https` link.
//!
//! **Asterism never downloads the image.** Proven against the pinned Hermes
//! 0.20.0: a structured `image_url` content part is forwarded unchanged, and the
//! *model provider* fetches the URL. Neither Node nor Hermes reads it. That is
//! why there is no bounded fetcher, no proxy, and no cache here — adding one
//! would build a remote-fetching service nothing asked for.
//!
//! It also means the URL leaves the VPS: whoever serves it sees a request from
//! the provider, and the provider sees the URL. That is a privacy property of
//! the feature, documented rather than hidden.

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Attachments accepted on one user turn.
///
/// Four is a product limit, not a technical one: it bounds the prompt, the
/// stored payload, and how much a single turn can ask the provider to fetch.
pub const MAX_ATTACHMENTS: usize = 4;

/// Long enough for a signed CDN link, short enough to bound the payload.
pub const MAX_URL_BYTES: usize = 2048;

/// A label, not a description.
pub const MAX_ALT_BYTES: usize = 200;

/// The one attachment type this version supports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentKind {
    ImageUrl,
}

impl AttachmentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ImageUrl => "image_url",
        }
    }
}

/// One attachment on a user turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attachment {
    #[serde(rename = "type")]
    pub kind: AttachmentKind,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
}

/// Parse and validate the attachments of one turn.
///
/// Every rejection is an error rather than a drop: silently sending a text-only
/// run for a message the operator attached an image to would answer a different
/// question than the one asked, and they would have no way to tell.
pub fn parse(value: Option<&Value>) -> Result<Vec<Attachment>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }
    let Some(items) = value.as_array() else {
        bail!("attachments must be an array");
    };
    if items.len() > MAX_ATTACHMENTS {
        bail!(
            "at most {MAX_ATTACHMENTS} attachments are allowed on one message, got {}",
            items.len()
        );
    }

    // Order is preserved as submitted: the operator's ordering is what the
    // model sees and what the transcript replays.
    items.iter().map(parse_one).collect()
}

fn parse_one(item: &Value) -> Result<Attachment> {
    let kind = item.get("type").and_then(Value::as_str).unwrap_or_default();
    if kind != AttachmentKind::ImageUrl.as_str() {
        bail!("unsupported attachment type {kind:?}; only \"image_url\" is supported");
    }

    let url = item
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .ok_or_else(|| anyhow::anyhow!("an image_url attachment requires a url"))?;
    validate_url(url)?;

    let alt = item
        .get("alt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|alt| !alt.is_empty())
        .map(ToOwned::to_owned);
    if let Some(alt) = &alt
        && alt.len() > MAX_ALT_BYTES
    {
        bail!("attachment label is longer than {MAX_ALT_BYTES} bytes");
    }

    Ok(Attachment {
        kind: AttachmentKind::ImageUrl,
        url: url.to_owned(),
        alt,
    })
}

fn validate_url(url: &str) -> Result<()> {
    if url.len() > MAX_URL_BYTES {
        bail!("attachment url is longer than {MAX_URL_BYTES} bytes");
    }

    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| anyhow::anyhow!("attachment url must be an absolute http or https url"))?;
    if !matches!(scheme, "http" | "https") {
        bail!("attachment url must use http or https, got {scheme:?}");
    }

    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() {
        bail!("attachment url has no host");
    }
    // `https://user:token@host/...` would put a credential in a value that is
    // stored, journalled, and handed to a third party that fetches it.
    if authority.contains('@') {
        bail!("attachment url must not embed credentials");
    }
    if url.contains(char::is_whitespace) {
        bail!("attachment url must not contain whitespace");
    }
    Ok(())
}

/// A form of the URL safe to put in a log or an error.
///
/// The query string is dropped wholesale: signed links carry their credential
/// there, and an error message is exactly where such a value escapes notice.
pub fn redact(url: &str) -> String {
    match url.split_once("://") {
        None => "<invalid-url>".to_owned(),
        Some((scheme, rest)) => {
            let path = rest.split(['?', '#']).next().unwrap_or_default();
            let truncated = if rest.len() > path.len() {
                format!("{path}?<redacted>")
            } else {
                path.to_owned()
            };
            format!("{scheme}://{truncated}")
        }
    }
}

/// Build the structured `input` Hermes forwards to the provider.
///
/// Proven shape: a one-element message list whose `content` is an array of
/// parts. A turn without attachments keeps sending a plain string, so an
/// ordinary message is byte-identical to what it was before this existed.
pub fn hermes_input(text: &str, attachments: &[Attachment]) -> Value {
    if attachments.is_empty() {
        return Value::String(text.to_owned());
    }
    let mut parts = vec![json!({"type": "text", "text": text})];
    for attachment in attachments {
        parts.push(json!({
            "type": "image_url",
            "image_url": {"url": attachment.url},
        }));
    }
    json!([{ "role": "user", "content": parts }])
}

/// How an attachment appears when a past turn is replayed as history.
///
/// Hermes coerces `conversation_history` content to a string, so an image part
/// cannot survive there. A stable textual reference is sent instead: it keeps
/// the model aware that the turn carried an image and what it was called,
/// without pretending the pixels are still available.
pub fn history_suffix(attachments: &[Attachment]) -> String {
    if attachments.is_empty() {
        return String::new();
    }
    let mut out = String::from("\n[attached images: ");
    for (index, attachment) in attachments.iter().enumerate() {
        if index > 0 {
            out.push_str(", ");
        }
        match &attachment.alt {
            Some(alt) => out.push_str(&format!("{alt} <{}>", attachment.url)),
            None => out.push_str(&format!("<{}>", attachment.url)),
        }
    }
    out.push(']');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(url: &str) -> Value {
        json!({"type": "image_url", "url": url})
    }

    #[test]
    fn a_message_without_attachments_parses_to_none() {
        assert!(parse(None).unwrap().is_empty());
        assert!(parse(Some(&Value::Null)).unwrap().is_empty());
        assert!(parse(Some(&json!([]))).unwrap().is_empty());
    }

    #[test]
    fn one_image_url_is_accepted_with_its_label() {
        let parsed = parse(Some(&json!([
            {"type": "image_url", "url": "https://example.com/a.png", "alt": "diagram"}
        ])))
        .unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].url, "https://example.com/a.png");
        assert_eq!(parsed[0].alt.as_deref(), Some("diagram"));
        assert_eq!(parsed[0].kind, AttachmentKind::ImageUrl);
    }

    #[test]
    fn four_images_are_accepted_in_the_order_given() {
        let items: Vec<Value> = (0..4)
            .map(|i| image(&format!("https://example.com/{i}.png")))
            .collect();
        let parsed = parse(Some(&json!(items))).unwrap();
        assert_eq!(parsed.len(), 4);
        let urls: Vec<&str> = parsed.iter().map(|a| a.url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "https://example.com/0.png",
                "https://example.com/1.png",
                "https://example.com/2.png",
                "https://example.com/3.png",
            ],
        );
    }

    #[test]
    fn a_fifth_image_is_refused() {
        let items: Vec<Value> = (0..5)
            .map(|i| image(&format!("https://example.com/{i}.png")))
            .collect();
        let error = parse(Some(&json!(items))).unwrap_err().to_string();
        assert!(error.contains("at most 4"), "got {error}");
    }

    #[test]
    fn a_malformed_url_is_refused() {
        for url in [
            "not-a-url",
            "example.com/a.png",
            "https://",
            "http:///a.png",
        ] {
            assert!(
                parse(Some(&json!([image(url)]))).is_err(),
                "{url} should be refused",
            );
        }
    }

    #[test]
    fn an_unsupported_scheme_is_refused() {
        for url in [
            "ftp://example.com/a.png",
            "file:///etc/passwd",
            "data:image/png;base64,AAAA",
            "javascript:alert(1)",
        ] {
            let error = parse(Some(&json!([image(url)]))).unwrap_err().to_string();
            assert!(
                error.contains("http") || error.contains("absolute"),
                "{url}: {error}",
            );
        }
    }

    #[test]
    fn a_url_carrying_credentials_is_refused() {
        // Storing this would put a secret in the run payload, the journal, and
        // a request to a third party that fetches it.
        let error = parse(Some(&json!([image(
            "https://user:token@example.com/a.png"
        )])))
        .unwrap_err()
        .to_string();
        assert!(error.contains("credentials"), "got {error}");
    }

    #[test]
    fn an_unsupported_attachment_type_is_refused_rather_than_ignored() {
        let error = parse(Some(
            &json!([{"type": "file_url", "url": "https://example.com/a.pdf"}]),
        ))
        .unwrap_err()
        .to_string();
        assert!(error.contains("unsupported attachment type"), "got {error}");
    }

    #[test]
    fn an_oversized_url_or_label_is_refused() {
        let long_url = format!("https://example.com/{}", "a".repeat(MAX_URL_BYTES));
        assert!(parse(Some(&json!([image(&long_url)]))).is_err());

        let long_alt = "x".repeat(MAX_ALT_BYTES + 1);
        assert!(
            parse(Some(&json!([
                {"type": "image_url", "url": "https://example.com/a.png", "alt": long_alt}
            ])))
            .is_err()
        );
    }

    #[test]
    fn attachments_must_be_an_array() {
        assert!(parse(Some(&json!({"url": "https://example.com/a.png"}))).is_err());
        assert!(parse(Some(&json!("https://example.com/a.png"))).is_err());
    }

    // --- redaction ----------------------------------------------------------

    #[test]
    fn redaction_keeps_the_location_and_drops_the_query() {
        // A signed link carries its credential in the query, and an error
        // message is exactly where such a value escapes notice.
        assert_eq!(
            redact("https://cdn.example.com/a.png?signature=abcd1234&expires=99"),
            "https://cdn.example.com/a.png?<redacted>",
        );
    }

    #[test]
    fn redaction_leaves_a_plain_url_readable() {
        assert_eq!(
            redact("https://example.com/a.png"),
            "https://example.com/a.png",
        );
    }

    #[test]
    fn redaction_drops_a_fragment_too() {
        assert_eq!(
            redact("https://example.com/a.png#tok"),
            "https://example.com/a.png?<redacted>"
        );
    }

    // --- the Hermes request -------------------------------------------------

    #[test]
    fn a_turn_without_attachments_sends_a_plain_string() {
        // Byte-identical to what every existing client sends.
        assert_eq!(hermes_input("hello", &[]), json!("hello"));
    }

    #[test]
    fn a_turn_with_images_sends_the_proven_structured_shape() {
        let attachments = parse(Some(&json!([
            image("https://example.com/a.png"),
            image("https://example.com/b.png"),
        ])))
        .unwrap();
        assert_eq!(
            hermes_input("what is this", &attachments),
            json!([{
                "role": "user",
                "content": [
                    {"type": "text", "text": "what is this"},
                    {"type": "image_url", "image_url": {"url": "https://example.com/a.png"}},
                    {"type": "image_url", "image_url": {"url": "https://example.com/b.png"}},
                ],
            }]),
        );
    }

    // --- history ------------------------------------------------------------

    #[test]
    fn history_records_the_images_a_turn_carried() {
        // Hermes stringifies conversation_history content, so the pixels cannot
        // survive there. Naming them keeps the model aware the turn had images.
        let attachments = parse(Some(&json!([
            {"type": "image_url", "url": "https://example.com/a.png", "alt": "diagram"},
            image("https://example.com/b.png"),
        ])))
        .unwrap();
        assert_eq!(
            history_suffix(&attachments),
            "\n[attached images: diagram <https://example.com/a.png>, <https://example.com/b.png>]",
        );
    }

    #[test]
    fn a_turn_without_attachments_adds_nothing_to_history() {
        assert_eq!(history_suffix(&[]), "");
    }

    #[test]
    fn a_parsed_attachment_round_trips_through_storage() {
        let attachments = parse(Some(&json!([
            {"type": "image_url", "url": "https://example.com/a.png", "alt": "diagram"}
        ])))
        .unwrap();
        let stored = serde_json::to_value(&attachments).unwrap();
        assert_eq!(parse(Some(&stored)).unwrap(), attachments);
    }
}
