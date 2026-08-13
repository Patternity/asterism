//! Local HTTP API over a Unix domain socket.
//!
//! This is the **local control endpoint**, not a Control Plane transport. There
//! is no TCP listener and no inbound network surface: the future Control Plane
//! link will be an *outbound* connection made by the daemon, and it will call
//! the same [`NodeService`] this module calls.
//!
//! Handlers here do nothing but parse a request, delegate, and render a
//! response. All behaviour lives in [`crate::service`].

use std::convert::Infallible;

use bytes::Bytes;
use futures_util::stream;
use http_body_util::{BodyExt, Full, StreamBody, combinators::BoxBody};
use hyper::body::{Frame, Incoming};
use hyper::{Method, Request, Response, StatusCode};
use serde_json::{Value, json};

use crate::registry::StoredEvent;
use crate::service::{CreateRun, NodeService, ServiceError, ServiceResult};

type ApiBody = BoxBody<Bytes, Infallible>;

/// Route and execute one request.
pub async fn handle(service: NodeService, request: Request<Incoming>) -> Response<ApiBody> {
    match route(&service, request).await {
        Ok(response) => response,
        Err(error) => error_response(&error),
    }
}

async fn route(
    service: &NodeService,
    request: Request<Incoming>,
) -> ServiceResult<Response<ApiBody>> {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let query = request.uri().query().unwrap_or_default().to_owned();
    let last_event_id = request
        .headers()
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned);

    let segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();

    match (&method, segments.as_slice()) {
        (&Method::GET, ["v1", "health"]) => {
            Ok(json_response(StatusCode::OK, &service.health().await))
        }
        (&Method::GET, ["v1", "capabilities"]) => {
            Ok(json_response(StatusCode::OK, &service.capabilities().await))
        }

        (&Method::POST, ["v1", "projects", project, "runs"]) => {
            let body = read_body(service, request).await?;
            let created = service
                .create_run(project, parse_create_run(&body)?)
                .await?;
            Ok(json_response(
                StatusCode::CREATED,
                &json!({"run": created.run, "idempotent_replay": created.idempotent_replay}),
            ))
        }

        (&Method::GET, ["v1", "projects", project, "runs"]) => {
            let limit = query_param(&query, "limit")
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(50);
            let runs = service.list_runs(project, limit).await?;
            Ok(json_response(
                StatusCode::OK,
                &json!({"project_id": project, "runs": runs}),
            ))
        }

        (&Method::GET, ["v1", "projects", project, "runs", run]) => {
            let record = service.get_run(project, run).await?;
            let approvals = service.approvals(project, run).await?;
            Ok(json_response(
                StatusCode::OK,
                &json!({"run": record, "approvals": approvals}),
            ))
        }

        (&Method::GET, ["v1", "projects", project, "runs", run, "events"]) => {
            let since = cursor_from(&query, last_event_id.as_deref())?;
            let limit = query_param(&query, "limit")
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(i64::MAX);
            let record = service.get_run(project, run).await?;
            let events = service.events(project, run, since, limit).await?;
            Ok(json_response(
                StatusCode::OK,
                &json!({
                    "run_id": record.run_id,
                    "status": record.status,
                    "since_seq": since,
                    "last_event_seq": record.last_event_seq,
                    "events": events,
                }),
            ))
        }

        (&Method::GET, ["v1", "projects", project, "runs", run, "events", "stream"]) => {
            let since = cursor_from(&query, last_event_id.as_deref())?;
            // Prove the run exists and belongs to the project before streaming.
            let record = service.get_run(project, run).await?;
            Ok(sse_response(service.clone(), record.run_id, since))
        }

        (&Method::POST, ["v1", "projects", project, "runs", run, "approval"]) => {
            let body = read_body(service, request).await?;
            let choice = body.get("choice").and_then(Value::as_str).ok_or_else(|| {
                ServiceError::BadRequest {
                    code: "missing_field",
                    message: "choice is required".to_owned(),
                }
            })?;
            Ok(json_response(
                StatusCode::OK,
                &service.resolve_approval(project, run, choice).await?,
            ))
        }

        (&Method::POST, ["v1", "projects", project, "runs", run, "cancel"]) => Ok(json_response(
            StatusCode::OK,
            &service.cancel_run(project, run).await?,
        )),

        (&Method::POST, ["v1", "projects", project, "runs", run, "retry"]) => {
            let created = service.retry_run(project, run).await?;
            Ok(json_response(
                StatusCode::CREATED,
                &json!({
                    "run": created.run,
                    "retry_of_run_id": created.run.retry_of_run_id,
                }),
            ))
        }

        (&Method::POST, ["v1", "projects", project, "reconcile"]) => {
            let outcomes = service.reconcile(project).await?;
            Ok(json_response(
                StatusCode::OK,
                &json!({"project_id": project, "reconciled": outcomes.len(), "runs": outcomes}),
            ))
        }

        (&Method::GET, ["v1", "projects", project, "activity"]) => Ok(json_response(
            StatusCode::OK,
            &json!(service.project_activity(project).await?),
        )),

        _ => Err(ServiceError::NotFound {
            code: "unknown_route",
            message: format!("no route for {method} {path}"),
        }),
    }
}

