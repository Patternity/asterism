//! Installing a Node, as one operation a person can watch.
//!
//! The shape of this file is the product flow: a person adds a Node in the
//! Control Plane, is given one command, and watches the stages go by. Every step
//! below reports where it is before it starts and says what went wrong in a code
//! the console can act on, because an installation nobody can see is
//! indistinguishable from one that has hung.
//!
//! No project is mentioned anywhere here. A fresh Node is capacity: an identity,
//! a runtime and nothing running on it.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use anyhow::{Context, Result};
use futures_util::StreamExt;

use crate::bundle;
use crate::hostsetup::HostPaths;
use crate::installreport::{FailureCode, Reporter, Stage};
use crate::nodesetup::{self, SERVICE_ACCOUNT, Settings};

/// What an installation needs to know. The code is a credential and is never
/// logged, printed or written to disk.
pub struct Request {
    pub control_plane: String,
    pub code: String,
    pub version: String,
    pub release_base: String,
    pub paths: HostPaths,
    pub generation: u32,
    pub allow_plaintext_loopback: bool,
    /// Set when the host's prerequisites are known to be present already, which
    /// is what makes `repair` cheap and what lets the tests run unprivileged.
    pub skip_prerequisites: bool,
}

/// A failure a person is shown and the console can act on.
#[derive(Debug)]
pub struct Failure {
    pub code: FailureCode,
    pub error: anyhow::Error,
}

impl Failure {
    fn new(code: FailureCode, error: impl Into<anyhow::Error>) -> Self {
        Self {
            code,
            error: error.into(),
        }
    }
}

/// What the installer needs the host to be before it starts changing it.
///
/// Refusing here is much cheaper than refusing halfway: an unsupported
/// architecture is discovered before a 0.55 GB download rather than after it.
pub fn preflight(paths: &HostPaths, free_bytes: u64) -> Result<(), Failure> {
    if bundle::host_platform() == "unsupported" {
        return Err(Failure::new(
            FailureCode::UnsupportedArchitecture,
            anyhow::anyhow!("Asterism has no runtime for this processor architecture"),
        ));
    }
    if !paths.systemd_dir().is_dir() {
        return Err(Failure::new(
            FailureCode::UnsupportedOs,
            anyhow::anyhow!("this host has no systemd, which the Node is supervised by"),
        ));
    }
    if free_bytes < REQUIRED_FREE_BYTES {
        return Err(Failure::new(
            FailureCode::InsufficientDisk,
            anyhow::anyhow!(
                "{} GB free is not enough; the runtime needs {} GB",
                free_bytes / 1_000_000_000,
                REQUIRED_FREE_BYTES / 1_000_000_000
            ),
        ));
    }
    Ok(())
}

/// The installed runtime is 1.9 GB and the archive is 0.55 GB, both present at
/// once while it unpacks, plus room for the host to keep working.
const REQUIRED_FREE_BYTES: u64 = 5_000_000_000;

/// Where the download and the unpacked tree are staged.
///
/// Deliberately not `/tmp`. On a small VPS `/tmp` is frequently a tmpfs, and
/// staging half a gigabyte there spends the machine's memory rather than its
/// disk. Staging beside the runtime also means the free-space check and the
/// final rename happen on the filesystem that actually receives the install,
/// so neither can be right about the wrong device.
pub struct Staging {
    path: PathBuf,
}

impl Staging {
    pub fn beside_the_runtime(paths: &HostPaths) -> Result<Self> {
        let parent = paths
            .opt_dir()
            .parent()
            .context("the runtime root has no parent directory")?
            .to_path_buf();
        std::fs::create_dir_all(&parent)?;
        let path = parent.join(format!(".asterism-install.{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path)?;
        // The archive is not secret, but nothing else needs to read it while it
        // is being verified either.
        std::fs::set_permissions(
            &path,
            <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o700),
        )?;
        Ok(Self { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        // An interrupted install must not leave half a gigabyte behind.
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// Free bytes on the filesystem holding a path.
///
/// Called with the runtime root's parent, because that is the filesystem both
/// the download and the installed tree occupy.
pub fn free_bytes(path: &Path) -> u64 {
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()) else {
        return 0;
    };
    if unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) } != 0 {
        return 0;
    }
    stat.f_bavail as u64 * stat.f_frsize as u64
}

/// Install a Node onto this host.
///
/// Each stage is reported before it is attempted, so a stage that never
/// completes is visible as the stage it stopped in rather than as silence.
pub async fn install(request: &Request, reporter: &Reporter) -> Result<Outcome, Failure> {
    reporter.stage(Stage::BundleMetadataFetched).await;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60 * 30))
        .build()
        .map_err(|error| Failure::new(FailureCode::InternalError, error))?;

