use axum::Json;
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use scheduler_proto::{ErrorBody, ErrorCode, ErrorEnvelope};
use std::sync::Arc;
use subtle::ConstantTimeEq;

pub const INTERNAL_TOKEN_HEADER: &str = "x-kin-internal-token";

/// Constant-time token comparison.
pub fn constant_time_token_eq(expected: &str, actual: &str) -> bool {
    let a = expected.as_bytes();
    let b = actual.as_bytes();
    if a.len() != b.len() {
        // Still perform a dummy constant-time compare to avoid early-return side channels.
        let _ = a.ct_eq(a);
        return false;
    }
    bool::from(a.ct_eq(b))
}

pub async fn require_internal_token(
    State(expected_token): State<Arc<String>>,
    req: Request,
    next: Next,
) -> Response {
    let provided = req
        .headers()
        .get(INTERNAL_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::trim);

    match provided {
        Some(actual) if !actual.is_empty() && constant_time_token_eq(&expected_token, actual) => {
            next.run(req).await
        }
        _ => {
            let body = ErrorEnvelope {
                error: ErrorBody {
                    code: ErrorCode::Unauthorized,
                    message: "missing or invalid x-kin-internal-token".to_owned(),
                    retry_after_sec: None,
                    explain: None,
                    current_epoch: None,
                    oldest_seq: None,
                    latest_seq: None,
                },
            };
            (StatusCode::UNAUTHORIZED, Json(body)).into_response()
        }
    }
}
