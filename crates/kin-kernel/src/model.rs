use serde::ser::SerializeMap;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Map, Value};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MessageRequest {
    pub model: String,
    pub messages: Vec<Message>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<SystemPrompt>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolDefinition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
    pub max_tokens: u32,
    #[serde(default, skip_serializing_if = "is_false")]
    pub stream: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_k: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stop_sequences: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub betas: Vec<String>,
    #[serde(default, flatten)]
    pub extra: Map<String, Value>,
}

impl Default for MessageRequest {
    fn default() -> Self {
        Self {
            model: String::new(),
            messages: Vec::new(),
            system: None,
            tools: Vec::new(),
            tool_choice: None,
            thinking: None,
            metadata: None,
            max_tokens: 1024,
            stream: false,
            temperature: None,
            top_p: None,
            top_k: None,
            stop_sequences: Vec::new(),
            betas: Vec::new(),
            extra: Map::new(),
        }
    }
}

impl MessageRequest {
    pub fn normalize_openai_tools(&mut self) {
        for message in &mut self.messages {
            if message.role == "tool"
                && let Some(id) = message.tool_call_id.clone()
            {
                let content = match &message.content {
                    MessageContent::Text(text) => Value::String(text.clone()),
                    MessageContent::Blocks(blocks) => {
                        serde_json::to_value(blocks).unwrap_or(Value::Null)
                    }
                };
                message.content = MessageContent::Blocks(vec![ContentBlock::ToolResult {
                    tool_use_id: id,
                    content,
                    is_error: false,
                    cache_control: None,
                }]);
                message.tool_call_id = None;
            }
            if !message.tool_calls.is_empty() {
                let mut blocks = Vec::new();
                if let MessageContent::Text(text) = &message.content
                    && !text.is_empty()
                {
                    blocks.push(ContentBlock::Text {
                        text: text.clone(),
                        cache_control: None,
                    });
                }
                if let MessageContent::Blocks(existing) = &message.content {
                    blocks.extend(existing.clone());
                }
                for call in message.tool_calls.drain(..) {
                    let input = serde_json::from_str(&call.function.arguments)
                        .unwrap_or_else(|_| json_or_string(&call.function.arguments));
                    blocks.push(ContentBlock::ToolUse {
                        id: call.id,
                        name: call.function.name,
                        input,
                        cache_control: None,
                    });
                }
                message.content = MessageContent::Blocks(blocks);
            }
        }
    }

    /// Anthropic server tools reject `input_schema` / `description`.
    pub fn strip_server_tool_extras(&mut self) {
        for tool in &mut self.tools {
            if is_anthropic_server_tool(tool) {
                tool.input_schema = Value::Null;
                tool.description.clear();
                for key in [
                    "input_schema",
                    "description",
                    "parameters",
                    "function",
                    "strict",
                ] {
                    tool.extra.remove(key);
                }
            } else if tool.input_schema.is_null() {
                tool.input_schema = default_schema();
            }
        }
    }
}

fn json_or_string(raw: &str) -> Value {
    Value::String(raw.to_string())
}

fn ephemeral_cache_control() -> Value {
    serde_json::json!({"type": "ephemeral"})
}

fn drop_text_cache_control(block: &mut ContentBlock) {
    if let Some(cc) = block_cache_slot(block) {
        *cc = None;
    }
}

fn block_cache_slot(block: &mut ContentBlock) -> Option<&mut Option<Value>> {
    match block {
        ContentBlock::Text { cache_control, .. }
        | ContentBlock::ToolUse { cache_control, .. }
        | ContentBlock::ToolResult { cache_control, .. }
        | ContentBlock::ServerToolUse { cache_control, .. }
        | ContentBlock::WebSearchToolResult { cache_control, .. } => Some(cache_control),
        _ => None,
    }
}

fn is_thinking_block(block: &ContentBlock) -> bool {
    matches!(
        block,
        ContentBlock::Thinking { .. } | ContentBlock::RedactedThinking { .. }
    )
}

fn stamp_message_tail(content: &mut MessageContent) {
    match content {
        MessageContent::Text(text) => {
            *content = MessageContent::Blocks(vec![ContentBlock::Text {
                text: std::mem::take(text),
                cache_control: Some(ephemeral_cache_control()),
            }]);
        }
        MessageContent::Blocks(blocks) if !blocks.is_empty() => {
            for block in blocks.iter_mut() {
                drop_text_cache_control(block);
            }
            for block in blocks.iter_mut().rev() {
                if is_thinking_block(block) {
                    continue;
                }
                if let Some(cc) = block_cache_slot(block) {
                    *cc = Some(ephemeral_cache_control());
                    break;
                }
            }
        }
        _ => {}
    }
}

fn leftover_user_index(messages: &[Message]) -> Option<usize> {
    let users: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter(|(_, m)| m.role == "user")
        .map(|(i, _)| i)
        .collect();
    if users.len() < 2 {
        return None;
    }
    Some(users[users.len() - 2])
}

