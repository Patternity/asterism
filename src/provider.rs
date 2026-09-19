//! Authorizing this host's model provider credentials, on command from the
//! Control Plane.
//!
//! Credentials belong to the Node, not to a project. The first ones on a host
//! were entries in Hermes's shared pool, which every legacy project reads. Every
//! credential authorized now gets a home of its own, created before the login
//! starts and handed to Hermes as the whole of its world, so the secret is
//! written at its final location by the CLI itself -- never copied, never moved,
//! never read by this process. A project selects one by linking to it.
//!
//! Nothing here ever reads the credential. What travels to the Control Plane is
//! a device code and a link — a temporary secret, held in its memory only while
//! it is valid — and a typed state. The credential itself is written by the
//! Codex CLI, into a directory only this host's service account can read, and no
//! part of it is ever logged, returned or reported.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

/// How long the CLI gets to print a code before this gives up on it.
///
/// The device flow reaches OpenAI before it prints anything, so this is a
/// network timeout wearing a different hat. Short enough that a person watching
/// a spinner in a browser gets an answer, long enough to survive a slow link.
const CODE_TIMEOUT: Duration = Duration::from_secs(45);

/// What a code is worth if the CLI does not say. The observed CLI says fifteen
/// minutes; this is only reached if a future one stops saying so.
const DEFAULT_EXPIRY: Duration = Duration::from_secs(15 * 60);

/// Every state this Node can report, spelled exactly as the Control Plane and
/// the console spell them. These three lists are one protocol; `repo-hygiene.sh`
/// checks that they still agree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderState {
    /// No provider runtime on this host at all. Not a thing authorization fixes.
    Unavailable,
    /// Installed, connected, and holding no credential. Runs will be refused.
    Required,
    /// A code is out and someone is expected to approve it in a browser.
    Authorizing,
    /// This host holds a credential.
    Authorized,
    /// The last attempt did not finish. Starting again is safe.
    Failed,
}

impl ProviderState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unavailable => "unavailable",
            Self::Required => "required",
            Self::Authorizing => "authorizing",
            Self::Authorized => "authorized",
            Self::Failed => "failed",
        }
    }
}

/// What a browser is shown. Serialized in exactly the shape the Control Plane
/// reads: it refuses a result missing either half rather than showing a link
/// with no code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DeviceCode {
    pub verification_uri: String,
    pub user_code: String,
    pub expires_in_seconds: u64,
}

/// Where this host keeps the things involved.
#[derive(Debug, Clone)]
pub struct ProviderPaths {
    /// The host's Hermes home. Its `auth.json` is the credential every project
    /// on this host reads, through a symlink of its own.
    pub hermes_home: PathBuf,
    /// The Hermes launcher, which owns the pooled credential this authorizes.
    pub hermes_binary: PathBuf,
}

impl ProviderPaths {
    pub fn on_this_host() -> Self {
        Self {
            hermes_home: PathBuf::from("/var/lib/asterism/hermes"),
            hermes_binary: PathBuf::from("/opt/asterism/hermes/.venv/bin/hermes"),
        }
    }

    /// The one file a run needs.
    ///
    /// Not the Codex CLI's session under `CODEX_HOME`. Those are two different
    /// credentials, in two different formats, and only this one is read by the
    /// provider pool a `hermes-loop` run executes against. Authorizing the other
    /// leaves a host that reports itself authorized and fails every run with
    /// "No Codex credentials stored".
    fn credential(&self) -> PathBuf {
        self.hermes_home.join("auth.json")
    }

    /// Existence only. Opening it would put a credential in this process for no
    /// reason: whether the provider still accepts it is a question only a run
    /// can answer, and a run asks it anyway.
    fn holds_credential(&self) -> bool {
        self.credential().exists()
    }
}

/// The provider authorization for this host.
///
/// At most one at a time, and that is the point. Two concurrent logins race for
/// the same `auth.json`, and whoever approved second would silently invalidate
/// the other person's code while their browser still showed it as pending.
#[derive(Clone)]
pub struct Provider {
    paths: ProviderPaths,
    attempt: Arc<Mutex<Option<Attempt>>>,
    /// Where this Node keeps what it knows about its credentials.
    ///
    /// Metadata only. The secrets are Hermes's pool, which this never opens.
    registry: Arc<Mutex<crate::credentials::Registry>>,
    node_home: PathBuf,
    /// Where every isolated credential's home is. Fixed by this Node.
    credential_root: PathBuf,
    /// The account Hermes runs as, and so the only acceptable owner of a home.
    runtime_uid: u32,
    /// A reauthorization login that has ended and not yet been acted on.
    ///
    /// Parked here rather than acted on where it is noticed: putting the new
    /// material in place means stopping workers, and that belongs to the layer
    /// that owns them, not to the one that watches a subprocess.
    finished_reauth: Arc<Mutex<Option<FinishedReauthorization>>>,
    /// Bumped whenever an attempt is started or abandoned.
    ///
    /// An attempt that finishes checks that the world still expects it. Without
    /// this, a login somebody cancelled could come back minutes later and bind
    /// the credential a *different* login had just created -- the classic
    /// late-arrival that overwrites the thing that replaced it.
    generation: Arc<std::sync::atomic::AtomicU64>,
}

/// A reauthorization login that ended, with whatever it produced.
///
/// The staging home is carried by value: whoever takes this owns the home, and
/// dropping it without using it removes the material, which is the right
/// outcome for every path that does not reach a swap.
#[derive(Debug)]
pub struct FinishedReauthorization {
    pub credential_id: String,
    pub staging: crate::credential_swap::StagingHome,
    /// The generation the login ran under, so a swap cannot be applied on
    /// behalf of an attempt that has since been replaced.
    pub generation: u64,
}

/// One login, from the moment it is started until it is settled.
///
/// The process is held here rather than by whoever started it, and the lock
/// that guards this is taken only to read or change the state -- never across
/// the wait for the provider's CLI or for the person approving in a browser.
/// That wait took 66 seconds on node-1, and while it was held every credential
/// operation queued behind it, including the cancellation that would have ended
/// it.
struct Attempt {
    child: Child,
    /// Which credential this login is for.
    credential_id: String,
    generation: u64,
    /// The command that asked for this login, so the code can be delivered
    /// against the right correlation whenever it appears.
    command_id: Option<String>,
    phase: Phase,
    /// Set when this login is replacing what an existing credential holds.
    ///
    /// The staging home lives here for exactly as long as the attempt does: if
    /// the attempt is cancelled, replaced or dropped, so is the home, and no
    /// half-finished credential is left on disk for anybody to find.
    reauth: Option<crate::credential_swap::StagingHome>,
}

/// How far a login has got.
#[derive(Debug)]
enum Phase {
    /// The CLI is running and has printed no code yet. Bounded by the reader's
    /// own deadline, not by anything holding a lock.
    Producing,
    /// The code is out, with its place on the way to the relay.
    Waiting {
        code: DeviceCode,
        delivery: Delivery,
    },
}

/// The journey of a device code from this Node to the browser that asked.
///
/// Held in memory beside the login it belongs to and nowhere else, because the
/// code itself is: nothing about this survives the process, and nothing needs
/// to -- a login whose code was never confirmed delivered is cancelled.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Delivery {
    /// Produced, not yet handed to a session.
    Pending,
    /// Sent over a session and waiting for the Control Plane to confirm it.
    Sent {
        command_id: String,
        deadline: std::time::Instant,
    },
    /// Confirmed: the relay holds the code.
    Acknowledged,
}

/// Why a login could not be started, in words both sides already agree on.
///
/// A code rather than a sentence, because the console shows a person what
/// happened and must not parse English to do it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizationRefusal {
    pub code: &'static str,
    pub message: String,
}

impl AuthorizationRefusal {
    fn in_progress(same_credential: bool) -> Self {
        Self {
            code: "authorization_in_progress",
            message: if same_credential {
                "this credential is already waiting for a browser approval".to_owned()
            } else {
                "another authorization is already waiting for a browser approval on this Node"
                    .to_owned()
            },
        }
    }

    fn failed(message: String) -> Self {
        Self {
            code: "authorization_failed",
            message,
        }
    }

