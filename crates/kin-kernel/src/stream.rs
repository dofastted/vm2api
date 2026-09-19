use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::model::{
    CacheCreation, ContentBlock, MessageRequest, MessageResponse, StopReason, Usage,
};

#[derive(Debug)]
pub enum StreamItem {
    Event(Value),
    Finished(MessageResponse),
}

#[derive(Debug)]
pub struct StreamAssembler {
    id: String,
    model: String,
    content: Vec<ContentBlock>,
    stop: StopReason,
    usage: Usage,
    tool_json: Vec<String>,
    saw_stop: bool,
}

impl StreamAssembler {

    pub fn new(model: impl Into<String>) -> Self {
        Self {
            id: format!("msg_{}", Uuid::new_v4().simple()),
            model: model.into(),
            content: Vec::new(),
            stop: StopReason::EndTurn,
            usage: Usage::default(),
            tool_json: Vec::new(),
            saw_stop: false,
        }
    }

    pub fn apply_event(&mut self, event: &Value) {
        match event.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                if let Some(message) = event.get("message") {
                    if let Some(id) = message.get("id").and_then(Value::as_str) {
                        self.id = id.to_string();
                    }
                    if let Some(model) = message.get("model").and_then(Value::as_str) {
                        self.model = model.to_string();
                    }
                    if let Some(usage) = message.get("usage") {
                        self.apply_usage(usage);
                    }
                }
            }
            Some("content_block_start") => {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                self.ensure_index(index);
                let block = event.get("content_block").cloned().unwrap_or(json!({}));
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        self.content[index] = ContentBlock::Text {
                            text: block
                                .get("text")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            cache_control: None,
                        };
                    }
                    Some("thinking") => {
                        self.content[index] = ContentBlock::Thinking {
                            thinking: block
                                .get("thinking")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            signature: block
                                .get("signature")
                                .and_then(Value::as_str)
                                .map(ToOwned::to_owned),
                        };
                    }
                    Some("image") => {
                        self.content[index] = ContentBlock::Image {
                            source: block.get("source").cloned().unwrap_or(json!({})),
                        };
                    }
                    Some("tool_use") => {
                        self.content[index] = ContentBlock::ToolUse {
                            id: block
                                .get("id")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            name: block
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            input: block.get("input").cloned().unwrap_or(json!({})),
                            cache_control: None,
                        };
                        // Real Anthropic streams always send an empty `input: {}`
                        // placeholder here; the actual arguments arrive as
                        // `input_json_delta` fragments and are parsed whole at
                        // `content_block_stop`. Seeding tool_json from a
                        // non-empty `input` here would corrupt that
                        // concatenation (e.g. `{}` + delta fragments is not
                        // valid JSON), so always start the accumulator empty.
                        self.tool_json[index] = String::new();
                    }
                    Some("server_tool_use") => {
                        self.content[index] = ContentBlock::ServerToolUse {
                            id: block
                                .get("id")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            name: block
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            input: block.get("input").cloned().unwrap_or(json!({})),
                            cache_control: None,
                        };
                        // Same placeholder-input pitfall as `tool_use` above:
                        // real args arrive via `input_json_delta` and are
                        // parsed whole at `content_block_stop`.
                        self.tool_json[index] = String::new();
                    }
                    Some("web_search_tool_result") => {
                        self.content[index] = ContentBlock::WebSearchToolResult {
                            tool_use_id: block
                                .get("tool_use_id")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            content: block.get("content").cloned().unwrap_or(Value::Null),
                            cache_control: None,
                        };
                    }
                    _ => {}
                }
            }
            Some("content_block_delta") => {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                self.ensure_index(index);
                let delta = event.get("delta").cloned().unwrap_or(json!({}));
                match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => {
                        let piece = delta.get("text").and_then(Value::as_str).unwrap_or("");
                        match &mut self.content[index] {
                            ContentBlock::Text { text, .. } => text.push_str(piece),
                            _ => {
                                self.content[index] = ContentBlock::Text {
                                    text: piece.to_string(),
                                    cache_control: None,
                                };
                            }
                        }
                    }
                    Some("thinking_delta") => {
                        let piece = delta.get("thinking").and_then(Value::as_str).unwrap_or("");
                        match &mut self.content[index] {
                            ContentBlock::Thinking { thinking, .. } => thinking.push_str(piece),
                            _ => {
                                self.content[index] = ContentBlock::Thinking {
                                    thinking: piece.to_string(),
                                    signature: None,
                                };
                            }
                        }
                    }
                    Some("input_json_delta") => {
                        if let Some(piece) = delta.get("partial_json").and_then(Value::as_str) {
                            self.tool_json[index].push_str(piece);
                        }
                    }
                    _ => {}
                }
            }
            Some("content_block_stop") => {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                if let Some(raw) = self.tool_json.get(index)
                    && !raw.is_empty()
                    && let Ok(parsed) = serde_json::from_str::<Value>(raw)
                {
                    match &mut self.content[index] {
                        ContentBlock::ToolUse { input, .. } => *input = parsed,
                        ContentBlock::ServerToolUse { input, .. } => *input = parsed,
                        _ => {}
                    }
                }
            }
            Some("message_delta") => {
                if let Some(usage) = event.get("usage") {
                    if let Some(tokens) = usage.get("output_tokens").and_then(Value::as_u64) {
                        self.usage.output_tokens = tokens;
                    }
                    if let Some(tokens) = usage.get("input_tokens").and_then(Value::as_u64) {
                        self.usage.input_tokens = tokens;
                    }
                }
                if let Some(reason) = event.pointer("/delta/stop_reason").and_then(Value::as_str) {
                    self.stop = map_stop_reason(reason);
                }
            }
            Some("message_stop") => self.saw_stop = true,
            _ => {}
        }
    }

    pub fn finish(self, request: &MessageRequest) -> MessageResponse {
        MessageResponse {
            id: self.id,
            r#type: "message",
            role: "assistant",
            model: if self.model.is_empty() {
                request.model.clone()
            } else {
                self.model
            },
            content: self.content,
            stop_reason: self.stop,
            usage: self.usage,
        }
    }

    pub fn parts(self) -> (Vec<ContentBlock>, StopReason, Usage) {
        (self.content, self.stop, self.usage)
    }

    pub fn saw_stop(&self) -> bool {
        self.saw_stop
    }

    fn ensure_index(&mut self, index: usize) {
        while self.content.len() <= index {
            self.content.push(ContentBlock::Text {
                text: String::new(),
                cache_control: None,
            });
            self.tool_json.push(String::new());
        }
    }

    fn apply_usage(&mut self, usage: &Value) {
        if let Some(tokens) = json_u64(usage.get("input_tokens")) {
            self.usage.input_tokens = tokens;
        }
        if let Some(tokens) = json_u64(usage.get("output_tokens")) {
            self.usage.output_tokens = tokens;
        }
        if let Some(tokens) = json_u64(usage.get("cache_read_input_tokens")) {
            self.usage.cache_read_input_tokens = tokens;
        }
        if let Some(tokens) = json_u64(usage.get("cache_creation_input_tokens")) {
            self.usage.cache_creation_input_tokens = tokens;
        }
        if let Some(creation) = usage.get("cache_creation") {
            self.usage.cache_creation = Some(merge_cache_creation(
                self.usage.cache_creation.take(),
                creation,
            ));
        }
    }
}

