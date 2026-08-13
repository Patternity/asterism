//! Persistent Ed25519 identity for one Asterism Node.
//!
//! The private key authenticates this Node to the Control Plane and nothing
//! else. It never appears in a command-line argument, an environment variable,
//! a log line, the local API, or a project container mount — the only thing
//! that leaves this module is the public key and its fingerprint.
//!
//! Identity is deliberately fragile in one direction: an unreadable or
//! malformed key file is a hard failure, never a reason to quietly mint a new
//! identity. Silently regenerating would present the Node to the Control Plane
//! as a stranger and mask a tampered or truncated key file.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use ed25519_dalek::{SECRET_KEY_LENGTH, Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Private key location relative to Node home.
pub const IDENTITY_KEY_FILE: &str = "node/identity.key";
/// Public metadata location relative to Node home.
pub const IDENTITY_META_FILE: &str = "node/identity.json";

pub fn key_path(node_home: &Path) -> PathBuf {
    node_home.join(IDENTITY_KEY_FILE)
}

pub fn meta_path(node_home: &Path) -> PathBuf {
    node_home.join(IDENTITY_META_FILE)
}

/// Public, safe-to-share identity metadata.
///
/// Persisted next to the key. Contains no reusable enrollment secret: the
/// enrollment token is discarded the moment it has been used.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct IdentityMetadata {
    /// Base64 of the 32-byte Ed25519 public key.
    pub public_key: String,
    /// SHA-256 fingerprint of the public key, lowercase hex.
    pub fingerprint: String,
    /// Assigned by the Control Plane during enrollment.
    pub node_id: Option<String>,
    /// Control Plane this Node enrolled with.
    pub control_plane_url: Option<String>,
    pub enrolled_at: Option<i64>,
    pub created_at: i64,
}

impl IdentityMetadata {
    pub fn is_enrolled(&self) -> bool {
        self.node_id.is_some()
    }

    pub fn enrollment_state(&self) -> &'static str {
        if self.is_enrolled() {
            "enrolled"
        } else {
            "unenrolled"
        }
    }
}

/// A loaded Node identity.
pub struct NodeIdentity {
    signing_key: SigningKey,
    metadata: IdentityMetadata,
    node_home: PathBuf,
}

impl std::fmt::Debug for NodeIdentity {
    /// Never renders private material, so an accidental `{:?}` cannot leak it.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NodeIdentity")
            .field("fingerprint", &self.metadata.fingerprint)
            .field("node_id", &self.metadata.node_id)
            .finish_non_exhaustive()
    }
}

impl NodeIdentity {
    /// Load the identity, creating one on first use.
    pub fn load_or_create(node_home: &Path) -> Result<Self> {
        match Self::load(node_home) {
            Ok(identity) => Ok(identity),
            Err(error) if is_missing(&error) => Self::create(node_home),
            Err(error) => Err(error),
        }
    }

    /// Load an existing identity. Fails closed on anything suspicious.
    pub fn load(node_home: &Path) -> Result<Self> {
        let path = key_path(node_home);
        let metadata = std::fs::metadata(&path)
            .with_context(|| format!("identity key {} is missing", path.display()))?;

        // A key readable by other users is not a key we will use.
        let mode = metadata.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            bail!(
                "identity key {} has permissions {mode:o}; it must be 0600. \
                 Refusing to use a key other users can read.",
                path.display()
            );
        }

        let encoded = std::fs::read_to_string(&path)
            .with_context(|| format!("failed to read identity key {}", path.display()))?;
        let bytes = decode_base64(encoded.trim()).with_context(|| {
            format!(
                "identity key {} is malformed; refusing to generate a replacement",
                path.display()
            )
        })?;
        if bytes.len() != SECRET_KEY_LENGTH {
            bail!(
                "identity key {} is {} bytes, expected {SECRET_KEY_LENGTH}; \
                 refusing to generate a replacement",
                path.display(),
                bytes.len()
            );
        }

        let mut secret = [0u8; SECRET_KEY_LENGTH];
        secret.copy_from_slice(&bytes);
        let signing_key = SigningKey::from_bytes(&secret);

        let metadata = Self::read_metadata(node_home)?;
        let expected = fingerprint_of(&signing_key.verifying_key());
        if !metadata.fingerprint.is_empty() && metadata.fingerprint != expected {
            bail!(
                "identity metadata fingerprint does not match the private key; \
                 refusing to continue with an inconsistent identity"
            );
        }

