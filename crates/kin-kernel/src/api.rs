use std::{
    convert::Infallible,
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header::CONTENT_TYPE},
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
    routing::{get, post},
};
use futures_util::Stream;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tower_http::{
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    trace::TraceLayer,
};
use uuid::Uuid;

use crate::{
    error::KernelError,
    model::{
        ChatAssistantMessage, ChatChoice, ChatResponse, ChatToolCall, ChatToolCallFunction,
        ChatUsage, ContentBlock, MessageContent, MessageRequest, MessageResponse, StopReason,
    },
    provider::{self, ExecutionContext},
    scheduler::WorkerLease,
    state::{AppState, ProviderBootStatus},
    stream::{StreamItem, openai_chunk},
};

/// Execution mode as reported by `/healthz` and `/readyz`, and the only mode
/// the kernel implements. It stays in the payload (and in the Go control
/// plane's `RuntimeProfile`, hence in `config_hash`) because the three-way
/// check compares this exact string across kernel, console, and CLI.
const EXECUTION_MODE: &str = "native_messages";

/// One Claude CLI process hosting N stateless slots; the per-turn-process and
/// session-reset isolations were deleted with the local_cli provider.
const ISOLATION: &str = "subagent-pool";

pub fn router(state: AppState) -> Router {
    let max_body_bytes = state.config.max_body_bytes;
    let request_id = HeaderName::from_static("x-request-id");
    Router::new()
        .route("/healthz", get(health))
        .route("/readyz", get(ready))
        .route("/status", get(health))
        .route("/v1/messages", post(messages))
        .route("/v1/chat/completions", post(chat_completions))
        .route("/internal/v1/slots", get(slots))
        .route("/internal/v1/envelope", get(envelope_get).put(envelope_put))
        .layer(DefaultBodyLimit::max(max_body_bytes))
        .layer(PropagateRequestIdLayer::new(request_id.clone()))
        .layer(SetRequestIdLayer::new(request_id, MakeRequestUuid))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    let capabilities = state.provider.capabilities();
    Json(json!({
        "status": "ok",
        "provider": state.provider.name(),
        "isolation": ISOLATION,
        "workers": state.config.worker_count,
        "slots_per_worker": state.config.slots_per_worker,
        "memory": state.provider.memory_snapshot(),
        "execution_mode": EXECUTION_MODE,
        "config_hash": state.config.desired_config_hash,
        "envelope": crate::provider::multiplex_cli::envelope::load(),
        "limits": {
            "max_body_bytes": state.config.max_body_bytes,
            "max_tool_result_bytes": state.config.max_tool_result_bytes,
            "slot_max_jobs": state.config.slot_max_jobs,
            "slot_max_lifetime_secs": state.config.slot_max_lifetime.as_secs(),
            "client_channel": crate::config::CLIENT_CHANNEL_SIZE,
            "event_channel": crate::config::EVENT_CHANNEL_SIZE,
            "per_connection_buffer": crate::config::PER_CONNECTION_BUFFER
        },
        "capabilities": {
            "streaming": capabilities.streaming,
            "resume": capabilities.resume,
            "multiplex_slots": capabilities.multiplex_slots,
            "native_tool_wait": capabilities.native_tool_wait,
            "cancel_receipt": capabilities.cancel_receipt
        }
    }))
}

async fn ready(State(state): State<AppState>) -> Response {
    match state.provider_boot_status() {
        ProviderBootStatus::Booting => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"status": "not_ready", "reason": "booting"})),
            )
                .into_response();
        }
        ProviderBootStatus::Failed => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"status": "not_ready", "reason": "boot_failed"})),
            )
                .into_response();
        }
        ProviderBootStatus::Ready => {}
    }
    if !state.scheduler.ready() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"status": "not_ready", "reason": "no_capacity"})),
        )
            .into_response();
    }
    if state.provider.config_hash_mismatch() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"status": "not_ready", "reason": "config_hash_mismatch"})),
        )
            .into_response();
    }
    (StatusCode::OK, Json(json!({"status": "ready"}))).into_response()
}

async fn slots(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({"workers": state.scheduler.snapshots()}))
}

async fn envelope_get() -> Json<serde_json::Value> {
    let cfg = crate::provider::multiplex_cli::envelope::load();
    Json(json!({
        "mode": cfg.mode,
        "timezone": cfg.timezone,
        "path": crate::provider::multiplex_cli::envelope::config_path(),
        "identity": crate::provider::multiplex_cli::envelope::IDENTITY,
        "execution_mode": EXECUTION_MODE,
        "notes": {
            "zero": "official sentence lives in billing prompt_version; no identity block",
            "identity": "official sentence is a standalone system block",
            "timezone": "must match SOCKS egress (default America/New_York)"
        }
    }))
}

