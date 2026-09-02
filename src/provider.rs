//! Authorizing this host's model provider, on command from the Control Plane.
//!
//! One credential per host. Every project on it reads the same file through a
//! reference of its own, which is why this is a Node-level operation and not a
//! project-level one: authorizing twice would not give two projects two
//! identities, it would give the second one the first one's file.
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
    /// `CODEX_HOME` for the login, and the directory the credential lands in.
    pub codex_home: PathBuf,
    /// The Codex CLI itself.
    pub codex_binary: PathBuf,
    /// Where an already-authorized host may still keep its credential.
    pub legacy_credential: PathBuf,
}

impl ProviderPaths {
    pub fn on_this_host() -> Self {
        Self {
            codex_home: PathBuf::from("/var/lib/asterism/codex"),
            codex_binary: PathBuf::from("/opt/asterism/codex/bin/codex"),
            legacy_credential: PathBuf::from("/var/lib/asterism/hermes/.codex/auth.json"),
        }
    }

    fn credential(&self) -> PathBuf {
        self.codex_home.join("auth.json")
    }

    /// Whether a credential is present, at either place a host may keep one.
    ///
    /// Existence only. Opening it would put a credential in this process for no
    /// reason: whether the provider still accepts it is a question only a run
    /// can answer, and a run asks it anyway.
    fn holds_credential(&self) -> bool {
        self.credential().exists() || self.legacy_credential.exists()
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
}

struct Attempt {
    child: Child,
    code: DeviceCode,
}

impl Provider {
    pub fn new(paths: ProviderPaths) -> Self {
        Self {
            paths,
            attempt: Arc::new(Mutex::new(None)),
        }
    }

    pub fn on_this_host() -> Self {
        Self::new(ProviderPaths::on_this_host())
    }

    /// What this Node advertises, so a Control Plane can hide a control that
    /// would do nothing against an older Node.
    pub fn capabilities(&self) -> serde_json::Value {
        serde_json::json!({
            "kind": "codex-cli",
            "device_authorization": true,
        })
    }

    /// This host's provider state, right now.
    pub async fn state(&self) -> ProviderState {
        if !self.paths.codex_binary.exists() {
            return ProviderState::Unavailable;
        }
        if self.paths.holds_credential() {
            // An attempt still running against a host that now has a credential
            // has served its purpose; the state is what the file says.
            return ProviderState::Authorized;
        }
        let mut attempt = self.attempt.lock().await;
        match attempt.as_mut() {
            None => ProviderState::Required,
            Some(running) => match running.child.try_wait() {
                // Still waiting for a person.
                Ok(None) => ProviderState::Authorizing,
                // It finished without leaving a credential, which is a failure
                // however it exited: a successful login writes the file.
                Ok(Some(_)) | Err(_) => {
                    *attempt = None;
                    ProviderState::Failed
                }
            },
        }
    }

    /// Start an authorization and return the pair a person needs in a browser.
    ///
    /// The CLI keeps running afterwards -- it is polling for the approval -- and
    /// this returns as soon as it has said enough for someone to act on.
    pub async fn authorize(&self) -> Result<DeviceCode> {
        if !self.paths.codex_binary.exists() {
            bail!("no provider runtime is installed on this host");
        }
        if self.paths.holds_credential() {
            bail!("this host already holds a provider credential");
        }

        let mut attempt = self.attempt.lock().await;
        // A second request while one is in flight is answered with the code that
        // is already out, not with a new one that would invalidate it.
        if let Some(running) = attempt.as_mut()
            && matches!(running.child.try_wait(), Ok(None))
        {
            return Ok(running.code.clone());
        }
        *attempt = None;

        std::fs::create_dir_all(&self.paths.codex_home)
            .with_context(|| format!("cannot create {}", self.paths.codex_home.display()))?;

        let mut child = Command::new(&self.paths.codex_binary)
            .arg("login")
            .arg("--device-auth")
            .env("CODEX_HOME", &self.paths.codex_home)
            .env("HOME", "/var/lib/asterism")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("cannot run {}", self.paths.codex_binary.display()))?;

        let code = match read_device_code(&mut child).await {
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
        });
        Ok(code)
    }

    /// Abandon whatever is in flight, and say where that leaves the host.
    pub async fn cancel(&self) -> ProviderState {
        {
            let mut attempt = self.attempt.lock().await;
            if let Some(mut running) = attempt.take() {
                let _ = running.child.start_kill();
            }
        }
        self.state().await
    }
}

/// Read the CLI's own output until it has printed a link and a code.
///
/// Both streams, because which one carries this is the CLI's business and not a
/// thing to depend on: the observed version writes the whole banner to stdout
/// and a PATH warning to stderr, and a version that swapped them would leave a
/// person watching a spinner forever.
async fn read_device_code(child: &mut Child) -> Result<DeviceCode> {
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
    let deadline = tokio::time::sleep(CODE_TIMEOUT);
    tokio::pin!(deadline);

    loop {
        let line = tokio::select! {
            line = out.next_line() => line?,
            line = err.next_line() => line?,
            () = &mut deadline => {
                bail!("the provider CLI did not offer a code within {} seconds", CODE_TIMEOUT.as_secs())
            }
        };
        match line {
            Some(line) => {
                seen.push_str(&line);
                seen.push('\n');
                if let Some(code) = parse_device_code(&seen) {
                    return Ok(code);
                }
            }
            // Both streams closed without a code. The CLI's own last words are
            // the only thing that says why, and they are not a credential.
            None => {
                let detail = seen
                    .lines()
                    .rfind(|line| !line.trim().is_empty())
                    .unwrap_or("it printed nothing")
                    .trim();
                bail!("the provider CLI stopped without offering a code: {detail}");
            }
        }
    }
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

/// Whether a path looks like a Codex home holding a credential. Used by the
/// installer's own reporting, which must not open the file either.
pub fn credential_present(codex_home: &Path) -> bool {
    codex_home.join("auth.json").exists()
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let provider = Provider::new(ProviderPaths {
            codex_home: root.path().join("codex"),
            codex_binary: root.path().join("nothing-here"),
            legacy_credential: root.path().join("legacy/auth.json"),
        });
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
    fn a_credential_at_the_legacy_place_still_counts_as_authorized() {
        let root = tempfile::tempdir().unwrap();
        let binary = root.path().join("codex");
        std::fs::write(&binary, "#!/bin/sh\n").unwrap();
        let legacy = root.path().join("legacy/auth.json");
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, "{}").unwrap();

        let provider = Provider::new(ProviderPaths {
            codex_home: root.path().join("codex-home"),
            codex_binary: binary,
            legacy_credential: legacy,
        });
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        assert_eq!(
            runtime.block_on(provider.state()),
            ProviderState::Authorized
        );
        // And it refuses to start a second one, which would replace the file the
        // host's projects are already reading.
        assert!(runtime.block_on(provider.authorize()).is_err());
    }

    #[test]
    fn a_host_that_is_merely_unauthorized_is_required_not_failed() {
        let root = tempfile::tempdir().unwrap();
        let binary = root.path().join("codex");
        std::fs::write(&binary, "#!/bin/sh\n").unwrap();
        let provider = Provider::new(ProviderPaths {
            codex_home: root.path().join("codex-home"),
            codex_binary: binary,
            legacy_credential: root.path().join("legacy/auth.json"),
        });
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        assert_eq!(runtime.block_on(provider.state()), ProviderState::Required);
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
        assert_eq!(advertised["kind"], serde_json::json!("codex-cli"));
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