/// Wrap `wireMessages` skips Claude Code addCacheBreakpoints. Stamp last
/// non-thinking block plus the previous user so Anthropic prefixes overlap.
pub fn stamp_cli_hop_message_breakpoints(request: &mut MessageRequest) {
    if request.messages.is_empty() {
        return;
    }
    for message in &mut request.messages {
        if let MessageContent::Blocks(blocks) = &mut message.content {
            for block in blocks.iter_mut() {
                drop_text_cache_control(block);
            }
        }
    }
    let last = request.messages.len() - 1;
    stamp_message_tail(&mut request.messages[last].content);
    if let Some(prev) = leftover_user_index(&request.messages) {
        if prev != last {
            stamp_message_tail(&mut request.messages[prev].content);
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum SystemPrompt {
    Text(String),
    Blocks(Vec<Value>),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Message {
    pub role: String,
    #[serde(default, deserialize_with = "deserialize_content")]
    pub content: MessageContent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ChatToolCall>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Blocks(Vec<ContentBlock>),
}

impl Default for MessageContent {
    fn default() -> Self {
        Self::Text(String::new())
    }
}

fn deserialize_content<'de, D>(deserializer: D) -> Result<MessageContent, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    match value {
        None | Some(Value::Null) => Ok(MessageContent::Text(String::new())),
        Some(Value::String(text)) => Ok(MessageContent::Text(text)),
        Some(Value::Array(items)) => {
            let blocks = items
                .into_iter()
                .filter_map(|item| serde_json::from_value(item).ok())
                .collect();
            Ok(MessageContent::Blocks(blocks))
        }
        Some(other) => Ok(MessageContent::Text(other.to_string())),
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cache_control: Option<Value>,
    },
    Image {
        source: Value,
    },
    Document {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
    ToolUse {
        id: String,
        name: String,
        #[serde(default)]
        input: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cache_control: Option<Value>,
    },
    ToolResult {
        tool_use_id: String,
        #[serde(default)]
        content: Value,
        #[serde(default)]
        is_error: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cache_control: Option<Value>,
    },
    Thinking {
        thinking: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
    RedactedThinking {
        #[serde(default)]
        data: Value,
    },
    ServerToolUse {
        id: String,
        name: String,
        #[serde(default)]
        input: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cache_control: Option<Value>,
    },
    WebSearchToolResult {
        tool_use_id: String,
        #[serde(default)]
        content: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cache_control: Option<Value>,
    },
}

#[derive(Clone, Debug, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub tool_type: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(default = "default_schema")]
    pub input_schema: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_control: Option<Value>,
    #[serde(default, flatten)]
    pub extra: Map<String, Value>,
}

impl Serialize for ToolDefinition {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("name", &self.name)?;
        if let Some(tool_type) = &self.tool_type {
            map.serialize_entry("type", tool_type)?;
        }
        if !self.description.is_empty() {
            map.serialize_entry("description", &self.description)?;
        }
        if !is_server_tool_type(self.tool_type.as_deref()) {
            map.serialize_entry("input_schema", &self.input_schema)?;
        }
        if let Some(cache_control) = &self.cache_control {
            map.serialize_entry("cache_control", cache_control)?;
        }
        for (key, value) in &self.extra {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

fn is_server_tool_type(tool_type: Option<&str>) -> bool {
    matches!(
        tool_type,
        Some(value)
            if value.starts_with("web_search_")
                || value.starts_with("web_fetch_")
                || value.starts_with("computer_")
                || value.starts_with("bash_")
                || value.starts_with("text_editor_")
                || value.starts_with("code_execution_")
                || value.starts_with("tool_search_")
    )
}

fn is_anthropic_server_tool(tool: &ToolDefinition) -> bool {
    let ty = tool.tool_type.as_deref().unwrap_or("");
    if ty.starts_with("web_search") || ty == "google_search" {
        return true;
    }
    if ty.is_empty() || ty == "function" || ty == "custom" {
        return matches!(
            tool.name.as_str(),
            "web_search" | "web_search_20250305" | "WebSearch" | "google_search"
        );
    }
    true
}

fn default_schema() -> Value {
    serde_json::json!({"type": "object", "properties": {}})
}

#[derive(Clone, Debug, Serialize)]
pub struct MessageResponse {
    pub id: String,
    pub r#type: &'static str,
    pub role: &'static str,
    pub model: String,
    pub content: Vec<ContentBlock>,
    pub stop_reason: StopReason,
    pub usage: Usage,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    ToolUse,
    MaxTokens,
    StopSequence,
    PauseTurn,
    Refusal,
    ModelContextWindowExceeded,
    Unknown,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub cache_read_input_tokens: u64,
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub cache_creation_input_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_creation: Option<CacheCreation>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct CacheCreation {
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub ephemeral_5m_input_tokens: u64,
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub ephemeral_1h_input_tokens: u64,
}

fn is_zero_u64(value: &u64) -> bool {
    *value == 0
}

#[derive(Clone, Debug, Deserialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub tools: Vec<ChatTool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<Value>,
    #[serde(default = "default_chat_max_tokens")]
    pub max_tokens: u32,
    #[serde(default)]
    pub stream: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ChatTool {
    #[allow(dead_code)]
    pub r#type: String,
    pub function: ChatFunction,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ChatFunction {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub parameters: Value,
}

#[derive(Clone, Debug, Serialize)]
pub struct ChatResponse {
    pub id: String,
    pub object: &'static str,
    pub model: String,
    pub choices: Vec<ChatChoice>,
    pub usage: ChatUsage,
}

#[derive(Clone, Debug, Serialize)]
pub struct ChatChoice {
    pub index: u32,
    pub message: ChatAssistantMessage,
    pub finish_reason: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ChatAssistantMessage {
    pub role: &'static str,
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ChatToolCall>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ChatToolCall {
    pub id: String,
    #[serde(default = "function_type")]
    pub r#type: String,
    pub function: ChatToolCallFunction,
}

fn function_type() -> String {
    "function".into()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ChatToolCallFunction {
    pub name: String,
    pub arguments: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ChatUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

fn default_chat_max_tokens() -> u32 {
    1024
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl From<ChatRequest> for MessageRequest {
    fn from(value: ChatRequest) -> Self {
        let tools = value
            .tools
            .into_iter()
            .map(|tool| ToolDefinition {
                name: tool.function.name,
                description: tool.function.description,
                input_schema: tool.function.parameters,
                cache_control: None,
                tool_type: None,
                extra: Map::new(),
            })
            .collect();

        let mut request = Self {
            model: value.model,
            messages: value.messages,
            tools,
            tool_choice: value.tool_choice,
            max_tokens: value.max_tokens,
            stream: value.stream,
            temperature: value.temperature,
            ..Self::default()
        };
        request.normalize_openai_tools();
        request
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_messages_body_roundtrip() {
        let raw = serde_json::json!({
            "model": "claude-sonnet-5",
            "max_tokens": 256,
            "stream": true,
            "temperature": 0.2,
            "top_p": 0.9,
            "top_k": 20,
            "stop_sequences": ["END"],
            "system": [
                {"type": "text", "text": "You are helpful.", "cache_control": {"type": "ephemeral"}}
            ],
            "thinking": {"type": "enabled", "budget_tokens": 2048},
            "tool_choice": {"type": "auto"},
            "metadata": {"user_id": "u1"},
            "service_tier": "auto",
            "tools": [{
                "name": "get_weather",
                "description": "weather",
                "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}}
            }],
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": "what is this?"},
                    {"type": "image", "source": {"type": "url", "url": "https://example.com/a.png"}}
                ]
            }]
        });
        let parsed: MessageRequest = serde_json::from_value(raw).unwrap();
        assert_eq!(parsed.model, "claude-sonnet-5");
        assert!(parsed.stream);
        assert_eq!(parsed.tools[0].name, "get_weather");
        assert!(parsed.system.is_some());
        assert!(parsed.thinking.is_some());
        assert_eq!(parsed.extra.get("service_tier").unwrap(), "auto");
        match &parsed.messages[0].content {
            MessageContent::Blocks(blocks) => {
                assert!(matches!(blocks[0], ContentBlock::Text { .. }));
                assert!(matches!(blocks[1], ContentBlock::Image { .. }));
            }
            _ => panic!("blocks"),
        }
    }

    #[test]
    fn server_tool_omits_default_input_schema() {
        let request: MessageRequest = serde_json::from_value(serde_json::json!({
            "model": "claude-sonnet-5",
            "max_tokens": 1024,
            "tools": [{"type": "web_search_20250305", "name": "web_search"}],
            "messages": [{"role": "user", "content": "search"}]
        }))
        .unwrap();

        let serialized = serde_json::to_value(request).unwrap();
        let tool = &serialized["tools"][0];
        assert_eq!(tool["type"], "web_search_20250305");
        assert_eq!(tool["name"], "web_search");
        assert!(tool.get("input_schema").is_none());
    }

    #[test]
    fn openai_tool_role_normalizes() {
        let raw = serde_json::json!({
            "model": "claude-sonnet-5",
            "messages": [
                {"role": "assistant", "content": null, "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "echo", "arguments": "{\"ok\":true}"}
                }]},
                {"role": "tool", "tool_call_id": "call_1", "content": "pong"}
            ]
        });
        let chat: ChatRequest = serde_json::from_value(raw).unwrap();
        let req = MessageRequest::from(chat);
        match &req.messages[1].content {
            MessageContent::Blocks(blocks) => match &blocks[0] {
                ContentBlock::ToolResult { tool_use_id, .. } => {
                    assert_eq!(tool_use_id, "call_1")
                }
                _ => panic!("tool_result"),
            },
            _ => panic!("blocks"),
        }
    }
}
