//! The one thing an unprivileged daemon may ask a privileged updater to do.
//!
//! `node update` writes system files, so it runs as root. The Node daemon does
//! not: it runs as the service account, and the whole of its escalation is a
//! sudoers file naming four systemctl verbs against one unit template. Managing
//! updates from the Control Plane means adding one more verb — starting
//! `asterism-update.service` — and that unit runs as root.
//!
//! Which makes this file the boundary. A daemon that was compromised could
//! write whatever it liked here, and root would read it. So the rule is that
//! **nothing in the request decides where anything comes from**. The request
//! carries a version and nothing else. The release it is fetched from, the
//! checksums it is verified against and the work that is done are all fixed in
//! the updater, which a compromised daemon cannot reach.
//!
//! What is left to check is that the version names a release rather than
//! something else wearing a version's clothes — a path, an argument, a shell —
//! and that the request has not been sitting there since last week.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

/// Longest a release tag may be. Generous for a tag, far short of a path.
const MAX_VERSION: usize = 64;

/// How long a request stays actionable.
///
/// A request is consumed when it is read, so this only matters when the updater
/// never ran — the unit failed to start, the host was powered off mid-update.
/// A stale request must not turn into a surprise update days later, on a host
/// whose operator has long since moved on.
const MAX_AGE_SECONDS: u64 = 3600;

/// What the daemon asks for, and the whole of it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpdateRequest {
    /// The release to move to. Validated before it is ever written or read.
    pub version: String,
    /// When it was asked for, seconds since the epoch.
    pub requested_at: u64,
    /// Who asked, for the record. Never trusted for a decision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_by: Option<String>,
}

impl UpdateRequest {
    pub fn new(version: &str, requested_by: Option<&str>) -> Result<Self> {
        validate_version(version)?;
        Ok(Self {
            version: version.to_owned(),
            requested_at: now(),
            requested_by: requested_by.map(ToOwned::to_owned),
        })
    }
}

/// Whether a string names a release, and only a release.
///
/// Deliberately stricter than the tags in use. This value reaches a URL and a
/// filename, so the question is not "does this look plausible" but "is there
/// anything here that could mean something else somewhere else". Anything that
/// is not a version character is refused rather than escaped, because escaping
/// is a claim about every consumer and refusing is a claim about one string.
pub fn validate_version(version: &str) -> Result<()> {
    if version.is_empty() {
        bail!("an update request names no version");
    }
    if version.len() > MAX_VERSION {
        bail!("an update version may not exceed {MAX_VERSION} characters");
    }
    if !version.starts_with('v') {
        bail!("an update version must be a release tag beginning with 'v', got {version:?}");
    }
    // No separators, no traversal, no whitespace, no shell. A release tag is
    // made of these characters and nothing else.
    if !version
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+' | '_'))
    {
        bail!("an update version may only contain letters, digits, '.', '-', '+' and '_'");
    }
    if version.contains("..") {
        bail!("an update version may not contain '..'");
    }
    // `v` alone, or `v-`: a prefix is not a version.
    if version.len() < 2 || !version[1..].starts_with(|c: char| c.is_ascii_digit()) {
        bail!("an update version must begin with 'v' and a digit, got {version:?}");
    }
    Ok(())
}

/// Record a request where the privileged updater will find it.
///
/// Written with a temporary file and renamed, so the updater never observes a
/// half-written request — it runs as root against a file an unprivileged
/// account is writing, and a torn read is the one thing it cannot validate.
pub fn write(path: &Path, request: &UpdateRequest) -> Result<()> {
    validate_version(&request.version)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("cannot create {}", parent.display()))?;
    }
    let staging = path.with_extension("incoming");
    std::fs::write(&staging, serde_json::to_vec_pretty(request)?)
        .with_context(|| format!("cannot write {}", staging.display()))?;
    std::fs::rename(&staging, path)
        .with_context(|| format!("cannot put {} in place", path.display()))?;
    Ok(())
}

