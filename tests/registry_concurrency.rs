//! The Node registry under concurrent use.
//!
//! Production lost a run to this. Two runs were created in the same second, the
//! registry answered `database is locked`, the control session ended, and the
//! command already dispatched into that session went with it — leaving a project
//! that could never start another run.
//!
//! The cause was not a short timeout. `admit_remote_command` began a *deferred*
//! transaction, read, and then needed to write; SQLite refuses that upgrade the
//! moment another connection has committed, in microseconds, without consulting
//! `busy_timeout` at all — waiting while holding a read snapshot could deadlock,
//! so it does not wait. `create_run` and `append_event` already took the write
//! lock up front. Two call sites did not.
//!
//! These tests hold the discipline: every registry transaction that writes takes
//! the write lock when it begins.

use std::sync::mpsc;
use std::sync::{Arc, Barrier};
use std::time::Duration;

use asterism_node::inventory::{ProfileState, RuntimeOwnership};
use asterism_node::registry::{JournalEvent, NewRun, Registry};
use asterism_node::remote::{CommandAdmission, CommandState};
use serde_json::json;

/// Long enough that an instant refusal cannot hide inside it, short enough to
/// keep the suite quick. The failure being excluded takes ~11µs; a correct wait
/// takes as long as the other writer holds the lock.
const OBSERVATION_WINDOW: Duration = Duration::from_millis(300);

fn new_run(project: &str) -> NewRun {
    NewRun {
        project_id: project.to_owned(),
        session_id: None,
        idempotency_key: None,
        runtime_kind: "hermes-loop".to_owned(),
        provider: None,
        model: None,
        request_payload: json!({"prompt": "concurrency"}),
        retry_of_run_id: None,
    }
}

/// Registers a project with its own workspace directory, the way provisioning
/// does. Each gets its own path: two projects sharing one is not a shape the
/// Node ever produces.
fn project(registry: &mut Registry, id: &str, root: &std::path::Path) {
    let workspace = root.join(id);
    std::fs::create_dir_all(&workspace).unwrap();
    registry
        .register_project(
            id,
            &workspace,
            None,
            None,
            None,
            RuntimeOwnership::ManagedContainer,
        )
        .unwrap();
}

/// The exact interleaving that took production down.
///
/// Another connection holds the write lock while an admission begins. The
/// property being asserted is that the admission *waits* rather than being
/// refused: with a deferred transaction it returns an error before this test
/// could even observe it, which is what makes the two behaviours distinguishable
/// without depending on timing to pass.
#[test]
fn an_admission_waits_for_a_concurrent_writer_instead_of_being_refused() {
    let dir = tempfile::tempdir().unwrap();
    let _seed = Registry::open(dir.path()).unwrap();

    // A plain connection to the same file, holding the write lock. Using
    // rusqlite directly keeps a test-only entry point out of the crate's API.
    let holder = rusqlite::Connection::open(Registry::path_for(dir.path())).unwrap();
    holder.busy_timeout(Duration::from_secs(10)).unwrap();
    holder.execute_batch("BEGIN IMMEDIATE").unwrap();

    let path = dir.path().to_owned();
    let (tx, rx) = mpsc::channel();
    let admitting = std::thread::spawn(move || {
        let mut registry = Registry::open(path).unwrap();
        let outcome = registry.admit_remote_command("c1", "runs.create", Some("p1"), "digest-1");
        tx.send(outcome.map(|_| ()).map_err(|error| format!("{error:#}")))
            .unwrap();
    });

    // The discriminator. A deferred transaction would have produced a result by
    // now — an error, immediately. An immediate one is still waiting for the
    // lock, so there is nothing to receive.
    match rx.recv_timeout(OBSERVATION_WINDOW) {
        Err(mpsc::RecvTimeoutError::Timeout) => {}
        Ok(Err(error)) => panic!("the admission was refused instead of waiting: {error}"),
        Ok(Ok(())) => panic!("the admission completed while the write lock was held"),
        Err(other) => panic!("admission thread died: {other}"),
    }

    holder.execute_batch("COMMIT").unwrap();
    admitting.join().unwrap();

    let outcome = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(
        outcome.is_ok(),
        "the admission failed after the lock was released: {outcome:?}"
    );
}