#[derive(serde::Deserialize)]
struct EnvelopePatch {
    mode: Option<String>,
    timezone: Option<String>,
}

async fn envelope_put(Json(patch): Json<EnvelopePatch>) -> Response {
    let mut cfg = crate::provider::multiplex_cli::envelope::load();
    if let Some(mode) = patch.mode {
        cfg.mode = crate::provider::multiplex_cli::envelope::SystemMode::parse(&mode);
    }
    if let Some(tz) = patch.timezone {
        let tz = tz.trim().to_string();
        if !tz.is_empty() {
            cfg.timezone = tz;
        }
    }
    match crate::provider::multiplex_cli::envelope::save(&cfg) {
        Ok(saved) => (StatusCode::OK, Json(json!(saved))).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": err})),
        )
            .into_response(),
    }
}

#[derive(Clone, Copy)]
enum ClientFormat {
    Anthropic,
    OpenAi,
}

async fn messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<MessageRequest>,
) -> Result<Response, KernelError> {
    dispatch(state, headers, request, ClientFormat::Anthropic).await
}

async fn chat_completions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<crate::model::ChatRequest>,
) -> Result<Response, KernelError> {
    dispatch(state, headers, request.into(), ClientFormat::OpenAi).await
}

async fn dispatch(
    state: AppState,
    headers: HeaderMap,
    request: MessageRequest,
    format: ClientFormat,
) -> Result<Response, KernelError> {
    let client_stream = request.stream;
    let turn = ActiveTurn::begin(&state, &headers, request).await?;
    let rx = state
        .provider
        .execute_stream(&turn.request, &turn.context)
        .await?;
    if client_stream {
        return Ok(turn.into_sse(state.clone(), rx, format));
    }
    let response = provider::collect_stream(rx).await?;
    let result = turn.complete(&state, response)?;
    match format {
        ClientFormat::Anthropic => Ok(message_response(&state, result)),
        ClientFormat::OpenAi => {
            let body = to_chat_response(result.response.clone());
            Ok(json_response(&state, body, &result))
        }
    }
}

struct ExecutionResult {
    response: MessageResponse,
    session_id: String,
    continuation: Option<String>,
    worker_id: String,
    pid: Option<u32>,
    generation: u64,
    native_slot: Option<String>,
}

struct ActiveTurn {
    lease: WorkerLease,
    tenant_id: String,
    session_id: String,
    worker_id: String,
    worker_index: usize,
    worker_generation: u64,
    request: MessageRequest,
    context: ExecutionContext,
}

impl ActiveTurn {
    async fn begin(
        state: &AppState,
        headers: &HeaderMap,
        mut request: MessageRequest,
    ) -> Result<Self, KernelError> {
        request.strip_server_tool_extras();
        validate_request(&request)?;
        let tenant_id = header_or_default(headers, "x-tenant-id", &state.config.default_tenant)?;
        let session_id = header_or_generated(headers, "x-kin-session-id")?;
        let continuation = optional_header(headers, "x-kin-continuation")?;
        request.betas = parse_betas(headers);
        if let Some(version) = optional_header(headers, "anthropic-version")? {
            request
                .extra
                .entry("anthropic_version".to_string())
                .or_insert(Value::String(version));
        }
        request.normalize_openai_tools();

        let (lease, resumed) = if let Some(token) = continuation.as_deref() {
            let tool_use_ids = tool_result_ids(&request);
            if tool_use_ids.is_empty() {
                return Err(KernelError::InvalidRequest(
                    "x-kin-continuation requires at least one tool_result block".to_string(),
                ));
            }
            let binding = state
                .sessions
                .resume(&tenant_id, &session_id, token, &tool_use_ids)?;
            if let Some(mut pending) = binding.pending_request {
                pending.messages.append(&mut request.messages);
                pending.max_tokens = request.max_tokens;
                request = pending;
            }
            let lease = if binding.reserved_worker {
                state
                    .scheduler
                    .resume(binding.worker_index, binding.worker_generation)?
            } else {
                state.scheduler.acquire(Some(binding.worker_index))?
            };
            (lease, true)
        } else {
            let preferred = state.sessions.sticky_worker(&tenant_id, &session_id);
            (state.scheduler.acquire(preferred)?, false)
        };

        let worker_index = lease.index();
        let worker_id = lease.id().to_string();
        let worker_generation = lease.generation();
        let context = ExecutionContext {
            tenant_id: tenant_id.clone(),
            session_id: session_id.clone(),
            worker_id: worker_id.clone(),
            worker_generation,
            resumed,
        };
        Ok(Self {
            lease,
            tenant_id,
            session_id,
            worker_id,
            worker_index,
            worker_generation,
            request,
            context,
        })
    }