pub fn merge_usage(current: &mut Map<String, Value>, next: &Map<String, Value>) {
    for (key, value) in next {
        current.insert(key.clone(), value.clone());
    }
}

pub fn event_usage(event: &Value) -> Option<Map<String, Value>> {
    if let Some(usage) = event.get("usage").and_then(Value::as_object) {
        return Some(usage.clone());
    }
    event
        .get("message")
        .and_then(|message| message.get("usage"))
        .and_then(Value::as_object)
        .cloned()
}

pub fn event_model(event: &Value) -> Option<String> {
    event
        .get("message")
        .and_then(|message| message.get("model"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

pub fn event_stop_reason(event: &Value) -> Option<String> {
    event
        .pointer("/delta/stop_reason")
        .or_else(|| event.pointer("/message/stop_reason"))
        .and_then(Value::as_str)
        .filter(|reason| !reason.is_empty())
        .map(ToOwned::to_owned)
}

fn merge_cache_creation(current: Option<CacheCreation>, next: &Value) -> CacheCreation {
    let mut cache = current.unwrap_or_default();
    if let Some(tokens) = json_u64(next.get("ephemeral_5m_input_tokens")) {
        cache.ephemeral_5m_input_tokens = tokens;
    }
    if let Some(tokens) = json_u64(next.get("ephemeral_1h_input_tokens")) {
        cache.ephemeral_1h_input_tokens = tokens;
    }
    cache
}

fn json_u64(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|n| u64::try_from(n).ok()))
        .or_else(|| value.as_f64().and_then(|n| (n >= 0.0).then_some(n as u64)))
}

pub fn parse_sse_block(block: &str) -> Option<Value> {
    let mut data = String::new();
    for line in block.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(rest) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.trim_start());
        }
    }
    if data.is_empty() || data == "[DONE]" {
        return None;
    }
    serde_json::from_str(&data).ok()
}