    let staging = Staging::beside_the_runtime(&request.paths)
        .map_err(|error| Failure::new(FailureCode::InternalError, error))?;
    let manifest = fetch_manifest(&client, request, staging.path()).await?;

    // Refused before the download rather than after it: a bundle for another
    // platform or a schema this build cannot read costs nothing to reject here.
    manifest.accept(bundle::host_platform()).map_err(|error| {
        let code = if error.to_string().contains("schema") {
            FailureCode::UnsupportedBundleSchema
        } else {
            FailureCode::UnsupportedArchitecture
        };
        Failure::new(code, error)
    })?;

    download_bundle(&client, request, &manifest, staging.path(), reporter).await?;

    reporter.stage(Stage::BundleVerified).await;
    let verified = bundle::verify(staging.path(), bundle::host_platform())
        .map_err(|error| Failure::new(FailureCode::DigestMismatch, error))?;

    reporter.stage(Stage::PlanPrepared).await;

    if !request.skip_prerequisites {
        reporter.stage(Stage::PrerequisitesInstalling).await;
        ensure_account_and_docker()
            .map_err(|error| Failure::new(FailureCode::PrerequisitesFailed, error))?;
    }

    reporter.stage(Stage::RuntimeInstalling).await;
    install_runtime(&verified, &request.paths)
        .map_err(|error| Failure::new(FailureCode::RuntimeInstallFailed, error))?;

    reporter.stage(Stage::ConfigurationWriting).await;
    let settings = Settings {
        hermes_port: pick_hermes_port(&request.paths),
        control_plane: request.control_plane.clone(),
    };
    write_configuration(&request.paths, &settings, &verified.manifest)
        .map_err(|error| Failure::new(FailureCode::RuntimeInstallFailed, error))?;

    Ok(Outcome {
        settings,
        revision: verified.manifest.source_revision.clone(),
        version: verified.manifest.version.clone(),
    })
}

pub struct Outcome {
    pub settings: Settings,
    pub revision: String,
    pub version: String,
}

async fn fetch_manifest(
    client: &reqwest::Client,
    request: &Request,
    into: &Path,
) -> Result<bundle::Manifest, Failure> {
    let base = format!(
        "{}/{}",
        request.release_base.trim_end_matches('/'),
        request.version
    );
    for name in ["manifest.json", "SHA256SUMS"] {
        let body = client
            .get(format!("{base}/{name}"))
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|error| Failure::new(FailureCode::DownloadFailed, error))?
            .bytes()
            .await
            .map_err(|error| Failure::new(FailureCode::DownloadFailed, error))?;
        std::fs::write(into.join(name), &body)
            .map_err(|error| Failure::new(FailureCode::InternalError, error))?;
    }
    let text = std::fs::read_to_string(into.join("manifest.json"))
        .map_err(|error| Failure::new(FailureCode::InternalError, error))?;
    bundle::Manifest::parse(&text)
        .map_err(|error| Failure::new(FailureCode::UnsupportedBundleSchema, error))
}

/// Stream the archive to disk, reporting bytes as they arrive.
///
/// Written straight to its final name in the staging directory because that
/// directory is discarded whole: an interrupted download leaves nothing behind
/// and is never mistaken for a complete one, since the digest is checked before
/// anything is extracted.
async fn download_bundle(
    client: &reqwest::Client,
    request: &Request,
    manifest: &bundle::Manifest,
    into: &Path,
    reporter: &Reporter,
) -> Result<(), Failure> {
    let url = format!(
        "{}/{}/{}",
        request.release_base.trim_end_matches('/'),
        request.version,
        manifest.archive.name
    );
    let response = client
        .get(&url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| Failure::new(FailureCode::DownloadFailed, error))?;

    let total = response
        .content_length()
        .or(Some(manifest.archive.size_bytes));
    let destination = into.join(&manifest.archive.name);
    let mut file = std::fs::File::create(&destination)
        .map_err(|error| Failure::new(FailureCode::InternalError, error))?;
    let mut stream = response.bytes_stream();
    let mut done: u64 = 0;

    reporter.download(0, total, false).await;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| Failure::new(FailureCode::DownloadFailed, error))?;
        std::io::Write::write_all(&mut file, &chunk)
            .map_err(|error| Failure::new(FailureCode::InternalError, error))?;
        done += chunk.len() as u64;
        reporter.download(done, total, false).await;
    }
    std::io::Write::flush(&mut file)
        .map_err(|error| Failure::new(FailureCode::InternalError, error))?;
    reporter.download(done, total, true).await;
    Ok(())
}

