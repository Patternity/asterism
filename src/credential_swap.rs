//! Replacing what one credential holds, without replacing the credential.
//!
//! The runtime this Node drives cannot rewrite a credential in place: its only
//! way to produce new material is to add a record, which mints an identity of
//! its own. So a reauthorization logs in inside a *staging home* nobody reads,
//! and the single file that results is renamed over the credential's own.
//!
//! Everything a project addresses survives that, because none of it is the
//! file: the credential id, its home, and the links every project's profile
//! holds all point at a path, and the path is what a rename preserves. Nothing
//! is relinked, no project is reassigned, and no second credential ever exists.
//!
//! **The old file is rollback material, not a second credential.** It is moved
//! aside rather than deleted so a failed swap has something true to return to,
//! it lives in the same private home, and it is removed once the new one has
//! been proven by the workers that use it. It is never a fallback the runtime
//! could read: the runtime is told one path, and only one file is ever at it.
//!
//! **Nothing here reads a credential.** The staged file is judged by
//! `credential_runtime`, which looks only at metadata; this module moves bytes
//! it never inspects and never copies anywhere but between two private paths.

use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

use crate::credential_homes::CREDENTIAL_FILE;

/// Where the previous file waits while the new one is proven.
pub const ROLLBACK_FILE: &str = "auth.json.rollback";

/// The directory staging homes are built under, beneath the Node home.
///
/// Beside the credential root rather than inside it: a staging home is a whole
/// runtime home for a moment, and the credential root holds credential homes
/// only. Same filesystem either way, which is what the rename needs.
pub const STAGING_ROOT: &str = "reauth";

/// A staging home, removed when this value is dropped.
///
/// Tied to the value rather than to a tidy-up at the end of the happy path:
/// every way this can fail -- a refusal, a cancellation, a panic, a `?` -- still
/// runs it, and a staging home that outlived its attempt would be a second copy
/// of a credential sitting on disk.
#[derive(Debug)]
pub struct StagingHome {
    path: PathBuf,
}

impl StagingHome {
    /// Build one, private to the account that runs the runtime.
    pub fn create(node_home: &Path, uid: u32) -> Result<Self> {
        let root = node_home.join(STAGING_ROOT);
        std::fs::create_dir_all(&root)
            .with_context(|| format!("cannot prepare {}", root.display()))?;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))?;

        // Named by nothing anybody can predict, so two attempts can never land
        // in one directory and a name cannot be guessed and pre-created.
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let path = root.join(nonce);
        std::fs::create_dir(&path).with_context(|| format!("cannot prepare {}", path.display()))?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
        chown(&path, uid)?;
        Ok(Self { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The store a login in this home produces.
    pub fn store(&self) -> PathBuf {
        self.path.join(CREDENTIAL_FILE)
    }
}

impl Drop for StagingHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn chown(path: &Path, uid: u32) -> Result<()> {
    // Only when this process can: a Node running as the runtime account already
    // owns what it creates, and a test running as anybody owns its own tree.
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.uid() == uid {
        return Ok(());
    }
    std::os::unix::fs::chown(path, Some(uid), None)
        .with_context(|| format!("cannot give {} to uid {uid}", path.display()))
}

/// Refuse anything that is not a plain, private file owned by the runtime.
///
/// A symlink here is the whole attack: a staged store that is a link writes
/// through to wherever it points, and a canonical file that has become one
/// would have the rename replace the link rather than the credential.
fn check_plain_private_file(path: &Path, uid: u32, what: &str) -> Result<()> {
    let metadata =
        std::fs::symlink_metadata(path).with_context(|| format!("cannot inspect {what}"))?;
    if metadata.file_type().is_symlink() {
        bail!("{what} is a symlink");
    }
    if !metadata.is_file() {
        bail!("{what} is not a regular file");
    }
    if metadata.uid() != uid {
        bail!("{what} is owned by uid {}, not {uid}", metadata.uid());
    }
    let mode = metadata.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        bail!("{what} is open beyond its owner");
    }
    Ok(())
}

/// Make a file durable, and its name durable in its directory.
fn fsync_file_and_parent(path: &Path) -> Result<()> {
    let file = std::fs::File::open(path)?;
    file.sync_all()?;
    if let Some(parent) = path.parent() {
        let dir = std::fs::File::open(parent)?;
        dir.sync_all()?;
    }
    Ok(())
}

/// What one home looks like part-way through a swap.
///
/// Read after a restart, because a Node that stopped between two renames has to
/// know which of them happened. There are only three shapes, and each has one
/// reading.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SwapState {
    /// One file, no rollback material: nothing is in flight.
    Settled,
    /// Both files: the rename happened and the result was never accepted.
    /// The new one is in place and the old one is still recoverable.
    Swapped,
    /// Rollback material and no credential: the move aside happened and the
    /// rename did not. The credential is the file that was moved.
    Interrupted,
}

