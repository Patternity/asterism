//! Minimal HTTP/1.1 client for the local Unix-socket control API.
//!
//! The CLI is now a thin client of the daemon. It never opens the registry,
//! never spawns workers, and never talks to Hermes: the daemon is the single
//! owner of active run supervision, and a second path into that state would
//! reintroduce exactly the split ownership Phase E exists to remove.
//!
//! The protocol surface is deliberately small — this client only has to speak to
//! the server in [`crate::api`], so it implements just the request shapes and
//! response framing that server produces.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

use crate::daemon::{NODE_UNAVAILABLE_CODE, socket_path};

/// The daemon is not listening on the expected socket.
#[derive(Debug, Clone)]
pub struct NodeUnavailable {
    pub socket: PathBuf,
    pub detail: String,
}

impl std::fmt::Display for NodeUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "the Asterism Node daemon is not reachable at {} ({}). Start it with: asterism-node node serve",
            self.socket.display(),
            self.detail
        )
    }
}

impl std::error::Error for NodeUnavailable {}

/// A non-2xx response carrying the API's typed error code.
#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: u16,
    pub code: String,
    pub message: String,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({}): {}", self.code, self.status, self.message)
    }
}

impl std::error::Error for ApiError {}

/// Client bound to one Node state directory.
#[derive(Debug, Clone)]
pub struct NodeClient {
    socket: PathBuf,
}

impl NodeClient {
    pub fn new(state_root: impl AsRef<Path>) -> Self {
        Self {
            socket: socket_path(state_root),
        }
    }

    pub fn socket(&self) -> &Path {
        &self.socket
    }

    async fn connect(&self) -> Result<UnixStream> {
        UnixStream::connect(&self.socket).await.map_err(|error| {
            NodeUnavailable {
                socket: self.socket.clone(),
                detail: error.to_string(),
            }
            .into()
        })
    }

    /// Send a request and decode a JSON response.
    pub async fn request(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value> {
        let mut stream = self.connect().await?;
        write_request(&mut stream, method, path, body, None).await?;

        let mut reader = BufReader::new(stream);
        let (status, headers) = read_head(&mut reader).await?;
        let body = read_body(&mut reader, &headers).await?;
        let value: Value = if body.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(&body).unwrap_or_else(|_| json!({"raw": body}))
        };

        if !(200..300).contains(&status) {
            return Err(ApiError {
                status,
                code: value
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown_error")
                    .to_owned(),
                message: value
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("no message")
                    .to_owned(),
            }
            .into());
        }
        Ok(value)
    }

    /// Follow an SSE stream, invoking `on_event` for each frame.
    ///
    /// `last_event_id` is the replay cursor: the server resumes strictly after
    /// it, so a reconnecting client sees no gap and no duplicate.
    pub async fn stream<F>(
        &self,
        path: &str,
        last_event_id: Option<i64>,
        mut on_event: F,
    ) -> Result<()>
    where
        F: FnMut(SseFrame) -> Result<bool>,
    {
        let mut stream = self.connect().await?;
        let header = last_event_id.map(|seq| ("Last-Event-ID", seq.to_string()));
        write_request(&mut stream, "GET", path, None, header).await?;

        let mut reader = BufReader::new(stream);
        let (status, headers) = read_head(&mut reader).await?;
        if !(200..300).contains(&status) {
            let body = read_body(&mut reader, &headers).await?;
            let value: Value = serde_json::from_str(&body).unwrap_or_else(|_| json!({}));
            return Err(ApiError {
                status,
                code: value
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown_error")
                    .to_owned(),
                message: value
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("no message")
                    .to_owned(),
            }
            .into());
        }

        let chunked = headers
            .iter()
            .any(|(name, value)| name == "transfer-encoding" && value.contains("chunked"));

        let mut parser = crate::sse::SseParser::default();
        let mut pending = String::new();
        loop {
            let chunk = if chunked {
                match read_chunk(&mut reader).await? {
                    Some(chunk) => chunk,
                    None => break,
                }
            } else {
                let mut buffer = vec![0u8; 8192];
                let read = reader.read(&mut buffer).await?;
                if read == 0 {
                    break;
                }
                buffer.truncate(read);
                buffer
            };

            pending.push_str(&String::from_utf8_lossy(&chunk));
            let text = std::mem::take(&mut pending);
            for event in parser.push(&text) {
                let seq = event
                    .json_data()
                    .and_then(|value| value.get("seq").and_then(Value::as_i64));
                if !on_event(SseFrame {
                    seq,
                    event_type: event.event.clone(),
                    data: event.data.clone(),
                })? {
                    return Ok(());
                }
            }
        }
        Ok(())
    }
}

/// One decoded SSE frame.
#[derive(Debug, Clone)]
pub struct SseFrame {
    /// Sequence number, taken from the payload. Doubles as the replay cursor.
    pub seq: Option<i64>,
    pub event_type: Option<String>,
    pub data: String,
}