fn parse_create_run(body: &Value) -> ServiceResult<CreateRun> {
    let input =
        body.get("input")
            .and_then(Value::as_str)
            .ok_or_else(|| ServiceError::BadRequest {
                code: "missing_field",
                message: "input is required".to_owned(),
            })?;

    Ok(CreateRun {
        input: input.to_owned(),
        session_id: string_field(body, "session_id"),
        instructions: string_field(body, "instructions"),
        idempotency_key: string_field(body, "idempotency_key"),
    })
}

fn string_field(body: &Value, name: &str) -> Option<String> {
    body.get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

/// Resolve the replay cursor from `Last-Event-ID`, falling back to the query
/// parameter for clients that cannot set the header.
fn cursor_from(query: &str, last_event_id: Option<&str>) -> ServiceResult<i64> {
    let raw = last_event_id
        .map(ToOwned::to_owned)
        .or_else(|| query_param(query, "since_seq"))
        .or_else(|| query_param(query, "last_event_id"));

    match raw {
        None => Ok(0),
        Some(value) => {
            value
                .trim()
                .parse::<i64>()
                .ok()
                .filter(|v| *v >= 0)
                .ok_or(ServiceError::BadRequest {
                    code: "invalid_cursor",
                    message: "cursor must be a non-negative integer sequence number".to_owned(),
                })
        }
    }
}

fn query_param(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == name).then(|| value.to_owned())
    })
}

async fn read_body(service: &NodeService, request: Request<Incoming>) -> ServiceResult<Value> {
    let limit = service.limits().max_request_bytes;
    let collected = request
        .into_body()
        .collect()
        .await
        .map_err(|error| ServiceError::BadRequest {
            code: "malformed_request",
            message: format!("could not read the request body: {error}"),
        })?
        .to_bytes();

    if collected.len() > limit {
        return Err(ServiceError::BadRequest {
            code: "request_too_large",
            message: format!("request body exceeds {limit} bytes"),
        });
    }
    if collected.is_empty() {
        return Ok(json!({}));
    }

    serde_json::from_slice(&collected).map_err(|error| ServiceError::BadRequest {
        code: "malformed_json",
        message: format!("request body is not valid JSON: {error}"),
    })
}

fn json_response(status: StatusCode, value: &Value) -> Response<ApiBody> {
    let body = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(full(body))
        .expect("response builder inputs are valid")
}

