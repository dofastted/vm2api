use crate::auth::require_internal_token;
use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::stream::Stream;
use scheduler_core::SchedulerEngine;
use scheduler_proto::{
    AcquireRequest, AcquireResponse, BootstrapRequest, BootstrapResponse, CommitRequest,
    CommitResponse, ConfigSyncRequest, ConfigSyncResponse, DrainRequest, DrainResponse,
    ExplainResponse, HealthResponse, HeartbeatRequest, HeartbeatResponse, ReleaseRequest,
    ReleaseResponse, ScheduleError, SchedulerEvent, StickyDeleteResponse, StickyListResponse,
    StickyQuery, SwitchRequest, TelemetryBatchRequest, TelemetryBatchResponse, UnrestRequest,
    UnrestResponse,
};
use serde::Deserialize;
use std::convert::Infallible;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::sync::broadcast;

#[derive(Clone)]
pub struct AppState {
    pub engine: Arc<SchedulerEngine>,
}

pub struct ApiError(pub ScheduleError);

impl From<ScheduleError> for ApiError {
    fn from(value: ScheduleError) -> Self {
        Self(value)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.0.http_status_code())
            .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let retry_after = self.0.retry_after_sec();
        let mut resp = (status, Json(self.0.to_envelope())).into_response();
        if let Some(sec) = retry_after {
            if let Ok(val) = HeaderValue::from_str(&sec.to_string()) {
                resp.headers_mut().insert(header::RETRY_AFTER, val);
            }
        }
        resp
    }
}

pub fn build_router(engine: Arc<SchedulerEngine>, internal_token: Arc<String>) -> Router {
    let state = AppState { engine };

    Router::new()
        .route("/internal/v1/health", get(handle_health))
        .route("/internal/v1/bootstrap", post(handle_bootstrap))
        .route("/internal/v1/config/sync", post(handle_config_sync))
        .route("/internal/v1/nodes/telemetry", post(handle_telemetry))
        .route("/internal/v1/schedule/acquire", post(handle_acquire))
        .route("/internal/v1/schedule/switch", post(handle_switch))
        .route("/internal/v1/schedule/heartbeat", post(handle_heartbeat))
        .route("/internal/v1/schedule/commit", post(handle_commit))
        .route("/internal/v1/schedule/release", post(handle_release))
        .route("/internal/v1/schedule/explain", post(handle_explain))
        .route("/internal/v1/persistence/drain", post(handle_drain))
        .route(
            "/internal/v1/sticky",
            get(handle_get_sticky).delete(handle_delete_sticky),
        )
        .route("/internal/v1/admin/unrest", post(handle_unrest))
        .route("/internal/v1/events", get(handle_events))
        .layer(middleware::from_fn_with_state(
            internal_token,
            require_internal_token,
        ))
        .with_state(state)
}

async fn handle_health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(state.engine.health())
}

async fn handle_bootstrap(
    State(state): State<AppState>,
    Json(req): Json<BootstrapRequest>,
) -> Json<BootstrapResponse> {
    Json(state.engine.bootstrap(req))
}

async fn handle_config_sync(
    State(state): State<AppState>,
    Json(req): Json<ConfigSyncRequest>,
) -> Json<ConfigSyncResponse> {
    Json(state.engine.sync_config(req))
}

async fn handle_telemetry(
    State(state): State<AppState>,
    Json(req): Json<TelemetryBatchRequest>,
) -> Json<TelemetryBatchResponse> {
    Json(state.engine.update_telemetry(req))
}

async fn handle_acquire(
    State(state): State<AppState>,
    Json(req): Json<AcquireRequest>,
) -> Result<Json<AcquireResponse>, ApiError> {
    state.engine.acquire(req).await.map(Json).map_err(ApiError)
}

async fn handle_switch(
    State(state): State<AppState>,
    Json(req): Json<SwitchRequest>,
) -> Result<Json<AcquireResponse>, ApiError> {
    state.engine.switch(req).await.map(Json).map_err(ApiError)
}

async fn handle_heartbeat(
    State(state): State<AppState>,
    Json(req): Json<HeartbeatRequest>,
) -> Json<HeartbeatResponse> {
    Json(state.engine.heartbeat(req))
}

async fn handle_commit(
    State(state): State<AppState>,
    Json(req): Json<CommitRequest>,
) -> Json<CommitResponse> {
    Json(state.engine.commit(req))
}

async fn handle_release(
    State(state): State<AppState>,
    Json(req): Json<ReleaseRequest>,
) -> Json<ReleaseResponse> {
    Json(state.engine.release(req))
}

async fn handle_explain(
    State(state): State<AppState>,
    Json(req): Json<AcquireRequest>,
) -> Result<Json<ExplainResponse>, ApiError> {
    state.engine.explain(req).await.map(Json).map_err(ApiError)
}

