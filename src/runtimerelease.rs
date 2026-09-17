//! Which release the installed runtime tree is.
//!
//! Until now nothing on disk said. The Node reported its own compiled version
//! as the runtime release, so a host with the alpha.30 binary on the alpha.29
//! runtime told the Control Plane both were alpha.30.
//!
//! The installer writes this marker into the new tree *before* the tree is
//! renamed into place, from the manifest whose archive digest it has just
//! verified. The marker therefore moves with the tree: a rollback that puts the
//! previous tree back puts that tree's own marker back with it, and a tree that
//! is live always carries the release it was unpacked from. The tree is root's
//! and read-only to the service account, which runs from it but cannot rewrite
//! what it says it is.

use std::path::Path;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

/// Inside the runtime root.
pub const MARKER: &str = "release.json";

/// What the Node reports when a tree carries no marker: an installation from
/// before markers existed, whose release cannot be known rather than guessed.
pub const UNKNOWN: &str = "unknown";

const SCHEMA: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeRelease {
    pub schema: u32,
    pub version: String,
    pub source_revision: String,
    pub platform: String,
    /// The digest of the archive the tree was unpacked from, as the release
    /// manifest published it and the installer verified it.
    pub archive_sha256: String,
}

impl RuntimeRelease {
    pub fn from_manifest(manifest: &crate::bundle::Manifest) -> Self {
        Self {
            schema: SCHEMA,
            version: manifest.version.clone(),
            source_revision: manifest.source_revision.clone(),
            platform: manifest.platform.clone(),
            archive_sha256: manifest.archive.sha256.clone(),
        }
    }

    fn validate(&self) -> Result<()> {
        if self.schema != SCHEMA {
            bail!(
                "runtime release marker schema {} is not supported",
                self.schema
            );
        }
        crate::updaterequest::validate_version(&self.version)?;
        let hex = |value: &str, lengths: std::ops::RangeInclusive<usize>| {
            lengths.contains(&value.len()) && value.bytes().all(|b| b.is_ascii_hexdigit())
        };
        // As loose as the manifest the marker is copied from, which accepts an
        // abbreviated revision, and no looser.
        if !hex(&self.source_revision, 3..=64) {
            bail!("runtime release marker names no source revision");
        }
        if !hex(&self.archive_sha256, 64..=64) {
            bail!("runtime release marker names no archive digest");
        }
        if self.platform.is_empty() || self.platform.len() > 32 {
            bail!("runtime release marker names no platform");
        }
        Ok(())
    }
}

/// Write the marker into a tree that is not yet live.
pub fn write_into(tree: &Path, release: &RuntimeRelease) -> Result<()> {
    release.validate()?;
    let path = tree.join(MARKER);
    std::fs::write(&path, serde_json::to_vec_pretty(release)?)
        .with_context(|| format!("cannot write {}", path.display()))?;
    std::fs::set_permissions(
        &path,
        <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o644),
    )?;
    Ok(())
}

/// The marker of the tree at `opt`. `Ok(None)` when the tree has none; an error
/// when it has one that cannot be believed.
pub fn read(opt: &Path) -> Result<Option<RuntimeRelease>> {
    let path = opt.join(MARKER);
    let raw = match std::fs::read(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("cannot read {}", path.display())),
    };
    if raw.len() > 4096 {
        bail!("{} is too large to be a release marker", path.display());
    }
    let release: RuntimeRelease = serde_json::from_slice(&raw)
        .with_context(|| format!("{} is not a release marker", path.display()))?;
    release.validate()?;
    Ok(Some(release))
}

/// The runtime release as the Node reports it upward.
pub fn reported(opt: &Path) -> String {
    match read(opt) {
        Ok(Some(release)) => release.version,
        _ => UNKNOWN.to_owned(),
    }
}

/// On this host.
pub fn reported_on_this_host() -> String {
    reported(&crate::hostsetup::HostPaths::default().opt_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn release(version: &str) -> RuntimeRelease {
        RuntimeRelease {
            schema: 1,
            version: version.to_owned(),
            source_revision: "938d3591bc554ba716144aee2cdd46b9787c708a".to_owned(),
            platform: "linux/amd64".to_owned(),
            archive_sha256: "a".repeat(64),
        }
    }

    #[test]
    fn a_written_marker_reads_back_and_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        write_into(dir.path(), &release("v0.1.0-alpha.31")).unwrap();
        assert_eq!(read(dir.path()).unwrap(), Some(release("v0.1.0-alpha.31")));
        assert_eq!(reported(dir.path()), "v0.1.0-alpha.31");
    }

    /// A tree from before markers says it does not know, rather than borrowing
    /// the Node binary's version and agreeing with it by construction.
    #[test]
    fn a_tree_without_a_marker_reports_unknown() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read(dir.path()).unwrap(), None);
        assert_eq!(reported(dir.path()), UNKNOWN);
    }

    #[test]
    fn a_marker_that_cannot_be_believed_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        for body in [
            r#"{"schema":1,"version":"../x","source_revision":"938d3591bc554ba716144aee2cdd46b9787c708a","platform":"linux/amd64","archive_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#,
            r#"{"schema":2,"version":"v1.0.0","source_revision":"938d3591bc554ba716144aee2cdd46b9787c708a","platform":"linux/amd64","archive_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#,
            r#"{"schema":1,"version":"v1.0.0","source_revision":"not-hex","platform":"linux/amd64","archive_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#,
            r#"{"schema":1,"version":"v1.0.0","source_revision":"938d3591bc554ba716144aee2cdd46b9787c708a","platform":"linux/amd64","archive_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","extra":1}"#,
            "not json",
        ] {
            std::fs::write(dir.path().join(MARKER), body).unwrap();
            assert!(read(dir.path()).is_err(), "{body} must be refused");
            assert_eq!(reported(dir.path()), UNKNOWN);
        }
    }
}