    fn complete(
        self,
        state: &AppState,
        response: MessageResponse,
    ) -> Result<ExecutionResult, KernelError> {
        let pid = state.provider.session_pid(&self.session_id);
        let continuation = match &response.stop_reason {
            StopReason::ToolUse => {
                let tool_use_ids: Vec<String> = response
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::ToolUse { id, .. } => Some(id.clone()),
                        _ => None,
                    })
                    .collect();
                if tool_use_ids.is_empty() {
                    return Err(KernelError::Internal);
                }
                let token = state.sessions.mark_waiting(
                    &self.tenant_id,
                    &self.session_id,
                    self.worker_index,
                    self.worker_generation,
                    tool_use_ids,
                    pending_request(&self.request, &response),
                    state.provider.capabilities().native_tool_wait,
                )?;
                if state.provider.capabilities().native_tool_wait {
                    self.lease.park_waiting();
                }
                Some(token)
            }
            _ => {
                state.sessions.mark_ready(
                    &self.tenant_id,
                    &self.session_id,
                    self.worker_index,
                    self.worker_generation,
                );
                None
            }
        };

        Ok(ExecutionResult {
            response,
            session_id: self.session_id.clone(),
            continuation,
            worker_id: self.worker_id,
            pid,
            generation: self.worker_generation,
            native_slot: state.provider.session_slot(&self.session_id),
        })
    }

    fn into_sse(
        self,
        state: AppState,
        mut rx: crate::provider::StreamRx,
        format: ClientFormat,
    ) -> Response {
        let session_id = self.session_id.clone();
        let worker_id = self.worker_id.clone();
        let generation = self.worker_generation;
        let expose_slot = state.config.expose_slot_header;
        let (out_tx, out_rx) =
            mpsc::channel::<Result<Event, Infallible>>(crate::config::EVENT_CHANNEL_SIZE);
        tokio::spawn(async move {
            let mut finished = None;
            let mut model = self.request.model.clone();
            let mut message_id = format!("msg_{}", Uuid::new_v4().simple());
            let mut role_sent = false;
            let mut ping = tokio::time::interval(Duration::from_secs(12));
            ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            ping.tick().await;
            loop {
                let item = tokio::select! {
                    item = rx.recv() => item,
                    _ = ping.tick() => {
                        let ping_ev = Event::default().event("ping").data("{\"type\":\"ping\"}");
                        if out_tx.send(Ok(ping_ev)).await.is_err() {
                            return;
                        }
                        continue;
                    }
                };
                let Some(item) = item else {
                    break;
                };
                match item {
                    Ok(StreamItem::Event(event)) => {
                        if let Some(id) = event.pointer("/message/id").and_then(Value::as_str) {
                            message_id = id.to_string();
                        }
                        if let Some(name) = event.pointer("/message/model").and_then(Value::as_str)
                        {
                            model = name.to_string();
                        }
                        let encoded = match format {
                            ClientFormat::Anthropic => Some(anthropic_event(&event)),
                            ClientFormat::OpenAi => {
                                openai_event(&message_id, &model, &event, &mut role_sent)
                            }
                        };
                        if let Some(encoded) = encoded
                            && out_tx.send(Ok(encoded)).await.is_err()
                        {
                            continue;
                        }
                    }
                    Ok(StreamItem::Finished(response)) => finished = Some(response),
                    Err(err) => {
                        let _ = out_tx.send(Ok(error_event(&err))).await;
                        return;
                    }
                }
            }
            let Some(response) = finished else {
                let _ = out_tx
                    .send(Ok(error_event(&KernelError::Provider(
                        "stream ended without a result".into(),
                    ))))
                    .await;
                return;
            };
            match self.complete(&state, response) {
                Ok(result) => {
                    let meta = json!({
                        "session_id": result.session_id,
                        "continuation": result.continuation,
                        "pid": result.pid,
                        "generation": result.generation,
                        "slot": result.worker_id
                    });
                    let _ = out_tx
                        .send(Ok(Event::default()
                            .event("kin.done")
                            .data(meta.to_string())))
                        .await;
                    if matches!(format, ClientFormat::OpenAi) {
                        let _ = out_tx.send(Ok(Event::default().data("[DONE]"))).await;
                    }
                }
                Err(err) => {
                    let _ = out_tx.send(Ok(error_event(&err))).await;
                }
            }
        });
        let mut response = Sse::new(ReceiverStream { inner: out_rx })
            .keep_alive(KeepAlive::default())
            .into_response();
        insert_header(response.headers_mut(), "x-kin-session-id", &session_id);
        if expose_slot {
            insert_header(response.headers_mut(), "x-kin-slot", &worker_id);
        }
        insert_header(
            response.headers_mut(),
            "x-kin-generation",
            &generation.to_string(),
        );
        response
            .headers_mut()
            .insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
        insert_header(
            response.headers_mut(),
            "cache-control",
            "no-cache, no-transform",
        );
        insert_header(response.headers_mut(), "x-accel-buffering", "no");
        insert_header(response.headers_mut(), "connection", "keep-alive");
        response
    }
}