async fn handle_drain(
    State(state): State<AppState>,
    body: Bytes,
) -> Result<Json<DrainResponse>, ApiError> {
    let req: DrainRequest = if body.is_empty() {
        DrainRequest::default()
    } else {
        serde_json::from_slice(&body)
            .map_err(|e| ApiError(ScheduleError::BadRequest(format!("invalid json: {e}"))))?
    };
    state
        .engine
        .drain_persistence(req)
        .map(Json)
        .map_err(ApiError)
}

async fn handle_get_sticky(
    State(state): State<AppState>,
    Query(query): Query<StickyQuery>,
) -> Json<StickyListResponse> {
    Json(state.engine.query_sticky(&query))
}

async fn handle_delete_sticky(
    State(state): State<AppState>,
    Query(mut query): Query<StickyQuery>,
    body: Bytes,
) -> Result<Json<StickyDeleteResponse>, ApiError> {
    if !body.is_empty() {
        let body_q: StickyQuery = serde_json::from_slice(&body)
            .map_err(|e| ApiError(ScheduleError::BadRequest(format!("invalid json: {e}"))))?;
        if body_q.pool_id.is_some() {
            query.pool_id = body_q.pool_id;
        }
        if body_q.scope_kind.is_some() {
            query.scope_kind = body_q.scope_kind;
        }
        if body_q.model_family.is_some() {
            query.model_family = body_q.model_family;
        }
        if body_q.machine_id.is_some() {
            query.machine_id = body_q.machine_id;
        }
        if body_q.session_id.is_some() {
            query.session_id = body_q.session_id;
        }
        if body_q.node_key.is_some() {
            query.node_key = body_q.node_key;
        }
    }
    Ok(Json(state.engine.delete_sticky(&query)))
}

async fn handle_unrest(
    State(state): State<AppState>,
    Json(req): Json<UnrestRequest>,
) -> Json<UnrestResponse> {
    Json(state.engine.unrest(req))
}

#[derive(Deserialize, Default)]
struct EventsQuery {
    #[serde(default)]
    after: Option<String>,
}

async fn handle_events(
    State(state): State<AppState>,
    Query(q): Query<EventsQuery>,
) -> Result<Response, ApiError> {
    let (replay, rx) = state.engine.subscribe_events(q.after.as_deref())?;
    let last_replayed_seq = replay.last().map(|e| e.seq).unwrap_or(0);
    let stream = EventSseStream::new(replay, rx, last_replayed_seq);
    Ok(Sse::new(stream)
        .keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(15))
                .text("keep-alive"),
        )
        .into_response())
}

type RecvEventFut = Pin<
    Box<
        dyn std::future::Future<
                Output = (
                    broadcast::Receiver<SchedulerEvent>,
                    Result<SchedulerEvent, broadcast::error::RecvError>,
                ),
            > + Send,
    >,
>;

struct EventSseStream {
    replay: std::vec::IntoIter<SchedulerEvent>,
    rx: broadcast::Receiver<SchedulerEvent>,
    last_seq: u64,
    pending_fut: Option<RecvEventFut>,
}

impl EventSseStream {
    fn new(
        replay: Vec<SchedulerEvent>,
        rx: broadcast::Receiver<SchedulerEvent>,
        last_seq: u64,
    ) -> Self {
        Self {
            replay: replay.into_iter(),
            rx,
            last_seq,
            pending_fut: None,
        }
    }

    fn format_event(ev: &SchedulerEvent) -> Event {
        let kind_name = serde_json::to_value(ev.kind)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_else(|| "event".to_owned());
        let data = serde_json::to_string(ev).unwrap_or_else(|_| "{}".to_owned());
        Event::default()
            .id(ev.cursor.clone())
            .event(kind_name)
            .data(data)
    }
}

// SAFETY: all fields are Unpin except nothing (pending_fut is Pin<Box<_>> which is Unpin).
impl Unpin for EventSseStream {}

impl Stream for EventSseStream {
    type Item = Result<Event, Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if let Some(ev) = self.replay.next() {
            self.last_seq = self.last_seq.max(ev.seq);
            return Poll::Ready(Some(Ok(Self::format_event(&ev))));
        }

        loop {
            if self.pending_fut.is_none() {
                // Swap out a dummy receiver to move `rx` into the receive future cleanly.
                let (_, dummy) = broadcast::channel(1);
                let mut rx = std::mem::replace(&mut self.rx, dummy);
                self.pending_fut = Some(Box::pin(async move {
                    let res = rx.recv().await;
                    (rx, res)
                }));
            }

            let fut = self.pending_fut.as_mut().expect("future initialized");
            match fut.as_mut().poll(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready((rx, res)) => {
                    self.rx = rx;
                    self.pending_fut = None;
                    match res {
                        Ok(ev) => {
                            if ev.seq <= self.last_seq {
                                continue;
                            }
                            self.last_seq = ev.seq;
                            return Poll::Ready(Some(Ok(Self::format_event(&ev))));
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            let ev = Event::default().event("snapshot_required").data(
                                r#"{"code":"snapshot_required","message":"event stream lagged"}"#,
                            );
                            return Poll::Ready(Some(Ok(ev)));
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            return Poll::Ready(None);
                        }
                    }
                }
            }
        }
    }
}
