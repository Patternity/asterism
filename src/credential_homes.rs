//! Where each isolated provider credential lives on this host.
//!
//! One credential, one directory, one `auth.json`. The pinned Hermes cannot be
//! told which entry of a shared pool to use -- its selection is a strategy, not
//! an address -- so the only way for a project to use exactly one credential is
//! for that project's `auth.json` to be a link to a store holding exactly one.
//! That store is a home under a single managed root, named by the credential's
//! opaque id and by nothing else.
//!
//! **Nothing here opens a credential.** Every check is on metadata: that a
//! directory is a directory, that a file is a regular file, who owns it, and
//! that nobody else can read it. Whether the provider still accepts what is
//! inside is a question only a run can answer.
//!
//! **Nothing here accepts a path.** A home is derived from a validated id under
//! a root this Node fixes, and a project's link is compared byte for byte
//! against the one target that id can produce. A link pointing anywhere else --
//! a sibling, a parent, a symlink dressed as a home, a path with a `.` in it --
//! is not a credential this Node assigned, whoever wrote it.

use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, bail};

/// The managed root, beneath the Node home.
pub const ROOT_NAME: &str = "credentials";

/// The file Hermes keeps its credential store in.
pub const CREDENTIAL_FILE: &str = "auth.json";

/// The lock Hermes takes around every read and write of that store.
///
/// Hermes derives it from the *link's* location rather than the file's, so two
/// projects reading one credential through two links would lock two different
/// files -- and refresh one single-use token concurrently. Linking the lock too
/// puts both of them on the one lock beside the store.
pub const LOCK_FILE: &str = "auth.lock";

/// Where isolated credentials live for a Node home.
pub fn managed_root(node_home: &Path) -> PathBuf {
    node_home.join(ROOT_NAME)
}

/// The home of one credential, derived only from its validated id.
pub fn home(root: &Path, credential_id: &str) -> Result<PathBuf> {
    crate::credentials::validate_id(credential_id)?;
    Ok(root.join(credential_id))
}

/// The one target a project link to this credential may have.
pub fn credential_file(root: &Path, credential_id: &str) -> Result<PathBuf> {
    Ok(home(root, credential_id)?.join(CREDENTIAL_FILE))
}

/// The lock a project link to this credential shares.
pub fn lock_file(root: &Path, credential_id: &str) -> Result<PathBuf> {
    Ok(home(root, credential_id)?.join(LOCK_FILE))
}

/// A directory only its owner may enter, owned by the account that runs Hermes.
fn check_private_dir(metadata: &std::fs::Metadata, uid: u32, what: &str) -> Result<()> {
    if metadata.file_type().is_symlink() {
        bail!("{what} is a symlink");
    }
    if !metadata.is_dir() {
        bail!("{what} is not a directory");
    }
    if metadata.uid() != uid {
        bail!("{what} is owned by uid {}, not {uid}", metadata.uid());
    }
    let mode = metadata.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        bail!("{what} is open beyond its owner (mode {mode:o})");
    }
    Ok(())
}

/// Make sure the managed root exists and is exactly what it should be.
///
/// Created `0700` when absent. An existing root that is a link, belongs to
/// somebody else or is readable by others is refused rather than repaired: that
/// is not a state this Node produces, and quietly tightening it would hide
/// whatever did.
pub fn ensure_root(root: &Path, uid: u32) -> Result<()> {
    match std::fs::symlink_metadata(root) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if let Some(parent) = root.parent() {
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("cannot create {}", parent.display()))?;
            }
            std::fs::create_dir(root)
                .with_context(|| format!("cannot create {}", root.display()))?;
            std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))?;
        }
        Err(error) => {
            return Err(error).with_context(|| format!("cannot inspect {}", root.display()));
        }
    }
    let metadata = std::fs::symlink_metadata(root)?;
    check_private_dir(&metadata, uid, "the credential root")
}

/// Create the home for a credential that does not exist yet.
///
/// Refuses one that already exists. Ids are random and fresh, so an existing
/// directory is something this attempt did not create, and a login run into it
/// would add a second credential to a store that must hold exactly one.
pub fn create_home(root: &Path, credential_id: &str, uid: u32) -> Result<PathBuf> {
    ensure_root(root, uid)?;
    let home = home(root, credential_id)?;
    std::fs::create_dir(&home)
        .with_context(|| format!("cannot create the credential home {}", home.display()))?;
    std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700))?;
    Ok(home)
}