fn validate_request(request: &MessageRequest) -> Result<(), KernelError> {
    if request.model.is_empty() || request.model.len() > 128 {
        return Err(KernelError::InvalidRequest(
            "model must contain 1 to 128 characters".to_string(),
        ));
    }
    if request.messages.is_empty() {
        return Err(KernelError::InvalidRequest(
            "messages must not be empty".to_string(),
        ));
    }
    if request.messages.len() > 1024 {
        return Err(KernelError::InvalidRequest(
            "messages must contain at most 1024 entries".to_string(),
        ));
    }
    if request.tools.len() > 128 {
        return Err(KernelError::InvalidRequest(
            "tools must contain at most 128 entries".to_string(),
        ));
    }
    let mut tool_names = std::collections::HashSet::new();
    if request
        .tools
        .iter()
        .any(|tool| tool.name.is_empty() || !tool_names.insert(tool.name.as_str()))
    {
        return Err(KernelError::InvalidRequest(
            "tool names must be non-empty and unique".to_string(),
        ));
    }
    if request.max_tokens == 0 {
        return Err(KernelError::InvalidRequest(
            "max_tokens must be positive".to_string(),
        ));
    }
    let max_tool = crate::config::MAX_TOOL_RESULT_BYTES;
    let tool_bytes: usize = request
        .messages
        .iter()
        .map(|message| match &message.content {
            MessageContent::Text(_) => 0usize,
            MessageContent::Blocks(blocks) => blocks
                .iter()
                .map(|block| match block {
                    ContentBlock::ToolResult { content, .. } => content.to_string().len(),
                    _ => 0,
                })
                .sum(),
        })
        .sum();
    if tool_bytes > max_tool {
        return Err(KernelError::InvalidRequest(format!(
            "tool_result payload {tool_bytes} exceeds {max_tool} bytes"
        )));
    }
    Ok(())
}

fn tool_result_ids(request: &MessageRequest) -> Vec<String> {
    request
        .messages
        .iter()
        .flat_map(|message| match &message.content {
            MessageContent::Text(_) => Vec::new(),
            MessageContent::Blocks(blocks) => blocks
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::ToolResult { tool_use_id, .. } => Some(tool_use_id.clone()),
                    _ => None,
                })
                .collect(),
        })
        .collect()
}

fn pending_request(request: &MessageRequest, response: &MessageResponse) -> MessageRequest {
    let mut pending = request.clone();
    pending.messages.push(crate::model::Message {
        role: "assistant".to_string(),
        content: MessageContent::Blocks(response.content.clone()),
        tool_call_id: None,
        tool_calls: Vec::new(),
    });
    pending
}

fn message_response(state: &AppState, result: ExecutionResult) -> Response {
    let body = result.response.clone();
    json_response(state, body, &result)
}

fn json_response<T: Serialize>(state: &AppState, body: T, result: &ExecutionResult) -> Response {
    let mut response = (StatusCode::OK, Json(body)).into_response();
    insert_result_headers(response.headers_mut(), state, result);
    response
}

