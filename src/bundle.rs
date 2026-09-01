//! The runtime bundle: what it claims, and whether the bytes agree.
//!
//! A host installs the runtime by downloading one archive built in CI from a
//! named revision. Everything here exists to decide whether that archive may be
//! trusted, and the answer is reached before a single byte is extracted.
//!
//! This is the Rust counterpart of `scripts/verify-runtime-bundle.sh` and asks
//! the same questions in the same order, because the installer and the release
//! pipeline must not disagree about what a valid bundle is.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// The bundle's checksum file.
///
/// Not `SHA256SUMS`. A GitHub release holds every artifact of a version in one
/// flat namespace, and the Node binary release publishes a `SHA256SUMS` there
/// already; two files of that name do not merge, the second upload replaces the
/// first, and one of the two verifications then reads checksums for an artifact
/// it is not verifying.
pub const CHECKSUM_FILE: &str = "SHA256SUMS.runtime";

/// The manifest schema this build understands.
///
/// A newer bundle is refused rather than interpreted optimistically: the field
/// exists so that a future change of meaning is a refusal here instead of a
/// misreading.
pub const SUPPORTED_SCHEMA: u32 = 1;

/// The platform this binary can install.
pub const fn host_platform() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        "linux/amd64"
    } else if cfg!(target_arch = "aarch64") {
        "linux/arm64"
    } else {
        "unsupported"
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ArchiveRef {
    pub name: String,
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub schema: u32,
    pub product: String,
    pub version: String,
    pub source_revision: String,
    pub platform: String,
    #[serde(default)]
    pub components: BTreeMap<String, String>,
    #[serde(default)]
    pub runtime_image: String,
    /// What the SQLite in this bundle can safely be configured with.
    ///
    /// Decided by the build, against the driver it actually compiled, rather
    /// than assumed by whatever installs it. `unknown` means the build could not
    /// tell, and a host must then choose the mode that is safe either way.
    #[serde(default = "unknown_journal_mode")]
    pub sqlite_journal_mode: String,
    pub archive: ArchiveRef,
    pub installed_size_bytes: u64,
    #[serde(default = "default_install_root")]
    pub install_root: String,
}

fn default_install_root() -> String {
    "/opt/asterism".to_string()
}

fn unknown_journal_mode() -> String {
    "unknown".to_string()
}

impl Manifest {
    pub fn parse(text: &str) -> Result<Self> {
        serde_json::from_str(text).context("the bundle manifest is not readable JSON")
    }

    /// Every question that can be answered without the archive bytes.
    ///
    /// Separate from the digest check because these are the cheap refusals: a
    /// bundle for another platform should not cost a 0.55 GB download first.
    pub fn accept(&self, platform: &str) -> Result<()> {
        if self.schema != SUPPORTED_SCHEMA {
            bail!(
                "bundle schema {} is not supported by this build (expected {SUPPORTED_SCHEMA})",
                self.schema
            );
        }
        if self.product != "asterism-runtime" {
            bail!("the manifest describes {}, not the runtime", self.product);
        }
        if self.platform != platform {
            bail!("the bundle is for {}, not {platform}", self.platform);
        }
        // An archive that cannot name where it came from is not distinguishable
        // from one built by hand, which is the whole reason the field exists.
        if self.source_revision.is_empty()
            || self.source_revision == "unknown"
            || self.source_revision == "?"
        {
            bail!("the manifest does not name the revision it was built from");
        }
        if self.archive.sha256.len() != 64
            || !self.archive.sha256.chars().all(|c| c.is_ascii_hexdigit())
        {
            bail!("the manifest does not carry a SHA-256 digest for its archive");
        }
        Ok(())
    }

    /// Whether the bytes on disk are the ones the manifest describes.
    pub fn matches_archive(&self, archive: &Path) -> Result<()> {
        let size = std::fs::metadata(archive)
            .with_context(|| format!("cannot read {}", archive.display()))?
            .len();
        if size != self.archive.size_bytes {
            bail!(
                "the archive is {size} bytes, the manifest says {}",
                self.archive.size_bytes
            );
        }
        let actual = sha256_file(archive)?;
        if !actual.eq_ignore_ascii_case(&self.archive.sha256) {
            bail!("the archive does not match the digest its manifest declares");
        }
        Ok(())
    }
}

pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file =
        std::fs::File::open(path).with_context(|| format!("cannot open {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 16];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A downloaded bundle that has been checked and may be extracted.
#[derive(Debug, Clone)]
pub struct VerifiedBundle {
    pub manifest: Manifest,
    pub archive: PathBuf,
}

/// Check a downloaded bundle directory the way the release pipeline does.
///
/// Fails closed on every question: an unreadable manifest, an unsupported
/// schema, another platform, an unnamed revision, a size or digest that
/// disagrees with the bytes, or a checksum file that disagrees with the
/// manifest.
pub fn verify(directory: &Path, platform: &str) -> Result<VerifiedBundle> {
    let manifest_path = directory.join("manifest.json");
    let text = std::fs::read_to_string(&manifest_path).context("the bundle has no manifest")?;
    let manifest = Manifest::parse(&text)?;
    manifest.accept(platform)?;

    let archive = directory.join(&manifest.archive.name);
    if !archive.is_file() {
        bail!(
            "the manifest names {}, which is not here",
            manifest.archive.name
        );
    }
    manifest.matches_archive(&archive)?;

    // The checksum file is written separately from the manifest, so it is
    // checked against the manifest rather than only against the bytes.
    let sums_path = directory.join(CHECKSUM_FILE);
    let sums = std::fs::read_to_string(&sums_path).context("the bundle has no checksum file")?;
    let listed = sums.lines().find_map(|line| {
        let (digest, name) = line.split_once("  ")?;
        (name.trim() == manifest.archive.name).then(|| digest.trim().to_string())
    });
    match listed {
        Some(digest) if digest.eq_ignore_ascii_case(&manifest.archive.sha256) => {}
        Some(_) => bail!("the checksum file and the manifest disagree about the archive"),
        None => bail!("the checksum file does not list the archive the manifest names"),
    }

    Ok(VerifiedBundle { manifest, archive })
}

/// Extract a verified bundle into the directory that holds `/opt/asterism`.
///
/// Every member must live under `asterism/`. The digest has already gated the
/// bytes, so this is not the security boundary; it is the assertion that the
/// archive is the shape this installer expects, which a truncated or swapped
/// artifact would fail.
pub fn unpack(bundle: &VerifiedBundle, into: &Path) -> Result<PathBuf> {
    let file = std::fs::File::open(&bundle.archive)
        .with_context(|| format!("cannot open {}", bundle.archive.display()))?;
    let decoder = flate2::read::GzDecoder::new(std::io::BufReader::new(file));
    let mut archive = tar::Archive::new(decoder);
    archive.set_preserve_permissions(true);
    archive.set_overwrite(true);
    // The runtime contains hard links — one interpreter under several names —
    // and refusing them would leave the tree incomplete rather than fail.
    archive.set_unpack_xattrs(false);

    std::fs::create_dir_all(into).with_context(|| format!("cannot create {}", into.display()))?;
    for entry in archive
        .entries()
        .with_context(|| format!("cannot read {}", bundle.archive.display()))?
    {
        let mut entry = entry.context("the archive ended in the middle of an entry")?;
        let path = entry
            .path()
            .context("an archive member has no readable path")?
            .into_owned();
        member_is_inside_the_tree(&path)?;
        // Every failure names the member. An installer that reports only
        // "No such file or directory" leaves the person reading it with a 1.9 GB
        // tree and no idea which of its files it meant.
        entry.unpack_in(into).with_context(|| {
            format!(
                "cannot unpack {} ({:?}) into {}",
                path.display(),
                entry.header().entry_type(),
                into.display()
            )
        })?;
    }
    Ok(into.join("asterism"))
}

/// Whether one archive member belongs to the runtime tree.
///
/// Split out because a `..` member cannot be produced by the tar writer, which
/// refuses to create one — so the only honest way to test this rule is to call
/// it with the path an attacker would need to smuggle in some other way.
fn member_is_inside_the_tree(path: &Path) -> Result<()> {
    let mut components = path.components();
    match components.next() {
        Some(std::path::Component::Normal(first)) if first == "asterism" => {}
        _ => bail!(
            "the archive contains {}, which is outside the runtime tree",
            path.display()
        ),
    }
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        bail!("the archive contains a path that climbs out of the runtime tree");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest_json(overrides: &[(&str, &str)]) -> String {
        let mut fields: BTreeMap<&str, String> = BTreeMap::new();
        fields.insert("schema", "1".into());
        fields.insert("product", "\"asterism-runtime\"".into());
        fields.insert("version", "\"1.2.3\"".into());
        fields.insert("source_revision", "\"abc123\"".into());
        fields.insert("platform", "\"linux/amd64\"".into());
        fields.insert("installed_size_bytes", "10".into());
        fields.insert(
            "archive",
            format!(
                "{{\"name\":\"a.tar.gz\",\"sha256\":\"{}\",\"size_bytes\":1}}",
                "0".repeat(64)
            ),
        );
        for (key, value) in overrides {
            fields.insert(key, (*value).to_string());
        }
        let body: Vec<String> = fields
            .iter()
            .map(|(key, value)| format!("\"{key}\": {value}"))
            .collect();
        format!("{{{}}}", body.join(","))
    }

    #[test]
    fn a_future_schema_is_refused_rather_than_interpreted() {
        let manifest = Manifest::parse(&manifest_json(&[("schema", "2")])).unwrap();
        let error = manifest.accept("linux/amd64").unwrap_err().to_string();
        assert!(error.contains("schema 2 is not supported"), "{error}");
    }

    #[test]
    fn another_platform_is_refused_before_anything_is_downloaded() {
        let manifest = Manifest::parse(&manifest_json(&[("platform", "\"linux/arm64\"")])).unwrap();
        let error = manifest.accept("linux/amd64").unwrap_err().to_string();
        assert!(error.contains("linux/arm64"), "{error}");
    }

    #[test]
    fn a_manifest_that_cannot_name_its_revision_is_refused() {
        for revision in ["\"\"", "\"unknown\"", "\"?\""] {
            let manifest =
                Manifest::parse(&manifest_json(&[("source_revision", revision)])).unwrap();
            let error = manifest.accept("linux/amd64").unwrap_err().to_string();
            assert!(error.contains("does not name the revision"), "{revision}");
        }
    }

    #[test]
    fn a_manifest_that_does_not_say_carries_the_unknown_journal_mode() {
        // Read from the top level, where the build writes it. Reading it from
        // the wrong place would silently produce the default on every bundle.
        let manifest = Manifest::parse(&manifest_json(&[])).unwrap();
        assert_eq!(manifest.sqlite_journal_mode, "unknown");
        let stated =
            Manifest::parse(&manifest_json(&[("sqlite_journal_mode", "\"wal\"")])).unwrap();
        assert_eq!(stated.sqlite_journal_mode, "wal");
    }

    #[test]
    fn a_digest_that_is_not_a_digest_is_refused() {
        let manifest = Manifest::parse(&manifest_json(&[(
            "archive",
            "{\"name\":\"a.tar.gz\",\"sha256\":\"not-a-digest\",\"size_bytes\":1}",
        )]))
        .unwrap();
        let error = manifest.accept("linux/amd64").unwrap_err().to_string();
        assert!(error.contains("SHA-256"), "{error}");
    }

    /// Builds a real archive so the verifier is exercised against bytes rather
    /// than against a description of bytes.
    fn write_bundle(dir: &Path, members: &[(&str, &[u8])]) -> Manifest {
        let archive_path = dir.join("asterism-runtime-test-linux-amd64.tar.gz");
        {
            let file = std::fs::File::create(&archive_path).unwrap();
            let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::fast());
            let mut builder = tar::Builder::new(encoder);
            for (name, body) in members {
                let mut header = tar::Header::new_gnu();
                header.set_size(body.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder.append_data(&mut header, name, *body).unwrap();
            }
            builder.into_inner().unwrap().finish().unwrap();
        }
        let digest = sha256_file(&archive_path).unwrap();
        let size = std::fs::metadata(&archive_path).unwrap().len();
        let text = format!(
            r#"{{"schema":1,"product":"asterism-runtime","version":"test",
                 "source_revision":"deadbeef","platform":"linux/amd64",
                 "components":{{"hermes":"0.20.0"}},"runtime_image":"ghcr.io/x@sha256:y",
                 "archive":{{"name":"{}","sha256":"{digest}","size_bytes":{size}}},
                 "installed_size_bytes":{size},"install_root":"/opt/asterism"}}"#,
            archive_path.file_name().unwrap().to_string_lossy()
        );
        std::fs::write(dir.join("manifest.json"), &text).unwrap();
        std::fs::write(
            dir.join(CHECKSUM_FILE),
            format!(
                "{digest}  {}\n",
                archive_path.file_name().unwrap().to_string_lossy()
            ),
        )
        .unwrap();
        Manifest::parse(&text).unwrap()
    }

    #[test]
    fn a_bundle_that_describes_itself_correctly_is_accepted_and_unpacks() {
        let dir = tempfile::tempdir().unwrap();
        write_bundle(dir.path(), &[("asterism/hermes/marker", b"hermes")]);

        let verified = verify(dir.path(), "linux/amd64").unwrap();
        assert_eq!(verified.manifest.source_revision, "deadbeef");

        let into = tempfile::tempdir().unwrap();
        let tree = unpack(&verified, into.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(tree.join("hermes/marker")).unwrap(),
            "hermes"
        );
    }

    #[test]
    fn an_archive_that_does_not_match_its_digest_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = write_bundle(dir.path(), &[("asterism/marker", b"one")]);
        // The same length, so only the digest can tell them apart.
        let archive = dir.path().join(&manifest.archive.name);
        let mut bytes = std::fs::read(&archive).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        std::fs::write(&archive, bytes).unwrap();

        let error = verify(dir.path(), "linux/amd64").unwrap_err().to_string();
        assert!(error.contains("does not match the digest"), "{error}");
    }

    #[test]
    fn a_checksum_file_that_disagrees_with_the_manifest_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = write_bundle(dir.path(), &[("asterism/marker", b"one")]);
        std::fs::write(
            dir.path().join(CHECKSUM_FILE),
            format!("{}  {}\n", "1".repeat(64), manifest.archive.name),
        )
        .unwrap();

        let error = verify(dir.path(), "linux/amd64").unwrap_err().to_string();
        assert!(error.contains("disagree"), "{error}");
    }

    #[test]
    fn a_missing_checksum_file_is_refused_rather_than_skipped() {
        let dir = tempfile::tempdir().unwrap();
        write_bundle(dir.path(), &[("asterism/marker", b"one")]);
        std::fs::remove_file(dir.path().join(CHECKSUM_FILE)).unwrap();

        let error = verify(dir.path(), "linux/amd64").unwrap_err().to_string();
        assert!(error.contains("checksum file"), "{error}");
    }

    #[test]
    fn an_archive_reaching_outside_the_runtime_tree_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        write_bundle(dir.path(), &[("etc/shadow", b"root")]);
        let verified = verify(dir.path(), "linux/amd64").unwrap();

        let into = tempfile::tempdir().unwrap();
        let error = unpack(&verified, into.path()).unwrap_err().to_string();
        assert!(error.contains("outside the runtime tree"), "{error}");
        assert!(!into.path().join("etc/shadow").exists());
    }

    #[test]
    fn a_member_climbing_out_with_dot_dot_is_refused() {
        let error = member_is_inside_the_tree(Path::new("asterism/../../escape"))
            .unwrap_err()
            .to_string();
        assert!(error.contains("climbs out"), "{error}");
        member_is_inside_the_tree(Path::new("asterism/hermes/.venv/bin/python")).unwrap();
    }
}