        let public_key = encode_base64(signing_key.verifying_key().as_bytes());
        Ok(Self {
            signing_key,
            metadata: IdentityMetadata {
                public_key,
                fingerprint: expected,
                ..metadata
            },
            node_home: node_home.to_path_buf(),
        })
    }

    /// Generate a fresh identity from OS randomness.
    pub fn create(node_home: &Path) -> Result<Self> {
        let path = key_path(node_home);
        if path.exists() {
            bail!(
                "identity key {} already exists; refusing to overwrite it",
                path.display()
            );
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let mut secret = [0u8; SECRET_KEY_LENGTH];
        getrandom::getrandom(&mut secret)
            .context("failed to read OS randomness for the Node identity")?;
        let signing_key = SigningKey::from_bytes(&secret);
        secret.fill(0);

        write_owner_only(&path, &encode_base64(&signing_key.to_bytes()))?;

        let verifying = signing_key.verifying_key();
        let metadata = IdentityMetadata {
            public_key: encode_base64(verifying.as_bytes()),
            fingerprint: fingerprint_of(&verifying),
            node_id: None,
            control_plane_url: None,
            enrolled_at: None,
            created_at: crate::registry::now_millis(),
        };
        let identity = Self {
            signing_key,
            metadata,
            node_home: node_home.to_path_buf(),
        };
        identity.save_metadata()?;
        Ok(identity)
    }

    /// Build a replacement identity in memory without touching the key on disk.
    ///
    /// Rotation must not destroy the current key before the Control Plane has
    /// accepted the new one: a failure between the two would leave a Node with a
    /// key nobody recognises and no way back. The caller commits with
    /// [`Self::commit_rotation`] only after the Control Plane confirms.
    pub fn propose_rotation(&self) -> Result<Self> {
        let mut secret = [0u8; SECRET_KEY_LENGTH];
        getrandom::getrandom(&mut secret)
            .context("failed to read OS randomness for the replacement identity")?;
        let signing_key = SigningKey::from_bytes(&secret);
        secret.fill(0);

        let verifying = signing_key.verifying_key();
        Ok(Self {
            metadata: IdentityMetadata {
                public_key: encode_base64(verifying.as_bytes()),
                fingerprint: fingerprint_of(&verifying),
                created_at: crate::registry::now_millis(),
                ..self.metadata.clone()
            },
            signing_key,
            node_home: self.node_home.clone(),
        })
    }

    /// Persist a proposed identity, replacing the key currently on disk.
    ///
    /// The key is written before the metadata: [`Self::load`] refuses a metadata
    /// fingerprint that disagrees with the key, so the ordering means a crash
    /// between the two writes fails loudly instead of running under an identity
    /// that is half-rotated.
    pub fn commit_rotation(&self) -> Result<()> {
        write_owner_only(
            &key_path(&self.node_home),
            &encode_base64(&self.signing_key.to_bytes()),
        )?;
        self.save_metadata()
    }

    fn read_metadata(node_home: &Path) -> Result<IdentityMetadata> {
        let path = meta_path(node_home);
        if !path.is_file() {
            return Ok(IdentityMetadata::default());
        }
        let body = std::fs::read_to_string(&path)
            .with_context(|| format!("failed to read {}", path.display()))?;
        serde_json::from_str(&body).with_context(|| format!("failed to parse {}", path.display()))
    }

    pub fn save_metadata(&self) -> Result<()> {
        let path = meta_path(&self.node_home);
        let body = serde_json::to_string_pretty(&self.metadata)?;
        write_owner_only(&path, &body)
    }

    pub fn metadata(&self) -> &IdentityMetadata {
        &self.metadata
    }

    pub fn fingerprint(&self) -> &str {
        &self.metadata.fingerprint
    }

    pub fn public_key_base64(&self) -> String {
        encode_base64(self.signing_key.verifying_key().as_bytes())
    }

    pub fn node_id(&self) -> Option<&str> {
        self.metadata.node_id.as_deref()
    }

    /// Record the identifier the Control Plane assigned during enrollment.
    pub fn record_enrollment(&mut self, node_id: &str, control_plane_url: &str) -> Result<()> {
        self.metadata.node_id = Some(node_id.to_owned());
        self.metadata.control_plane_url = Some(control_plane_url.to_owned());
        self.metadata.enrolled_at = Some(crate::registry::now_millis());
        self.save_metadata()
    }

    /// Sign an authentication transcript. The only use of the private key.
    pub fn sign(&self, message: &[u8]) -> String {
        encode_base64(&self.signing_key.sign(message).to_bytes())
    }
}