/// Two runs created at the same instant, which is what a person doing two things
/// at once produces.
#[test]
fn two_runs_created_at_the_same_instant_both_succeed() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    {
        let mut registry = Registry::open(dir.path()).unwrap();
        project(&mut registry, "alpha", workspace.path());
        project(&mut registry, "beta", workspace.path());
    }

    let barrier = Arc::new(Barrier::new(2));
    let mut handles = Vec::new();
    for (project_id, command_id) in [("alpha", "cmd-alpha"), ("beta", "cmd-beta")] {
        let path = dir.path().to_owned();
        let barrier = Arc::clone(&barrier);
        handles.push(std::thread::spawn(move || {
            let mut registry = Registry::open(path).unwrap();
            barrier.wait();
            registry
                .admit_remote_command(command_id, "runs.create", Some(project_id), "digest")
                .map_err(|error| format!("{error:#}"))?;
            registry
                .create_run(&new_run(project_id))
                .map_err(|error| format!("{error:#}"))?;
            registry
                .set_remote_command_state(command_id, CommandState::Executing)
                .map_err(|error| format!("{error:#}"))?;
            Ok::<(), String>(())
        }));
    }

    for handle in handles {
        handle.join().unwrap().expect("a concurrent run failed");
    }

    let registry = Registry::open(dir.path()).unwrap();
    for command_id in ["cmd-alpha", "cmd-beta"] {
        let record = registry.remote_command(command_id).unwrap().unwrap();
        assert_eq!(
            record.state, "executing",
            "{command_id} lost its transition"
        );
    }
}

/// Many writers and readers at once, which is the shape that made the original
/// failure intermittent rather than reproducible.
#[test]
fn concurrent_readers_and_writers_never_see_a_locked_database() {
    const WRITERS: usize = 6;
    const READERS: usize = 6;
    const ROUNDS: usize = 25;

    let dir = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    {
        let mut registry = Registry::open(dir.path()).unwrap();
        for writer in 0..WRITERS {
            project(&mut registry, &format!("p{writer}"), workspace.path());
        }
    }

    let barrier = Arc::new(Barrier::new(WRITERS + READERS));
    let mut handles = Vec::new();

    for writer in 0..WRITERS {
        let path = dir.path().to_owned();
        let barrier = Arc::clone(&barrier);
        handles.push(std::thread::spawn(move || {
            let mut registry = Registry::open(path).unwrap();
            barrier.wait();
            for round in 0..ROUNDS {
                let command_id = format!("c-{writer}-{round}");
                let project_id = format!("p{writer}");
                registry
                    .admit_remote_command(&command_id, "runs.create", Some(&project_id), "digest")
                    .map_err(|error| format!("admit: {error:#}"))?;
                let run_id = registry
                    .create_run(&new_run(&project_id))
                    .map_err(|error| format!("create: {error:#}"))?
                    .record()
                    .run_id
                    .clone();
                registry
                    .append_event(
                        &run_id,
                        &JournalEvent::asterism("test.event", json!({"round": round})),
                        None,
                    )
                    .map_err(|error| format!("append: {error:#}"))?;
                registry
                    .set_remote_command_state(&command_id, CommandState::Executing)
                    .map_err(|error| format!("state: {error:#}"))?;
            }
            Ok::<(), String>(())
        }));
    }

    for _ in 0..READERS {
        let path = dir.path().to_owned();
        let barrier = Arc::clone(&barrier);
        handles.push(std::thread::spawn(move || {
            let registry = Registry::open(path).unwrap();
            barrier.wait();
            for _ in 0..ROUNDS {
                registry
                    .list_projects()
                    .map_err(|error| format!("list: {error:#}"))?;
                registry
                    .outbox_depth()
                    .map_err(|error| format!("outbox: {error:#}"))?;
            }
            Ok::<(), String>(())
        }));
    }

    for handle in handles {
        handle.join().unwrap().expect("concurrent registry access");
    }

    // No lost update: every command exists exactly once, in its final state.
    let registry = Registry::open(dir.path()).unwrap();
    for writer in 0..WRITERS {
        for round in 0..ROUNDS {
            let record = registry
                .remote_command(&format!("c-{writer}-{round}"))
                .unwrap()
                .expect("a command was lost");
            assert_eq!(record.state, "executing");
        }
    }
}