pub fn map_stop_reason(value: &str) -> StopReason {
    match value {
        "end_turn" => StopReason::EndTurn,
        "tool_use" => StopReason::ToolUse,
        "max_tokens" => StopReason::MaxTokens,
        "stop_sequence" => StopReason::StopSequence,
        "pause_turn" => StopReason::PauseTurn,
        "refusal" => StopReason::Refusal,
        "model_context_window_exceeded" => StopReason::ModelContextWindowExceeded,
        _ => StopReason::Unknown,
    }
}

pub fn openai_chunk(id: &str, model: &str, delta: Value, finish: Option<&str>) -> Value {
    json!({
        "id": id,
        "object": "chat.completion.chunk",
        "model": model,
        "choices": [{
            "index": 0,
            "delta": delta,
            "finish_reason": finish
        }]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concatenates_text_deltas() {
        let mut assembler = StreamAssembler::new("claude-sonnet-5");
        assembler.apply_event(&json!({
            "type": "content_block_start",
            "index": 0,
            "content_block": { "type": "text", "text": "" }
        }));
        assembler.apply_event(&json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "text_delta", "text": "Hel" }
        }));
        assembler.apply_event(&json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "text_delta", "text": "lo" }
        }));
        let (content, _, _) = assembler.parts();
        match &content[0] {
            ContentBlock::Text { text, .. } => assert_eq!(text, "Hello"),
            _ => panic!("expected text"),
        }
    }

    #[test]
    fn message_stop_sets_saw_stop() {
        let mut assembler = StreamAssembler::new("claude-sonnet-5");
        assert!(!assembler.saw_stop());
        assembler.apply_event(&json!({ "type": "message_stop" }));
        assert!(assembler.saw_stop());
    }

    #[test]
    fn parses_sse_data_block() {
        let event = parse_sse_block("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"ab\"}}\n").unwrap();
        assert_eq!(event["type"], "content_block_delta");
        assert_eq!(event["delta"]["text"], "ab");
    }

    #[test]
    fn merges_sub2api_cache_usage_from_start_and_delta() {
        let mut assembler = StreamAssembler::new("claude-haiku-4-5-20251001");
        assembler.apply_event(&json!({
            "type": "message_start",
            "message": {
                "model": "claude-haiku-4-5-20251001",
                "usage": {
                    "input_tokens": 12,
                    "cache_read_input_tokens": 3,
                    "cache_creation_input_tokens": 7,
                    "cache_creation": {
                        "ephemeral_5m_input_tokens": 5,
                        "ephemeral_1h_input_tokens": 2
                    }
                }
            }
        }));
        assembler.apply_event(&json!({
            "type": "message_delta",
            "delta": { "stop_reason": "end_turn" },
            "usage": { "output_tokens": 4 }
        }));
        let (_, _, usage) = assembler.parts();
        assert_eq!(usage.input_tokens, 12);
        assert_eq!(usage.output_tokens, 4);
        assert_eq!(usage.cache_read_input_tokens, 3);
        assert_eq!(usage.cache_creation_input_tokens, 7);
        let cache_creation = usage.cache_creation.unwrap();
        assert_eq!(cache_creation.ephemeral_5m_input_tokens, 5);
        assert_eq!(cache_creation.ephemeral_1h_input_tokens, 2);
    }

    #[test]
    fn merge_usage_keeps_start_fields_when_delta_only_has_output() {
        let mut usage = Map::new();
        let start = json!({
            "type": "message_start",
            "message": {
                "usage": {
                    "input_tokens": 12,
                    "cache_read_input_tokens": 3,
                    "cache_creation_input_tokens": 7,
                    "cache_creation": {
                        "ephemeral_5m_input_tokens": 5,
                        "ephemeral_1h_input_tokens": 2
                    }
                }
            }
        });
        merge_usage(&mut usage, &event_usage(&start).unwrap());
        let delta = json!({
            "type": "message_delta",
            "delta": { "stop_reason": "end_turn" },
            "usage": { "output_tokens": 4 }
        });
        merge_usage(&mut usage, &event_usage(&delta).unwrap());
        assert_eq!(usage["input_tokens"], 12);
        assert_eq!(usage["output_tokens"], 4);
        assert_eq!(usage["cache_read_input_tokens"], 3);
        assert_eq!(usage["cache_creation"]["ephemeral_5m_input_tokens"], 5);
        assert_eq!(usage["cache_creation"]["ephemeral_1h_input_tokens"], 2);
    }

    /// AC5: a native `server_tool_use` block (e.g. WebSearch) must assemble
    /// its real `input` from `input_json_delta` fragments at
    /// `content_block_stop`, exactly like `tool_use` — not keep the
    /// `content_block_start` placeholder `{}`.
    #[test]
    fn assembles_server_tool_use_input_from_deltas() {
        let mut assembler = StreamAssembler::new("claude-haiku-4-5-20251001");
        assembler.apply_event(&json!({
            "type": "content_block_start",
            "index": 0,
            "content_block": { "type": "server_tool_use", "id": "srvtoolu_1", "name": "web_search", "input": {} }
        }));
        for chunk in ["{\"qu", "ery\":\"cur", "rent UTC time\"}"] {
            assembler.apply_event(&json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "input_json_delta", "partial_json": chunk }
            }));
        }
        assembler.apply_event(&json!({
            "type": "content_block_stop",
            "index": 0
        }));
        let (content, _, _) = assembler.parts();
        match &content[0] {
            ContentBlock::ServerToolUse { name, input, .. } => {
                assert_eq!(name, "web_search");
                assert_eq!(input, &json!({"query": "current UTC time"}));
            }
            other => panic!("expected server_tool_use block, got {other:?}"),
        }
    }

    /// AC3 regression fixture: a real captured `tool_use` event sequence
    /// (job_ad1947...) that once produced an empty `input` object in a
    /// live-server run. Feeding it directly to a fresh `StreamAssembler`
    /// reproduces the correct assembled input, confirming the assembler
    /// logic itself is not the source of that one-off anomaly.
    #[test]
    fn assembles_tool_use_input_from_real_captured_event_sequence() {
        let mut assembler = StreamAssembler::new("claude-sonnet-5");
        let events: Vec<Value> = vec![
            json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01RPzzVenCnqx1J4HnyUwCX4","name":"get_weather","input":{},"caller":{"type":"direct"}}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"city\""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":": \"To"}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"kyo\""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":", \"un"}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"it\": \"c"}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"el"}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"sius"}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"}"}}),
            json!({"type":"content_block_stop","index":0}),
        ];
        for ev in &events {
            assembler.apply_event(ev);
        }
        let (content, _stop, _usage) = assembler.parts();
        match &content[0] {
            ContentBlock::ToolUse { input, .. } => {
                assert_eq!(
                    input,
                    &json!({"city":"Tokyo","unit":"celsius"}),
                    "input was: {input:?}"
                );
            }
            other => panic!("expected tool_use, got {other:?}"),
        }
    }
}