/// Which of the three shapes a credential home is in.
pub fn swap_state(home: &Path) -> SwapState {
    let live = home.join(CREDENTIAL_FILE).exists();
    let rollback = home.join(ROLLBACK_FILE).exists();
    match (live, rollback) {
        (true, false) => SwapState::Settled,
        (true, true) => SwapState::Swapped,
        (false, true) => SwapState::Interrupted,
        // No credential and nothing to restore is not a swap in progress; it is
        // a home with no record, which is a state of its own.
        (false, false) => SwapState::Settled,
    }
}

/// Put the staged store in place, keeping the old one recoverable.
///
/// The order is the contract. The old file is moved aside first, so at no
/// moment do two credentials answer to one path; the new one is renamed in
/// second; the directory is synced last, so the pair of names survives a power
/// cut. A Node that stops between any two steps leaves one of the three shapes
/// above, and `swap_state` reads each of them one way.
pub fn swap_in(home: &Path, staged: &Path, uid: u32) -> Result<()> {
    check_plain_private_file(staged, uid, "the staged credential store")?;
    let live = home.join(CREDENTIAL_FILE);
    let rollback = home.join(ROLLBACK_FILE);
    if live.exists() {
        check_plain_private_file(&live, uid, "this credential's store")?;
    }
    if rollback.exists() {
        bail!("this credential already has a swap waiting to be accepted");
    }

    std::fs::set_permissions(staged, std::fs::Permissions::from_mode(0o600))?;
    fsync_file_and_parent(staged)?;

    if live.exists() {
        std::fs::rename(&live, &rollback)
            .with_context(|| "cannot set this credential's store aside".to_owned())?;
    }
    std::fs::rename(staged, &live)
        .with_context(|| "cannot put the new credential store in place".to_owned())?;
    let dir = std::fs::File::open(home)?;
    dir.sync_all()?;
    Ok(())
}

/// Undo a swap, atomically, leaving the credential exactly as it was.
pub fn roll_back(home: &Path) -> Result<()> {
    let live = home.join(CREDENTIAL_FILE);
    let rollback = home.join(ROLLBACK_FILE);
    if !rollback.exists() {
        bail!("this credential has nothing to roll back to");
    }
    // The new file goes first: a rename onto an existing name is atomic, but
    // leaving the failed material beside the restored credential is not what
    // "as it was" means.
    if live.exists() {
        std::fs::remove_file(&live)?;
    }
    std::fs::rename(&rollback, &live)
        .with_context(|| "cannot put this credential's store back".to_owned())?;
    let dir = std::fs::File::open(home)?;
    dir.sync_all()?;
    Ok(())
}

