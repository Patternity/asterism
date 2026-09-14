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
    /// Bumped whenever an attempt is started or abandoned.
    ///
    /// An attempt that finishes checks that the world still expects it. Without
    /// this, a login somebody cancelled could come back minutes later and bind
    /// the credential a *different* login had just created -- the classic
    /// late-arrival that overwrites the thing that replaced it.
    generation: Arc<std::sync::atomic::AtomicU64>,
}

struct Attempt {
    child: Child,
    code: DeviceCode,
    /// Which credential this login is for.
    credential_id: String,
    generation: u64,
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
        command
            .spawn()
            .with_context(|| format!("cannot run {}", self.paths.hermes_binary.display()))
    }

    /// Read the banner, then keep the pipes drained for the rest of the login.
    async fn take_device_code(child: &mut Child) -> Result<DeviceCode> {
        let (code, (mut out, mut err)) = read_device_code(child).await?;
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

    /// Start a login for one credential, or hand back the one already in flight.
    async fn begin_login(
        &self,
        provider_id: &str,
        credential_id: &str,
        home: &Path,
    ) -> Result<DeviceCode> {
        let mut attempt = self.attempt.lock().await;
        // A second request while one is in flight is answered with the code that
        // is already out, not with a new one that would invalidate it.
        if let Some(running) = attempt.as_mut()
            && matches!(running.child.try_wait(), Ok(None))
        {
            if running.credential_id != credential_id {
                bail!(
                    "another authorization is already in flight on this Node; \
                     cancel it before starting a second"
                );
            }
            return Ok(running.code.clone());
        }
        *attempt = None;

        let generation = self
            .generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        let mut child = self.spawn_login(provider_id, credential_id, home)?;
        let code = match Self::take_device_code(&mut child).await {
            Ok(code) => code,
            Err(error) => {
                // Nothing is left polling for an approval nobody can give.
                let _ = child.start_kill();
                return Err(error);
            }
        };

        *attempt = Some(Attempt {
            child,
            code: code.clone(),
            credential_id: credential_id.to_owned(),
            generation,
        });
        Ok(code)
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
    ) -> Result<(String, DeviceCode)> {
        crate::credentials::validate_label(label)?;
        let label = label.trim();

        let snapshot = crate::providercaps::snapshot(
            &self.paths.hermes_binary,
            crate::control::software_version(),
        );
        let supported = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == provider_id)
            .ok_or_else(|| {
                anyhow::anyhow!("this Node does not support the provider {provider_id:?}")
            })?;
        if supported.availability != crate::providercaps::Availability::Available {
            bail!("the provider {provider_id:?} is not available on this Node");
        }
        if !supported
            .auth_methods
            .iter()
            .any(|method| method.wire() == auth_method)
        {
            bail!("this Node does not support {auth_method:?} for {provider_id:?}");
        }

        // Refused before anything exists. A second login would invalidate the
        // code the first person is looking at, and starting one here would
        // leave behind a home and a failed row for an attempt that never ran.
        if self.attempt_in_flight().await.is_some() {
            bail!(
                "another authorization is already in flight on this Node; \
                 cancel it before starting a second"
            );
        }

        {
            let registry = self.registry.lock().await;
            if registry.credentials.len() >= crate::credentials::MAX_CREDENTIALS {
                bail!(
                    "this Node already holds {} credentials",
                    crate::credentials::MAX_CREDENTIALS
                );
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
        .context("cannot prepare a home for the new credential")?;
        {
            let mut registry = self.registry.lock().await;
            registry.credentials.push(crate::credentials::Credential {
                id: credential_id.clone(),
                provider_id: provider_id.to_owned(),
                auth_method: auth_method.to_owned(),
                label: label.to_owned(),
                state: crate::credentials::CredentialState::Authorizing,
                storage: crate::credentials::CredentialStorage::Isolated,
                pool_entry: None,
                created_at: now(),
                updated_at: now(),
            });
            self.persist(&registry);
        }

        match self.begin_login(provider_id, &credential_id, &home).await {
            Ok(code) => Ok((credential_id, code)),
            Err(error) => {
                self.mark(&credential_id, crate::credentials::CredentialState::Failed)
                    .await;
                Err(error)
            }
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
        self.abandon_attempt().await;
        self.mark(credential_id, crate::credentials::CredentialState::Failed)
            .await;
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
                        Some((running.credential_id, running.generation))
                    }
                },
                None => None,
            }
        };
        let (credential_id, generation) = finished?;
        if generation != self.generation.load(std::sync::atomic::Ordering::SeqCst) {
            // Somebody cancelled or started another login while this one was
            // finishing. It speaks for a world that no longer exists.
            return None;
        }
        Some(credential_id)
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
            // The CLI's own message, which names a provider and an entry and
            // never a token.
            bail!(
                "the provider runtime refused to remove the credential: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(())
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
        if state != CredentialState::Authorized
            || self.attempt_in_flight().await.as_deref() == Some(credential_id)
        {
            return Err(CredentialRefusal::new(
                "credential_not_authorized",
                "the credential is not authorized",
            ));
        }
        let snapshot = crate::providercaps::snapshot(
            &self.paths.hermes_binary,
            crate::control::software_version(),
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
                "the provider runtime refused to remove the credential: {}",
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

async fn read_device_code(child: &mut Child) -> Result<(DeviceCode, Streams)> {
    let stdout = child
        .stdout
        .take()
        .context("the provider CLI has no stdout")?;
    let stderr = child
        .stderr
        .take()
        .context("the provider CLI has no stderr")?;
    let mut out = BufReader::new(stdout).lines();
    let mut err = BufReader::new(stderr).lines();

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
        let root = tempfile::tempdir().unwrap();
        let binary = root.path().join("hermes");
        std::fs::write(&binary, "#!/bin/sh\nexit 0\n").unwrap();
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

    /// The Node is the final authority, and this is what that means in code: a
    /// Control Plane asking for something the Node never published is refused
    /// here, before anything is spawned and before a registry row exists.
    #[tokio::test]
    async fn a_provider_this_node_never_reported_is_refused() {
        let (_root, provider) = node_with_runtime();
        for unknown in ["anthropic", "acme-llm", "openai", ""] {
            let refused = provider
                .authorize_credential(unknown, "device_authorization", "Second")
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
                .authorize_credential("openai-codex", unknown, "Second")
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
                .authorize_credential("openai-codex", "device_authorization", "Second")
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
                    .authorize_credential("openai-codex", "device_authorization", bad)
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

    /// Drive a login for a new credential, the way the Control Plane does.
    fn begin(runtime: &tokio::runtime::Runtime, provider: &Provider) -> Result<DeviceCode> {
        runtime
            .block_on(provider.authorize_credential(
                "openai-codex",
                "device_authorization",
                "Second",
            ))
            .map(|(_, code)| code)
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

        let (credential_id, code) = runtime
            .block_on(provider.authorize_credential(
                "openai-codex",
                "device_authorization",
                "Second account",
            ))
            .expect("a code");
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

        let error = begin(&runtime, &provider).unwrap_err().to_string();
        assert!(error.contains("could not reach the provider"), "{error}");
        // Nothing is left running, and the host is not stuck claiming to be
        // waiting for an approval nobody was ever asked for.
        assert_eq!(runtime.block_on(provider.state()), ProviderState::Required);
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