fn insert_result_headers(headers: &mut HeaderMap, state: &AppState, result: &ExecutionResult) {
    insert_header(headers, "x-kin-session-id", &result.session_id);
    if let Some(token) = &result.continuation {
        insert_header(headers, "x-kin-continuation", token);
    }
    if state.config.expose_slot_header {
        insert_header(headers, "x-kin-slot", &result.worker_id);
    }
    if let Some(pid) = result.pid {
        insert_header(headers, "x-kin-pid", &pid.to_string());
    }
    if let Some(slot_id) = &result.native_slot {
        insert_header(headers, "x-kin-native-slot", slot_id);
    }
    insert_header(headers, "x-kin-generation", &result.generation.to_string());
}

fn to_chat_response(response: MessageResponse) -> ChatResponse {
    let mut text = String::new();
    let mut tool_calls = Vec::new();
    for block in response.content {
        match block {
            ContentBlock::Text { text: value, .. } => text.push_str(&value),
            ContentBlock::ToolUse {
                id, name, input, ..
            } => tool_calls.push(ChatToolCall {
                id,
                r#type: "function".into(),
                function: ChatToolCallFunction {
                    name,
                    arguments: input.to_string(),
                },
            }),
            ContentBlock::Thinking { thinking, .. } => text.push_str(&thinking),
            _ => {}
        }
    }
    let finish_reason = match response.stop_reason {
        StopReason::EndTurn => "stop",
        StopReason::ToolUse => "tool_calls",
        StopReason::MaxTokens => "length",
        StopReason::StopSequence => "stop",
        StopReason::PauseTurn => "stop",
        StopReason::Refusal => "content_filter",
        StopReason::ModelContextWindowExceeded => "length",
        StopReason::Unknown => "stop",
    }
    .to_string();
    let usage = ChatUsage {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
    };

    ChatResponse {
        id: response.id,
        object: "chat.completion",
        model: response.model,
        choices: vec![ChatChoice {
            index: 0,
            message: ChatAssistantMessage {
                role: "assistant",
                content: (!text.is_empty()).then_some(text),
                tool_calls,
            },
            finish_reason,
        }],
        usage,
    }
}

fn header_or_default(
    headers: &HeaderMap,
    name: &str,
    default: &str,
) -> Result<String, KernelError> {
    Ok(optional_header(headers, name)?.unwrap_or_else(|| default.to_string()))
}

fn header_or_generated(headers: &HeaderMap, name: &str) -> Result<String, KernelError> {
    Ok(optional_header(headers, name)?.unwrap_or_else(|| Uuid::new_v4().to_string()))
}

fn parse_betas(headers: &HeaderMap) -> Vec<String> {
    headers
        .get("anthropic-beta")
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|part| !part.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn optional_header(headers: &HeaderMap, name: &str) -> Result<Option<String>, KernelError> {
    let Some(value) = headers.get(name) else {
        return Ok(None);
    };
    let value = value
        .to_str()
        .map_err(|_| KernelError::InvalidRequest(format!("{name} is not valid ASCII")))?;
    if value.is_empty() || value.len() > 4096 {
        return Err(KernelError::InvalidRequest(format!(
            "{name} must contain 1 to 4096 characters"
        )));
    }
    Ok(Some(value.to_string()))
}

fn insert_header(headers: &mut HeaderMap, name: &'static str, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        headers.insert(HeaderName::from_static(name), value);
    }
}

fn anthropic_event(event: &Value) -> Event {
    let name = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("message");
    Event::default().event(name).data(event.to_string())
}

fn openai_event(id: &str, model: &str, event: &Value, role_sent: &mut bool) -> Option<Event> {
    match event.get("type").and_then(Value::as_str) {
        Some("message_start") => {
            *role_sent = true;
            Some(
                Event::default()
                    .data(openai_chunk(id, model, json!({"role": "assistant"}), None).to_string()),
            )
        }
        Some("content_block_delta") => {
            let delta = event.get("delta")?;
            match delta.get("type").and_then(Value::as_str) {
                Some("text_delta") => {
                    let text = delta.get("text").and_then(Value::as_str).unwrap_or("");
                    Some(
                        Event::default().data(
                            openai_chunk(id, model, json!({"content": text}), None).to_string(),
                        ),
                    )
                }
                Some("thinking_delta") => {
                    let text = delta.get("thinking").and_then(Value::as_str).unwrap_or("");
                    Some(
                        Event::default().data(
                            openai_chunk(id, model, json!({"content": text}), None).to_string(),
                        ),
                    )
                }
                Some("input_json_delta") => None,
                _ => None,
            }
        }
        Some("message_delta") => {
            let reason = event
                .pointer("/delta/stop_reason")
                .and_then(Value::as_str)
                .map(|reason| match reason {
                    "tool_use" => "tool_calls",
                    "max_tokens" => "length",
                    _ => "stop",
                });
            Some(Event::default().data(openai_chunk(id, model, json!({}), reason).to_string()))
        }
        _ => None,
    }
}