async fn write_request(
    stream: &mut UnixStream,
    method: &str,
    path: &str,
    body: Option<&Value>,
    extra_header: Option<(&str, String)>,
) -> Result<()> {
    let encoded = body.map(serde_json::to_vec).transpose()?;
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: asterism.local\r\n");
    if let Some((name, value)) = extra_header {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    match &encoded {
        Some(bytes) => request.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            bytes.len()
        )),
        None => request.push_str("Content-Length: 0\r\n"),
    }
    request.push_str("Connection: close\r\n\r\n");

    stream.write_all(request.as_bytes()).await?;
    if let Some(bytes) = encoded {
        stream.write_all(&bytes).await?;
    }
    stream.flush().await?;
    Ok(())
}

async fn read_head(reader: &mut BufReader<UnixStream>) -> Result<(u16, Vec<(String, String)>)> {
    let status_line = read_line(reader).await?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .with_context(|| format!("malformed status line from the node: {status_line:?}"))?;

    let mut headers = Vec::new();
    loop {
        let line = read_line(reader).await?;
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((
                name.trim().to_ascii_lowercase(),
                value.trim().to_ascii_lowercase(),
            ));
        }
    }
    Ok((status, headers))
}

async fn read_body(
    reader: &mut BufReader<UnixStream>,
    headers: &[(String, String)],
) -> Result<String> {
    let chunked = headers
        .iter()
        .any(|(name, value)| name == "transfer-encoding" && value.contains("chunked"));

    if chunked {
        let mut body = Vec::new();
        while let Some(chunk) = read_chunk(reader).await? {
            body.extend_from_slice(&chunk);
        }
        return Ok(String::from_utf8_lossy(&body).into_owned());
    }

    let length = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok());

    match length {
        Some(length) => {
            let mut buffer = vec![0u8; length];
            reader.read_exact(&mut buffer).await?;
            Ok(String::from_utf8_lossy(&buffer).into_owned())
        }
        None => {
            let mut body = String::new();
            reader.read_to_string(&mut body).await?;
            Ok(body)
        }
    }
}

/// Read one chunk of a `Transfer-Encoding: chunked` body.
///
/// Returns `None` at the terminating zero-length chunk.
async fn read_chunk(reader: &mut BufReader<UnixStream>) -> Result<Option<Vec<u8>>> {
    let size_line = read_line(reader).await?;
    let size_text = size_line.split(';').next().unwrap_or_default().trim();
    if size_text.is_empty() {
        return Ok(None);
    }
    let size = usize::from_str_radix(size_text, 16)
        .with_context(|| format!("malformed chunk size {size_text:?}"))?;
    if size == 0 {
        // Consume the trailing CRLF of the terminating chunk.
        let _ = read_line(reader).await;
        return Ok(None);
    }

    let mut buffer = vec![0u8; size];
    reader.read_exact(&mut buffer).await?;
    // Each chunk is followed by CRLF.
    let mut terminator = [0u8; 2];
    let _ = reader.read_exact(&mut terminator).await;
    Ok(Some(buffer))
}

async fn read_line(reader: &mut BufReader<UnixStream>) -> Result<String> {
    let mut line = Vec::new();
    loop {
        let mut byte = [0u8; 1];
        let read = reader.read(&mut byte).await?;
        if read == 0 {
            if line.is_empty() {
                bail!("the node closed the connection unexpectedly");
            }
            break;
        }
        if byte[0] == b'\n' {
            break;
        }
        if byte[0] != b'\r' {
            line.push(byte[0]);
        }
    }
    Ok(String::from_utf8_lossy(&line).into_owned())
}

/// Render a client-facing failure for a missing daemon, using the same code the
/// API would have returned.
pub fn unavailable_json(error: &NodeUnavailable) -> Value {
    json!({
        "error": NODE_UNAVAILABLE_CODE,
        "message": error.to_string(),
        "socket": error.socket.display().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_client_targets_the_node_socket() {
        let client = NodeClient::new("/srv/state");
        assert_eq!(client.socket(), Path::new("/srv/state/node/asterism.sock"));
    }

    #[test]
    fn an_absent_daemon_is_reported_with_a_typed_code_and_instructions() {
        let error = NodeUnavailable {
            socket: PathBuf::from("/srv/state/node/asterism.sock"),
            detail: "No such file or directory".to_owned(),
        };
        let rendered = unavailable_json(&error);

        assert_eq!(rendered["error"], json!(NODE_UNAVAILABLE_CODE));
        assert!(
            rendered["message"].as_str().unwrap().contains("node serve"),
            "the message must tell the operator how to start the daemon"
        );
    }

    #[test]
    fn api_errors_preserve_the_status_and_code() {
        let error = ApiError {
            status: 409,
            code: "run_conflict".to_owned(),
            message: "busy".to_owned(),
        };
        assert_eq!(error.status, 409);
        assert!(error.to_string().contains("run_conflict"));
    }
}