/// Replace `/opt/asterism` with the bundle's tree.
///
/// The new tree is unpacked beside the old one and swapped, so a failure part
/// way through leaves the previous runtime in place rather than a half-replaced
/// one that starts and then misbehaves.
fn install_runtime(verified: &bundle::VerifiedBundle, paths: &HostPaths) -> Result<()> {
    let opt = paths.opt_dir();
    let parent = opt
        .parent()
        .context("the runtime root has no parent directory")?;
    std::fs::create_dir_all(parent)?;

    let incoming = parent.join(".asterism-incoming");
    let _ = std::fs::remove_dir_all(&incoming);
    std::fs::create_dir_all(&incoming)?;
    bundle::unpack(verified, &incoming)?;

    let retired = parent.join(".asterism-previous");
    let _ = std::fs::remove_dir_all(&retired);
    if opt.exists() {
        std::fs::rename(&opt, &retired)?;
    }
    match std::fs::rename(incoming.join("asterism"), &opt) {
        Ok(()) => {
            let _ = std::fs::remove_dir_all(&incoming);
            let _ = std::fs::remove_dir_all(&retired);
            Ok(())
        }
        Err(error) => {
            // Put back what was working before reporting the failure.
            if retired.exists() && !opt.exists() {
                let _ = std::fs::rename(&retired, &opt);
            }
            Err(error).context("cannot put the new runtime in place")
        }
    }
}

fn write_configuration(
    paths: &HostPaths,
    settings: &Settings,
    manifest: &bundle::Manifest,
) -> Result<()> {
    for (path, mode) in [
        (paths.etc_dir(), 0o750),
        (paths.state_root(), 0o750),
        (paths.node_home(), 0o700),
        (paths.hermes_home(), 0o700),
        (paths.project_root(), 0o700),
        (paths.hermes_project_home_root(), 0o700),
        (paths.workspace(), 0o755),
    ] {
        nodesetup::ensure_directory(&path, mode)?;
    }

    nodesetup::write_env_file(paths, settings)?;

    // The journal mode the bundle was built with, not one guessed here: the
    // bundle records what its own SQLite supports and Hermes must be configured
    // to match, or it silently falls back and loses write concurrency.
    let journal_mode = manifest
        .components
        .get("sqlite_journal_mode")
        .map(String::as_str)
        .unwrap_or("wal");
    if !paths.hermes_config().exists() {
        nodesetup::write_file(
            &paths.hermes_config(),
            &nodesetup::hermes_config(paths, settings, journal_mode),
            0o600,
        )?;
    }

    nodesetup::write_file(
        &paths.hermes_unit(),
        &nodesetup::hermes_unit(paths, settings),
        0o644,
    )?;
    nodesetup::write_file(&paths.node_unit(), &nodesetup::node_unit(paths), 0o644)?;
    nodesetup::write_file(
        &paths.worker_template(),
        &nodesetup::worker_template(paths),
        0o644,
    )?;
    nodesetup::write_file(&paths.sudoers_policy(), &nodesetup::worker_sudoers(), 0o440)?;
    Ok(())
}

/// The first free loopback port in the range the units expect.
///
/// An existing choice is kept: changing the port of a Hermes that is already
/// running would leave the Node dialling nothing.
fn pick_hermes_port(paths: &HostPaths) -> u16 {
    if let Ok(existing) = std::fs::read_to_string(paths.env_file())
        && let Some(port) = existing
            .lines()
            .find_map(|line| line.strip_prefix("ASTERISM_HERMES_PORT="))
            .and_then(|value| value.trim().parse::<u16>().ok())
    {
        return port;
    }
    (18642..=18700)
        .find(|port| std::net::TcpListener::bind(("127.0.0.1", *port)).is_ok())
        .unwrap_or(18642)
}