    pub fn refused(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for AuthorizationRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl Provider {
    pub fn new(paths: ProviderPaths, node_home: PathBuf) -> Self {
        let registry =
            crate::credentials::Registry::load(&crate::credentials::registry_path(&node_home));
        Self {
            paths,
            attempt: Arc::new(Mutex::new(None)),
            registry: Arc::new(Mutex::new(registry)),
            credential_root: crate::credential_homes::managed_root(&node_home),
            runtime_uid: unsafe { libc::getuid() },
            node_home,
            finished_reauth: Arc::new(Mutex::new(None)),
            generation: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }

    pub fn on_this_host() -> Self {
        Self::new(
            ProviderPaths::on_this_host(),
            PathBuf::from("/var/lib/asterism"),
        )
    }

    /// What this Node advertises, so a Control Plane can hide a control that
    /// would do nothing against an older Node.
    pub fn capabilities(&self) -> serde_json::Value {
        serde_json::json!({
            // The provider a run reaches, which is the pool Hermes keeps -- not
            // the Codex CLI session that lives beside it under CODEX_HOME.
            "kind": "openai-codex",
            "device_authorization": true,
            // Logging in again as an existing credential, keeping its id, its
            // home and every project assigned to it. Advertised rather than
            // inferred: an older Node refuses the command, and a console that
            // guessed from a version would offer a button that cannot work.
            "reauthorization": true,
            "reauthorization_command_version": 1,
        })
    }

    /// Whether the host's shared pool holds a credential, right now.
    ///
    /// About the shared pool alone, because that is what every project without
    /// an assignment reads. An isolated credential being authorized does not let
    /// such a project run, and reporting it as though it did is how a console
    /// would dispatch a run straight into a missing file. A login in flight is
    /// always for an isolated credential, so it does not move this either;
    /// isolated credentials report their own states.
    pub async fn state(&self) -> ProviderState {
        if !self.paths.hermes_binary.exists() {
            return ProviderState::Unavailable;
        }
        if self.paths.holds_credential() {
            return ProviderState::Authorized;
        }
        ProviderState::Required
    }

    /// Spawn the CLI that performs a device login into one credential's home.
    ///
    /// The entry is named after the credential's id rather than its label.
    /// Hermes names a pool entry after `--label`, and a label is a person's to
    /// change; the one entry in a home that holds exactly one credential needs
    /// no name a person reads, and must not move when they rename it.
    fn spawn_login(&self, provider_id: &str, credential_id: &str, home: &Path) -> Result<Child> {
        let mut command = Command::new(&self.paths.hermes_binary);
        command
            .arg("auth")
            .arg("add")
            .arg(provider_id)
            .arg("--type")
            .arg("oauth")
            .arg("--label")
            .arg(credential_id)
            // Never open a browser: there is nobody at this host to look at one,
            // and the point of the device flow is that the person is elsewhere.
            .arg("--no-browser");
        isolate(&mut command, home);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // A binary still open for writing somewhere cannot be executed for a
        // moment (ETXTBSY): a child forked by another thread holds the writer's
        // descriptor until it execs. Only a test writing its stand-in CLI ever
        // meets this, and a short wait is the whole of the fix.
        let mut attempts = 0;
        loop {
            match command.spawn() {
                Err(error) if error.raw_os_error() == Some(libc::ETXTBSY) && attempts < 50 => {
                    attempts += 1;
                    std::thread::sleep(Duration::from_millis(10));
                }
                spawned => {
                    return spawned.with_context(|| {
                        format!("cannot run {}", self.paths.hermes_binary.display())
                    });
                }
            }
        }
    }

    /// Read the banner, then keep the pipes drained for the rest of the login.
    async fn take_device_code(streams: Streams) -> Result<DeviceCode> {
        let (code, (mut out, mut err)) = read_device_code(streams).await?;
        // Keep reading, and throw it away. A pipe nobody drains fills and blocks
        // the writer; a pipe nobody holds open kills it. Neither is what a login
        // waiting on a person needs, and there is nothing else left to do for it
        // -- the credential is written by the CLI itself, into a directory this
        // process never opens.
        tokio::spawn(async move {
            // Both streams tracked separately, for the same reason the reader
            // above tracks them: one reaching its end is not the end of the
            // output, and a drain that stopped there would close the other pipe
            // and kill the login exactly as dropping it did.
            let (mut out_open, mut err_open) = (true, true);
            while out_open || err_open {
                tokio::select! {
                    line = out.next_line(), if out_open => {
                        if !matches!(line, Ok(Some(_))) {
                            out_open = false;
                        }
                    }
                    line = err.next_line(), if err_open => {
                        if !matches!(line, Ok(Some(_))) {
                            err_open = false;
                        }
                    }
                }
            }
        });
        Ok(code)
    }

    /// The original single-credential entry point, retired.
    ///
    /// It wrote a new credential into the shared pool, which is exactly where no
    /// credential may go any more: a pool entry cannot be selected by a project,
    /// so a login through here would add a credential nobody could use on
    /// purpose, beside ones they already cannot tell apart. Every new credential
    /// is authorized through `authorize_credential`, into a home of its own.
    pub async fn authorize(&self) -> Result<DeviceCode> {
        bail!(
            "provider_authorization_retired: new credentials are authorized one at a time, \
             each into its own home"
        )
    }

    /// Start a login for one credential and return as soon as it is running.
    ///
    /// The code is not waited for here. The CLI prints it when the provider
    /// answers -- a minute or more on a slow day -- and waiting for that while
    /// holding the attempt lock is what made a Node stop answering anything
    /// about its credentials. A reader task takes the code when it arrives and
    /// records it; until then the attempt is visibly `Producing`, cancellable,
    /// and in nobody's way.
    async fn begin_login(
        &self,
        provider_id: &str,
        credential_id: &str,
        home: &Path,
        command_id: Option<&str>,
        reauth: Option<crate::credential_swap::StagingHome>,
    ) -> std::result::Result<(), AuthorizationRefusal> {
        let mut attempt = self.attempt.lock().await;
        if let Some(running) = attempt.as_mut()
            && matches!(running.child.try_wait(), Ok(None))
        {
            return Err(AuthorizationRefusal::in_progress(
                running.credential_id == credential_id,
            ));
        }
        *attempt = None;

        let generation = self
            .generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        let mut child = self
            .spawn_login(provider_id, credential_id, home)
            .map_err(|error| AuthorizationRefusal::failed(error.to_string()))?;
        // Taken before the child is stored: the reader needs the pipes, and the
        // state needs the process, and neither may wait for the other.
        let streams = match (child.stdout.take(), child.stderr.take()) {
            (Some(out), Some(err)) => (BufReader::new(out).lines(), BufReader::new(err).lines()),
            _ => {
                let _ = child.start_kill();
                return Err(AuthorizationRefusal::failed(
                    "the provider CLI offered no output to read".to_owned(),
                ));
            }
        };

        *attempt = Some(Attempt {
            child,
            credential_id: credential_id.to_owned(),
            generation,
            command_id: command_id.map(ToOwned::to_owned),
            phase: Phase::Producing,
            reauth,
        });
        drop(attempt);

        let provider = self.clone();
        let credential = credential_id.to_owned();
        tokio::spawn(async move {
            match Self::take_device_code(streams).await {
                Ok(code) => provider.record_code(generation, &credential, code).await,
                Err(error) => {
                    provider
                        .abandon_produced_nothing(generation, &credential, &error.to_string())
                        .await
                }
            }
        });
        Ok(())
    }

    /// The CLI printed a code for the attempt that is still expected.
    async fn record_code(&self, generation: u64, credential_id: &str, code: DeviceCode) {
        let mut attempt = self.attempt.lock().await;
        match attempt.as_mut() {
            Some(running)
                if running.generation == generation
                    && running.credential_id == credential_id
                    && matches!(running.phase, Phase::Producing) =>
            {
                running.phase = Phase::Waiting {
                    code,
                    delivery: Delivery::Pending,
                };
            }
            // Cancelled, replaced, or already settled while the CLI was
            // thinking: the code speaks for a world that has moved on.
            _ => {}
        }
    }

    /// The CLI ended, or timed out, without ever printing a code.
    async fn abandon_produced_nothing(&self, generation: u64, credential_id: &str, detail: &str) {
        let replacing;
        {
            let mut attempt = self.attempt.lock().await;
            match attempt.as_mut() {
                Some(running) if running.generation == generation => {
                    let mut running = attempt.take().expect("checked above");
                    replacing = running.reauth.is_some();
                    let _ = running.child.start_kill();
                    self.generation
                        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
                _ => return,
            }
        }
        crate::daemon::log_event(
            "credential.authorization_produced_no_code",
            serde_json::json!({ "credential_id": credential_id, "detail": detail }),
        );
        // Same rule as a cancellation: a replacement that produced nothing
        // leaves the credential holding what it already held.
        if replacing {
            self.settle_reauthorization_failure(credential_id).await;
        } else {
            self.mark(credential_id, crate::credentials::CredentialState::Failed)
                .await;
        }
    }

    /// A code that is ready to be handed to a session, with the command it
    /// answers. `None` until the CLI has printed one.
    pub async fn deliverable_code(&self) -> Option<(String, String, DeviceCode)> {
        let attempt = self.attempt.lock().await;
        let running = attempt.as_ref()?;
        let command_id = running.command_id.clone()?;
        match &running.phase {
            Phase::Waiting { code, delivery } if *delivery == Delivery::Pending => {
                Some((command_id, running.credential_id.clone(), code.clone()))
            }
            _ => None,
        }
    }

    /// Abandon whatever is in flight, and say where that leaves the host.
    pub async fn cancel(&self) -> ProviderState {
        self.abandon_attempt().await;
        self.state().await
    }

    /// Kill the running login and forget its code.
    ///
    /// The generation moves, so the process that was polling for an approval
    /// cannot come back later and claim a credential that a newer login has
    /// since created.
    async fn abandon_attempt(&self) -> Option<String> {
        let mut attempt = self.attempt.lock().await;
        let taken = attempt.take();
        if taken.is_some() {
            self.generation
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        taken.map(|mut running| {
            let _ = running.child.start_kill();
            running.credential_id
        })
    }
}

// ------------------------------------------------------------ credentials

impl Provider {
    /// Everything this Node holds, reconciled against what is on disk first.
    ///
    /// Asked every time rather than cached. A cached answer is how a console
    /// ends up showing a credential somebody removed from the host by hand.
    pub async fn list_credentials(&self) -> Result<Vec<crate::credentials::CredentialSummary>> {
        use crate::credential_homes::HomeState;
        use crate::credentials::{CredentialState, CredentialStorage};

        // A login that has ended, if one has. Nothing is decided about it here:
        // the credential's home is what says whether it produced a credential.
        let finished = self.settle_attempt().await;
        let in_flight = self.attempt_in_flight().await;

        // The shared pool is asked only when it exists. On a host that never had
        // one, asking would make Hermes build a shared home nobody uses.
        let pool = if self.paths.holds_credential() {
            self.pool_list("openai-codex").await.unwrap_or_default()
        } else {
            Vec::new()
        };

        // Each isolated credential is judged by its own home, gathered without
        // holding the registry: confirming a store means running Hermes on it.
        let candidates: Vec<(String, String, CredentialState)> = {
            let registry = self.registry.lock().await;
            registry
                .credentials
                .iter()
                .filter(|credential| credential.storage == CredentialStorage::Isolated)
                .filter(|credential| credential.state != CredentialState::Revoked)
                .filter(|credential| in_flight.as_deref() != Some(credential.id.as_str()))
                .map(|credential| {
                    (
                        credential.id.clone(),
                        credential.provider_id.clone(),
                        credential.state,
                    )
                })
                .collect()
        };
        let mut verdicts = Vec::new();
        for (credential_id, provider_id, state) in candidates {
            let home = crate::credential_homes::inspect(
                &self.credential_root,
                &credential_id,
                self.runtime_uid,
            );
            let next = match (home, state) {
                (HomeState::Ready, CredentialState::Authorized) => CredentialState::Authorized,
                (HomeState::Ready, _) => {
                    if self.home_holds_entry(&provider_id, &credential_id).await {
                        CredentialState::Authorized
                    } else {
                        unsettled(state)
                    }
                }
                (_, CredentialState::Authorized) => CredentialState::Required,
                _ => unsettled(state),
            };
            if next != state {
                verdicts.push((credential_id, next));
            }
        }

        let mut registry = self.registry.lock().await;
        let mut changed = registry.reconcile("openai-codex", &pool, now());
        for (credential_id, next) in verdicts {
            if let Some(credential) = registry.get_mut(&credential_id)
                && credential.state != CredentialState::Revoked
            {
                credential.state = next;
                credential.updated_at = now();
                changed = true;
            }
        }

        // Only now, once the pool has had its say. A login whose credential is
        // still unbound left nothing behind, which is a failure however the CLI
        // exited -- a successful one writes to the pool.
        if let Some(credential_id) = finished
            && let Some(credential) = registry.get_mut(&credential_id)
            && credential.state == crate::credentials::CredentialState::Authorizing
        {
            credential.state = crate::credentials::CredentialState::Failed;
            credential.updated_at = now();
            changed = true;
        }
        if changed {
            self.persist(&registry);
        }
        Ok(registry.summaries())
    }

    /// Begin a login for a new credential.
    ///
    /// The provider and the method are checked against what this Node reports
    /// it supports -- not against anything the caller sent. A Control Plane that
    /// asked for something else is refused here, which is the point of the Node
    /// being the final authority: the list it publishes and the list it honours
    /// are the same list.
    pub async fn authorize_credential(
        &self,
        provider_id: &str,
        auth_method: &str,
        label: &str,
        command_id: Option<&str>,
    ) -> std::result::Result<String, AuthorizationRefusal> {
        self.start_authorization(provider_id, auth_method, label, command_id)
            .await
    }

    async fn start_authorization(
        &self,
        provider_id: &str,
        auth_method: &str,
        label: &str,
        command_id: Option<&str>,
    ) -> std::result::Result<String, AuthorizationRefusal> {
        let refused =
            |code: &'static str, message: String| AuthorizationRefusal::refused(code, message);
        crate::credentials::validate_label(label)
            .map_err(|error| refused("label_invalid", error.to_string()))?;
        let label = label.trim();

        let snapshot = crate::providercaps::snapshot(
            &self.paths.hermes_binary,
            &crate::runtimerelease::reported_on_this_host(),
        );
        let supported = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == provider_id)
            .ok_or_else(|| {
                refused(
                    "provider_not_supported",
                    "this Node does not support that provider".to_owned(),
                )
            })?;
        if supported.availability != crate::providercaps::Availability::Available {
            return Err(refused(
                "provider_unavailable",
                "that provider is not available on this Node".to_owned(),
            ));
        }
        if !supported
            .auth_methods
            .iter()
            .any(|method| method.wire() == auth_method)
        {
            return Err(refused(
                "auth_method_not_supported",
                "this Node does not support that way of authorizing that provider".to_owned(),
            ));
        }

        // Refused before anything exists, and immediately: a second login would
        // invalidate the code the first person is looking at, and starting one
        // here would leave behind a home and a failed row for an attempt that
        // never ran.
        if self.attempt_in_flight().await.is_some() {
            return Err(AuthorizationRefusal::in_progress(false));
        }

        {
            let registry = self.registry.lock().await;
            if registry.credentials.len() >= crate::credentials::MAX_CREDENTIALS {
                return Err(refused(
                    "credential_limit_reached",
                    format!(
                        "this Node already holds {} credentials",
                        crate::credentials::MAX_CREDENTIALS
                    ),
                ));
            }
        }

        // A credential id that exists before the login does, so an attempt is
        // always attached to something an operator can see and cancel.
        let credential_id = new_credential_id();
        // And a home that exists before the login does, so the CLI writes the
        // secret at its final location and nothing ever moves it.
        let home = crate::credential_homes::create_home(
            &self.credential_root,
            &credential_id,
            self.runtime_uid,
        )
        .map_err(|error| refused("credential_home_unavailable", error.to_string()))?;
        {
            let mut registry = self.registry.lock().await;
            registry.credentials.push(crate::credentials::Credential {
                id: credential_id.clone(),
                provider_id: provider_id.to_owned(),
                auth_method: auth_method.to_owned(),
                label: label.to_owned(),
                state: crate::credentials::CredentialState::Authorizing,
                storage: crate::credentials::CredentialStorage::Isolated,
                generation: 0,
                pool_entry: None,
                created_at: now(),
                updated_at: now(),
            });
            self.persist(&registry);
        }

        match self
            .begin_login(provider_id, &credential_id, &home, command_id, None)
            .await
        {
            Ok(()) => Ok(credential_id),
            Err(refusal) => {
                self.mark(&credential_id, crate::credentials::CredentialState::Failed)
                    .await;
                Err(refusal)
            }
        }
    }

    /// Log in again as an existing credential, replacing what it holds.
    ///
    /// The credential is not recreated and nothing about it moves: the id, the
    /// home, the label, the provider, the method and every project that reads it
    /// are the same before and after. What changes is one file, and only once
    /// the login has produced a replacement worth putting there.
    ///
    /// The login happens in a staging home nobody reads, because the runtime
    /// cannot rewrite a record in place -- it can only add one, under an
    /// identity of its own choosing. Adding it to the credential's own home
    /// would make that home hold two credentials, which is the one thing an
    /// isolated home must never do.
    pub async fn reauthorize_credential(
        &self,
        credential_id: &str,
        command_id: Option<&str>,
    ) -> std::result::Result<(), AuthorizationRefusal> {
        use crate::credentials::{CredentialState, CredentialStorage};
        let refused =
            |code: &'static str, message: String| AuthorizationRefusal::refused(code, message);
        crate::credentials::validate_id(credential_id)
            .map_err(|_| refused("credential_id_invalid", "not a credential id".to_owned()))?;

        let (state, provider_id, auth_method) = {
            let registry = self.registry.lock().await;
            let credential = registry.get(credential_id).ok_or_else(|| {
                refused(
                    "credential_not_found",
                    "this Node does not hold that credential".to_owned(),
                )
            })?;
            // Only a credential with a home of its own can be replaced. A shared
            // pool entry is not addressable, so there is nothing to replace.
            if credential.storage != CredentialStorage::Isolated {
                return Err(refused(
                    "credential_not_reauthorizable",
                    "that credential is not one this Node can log in again".to_owned(),
                ));
            }
            (
                credential.state,
                credential.provider_id.clone(),
                credential.auth_method.clone(),
            )
        };

        // Asked before the state is judged. A credential already waiting for an
        // approval is in `reauthorizing`, which is not a state a login may start
        // from -- but "another login is already out" is the reason, and saying
        // "this cannot be logged in again" instead would send somebody looking
        // for a problem with the credential.
        if self.attempt_in_flight().await.is_some() {
            return Err(AuthorizationRefusal::in_progress(false));
        }
        if !state.reauthorizable() {
            return Err(refused(
                "credential_not_reauthorizable",
                "that credential is not in a state that can be logged in again".to_owned(),
            ));
        }

        // Asked of the runtime, not assumed: a Node whose runtime stopped
        // offering the provider must refuse rather than start a login nobody
        // can finish.
        let snapshot = crate::providercaps::snapshot(
            &self.paths.hermes_binary,
            &crate::runtimerelease::reported_on_this_host(),
        );
        let supported = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == provider_id)
            .ok_or_else(|| {
                refused(
                    "provider_not_supported",
                    "this Node does not support that provider".to_owned(),
                )
            })?;
        if supported.availability != crate::providercaps::Availability::Available {
            return Err(refused(
                "provider_unavailable",
                "that provider is not available on this Node".to_owned(),
            ));
        }
        if !supported
            .auth_methods
            .iter()
            .any(|method| method.wire() == auth_method)
        {
            return Err(refused(
                "auth_method_not_supported",
                "this Node does not support that way of authorizing that provider".to_owned(),
            ));
        }

        // A credential whose home is not fit to hold one cannot be repaired by
        // putting a new file in it. The home already exists -- this credential
        // is not new -- so it is inspected rather than created, and the two
        // shapes worth continuing from are a home with a record and a home
        // whose record the runtime pruned.
        match crate::credential_homes::inspect(
            &self.credential_root,
            credential_id,
            self.runtime_uid,
        ) {
            crate::credential_homes::HomeState::Ready
            | crate::credential_homes::HomeState::CredentialMissing
            | crate::credential_homes::HomeState::CredentialUnreadable => {}
            crate::credential_homes::HomeState::HomeMissing => {
                crate::credential_homes::create_home(
                    &self.credential_root,
                    credential_id,
                    self.runtime_uid,
                )
                .map_err(|error| refused("credential_home_unavailable", error.to_string()))?;
            }
            crate::credential_homes::HomeState::HomeInvalid => {
                return Err(refused(
                    "credential_home_unavailable",
                    "this credential's home on the Node is not one it may use".to_owned(),
                ));
            }
        }

        let staging =
            crate::credential_swap::StagingHome::create(&self.node_home, self.runtime_uid)
                .map_err(|error| refused("credential_home_unavailable", error.to_string()))?;
        let staging_path = staging.path().to_path_buf();

        self.mark(credential_id, CredentialState::Reauthorizing)
            .await;
        match self
            .begin_login(
                &provider_id,
                credential_id,
                &staging_path,
                command_id,
                Some(staging),
            )
            .await
        {
            Ok(()) => Ok(()),
            Err(refusal) => {
                // Back to the honest state rather than to a generic failure: the
                // credential still holds whatever it held a moment ago, and
                // whether that works is a question this refusal did not answer.
                self.settle_reauthorization_failure(credential_id).await;
                Err(refusal)
            }
        }
    }

    /// A credential is now holding material it did not hold before.
    ///
    /// The generation moves here and only here. A run that started before this
    /// carries the older one, so when it reports the grant dead -- which it
    /// will, because it was using the grant that was just replaced -- the report
    /// is recognisably about material this credential no longer has.
    pub async fn accept_reauthorization(&self, credential_id: &str) {
        let mut registry = self.registry.lock().await;
        if let Some(credential) = registry.get_mut(credential_id) {
            credential.generation = credential.generation.saturating_add(1);
            credential.state = crate::credentials::CredentialState::Authorized;
            credential.updated_at = now();
        }
        self.persist(&registry);
    }

    /// The provider and method one credential was created with.
    pub async fn credential_facts(&self, credential_id: &str) -> Option<(String, String)> {
        let registry = self.registry.lock().await;
        registry.get(credential_id).map(|credential| {
            (
                credential.provider_id.clone(),
                credential.auth_method.clone(),
            )
        })
    }

    /// What generation this credential is on, for a caller that will report
    /// back about it later.
    pub async fn credential_generation(&self, credential_id: &str) -> Option<u64> {
        let registry = self.registry.lock().await;
        registry
            .get(credential_id)
            .map(|credential| credential.generation)
    }

    /// The runtime says this credential's grant is finished.
    ///
    /// Applied only when the report is about the material the credential holds
    /// now. A slower run from before a reauthorization reports the grant it was
    /// using, which is not this one, and marking the credential on the strength
    /// of that would break a credential that works.
    pub async fn report_grant_dead(&self, credential_id: &str, generation: u64) -> bool {
        let mut registry = self.registry.lock().await;
        let Some(credential) = registry.get_mut(credential_id) else {
            return false;
        };
        if credential.generation != generation {
            return false;
        }
        // And never over a login that is happening right now: that attempt is
        // about to answer this question itself.
        if matches!(
            credential.state,
            crate::credentials::CredentialState::Reauthorizing
                | crate::credentials::CredentialState::Authorizing
        ) {
            return false;
        }
        if credential.state == crate::credentials::CredentialState::ReauthorizationRequired {
            return false;
        }
        credential.state = crate::credentials::CredentialState::ReauthorizationRequired;
        credential.updated_at = now();
        self.persist(&registry);
        true
    }

    /// Where a reauthorization that did not happen leaves the credential.
    ///
    /// Never `Authorized` and never `Failed`. The credential exists, it has a
    /// home, and the only thing that changed is that an attempt to replace its
    /// material did not finish -- so it goes back to what its runtime record
    /// says about it, which is the same question asked before the attempt.
    pub async fn settle_reauthorization_failure(&self, credential_id: &str) {
        let next = self.runtime_state(credential_id).await;
        self.mark(credential_id, next).await;
    }

    /// What this credential's own runtime record says it is.
    ///
    /// The distinction that matters is between a record the runtime wrote off
    /// and no record at all: the first is a revocation somebody must answer, the
    /// second is an absence that says nothing about the grant.
    pub async fn runtime_state(&self, credential_id: &str) -> crate::credentials::CredentialState {
        use crate::credentials::CredentialState;
        let provider_id = {
            let registry = self.registry.lock().await;
            match registry.get(credential_id) {
                Some(credential) => credential.provider_id.clone(),
                None => return CredentialState::Required,
            }
        };
        let Ok(store) =
            crate::credential_homes::credential_file(&self.credential_root, credential_id)
        else {
            return CredentialState::Required;
        };
        match crate::credential_runtime::verdict(&store, &provider_id, credential_id) {
            crate::credential_runtime::RuntimeVerdict::Usable => CredentialState::Authorized,
            crate::credential_runtime::RuntimeVerdict::Dead { .. } => {
                CredentialState::ReauthorizationRequired
            }
            crate::credential_runtime::RuntimeVerdict::Missing => CredentialState::RuntimeMissing,
            // A store this Node cannot read is not a store it may draw a
            // conclusion from.
            crate::credential_runtime::RuntimeVerdict::Unreadable => CredentialState::Required,
        }
    }

    /// Abandon the login for one credential.
    ///
    /// Refuses to touch an attempt belonging to a different credential: a cancel
    /// aimed at one login must not silently kill another person's.
    pub async fn cancel_credential(&self, credential_id: &str) -> Result<()> {
        crate::credentials::validate_id(credential_id)?;
        {
            let attempt = self.attempt.lock().await;
            match attempt.as_ref() {
                Some(running) if running.credential_id == credential_id => {}
                Some(_) => bail!("the login in flight belongs to a different credential"),
                None => {}
            }
        }
        // Whether this was a first login or a replacement decides where the
        // credential lands. A cancelled *first* login leaves a credential that
        // never held anything, and `failed` says so. A cancelled *replacement*
        // leaves a credential still holding exactly what it held before, and
        // calling that failed would report a loss that did not happen.
        let replacing = {
            let attempt = self.attempt.lock().await;
            attempt
                .as_ref()
                .is_some_and(|running| running.reauth.is_some())
        } || {
            let registry = self.registry.lock().await;
            registry.get(credential_id).is_some_and(|credential| {
                credential.state == crate::credentials::CredentialState::Reauthorizing
            })
        };
        self.abandon_attempt().await;
        // Any material a cancelled replacement staged went with the attempt.
        if replacing {
            self.settle_reauthorization_failure(credential_id).await;
        } else {
            self.mark(credential_id, crate::credentials::CredentialState::Failed)
                .await;
        }
        Ok(())
    }

    /// Give a credential a different name. Nothing else about it changes.
    pub async fn rename_credential(&self, credential_id: &str, label: &str) -> Result<()> {
        crate::credentials::validate_id(credential_id)?;
        crate::credentials::validate_label(label)?;
        let mut registry = self.registry.lock().await;
        let credential = registry
            .get_mut(credential_id)
            .ok_or_else(|| anyhow::anyhow!("no such credential on this Node"))?;
        credential.label = label.trim().to_owned();
        credential.updated_at = now();
        self.persist(&registry);
        Ok(())
    }

    /// Take one credential away, and only that one.
    ///
    /// The removal goes through Hermes by the pool's own entry id, so the other
    /// credentials in the pool are untouched by construction rather than by
    /// this code being careful with a file.
    pub async fn revoke_credential(&self, credential_id: &str) -> Result<()> {
        crate::credentials::validate_id(credential_id)?;
        let (provider_id, pool_entry, storage) = {
            let registry = self.registry.lock().await;
            let credential = registry
                .get(credential_id)
                .ok_or_else(|| anyhow::anyhow!("no such credential on this Node"))?;
            (
                credential.provider_id.clone(),
                credential.pool_entry.clone(),
                credential.storage,
            )
        };

        // A credential mid-login has nothing in the pool yet; abandoning the
        // attempt is the whole of revoking it.
        {
            let attempt = self.attempt.lock().await;
            if attempt
                .as_ref()
                .is_some_and(|running| running.credential_id == credential_id)
            {
                drop(attempt);
                self.abandon_attempt().await;
            }
        }

        match storage {
            crate::credentials::CredentialStorage::LegacySharedPool => {
                if let Some(entry) = pool_entry {
                    self.pool_remove(&provider_id, &entry).await?;
                }
            }
            // Inside its own home, through Hermes. Nothing else is in that store
            // and nothing outside it is touched; the home itself is kept, so a
            // removal is a record rather than a missing directory.
            crate::credentials::CredentialStorage::Isolated => {
                if crate::credential_homes::inspect(
                    &self.credential_root,
                    credential_id,
                    self.runtime_uid,
                ) == crate::credential_homes::HomeState::Ready
                {
                    self.home_remove(&provider_id, credential_id).await?;
                }
            }
        }
        self.mark(credential_id, crate::credentials::CredentialState::Revoked)
            .await;
        Ok(())
    }

    /// Which login has ended, if one has.
    ///
    /// The generation guard is the point: an attempt the world has moved past --
    /// one somebody cancelled, whose process finished anyway -- is discarded
    /// rather than allowed to speak for a credential a later login created.
    ///
    /// Deliberately decides nothing else. Whether the login produced a
    /// credential is a question for the pool, and `reconcile` is what reads it.
    async fn settle_attempt(&self) -> Option<String> {
        let finished = {
            let mut attempt = self.attempt.lock().await;
            match attempt.as_mut() {
                Some(running) => match running.child.try_wait() {
                    // Still waiting for a person.
                    Ok(None) => None,
                    Ok(Some(_)) | Err(_) => {
                        let running = attempt.take().expect("checked above");
                        Some((running.credential_id, running.generation, running.reauth))
                    }
                },
                None => None,
            }
        };
        let (credential_id, generation, reauth) = finished?;
        if generation != self.generation.load(std::sync::atomic::Ordering::SeqCst) {
            // Somebody cancelled or started another login while this one was
            // finishing. It speaks for a world that no longer exists -- and if
            // it staged any material, dropping it here is what removes it.
            return None;
        }
        // A reauthorization is not settled by its login ending. What it produced
        // still has to be judged and put in place, which happens where the
        // workers are; it is parked until then rather than decided here.
        if let Some(staging) = reauth {
            let mut slot = self.finished_reauth.lock().await;
            *slot = Some(FinishedReauthorization {
                credential_id,
                staging,
                generation,
            });
            return None;
        }
        Some(credential_id)
    }

    /// Take a reauthorization login that has ended, if one has.
    ///
    /// Taken rather than read: whoever gets it owns the staged material and is
    /// the only one who can put it in place or throw it away.
    pub async fn take_finished_reauthorization(&self) -> Option<FinishedReauthorization> {
        self.finished_reauth.lock().await.take()
    }

    /// Whether the generation a swap was prepared under is still the current one.
    pub fn generation_is_current(&self, generation: u64) -> bool {
        generation == self.generation.load(std::sync::atomic::Ordering::SeqCst)
    }

    async fn mark(&self, credential_id: &str, state: crate::credentials::CredentialState) {
        let mut registry = self.registry.lock().await;
        if let Some(credential) = registry.get_mut(credential_id) {
            credential.state = state;
            credential.updated_at = now();
        }
        self.persist(&registry);
    }

    /// Failures here are reported and dropped. A registry that cannot be written
    /// costs labels on the next start -- every credential is adopted again from
    /// the pool -- and refusing an authorization over it would cost the login.
    fn persist(&self, registry: &crate::credentials::Registry) {
        let path = crate::credentials::registry_path(&self.node_home);
        if let Err(error) = registry.save(&path) {
            eprintln!("warning: cannot record the credential registry: {error:#}");
        }
    }

    /// What the pool holds, as Hermes reports it. Never opens a credential.
    async fn pool_list(&self, provider_id: &str) -> Result<Vec<crate::credentials::PoolEntry>> {
        let output = Command::new(&self.paths.hermes_binary)
            .arg("auth")
            .arg("list")
            .arg(provider_id)
            .env("HERMES_HOME", &self.paths.hermes_home)
            .env("HOME", "/var/lib/asterism")
            .stdin(Stdio::null())
            .output()
            .await
            .with_context(|| format!("cannot run {}", self.paths.hermes_binary.display()))?;
        Ok(crate::credentials::parse_pool_listing(
            &String::from_utf8_lossy(&output.stdout),
        ))
    }

    async fn pool_remove(&self, provider_id: &str, target: &str) -> Result<()> {
        let output = Command::new(&self.paths.hermes_binary)
            .arg("auth")
            .arg("remove")
            .arg(provider_id)
            .arg(target)
            .env("HERMES_HOME", &self.paths.hermes_home)
            .env("HOME", "/var/lib/asterism")
            .stdin(Stdio::null())
            .output()
            .await
            .with_context(|| format!("cannot run {}", self.paths.hermes_binary.display()))?;
        if !output.status.success() {
            // Typed first, so a console can say what happened without reading
            // the CLI's sentence; the sentence follows for this Node's journal,
            // and names a provider and an entry and never a token.
            bail!(
                "credential_runtime_missing: the provider runtime refused to remove the \
                 credential: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(())
    }
}

// ------------------------------------------------------------ code delivery

impl Provider {
    /// The code of this credential's login was just sent over a session.
    ///
    /// Only a login still waiting to be delivered moves; anything else -- a
    /// different credential, a login already sent or confirmed -- is refused, so
    /// one code is never considered delivered twice.
    pub async fn delivery_sent(
        &self,
        credential_id: &str,
        command_id: &str,
        deadline: std::time::Instant,
    ) -> bool {
        let mut attempt = self.attempt.lock().await;
        match attempt.as_mut() {
            Some(running) if running.credential_id == credential_id => match &mut running.phase {
                Phase::Waiting { delivery, .. } if *delivery == Delivery::Pending => {
                    *delivery = Delivery::Sent {
                        command_id: command_id.to_owned(),
                        deadline,
                    };
                    true
                }
                _ => false,
            },
            _ => false,
        }
    }

    /// The Control Plane holds the code sent for this command.
    ///
    /// A confirmation for anything but the delivery in flight -- another
    /// command, a login already cancelled, a confirmation that arrives twice --
    /// changes nothing.
    pub async fn acknowledge_delivery(&self, command_id: &str) -> bool {
        let mut attempt = self.attempt.lock().await;
        match attempt.as_mut() {
            Some(running) => match &mut running.phase {
                Phase::Waiting { delivery, .. } => {
                    let sent_for_this = matches!(
                        &*delivery,
                        Delivery::Sent { command_id: sent, .. } if sent == command_id
                    );
                    if sent_for_this {
                        *delivery = Delivery::Acknowledged;
                    }
                    sent_for_this
                }
                Phase::Producing => false,
            },
            None => false,
        }
    }

    /// Cancel the login whose code did not reach the relay, and say which.
    ///
    /// Deterministic, in two cases only. When the session ends, any code not yet
    /// confirmed -- sent or not -- is lost with it, so its login is cancelled.
    /// While a session is up, a sent code unconfirmed past its deadline is
    /// treated the same way. A confirmed code is never touched: the relay has
    /// it, and the person may be approving it right now.
    pub async fn cancel_undelivered(
        &self,
        session_ended: bool,
        now: std::time::Instant,
    ) -> Option<String> {
        let credential_id = {
            let attempt = self.attempt.lock().await;
            let running = attempt.as_ref()?;
            let undelivered = match &running.phase {
                // A login still waiting for its code cannot deliver it to a
                // session that has ended, so the session ending ends it too.
                // While the session holds, it is given the time its own reader
                // allows rather than a delivery deadline it has not reached.
                Phase::Producing => session_ended,
                Phase::Waiting { delivery, .. } => match delivery {
                    Delivery::Acknowledged => false,
                    Delivery::Pending => session_ended,
                    Delivery::Sent { deadline, .. } => session_ended || now >= *deadline,
                },
            };
            if !undelivered {
                return None;
            }
            running.credential_id.clone()
        };
        self.cancel_credential(&credential_id).await.ok()?;
        Some(credential_id)
    }
}

// ------------------------------------------------------- isolated credentials

/// Why a credential cannot be used by a project, in terms safe to show anyone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CredentialRefusal {
    pub code: &'static str,
    pub message: &'static str,
}

impl CredentialRefusal {
    const fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }
}

impl Provider {
    /// The managed root every isolated credential lives under.
    pub fn credential_root(&self) -> &Path {
        &self.credential_root
    }

    /// The account a credential home must belong to.
    pub fn runtime_uid(&self) -> u32 {
        self.runtime_uid
    }

    /// The host's shared pool, which projects without an assignment read.
    pub fn shared_pool(&self) -> PathBuf {
        self.paths.credential()
    }

    /// Whether a project may use this credential right now, and its provider.
    ///
    /// Everything is checked again here, on the Node, whatever the Control Plane
    /// already decided: that the id is one, that this Node holds it, that it
    /// lives in a home of its own rather than the shared pool, that it is
    /// authorized, that its provider is available here, and that its home and
    /// store are exactly what a worker may read. A credential of another Node is
    /// simply not held, and is refused exactly like one that never existed.
    pub async fn usable(
        &self,
        credential_id: &str,
    ) -> std::result::Result<String, CredentialRefusal> {
        use crate::credential_homes::HomeState;
        use crate::credentials::{CredentialState, CredentialStorage};

        if crate::credentials::validate_id(credential_id).is_err() {
            return Err(CredentialRefusal::new(
                "credential_id_invalid",
                "that is not a credential id",
            ));
        }
        let (provider_id, storage, state) = {
            let registry = self.registry.lock().await;
            let Some(credential) = registry.get(credential_id) else {
                return Err(CredentialRefusal::new(
                    "credential_not_found",
                    "this Node holds no such credential",
                ));
            };
            (
                credential.provider_id.clone(),
                credential.storage,
                credential.state,
            )
        };
        if storage != CredentialStorage::Isolated {
            return Err(CredentialRefusal::new(
                "credential_not_isolated",
                "a credential in the shared pool cannot be selected by a project",
            ));
        }
        // Typed by where the credential actually stands, because these reach a
        // person as the reason their run did not start and each one has a
        // different answer. "Not authorized" for all of them told somebody
        // whose credential was being replaced to go and authorize it, which was
        // both wrong and impossible.
        if self.attempt_in_flight().await.as_deref() == Some(credential_id) {
            return Err(CredentialRefusal::new(
                "credential_reauthorizing",
                "this credential is being logged in again; try this once it finishes",
            ));
        }
        match state {
            CredentialState::Authorized => {}
            CredentialState::Reauthorizing => {
                return Err(CredentialRefusal::new(
                    "credential_reauthorizing",
                    "this credential is being logged in again; try this once it finishes",
                ));
            }
            CredentialState::ReauthorizationRequired => {
                return Err(CredentialRefusal::new(
                    "credential_reauthorization_required",
                    "this credential's provider access has ended; authorize it again",
                ));
            }
            CredentialState::RuntimeMissing => {
                return Err(CredentialRefusal::new(
                    "credential_runtime_missing",
                    "this Node's runtime holds nothing for this credential; authorize it again",
                ));
            }
            _ => {
                return Err(CredentialRefusal::new(
                    "credential_not_authorized",
                    "the credential is not authorized",
                ));
            }
        }
        let snapshot = crate::providercaps::snapshot(
            &self.paths.hermes_binary,
            &crate::runtimerelease::reported_on_this_host(),
        );
        let available = snapshot.providers.iter().any(|provider| {
            provider.id == provider_id
                && provider.availability == crate::providercaps::Availability::Available
        });
        if !available {
            return Err(CredentialRefusal::new(
                "credential_provider_unavailable",
                "this Node cannot currently reach the credential's provider",
            ));
        }
        match crate::credential_homes::inspect(
            &self.credential_root,
            credential_id,
            self.runtime_uid,
        ) {
            HomeState::Ready => Ok(provider_id),
            HomeState::HomeMissing => Err(CredentialRefusal::new(
                "credential_home_missing",
                "the credential's home is missing on this Node",
            )),
            HomeState::CredentialMissing => Err(CredentialRefusal::new(
                "credential_unavailable",
                "the credential holds nothing; authorize it again",
            )),
            HomeState::HomeInvalid | HomeState::CredentialUnreadable => {
                Err(CredentialRefusal::new(
                    "credential_unreadable",
                    "the credential's store is not in a state a worker may read",
                ))
            }
        }
    }

    /// Which credential a login is still running for, if any.
    async fn attempt_in_flight(&self) -> Option<String> {
        let mut attempt = self.attempt.lock().await;
        let running = attempt.as_mut()?;
        match running.child.try_wait() {
            Ok(None) => Some(running.credential_id.clone()),
            _ => None,
        }
    }

    /// Whether one home's store holds an entry, as Hermes itself reports it.
    /// Never opens the store.
    async fn home_holds_entry(&self, provider_id: &str, credential_id: &str) -> bool {
        let Ok(home) = crate::credential_homes::home(&self.credential_root, credential_id) else {
            return false;
        };
        let mut command = Command::new(&self.paths.hermes_binary);
        command.arg("auth").arg("list").arg(provider_id);
        isolate(&mut command, &home);
        match command.stdin(Stdio::null()).output().await {
            Ok(output) => {
                !crate::credentials::parse_pool_listing(&String::from_utf8_lossy(&output.stdout))
                    .is_empty()
            }
            Err(_) => false,
        }
    }

    /// Remove the one entry in one home, through Hermes.
    async fn home_remove(&self, provider_id: &str, credential_id: &str) -> Result<()> {
        let home = crate::credential_homes::home(&self.credential_root, credential_id)?;
        let mut command = Command::new(&self.paths.hermes_binary);
        command
            .arg("auth")
            .arg("remove")
            .arg(provider_id)
            .arg(credential_id);
        isolate(&mut command, &home);
        let output = command
            .stdin(Stdio::null())
            .output()
            .await
            .with_context(|| format!("cannot run {}", self.paths.hermes_binary.display()))?;
        if !output.status.success() {
            bail!(
                "credential_runtime_missing: the provider runtime refused to remove the \
                 credential: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(())
    }
}

/// What a login that ended, or a home that holds nothing, leaves a credential
/// as. A person was waiting on it, so it failed; anything else stays put.
fn unsettled(state: crate::credentials::CredentialState) -> crate::credentials::CredentialState {
    use crate::credentials::CredentialState;
    match state {
        CredentialState::Authorizing => CredentialState::Failed,
        other => other,
    }
}

/// Point everything Hermes resolves state from at one credential home.
///
/// `HERMES_HOME` alone is not enough. Hermes and the libraries under it also
/// look under `HOME`, `CODEX_HOME` and the XDG directories, and a login that
/// found an existing store through any of them would write into it -- or read a
/// credential out of it -- instead of creating one where it belongs.
fn isolate(command: &mut Command, home: &Path) {
    command
        .env("HERMES_HOME", home)
        .env("HOME", home)
        .env("CODEX_HOME", home.join(".codex"))
        .env("XDG_CONFIG_HOME", home)
        .env("XDG_DATA_HOME", home)
        .env("XDG_STATE_HOME", home)
        .env("XDG_CACHE_HOME", home.join("cache"))
        // Without this the banner never arrives. Python buffers stdout when it
        // is not a terminal, and this one is a pipe: the link and the code sit
        // in a buffer until the process exits, which is after the approval it
        // was waiting for. Measured, not assumed -- the same command produced
        // zero bytes in forty seconds without it.
        .env("PYTHONUNBUFFERED", "1");
}

/// An id for a credential this Node is about to create.
///
/// Random rather than derived: there is nothing to derive it from yet, and two
/// logins started a second apart must not collide.
fn new_credential_id() -> String {
    let mut bytes = [0u8; 8];
    getrandom::getrandom(&mut bytes).expect("OS randomness is available");
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("cred-{hex}")
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0)
}

/// Read the CLI's own output until it has printed a link and a code.
///
/// Both streams, because which one carries this is the CLI's business and not a
/// thing to depend on: the observed version writes the whole banner to stdout
/// and a PATH warning to stderr, and a version that swapped them would leave a
/// person watching a spinner forever.
type Streams = (
    tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    tokio::io::Lines<BufReader<tokio::process::ChildStderr>>,
);

async fn read_device_code((mut out, mut err): Streams) -> Result<(DeviceCode, Streams)> {
    let mut seen = String::new();
    // Tracked separately, because one stream reaching its end is not the end of
    // the output. Treating it as one would abandon a login the moment the CLI
    // finished with stderr -- reporting "it offered no code" while the code was
    // still on its way down stdout.
    let (mut out_open, mut err_open) = (true, true);
    let deadline = tokio::time::sleep(CODE_TIMEOUT);
    tokio::pin!(deadline);

    while out_open || err_open {
        let line = tokio::select! {
            line = out.next_line(), if out_open => match line? {
                Some(line) => Some(line),
                None => { out_open = false; None }
            },
            line = err.next_line(), if err_open => match line? {
                Some(line) => Some(line),
                None => { err_open = false; None }
            },
            () = &mut deadline => {
                bail!("the provider CLI did not offer a code within {} seconds", CODE_TIMEOUT.as_secs())
            }
        };
        if let Some(line) = line {
            seen.push_str(&line);
            seen.push('\n');
            if let Some(code) = parse_device_code(&seen) {
                // The readers travel back with the code. Dropping them here
                // closes the pipes, and the CLI dies of SIGPIPE on its next
                // write -- which it makes, repeatedly, while it polls for the
                // approval. The code reached the browser and the login was
                // already dead: a person held a valid code with nothing left
                // listening for their answer.
                return Ok((code, (out, err)));
            }
        }
    }

    // Both streams are genuinely finished and neither carried a code. The CLI's
    // own last words are the only thing that says why, and they are not a
    // credential: a failed login has no secret in it.
    let detail = seen
        .lines()
        .rfind(|line| !line.trim().is_empty())
        .unwrap_or("it printed nothing")
        .trim();
    bail!("the provider CLI stopped without offering a code: {detail}")
}

/// Pull the link, the code and the expiry out of what the CLI printed.
///
/// Deliberately not a template of the CLI's sentences. It prints a numbered,
/// coloured, human-facing banner whose wording is not a contract, so this looks
/// for the two things that are: an `https://` link, and a short grouped code on
/// a line of its own. Matching the prose instead would break on a release that
/// reworded a heading.
pub fn parse_device_code(text: &str) -> Option<DeviceCode> {
    let plain = strip_ansi(text);

    let verification_uri = plain
        .split_whitespace()
        .find(|word| word.starts_with("https://"))
        .map(|word| word.trim_end_matches(['.', ',']).to_owned())?;

    // A code is short, upper-case, grouped by a dash, and alone on its line. The
    // link is on its own line too, which is why this looks at whole lines: a
    // word-level scan would happily return a fragment of a URL.
    let user_code = plain
        .lines()
        .map(str::trim)
        .find(|line| is_user_code(line))?
        .to_owned();

    Some(DeviceCode {
        verification_uri,
        user_code,
        expires_in_seconds: parse_expiry(&plain).unwrap_or(DEFAULT_EXPIRY).as_secs(),
    })
}

/// `RCB8-M9COT`: groups of upper-case letters and digits joined by dashes.
fn is_user_code(line: &str) -> bool {
    if !(6..=32).contains(&line.len()) || !line.contains('-') {
        return false;
    }
    let groups: Vec<&str> = line.split('-').collect();
    if groups.len() < 2 {
        return false;
    }
    groups.iter().all(|group| {
        !group.is_empty()
            && group
                .chars()
                .all(|c| c.is_ascii_digit() || c.is_ascii_uppercase())
    })
}

/// `(expires in 15 minutes)`, in whatever unit it is offered.
fn parse_expiry(plain: &str) -> Option<Duration> {
    let start = plain.find("expires in ")? + "expires in ".len();
    let rest = &plain[start..];
    let mut words = rest.split_whitespace();
    let amount: u64 = words.next()?.parse().ok()?;
    let unit = words.next()?.trim_end_matches([')', '.', ',']);
    let seconds = match unit {
        u if u.starts_with("second") => amount,
        u if u.starts_with("minute") => amount * 60,
        u if u.starts_with("hour") => amount * 3600,
        _ => return None,
    };
    Some(Duration::from_secs(seconds))
}

/// Remove the colouring the CLI writes for a terminal.
///
/// The code and the link are both wrapped in it, so a parser that did not do
/// this would return `\x1b[94mRCB8-M9COT\x1b[0m` and a person would type the
/// escape sequence into a web form.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        // CSI sequences end at the first byte in @..~; anything else is a short
        // escape whose single next character is consumed.
        if let Some('[') = chars.next() {
            for c in chars.by_ref() {
                if ('\u{40}'..='\u{7e}').contains(&c) {
                    break;
                }
            }
        }
    }
    out
}

/// Whether a Hermes home holds a pooled credential. Used by the installer's own
/// reporting, which must not open the file either.
pub fn credential_present(hermes_home: &Path) -> bool {
    hermes_home.join("auth.json").exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A Node with a runtime present, so its capability snapshot offers the one
    /// provider it actually implements.
    fn node_with_runtime() -> (tempfile::TempDir, Provider) {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let binary = root.path().join("hermes");
        // Runnable: a login that is meant to start has to be able to spawn, and
        // a stub that merely exists refuses for the wrong reason.
        std::fs::write(&binary, "#!/bin/sh\nsleep 30\n").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::create_dir_all(root.path().join("node")).unwrap();
        let provider = Provider::new(
            ProviderPaths {
                hermes_home: root.path().join("hermes-home"),
                hermes_binary: binary,
            },
            root.path().to_path_buf(),
        );
        (root, provider)
    }

    /// A credential put into the registry directly, as one that already exists.
    async fn existing_credential(
        provider: &Provider,
        state: crate::credentials::CredentialState,
    ) -> String {
        let credential_id = "cred-0011aabbccddeeff".to_owned();
        crate::credential_homes::create_home(
            &provider.credential_root,
            &credential_id,
            provider.runtime_uid,
        )
        .unwrap();
        let mut registry = provider.registry.lock().await;
        registry.credentials.push(crate::credentials::Credential {
            id: credential_id.clone(),
            provider_id: "openai-codex".to_owned(),
            auth_method: "device_authorization".to_owned(),
            label: "Work account".to_owned(),
            state,
            storage: crate::credentials::CredentialStorage::Isolated,
            generation: 0,
            pool_entry: None,
            created_at: 1,
            updated_at: 1,
        });
        provider.persist(&registry);
        credential_id
    }

    /// The whole point of the feature, asserted rather than described.
    #[tokio::test]
    async fn logging_in_again_keeps_the_credential_it_is_for() {
        let (_root, provider) = node_with_runtime();
        let credential_id = existing_credential(
            &provider,
            crate::credentials::CredentialState::ReauthorizationRequired,
        )
        .await;
        let before = provider
            .registry
            .lock()
            .await
            .get(&credential_id)
            .cloned()
            .unwrap();

        provider
            .reauthorize_credential(&credential_id, Some("cmd-1"))
            .await
            .unwrap();

        let registry = provider.registry.lock().await;
        assert_eq!(registry.credentials.len(), 1, "no second credential exists");
        let after = registry.get(&credential_id).unwrap();
        assert_eq!(after.id, before.id);
        assert_eq!(after.label, before.label);
        assert_eq!(after.provider_id, before.provider_id);
        assert_eq!(after.auth_method, before.auth_method);
        assert_eq!(after.storage, before.storage);
        assert_eq!(after.created_at, before.created_at);
        assert_eq!(
            after.state,
            crate::credentials::CredentialState::Reauthorizing
        );
        // And the home it addresses is the one it always had.
        assert_eq!(
            crate::credential_homes::home(&provider.credential_root, &credential_id).unwrap(),
            provider.credential_root.join(&credential_id)
        );
    }

    /// A cancelled replacement is not a failure of the credential.
    #[tokio::test]
    async fn cancelling_a_replacement_leaves_the_credential_as_it_was() {
        let (_root, provider) = node_with_runtime();
        let credential_id = existing_credential(
            &provider,
            crate::credentials::CredentialState::ReauthorizationRequired,
        )
        .await;
        provider
            .reauthorize_credential(&credential_id, Some("cmd-1"))
            .await
            .unwrap();

        provider.cancel_credential(&credential_id).await.unwrap();

        let registry = provider.registry.lock().await;
        let after = registry.get(&credential_id).unwrap();
        // Not `failed`: the credential still holds exactly what it held, and
        // whether that works is the question the attempt did not answer.
        assert_ne!(after.state, crate::credentials::CredentialState::Failed);
        assert_eq!(
            after.state,
            crate::credentials::CredentialState::RuntimeMissing,
            "no runtime record was ever written in this test's home"
        );
    }

    /// One login at a time, whichever kind it is.
    #[tokio::test]
    async fn a_replacement_and_a_new_login_cannot_both_be_waiting() {
        let (_root, provider) = node_with_runtime();
        let credential_id =
            existing_credential(&provider, crate::credentials::CredentialState::Authorized).await;
        provider
            .reauthorize_credential(&credential_id, Some("cmd-1"))
            .await
            .unwrap();

        let second = provider
            .authorize_credential("openai-codex", "device_authorization", "Another", None)
            .await
            .unwrap_err();
        assert_eq!(second.code, "authorization_in_progress");

        let again = provider
            .reauthorize_credential(&credential_id, Some("cmd-2"))
            .await
            .unwrap_err();
        assert_eq!(again.code, "authorization_in_progress");
    }

    /// A credential taken away on purpose is not brought back by a login.
    #[tokio::test]
    async fn a_revoked_credential_is_not_reauthorizable() {
        let (_root, provider) = node_with_runtime();
        let credential_id =
            existing_credential(&provider, crate::credentials::CredentialState::Revoked).await;
        let refused = provider
            .reauthorize_credential(&credential_id, Some("cmd-1"))
            .await
            .unwrap_err();
        assert_eq!(refused.code, "credential_not_reauthorizable");
    }

    #[tokio::test]
    async fn a_credential_this_node_does_not_hold_is_refused() {
        let (_root, provider) = node_with_runtime();
        let refused = provider
            .reauthorize_credential("cred-ffffffffffffffff", Some("cmd-1"))
            .await
            .unwrap_err();
        assert_eq!(refused.code, "credential_not_found");
    }

    /// The failure this generation counter exists to prevent.
    ///
    /// A run that began before a reauthorization finishes afterwards and
    /// reports the grant it was using as dead. That grant is not the one the
    /// credential holds now, and applying the report would break a credential
    /// that had just been fixed.
    #[tokio::test]
    async fn a_run_from_before_a_replacement_cannot_break_what_replaced_it() {
        let (_root, provider) = node_with_runtime();
        let credential_id =
            existing_credential(&provider, crate::credentials::CredentialState::Authorized).await;
        let started_under = provider
            .credential_generation(&credential_id)
            .await
            .unwrap();

        // The credential is replaced while that run is still going.
        provider.accept_reauthorization(&credential_id).await;
        let now_on = provider
            .credential_generation(&credential_id)
            .await
            .unwrap();
        assert_eq!(now_on, started_under + 1);

        // The old run finally reports.
        let applied = provider
            .report_grant_dead(&credential_id, started_under)
            .await;
        assert!(
            !applied,
            "a report about replaced material must not be applied"
        );
        assert_eq!(
            provider
                .registry
                .lock()
                .await
                .get(&credential_id)
                .unwrap()
                .state,
            crate::credentials::CredentialState::Authorized
        );

        // A report about the material it actually holds is applied.
        assert!(provider.report_grant_dead(&credential_id, now_on).await);
        assert_eq!(
            provider
                .registry
                .lock()
                .await
                .get(&credential_id)
                .unwrap()
                .state,
            crate::credentials::CredentialState::ReauthorizationRequired
        );
    }

    /// A report must not land on a login that is happening right now.
    #[tokio::test]
    async fn a_report_never_interrupts_a_login_in_flight() {
        let (_root, provider) = node_with_runtime();
        let credential_id =
            existing_credential(&provider, crate::credentials::CredentialState::Authorized).await;
        let generation = provider
            .credential_generation(&credential_id)
            .await
            .unwrap();
        provider
            .reauthorize_credential(&credential_id, Some("cmd-1"))
            .await
            .unwrap();

        assert!(!provider.report_grant_dead(&credential_id, generation).await);
        assert_eq!(
            provider
                .registry
                .lock()
                .await
                .get(&credential_id)
                .unwrap()
                .state,
            crate::credentials::CredentialState::Reauthorizing
        );
    }

    /// A credential being replaced cannot be used to start work.
    #[tokio::test]
    async fn no_run_may_start_against_a_credential_being_replaced() {
        let (_root, provider) = node_with_runtime();
        let credential_id =
            existing_credential(&provider, crate::credentials::CredentialState::Authorized).await;
        provider
            .reauthorize_credential(&credential_id, Some("cmd-1"))
            .await
            .unwrap();

        let refused = provider.usable(&credential_id).await.unwrap_err();
        assert_eq!(refused.code, "credential_reauthorizing");
    }

    /// The two unusable states say different things, and both are actionable.
    #[tokio::test]
    async fn a_dead_grant_and_a_missing_record_refuse_runs_differently() {
        let (_root, provider) = node_with_runtime();
        let credential_id = existing_credential(
            &provider,
            crate::credentials::CredentialState::ReauthorizationRequired,
        )
        .await;
        assert_eq!(
            provider.usable(&credential_id).await.unwrap_err().code,
            "credential_reauthorization_required"
        );

        provider
            .mark(
                &credential_id,
                crate::credentials::CredentialState::RuntimeMissing,
            )
            .await;
        assert_eq!(
            provider.usable(&credential_id).await.unwrap_err().code,
            "credential_runtime_missing"
        );
    }

    /// The Node is the final authority, and this is what that means in code: a
    /// Control Plane asking for something the Node never published is refused
    /// here, before anything is spawned and before a registry row exists.
    #[tokio::test]
    async fn a_provider_this_node_never_reported_is_refused() {
        let (_root, provider) = node_with_runtime();
        for unknown in ["anthropic", "acme-llm", "openai", ""] {
            let refused = provider
                .authorize_credential(unknown, "device_authorization", "Second", None)
                .await;
            assert!(refused.is_err(), "{unknown} must be refused");
        }
        assert!(provider.registry.lock().await.credentials.is_empty());
    }

    /// The API-key case, which is the one that matters: Hermes accepts the flag,
    /// Asterism does not implement the path, so the Node does not report it and
    /// must not perform it however convincingly it is asked.
    #[tokio::test]
    async fn an_authentication_method_this_node_never_reported_is_refused() {
        let (_root, provider) = node_with_runtime();
        for unknown in ["api_key", "api-key", "oauth", "smartcard", ""] {
            let refused = provider
                .authorize_credential("openai-codex", unknown, "Second", None)
                .await;
            assert!(refused.is_err(), "{unknown} must be refused");
        }
        assert!(provider.registry.lock().await.credentials.is_empty());
    }

    /// A host whose runtime is not installed reports the provider unavailable,
    /// and an unavailable provider cannot be authorized.
    #[tokio::test]
    async fn a_provider_that_is_not_available_cannot_be_authorized() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("node")).unwrap();
        let provider = Provider::new(
            ProviderPaths {
                hermes_home: root.path().join("hermes-home"),
                hermes_binary: root.path().join("absent"),
            },
            root.path().to_path_buf(),
        );
        assert!(
            provider
                .authorize_credential("openai-codex", "device_authorization", "Second", None)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn a_label_that_is_not_usable_is_refused_before_anything_is_created() {
        let (_root, provider) = node_with_runtime();
        for bad in ["", "   ", &"x".repeat(65), "two\nlines"] {
            assert!(
                provider
                    .authorize_credential("openai-codex", "device_authorization", bad, None)
                    .await
                    .is_err(),
                "{bad:?}"
            );
        }
        assert!(provider.registry.lock().await.credentials.is_empty());
    }

    #[tokio::test]
    async fn renaming_and_revoking_refuse_a_credential_this_node_does_not_have() {
        let (_root, provider) = node_with_runtime();
        assert!(provider.rename_credential("cred-00", "New").await.is_err());
        assert!(provider.revoke_credential("cred-00").await.is_err());
        // And an id that is not an id at all never reaches a lookup.
        assert!(provider.rename_credential("../etc", "New").await.is_err());
        assert!(provider.revoke_credential("a/b").await.is_err());
    }

    /// Renaming touches one credential and nothing else about it.
    #[tokio::test]
    async fn renaming_changes_the_label_and_leaves_everything_else() {
        let (root, provider) = node_with_runtime();
        {
            let mut registry = provider.registry.lock().await;
            registry.reconcile(
                "openai-codex",
                &[
                    crate::credentials::PoolEntry {
                        id: "openai-codex-oauth-1".to_owned(),
                        kind: "oauth".to_owned(),
                    },
                    crate::credentials::PoolEntry {
                        id: "openai-codex-oauth-2".to_owned(),
                        kind: "oauth".to_owned(),
                    },
                ],
                100,
            );
        }
        let (first, second) = {
            let registry = provider.registry.lock().await;
            (
                registry.credentials[0].clone(),
                registry.credentials[1].clone(),
            )
        };

        provider
            .rename_credential(&second.id, "Personal account")
            .await
            .unwrap();

        let registry = provider.registry.lock().await;
        assert_eq!(
            registry.get(&first.id).unwrap(),
            &first,
            "the other one is untouched"
        );
        let renamed = registry.get(&second.id).unwrap();
        assert_eq!(renamed.label, "Personal account");
        assert_eq!(renamed.state, second.state);
        assert_eq!(renamed.pool_entry, second.pool_entry);
        // And it survives a restart.
        drop(registry);
        let reloaded =
            crate::credentials::Registry::load(&crate::credentials::registry_path(root.path()));
        assert_eq!(reloaded.get(&second.id).unwrap().label, "Personal account");
    }

    /// The code the reader task records, once it has.
    async fn await_code(provider: &Provider) -> (String, String, DeviceCode) {
        for _ in 0..200 {
            if let Some(ready) = provider.deliverable_code().await {
                return ready;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the login never produced a code");
    }

    /// A login that prints its code and then keeps waiting for a person.
    async fn waiting_login(root: &Path) -> (Provider, String) {
        let provider = fake_cli(
            root,
            "echo 'Open https://auth.openai.com/codex/device'\necho 'RCB8-M9COT'\nsleep 30",
        );
        let credential_id = provider
            .authorize_credential(
                "openai-codex",
                "device_authorization",
                "Delivery",
                Some("cmd-1"),
            )
            .await
            .expect("a login");
        await_code(&provider).await;
        (provider, credential_id)
    }

    async fn state_of(
        provider: &Provider,
        credential_id: &str,
    ) -> crate::credentials::CredentialState {
        provider
            .registry
            .lock()
            .await
            .get(credential_id)
            .expect("the credential")
            .state
    }

    #[tokio::test]
    async fn a_confirmed_delivery_leaves_its_login_running_whatever_happens_to_the_session() {
        let root = tempfile::tempdir().unwrap();
        let (provider, id) = waiting_login(root.path()).await;
        let deadline = std::time::Instant::now() + Duration::from_secs(20);

        assert!(provider.delivery_sent(&id, "cmd-1", deadline).await);
        assert!(
            !provider.delivery_sent(&id, "cmd-1", deadline).await,
            "sent once"
        );
        assert!(!provider.acknowledge_delivery("cmd-other").await);
        assert!(provider.acknowledge_delivery("cmd-1").await);
        assert!(
            !provider.acknowledge_delivery("cmd-1").await,
            "confirmed once"
        );

        assert_eq!(
            provider
                .cancel_undelivered(false, std::time::Instant::now() + Duration::from_secs(600))
                .await,
            None
        );
        assert_eq!(
            provider
                .cancel_undelivered(true, std::time::Instant::now())
                .await,
            None
        );
        assert_eq!(
            provider.attempt_in_flight().await.as_deref(),
            Some(id.as_str())
        );
        provider.cancel_credential(&id).await.unwrap();
    }

    #[tokio::test]
    async fn a_code_the_session_never_confirmed_cancels_its_login_when_the_session_ends() {
        let root = tempfile::tempdir().unwrap();
        let (provider, id) = waiting_login(root.path()).await;
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        assert!(provider.delivery_sent(&id, "cmd-1", deadline).await);

        assert_eq!(
            provider
                .cancel_undelivered(true, std::time::Instant::now())
                .await,
            Some(id.clone())
        );
        assert_eq!(provider.attempt_in_flight().await, None);
        assert_eq!(
            state_of(&provider, &id).await,
            crate::credentials::CredentialState::Failed
        );
        // A confirmation that arrives afterwards revives nothing.
        assert!(!provider.acknowledge_delivery("cmd-1").await);
        // And a new login can start at once.
        let again = provider
            .authorize_credential(
                "openai-codex",
                "device_authorization",
                "Again",
                Some("cmd-2"),
            )
            .await
            .expect("a fresh login");
        provider.cancel_credential(&again).await.unwrap();
    }

    #[tokio::test]
    async fn a_code_unconfirmed_past_its_deadline_cancels_its_login_while_connected() {
        let root = tempfile::tempdir().unwrap();
        let (provider, id) = waiting_login(root.path()).await;
        let sent_at = std::time::Instant::now();
        assert!(
            provider
                .delivery_sent(&id, "cmd-1", sent_at + Duration::from_secs(20))
                .await
        );

        assert_eq!(provider.cancel_undelivered(false, sent_at).await, None);
        assert_eq!(
            provider
                .cancel_undelivered(false, sent_at + Duration::from_secs(21))
                .await,
            Some(id.clone())
        );
        assert_eq!(
            state_of(&provider, &id).await,
            crate::credentials::CredentialState::Failed
        );
    }

    #[tokio::test]
    async fn a_code_never_sent_is_cancelled_when_the_session_ends_and_not_before() {
        let root = tempfile::tempdir().unwrap();
        let (provider, id) = waiting_login(root.path()).await;

        assert_eq!(
            provider
                .cancel_undelivered(false, std::time::Instant::now() + Duration::from_secs(600))
                .await,
            None
        );
        assert_eq!(
            provider
                .cancel_undelivered(true, std::time::Instant::now())
                .await,
            Some(id)
        );
    }

    /// Captured from Codex CLI 0.147.0 on a real host, escapes and all. Written
    /// down rather than paraphrased: a parser tested against a tidied-up version
    /// of its input is tested against something it will never be given.
    const REAL_OUTPUT: &str = concat!(
        "WARNING: proceeding, even though we could not create PATH aliases\n",
        "\n",
        "Welcome to Codex [v\u{1b}[90m0.147.0\u{1b}[0m]\n",
        "\u{1b}[90mOpenAI's command-line coding agent\u{1b}[0m\n",
        "\n",
        "Follow these steps to sign in with ChatGPT using device code authorization:\n",
        "\n",
        "1. Open this link in your browser and sign in to your account\n",
        "   \u{1b}[94mhttps://auth.openai.com/codex/device\u{1b}[0m\n",
        "\n",
        "2. Enter this one-time code \u{1b}[90m(expires in 15 minutes)\u{1b}[0m\n",
        "   \u{1b}[94mRCB8-M9COT\u{1b}[0m\n",
    );

    #[test]
    fn the_real_cli_banner_yields_a_link_a_code_and_an_expiry() {
        let code = parse_device_code(REAL_OUTPUT).expect("the banner carries all three");
        assert_eq!(
            code.verification_uri,
            "https://auth.openai.com/codex/device"
        );
        assert_eq!(code.user_code, "RCB8-M9COT");
        assert_eq!(code.expires_in_seconds, 900);
    }

    /// Captured from `hermes auth add openai-codex --type oauth --no-browser`
    /// on a real host, escapes and all. Different prose from the Codex CLI's,
    /// no expiry line at all -- which is the point of parsing the two things
    /// that are a contract rather than the sentences around them.
    const HERMES_OUTPUT: &str = concat!(
        "To continue, follow these steps:\n",
        "\n",
        "  1. Open this URL in your browser:\n",
        "     \u{1b}[94mhttps://auth.openai.com/codex/device\u{1b}[0m\n",
        "\n",
        "  2. Enter this code:\n",
        "     \u{1b}[94mK7QP-3WZN\u{1b}[0m\n",
        "\n",
        "Waiting for sign-in... (press Ctrl+C to cancel)\n",
    );

    #[test]
    fn the_hermes_banner_yields_a_link_and_a_code_too() {
        let code = parse_device_code(HERMES_OUTPUT).expect("the banner carries both");
        assert_eq!(
            code.verification_uri,
            "https://auth.openai.com/codex/device"
        );
        assert_eq!(code.user_code, "K7QP-3WZN");
        // It says nothing about expiry, so the conservative default stands
        // rather than a guess that would leave a dead code on screen.
        assert_eq!(code.expires_in_seconds, 900);
    }

    #[test]
    fn nothing_the_parser_returns_still_carries_terminal_escapes() {
        let code = parse_device_code(REAL_OUTPUT).unwrap();
        // Typing an escape sequence into a web form is the failure this prevents.
        assert!(!code.user_code.contains('\u{1b}'), "{}", code.user_code);
        assert!(!code.verification_uri.contains('\u{1b}'));
    }

    #[test]
    fn a_banner_that_has_only_reached_the_link_is_not_yet_an_answer() {
        // The CLI prints the link first. Returning at that point would show a
        // person a page and no code to type into it.
        let partial = REAL_OUTPUT.split("2. Enter this").next().unwrap();
        assert_eq!(parse_device_code(partial), None);
    }

    #[test]
    fn prose_is_not_the_contract() {
        // The same two facts, none of the same sentences.
        let reworded = "Visit https://auth.openai.com/device\nCode:\n  WXYZ-1234\n";
        let code = parse_device_code(reworded).expect("a link and a code are enough");
        assert_eq!(code.verification_uri, "https://auth.openai.com/device");
        assert_eq!(code.user_code, "WXYZ-1234");
        // No expiry offered, so the conservative default stands rather than a
        // guess that would leave a dead code on screen.
        assert_eq!(code.expires_in_seconds, 900);
    }

    #[test]
    fn a_url_fragment_is_never_mistaken_for_a_code() {
        let text = "https://auth.openai.com/codex/device\nRCB8-M9COT\n";
        assert_eq!(parse_device_code(text).unwrap().user_code, "RCB8-M9COT");
    }

    #[test]
    fn lower_case_words_and_bare_sentences_are_not_codes() {
        for line in [
            "sign-in",
            "one-time code",
            "-",
            "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
            "https://auth.openai.com/codex/device",
        ] {
            assert!(!is_user_code(line), "{line}");
        }
        for line in ["RCB8-M9COT", "WXYZ-1234", "AB-CD-EF"] {
            assert!(is_user_code(line), "{line}");
        }
    }

    #[test]
    fn every_unit_the_cli_might_offer_is_understood() {
        assert_eq!(
            parse_expiry("(expires in 30 seconds)"),
            Some(Duration::from_secs(30))
        );
        assert_eq!(
            parse_expiry("(expires in 15 minutes)"),
            Some(Duration::from_secs(900))
        );
        assert_eq!(
            parse_expiry("(expires in 1 hour)"),
            Some(Duration::from_secs(3600))
        );
        assert_eq!(parse_expiry("expires in a while"), None);
    }

    #[test]
    fn a_host_with_no_provider_runtime_says_so_rather_than_asking_for_a_login() {
        let root = tempfile::tempdir().unwrap();
        let provider = Provider::new(
            ProviderPaths {
                hermes_home: root.path().join("hermes"),
                hermes_binary: root.path().join("nothing-here"),
            },
            root.path().to_path_buf(),
        );
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        assert_eq!(
            runtime.block_on(provider.state()),
            ProviderState::Unavailable
        );
        assert!(runtime.block_on(provider.authorize()).is_err());
    }

    #[test]
    fn the_credential_a_run_reads_is_the_one_that_counts() {
        // Not the Codex CLI session beside it. Those are two credentials in two
        // formats, and a host holding only the other reports itself authorized
        // and then fails every run with "No Codex credentials stored" -- which
        // is exactly what happened on the host this was written for.
        let root = tempfile::tempdir().unwrap();
        let binary = root.path().join("hermes");
        std::fs::write(&binary, "#!/bin/sh\n").unwrap();
        let hermes_home = root.path().join("hermes-home");
        std::fs::create_dir_all(hermes_home.join(".codex")).unwrap();
        // A Codex CLI session, and nothing the provider pool can use.
        std::fs::write(hermes_home.join(".codex/auth.json"), "{}").unwrap();

        let provider = Provider::new(
            ProviderPaths {
                hermes_home: hermes_home.clone(),
                hermes_binary: binary,
            },
            root.path().to_path_buf(),
        );
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        assert_eq!(runtime.block_on(provider.state()), ProviderState::Required);

        // The pooled credential, where Hermes keeps it.
        std::fs::write(hermes_home.join("auth.json"), "{}").unwrap();
        assert_eq!(
            runtime.block_on(provider.state()),
            ProviderState::Authorized
        );
        assert!(runtime.block_on(provider.authorize()).is_err());
    }

    #[test]
    fn a_host_that_is_merely_unauthorized_is_required_not_failed() {
        let root = tempfile::tempdir().unwrap();
        let binary = root.path().join("codex");
        std::fs::write(&binary, "#!/bin/sh\n").unwrap();
        let provider = Provider::new(
            ProviderPaths {
                hermes_home: root.path().join("hermes"),
                hermes_binary: binary,
            },
            root.path().to_path_buf(),
        );
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        assert_eq!(runtime.block_on(provider.state()), ProviderState::Required);
    }

    /// A stand-in for the Codex CLI, so the flow can be exercised without a real
    /// device authorization. Takes the shell body to run.
    fn fake_cli(root: &Path, body: &str) -> Provider {
        use std::os::unix::fs::PermissionsExt;
        let binary = root.join("codex");
        std::fs::write(&binary, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        Provider::new(
            ProviderPaths {
                hermes_home: root.join("hermes"),
                hermes_binary: binary,
            },
            root.to_path_buf(),
        )
    }

    /// Drive a login for a new credential, the way the Control Plane does, and
    /// wait for the code the reader task records.
    fn begin(runtime: &tokio::runtime::Runtime, provider: &Provider) -> Result<DeviceCode> {
        runtime.block_on(async {
            provider
                .authorize_credential(
                    "openai-codex",
                    "device_authorization",
                    "Second",
                    Some("cmd-begin"),
                )
                .await
                .map_err(|refusal| anyhow::anyhow!("{refusal}"))?;
            Ok(await_code(provider).await.2)
        })
    }

    /// A stand-in for Hermes that behaves like the real one where it matters:
    /// `auth add` prints a code, waits, and writes a private store into
    /// `HERMES_HOME`; `auth list` reports an entry only when that store exists.
    /// It also writes down which directories it was told to use, and the name
    /// it was told to give the entry.
    const ISOLATED_HERMES: &str = r#"
case "$1 $2" in
  "auth add")
    echo 'Open https://auth.openai.com/codex/device'
    echo 'RCB8-M9COT'
    sleep 0.2
    umask 077
    printf '{"credential_pool":{}}' > "$HERMES_HOME/auth.json"
    printf '%s\n%s\n%s\n%s\n' "$HOME" "$CODEX_HOME" "$XDG_CONFIG_HOME" "$7" > "$HERMES_HOME/seen"
    ;;
  "auth list")
    [ -s "$HERMES_HOME/auth.json" ] && echo '  #1  entry oauth   device_code'
    ;;
  "auth remove")
    rm -f "$HERMES_HOME/auth.json"
    ;;
esac
exit 0
"#;

    #[test]
    fn a_new_credential_is_authorized_into_its_own_home_and_nowhere_else() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let provider = fake_cli(root.path(), ISOLATED_HERMES);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        let credential_id = runtime
            .block_on(provider.authorize_credential(
                "openai-codex",
                "device_authorization",
                "Second account",
                Some("cmd-new"),
            ))
            .expect("a login");
        let code = runtime.block_on(await_code(&provider)).2;
        assert_eq!(code.user_code, "RCB8-M9COT");
        let home = root.path().join("credentials").join(&credential_id);

        let listed = runtime.block_on(async {
            for _ in 0..100 {
                let listed = provider.list_credentials().await.unwrap();
                if listed[0].state != "authorizing" {
                    return listed;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            provider.list_credentials().await.unwrap()
        });
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, credential_id);
        assert_eq!(listed[0].state, "authorized");
        assert_eq!(listed[0].storage, "isolated");
        assert_eq!(listed[0].label, "Second account");

        // Every directory Hermes resolves anything from was the home, and the
        // entry was named after the id rather than the label.
        let seen = std::fs::read_to_string(home.join("seen")).unwrap();
        assert_eq!(
            seen.lines().collect::<Vec<_>>(),
            vec![
                home.to_str().unwrap(),
                home.join(".codex").to_str().unwrap(),
                home.to_str().unwrap(),
                credential_id.as_str(),
            ]
        );
        // The store is where it was written and private; the shared pool was
        // never created.
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&home.join("auth.json")), 0o600);
        assert_eq!(mode(&home), 0o700);
        assert_eq!(mode(&root.path().join("credentials")), 0o700);
        assert!(!root.path().join("hermes").exists());

        // It is a credential a project can select, and renaming it changes
        // nothing a project depends on.
        assert_eq!(
            runtime.block_on(provider.usable(&credential_id)),
            Ok("openai-codex".to_owned())
        );
        runtime
            .block_on(provider.rename_credential(&credential_id, "Renamed"))
            .unwrap();
        assert_eq!(
            runtime.block_on(provider.usable(&credential_id)),
            Ok("openai-codex".to_owned())
        );

        // Revoking goes through Hermes inside that home, and the credential is
        // not usable afterwards.
        runtime
            .block_on(provider.revoke_credential(&credential_id))
            .unwrap();
        assert!(!home.join("auth.json").exists());
        assert_eq!(
            runtime
                .block_on(provider.usable(&credential_id))
                .unwrap_err()
                .code,
            "credential_not_authorized"
        );
    }