/// SHA-256 of the raw public key, lowercase hex.
///
/// SHA-256 is used wherever a stable digest is required; no bespoke hash is
/// involved anywhere in the protocol.
pub fn fingerprint_of(key: &VerifyingKey) -> String {
    let digest = Sha256::digest(key.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Verify a signature against a base64-encoded public key.
///
/// Used by the mock Control Plane and by tests. `ed25519-dalek` performs the
/// comparison itself; no signature bytes are compared here by hand.
pub fn verify_signature(public_key_base64: &str, message: &[u8], signature_base64: &str) -> bool {
    let Ok(key_bytes) = decode_base64(public_key_base64) else {
        return false;
    };
    let Ok(key_array): std::result::Result<[u8; 32], _> = key_bytes.try_into() else {
        return false;
    };
    let Ok(verifying) = VerifyingKey::from_bytes(&key_array) else {
        return false;
    };
    let Ok(signature_bytes) = decode_base64(signature_base64) else {
        return false;
    };
    let Ok(signature_array): std::result::Result<[u8; 64], _> = signature_bytes.try_into() else {
        return false;
    };
    verifying
        .verify(message, &Signature::from_bytes(&signature_array))
        .is_ok()
}

fn write_owner_only(path: &Path, body: &str) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    // Created 0600 from the outset: never briefly world-readable.
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .with_context(|| format!("failed to write {}", path.display()))?;
    file.write_all(body.as_bytes())?;
    file.flush()?;

    let mut permissions = std::fs::metadata(path)?.permissions();
    permissions.set_mode(0o600);
    std::fs::set_permissions(path, permissions)?;
    Ok(())
}

fn is_missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound)
    })
}

pub fn encode_base64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn decode_base64(text: &str) -> Result<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(text.trim())
        .context("value is not valid base64")
}

#[cfg(test)]
mod tests {

    #[test]
    fn a_proposed_rotation_does_not_touch_the_key_on_disk() {
        // The current key must stay usable until the Control Plane accepts the
        // replacement; otherwise a failure mid-rotation strands the Node.
        let home = tempfile::tempdir().unwrap();
        let identity = NodeIdentity::create(home.path()).unwrap();
        let before = std::fs::read_to_string(key_path(home.path())).unwrap();

        let proposed = identity.propose_rotation().unwrap();
        assert_ne!(proposed.fingerprint(), identity.fingerprint());
        assert_eq!(
            std::fs::read_to_string(key_path(home.path())).unwrap(),
            before
        );
    }

    #[test]
    fn committing_a_rotation_replaces_the_key_and_metadata_together() {
        let home = tempfile::tempdir().unwrap();
        let mut identity = NodeIdentity::create(home.path()).unwrap();
        identity
            .record_enrollment("node-1", "https://control.example")
            .unwrap();
        let old_fingerprint = identity.fingerprint().to_owned();

        let proposed = identity.propose_rotation().unwrap();
        let new_fingerprint = proposed.fingerprint().to_owned();
        proposed.commit_rotation().unwrap();

        // Reloading proves key and metadata agree; `load` refuses a mismatch.
        let reloaded = NodeIdentity::load(home.path()).unwrap();
        assert_eq!(reloaded.fingerprint(), new_fingerprint);
        assert_ne!(reloaded.fingerprint(), old_fingerprint);
        // Enrollment survives rotation: same Node, new key.
        assert_eq!(reloaded.node_id(), Some("node-1"));
    }