/// The account and the container runtime, both of which a clean host lacks.
fn ensure_account_and_docker() -> Result<()> {
    if !account_exists(SERVICE_ACCOUNT) {
        run(
            "useradd",
            &[
                "--system",
                "--user-group",
                "--create-home",
                "--home-dir",
                "/var/lib/asterism",
                "--shell",
                "/usr/sbin/nologin",
                SERVICE_ACCOUNT,
            ],
        )?;
    }

    // Hermes drives the project's own services and talks to the host daemon
    // directly: Docker-in-Docker would give the agent a second, invisible daemon
    // whose containers nothing on the host could see.
    if Command::new("docker")
        .arg("info")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
    {
        add_to_docker_group()?;
        return Ok(());
    }
    install_docker()?;
    add_to_docker_group()
}

fn account_exists(user: &str) -> bool {
    Command::new("id")
        .args(["-u", user])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn add_to_docker_group() -> Result<()> {
    // Failing to join is not fatal here: the unit declares SupplementaryGroups,
    // and the membership applies when the service starts.
    let _ = run("usermod", &["-aG", "docker", SERVICE_ACCOUNT]);
    Ok(())
}

fn install_docker() -> Result<()> {
    let distro = distribution_id().context("cannot identify this distribution")?;
    let codename = distribution_codename().context("cannot identify this distribution release")?;

    std::fs::create_dir_all("/etc/apt/keyrings")?;
    let key = format!("https://download.docker.com/linux/{distro}/gpg");
    run(
        "curl",
        &["-fsSL", &key, "-o", "/etc/apt/keyrings/docker.asc"],
    )?;
    std::fs::set_permissions(
        "/etc/apt/keyrings/docker.asc",
        <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o644),
    )?;
    std::fs::write(
        "/etc/apt/sources.list.d/docker.list",
        format!(
            "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] \
             https://download.docker.com/linux/{distro} {codename} stable\n"
        ),
    )?;
    run("apt-get", &["update", "-qq"])?;
    run(
        "apt-get",
        &[
            "install",
            "-y",
            "-qq",
            "docker-ce",
            "docker-ce-cli",
            "containerd.io",
            "docker-buildx-plugin",
            "docker-compose-plugin",
        ],
    )?;
    run("systemctl", &["enable", "--now", "docker"])?;
    Ok(())
}

fn os_release_field(field: &str) -> Option<String> {
    let text = std::fs::read_to_string("/etc/os-release").ok()?;
    text.lines()
        .find_map(|line| line.strip_prefix(&format!("{field}=")))
        .map(|value| value.trim_matches('"').to_string())
}

fn distribution_id() -> Option<String> {
    os_release_field("ID")
}

fn distribution_codename() -> Option<String> {
    os_release_field("VERSION_CODENAME")
}

