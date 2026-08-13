use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

impl SseEvent {
    pub fn json_data(&self) -> Option<Value> {
        serde_json::from_str(&self.data).ok()
    }
}

#[derive(Debug, Default)]
pub struct SseParser {
    buffer: String,
    event_name: Option<String>,
    data_lines: Vec<String>,
}

impl SseParser {
    pub fn push(&mut self, chunk: &str) -> Vec<SseEvent> {
        self.buffer.push_str(chunk);
        let mut events = Vec::new();

        while let Some(newline) = self.buffer.find('\n') {
            let mut line = self.buffer[..newline].to_owned();
            self.buffer.drain(..=newline);

            if line.ends_with('\r') {
                line.pop();
            }

            if line.is_empty() {
                if let Some(event) = self.finish_event() {
                    events.push(event);
                }
                continue;
            }

            if line.starts_with(':') {
                continue;
            }

            let (field, value) = match line.split_once(':') {
                Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
                None => (line.as_str(), ""),
            };

            match field {
                "event" => self.event_name = Some(value.to_owned()),
                "data" => self.data_lines.push(value.to_owned()),
                _ => {}
            }
        }

        events
    }

    pub fn finish(mut self) -> Option<SseEvent> {
        if !self.buffer.is_empty() {
            let line = std::mem::take(&mut self.buffer);
            if let Some(value) = line.strip_prefix("data:") {
                self.data_lines
                    .push(value.strip_prefix(' ').unwrap_or(value).to_owned());
            }
        }
        self.finish_event()
    }

    fn finish_event(&mut self) -> Option<SseEvent> {
        if self.data_lines.is_empty() && self.event_name.is_none() {
            return None;
        }

        Some(SseEvent {
            event: self.event_name.take(),
            data: std::mem::take(&mut self.data_lines).join("\n"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fragmented_events() {
        let mut parser = SseParser::default();

        assert!(parser.push("event: tool.start\nda").is_empty());
        let events = parser.push("ta: {\"tool\":\"terminal\"}\n\n");

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event.as_deref(), Some("tool.start"));
        assert_eq!(
            events[0].json_data(),
            Some(serde_json::json!({"tool": "terminal"}))
        );
    }

    #[test]
    fn joins_multiline_data_and_ignores_comments() {
        let mut parser = SseParser::default();
        let events = parser.push(": keepalive\nevent: message\ndata: first\ndata: second\n\n");

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "first\nsecond");
    }
}
