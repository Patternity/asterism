//! What the workflows publish to a release, and whether any two of them collide.
//!
//! A GitHub release is one flat namespace. Two workflows uploading a file of the
//! same name do not merge: the second replaces the first, silently, and whichever
//! verification loses then reads a file describing an artifact it is not
//! verifying. That is exactly what happened with `SHA256SUMS` — the Node binary
//! release and the runtime bundle both published one — and it would not have been
//! visible until a real tag was cut.

use std::collections::BTreeMap;
use std::path::Path;

/// The file names one workflow uploads to a release.
///
/// Read out of the `files:` block of the release action rather than from a list
/// kept here, so a workflow that starts publishing something new is covered
/// without anyone remembering to update this.
fn published_by(workflow: &str) -> Vec<String> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(".github/workflows")
        .join(workflow);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));

    let mut names = Vec::new();
    let mut lines = text.lines().peekable();
    while let Some(line) = lines.next() {
        if line.trim() != "files: |" {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        for entry in lines.by_ref() {
            let trimmed = entry.trim();
            if trimmed.is_empty() {
                continue;
            }
            // The block ends at the first line no more indented than `files:`.
            if entry.len() - entry.trim_start().len() <= indent {
                break;
            }
            let name = trimmed.rsplit('/').next().unwrap_or(trimmed);
            names.push(name.to_string());
        }
    }
    names
}

/// Whether two published names can ever be the same file.
///
/// A glob is compared by its literal parts, so `asterism-runtime-*.tar.gz` and
/// `asterism-node-*.tar.gz` are known to be different while
/// `asterism-runtime-*.tar.gz` and `asterism-runtime-v1.tar.gz` are not.
fn can_collide(left: &str, right: &str) -> bool {
    match (left.split_once('*'), right.split_once('*')) {
        (None, None) => left == right,
        (Some((prefix, suffix)), None) => right.starts_with(prefix) && right.ends_with(suffix),
        (None, Some((prefix, suffix))) => left.starts_with(prefix) && left.ends_with(suffix),
        (Some((left_prefix, _)), Some((right_prefix, _))) => {
            left_prefix.starts_with(right_prefix) || right_prefix.starts_with(left_prefix)
        }
    }
}

#[test]
fn no_two_workflows_publish_the_same_release_file() {
    let workflows = ["release.yml", "runtime-bundle.yml"];
    let published: BTreeMap<&str, Vec<String>> = workflows
        .iter()
        .map(|workflow| (*workflow, published_by(workflow)))
        .collect();

    for (workflow, names) in &published {
        assert!(
            !names.is_empty(),
            "{workflow} publishes nothing, which means this test is reading it wrongly"
        );
    }

    for (index, left) in workflows.iter().enumerate() {
        for right in &workflows[index + 1..] {
            for one in &published[left] {
                for other in &published[right] {
                    assert!(
                        !can_collide(one, other),
                        "{left} publishes {one} and {right} publishes {other}; \
                         on one release the second upload replaces the first"
                    );
                }
            }
        }
    }
}

#[test]
fn the_bundle_checksums_and_the_binary_checksums_are_different_files() {
    // The specific collision that reached the repository, named so a future
    // change that recreates it fails with the reason rather than a generic one.
    let bundle = published_by("runtime-bundle.yml");
    assert!(
        bundle
            .iter()
            .any(|name| name == asterism_node::bundle::CHECKSUM_FILE),
        "the bundle workflow must publish {}, and publishes {bundle:?}",
        asterism_node::bundle::CHECKSUM_FILE
    );
    assert!(
        published_by("release.yml")
            .iter()
            .any(|name| name == "SHA256SUMS"),
        "the Node binary release must keep publishing SHA256SUMS, which the bootstrap reads"
    );
}

#[test]
fn a_glob_and_a_name_it_matches_are_treated_as_a_collision() {
    assert!(can_collide(
        "asterism-runtime-*.tar.gz",
        "asterism-runtime-v1.tar.gz"
    ));
    assert!(can_collide("SHA256SUMS", "SHA256SUMS"));
    assert!(!can_collide("SHA256SUMS", "SHA256SUMS.runtime"));
    assert!(!can_collide(
        "asterism-node-*.tar.gz",
        "asterism-runtime-*.tar.gz"
    ));
}