    /// Neither an adopted pool entry nor an id this Node never issued can be
    /// given to a project, and a path is not an id however it is spelled.
    #[tokio::test]
    async fn a_pool_entry_or_an_unknown_id_is_never_usable_by_a_project() {
        let (_root, provider) = node_with_runtime();
        provider.registry.lock().await.reconcile(
            "openai-codex",
            &[crate::credentials::PoolEntry {
                id: "openai-codex-oauth-1".to_owned(),
                kind: "oauth".to_owned(),
            }],
            100,
        );
        let adopted = provider.registry.lock().await.credentials[0].id.clone();
        assert_eq!(
            provider.usable(&adopted).await.unwrap_err().code,
            "credential_not_isolated"
        );
        assert_eq!(
            provider
                .usable("cred-00000000deadbeef")
                .await
                .unwrap_err()
                .code,
            "credential_not_found"
        );
        for hostile in ["../hermes", "cred/../../etc", "", "CRED", "/etc/passwd"] {
            assert_eq!(
                provider.usable(hostile).await.unwrap_err().code,
                "credential_id_invalid",
                "{hostile:?}"
            );
        }
    }

    #[tokio::test]
    async fn an_isolated_credential_whose_store_is_gone_stops_being_usable() {
        use std::os::unix::fs::PermissionsExt;
        let (_root, provider) = node_with_runtime();
        let id = "cred-0011aabbccddeeff";
        let home = crate::credential_homes::create_home(
            provider.credential_root(),
            id,
            provider.runtime_uid(),
        )
        .unwrap();
        std::fs::write(home.join("auth.json"), b"{}").unwrap();
        std::fs::set_permissions(
            home.join("auth.json"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        provider
            .registry
            .lock()
            .await
            .credentials
            .push(crate::credentials::Credential {
                id: id.to_owned(),
                provider_id: "openai-codex".to_owned(),
                auth_method: "device_authorization".to_owned(),
                label: "Work".to_owned(),
                state: crate::credentials::CredentialState::Authorized,
                storage: crate::credentials::CredentialStorage::Isolated,
                pool_entry: None,
                generation: 0,
                created_at: 1,
                updated_at: 1,
            });
        assert!(provider.usable(id).await.is_ok());
        assert_eq!(
            provider.list_credentials().await.unwrap()[0].state,
            "authorized"
        );

        std::fs::remove_file(home.join("auth.json")).unwrap();
        assert_eq!(
            provider.usable(id).await.unwrap_err().code,
            "credential_unavailable"
        );
        assert_eq!(
            provider.list_credentials().await.unwrap()[0].state,
            "required"
        );
        assert_eq!(
            provider.usable(id).await.unwrap_err().code,
            "credential_not_authorized"
        );

        std::fs::remove_dir_all(&home).unwrap();
        provider.registry.lock().await.credentials[0].state =
            crate::credentials::CredentialState::Authorized;
        assert_eq!(
            provider.usable(id).await.unwrap_err().code,
            "credential_home_missing"
        );
    }

    #[test]
    fn a_cli_that_finishes_with_stderr_first_still_gets_its_code_read() {
        // The failure this prevents: one stream reaching its end is not the end
        // of the output. Reading them as one abandons the login the moment the
        // CLI is done warning, and reports "it offered no code" while the code
        // is still on its way down stdout.
        let root = tempfile::tempdir().unwrap();
        let provider = fake_cli(
            root.path(),
            "echo 'WARNING: something' >&2\n\
             exec 2>&-\n\
             sleep 0.2\n\
             echo 'Open https://auth.openai.com/codex/device'\n\
             echo 'RCB8-M9COT'\n\
             sleep 30",
        );
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        let code = begin(&runtime, &provider).expect("a code");
        assert_eq!(code.user_code, "RCB8-M9COT");
        assert_eq!(
            code.verification_uri,
            "https://auth.openai.com/codex/device"
        );
        // And the credential is now waiting for a person, not idle.
        let listed = runtime.block_on(provider.list_credentials()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].state, "authorizing");
        assert_eq!(listed[0].storage, "isolated");
        // Cancelling leaves it somewhere a person can start again from.
        assert_eq!(runtime.block_on(provider.cancel()), ProviderState::Required);
    }

    #[test]
    fn the_login_outlives_the_code_it_printed() {
        // The failure this prevents cost a real authorization. The code was
        // read, the readers were dropped, the pipes closed, and the CLI died of
        // SIGPIPE on its next write -- which it makes repeatedly while polling
        // for the approval. A person was shown a valid code with nothing left
        // listening for their answer.
        //
        // So the fake CLI keeps writing after the code, exactly as the real one
        // does, and then records that it survived long enough to finish.
        let root = tempfile::tempdir().unwrap();
        let done = root.path().join("survived");
        let provider = fake_cli(
            root.path(),
            &format!(
                "echo 'Open https://auth.openai.com/codex/device'\n\
                 echo 'RCB8-M9COT'\n\
                 i=0\n\
                 while [ $i -lt 40 ]; do echo \"polling $i\"; i=$((i+1)); sleep 0.05; done\n\
                 touch {}\n",
                done.display()
            ),
        );
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        let code = begin(&runtime, &provider).expect("a code");
        assert_eq!(code.user_code, "RCB8-M9COT");

        // Long enough for a CLI that was going to die of SIGPIPE to have done
        // so, and for one that lives to reach the end of its output.
        runtime.block_on(async {
            for _ in 0..100 {
                if done.exists() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        });
        assert!(
            done.exists(),
            "the CLI did not survive printing the code; it wrote {} lines and stopped",
            "some"
        );

        runtime.block_on(provider.cancel());
    }

    #[test]
    fn a_cli_that_exits_without_a_code_says_what_it_last_said() {
        let root = tempfile::tempdir().unwrap();
        let provider = fake_cli(
            root.path(),
            "echo 'could not reach the provider' >&2\nexit 1",
        );
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        // The command answers as soon as the login is running, so a CLI that
        // fails afterwards is not a failed command: it is a credential that
        // never got a code, and the console sees it as one.
        let credential_id = runtime
            .block_on(provider.authorize_credential(
                "openai-codex",
                "device_authorization",
                "Second",
                Some("cmd-dead"),
            ))
            .expect("the login starts");

        let settled = runtime.block_on(async {
            for _ in 0..200 {
                if state_of(&provider, &credential_id).await
                    == crate::credentials::CredentialState::Failed
                {
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            false
        });
        assert!(settled, "a login that produced no code must end as failed");

        // Nothing is left running, the host is not stuck claiming to be waiting
        // for an approval nobody was ever asked for, and the slot is free.
        assert_eq!(runtime.block_on(provider.state()), ProviderState::Required);
        assert!(runtime.block_on(provider.attempt_in_flight()).is_none());
        assert!(runtime.block_on(provider.deliverable_code()).is_none());
    }

    /// The production failure, in one test: a provider that takes longer than a
    /// minute to print a code. The command must answer at once, the code must
    /// still arrive, and nothing about the Node may be held up meanwhile.
    #[tokio::test]
    async fn a_login_that_takes_over_a_minute_still_delivers_its_code() {
        let root = tempfile::tempdir().unwrap();
        // The code is printed after a wait; `sleep` stands in for the provider
        // thinking. Scaled down in test time, unbounded in what it proves: the
        // attempt lock is not held across it.
        let provider = fake_cli(
            root.path(),
            "sleep 0.6
echo 'Open https://auth.openai.com/codex/device'
echo 'RCB8-M9COT'
sleep 30",
        );

        let started = std::time::Instant::now();
        let credential_id = provider
            .authorize_credential(
                "openai-codex",
                "device_authorization",
                "Slow provider",
                Some("cmd-slow"),
            )
            .await
            .expect("the login starts");
        let answered = started.elapsed();
        assert!(
            answered < Duration::from_millis(400),
            "the command answered in {answered:?}, so it waited for the code"
        );
        // Nothing to deliver yet, and the credential is visibly waiting.
        assert!(provider.deliverable_code().await.is_none());
        assert_eq!(
            state_of(&provider, &credential_id).await,
            crate::credentials::CredentialState::Authorizing
        );

        // While it is producing, the Node keeps answering about its
        // credentials rather than queueing behind the provider subprocess.
        let listed = tokio::time::timeout(Duration::from_secs(5), provider.list_credentials())
            .await
            .expect("listing must not wait for the login")
            .expect("a list");
        assert!(listed.iter().any(|entry| entry.id == credential_id));

        let (command_id, credential, code) = await_code(&provider).await;
        assert_eq!(command_id, "cmd-slow");
        assert_eq!(credential, credential_id);
        assert_eq!(code.user_code, "RCB8-M9COT");
    }

    /// A login waiting for a person is cancelled the moment somebody asks,
    /// not when the provider gets around to exiting.
    #[tokio::test]
    async fn a_login_in_flight_does_not_block_its_own_cancellation() {
        let root = tempfile::tempdir().unwrap();
        let (provider, credential_id) = waiting_login(root.path()).await;

        let started = std::time::Instant::now();
        tokio::time::timeout(
            Duration::from_secs(2),
            provider.cancel_credential(&credential_id),
        )
        .await
        .expect("cancellation must not wait for the login")
        .expect("cancelled");
        assert!(started.elapsed() < Duration::from_secs(2));

        assert_eq!(
            state_of(&provider, &credential_id).await,
            crate::credentials::CredentialState::Failed
        );
        assert!(provider.attempt_in_flight().await.is_none());
        assert!(provider.deliverable_code().await.is_none());
    }

    /// A second attempt is refused immediately, with a code a console can act
    /// on, and it does not disturb the login already waiting.
    #[tokio::test]
    async fn a_second_authorization_fails_immediately_with_a_typed_reason() {
        let root = tempfile::tempdir().unwrap();
        let (provider, first) = waiting_login(root.path()).await;

        let started = std::time::Instant::now();
        let refusal = tokio::time::timeout(
            Duration::from_secs(2),
            provider.authorize_credential(
                "openai-codex",
                "device_authorization",
                "Second attempt",
                Some("cmd-second"),
            ),
        )
        .await
        .expect("a second attempt must not wait")
        .expect_err("a second attempt must be refused");
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(refusal.code, "authorization_in_progress");
        assert!(
            refusal
                .to_string()
                .starts_with("authorization_in_progress: ")
        );

        // The first login is untouched, and no second credential was created.
        assert_eq!(
            state_of(&provider, &first).await,
            crate::credentials::CredentialState::Authorizing
        );
        assert_eq!(provider.registry.lock().await.credentials.len(), 1);
    }

    #[test]
    fn a_second_login_is_refused_while_one_is_out() {
        // Issuing a new one would invalidate the code the first person is
        // looking at, in a browser that still shows it as pending.
        let root = tempfile::tempdir().unwrap();
        let provider = fake_cli(
            root.path(),
            "echo 'Open https://auth.openai.com/codex/device'\n\
             echo \"$(cat $CODEX_HOME/../n 2>/dev/null || echo AAAA-1111)\"\n\
             sleep 30",
        );
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        let first = begin(&runtime, &provider).expect("a code");
        assert_eq!(first.user_code, "AAAA-1111");
        assert!(begin(&runtime, &provider).is_err());
        // Refused before anything was made: one credential, one home.
        let listed = runtime.block_on(provider.list_credentials()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(
            std::fs::read_dir(root.path().join("credentials"))
                .unwrap()
                .count(),
            1
        );

        // Ended inside the runtime rather than left to Drop. A `Child` with
        // `kill_on_drop` needs the reactor to reap it, and a provider still
        // holding one is dropped *after* the runtime here -- which panics on a
        // machine whose timing differs from the one this was written on.
        runtime.block_on(provider.cancel());
    }

    #[test]
    fn the_capability_that_makes_the_console_offer_the_control_is_advertised() {
        // Without this exact field the Control Plane treats the Node as one that
        // would ignore the command, never asks for its status, and the console
        // renders a panel with no button. The whole feature is invisible, and
        // nothing anywhere reports an error.
        let provider = Provider::on_this_host();
        let advertised = provider.capabilities();
        assert_eq!(advertised["device_authorization"], serde_json::json!(true));
        assert_eq!(advertised["kind"], serde_json::json!("openai-codex"));
    }

    #[test]
    fn the_states_are_spelled_the_way_the_protocol_spells_them() {
        assert_eq!(ProviderState::Unavailable.as_str(), "unavailable");
        assert_eq!(ProviderState::Required.as_str(), "required");
        assert_eq!(ProviderState::Authorizing.as_str(), "authorizing");
        assert_eq!(ProviderState::Authorized.as_str(), "authorized");
        assert_eq!(ProviderState::Failed.as_str(), "failed");
    }
}
