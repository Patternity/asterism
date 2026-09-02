//! One provider credential per host, reached by every worker.
//!
//! The defect these cover was not subtle once seen: the legacy runtime had a
//! `CODEX_HOME` and project workers had none, so they resolved to a directory
//! nothing ever created. Authorizing a host therefore did not authorize its
//! projects — on any host, ever — and a Node could be online, healthy, and
//! unable to execute a single model run.
//!
//! Two properties matter more than the mechanism, and both are asserted here
//! rather than described: authorizing once must be enough, whenever a project
//! was created; and a refreshed token must be seen by workers that already
//! exist, without anything being copied into them.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use asterism_node::hostsetup::HostPaths;
use asterism_node::nodesetup::{self, HostCredential};
use asterism_node::profiles::{
    CredentialLink, CredentialPaths, ProfileLayout, link_to_host_credential, reconcile_credentials,
};

/// The three paths a host keeps, under a temporary root.
fn paths(root: &Path) -> CredentialPaths {
    CredentialPaths {
        home_root: root.join("var/lib/asterism/hermes-projects"),
        shared_auth: root.join("var/lib/asterism/hermes/auth.json"),
        codex_auth: root.join("var/lib/asterism/codex/auth.json"),
    }
}

/// A profile home as provisioning leaves it, minus the credential references.
fn existing_home(paths: &CredentialPaths, profile: &str) -> PathBuf {
    let home = paths.home_root.join(profile);
    for directory in ["sessions", "memories", "logs"] {
        std::fs::create_dir_all(home.join(directory)).unwrap();
    }
    std::fs::write(
        home.join("config.yaml"),
        "model:\n  provider: openai-codex\n",
    )
    .unwrap();
    home
}

fn authorize(paths: &CredentialPaths, contents: &[u8]) {
    std::fs::create_dir_all(paths.codex_auth.parent().unwrap()).unwrap();
    std::fs::write(&paths.codex_auth, contents).unwrap();
    std::fs::set_permissions(&paths.codex_auth, std::fs::Permissions::from_mode(0o600)).unwrap();
}

/// What the Codex CLI would read for this profile: the file its `CODEX_HOME`
/// resolves to, followed through whatever references stand in the way.
fn what_the_worker_reads(paths: &CredentialPaths, profile: &str) -> Option<Vec<u8>> {
    let layout = ProfileLayout {
        home: paths.home_root.join(profile),
        profile: profile.to_owned(),
    };
    std::fs::read(layout.codex_auth()).ok()
}

#[test]
fn a_project_created_before_authorization_works_once_the_host_is_authorized() {
    let root = tempfile::tempdir().unwrap();
    let paths = paths(root.path());
    existing_home(&paths, "project-early");

    // Provisioned against a host nobody has authorized yet.
    reconcile_credentials(&paths, "project-early").unwrap();
    assert!(
        what_the_worker_reads(&paths, "project-early").is_none(),
        "there is nothing to read yet, and that is correct"
    );

    // The person authorizes the host. Nothing touches the project.
    authorize(&paths, b"host-credential-v1");

    assert_eq!(
        what_the_worker_reads(&paths, "project-early").as_deref(),
        Some(b"host-credential-v1".as_slice()),
        "a project created first must start working when the host is authorized, \
         without being reprovisioned"
    );
}

#[test]
fn a_project_created_after_authorization_uses_the_same_credential_immediately() {
    let root = tempfile::tempdir().unwrap();
    let paths = paths(root.path());
    authorize(&paths, b"host-credential-v1");

    existing_home(&paths, "project-late");
    reconcile_credentials(&paths, "project-late").unwrap();

    assert_eq!(
        what_the_worker_reads(&paths, "project-late").as_deref(),
        Some(b"host-credential-v1".as_slice())
    );
}

#[test]
fn a_refreshed_token_is_seen_by_workers_that_already_exist() {
    let root = tempfile::tempdir().unwrap();
    let paths = paths(root.path());
    authorize(&paths, b"host-credential-v1");
    for profile in ["project-one", "project-two"] {
        existing_home(&paths, profile);
        reconcile_credentials(&paths, profile).unwrap();
    }

    // The provider refreshes the token in place, which is what the pinned CLI
    // does: it writes through the reference rather than replacing the file.
    authorize(&paths, b"host-credential-v2-refreshed");

    for profile in ["project-one", "project-two"] {
        assert_eq!(
            what_the_worker_reads(&paths, profile).as_deref(),
            Some(b"host-credential-v2-refreshed".as_slice()),
            "{profile} kept reading a token the host had already replaced"
        );
    }
}

#[test]
fn two_projects_share_the_credential_and_nothing_else() {
    let root = tempfile::tempdir().unwrap();
    let paths = paths(root.path());
    authorize(&paths, b"host-credential-v1");
    for profile in ["project-one", "project-two"] {
        existing_home(&paths, profile);
        reconcile_credentials(&paths, profile).unwrap();
    }

    // Each worker's Codex home is its own directory: the CLI writes a log there,
    // and one project's log is not another project's business.
    let one = paths.home_root.join("project-one/.codex");
    let two = paths.home_root.join("project-two/.codex");
    assert_ne!(one, two);
    std::fs::write(one.join("log"), "one").unwrap();
    assert!(
        !two.join("log").exists(),
        "a per-worker file crossed projects"
    );

    // Sessions and memories were never in scope and must stay separate.
    std::fs::write(paths.home_root.join("project-one/sessions/a"), "one").unwrap();
    assert!(!paths.home_root.join("project-two/sessions/a").exists());

    for home in [&one, &two] {
        assert_eq!(
            std::fs::metadata(home).unwrap().permissions().mode() & 0o777,
            0o700,
            "a Codex home was left open to other accounts"
        );
    }
}