fn error_response(error: &ServiceError) -> Response<ApiBody> {
    if let ServiceError::Internal(detail) = error {
        // Logged here, never returned: the caller gets an opaque message.
        eprintln!("[asterism] internal error: {detail:#}");
    }
    let status = StatusCode::from_u16(error.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    json_response(
        status,
        &json!({"error": error.code(), "message": error.public_message()}),
    )
}

fn full(body: Vec<u8>) -> ApiBody {
    Full::new(Bytes::from(body)).boxed()
}

/// Stream a run's journal as SSE: replay everything after the cursor, then keep
/// following.
///
/// The catch-up loop reads SQLite exclusively; the in-memory notification bus is
/// only a wake-up, so a dropped notification delays delivery rather than losing
/// an event. Because every iteration re-queries from the cursor, there is no
/// window between "replay finished" and "live subscription started" in which an
/// appended event could be missed.
fn sse_response(service: NodeService, run_id: String, since_seq: i64) -> Response<ApiBody> {
    let (tx, rx) = tokio::sync::mpsc::channel::<Bytes>(64);
    let heartbeat = std::time::Duration::from_secs(service.limits().heartbeat_seconds);

    tokio::spawn(async move {
        // Subscribe before the first query so an event appended during replay
        // still produces a wake-up.
        let mut wakeups = service.subscribe();
        let mut cursor = since_seq;

        loop {
            let (events, status) = match service.stream_page(&run_id, cursor).await {
                Ok(page) => page,
                Err(_) => break,
            };

            let drained = events.len();
            for event in &events {
                if tx.send(sse_frame(event)).await.is_err() {
                    return; // client went away
                }
                cursor = event.seq;
            }

            // A full page may hide more; keep draining before waiting.
            if drained as i64 >= service.limits().stream_page_size {
                continue;
            }

            if status.is_terminal() {
                let _ = tx
                    .send(Bytes::from(format!(
                        ": run terminal ({})\n\n",
                        status.as_str()
                    )))
                    .await;
                return;
            }

            tokio::select! {
                received = wakeups.recv() => {
                    match received {
                        Ok(woken) if woken != run_id => continue,
                        // A lagged receiver simply re-queries; SQLite is the
                        // source of truth, so nothing is lost.
                        Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => return,
                    }
                }
                _ = tokio::time::sleep(heartbeat) => {
                    if tx.send(Bytes::from_static(b": heartbeat\n\n")).await.is_err() {
                        return;
                    }
                }
            }
        }
    });

    let body_stream = stream::unfold(rx, |mut rx| async move {
        rx.recv()
            .await
            .map(|chunk| (Ok::<_, Infallible>(Frame::data(chunk)), rx))
    });
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-cache")
        .body(BoxBody::new(StreamBody::new(body_stream)))
        .expect("response builder inputs are valid")
}

/// Render one journal entry as an SSE frame.
///
/// `id` is the per-run sequence number, which is exactly what a client sends
/// back as `Last-Event-ID` to resume without a gap.
fn sse_frame(event: &StoredEvent) -> Bytes {
    let payload = serde_json::to_string(event).unwrap_or_else(|_| "{}".to_owned());
    Bytes::from(format!(
        "id: {}\nevent: {}\ndata: {}\n\n",
        event.seq, event.event_type, payload
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_prefers_the_last_event_id_header() {
        assert_eq!(cursor_from("since_seq=5", Some("42")).unwrap(), 42);
    }

    #[test]
    fn cursor_falls_back_to_query_parameters() {
        assert_eq!(cursor_from("since_seq=7", None).unwrap(), 7);
        assert_eq!(cursor_from("last_event_id=9", None).unwrap(), 9);
        assert_eq!(cursor_from("", None).unwrap(), 0);
    }

    #[test]
    fn cursor_rejects_malformed_or_negative_values() {
        for bad in ["abc", "-1", "1.5", ""] {
            assert!(
                cursor_from(&format!("since_seq={bad}"), None).is_err(),
                "{bad:?} must be rejected"
            );
        }
        assert!(cursor_from("", Some("not-a-number")).is_err());
    }

    #[test]
    fn query_parameters_are_extracted_by_exact_name() {
        let query = "limit=10&since_seq=3&limits=99";
        assert_eq!(query_param(query, "limit").as_deref(), Some("10"));
        assert_eq!(query_param(query, "since_seq").as_deref(), Some("3"));
        assert_eq!(query_param(query, "missing"), None);
    }

    #[test]
    fn create_run_requires_input() {
        assert!(parse_create_run(&json!({})).is_err());
        let parsed = parse_create_run(&json!({"input": "hi", "session_id": "s"})).unwrap();
        assert_eq!(parsed.input, "hi");
        assert_eq!(parsed.session_id.as_deref(), Some("s"));
        assert_eq!(parsed.instructions, None);
    }

    #[test]
    fn empty_optional_strings_are_treated_as_absent() {
        let parsed = parse_create_run(&json!({"input": "hi", "session_id": ""})).unwrap();
        assert_eq!(parsed.session_id, None);
    }

    #[test]
    fn sse_frames_carry_the_sequence_as_the_event_id() {
        let event = StoredEvent {
            run_id: "arun_1".into(),
            seq: 17,
            event_type: "tool.started".into(),
            recorded_at: 1,
            source: "hermes".into(),
            payload: json!({"tool": "terminal"}),
            raw_payload: None,
            redacted: false,
        };
        let rendered = String::from_utf8(sse_frame(&event).to_vec()).unwrap();

        assert!(rendered.starts_with("id: 17\n"));
        assert!(rendered.contains("event: tool.started\n"));
        assert!(rendered.contains("\"seq\":17"));
        assert!(rendered.ends_with("\n\n"));
    }

    #[test]
    fn error_responses_use_the_service_status_and_code() {
        let response = error_response(&ServiceError::Conflict {
            code: "run_conflict",
            message: "busy".into(),
        });
        assert_eq!(response.status(), StatusCode::CONFLICT);
    }

    #[test]
    fn internal_errors_do_not_leak_detail_into_the_response_status() {
        let response = error_response(&ServiceError::Internal(anyhow::anyhow!(
            "sqlite: no such table: secrets"
        )));
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }
}