/// Drop the rollback material, once the new credential has been proven.
///
/// Called only after every worker that reads this credential is healthy on it.
/// Until then the old file stays, because a credential nobody has managed to
/// use is not yet a credential worth keeping alone.
pub fn accept(home: &Path) -> Result<()> {
    let rollback = home.join(ROLLBACK_FILE);
    if rollback.exists() {
        std::fs::remove_file(&rollback)
            .with_context(|| "cannot clear this credential's rollback store".to_owned())?;
        let dir = std::fs::File::open(home)?;
        dir.sync_all()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uid() -> u32 {
        // The account running the test owns everything it creates, which is the
        // same relationship the Node has with the runtime account.
        unsafe { libc::getuid() }
    }

    fn home(contents: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let live = dir.path().join(CREDENTIAL_FILE);
        std::fs::write(&live, contents).unwrap();
        std::fs::set_permissions(&live, std::fs::Permissions::from_mode(0o600)).unwrap();
        dir
    }

    fn staged(dir: &Path, contents: &str) -> PathBuf {
        let path = dir.join("staged.json");
        std::fs::write(&path, contents).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        path
    }

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    #[test]
    fn the_new_store_takes_the_old_ones_place_and_the_old_one_survives() {
        let credential = home("old material");
        let elsewhere = tempfile::tempdir().unwrap();
        let new = staged(elsewhere.path(), "new material");

        swap_in(credential.path(), &new, uid()).unwrap();

        // The path a project reads is unchanged and holds the new store.
        assert_eq!(
            read(&credential.path().join(CREDENTIAL_FILE)),
            "new material"
        );
        // The old one is recoverable, and only as rollback material.
        assert_eq!(read(&credential.path().join(ROLLBACK_FILE)), "old material");
        assert!(!new.exists(), "the staged file was moved, not copied");
        assert_eq!(swap_state(credential.path()), SwapState::Swapped);
    }

    #[test]
    fn a_swap_can_be_undone_exactly() {
        let credential = home("old material");
        let elsewhere = tempfile::tempdir().unwrap();
        swap_in(
            credential.path(),
            &staged(elsewhere.path(), "new material"),
            uid(),
        )
        .unwrap();

        roll_back(credential.path()).unwrap();

        assert_eq!(
            read(&credential.path().join(CREDENTIAL_FILE)),
            "old material"
        );
        assert!(!credential.path().join(ROLLBACK_FILE).exists());
        assert_eq!(swap_state(credential.path()), SwapState::Settled);
    }

    #[test]
    fn accepting_clears_the_rollback_store_and_nothing_else() {
        let credential = home("old material");
        let elsewhere = tempfile::tempdir().unwrap();
        swap_in(
            credential.path(),
            &staged(elsewhere.path(), "new material"),
            uid(),
        )
        .unwrap();

        accept(credential.path()).unwrap();

        assert_eq!(
            read(&credential.path().join(CREDENTIAL_FILE)),
            "new material"
        );
        assert!(!credential.path().join(ROLLBACK_FILE).exists());
        assert_eq!(swap_state(credential.path()), SwapState::Settled);
        // Accepting twice is not an error: a retry after a crash must not fail.
        accept(credential.path()).unwrap();
    }

    /// Every shape a Node can stop in has exactly one reading.
    #[test]
    fn an_interrupted_swap_is_read_one_way() {
        let credential = home("old material");
        assert_eq!(swap_state(credential.path()), SwapState::Settled);

        // Stopped between the two renames: the credential is the file that was
        // moved aside, and putting it back is the whole recovery.
        std::fs::rename(
            credential.path().join(CREDENTIAL_FILE),
            credential.path().join(ROLLBACK_FILE),
        )
        .unwrap();
        assert_eq!(swap_state(credential.path()), SwapState::Interrupted);

        roll_back(credential.path()).unwrap();
        assert_eq!(
            read(&credential.path().join(CREDENTIAL_FILE)),
            "old material"
        );
        assert_eq!(swap_state(credential.path()), SwapState::Settled);
    }

    #[test]
    fn a_home_with_no_store_is_not_a_swap_in_progress() {
        let credential = tempfile::tempdir().unwrap();
        assert_eq!(swap_state(credential.path()), SwapState::Settled);

        // A credential whose record was pruned can still be given a new one.
        let elsewhere = tempfile::tempdir().unwrap();
        swap_in(
            credential.path(),
            &staged(elsewhere.path(), "new material"),
            uid(),
        )
        .unwrap();
        assert_eq!(
            read(&credential.path().join(CREDENTIAL_FILE)),
            "new material"
        );
        assert!(!credential.path().join(ROLLBACK_FILE).exists());
    }

    #[test]
    fn a_second_swap_cannot_start_while_one_is_unaccepted() {
        let credential = home("old material");
        let elsewhere = tempfile::tempdir().unwrap();
        swap_in(
            credential.path(),
            &staged(elsewhere.path(), "new material"),
            uid(),
        )
        .unwrap();

        let error = swap_in(
            credential.path(),
            &staged(elsewhere.path(), "newer material"),
            uid(),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("waiting to be accepted"), "{error}");
        // And the first swap is untouched by the refusal.
        assert_eq!(read(&credential.path().join(ROLLBACK_FILE)), "old material");
    }

    #[test]
    fn a_staged_store_that_is_a_link_is_refused() {
        let credential = home("old material");
        let elsewhere = tempfile::tempdir().unwrap();
        let target = staged(elsewhere.path(), "somebody else's file");
        let link = elsewhere.path().join("link.json");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let error = swap_in(credential.path(), &link, uid())
            .unwrap_err()
            .to_string();
        assert!(error.contains("symlink"), "{error}");
        // Nothing moved.
        assert_eq!(
            read(&credential.path().join(CREDENTIAL_FILE)),
            "old material"
        );
        assert_eq!(swap_state(credential.path()), SwapState::Settled);
    }

    #[test]
    fn a_staged_store_readable_by_others_is_refused() {
        let credential = home("old material");
        let elsewhere = tempfile::tempdir().unwrap();
        let open = staged(elsewhere.path(), "new material");
        std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o644)).unwrap();

        let error = swap_in(credential.path(), &open, uid())
            .unwrap_err()
            .to_string();
        assert!(error.contains("open beyond its owner"), "{error}");
        assert_eq!(
            read(&credential.path().join(CREDENTIAL_FILE)),
            "old material"
        );
    }

    #[test]
    fn a_staging_home_is_private_and_does_not_outlive_its_attempt() {
        let node_home = tempfile::tempdir().unwrap();
        let path = {
            let staging = StagingHome::create(node_home.path(), uid()).unwrap();
            let mode = std::fs::metadata(staging.path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o700);
            assert_eq!(staging.store().file_name().unwrap(), CREDENTIAL_FILE);
            // Whatever a login leaves behind goes with it.
            std::fs::write(staging.store(), "material from a login").unwrap();
            staging.path().to_path_buf()
        };
        assert!(!path.exists(), "the staging home outlived the attempt");
    }

    #[test]
    fn two_attempts_never_share_a_staging_home() {
        let node_home = tempfile::tempdir().unwrap();
        let first = StagingHome::create(node_home.path(), uid()).unwrap();
        let second = StagingHome::create(node_home.path(), uid()).unwrap();
        assert_ne!(first.path(), second.path());
    }
}