/// What is on disk for one credential.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HomeState {
    /// The home and its store are exactly as they should be.
    Ready,
    /// No home at all.
    HomeMissing,
    /// The root or the home is a link, belongs to someone else, or is open.
    HomeInvalid,
    /// A home with nothing in it: authorization never finished, or the store
    /// was taken away.
    CredentialMissing,
    /// A store that is a link, is not a regular file, belongs to someone else,
    /// is readable by others, or is empty.
    CredentialUnreadable,
}

/// Inspect one credential's home. Metadata only; the store is never opened.
pub fn inspect(root: &Path, credential_id: &str, uid: u32) -> HomeState {
    let Ok(home) = home(root, credential_id) else {
        return HomeState::HomeInvalid;
    };
    match std::fs::symlink_metadata(root) {
        Ok(metadata) => {
            if check_private_dir(&metadata, uid, "the credential root").is_err() {
                return HomeState::HomeInvalid;
            }
        }
        Err(_) => return HomeState::HomeMissing,
    }
    match std::fs::symlink_metadata(&home) {
        Ok(metadata) => {
            if check_private_dir(&metadata, uid, "the credential home").is_err() {
                return HomeState::HomeInvalid;
            }
        }
        Err(_) => return HomeState::HomeMissing,
    }
    let store = home.join(CREDENTIAL_FILE);
    let metadata = match std::fs::symlink_metadata(&store) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return HomeState::CredentialMissing;
        }
        Err(_) => return HomeState::CredentialUnreadable,
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return HomeState::CredentialUnreadable;
    }
    if metadata.uid() != uid || metadata.permissions().mode() & 0o077 != 0 {
        return HomeState::CredentialUnreadable;
    }
    if metadata.len() == 0 {
        return HomeState::CredentialUnreadable;
    }
    HomeState::Ready
}

/// Where a project's `auth.json` link points, in the only terms that matter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkTarget {
    /// No link at all.
    Missing,
    /// Something other than a symlink sits where the link belongs.
    NotALink,
    /// Exactly the host's shared pool.
    LegacySharedPool,
    /// Exactly `<root>/<id>/auth.json`, for an id this Node would accept.
    Isolated(String),
    /// Anywhere else, including a spelling of an isolated target that is not
    /// byte-for-byte the one this Node writes.
    Elsewhere,
}

/// Read a link and say what it is. The link is never followed.
pub fn classify_link(link: &Path, root: &Path, shared_pool: &Path) -> LinkTarget {
    let metadata = match std::fs::symlink_metadata(link) {
        Ok(metadata) => metadata,
        Err(_) => return LinkTarget::Missing,
    };
    if !metadata.file_type().is_symlink() {
        return LinkTarget::NotALink;
    }
    let Ok(target) = std::fs::read_link(link) else {
        return LinkTarget::Elsewhere;
    };
    classify_target(&target, root, shared_pool)
}

/// The same judgement for a target that has already been read.
pub fn classify_target(target: &Path, root: &Path, shared_pool: &Path) -> LinkTarget {
    if target.as_os_str() == shared_pool.as_os_str() {
        return LinkTarget::LegacySharedPool;
    }
    let Ok(rest) = target.strip_prefix(root) else {
        return LinkTarget::Elsewhere;
    };
    let components: Vec<Component<'_>> = rest.components().collect();
    let [Component::Normal(id), Component::Normal(file)] = components.as_slice() else {
        return LinkTarget::Elsewhere;
    };
    if *file != CREDENTIAL_FILE {
        return LinkTarget::Elsewhere;
    }
    let Some(id) = id.to_str() else {
        return LinkTarget::Elsewhere;
    };
    // Components are normalised, so `root/./id/auth.json` parses the same as
    // the real thing. Only the exact bytes this Node writes count.
    match credential_file(root, id) {
        Ok(expected) if expected.as_os_str() == target.as_os_str() => {
            LinkTarget::Isolated(id.to_owned())
        }
        _ => LinkTarget::Elsewhere,
    }
}