/// Run a command, and say what it printed when it fails.
///
/// A step that fails with only an exit status is not diagnosable from a console
/// on another machine, which is where these failures are read.
fn run(program: &str, args: &[&str]) -> Result<()> {
    let output = Command::new(program)
        .args(args)
        .output()
        .with_context(|| format!("cannot run {program}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    anyhow::bail!(
        "{program} {} failed: {}",
        args.first().copied().unwrap_or_default(),
        stderr.trim()
    )
}

/// Enable and start what the Node needs, then wait for it to answer.
pub fn start_services(paths: &HostPaths) -> Result<()> {
    if !paths.prefix.as_os_str().is_empty() {
        // Under a prefix nothing real is being supervised, so starting units
        // would act on the host running the test.
        return Ok(());
    }
    run("systemctl", &["daemon-reload"])?;
    for unit in ["asterism-hermes.service", "asterism-node.service"] {
        run("systemctl", &["enable", "--now", unit])?;
    }
    Ok(())
}

/// Where the Node binary that is running should end up on the host.
pub fn install_self(paths: &HostPaths) -> Result<PathBuf> {
    let running = std::env::current_exe().context("cannot locate the running binary")?;
    let target = paths.node_binary();
    if running == target {
        return Ok(target);
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Copied to a neighbour and renamed: replacing a running binary in place
    // fails with ETXTBSY, and a partial copy would leave an unrunnable file
    // where a working one used to be.
    let staged = target.with_extension("incoming");
    std::fs::copy(&running, &staged)?;
    std::fs::set_permissions(
        &staged,
        <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o755),
    )?;
    std::fs::rename(&staged, &target)?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths_with_systemd() -> (tempfile::TempDir, HostPaths) {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("etc/systemd/system")).unwrap();
        let paths = HostPaths::with_prefix(root.path());
        (root, paths)
    }

    #[test]
    fn a_host_without_systemd_is_refused_before_anything_is_downloaded() {
        let root = tempfile::tempdir().unwrap();
        let paths = HostPaths::with_prefix(root.path());
        let failure = preflight(&paths, REQUIRED_FREE_BYTES).unwrap_err();
        assert_eq!(failure.code, FailureCode::UnsupportedOs);
    }

    #[test]
    fn a_host_without_room_is_refused_before_anything_is_downloaded() {
        let (_root, paths) = paths_with_systemd();
        let failure = preflight(&paths, 1_000_000_000).unwrap_err();
        assert_eq!(failure.code, FailureCode::InsufficientDisk);
        assert!(failure.error.to_string().contains("not enough"));
    }

    #[test]
    fn a_supported_host_passes_preflight() {
        let (_root, paths) = paths_with_systemd();
        preflight(&paths, REQUIRED_FREE_BYTES).unwrap();
    }

    #[test]
    fn configuration_writes_every_file_a_node_is_supervised_by() {
        let (_root, paths) = paths_with_systemd();
        let settings = Settings {
            hermes_port: 18642,
            control_plane: "https://example.invalid".into(),
        };
        let manifest = bundle::Manifest::parse(
            r#"{"schema":1,"product":"asterism-runtime","version":"v1","source_revision":"abc",
                "platform":"linux/amd64","archive":{"name":"a","sha256":"0","size_bytes":1},
                "installed_size_bytes":1}"#,
        )
        .unwrap();

        write_configuration(&paths, &settings, &manifest).unwrap();

        for path in [
            paths.env_file(),
            paths.hermes_unit(),
            paths.node_unit(),
            paths.worker_template(),
            paths.sudoers_policy(),
            paths.hermes_config(),
        ] {
            assert!(path.is_file(), "{} was not written", path.display());
        }
        for path in [paths.project_root(), paths.hermes_project_home_root()] {
            assert!(path.is_dir(), "{} was not created", path.display());
        }
    }

    #[test]
    fn an_existing_hermes_port_is_kept_rather_than_reassigned() {
        let (_root, paths) = paths_with_systemd();
        std::fs::create_dir_all(paths.etc_dir()).unwrap();
        std::fs::write(
            paths.env_file(),
            "ASTERISM_HERMES_API_KEY=x\nASTERISM_HERMES_PORT=18699\n",
        )
        .unwrap();
        assert_eq!(pick_hermes_port(&paths), 18699);
    }

    #[test]
    fn a_failed_swap_leaves_the_previous_runtime_in_place() {
        let (_root, paths) = paths_with_systemd();
        // A runtime is already installed.
        std::fs::create_dir_all(paths.opt_dir().join("hermes")).unwrap();
        std::fs::write(paths.opt_dir().join("hermes/marker"), "old").unwrap();

        // An archive whose only member is outside the runtime tree is refused by
        // `unpack`, which is a failure part-way through the replacement.
        let staging = tempfile::tempdir().unwrap();
        let verified = broken_bundle(staging.path());
        assert!(install_runtime(&verified, &paths).is_err());

        assert_eq!(
            std::fs::read_to_string(paths.opt_dir().join("hermes/marker")).unwrap(),
            "old",
            "the working runtime was lost to a failed replacement"
        );
    }

    /// A bundle whose archive `unpack` refuses, so the failure happens after the
    /// replacement has begun.
    fn broken_bundle(dir: &Path) -> bundle::VerifiedBundle {
        let archive = dir.join("broken.tar.gz");
        let file = std::fs::File::create(&archive).unwrap();
        let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::fast());
        let mut builder = tar::Builder::new(encoder);
        let body = b"nope";
        let mut header = tar::Header::new_gnu();
        header.set_size(body.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, "etc/passwd", &body[..])
            .unwrap();
        builder.into_inner().unwrap().finish().unwrap();

        bundle::VerifiedBundle {
            manifest: bundle::Manifest::parse(
                r#"{"schema":1,"product":"asterism-runtime","version":"v1","source_revision":"abc",
                    "platform":"linux/amd64","archive":{"name":"broken.tar.gz","sha256":"0","size_bytes":1},
                    "installed_size_bytes":1}"#,
            )
            .unwrap(),
            archive,
        }
    }
}
