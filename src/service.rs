//! Transport-independent application service.
//!
//! Every operation Asterism Node offers lives here, expressed in terms of the
//! durable registry and the Hermes backend — never in terms of HTTP. The local
//! Unix-socket API in [`crate::api`] is one caller; the future **outbound**
//! Control Plane transport will be another, and both must go through this same
//! layer so that policy, single-flight, and state transitions cannot diverge
//! between them.
//!
//! Business logic therefore never appears in a request handler.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::Result;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::{Mutex, broadcast};
use tokio::task::JoinHandle;

use crate::hermes::HermesClient;
use crate::registry::{
    IdempotencyConflict, JournalEvent, NewRun, Registry, RunRecord, RunUpdate, SCHEMA_VERSION,
    StoredEvent,
};
use crate::runner::{self, WorkerContext};
use crate::runstate::RunStatus;

/// Local API version advertised through capabilities.
pub const API_VERSION: &str = "v1";

/// Resource ceilings that keep one client or one noisy run from exhausting the
/// daemon. Phase D observed 1 658 events in a single run, so nothing here may
/// depend on holding a whole run's events in memory.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Largest accepted request body.
    pub max_request_bytes: usize,
    /// Largest number of events returned by one non-streaming query.
    pub max_events_per_query: i64,
    /// Events read per catch-up iteration while streaming.
    pub stream_page_size: i64,
    /// Concurrent local API connections.
    pub max_connections: usize,
    /// Concurrent SSE followers per run.
    pub max_followers_per_run: usize,
    /// Idle heartbeat interval for SSE.
    pub heartbeat_seconds: u64,
    /// Most recent completed chat turns replayed to Hermes as conversation
    /// history. Hermes loads no persisted history of its own, so this is what
    /// a continued conversation remembers.
    pub history_max_turns: usize,
    /// Serialized byte ceiling for that history.
    pub history_max_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_request_bytes: 256 * 1024,
            max_events_per_query: 5_000,
            stream_page_size: 256,
            max_connections: 64,
            max_followers_per_run: 8,
            heartbeat_seconds: 15,
            history_max_turns: crate::chathistory::DEFAULT_MAX_TURNS,
            history_max_bytes: crate::chathistory::DEFAULT_MAX_BYTES,
        }
    }
}

/// A failure expressed in terms the API can map to a status code without
/// knowing anything about SQLite, the filesystem, or Hermes internals.
#[derive(Debug)]
pub enum ServiceError {
    BadRequest {
        code: &'static str,
        message: String,
    },
    NotFound {
        code: &'static str,
        message: String,
    },
    Conflict {
        code: &'static str,
        message: String,
    },
    Gone {
        code: &'static str,
        message: String,
    },
    Unprocessable {
        code: &'static str,
        message: String,
    },
    Unavailable {
        code: &'static str,
        message: String,
    },
    /// Anything unexpected. The detail is logged, never returned.
    Internal(anyhow::Error),
}

impl ServiceError {
    pub fn code(&self) -> &str {
        match self {
            Self::BadRequest { code, .. }
            | Self::NotFound { code, .. }
            | Self::Conflict { code, .. }
            | Self::Gone { code, .. }
            | Self::Unprocessable { code, .. }
            | Self::Unavailable { code, .. } => code,
            Self::Internal(_) => "internal_error",
        }
    }

    pub fn status(&self) -> u16 {
        match self {
            Self::BadRequest { .. } => 400,
            Self::NotFound { .. } => 404,
            Self::Conflict { .. } => 409,
            Self::Gone { .. } => 410,
            Self::Unprocessable { .. } => 422,
            Self::Unavailable { .. } => 503,
            Self::Internal(_) => 500,
        }
    }

    /// Client-facing message. Internal errors are deliberately opaque so that a
    /// SQLite message or a filesystem path never reaches a caller.
    pub fn public_message(&self) -> String {
        match self {
            Self::BadRequest { message, .. }
            | Self::NotFound { message, .. }
            | Self::Conflict { message, .. }
            | Self::Gone { message, .. }
            | Self::Unprocessable { message, .. }
            | Self::Unavailable { message, .. } => message.clone(),
            Self::Internal(_) => "internal node error; see the daemon log".to_owned(),
        }
    }

