//! Telling the Control Plane how an installation is going.
//!
//! The installer runs on a machine the browser cannot reach, so progress travels
//! outbound over HTTPS using the installation's own code as its credential. That
//! code authorizes reporting for one installation and nothing else: it opens no
//! inbound port, and it cannot read or affect anything but the attempt it
//! belongs to.
//!
//! Reporting is deliberately best-effort. A Control Plane that cannot be reached
//! for a moment costs the browser its live view, which is a display problem; it
//! must not cost the host an installation that is otherwise proceeding correctly.
//! Enrollment is the step that genuinely requires the Control Plane, and it is
//! not this one.

use std::time::{Duration, Instant};

use serde::Serialize;

/// Every stage an installation can report.
///
/// These strings are the wire protocol and are shared with the Control Plane's
/// `INSTALLATION_STATES`. They are typed on both sides so that neither can spell
/// a stage wrongly, and a test below reads the other side's list to prove the
/// two have not drifted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    BootstrapDownloaded,
    BundleMetadataFetched,
    BundleDownloading,
    BundleVerified,
    PlanPrepared,
    PrerequisitesInstalling,
    RuntimeInstalling,
    ConfigurationWriting,
    IdentityEnrolling,
    ServicesStarting,
    NodeConnecting,
    HealthVerifying,
    Complete,
    Failed,
}

impl Stage {
    pub fn wire(self) -> &'static str {
        match self {
            Stage::BootstrapDownloaded => "bootstrap_downloaded",
            Stage::BundleMetadataFetched => "bundle_metadata_fetched",
            Stage::BundleDownloading => "bundle_downloading",
            Stage::BundleVerified => "bundle_verified",
            Stage::PlanPrepared => "plan_prepared",
            Stage::PrerequisitesInstalling => "prerequisites_installing",
            Stage::RuntimeInstalling => "runtime_installing",
            Stage::ConfigurationWriting => "configuration_writing",
            Stage::IdentityEnrolling => "identity_enrolling",
            Stage::ServicesStarting => "services_starting",
            Stage::NodeConnecting => "node_connecting",
            Stage::HealthVerifying => "health_verifying",
            Stage::Complete => "complete",
            Stage::Failed => "failed",
        }
    }
}

/// Why an installation stopped.
///
/// The Control Plane decides from this whether to offer a retry, so the
/// distinction that matters is "could trying again work" rather than how the
/// failure reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureCode {
    UnsupportedOs,
    UnsupportedArchitecture,
    InsufficientDisk,
    DownloadFailed,
    DigestMismatch,
    UnsupportedBundleSchema,
    PrerequisitesFailed,
    RuntimeInstallFailed,
    EnrollmentRejected,
    ServiceStartFailed,
    HealthCheckFailed,
    Interrupted,
    InternalError,
}

impl FailureCode {
    pub fn wire(self) -> &'static str {
        match self {
            FailureCode::UnsupportedOs => "unsupported_os",
            FailureCode::UnsupportedArchitecture => "unsupported_architecture",
            FailureCode::InsufficientDisk => "insufficient_disk",
            FailureCode::DownloadFailed => "download_failed",
            FailureCode::DigestMismatch => "digest_mismatch",
            FailureCode::UnsupportedBundleSchema => "unsupported_bundle_schema",
            FailureCode::PrerequisitesFailed => "prerequisites_failed",
            FailureCode::RuntimeInstallFailed => "runtime_install_failed",
            FailureCode::EnrollmentRejected => "enrollment_rejected",
            FailureCode::ServiceStartFailed => "service_start_failed",
            FailureCode::HealthCheckFailed => "health_check_failed",
            FailureCode::Interrupted => "interrupted",
            FailureCode::InternalError => "internal_error",
        }
    }
}

#[derive(Serialize)]
struct Report<'a> {
    state: &'a str,
    generation: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes_done: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes_total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure_code: Option<&'a str>,
}

/// How often a download may report while bytes are moving.
///
/// A chunk-by-chunk report would be thousands of requests for one download and
/// would tell a person nothing a second-by-second one does not. The final byte
/// count is always sent regardless of this, so the bar ends where the file ends.
const DOWNLOAD_REPORT_INTERVAL: Duration = Duration::from_secs(2);

pub struct Reporter {
    client: reqwest::Client,
    endpoint: String,
    /// The installation code. Held only to be sent as a bearer credential; it is
    /// never logged, never printed and never placed in a URL.
    code: String,
    generation: u32,
    last_download_report: std::sync::Mutex<Option<Instant>>,
}

impl Reporter {
    pub fn new(
        client: reqwest::Client,
        control_plane: &str,
        code: String,
        generation: u32,
    ) -> Self {
        Self {
            client,
            endpoint: format!(
                "{}/v1/node-installations/progress",
                control_plane.trim_end_matches('/')
            ),
            code,
            generation,
            last_download_report: std::sync::Mutex::new(None),
        }
    }

    pub async fn stage(&self, stage: Stage) {
        self.send(Report {
            state: stage.wire(),
            generation: self.generation,
            bytes_done: None,
            bytes_total: None,
            failure_code: None,
        })
        .await;
    }