/// Read a request and take it away in the same breath.
///
/// Consumed before it is acted on, never after. An update restarts the Node and
/// can fail in the middle; a request that survived that would be executed again
/// on the next start, and an update loop is a worse failure than the one that
/// caused it.
pub fn consume(path: &Path) -> Result<Option<UpdateRequest>> {
    let raw = match std::fs::read(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("cannot read {}", path.display()));
        }
    };
    let _ = std::fs::remove_file(path);

    let request: UpdateRequest = serde_json::from_slice(&raw)
        .with_context(|| format!("{} is not a readable update request", path.display()))?;
    validate_version(&request.version)?;

    let age = now().saturating_sub(request.requested_at);
    if age > MAX_AGE_SECONDS {
        bail!(
            "the update request is {age} seconds old, past the {MAX_AGE_SECONDS} second limit; \
             ask again if it is still wanted"
        );
    }
    Ok(Some(request))
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request_at(version: &str, requested_at: u64) -> UpdateRequest {
        UpdateRequest {
            version: version.to_owned(),
            requested_at,
            requested_by: None,
        }
    }

    /// The request is the boundary between an unprivileged daemon and root, so
    /// the version is checked for what it could mean elsewhere, not for whether
    /// it looks plausible. Everything here reaches a URL and a filename.
    #[test]
    fn nothing_but_a_release_tag_is_accepted() {
        for good in [
            "v0.1.0",
            "v0.1.0-alpha.19",
            "v0.1.0-alpha.19-rc.7",
            "v1.2.3+build.4",
            "v10.20.30",
        ] {
            assert!(validate_version(good).is_ok(), "{good:?} must be accepted");
        }

        for hostile in [
            "",
            "0.1.0", // no leading v
            "v",     // a prefix is not a version
            "v-1",   // no digit after v
            "../../etc/passwd",
            "v1/../../etc", // a separator
            "v1.0.0/extra",
            "v1.0.0 --release-base=http://evil", // a second argument
            "v1.0.0\nv2.0.0",                    // a second line
            "v1.0.0;rm -rf /",                   // a shell
            "v1.0.0$(id)",
            "v1.0.0`id`",
            "v..1.0.0", // traversal spelled inside a version
            "v1.0.0\t",
        ] {
            assert!(
                validate_version(hostile).is_err(),
                "{hostile:?} must be refused"
            );
        }

        assert!(validate_version(&format!("v1.0.0-{}", "a".repeat(80))).is_err());
    }

    /// Read once. An update restarts the Node and can fail in the middle; a
    /// request that survived that would run again on the next start, and an
    /// update loop is worse than the failure that began it.
    #[test]
    fn a_request_is_consumed_by_reading_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("update-request.json");
        write(
            &path,
            &UpdateRequest::new("v1.2.3", Some("operator")).unwrap(),
        )
        .unwrap();

        let first = consume(&path).unwrap().expect("a request was written");
        assert_eq!(first.version, "v1.2.3");
        assert_eq!(first.requested_by.as_deref(), Some("operator"));
        assert!(!path.exists(), "the request must not survive being read");
        assert!(consume(&path).unwrap().is_none(), "and never runs twice");
    }

    #[test]
    fn no_request_is_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(consume(&dir.path().join("absent.json")).unwrap().is_none());
    }

    /// A request left behind by an update that never ran must not become a
    /// surprise days later.
    #[test]
    fn a_stale_request_is_refused_and_still_consumed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("update-request.json");
        let old = request_at("v1.2.3", now().saturating_sub(MAX_AGE_SECONDS + 60));
        std::fs::write(&path, serde_json::to_vec(&old).unwrap()).unwrap();

        assert!(consume(&path).is_err(), "an old request must be refused");
        assert!(!path.exists(), "and must not be left to be tried again");
    }

    /// A version that was never valid cannot be smuggled in by writing the file
    /// directly rather than through `write`.
    #[test]
    fn a_hand_written_request_is_validated_on_the_way_out() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("update-request.json");
        let forged = request_at("v1.0.0 --release-base=http://elsewhere", now());
        std::fs::write(&path, serde_json::to_vec(&forged).unwrap()).unwrap();

        assert!(consume(&path).is_err());
    }

    #[test]
    fn a_request_that_is_not_a_request_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("update-request.json");
        std::fs::write(&path, b"not json at all").unwrap();
        assert!(consume(&path).is_err());
    }

    #[test]
    fn writing_refuses_a_version_it_would_not_read_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("update-request.json");
        let bad = request_at("../escape", now());
        assert!(write(&path, &bad).is_err());
        assert!(
            !path.exists(),
            "nothing is written when the version is refused"
        );
    }
}