/// One project's writes must not be able to disturb another's rows.
#[test]
fn concurrent_projects_keep_their_own_bindings() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    {
        let mut registry = Registry::open(dir.path()).unwrap();
        project(&mut registry, "alpha", workspace.path());
        project(&mut registry, "beta", workspace.path());
        registry
            .bind_existing_profile(
                "alpha",
                "/var/lib/asterism/hermes-projects/alpha",
                "asterism-project-alpha",
                "http://127.0.0.1:18700",
                "/var/lib/asterism/hermes-projects/alpha/runtime.env",
            )
            .unwrap();
        registry
            .bind_existing_profile(
                "beta",
                "/var/lib/asterism/hermes-projects/beta",
                "asterism-project-beta",
                "http://127.0.0.1:18701",
                "/var/lib/asterism/hermes-projects/beta/runtime.env",
            )
            .unwrap();
    }

    let barrier = Arc::new(Barrier::new(2));
    let mut handles = Vec::new();
    for (project_id, state) in [
        ("alpha", ProfileState::Ready),
        ("beta", ProfileState::Failed),
    ] {
        let path = dir.path().to_owned();
        let barrier = Arc::clone(&barrier);
        handles.push(std::thread::spawn(move || {
            let mut registry = Registry::open(path).unwrap();
            barrier.wait();
            for _ in 0..20 {
                registry.set_profile_state(project_id, state, None).unwrap();
                registry.project(project_id).unwrap();
            }
        }));
    }
    for handle in handles {
        handle.join().unwrap();
    }

    let registry = Registry::open(dir.path()).unwrap();
    let alpha = registry.project("alpha").unwrap().unwrap();
    let beta = registry.project("beta").unwrap().unwrap();

    assert_eq!(alpha.profile_state, ProfileState::Ready);
    assert_eq!(beta.profile_state, ProfileState::Failed);
    // The binding each project was given is still its own.
    assert_eq!(
        alpha.runtime_endpoint.as_deref(),
        Some("http://127.0.0.1:18700")
    );
    assert_eq!(
        beta.runtime_endpoint.as_deref(),
        Some("http://127.0.0.1:18701")
    );
    assert_eq!(
        alpha.hermes_api_key_ref.as_deref(),
        Some("/var/lib/asterism/hermes-projects/alpha/runtime.env")
    );
    assert_eq!(
        beta.hermes_api_key_ref.as_deref(),
        Some("/var/lib/asterism/hermes-projects/beta/runtime.env")
    );
}

/// Provisioning moves a project's state while unrelated runs are being recorded.
#[test]
fn provisioning_transitions_survive_unrelated_run_activity() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    {
        let mut registry = Registry::open(dir.path()).unwrap();
        project(&mut registry, "provisioning", workspace.path());
        project(&mut registry, "busy", workspace.path());
    }

    let barrier = Arc::new(Barrier::new(2));

    let path = dir.path().to_owned();
    let provisioning_barrier = Arc::clone(&barrier);
    let provisioning = std::thread::spawn(move || {
        let mut registry = Registry::open(path).unwrap();
        provisioning_barrier.wait();
        for state in [
            ProfileState::Provisioning,
            ProfileState::Ready,
            ProfileState::Provisioning,
            ProfileState::Ready,
        ] {
            registry
                .set_profile_state("provisioning", state, None)
                .map_err(|error| format!("{error:#}"))?;
        }
        Ok::<(), String>(())
    });

    let path = dir.path().to_owned();
    let runs = std::thread::spawn(move || {
        let mut registry = Registry::open(path).unwrap();
        barrier.wait();
        for _ in 0..30 {
            let run_id = registry
                .create_run(&new_run("busy"))
                .map_err(|error| format!("{error:#}"))?
                .record()
                .run_id
                .clone();
            registry
                .append_event(
                    &run_id,
                    &JournalEvent::asterism("test.event", json!({})),
                    None,
                )
                .map_err(|error| format!("{error:#}"))?;
        }
        Ok::<(), String>(())
    });

    provisioning.join().unwrap().expect("provisioning");
    runs.join().unwrap().expect("run activity");

    let registry = Registry::open(dir.path()).unwrap();
    assert_eq!(
        registry
            .project("provisioning")
            .unwrap()
            .unwrap()
            .profile_state,
        ProfileState::Ready
    );
}