    #[test]
    fn a_rotated_key_is_written_owner_only() {
        let home = tempfile::tempdir().unwrap();
        let identity = NodeIdentity::create(home.path()).unwrap();
        identity
            .propose_rotation()
            .unwrap()
            .commit_rotation()
            .unwrap();

        let mode = std::fs::metadata(key_path(home.path()))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn each_proposed_rotation_is_a_distinct_key() {
        let home = tempfile::tempdir().unwrap();
        let identity = NodeIdentity::create(home.path()).unwrap();
        let first = identity.propose_rotation().unwrap();
        let second = identity.propose_rotation().unwrap();
        assert_ne!(first.fingerprint(), second.fingerprint());
    }
    use super::*;

    fn home() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("node")).unwrap();
        dir
    }

    #[test]
    fn an_identity_is_generated_on_first_use() {
        let dir = home();
        let identity = NodeIdentity::load_or_create(dir.path()).unwrap();

        assert_eq!(identity.fingerprint().len(), 64, "SHA-256 hex");
        assert!(!identity.metadata().is_enrolled());
        assert!(key_path(dir.path()).is_file());
        assert!(meta_path(dir.path()).is_file());
    }

    #[test]
    fn the_private_key_is_written_owner_only() {
        let dir = home();
        NodeIdentity::load_or_create(dir.path()).unwrap();

        let mode = std::fs::metadata(key_path(dir.path()))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn an_identity_persists_across_loads() {
        let dir = home();
        let first = NodeIdentity::load_or_create(dir.path()).unwrap();
        let fingerprint = first.fingerprint().to_owned();
        drop(first);

        let second = NodeIdentity::load(dir.path()).unwrap();
        assert_eq!(second.fingerprint(), fingerprint);
    }

    #[test]
    fn a_world_readable_key_is_refused() {
        let dir = home();
        NodeIdentity::load_or_create(dir.path()).unwrap();
        let path = key_path(dir.path());
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o644);
        std::fs::set_permissions(&path, permissions).unwrap();

        let error = NodeIdentity::load(dir.path()).unwrap_err();
        assert!(error.to_string().contains("0600"));
    }

    #[test]
    fn a_malformed_key_never_silently_becomes_a_new_identity() {
        let dir = home();
        write_owner_only(&key_path(dir.path()), "this is not base64 !!!").unwrap();

        // load_or_create must NOT paper over corruption by minting a new key.
        assert!(NodeIdentity::load_or_create(dir.path()).is_err());
    }

    #[test]
    fn a_truncated_key_is_refused() {
        let dir = home();
        write_owner_only(&key_path(dir.path()), &encode_base64(&[1u8; 16])).unwrap();

        let error = NodeIdentity::load(dir.path()).unwrap_err();
        assert!(error.to_string().contains("expected"));
    }

    #[test]
    fn metadata_that_disagrees_with_the_key_is_refused() {
        let dir = home();
        NodeIdentity::load_or_create(dir.path()).unwrap();
        let mut metadata: IdentityMetadata =
            serde_json::from_str(&std::fs::read_to_string(meta_path(dir.path())).unwrap()).unwrap();
        metadata.fingerprint = "0".repeat(64);
        write_owner_only(
            &meta_path(dir.path()),
            &serde_json::to_string(&metadata).unwrap(),
        )
        .unwrap();

        assert!(NodeIdentity::load(dir.path()).is_err());
    }

    #[test]
    fn creating_over_an_existing_key_is_refused() {
        let dir = home();
        NodeIdentity::load_or_create(dir.path()).unwrap();
        assert!(NodeIdentity::create(dir.path()).is_err());
    }

    #[test]
    fn signatures_verify_against_the_public_key() {
        let dir = home();
        let identity = NodeIdentity::load_or_create(dir.path()).unwrap();
        let message = b"transcript bytes";

        let signature = identity.sign(message);

        assert!(verify_signature(
            &identity.public_key_base64(),
            message,
            &signature
        ));
    }

    #[test]
    fn a_signature_over_different_bytes_fails() {
        let dir = home();
        let identity = NodeIdentity::load_or_create(dir.path()).unwrap();
        let signature = identity.sign(b"one message");

        assert!(!verify_signature(
            &identity.public_key_base64(),
            b"another message",
            &signature
        ));
    }

    #[test]
    fn a_signature_from_a_different_identity_fails() {
        let first = home();
        let second = home();
        let a = NodeIdentity::load_or_create(first.path()).unwrap();
        let b = NodeIdentity::load_or_create(second.path()).unwrap();
        let message = b"transcript";

        assert!(!verify_signature(
            &b.public_key_base64(),
            message,
            &a.sign(message)
        ));
    }

    #[test]
    fn malformed_signature_material_is_rejected_without_panicking() {
        let dir = home();
        let identity = NodeIdentity::load_or_create(dir.path()).unwrap();

        assert!(!verify_signature(
            &identity.public_key_base64(),
            b"m",
            "!!!"
        ));
        assert!(!verify_signature(&identity.public_key_base64(), b"m", ""));
        assert!(!verify_signature("not-base64", b"m", &identity.sign(b"m")));
        assert!(!verify_signature(
            &encode_base64(&[0u8; 8]),
            b"m",
            &identity.sign(b"m")
        ));
    }

    #[test]
    fn enrollment_is_recorded_without_any_secret() {
        let dir = home();
        let mut identity = NodeIdentity::load_or_create(dir.path()).unwrap();
        identity
            .record_enrollment("node-123", "https://control.example")
            .unwrap();

        let stored = std::fs::read_to_string(meta_path(dir.path())).unwrap();
        assert!(stored.contains("node-123"));
        assert!(!stored.contains("token"));
        assert!(!stored.contains("secret"));
        // The private key must never appear in the public metadata file.
        assert!(!stored.contains(&encode_base64(&identity.signing_key.to_bytes())));
    }

    #[test]
    fn the_debug_rendering_hides_private_material() {
        let dir = home();
        let identity = NodeIdentity::load_or_create(dir.path()).unwrap();
        let rendered = format!("{identity:?}");

        assert!(rendered.contains(identity.fingerprint()));
        assert!(!rendered.contains(&encode_base64(&identity.signing_key.to_bytes())));
    }

    #[test]
    fn fingerprints_are_stable_and_distinct_per_identity() {
        let first = home();
        let second = home();
        let a = NodeIdentity::load_or_create(first.path()).unwrap();
        let b = NodeIdentity::load_or_create(second.path()).unwrap();

        assert_ne!(a.fingerprint(), b.fingerprint());
        assert_eq!(
            a.fingerprint(),
            NodeIdentity::load(first.path()).unwrap().fingerprint()
        );
    }
}
