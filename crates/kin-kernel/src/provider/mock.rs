use async_trait::async_trait;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    error::KernelError,
    model::{ContentBlock, MessageContent, MessageRequest, MessageResponse, StopReason, Usage},
    provider::{ExecutionContext, Provider, ProviderCapabilities, StreamRx, stream_channel},
    stream::StreamItem,
};

#[derive(Default)]
pub struct MockProvider;

#[async_trait]
impl Provider for MockProvider {
    fn name(&self) -> &'static str {
        "mock"
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            streaming: true,
            resume: true,
            multiplex_slots: true,
            native_tool_wait: true,
            cancel_receipt: true,
        }
    }

    async fn execute_stream(
        &self,
        request: &MessageRequest,
        context: &ExecutionContext,
    ) -> Result<StreamRx, KernelError> {
        let response = mock_turn(request, context)?;
        let (tx, rx) = stream_channel();
        tokio::spawn(async move {
            for event in mock_events(&response) {
                if tx.send(Ok(StreamItem::Event(event))).await.is_err() {
                    return;
                }
            }
            let _ = tx.send(Ok(StreamItem::Finished(response))).await;
        });
        Ok(rx)
    }
}

fn mock_turn(
    request: &MessageRequest,
    context: &ExecutionContext,
) -> Result<MessageResponse, KernelError> {
    if let Some((tool_use_id, result)) = latest_tool_result(request) {
        let text = format!(
            "tool result accepted for {tool_use_id}: {}",
            display_json(&result)
        );
        return Ok(response(
            request,
            vec![ContentBlock::Text {
                text,
                cache_control: None,
            }],
            StopReason::EndTurn,
        ));
    }

    if let Some(tool_name) = requested_mock_tool(request) {
        if !request.tools.iter().any(|tool| tool.name == tool_name) {
            return Err(KernelError::InvalidRequest(format!(
                "mock tool {tool_name} was requested but is not declared"
            )));
        }

        return Ok(response(
            request,
            vec![ContentBlock::ToolUse {
                id: format!("toolu_{}", Uuid::new_v4().simple()),
                name: tool_name,
                input: json!({"location": "Shanghai"}),
                cache_control: None,
            }],
            StopReason::ToolUse,
        ));
    }

    let latest = latest_text(request).unwrap_or_else(|| "(empty message)".to_string());
    let text = format!(
        "mock response: {latest} [tenant={}, session={}, worker={}, generation={}, resumed={}]",
        context.tenant_id,
        context.session_id,
        context.worker_id,
        context.worker_generation,
        context.resumed
    );
    Ok(response(
        request,
        vec![ContentBlock::Text {
            text,
            cache_control: None,
        }],
        StopReason::EndTurn,
    ))
}

fn mock_events(response: &MessageResponse) -> Vec<Value> {
    let mut events = vec![json!({
        "type": "message_start",
        "message": {
            "id": response.id,
            "type": "message",
            "role": "assistant",
            "content": [],
            "model": response.model,
            "stop_reason": null,
            "usage": { "input_tokens": response.usage.input_tokens, "output_tokens": 0 }
        }
    })];
    for (index, block) in response.content.iter().enumerate() {
        match block {
            ContentBlock::Text { text, .. } => {
                events.push(json!({
                    "type": "content_block_start",
                    "index": index,
                    "content_block": { "type": "text", "text": "" }
                }));
                for chunk in text.as_bytes().chunks(24) {
                    let piece = String::from_utf8_lossy(chunk);
                    events.push(json!({
                        "type": "content_block_delta",
                        "index": index,
                        "delta": { "type": "text_delta", "text": piece }
                    }));
                }
                events.push(json!({ "type": "content_block_stop", "index": index }));
            }
            ContentBlock::ToolUse {
                id, name, input, ..
            } => {
                events.push(json!({
                    "type": "content_block_start",
                    "index": index,
                    "content_block": { "type": "tool_use", "id": id, "name": name, "input": {} }
                }));
                events.push(json!({
                    "type": "content_block_delta",
                    "index": index,
                    "delta": { "type": "input_json_delta", "partial_json": input.to_string() }
                }));
                events.push(json!({ "type": "content_block_stop", "index": index }));
            }
            _ => {}
        }
    }
    let stop = match response.stop_reason {
        StopReason::ToolUse => "tool_use",
        StopReason::MaxTokens => "max_tokens",
        _ => "end_turn",
    };
    events.push(json!({
        "type": "message_delta",
        "delta": { "stop_reason": stop, "stop_sequence": null },
        "usage": { "output_tokens": response.usage.output_tokens }
    }));
    events.push(json!({ "type": "message_stop" }));
    events
}

fn response(
    request: &MessageRequest,
    content: Vec<ContentBlock>,
    stop_reason: StopReason,
) -> MessageResponse {
    let input_chars = serde_json::to_string(&request.messages)
        .map(|value| value.chars().count())
        .unwrap_or_default();
    let output_chars = serde_json::to_string(&content)
        .map(|value| value.chars().count())
        .unwrap_or_default();

    MessageResponse {
        id: format!("msg_{}", Uuid::new_v4().simple()),
        r#type: "message",
        role: "assistant",
        model: request.model.clone(),
        content,
        stop_reason,
        usage: Usage {
            input_tokens: approximate_tokens(input_chars),
            output_tokens: approximate_tokens(output_chars),
            ..Usage::default()
        },
    }
}

fn approximate_tokens(chars: usize) -> u64 {
    chars.div_ceil(4) as u64
}

fn requested_mock_tool(request: &MessageRequest) -> Option<String> {
    let text = latest_text(request)?;
    let start = text.find("[use_tool:")? + "[use_tool:".len();
    let end = text[start..].find(']')? + start;
    let tool = text[start..end].trim();
    (!tool.is_empty()).then(|| tool.to_string())
}

fn latest_text(request: &MessageRequest) -> Option<String> {
    request
        .messages
        .iter()
        .rev()
        .find_map(|message| match &message.content {
            MessageContent::Text(text) => Some(text.clone()),
            MessageContent::Blocks(blocks) => blocks.iter().rev().find_map(|block| match block {
                ContentBlock::Text { text, .. } => Some(text.clone()),
                _ => None,
            }),
        })
}

fn latest_tool_result(request: &MessageRequest) -> Option<(String, Value)> {
    request
        .messages
        .iter()
        .rev()
        .find_map(|message| match &message.content {
            MessageContent::Text(_) => None,
            MessageContent::Blocks(blocks) => blocks.iter().rev().find_map(|block| match block {
                ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                    ..
                } => Some((tool_use_id.clone(), content.clone())),
                _ => None,
            }),
        })
}

fn display_json(value: &Value) -> String {
    value
        .as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| value.to_string())
}