/// Reconciliation reads the whole inventory while writes are happening.
#[test]
fn reconciliation_reads_while_the_registry_is_being_written() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    {
        let mut registry = Registry::open(dir.path()).unwrap();
        for index in 0..5 {
            project(&mut registry, &format!("p{index}"), workspace.path());
        }
    }

    let barrier = Arc::new(Barrier::new(2));

    let path = dir.path().to_owned();
    let writer_barrier = Arc::clone(&barrier);
    let writer = std::thread::spawn(move || {
        let mut registry = Registry::open(path).unwrap();
        writer_barrier.wait();
        for round in 0..40 {
            registry
                .set_profile_state(&format!("p{}", round % 5), ProfileState::Ready, None)
                .map_err(|error| format!("{error:#}"))?;
        }
        Ok::<(), String>(())
    });

    let path = dir.path().to_owned();
    let reader = std::thread::spawn(move || {
        let registry = Registry::open(path).unwrap();
        barrier.wait();
        for _ in 0..40 {
            let projects = registry
                .list_projects()
                .map_err(|error| format!("{error:#}"))?;
            // Reads stay correct while writes are in flight: the set of projects
            // never shrinks or duplicates under a concurrent writer.
            assert_eq!(projects.len(), 5);
        }
        Ok::<(), String>(())
    });

    writer.join().unwrap().expect("writer");
    reader.join().unwrap().expect("reader");
}

/// A command must not move to a terminal state twice, whichever writer gets
/// there first.
#[test]
fn a_command_transition_is_not_applied_twice() {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut registry = Registry::open(dir.path()).unwrap();
        registry
            .admit_remote_command("shared", "runs.create", None, "digest")
            .unwrap();
    }

    let barrier = Arc::new(Barrier::new(4));
    let mut handles = Vec::new();
    for _ in 0..4 {
        let path = dir.path().to_owned();
        let barrier = Arc::clone(&barrier);
        handles.push(std::thread::spawn(move || {
            let mut registry = Registry::open(path).unwrap();
            barrier.wait();
            registry
                .admit_remote_command("shared", "runs.create", None, "digest")
                .map_err(|error| format!("{error:#}"))
        }));
    }

    let mut fresh = 0;
    let mut duplicate = 0;
    for handle in handles {
        match handle.join().unwrap().expect("admission") {
            CommandAdmission::Fresh(_) => fresh += 1,
            CommandAdmission::Duplicate(_) => duplicate += 1,
            other => panic!("unexpected admission: {other:?}"),
        }
    }
    // It was already admitted before the race, so every racer must see a
    // duplicate. One of them recording a second `Fresh` would mean a command
    // executed twice.
    assert_eq!(fresh, 0, "a command was admitted twice");
    assert_eq!(duplicate, 4);
}

/// An existing schema 7 database opens and keeps everything in it.
#[test]
fn an_existing_registry_opens_without_losing_anything() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    {
        let mut registry = Registry::open(dir.path()).unwrap();
        project(&mut registry, "kept", workspace.path());
        registry
            .bind_existing_profile(
                "kept",
                "/var/lib/asterism/hermes-projects/kept",
                "asterism-project-kept",
                "http://127.0.0.1:18700",
                "/var/lib/asterism/hermes-projects/kept/runtime.env",
            )
            .unwrap();
        let kept_run = registry
            .create_run(&new_run("kept"))
            .unwrap()
            .record()
            .run_id
            .clone();
        std::fs::write(dir.path().join("run-id"), &kept_run).unwrap();
        registry
            .admit_remote_command("cmd-kept", "runs.create", Some("kept"), "digest")
            .unwrap();
    }

    let registry = Registry::open(dir.path()).unwrap();
    let kept = registry.project("kept").unwrap().unwrap();
    assert_eq!(
        kept.runtime_endpoint.as_deref(),
        Some("http://127.0.0.1:18700")
    );
    assert_eq!(
        kept.hermes_api_key_ref.as_deref(),
        Some("/var/lib/asterism/hermes-projects/kept/runtime.env")
    );
    assert_eq!(
        kept.hermes_profile.as_deref(),
        Some("asterism-project-kept")
    );
    let kept_run = std::fs::read_to_string(dir.path().join("run-id")).unwrap();
    assert!(registry.run(&kept_run).unwrap().is_some());
    assert!(registry.remote_command("cmd-kept").unwrap().is_some());
}