    fn not_found(kind: &str, id: &str) -> Self {
        Self::NotFound {
            code: if kind == "project" {
                "project_not_found"
            } else {
                "run_not_found"
            },
            message: format!("unknown {kind} {id}"),
        }
    }
}

impl std::fmt::Display for ServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Internal(error) => write!(f, "internal error: {error:#}"),
            other => write!(f, "{}: {}", other.code(), other.public_message()),
        }
    }
}

impl From<anyhow::Error> for ServiceError {
    fn from(error: anyhow::Error) -> Self {
        if let Some(conflict) = error.downcast_ref::<IdempotencyConflict>() {
            return Self::Conflict {
                code: crate::registry::IDEMPOTENCY_CONFLICT_CODE,
                message: conflict.to_string(),
            };
        }
        if let Some(invalid) = error.downcast_ref::<crate::runstate::InvalidTransition>() {
            return Self::Conflict {
                code: "invalid_transition",
                message: invalid.to_string(),
            };
        }
        Self::Internal(error)
    }
}

pub type ServiceResult<T> = std::result::Result<T, ServiceError>;

/// Returned when a caller asks for a persistent approval grant.
pub const PERSISTENT_APPROVAL_NOT_SUPPORTED: &str = "persistent_approval_not_supported";

/// A request to create a run, independent of how it arrived.
#[derive(Debug, Clone, Default)]
pub struct CreateRun {
    pub input: String,
    pub session_id: Option<String>,
    pub instructions: Option<String>,
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunCreated {
    pub run: RunRecord,
    /// True when an idempotency key replayed an existing run instead of
    /// creating and submitting a new one.
    pub idempotent_replay: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectActivity {
    pub project_id: String,
    pub active_run_id: Option<String>,
    pub active_status: Option<String>,
}

impl ProjectActivity {
    pub fn is_busy(&self) -> bool {
        self.active_run_id.is_some()
    }
}

struct Inner {
    state_root: PathBuf,
    base_url: String,
    api_key: String,
    instance_id: String,
    started_at: i64,
    limits: Limits,
    registry: Mutex<Registry>,
    /// Wake-up bus for SSE followers. Carries only run ids: SQLite stays the
    /// authoritative event source, so a missed notification costs latency, not
    /// correctness.
    events: broadcast::Sender<String>,
    workers: Mutex<HashMap<String, JoinHandle<()>>>,
    draining: AtomicBool,
    /// Set once the daemon starts its outbound control channel. Absent means
    /// the channel is not running, which is never an error locally.
    channel: Mutex<Option<crate::control::ChannelStatus>>,
}

/// Handle to the Node application service.
#[derive(Clone)]
pub struct NodeService {
    inner: Arc<Inner>,
}

impl NodeService {
    pub fn new(
        state_root: impl AsRef<Path>,
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        limits: Limits,
    ) -> Result<Self> {
        let state_root = state_root.as_ref().to_path_buf();
        let registry = Registry::open(&state_root)?;
        let (events, _) = broadcast::channel(1024);

        Ok(Self {
            inner: Arc::new(Inner {
                state_root,
                base_url: base_url.into(),
                api_key: api_key.into(),
                instance_id: new_instance_id(),
                started_at: crate::registry::now_millis(),
                limits,
                registry: Mutex::new(registry),
                events,
                workers: Mutex::new(HashMap::new()),
                draining: AtomicBool::new(false),
                channel: Mutex::new(None),
            }),
        })
    }

    pub fn limits(&self) -> Limits {
        self.inner.limits
    }

    pub fn instance_id(&self) -> &str {
        &self.inner.instance_id
    }

    pub fn state_root(&self) -> &Path {
        &self.inner.state_root
    }

    /// Subscribe to the wake-up bus. Used only to avoid polling latency.
    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.inner.events.subscribe()
    }

    /// Stop admitting new runs. Existing ones keep executing.
    pub fn begin_drain(&self) {
        self.inner.draining.store(true, Ordering::SeqCst);
    }

    pub fn is_draining(&self) -> bool {
        self.inner.draining.load(Ordering::SeqCst)
    }

    pub async fn active_worker_count(&self) -> usize {
        self.inner.workers.lock().await.len()
    }

    /// Resolve the Hermes endpoint a given project's runtime listens on.
    ///
    /// Each project runs its own container on its own host port, so the endpoint
    /// is a property of the project, not of the Node. A project registered
    /// without one falls back to the Node-wide default, which is what every
    /// single-project deployment relies on.
    async fn project_endpoint(&self, project_id: &str) -> String {
        let registry = self.inner.registry.lock().await;
        registry
            .project(project_id)
            .ok()
            .flatten()
            .and_then(|project| project.runtime_endpoint)
            .unwrap_or_else(|| self.inner.base_url.clone())
    }

    /// A Hermes client aimed at one project's runtime.
    ///
    /// Approvals, cancellation, and reconciliation all address a specific
    /// project, so none of them may use a Node-wide endpoint once more than one
    /// project exists — they would talk to the wrong container.
    async fn client_for(&self, project_id: &str) -> ServiceResult<HermesClient> {
        let base_url = self.project_endpoint(project_id).await;
        HermesClient::new(base_url, self.inner.api_key.clone()).map_err(|error| {
            ServiceError::Unavailable {
                code: "hermes_unavailable",
                message: format!("cannot address the Hermes endpoint: {error}"),
            }
        })
    }

    /// Attach the control channel so its state can be reported locally.
    pub async fn attach_channel(&self, status: crate::control::ChannelStatus) {
        *self.inner.channel.lock().await = Some(status);
    }

    async fn channel_snapshot(&self) -> Value {
        match self.inner.channel.lock().await.clone() {
            Some(status) => status.snapshot().await,
            None => json!({"state": "disabled", "metrics": Value::Null}),
        }
    }

    /// Local health.
    ///
    /// A disconnected Control Plane is reported, never treated as ill health:
    /// the daemon serves its socket and executes runs regardless.
    pub async fn health(&self) -> Value {
        let channel = self.channel_snapshot().await;
        let control_state = channel["state"].as_str().unwrap_or("disabled").to_owned();
        json!({
            "status": "ok",
            "instance_id": self.inner.instance_id,
            "started_at": self.inner.started_at,
            "draining": self.is_draining(),
            "api_version": API_VERSION,
            "control_plane": {
                "state": control_state,
                "connected": channel["state"] == json!("connected"),
                "authentication_failed": channel["state"] == json!("failed"),
            },
        })
    }

    pub async fn capabilities(&self) -> Value {
        json!({
            "api_version": API_VERSION,
            "registry_schema_version": SCHEMA_VERSION,
            "node_instance_id": self.inner.instance_id,
            "transport": {
                "kind": "unix_socket_http",
                "inbound_tcp": false,
            },
            "runtime_kinds": ["hermes-loop"],
            "experimental_runtime_kinds": ["codex-app-server"],
            "approvals": {
                "supported": true,
                // "always" is deliberately absent. Hermes turns it into a
                // permanent command_allowlist entry that suppresses every future
                // approval in that category, and Asterism has no UI that shows
                // or revokes such a rule. Until it does, offering the choice
                // would hand out an irreversible grant with no way back.
                "choices": ["once", "session", "deny"],
                "delayed_decisions": true,
                "at_most_once": true,
            },
            "replay": {
                "supported": true,
                "cursor": "seq",
                "last_event_id_header": true,
                "query_parameter": "since_seq",
                "terminal_replay_without_backend": true,
            },
            "cancellation": {"supported": true, "idempotent": true},
            "retry": {
                "supported": true,
                "retryable_statuses": ["interrupted", "lost"],
                "creates_new_run": true,
                "link_field": "retry_of_run_id",
            },
            "concurrency": {
                "active_runs_per_project": 1,
                "policy": "single_flight",
            },
            "control_plane": self.channel_snapshot().await,
            "protocol": {
                "versions": crate::protocol::SUPPORTED_VERSIONS,
                "outbound_only": true,
                "inbound_listener": false,
            },
            "limits": {
                "max_request_bytes": self.inner.limits.max_request_bytes,
                "max_events_per_query": self.inner.limits.max_events_per_query,
                "max_followers_per_run": self.inner.limits.max_followers_per_run,
                "heartbeat_seconds": self.inner.limits.heartbeat_seconds,
            },
        })
    }

    // ---------------------------------------------------------------- runs

    pub async fn create_run(
        &self,
        project_id: &str,
        request: CreateRun,
    ) -> ServiceResult<RunCreated> {
        validate_identifier("project_id", project_id)?;
        if request.input.trim().is_empty() {
            return Err(ServiceError::Unprocessable {
                code: "empty_input",
                message: "input must not be empty".to_owned(),
            });
        }
        if self.is_draining() {
            return Err(ServiceError::Unavailable {
                code: "node_draining",
                message: "the node is shutting down and is not accepting new runs".to_owned(),
            });
        }

        let runtime_kind = detect_runtime_kind(&self.inner.state_root, project_id);
        let creation = {
            let mut registry = self.inner.registry.lock().await;
            registry.create_run(&NewRun {
                project_id: project_id.to_owned(),
                session_id: request.session_id.clone(),
                idempotency_key: request.idempotency_key.clone(),
                runtime_kind,
                provider: None,
                model: None,
                request_payload: json!({
                    "input": request.input,
                    "instructions": request.instructions,
                }),
                retry_of_run_id: None,
            })?
        };

        let record = creation.record().clone();
        let is_new = creation.is_new();
        if is_new {
            self.supervise(project_id, &record.run_id).await;
        }

        Ok(RunCreated {
            run: record,
            idempotent_replay: !is_new,
        })
    }

    pub async fn list_runs(&self, project_id: &str, limit: i64) -> ServiceResult<Vec<RunRecord>> {
        validate_identifier("project_id", project_id)?;
        let limit = limit.clamp(1, self.inner.limits.max_events_per_query);
        let registry = self.inner.registry.lock().await;
        Ok(registry.list_runs(project_id, limit)?)
    }

    pub async fn get_run(&self, project_id: &str, run_id: &str) -> ServiceResult<RunRecord> {
        validate_identifier("project_id", project_id)?;
        validate_identifier("run_id", run_id)?;
        let registry = self.inner.registry.lock().await;
        load_owned(&registry, project_id, run_id)
    }

    pub async fn approvals(&self, project_id: &str, run_id: &str) -> ServiceResult<Value> {
        let registry = self.inner.registry.lock().await;
        let record = load_owned(&registry, project_id, run_id)?;
        Ok(json!(registry.approvals(&record.run_id)?))
    }

    pub async fn events(
        &self,
        project_id: &str,
        run_id: &str,
        since_seq: i64,
        limit: i64,
    ) -> ServiceResult<Vec<StoredEvent>> {
        validate_identifier("project_id", project_id)?;
        validate_identifier("run_id", run_id)?;
        if since_seq < 0 {
            return Err(ServiceError::BadRequest {
                code: "invalid_cursor",
                message: "since_seq must not be negative".to_owned(),
            });
        }
        let limit = limit.clamp(1, self.inner.limits.max_events_per_query);
        let registry = self.inner.registry.lock().await;
        let record = load_owned(&registry, project_id, run_id)?;
        Ok(registry.events_since(&record.run_id, since_seq, limit)?)
    }

    /// One catch-up page for a streaming client, plus the run's current status.
    ///
    /// Streaming is built from repeated calls to this, so SQLite remains the
    /// authoritative source and a dropped wake-up notification costs only
    /// latency.
    pub async fn stream_page(
        &self,
        run_id: &str,
        after_seq: i64,
    ) -> ServiceResult<(Vec<StoredEvent>, RunStatus)> {
        let registry = self.inner.registry.lock().await;
        let record = registry
            .run(run_id)?
            .ok_or_else(|| ServiceError::not_found("run", run_id))?;
        let events =
            registry.events_since(run_id, after_seq, self.inner.limits.stream_page_size)?;
        let status = record.status().map_err(ServiceError::Internal)?;
        Ok((events, status))
    }

    // ----------------------------------------------------------- approvals

    pub async fn resolve_approval(
        &self,
        project_id: &str,
        run_id: &str,
        choice: &str,
    ) -> ServiceResult<Value> {
        // Refused explicitly rather than folded into "once": silently
        // downgrading a persistent grant would answer a question the operator
        // did not ask, and they would believe a standing rule exists.
        if choice == "always" {
            return Err(ServiceError::Unprocessable {
                code: PERSISTENT_APPROVAL_NOT_SUPPORTED,
                message: "persistent approvals are unavailable: Hermes would record this \
                          as a permanent command_allowlist rule that Asterism cannot yet \
                          display or revoke. Use \"once\" or \"session\"."
                    .to_owned(),
            });
        }
        if !matches!(choice, "once" | "session" | "deny") {
            return Err(ServiceError::Unprocessable {
                code: "invalid_choice",
                message: format!("unsupported approval choice {choice:?}"),
            });
        }
        let client = self.client_for(project_id).await?;
        let mut registry = self.inner.registry.lock().await;
        let record = load_owned(&registry, project_id, run_id)?;

        let pending =
            registry
                .pending_approval(&record.run_id)?
                .ok_or_else(|| ServiceError::Conflict {
                    code: "no_pending_approval",
                    message: "this run has no approval waiting for a decision".to_owned(),
                })?;
        let hermes_run_id = record
            .hermes_run_id
            .clone()
            .ok_or_else(|| ServiceError::Gone {
                code: "backend_run_missing",
                message: "this run was never submitted to a backend".to_owned(),
            })?;

        // The decision is claimed durably before it is forwarded, so a retry
        // cannot send a second decision for the same request.
        if !registry.record_approval_decision(&record.run_id, pending.request_seq, choice)? {
            return Err(ServiceError::Conflict {
                code: "approval_already_resolved",
                message: "a decision was already recorded for this approval".to_owned(),
            });
        }

        let response = client.resolve_approval(&hermes_run_id, choice, false).await;
        let payload = match &response {
            Ok(value) => value.clone(),
            Err(error) => json!({"error": error.to_string()}),
        };
        let seq = runner::append_note(
            &mut registry,
            &record.run_id,
            runner::EVENT_APPROVAL_DECISION,
            json!({"choice": choice, "response": payload}),
        )?;
        registry.record_approval_resolution(&record.run_id, pending.request_seq, seq)?;
        drop(registry);
        self.notify(&record.run_id);

        if let Err(error) = response {
            return Err(ServiceError::Unavailable {
                code: "hermes_unavailable",
                message: format!("the decision was recorded but the backend rejected it: {error}"),
            });
        }

        Ok(json!({
            "run_id": record.run_id,
            "approval_id": pending.request_seq,
            "choice": choice,
            "applied": true,
        }))
    }

    // -------------------------------------------------------- cancellation

    pub async fn cancel_run(&self, project_id: &str, run_id: &str) -> ServiceResult<Value> {
        let client = self.client_for(project_id).await?;
        let mut registry = self.inner.registry.lock().await;
        let record = load_owned(&registry, project_id, run_id)?;
        let status = record.status().map_err(ServiceError::Internal)?;

        if status.is_terminal() {
            return Ok(json!({
                "run_id": record.run_id,
                "status": record.status,
                "cancel_requested": false,
                "note": "run already reached a terminal state",
            }));
        }

        runner::append_note(
            &mut registry,
            &record.run_id,
            runner::EVENT_CANCEL_REQUESTED,
            json!({"requested_status": status.as_str()}),
        )?;

        let Some(hermes_run_id) = record.hermes_run_id.clone() else {
            let updated = registry.update_run(
                &record.run_id,
                &RunUpdate::status(RunStatus::Cancelled)
                    .with_terminal_reason("cancelled before submission to a backend"),
            )?;
            drop(registry);
            self.notify(&record.run_id);
            return Ok(
                json!({"run_id": updated.run_id, "status": updated.status, "cancel_requested": true}),
            );
        };

        let response = client.stop_run(&hermes_run_id).await;
        let payload = match &response {
            Ok(value) => value.clone(),
            Err(error) => json!({"error": error.to_string()}),
        };
        runner::append_note(
            &mut registry,
            &record.run_id,
            "asterism.cancel.response",
            payload.clone(),
        )?;
        drop(registry);
        self.notify(&record.run_id);

        // The supervising worker observes the real terminal status. `cancelled`
        // is only ever claimed on backend evidence.
        Ok(json!({
            "run_id": record.run_id,
            "cancel_requested": true,
            "backend_response": payload,
        }))
    }

    // --------------------------------------------------------------- retry

    /// Create a replacement run for a terminal `interrupted` or `lost` run.
    ///
    /// The original is never modified beyond a linking event and never
    /// resubmitted: retrying is always a new run with a new id.
    pub async fn retry_run(&self, project_id: &str, run_id: &str) -> ServiceResult<RunCreated> {
        if self.is_draining() {
            return Err(ServiceError::Unavailable {
                code: "node_draining",
                message: "the node is shutting down and is not accepting new runs".to_owned(),
            });
        }

        let (original, replacement) = {
            let mut registry = self.inner.registry.lock().await;
            let original = load_owned(&registry, project_id, run_id)?;
            let status = original.status().map_err(ServiceError::Internal)?;

            if !status.is_terminal() {
                return Err(ServiceError::Conflict {
                    code: "run_active",
                    message: format!("run {} is {status} and cannot be retried", original.run_id),
                });
            }
            if !status.is_retryable() {
                return Err(ServiceError::Conflict {
                    code: "run_not_retryable",
                    message: format!(
                        "run {} ended as {status}; only interrupted or lost runs may be retried",
                        original.run_id
                    ),
                });
            }

            // Only fields that describe the work are carried over. The
            // idempotency key deliberately is not: reusing it would collide with
            // the original record.
            let creation = registry.create_run(&NewRun {
                project_id: project_id.to_owned(),
                session_id: original.session_id.clone(),
                idempotency_key: None,
                runtime_kind: original.runtime_kind.clone(),
                provider: original.provider.clone(),
                model: original.model.clone(),
                request_payload: json!({
                    "input": original.request_payload.get("input"),
                    "instructions": original.request_payload.get("instructions"),
                }),
                retry_of_run_id: Some(original.run_id.clone()),
            })?;
            let replacement = creation.record().clone();

            // Both sides of the relationship are journalled.
            registry.append_event(
                &original.run_id,
                &JournalEvent::asterism(
                    runner::EVENT_RETRY_CREATED,
                    json!({"replacement_run_id": replacement.run_id}),
                ),
                None,
            )?;
            registry.append_event(
                &replacement.run_id,
                &JournalEvent::asterism(
                    runner::EVENT_RETRY_OF,
                    json!({
                        "original_run_id": original.run_id,
                        "original_status": original.status,
                    }),
                ),
                None,
            )?;
            (original, replacement)
        };

        self.notify(&original.run_id);
        self.supervise(project_id, &replacement.run_id).await;

        Ok(RunCreated {
            run: replacement,
            idempotent_replay: false,
        })
    }

    // ------------------------------------------------------- reconciliation

    /// Resolve every non-terminal run of a project and re-attach supervision to
    /// any the backend still reports as live.
    pub async fn reconcile(&self, project_id: &str) -> ServiceResult<Vec<Value>> {
        validate_identifier("project_id", project_id)?;
        let client = self.client_for(project_id).await?;
        let outcomes = runner::reconcile_project(&self.inner.state_root, project_id, &client)
            .await
            .map_err(ServiceError::Internal)?;

        let resumable = {
            let registry = self.inner.registry.lock().await;
            registry
                .active_runs(project_id)?
                .into_iter()
                .filter(|run| run.hermes_run_id.is_some())
                .filter(|run| {
                    matches!(
                        run.status(),
                        Ok(RunStatus::Running | RunStatus::WaitingForApproval)
                    )
                })
                .map(|run| run.run_id)
                .collect::<Vec<_>>()
        };

        // Single-flight: at most one run may be supervised per project.
        if let Some(run_id) = resumable.first() {
            self.supervise(project_id, run_id).await;
        }

        Ok(outcomes
            .into_iter()
            .map(|outcome| {
                json!({
                    "run_id": outcome.run_id,
                    "previous_status": outcome.previous_status,
                    "new_status": outcome.new_status,
                    "note": outcome.note,
                })
            })
            .collect())
    }

    /// Durable view of whether a project currently has work in flight, used by
    /// lifecycle commands that must not disturb a live run.
    pub async fn project_activity(&self, project_id: &str) -> ServiceResult<ProjectActivity> {
        validate_identifier("project_id", project_id)?;
        let registry = self.inner.registry.lock().await;
        let active = registry.active_runs(project_id)?;
        let first = active.into_iter().next();
        Ok(ProjectActivity {
            project_id: project_id.to_owned(),
            active_run_id: first.as_ref().map(|run| run.run_id.clone()),
            active_status: first.map(|run| run.status),
        })
    }

    // ------------------------------------------------------------ internals

    fn notify(&self, run_id: &str) {
        // A full channel means followers are behind; they will still catch up
        // from SQLite on their next poll, so the send failure is not an error.
        let _ = self.inner.events.send(run_id.to_owned());
    }

    /// Spawn the in-daemon worker that owns one run's execution.
    ///
    /// Phase D spawned a detached process per run. The daemon now owns
    /// supervision directly, which is what makes it the single authority over
    /// active runs: a CLI or SSE client disconnecting has no effect on it.
    async fn supervise(&self, project_id: &str, run_id: &str) {
        let mut workers = self.inner.workers.lock().await;
        if workers.contains_key(run_id) {
            return;
        }

        let context = WorkerContext {
            state_root: self.inner.state_root.clone(),
            project_id: project_id.to_owned(),
            run_id: run_id.to_owned(),
            base_url: self.project_endpoint(project_id).await,
            api_key: self.inner.api_key.clone(),
            notifier: Some(self.inner.events.clone()),
            history_limits: crate::chathistory::HistoryLimits {
                max_turns: self.inner.limits.history_max_turns,
                max_bytes: self.inner.limits.history_max_bytes,
            },
        };
        let inner = Arc::clone(&self.inner);
        let owned_run_id = run_id.to_owned();

        let handle = tokio::spawn(async move {
            if let Err(error) = runner::execute_run(&context).await {
                // The worker records failures durably itself; anything reaching
                // here is unexpected, so log it without payloads.
                eprintln!(
                    "[asterism] worker for run {} ended with an error: {error:#}",
                    context.run_id
                );
            }
            let _ = inner.events.send(context.run_id.clone());
            inner.workers.lock().await.remove(&owned_run_id);
        });

        workers.insert(run_id.to_owned(), handle);
    }

    /// Wait for supervised runs to finish, bounded by `timeout`.
    ///
    /// Active Hermes runs are deliberately **not** cancelled: a graceful daemon
    /// shutdown must not destroy work the operator did not ask to stop. Whatever
    /// is still live is picked up by startup reconciliation.
    pub async fn drain(&self, timeout: std::time::Duration) -> usize {
        self.begin_drain();
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let remaining = self.inner.workers.lock().await.len();
            if remaining == 0 || tokio::time::Instant::now() >= deadline {
                return remaining;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }
}

fn load_owned(registry: &Registry, project_id: &str, run_id: &str) -> ServiceResult<RunRecord> {
    validate_identifier("project_id", project_id)?;
    validate_identifier("run_id", run_id)?;
    let record = registry
        .run(run_id)
        .map_err(ServiceError::Internal)?
        .ok_or_else(|| ServiceError::not_found("run", run_id))?;
    // A run id is only meaningful inside its own project. Reporting "not found"
    // rather than "forbidden" avoids confirming that another project's run
    // exists.
    if record.project_id != project_id {
        return Err(ServiceError::not_found("run", run_id));
    }
    Ok(record)
}

/// Reject anything that could escape its storage namespace or a URL path.
///
/// Identifiers reach the service straight from a request path, so `..`, `/`,
/// and control characters must never be accepted.
pub fn validate_identifier(field: &str, value: &str) -> ServiceResult<()> {
    let invalid = |message: String| ServiceError::BadRequest {
        code: "invalid_identifier",
        message,
    };

    if value.is_empty() || value.len() > 128 {
        return Err(invalid(format!("{field} must be 1..=128 characters")));
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(invalid(format!(
            "{field} may only contain ASCII letters, digits, '-', '_' and '.'"
        )));
    }
    if value.contains("..") {
        return Err(invalid(format!("{field} must not contain '..'")));
    }
    Ok(())
}

fn detect_runtime_kind(state_root: &Path, project_id: &str) -> String {
    let config = state_root
        .join(project_id)
        .join("hermes")
        .join("config.yaml");
    match crate::policy::read_runtime_configuration(&config) {
        Ok(config) if config.uses_native_codex() => "codex-app-server".to_owned(),
        _ => "hermes-loop".to_owned(),
    }
}

fn new_instance_id() -> String {
    let mut bytes = [0u8; 8];
    if std::fs::File::open("/dev/urandom")
        .and_then(|mut file| std::io::Read::read_exact(&mut file, &mut bytes))
        .is_err()
    {
        bytes.copy_from_slice(&crate::registry::now_millis().to_le_bytes());
    }
    format!(
        "node_{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_identifiers_that_could_escape_a_path() {
        for bad in [
            "",
            "../etc",
            "a/b",
            "..",
            "with space",
            "new\nline",
            "nul\0byte",
            "%2e%2e",
        ] {
            assert!(
                validate_identifier("project_id", bad).is_err(),
                "{bad:?} must be rejected"
            );
        }
        assert!(validate_identifier("project_id", &"x".repeat(129)).is_err());
    }

    #[test]
    fn accepts_ordinary_identifiers() {
        for good in ["phase-a", "arun_5a765361d94c0d6c", "proj.1", "A-9_z"] {
            assert!(validate_identifier("project_id", good).is_ok(), "{good:?}");
        }
    }

    #[test]
    fn errors_map_onto_stable_codes_and_statuses() {
        let cases: Vec<(ServiceError, u16, &str)> = vec![
            (
                ServiceError::BadRequest {
                    code: "invalid_cursor",
                    message: "x".into(),
                },
                400,
                "invalid_cursor",
            ),
            (
                ServiceError::not_found("run", "arun_x"),
                404,
                "run_not_found",
            ),
            (
                ServiceError::Conflict {
                    code: "run_conflict",
                    message: "x".into(),
                },
                409,
                "run_conflict",
            ),
            (
                ServiceError::Gone {
                    code: "backend_run_missing",
                    message: "x".into(),
                },
                410,
                "backend_run_missing",
            ),
            (
                ServiceError::Unprocessable {
                    code: "empty_input",
                    message: "x".into(),
                },
                422,
                "empty_input",
            ),
            (
                ServiceError::Unavailable {
                    code: "hermes_unavailable",
                    message: "x".into(),
                },
                503,
                "hermes_unavailable",
            ),
        ];
        for (error, status, code) in cases {
            assert_eq!(error.status(), status);
            assert_eq!(error.code(), code);
        }
    }

    #[test]
    fn internal_errors_never_leak_their_detail() {
        let error = ServiceError::Internal(anyhow::anyhow!(
            "no such column: secret_token in /home/user/.asterism/node/registry.db"
        ));
        let public = error.public_message();

        assert_eq!(error.status(), 500);
        assert_eq!(error.code(), "internal_error");
        assert!(!public.contains("secret_token"));
        assert!(!public.contains("/home/user"));
        assert!(!public.contains("no such column"));
    }

    #[test]
    fn idempotency_conflicts_become_409_not_500() {
        let error: ServiceError = anyhow::Error::from(IdempotencyConflict {
            project_id: "p".into(),
            idempotency_key: "k".into(),
            existing_run_id: "arun_1".into(),
        })
        .into();

        assert_eq!(error.status(), 409);
        assert_eq!(error.code(), "idempotency_conflict");
    }

    #[test]
    fn invalid_transitions_become_409() {
        let error: ServiceError = anyhow::Error::from(crate::runstate::InvalidTransition {
            from: RunStatus::Completed,
            to: RunStatus::Running,
        })
        .into();

        assert_eq!(error.status(), 409);
        assert_eq!(error.code(), "invalid_transition");
    }

    #[test]
    fn limits_are_bounded_by_default() {
        let limits = Limits::default();
        assert!(limits.max_request_bytes <= 1024 * 1024);
        assert!(limits.stream_page_size <= limits.max_events_per_query);
        assert!(limits.max_followers_per_run >= 1);
        assert!(limits.heartbeat_seconds >= 1);
    }

    #[test]
    fn instance_ids_are_distinct() {
        assert_ne!(new_instance_id(), new_instance_id());
    }
}
