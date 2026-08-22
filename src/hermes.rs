use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use futures_util::StreamExt;
use reqwest::{Client, Response, StatusCode};
use serde::{Deserialize, Serialize};

use crate::chathistory::HistoryMessage;
use serde_json::{Value, json};

use crate::sse::{SseEvent, SseParser};

#[derive(Debug, Clone)]
pub struct HermesClient {
    http: Client,
    base_url: String,
    api_key: String,
}

#[derive(Debug, Serialize)]
pub struct StartRunRequest<'a> {
    /// Plain text for an ordinary turn, or the structured content-part list
    /// proven to carry `image_url` attachments through to the provider.
    pub input: &'a serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<&'a str>,
    /// Prior turns of this conversation.
    ///
    /// Hermes builds a run's transcript from this field first and never loads
    /// persisted session history for `session_id`, so a continued run that
    /// omits it starts with no memory of the conversation it belongs to.
    /// Empty is skipped rather than sent, keeping a first turn's request
    /// byte-identical to what it was before.
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    pub conversation_history: &'a [HistoryMessage],
}

#[derive(Debug, Deserialize)]
pub struct StartRunResponse {
    pub run_id: String,
    pub status: String,
}

impl HermesClient {
    pub fn new(base_url: impl Into<String>, api_key: impl Into<String>) -> Result<Self> {
        let base_url = base_url.into().trim_end_matches('/').to_owned();
        if !base_url.starts_with("http://127.0.0.1:") && !base_url.starts_with("http://localhost:")
        {
            bail!("Phase A only permits a loopback Hermes API URL");
        }

        let api_key = api_key.into();
        if api_key.len() < 16 {
            bail!("Hermes API key must be at least 16 characters");
        }

        Ok(Self {
            http: Client::new(),
            base_url,
            api_key,
        })
    }

    pub async fn health(&self) -> Result<Value> {
        let response = self
            .http
            .get(format!("{}/health", self.base_url))
            .send()
            .await
            .context("failed to call Hermes health endpoint")?;
        Self::json(response).await
    }

    pub async fn detailed_health(&self) -> Result<Value> {
        let response = self
            .authorized(self.http.get(format!("{}/health/detailed", self.base_url)))
            .send()
            .await
            .context("failed to call Hermes detailed health endpoint")?;
        Self::json(response).await
    }

    pub async fn capabilities(&self) -> Result<Value> {
        let response = self
            .authorized(self.http.get(format!("{}/v1/capabilities", self.base_url)))
            .send()
            .await
            .context("failed to call Hermes capabilities endpoint")?;
        Self::json(response).await
    }

    pub async fn start_run(&self, request: &StartRunRequest<'_>) -> Result<StartRunResponse> {
        let idempotency_key = Self::new_idempotency_key();
        let response = self
            .authorized(self.http.post(format!("{}/v1/runs", self.base_url)))
            .header("Idempotency-Key", idempotency_key)
            .json(request)
            .send()
            .await
            .context("failed to start Hermes run")?;

        Self::json(response).await
    }

    pub async fn run_status(&self, run_id: &str) -> Result<Value> {
        let response = self
            .authorized(
                self.http
                    .get(format!("{}/v1/runs/{}", self.base_url, run_id)),
            )
            .send()
            .await
            .context("failed to read Hermes run status")?;
        Self::json(response).await
    }

    /// Status of a run, or `None` when Hermes has no record of it.
    ///
    /// The Hermes run registry is in-memory: after a container restart a
    /// previously known run id returns 404. Callers use `None` to mean "no
    /// longer tracked" rather than treating it as a hard failure.
    pub async fn try_run_status(&self, run_id: &str) -> Result<Option<Value>> {
        let response = self
            .authorized(
                self.http
                    .get(format!("{}/v1/runs/{}", self.base_url, run_id)),
            )
            .send()
            .await
            .context("failed to read Hermes run status")?;

        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(Self::http_error(response).await);
        }
        response
            .json()
            .await
            .context("Hermes returned invalid JSON")
            .map(Some)
    }

    pub async fn stop_run(&self, run_id: &str) -> Result<Value> {
        let response = self
            .authorized(
                self.http
                    .post(format!("{}/v1/runs/{}/stop", self.base_url, run_id)),
            )
            .send()
            .await
            .context("failed to stop Hermes run")?;
        Self::json(response).await
    }

    pub async fn resolve_approval(
        &self,
        run_id: &str,
        choice: &str,
        resolve_all: bool,
    ) -> Result<Value> {
        let response = self
            .authorized(
                self.http
                    .post(format!("{}/v1/runs/{}/approval", self.base_url, run_id)),
            )
            .json(&json!({
                "choice": choice,
                "resolve_all": resolve_all,
            }))
            .send()
            .await
            .context("failed to resolve Hermes approval")?;
        Self::json(response).await
    }

    pub async fn stream_events<F>(&self, run_id: &str, mut on_event: F) -> Result<()>
    where
        F: FnMut(SseEvent) -> Result<()>,
    {
        let response = self
            .authorized(
                self.http
                    .get(format!("{}/v1/runs/{}/events", self.base_url, run_id)),
            )
            .send()
            .await
            .context("failed to subscribe to Hermes run events")?;

        if !response.status().is_success() {
            return Err(Self::http_error(response).await);
        }

        let mut stream = response.bytes_stream();
        let mut parser = SseParser::default();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("failed while reading Hermes SSE stream")?;
            let text = String::from_utf8_lossy(&chunk);
            for event in parser.push(&text) {
                on_event(event)?;
            }
        }

        if let Some(event) = parser.finish() {
            on_event(event)?;
        }

        Ok(())
    }

    fn authorized(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        builder.bearer_auth(&self.api_key)
    }

    async fn json<T>(response: Response) -> Result<T>
    where
        T: serde::de::DeserializeOwned,
    {
        if !response.status().is_success() {
            return Err(Self::http_error(response).await);
        }
        response
            .json()
            .await
            .context("Hermes returned invalid JSON")
    }

    async fn http_error(response: Response) -> anyhow::Error {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let body = if body.chars().count() > 2048 {
            format!("{}...", body.chars().take(2048).collect::<String>())
        } else {
            body
        };
        anyhow::anyhow!("Hermes API returned {}: {}", status, body)
    }

    fn new_idempotency_key() -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        format!("asterism-{nanos}")
    }
}

pub fn is_terminal_status(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled")
}

pub fn is_retryable_status(status: StatusCode) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_loopback_api() {
        let result = HermesClient::new("http://192.168.1.10:8642", "1234567890abcdef");
        assert!(result.is_err());
    }

    #[test]
    fn rejects_short_api_key() {
        let result = HermesClient::new("http://127.0.0.1:8642", "too-short");
        assert!(result.is_err());
    }

    #[test]
    fn recognizes_terminal_run_statuses() {
        assert!(is_terminal_status("completed"));
        assert!(is_terminal_status("failed"));
        assert!(is_terminal_status("cancelled"));
        assert!(!is_terminal_status("started"));
        assert!(!is_terminal_status("stopping"));
    }
}