/// Point `link` at `target` in one step.
///
/// A new link is made beside the old one and renamed over it, so a reader sees
/// the old target or the new one and never an absent file. Refuses to replace
/// anything that is not already a link unless `replace_file` says a regular
/// file there is disposable -- true for a lock, never for a credential store.
pub fn swap_link(target: &Path, link: &Path, replace_file: bool) -> Result<()> {
    if !is_plain_absolute(target) {
        bail!("a credential link target must be a plain absolute path");
    }
    match std::fs::symlink_metadata(link) {
        Ok(metadata) if metadata.file_type().is_symlink() => {}
        Ok(metadata) if metadata.is_file() && replace_file => {}
        Ok(_) => bail!(
            "{} is not a link, and is not replaced",
            link.file_name()
                .map(|name| name.to_string_lossy())
                .unwrap_or_default()
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }

    let parent = link
        .parent()
        .context("a credential link must have a parent directory")?;
    let name = link
        .file_name()
        .context("a credential link must have a name")?
        .to_string_lossy();
    let mut nonce = [0u8; 6];
    getrandom::getrandom(&mut nonce).expect("OS randomness is available");
    let nonce: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
    let staging = parent.join(format!(".{name}.asterism-{nonce}"));

    std::os::unix::fs::symlink(target, &staging)
        .with_context(|| format!("cannot stage a link in {}", parent.display()))?;
    if let Err(error) = std::fs::rename(&staging, link) {
        let _ = std::fs::remove_file(&staging);
        return Err(error).with_context(|| format!("cannot put {name} in place"));
    }
    Ok(())
}

/// An absolute path with no empty, `.` or `..` segment, judged on its bytes.
///
/// Not on `Path::components`, which quietly drops an interior `.` and would let
/// `/a/./b` through as though it were `/a/b`.
fn is_plain_absolute(path: &Path) -> bool {
    let Some(text) = path.to_str() else {
        return false;
    };
    let Some(rest) = text.strip_prefix('/') else {
        return false;
    };
    !rest.is_empty()
        && rest
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

/// Remove a link, and only a link.
pub fn remove_link(link: &Path) -> Result<()> {
    match std::fs::symlink_metadata(link) {
        Ok(metadata) if metadata.file_type().is_symlink() => Ok(std::fs::remove_file(link)?),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// How one project reaches its credential, as `node doctor` reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReferenceState {
    /// No assignment, and the link reaches the shared pool.
    LegacySharedPool,
    /// Assigned, and the link reaches exactly that credential's store.
    Isolated,
    /// Assigned to a credential whose home does not exist.
    CredentialHomeMissing,
    /// The link points somewhere other than the assignment says.
    LinkTargetInvalid,
    /// The home or store exists and is not something a worker may read.
    CredentialUnreadable,
    /// The home is fine, but the credential is not authorized or holds nothing.
    CredentialUnavailable,
}

impl ReferenceState {
    pub fn wire(self) -> &'static str {
        match self {
            Self::LegacySharedPool => "legacy_shared_pool",
            Self::Isolated => "isolated",
            Self::CredentialHomeMissing => "credential_home_missing",
            Self::LinkTargetInvalid => "link_target_invalid",
            Self::CredentialUnreadable => "credential_unreadable",
            Self::CredentialUnavailable => "credential_unavailable",
        }
    }

    pub fn is_healthy(self) -> bool {
        matches!(self, Self::LegacySharedPool | Self::Isolated)
    }
}

/// Judge one project's reference.
///
/// `authorized` answers whether the registry holds this id as an authorized,
/// isolated credential. It is a parameter so the doctor, which reads the
/// registry file, and the service, which holds it in memory, reach the same
/// verdict through the same rules.
pub fn reference_state(
    link: &Path,
    root: &Path,
    shared_pool: &Path,
    assignment: Option<&str>,
    uid: u32,
    authorized: impl Fn(&str) -> bool,
) -> ReferenceState {
    let target = classify_link(link, root, shared_pool);
    let Some(credential_id) = assignment else {
        return match target {
            LinkTarget::LegacySharedPool => ReferenceState::LegacySharedPool,
            _ => ReferenceState::LinkTargetInvalid,
        };
    };
    match inspect(root, credential_id, uid) {
        HomeState::HomeMissing => return ReferenceState::CredentialHomeMissing,
        HomeState::HomeInvalid | HomeState::CredentialUnreadable => {
            return ReferenceState::CredentialUnreadable;
        }
        HomeState::CredentialMissing => return ReferenceState::CredentialUnavailable,
        HomeState::Ready => {}
    }
    if target != LinkTarget::Isolated(credential_id.to_owned()) {
        return ReferenceState::LinkTargetInvalid;
    }
    if !authorized(credential_id) {
        return ReferenceState::CredentialUnavailable;
    }
    ReferenceState::Isolated
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uid() -> u32 {
        unsafe { libc::getuid() }
    }

    fn ready_home(root: &Path, id: &str) -> PathBuf {
        let home = create_home(root, id, uid()).unwrap();
        let store = home.join(CREDENTIAL_FILE);
        std::fs::write(&store, b"{}").unwrap();
        std::fs::set_permissions(&store, std::fs::Permissions::from_mode(0o600)).unwrap();
        home
    }

    #[test]
    fn a_home_is_derived_from_a_valid_id_and_nothing_else() {
        let root = Path::new("/var/lib/asterism/credentials");
        assert_eq!(
            credential_file(root, "cred-0011aabbccddeeff").unwrap(),
            PathBuf::from("/var/lib/asterism/credentials/cred-0011aabbccddeeff/auth.json")
        );
        for hostile in [
            "../hermes",
            "..",
            ".",
            "",
            "cred/../../etc",
            "/etc/passwd",
            "Cred",
            "a b",
            "cred-\u{0}",
        ] {
            assert!(home(root, hostile).is_err(), "{hostile:?} must be refused");
        }
    }

    #[test]
    fn a_new_home_is_private_and_a_second_one_with_that_id_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("credentials");
        let home = create_home(&root, "cred-one", uid()).unwrap();
        assert_eq!(
            std::fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&home).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert!(create_home(&root, "cred-one", uid()).is_err());
    }

    /// A root that is a link is somebody else's idea of where credentials go.
    #[test]
    fn a_root_that_is_a_link_or_open_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = dir.path().join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        std::fs::set_permissions(&elsewhere, std::fs::Permissions::from_mode(0o700)).unwrap();
        let root = dir.path().join("credentials");
        std::os::unix::fs::symlink(&elsewhere, &root).unwrap();
        assert!(ensure_root(&root, uid()).is_err());
        assert!(create_home(&root, "cred-one", uid()).is_err());

        let open = dir.path().join("open");
        std::fs::create_dir(&open).unwrap();
        std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(ensure_root(&open, uid()).is_err());
    }

    #[test]
    fn a_home_is_judged_on_metadata_alone() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("credentials");
        assert_eq!(inspect(&root, "cred-one", uid()), HomeState::HomeMissing);

        let home = create_home(&root, "cred-one", uid()).unwrap();
        assert_eq!(
            inspect(&root, "cred-one", uid()),
            HomeState::CredentialMissing
        );

        let store = home.join(CREDENTIAL_FILE);
        std::fs::write(&store, b"").unwrap();
        std::fs::set_permissions(&store, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            inspect(&root, "cred-one", uid()),
            HomeState::CredentialUnreadable,
            "an empty store holds nothing"
        );

        std::fs::write(&store, b"{}").unwrap();
        assert_eq!(inspect(&root, "cred-one", uid()), HomeState::Ready);

        std::fs::set_permissions(&store, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            inspect(&root, "cred-one", uid()),
            HomeState::CredentialUnreadable
        );
        assert_eq!(
            inspect(&root, "cred-one", uid() + 1),
            HomeState::HomeInvalid,
            "a home owned by another account is not this Node's"
        );
    }

    /// Symlink substitution: a store replaced by a link to some other file, or
    /// a home replaced by a link to some other directory, is not the credential.
    #[test]
    fn a_store_or_home_substituted_by_a_link_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("credentials");
        let home = ready_home(&root, "cred-one");
        let other = ready_home(&root, "cred-two");

        let store = home.join(CREDENTIAL_FILE);
        std::fs::remove_file(&store).unwrap();
        std::os::unix::fs::symlink(other.join(CREDENTIAL_FILE), &store).unwrap();
        assert_eq!(
            inspect(&root, "cred-one", uid()),
            HomeState::CredentialUnreadable
        );

        std::fs::remove_file(&store).unwrap();
        std::fs::remove_dir(&home).unwrap();
        std::os::unix::fs::symlink(&other, &home).unwrap();
        assert_eq!(inspect(&root, "cred-one", uid()), HomeState::HomeInvalid);
    }

    #[test]
    fn only_the_exact_target_counts_as_a_credential() {
        let root = Path::new("/var/lib/asterism/credentials");
        let shared = Path::new("/var/lib/asterism/hermes/auth.json");
        let classify = |target: &str| classify_target(Path::new(target), root, shared);

        assert_eq!(
            classify("/var/lib/asterism/hermes/auth.json"),
            LinkTarget::LegacySharedPool
        );
        assert_eq!(
            classify("/var/lib/asterism/credentials/cred-one/auth.json"),
            LinkTarget::Isolated("cred-one".to_owned())
        );
        for hostile in [
            "/var/lib/asterism/credentials/cred-one/../cred-two/auth.json",
            "/var/lib/asterism/credentials/./cred-one/auth.json",
            "/var/lib/asterism/credentials//cred-one/auth.json",
            "/var/lib/asterism/credentials/cred-one/auth.lock",
            "/var/lib/asterism/credentials/cred-one/nested/auth.json",
            "/var/lib/asterism/credentials/auth.json",
            "/var/lib/asterism/credentials/../hermes/auth.json",
            "/var/lib/asterism/credentials/Cred-One/auth.json",
            "/etc/shadow",
            "credentials/cred-one/auth.json",
            "/var/lib/asterism/hermes/auth.json/",
        ] {
            assert_eq!(classify(hostile), LinkTarget::Elsewhere, "{hostile}");
        }
    }

    #[test]
    fn a_link_is_swapped_in_one_step_and_a_real_store_is_never_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let link = dir.path().join(CREDENTIAL_FILE);
        let first = dir.path().join("first");
        let second = dir.path().join("second");

        swap_link(&first, &link, false).unwrap();
        assert_eq!(std::fs::read_link(&link).unwrap(), first);
        swap_link(&second, &link, false).unwrap();
        assert_eq!(std::fs::read_link(&link).unwrap(), second);
        // Nothing staged is left behind.
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains("asterism-"))
            .collect();
        assert!(leftovers.is_empty());

        std::fs::remove_file(&link).unwrap();
        std::fs::write(&link, b"{}").unwrap();
        assert!(swap_link(&first, &link, false).is_err());
        assert_eq!(
            std::fs::read(&link).unwrap(),
            b"{}",
            "left exactly as it was"
        );
        // A lock is disposable.
        swap_link(&first, &link, true).unwrap();
        assert!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );

        for hostile in ["relative/auth.json", "/a/../b/auth.json", "/a/./auth.json"] {
            assert!(swap_link(Path::new(hostile), &link, false).is_err());
        }
    }

    #[test]
    fn every_reference_state_is_told_apart() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("credentials");
        let shared = dir.path().join("hermes/auth.json");
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let link = project.join(CREDENTIAL_FILE);
        let yes = |_: &str| true;
        let judge = |assignment: Option<&str>, authorized: &dyn Fn(&str) -> bool| {
            reference_state(&link, &root, &shared, assignment, uid(), authorized)
        };

        swap_link(&shared, &link, false).unwrap();
        assert_eq!(judge(None, &yes), ReferenceState::LegacySharedPool);
        assert_eq!(
            judge(Some("cred-one"), &yes),
            ReferenceState::CredentialHomeMissing
        );

        let home = create_home(&root, "cred-one", uid()).unwrap();
        assert_eq!(
            judge(Some("cred-one"), &yes),
            ReferenceState::CredentialUnavailable
        );

        std::fs::write(home.join(CREDENTIAL_FILE), b"{}").unwrap();
        std::fs::set_permissions(
            home.join(CREDENTIAL_FILE),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        assert_eq!(
            judge(Some("cred-one"), &yes),
            ReferenceState::LinkTargetInvalid,
            "still pointing at the shared pool"
        );

        swap_link(&credential_file(&root, "cred-one").unwrap(), &link, false).unwrap();
        assert_eq!(judge(Some("cred-one"), &yes), ReferenceState::Isolated);
        assert_eq!(
            judge(Some("cred-one"), &|_| false),
            ReferenceState::CredentialUnavailable
        );
        assert_eq!(judge(None, &yes), ReferenceState::LinkTargetInvalid);

        std::fs::set_permissions(
            home.join(CREDENTIAL_FILE),
            std::fs::Permissions::from_mode(0o640),
        )
        .unwrap();
        assert_eq!(
            judge(Some("cred-one"), &yes),
            ReferenceState::CredentialUnreadable
        );
    }
}