#[test]
fn reconciliation_is_idempotent_and_repairs_a_reference_that_points_elsewhere() {
    let root = tempfile::tempdir().unwrap();
    let paths = paths(root.path());
    authorize(&paths, b"host-credential-v1");
    existing_home(&paths, "project-one");

    let first = reconcile_credentials(&paths, "project-one").unwrap();
    assert!(
        first
            .iter()
            .any(|(_, outcome)| *outcome == CredentialLink::Created)
    );

    let again = reconcile_credentials(&paths, "project-one").unwrap();
    assert!(
        again
            .iter()
            .all(|(_, outcome)| *outcome == CredentialLink::AlreadyCorrect),
        "a second run should find nothing to do: {again:?}"
    );

    // Something repointed it at a credential of its own.
    let elsewhere = root.path().join("somewhere-else.json");
    std::fs::write(&elsewhere, b"not-the-host-credential").unwrap();
    let link = paths.home_root.join("project-one/.codex/auth.json");
    std::fs::remove_file(&link).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &link).unwrap();

    let repaired = reconcile_credentials(&paths, "project-one").unwrap();
    assert!(
        repaired
            .iter()
            .any(|(_, outcome)| *outcome == CredentialLink::Repaired)
    );
    assert_eq!(
        what_the_worker_reads(&paths, "project-one").as_deref(),
        Some(b"host-credential-v1".as_slice())
    );
}

#[test]
fn a_real_credential_file_in_a_project_is_never_destroyed() {
    let root = tempfile::tempdir().unwrap();
    let paths = paths(root.path());
    authorize(&paths, b"host-credential-v1");
    let home = existing_home(&paths, "project-one");
    std::fs::create_dir_all(home.join(".codex")).unwrap();
    std::fs::write(home.join(".codex/auth.json"), b"someone-put-this-here").unwrap();

    let outcome = reconcile_credentials(&paths, "project-one").unwrap();
    assert!(
        outcome
            .iter()
            .any(|(kind, result)| *kind == "codex" && *result == CredentialLink::KeptExistingFile)
    );
    assert_eq!(
        std::fs::read(home.join(".codex/auth.json")).unwrap(),
        b"someone-put-this-here",
        "reconciliation destroyed a credential it did not put there"
    );
}

#[test]
fn a_reference_is_refused_when_the_host_path_is_not_one() {
    let root = tempfile::tempdir().unwrap();
    let link = root.path().join("auth.json");

    for bad in ["relative/auth.json", "/var/lib/asterism/../../etc/shadow"] {
        let error = link_to_host_credential(Path::new(bad), &link)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("absolute") || error.contains("climb"),
            "{bad} was accepted: {error}"
        );
    }
    assert!(!link.exists(), "a refused reference was created anyway");
}

#[test]
fn an_existing_authorization_is_adopted_rather_than_asked_for_again() {
    let root = tempfile::tempdir().unwrap();
    let host = HostPaths::with_prefix(root.path());
    // A host authorized by an older installer: the credential is in the legacy
    // runtime's Codex home, which is the only place that ever had one.
    std::fs::create_dir_all(host.legacy_codex_home()).unwrap();
    std::fs::write(host.legacy_codex_auth(), b"authorized-months-ago").unwrap();

    let outcome = nodesetup::establish_host_credential(&host).unwrap();
    assert_eq!(outcome, HostCredential::Adopted);
    assert_eq!(
        std::fs::read(host.codex_auth()).unwrap(),
        b"authorized-months-ago",
        "an authorization a person already approved was lost"
    );
    // And the old name now reaches the new one, so the legacy runtime and every
    // worker read the same file.
    assert_eq!(
        std::fs::read(host.legacy_codex_auth()).unwrap(),
        b"authorized-months-ago"
    );
}

#[test]
fn establishing_the_credential_twice_changes_nothing() {
    let root = tempfile::tempdir().unwrap();
    let host = HostPaths::with_prefix(root.path());
    std::fs::create_dir_all(host.legacy_codex_home()).unwrap();
    std::fs::write(host.legacy_codex_auth(), b"authorized-months-ago").unwrap();

    assert_eq!(
        nodesetup::establish_host_credential(&host).unwrap(),
        HostCredential::Adopted
    );
    assert_eq!(
        nodesetup::establish_host_credential(&host).unwrap(),
        HostCredential::AlreadyCanonical,
        "a second install or repair must not move the credential again"
    );
    assert_eq!(
        std::fs::read(host.codex_auth()).unwrap(),
        b"authorized-months-ago"
    );
}

#[test]
fn an_unauthorized_host_is_prepared_rather_than_left_without_a_place() {
    let root = tempfile::tempdir().unwrap();
    let host = HostPaths::with_prefix(root.path());

    assert_eq!(
        nodesetup::establish_host_credential(&host).unwrap(),
        HostCredential::NotYetAuthorized
    );
    assert!(host.codex_root().is_dir());
    assert_eq!(
        std::fs::metadata(host.codex_root())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    // The legacy runtime already points at where the credential will go, so one
    // authorization later is enough for it too.
    assert_eq!(
        std::fs::read_link(host.legacy_codex_auth()).unwrap(),
        host.codex_auth()
    );
}