    /// Report download progress, at most as often as the interval allows.
    ///
    /// `final_report` overrides the interval, because the last one carries the
    /// completed byte count and is the only one whose absence would be visible.
    pub async fn download(&self, done: u64, total: Option<u64>, final_report: bool) {
        if !final_report && !self.download_report_is_due() {
            return;
        }
        self.send(Report {
            state: Stage::BundleDownloading.wire(),
            generation: self.generation,
            bytes_done: Some(done),
            bytes_total: total,
            failure_code: None,
        })
        .await;
    }

    fn download_report_is_due(&self) -> bool {
        let mut last = match self.last_download_report.lock() {
            Ok(guard) => guard,
            // A poisoned lock here means another task panicked mid-report. The
            // rate limit is not worth propagating that into the installation.
            Err(poisoned) => poisoned.into_inner(),
        };
        let now = Instant::now();
        match *last {
            Some(previous) if now.duration_since(previous) < DOWNLOAD_REPORT_INTERVAL => false,
            _ => {
                *last = Some(now);
                true
            }
        }
    }

    pub async fn failed(&self, code: FailureCode) {
        self.send(Report {
            state: Stage::Failed.wire(),
            generation: self.generation,
            bytes_done: None,
            bytes_total: None,
            failure_code: Some(code.wire()),
        })
        .await;
    }

    async fn send(&self, report: Report<'_>) {
        // Short, and never retried. The next stage report supersedes this one
        // anyway, so a retry would delay the installation to deliver something
        // already stale.
        let _ = self
            .client
            .post(&self.endpoint)
            .bearer_auth(&self.code)
            .timeout(Duration::from_secs(10))
            .json(&report)
            .send()
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reads the Control Plane's own list rather than a copy of it.
    ///
    /// Two typed enumerations describing one wire protocol drift the moment one
    /// side gains a value. This is the test that notices.
    fn wire_values(constant: &str) -> Vec<String> {
        let source = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/control-plane/src/node-installations.ts"
        ))
        .expect("the Control Plane state model must be readable");
        let start = source
            .find(&format!("export const {constant} = ["))
            .expect("the constant must exist");
        let body = &source[start..];
        let end = body.find("] as const;").expect("the list must be closed");
        body[..end]
            .lines()
            .filter_map(|line| {
                let line = line.trim();
                line.strip_prefix('\'')?
                    .split('\'')
                    .next()
                    .map(str::to_string)
            })
            .collect()
    }

    #[test]
    fn every_stage_this_installer_reports_is_one_the_control_plane_accepts() {
        let accepted = wire_values("INSTALLATION_STATES");
        for stage in [
            Stage::BootstrapDownloaded,
            Stage::BundleMetadataFetched,
            Stage::BundleDownloading,
            Stage::BundleVerified,
            Stage::PlanPrepared,
            Stage::PrerequisitesInstalling,
            Stage::RuntimeInstalling,
            Stage::ConfigurationWriting,
            Stage::IdentityEnrolling,
            Stage::ServicesStarting,
            Stage::NodeConnecting,
            Stage::HealthVerifying,
            Stage::Complete,
            Stage::Failed,
        ] {
            assert!(
                accepted.iter().any(|value| value == stage.wire()),
                "the Control Plane does not accept the stage {}",
                stage.wire()
            );
        }
    }

    #[test]
    fn every_failure_code_this_installer_reports_is_one_the_control_plane_accepts() {
        let accepted = wire_values("FAILURE_CODES");
        for code in [
            FailureCode::UnsupportedOs,
            FailureCode::UnsupportedArchitecture,
            FailureCode::InsufficientDisk,
            FailureCode::DownloadFailed,
            FailureCode::DigestMismatch,
            FailureCode::UnsupportedBundleSchema,
            FailureCode::PrerequisitesFailed,
            FailureCode::RuntimeInstallFailed,
            FailureCode::EnrollmentRejected,
            FailureCode::ServiceStartFailed,
            FailureCode::HealthCheckFailed,
            FailureCode::Interrupted,
            FailureCode::InternalError,
        ] {
            assert!(
                accepted.iter().any(|value| value == code.wire()),
                "the Control Plane does not accept the failure code {}",
                code.wire()
            );
        }
    }

    #[test]
    fn download_reports_are_rate_limited_but_the_last_one_always_goes() {
        let reporter = Reporter::new(
            reqwest::Client::new(),
            "https://example.invalid",
            "code".into(),
            1,
        );
        assert!(reporter.download_report_is_due(), "the first is due");
        assert!(
            !reporter.download_report_is_due(),
            "the next one within the interval is not"
        );
        // `download(.., final_report = true)` bypasses this check entirely,
        // which is what guarantees the completed byte count is sent.
    }

    #[test]
    fn the_endpoint_is_built_without_doubling_the_separator() {
        let reporter = Reporter::new(
            reqwest::Client::new(),
            "https://example.invalid/",
            "code".into(),
            1,
        );
        assert_eq!(
            reporter.endpoint,
            "https://example.invalid/v1/node-installations/progress"
        );
    }
}