fn error_event(err: &KernelError) -> Event {
    Event::default().event("error").data(
        json!({
            "type": "error",
            "error": { "type": "api_error", "message": err.to_string() }
        })
        .to_string(),
    )
}

struct ReceiverStream {
    inner: mpsc::Receiver<Result<Event, Infallible>>,
}

impl Stream for ReceiverStream {
    type Item = Result<Event, Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.inner.poll_recv(cx)
    }
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use axum::body::to_bytes;

    use super::*;
    use crate::{
        config::Config, provider::mock::MockProvider, scheduler::Scheduler,
        session::SessionDirectory,
    };

    fn test_config() -> Config {
        Config {
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            worker_count: 1,
            slots_per_worker: 1,
            max_body_bytes: 1024 * 1024,
            max_tool_result_bytes: crate::config::MAX_TOOL_RESULT_BYTES,
            max_session_bytes: 1024 * 1024,
            session_ttl: Duration::from_secs(60),
            continuation_ttl: Duration::from_secs(60),
            slot_max_jobs: 10,
            slot_max_lifetime: Duration::from_secs(60),
            default_tenant: "demo".into(),
            expose_slot_header: true,
            provider: "mock".into(),
            desired_config_hash: None,
        }
    }

    fn test_state() -> AppState {
        AppState::new(
            test_config(),
            Arc::new(Scheduler::new(1, 1)),
            Arc::new(SessionDirectory::new(
                Duration::from_secs(60),
                Duration::from_secs(60),
                1024 * 1024,
            )),
            Arc::new(MockProvider),
        )
    }

    async fn response_json(response: Response) -> serde_json::Value {
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    /// Wraps `MockProvider` but reports a config_hash mismatch, for
    /// simulating the AC14 `/readyz` 503 path without a real native CLI.
    #[derive(Default)]
    struct ConfigHashMismatchProvider(MockProvider);

    #[async_trait::async_trait]
    impl provider::Provider for ConfigHashMismatchProvider {
        fn name(&self) -> &'static str {
            self.0.name()
        }

        fn capabilities(&self) -> provider::ProviderCapabilities {
            self.0.capabilities()
        }

        async fn execute_stream(
            &self,
            request: &crate::model::MessageRequest,
            context: &ExecutionContext,
        ) -> Result<crate::provider::StreamRx, KernelError> {
            self.0.execute_stream(request, context).await
        }

        fn config_hash_mismatch(&self) -> bool {
            true
        }
    }

    #[tokio::test]
    async fn readyz_returns_503_on_config_hash_mismatch() {
        let state = AppState::new(
            test_config(),
            Arc::new(Scheduler::new(1, 1)),
            Arc::new(SessionDirectory::new(
                Duration::from_secs(60),
                Duration::from_secs(60),
                1024 * 1024,
            )),
            Arc::new(ConfigHashMismatchProvider::default()),
        );
        state.mark_provider_ready();

        let response = ready(State(state)).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            response_json(response).await["reason"],
            "config_hash_mismatch"
        );
    }

    #[tokio::test]
    async fn readyz_returns_503_until_provider_boot_ready_then_200() {
        let state = test_state();

        let response = ready(State(state.clone())).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response_json(response).await["reason"], "booting");

        state.mark_provider_ready();
        let response = ready(State(state)).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response_json(response).await["status"], "ready");
    }

    #[tokio::test]
    async fn readyz_returns_503_after_provider_boot_failed() {
        let state = test_state();
        state.mark_provider_failed();

        let response = ready(State(state.clone())).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response_json(response).await["reason"], "boot_failed");

        state.scheduler.mark_all_unhealthy();
        let response = ready(State(state)).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response_json(response).await["reason"], "boot_failed");
    }

    /// AC19 survives the collapse of `ExecutionMode`: the kernel still
    /// reports `native_messages`, which is also the value the Go control
    /// plane's `RuntimeProfile` hashes into `config_hash`. Drifting this
    /// string breaks the three-way check.
    #[tokio::test]
    async fn healthz_reports_the_only_execution_mode() {
        let state = test_state();
        state.mark_provider_ready();

        let body = response_json(health(State(state)).await.into_response()).await;
        assert_eq!(body["execution_mode"], "native_messages");
    }
}
