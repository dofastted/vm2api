//! Error attribution, dual-granularity (node + node/model) cooldowns, 429 Sink,
//! poison-request multi-node rollback (`poison_tracker`, 120s TTL), and manual `/admin/unrest`.

use crate::delta::DirtyDeltaRing;
use crate::events::EventRingBuffer;
use crate::lease::ActiveLease;
use crate::node_state::{ModelCooldownEntry, NodeRuntimeState};
use compact_str::CompactString;
use dashmap::DashMap;
use scheduler_proto::{
    ErrorClass, FailureReport, NodeKey, NodePenaltyDto, PenaltyDeleteKeyDto, Provider,
    QuotaHeaders, RequestId, SchedulerEventKind, UnrestResponse,
};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::Notify;

pub const POISON_WINDOW_TTL_MS: u64 = 120_000;
pub const PROVIDER_HEALTHY_RECENT_MS: u64 = 300_000;
pub const LONG_COOLDOWN_PERSIST_THRESHOLD_MS: u64 = 60_000;

const MODEL_COOLDOWN_LADDER_MS: &[u64] = &[15_000, 30_000, 60_000, 120_000, 300_000];
const NODE_COOLDOWN_LADDER_MS: &[u64] = &[30_000, 60_000, 120_000, 300_000, 600_000];

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FailureVerdict {
    Recorded,
    PoisonAbort(String),
}

#[derive(Clone, Debug)]
pub struct PoisonNodeSnapshot {
    pub node_key: NodeKey,
    pub model: CompactString,
    pub prev_node_cooldown_until_ms: u64,
    pub prev_node_cooldown_reason: Option<CompactString>,
    pub prev_node_cooldown_step: u32,
    pub prev_consecutive_failures: u32,
    pub prev_sink_seq: u64,
    pub prev_model_cooldown: Option<ModelCooldownEntry>,
    pub persisted_node_penalty: bool,
    pub persisted_model_penalty: bool,
}

#[derive(Clone, Debug)]
pub struct PoisonWindow {
    pub signature: String,
    pub hits: Vec<PoisonNodeSnapshot>,
    pub expires_at_ms: u64,
}

/// Apply upstream quota response headers to a node's runtime state.
pub fn apply_quota_headers(node_rt: &NodeRuntimeState, headers: &QuotaHeaders) {
    let mut st = node_rt.inner.lock();
    if let Some(p5) = headers.quota_util_5h_pct {
        st.quota_util_5h_pct = p5.clamp(0.0, 100.0);
    }
    if let Some(p7) = headers.quota_util_7d_pct {
        st.quota_util_7d_pct = p7.clamp(0.0, 100.0);
    }
}

/// Compute normalized SHA-256 error signature stripping UUIDs, request IDs, timestamps,
/// long numeric IDs, and emails from the first 256 bytes of error text.
pub fn normalize_error_signature(
    http_status: u16,
    explicit_sig: Option<&str>,
    error_message: Option<&str>,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(http_status.to_string().as_bytes());
    hasher.update(b":");

    if let Some(sig) = explicit_sig.map(str::trim).filter(|s| !s.is_empty()) {
        hasher.update(sig.as_bytes());
    } else if let Some(msg) = error_message {
        let normalized = strip_volatile_tokens(msg);
        let limit = floor_char_boundary(&normalized, 256);
        hasher.update(&normalized.as_bytes()[..limit]);
    }
    hex::encode(hasher.finalize())
}

fn floor_char_boundary(s: &str, max_bytes: usize) -> usize {
    if s.len() <= max_bytes {
        return s.len();
    }
    let mut idx = max_bytes;
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

fn strip_volatile_tokens(input: &str) -> String {
    let mut out = String::with_capacity(input.len().min(300));
    let mut first = true;
    for raw_tok in input.split_whitespace() {
        let tok = raw_tok.trim_matches(|c: char| {
            matches!(
                c,
                ',' | ';' | '"' | '\'' | '(' | ')' | '[' | ']' | '{' | '}'
            )
        });
        if tok.is_empty() {
            continue;
        }
        if !first {
            out.push(' ');
        }
        first = false;

        if is_uuid_like(tok) {
            out.push_str("<uuid>");
        } else if is_email_like(tok) {
            out.push_str("<email>");
        } else if is_request_id_like(tok) {
            out.push_str("<reqid>");
        } else if is_iso_timestamp_like(tok) {
            out.push_str("<ts>");
        } else if tok.len() >= 6 && tok.bytes().all(|b| b.is_ascii_digit()) {
            out.push_str("<num>");
        } else {
            out.push_str(&tok.to_ascii_lowercase());
        }
        if out.len() >= 280 {
            break;
        }
    }
    out
}

fn is_uuid_like(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    b[8] == b'-'
        && b[13] == b'-'
        && b[18] == b'-'
        && b[23] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, &c)| matches!(i, 8 | 13 | 18 | 23) || c.is_ascii_hexdigit())
}

fn is_email_like(s: &str) -> bool {
    if let Some((user, dom)) = s.split_once('@') {
        !user.is_empty() && dom.contains('.') && !dom.starts_with('.') && !dom.ends_with('.')
    } else {
        false
    }
}

fn is_request_id_like(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    (lower.starts_with("req_") || lower.starts_with("msg_") || lower.starts_with("resp_"))
        && lower.len() >= 8
}

fn is_iso_timestamp_like(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 19
        && b[0..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[7] == b'-'
        && (b[10] == b'T' || b[10] == b't')
}

/// Apply failure attribution for a lease, updating cooldown/sink and running poison detection.
#[allow(clippy::too_many_arguments)]
pub fn apply_failure(
    lease: &ActiveLease,
    failure: &FailureReport,
    nodes: &DashMap<NodeKey, Arc<NodeRuntimeState>>,
    poison_tracker: &DashMap<RequestId, PoisonWindow>,
    provider_last_healthy: &DashMap<Provider, AtomicU64>,
    sink_counter: &AtomicU64,
    delta_ring: &DirtyDeltaRing,
    events: &EventRingBuffer,
    now_ms: u64,
) -> FailureVerdict {
    // 1. Classify request faults that MUST NOT penalize or cool down the node.
    //    Infer first so callers that omit `error_class` (e.g. plain 400/404/413/422) are exempt too.
    let effective_class = infer_error_class(failure);
    if is_request_fault(effective_class, failure.http_status) {
        return FailureVerdict::Recorded;
    }

    let Some(node_rt) = nodes.get(&lease.node_key) else {
        return FailureVerdict::Recorded;
    };

    if let Some(qh) = &failure.quota_headers {
        apply_quota_headers(&node_rt, qh);
    }

    // 2. Permanent account ban / unrecoverable fault
    if effective_class == ErrorClass::PermanentBan {
        let mut st = node_rt.inner.lock();
        st.permanent_unschedulable = true;
        st.permanent_reason = Some(CompactString::from(
            failure.error_message.as_deref().unwrap_or("permanent_ban"),
        ));
        drop(st);
        delta_ring.record_penalty_upsert(NodePenaltyDto {
            node_key: lease.node_key.clone(),
            node_type: lease.node_type,
            node_id: lease.node_id.clone(),
            model_scope: CompactString::const_new("*"),
            reason: CompactString::const_new("permanent_ban"),
            cooldown_until_ms: u64::MAX / 2,
            ladder_step: 0,
            permanent: true,
            updated_at_ms: now_ms,
        });
        events.emit(
            SchedulerEventKind::NodeCooldown,
            Some(lease.resolved_pool_id.clone()),
            Some(lease.node_key.clone()),
            Some(lease.request_id.clone()),
            Some("permanent_ban".to_owned()),
        );
        return FailureVerdict::Recorded;
    }

    // Snapshot pre-failure state for potential poison rollback.
    let (pre_snap, was_healthy_node) = {
        let st = node_rt.inner.lock();
        let healthy_before = st.consecutive_failures == 0
            && st.node_cooldown_until_ms <= now_ms
            && st
                .model_cooldowns
                .get(&lease.model)
                .is_none_or(|m| m.until_ms <= now_ms);
        (
            PoisonNodeSnapshot {
                node_key: lease.node_key.clone(),
                model: lease.model.clone(),
                prev_node_cooldown_until_ms: st.node_cooldown_until_ms,
                prev_node_cooldown_reason: st.node_cooldown_reason.clone(),
                prev_node_cooldown_step: st.node_cooldown_step,
                prev_consecutive_failures: st.consecutive_failures,
                prev_sink_seq: st.sink_seq,
                prev_model_cooldown: st.model_cooldowns.get(&lease.model).cloned(),
                persisted_node_penalty: false,
                persisted_model_penalty: false,
            },
            healthy_before,
        )
    };

    let mut pre_snap = pre_snap;

    // 3. Apply cooldown / Sink state transitions under single non-nested NodeMutable lock.
    let mut emit_sunk = false;
    let mut emit_cooldown_detail: Option<String> = None;
    let mut penalty_to_persist: Option<NodePenaltyDto> = None;

    {
        let mut st = node_rt.inner.lock();
        match effective_class {
            ErrorClass::RateLimit429 => {
                // Always sink on 429 within tier to prevent hammering the same node.
                let seq = sink_counter.fetch_add(1, Ordering::Relaxed) + 1;
                st.sink_seq = seq;
                emit_sunk = true;

                // If explicit long retry-after (>5s) or already elevated failures/quota >= 90%,
                // also apply model-level cooldown (without amplifying on probe failure).
                let retry_ms = failure.retry_after_sec.map(|s| s.saturating_mul(1000));
                if retry_ms.is_some_and(|ms| ms > 5_000) || st.max_quota_pct() >= 90.0 {
                    let entry = st.model_cooldowns.entry(lease.model.clone()).or_insert(
                        ModelCooldownEntry {
                            until_ms: 0,
                            reason: CompactString::const_new("rate_limit_429"),
                            ladder_step: 0,
                        },
                    );
                    let step = if lease.is_probe_one {
                        entry.ladder_step
                    } else {
                        let s = entry.ladder_step;
                        entry.ladder_step =
                            (entry.ladder_step + 1).min(MODEL_COOLDOWN_LADDER_MS.len() as u32 - 1);
                        s
                    };
                    let dur_ms = retry_ms.unwrap_or(MODEL_COOLDOWN_LADDER_MS[step as usize]);
                    entry.until_ms = now_ms.saturating_add(dur_ms);
                    entry.reason = CompactString::const_new("rate_limit_429");
                    emit_cooldown_detail = Some(format!("model={} dur_ms={dur_ms}", lease.model));
                    if dur_ms > LONG_COOLDOWN_PERSIST_THRESHOLD_MS {
                        pre_snap.persisted_model_penalty = true;
                        penalty_to_persist = Some(NodePenaltyDto {
                            node_key: lease.node_key.clone(),
                            node_type: lease.node_type,
                            node_id: lease.node_id.clone(),
                            model_scope: lease.model.clone(),
                            reason: CompactString::const_new("rate_limit_429"),
                            cooldown_until_ms: entry.until_ms,
                            ladder_step: entry.ladder_step,
                            permanent: false,
                            updated_at_ms: now_ms,
                        });
                    }
                }
            }
            ErrorClass::Overloaded529 => {
                let entry =
                    st.model_cooldowns
                        .entry(lease.model.clone())
                        .or_insert(ModelCooldownEntry {
                            until_ms: 0,
                            reason: CompactString::const_new("overloaded_529"),
                            ladder_step: 0,
                        });
                let step = if lease.is_probe_one {
                    entry.ladder_step
                } else {
                    let s = entry.ladder_step;
                    entry.ladder_step =
                        (entry.ladder_step + 1).min(MODEL_COOLDOWN_LADDER_MS.len() as u32 - 1);
                    s
                };
                let dur_ms = failure
                    .retry_after_sec
                    .map(|s| s.saturating_mul(1000))
                    .unwrap_or(MODEL_COOLDOWN_LADDER_MS[step as usize]);
                entry.until_ms = now_ms.saturating_add(dur_ms);
                entry.reason = CompactString::const_new("overloaded_529");
                emit_cooldown_detail = Some(format!("model={} dur_ms={dur_ms}", lease.model));
                if dur_ms > LONG_COOLDOWN_PERSIST_THRESHOLD_MS {
                    pre_snap.persisted_model_penalty = true;
                    penalty_to_persist = Some(NodePenaltyDto {
                        node_key: lease.node_key.clone(),
                        node_type: lease.node_type,
                        node_id: lease.node_id.clone(),
                        model_scope: lease.model.clone(),
                        reason: CompactString::const_new("overloaded_529"),
                        cooldown_until_ms: entry.until_ms,
                        ladder_step: entry.ladder_step,
                        permanent: false,
                        updated_at_ms: now_ms,
                    });
                }
            }
            ErrorClass::QuotaExhausted | ErrorClass::AuthError => {
                let reason = if effective_class == ErrorClass::QuotaExhausted {
                    CompactString::const_new("quota_exhausted")
                } else {
                    CompactString::const_new("auth_error")
                };
                let step = if lease.is_probe_one {
                    st.node_cooldown_step
                } else {
                    let s = st.node_cooldown_step;
                    st.node_cooldown_step =
                        (st.node_cooldown_step + 1).min(NODE_COOLDOWN_LADDER_MS.len() as u32 - 1);
                    s
                };
                let dur_ms = failure
                    .quota_headers
                    .as_ref()
                    .and_then(|q| q.resets_at_ms)
                    .map(|reset| reset.saturating_sub(now_ms).max(1_000))
                    .or_else(|| failure.retry_after_sec.map(|s| s.saturating_mul(1000)))
                    .unwrap_or(NODE_COOLDOWN_LADDER_MS[step as usize]);
                st.node_cooldown_until_ms = now_ms.saturating_add(dur_ms);
                st.node_cooldown_reason = Some(reason.clone());
                emit_cooldown_detail = Some(format!("node dur_ms={dur_ms} reason={reason}"));
                if dur_ms > LONG_COOLDOWN_PERSIST_THRESHOLD_MS {
                    pre_snap.persisted_node_penalty = true;
                    penalty_to_persist = Some(NodePenaltyDto {
                        node_key: lease.node_key.clone(),
                        node_type: lease.node_type,
                        node_id: lease.node_id.clone(),
                        model_scope: CompactString::const_new("*"),
                        reason,
                        cooldown_until_ms: st.node_cooldown_until_ms,
                        ladder_step: st.node_cooldown_step,
                        permanent: false,
                        updated_at_ms: now_ms,
                    });
                }
            }
            ErrorClass::Server5xx
            | ErrorClass::Transport
            | ErrorClass::Timeout
            | ErrorClass::Client4xx
            | ErrorClass::Unknown => {
                st.consecutive_failures = st.consecutive_failures.saturating_add(1);
                let step = if lease.is_probe_one {
                    st.node_cooldown_step
                } else {
                    let s = st.node_cooldown_step;
                    st.node_cooldown_step =
                        (st.node_cooldown_step + 1).min(NODE_COOLDOWN_LADDER_MS.len() as u32 - 1);
                    s
                };
                let dur_ms = failure
                    .retry_after_sec
                    .map(|s| s.saturating_mul(1000))
                    .unwrap_or(NODE_COOLDOWN_LADDER_MS[step as usize]);
                st.node_cooldown_until_ms = now_ms.saturating_add(dur_ms);
                st.node_cooldown_reason =
                    Some(CompactString::from(format!("http_{}", failure.http_status)));
                emit_cooldown_detail =
                    Some(format!("node http={} dur_ms={dur_ms}", failure.http_status));
                if dur_ms > LONG_COOLDOWN_PERSIST_THRESHOLD_MS {
                    pre_snap.persisted_node_penalty = true;
                    penalty_to_persist = Some(NodePenaltyDto {
                        node_key: lease.node_key.clone(),
                        node_type: lease.node_type,
                        node_id: lease.node_id.clone(),
                        model_scope: CompactString::const_new("*"),
                        reason: CompactString::from(format!("http_{}", failure.http_status)),
                        cooldown_until_ms: st.node_cooldown_until_ms,
                        ladder_step: st.node_cooldown_step,
                        permanent: false,
                        updated_at_ms: now_ms,
                    });
                }
            }
            ErrorClass::JevBlocked
            | ErrorClass::Refusal
            | ErrorClass::ContextTooLong
            | ErrorClass::PermanentBan => {}
        }
    }

    if let Some(p) = penalty_to_persist {
        delta_ring.record_penalty_upsert(p);
    }

    // 4. Poison request multi-node rollback detection (403 or 5xx on >=2 distinct healthy nodes
    //    with the exact same normalized error signature while provider was healthy in last 5 min).
    let poison_eligible = (failure.http_status == 403 || failure.http_status >= 500)
        && effective_class != ErrorClass::Overloaded529
        && was_healthy_node
        && is_provider_recently_healthy(provider_last_healthy, lease.provider, now_ms);

    if poison_eligible {
        let sig = normalize_error_signature(
            failure.http_status,
            failure.error_signature.as_deref(),
            failure.error_message.as_deref(),
        );

        let rollback_hits = {
            let mut entry = poison_tracker
                .entry(lease.request_id.clone())
                .or_insert_with(|| PoisonWindow {
                    signature: sig.clone(),
                    hits: Vec::new(),
                    expires_at_ms: now_ms.saturating_add(POISON_WINDOW_TTL_MS),
                });
            entry.expires_at_ms = now_ms.saturating_add(POISON_WINDOW_TTL_MS);

            if entry.signature == sig {
                if !entry.hits.iter().any(|h| h.node_key == lease.node_key) {
                    entry.hits.push(pre_snap);
                }
                if entry.hits.len() >= 2 {
                    Some(entry.hits.clone())
                } else {
                    None
                }
            } else {
                // Different error signature on retry: reset tracking window to new signature.
                entry.signature = sig.clone();
                entry.hits.clear();
                entry.hits.push(pre_snap);
                None
            }
        };

        if let Some(hits) = rollback_hits {
            // Rollback cooldowns & failure counters on ALL nodes hit by this poison request!
            for h in &hits {
                if let Some(rt) = nodes.get(&h.node_key) {
                    let mut st = rt.inner.lock();
                    st.node_cooldown_until_ms = h.prev_node_cooldown_until_ms;
                    st.node_cooldown_reason = h.prev_node_cooldown_reason.clone();
                    st.node_cooldown_step = h.prev_node_cooldown_step;
                    st.consecutive_failures = h.prev_consecutive_failures;
                    st.sink_seq = h.prev_sink_seq;
                    match &h.prev_model_cooldown {
                        Some(prev_mc) => {
                            st.model_cooldowns.insert(h.model.clone(), prev_mc.clone());
                        }
                        None => {
                            st.model_cooldowns.remove(&h.model);
                        }
                    }
                }
                if h.persisted_node_penalty {
                    delta_ring.record_penalty_delete(PenaltyDeleteKeyDto {
                        node_key: h.node_key.clone(),
                        model_scope: CompactString::const_new("*"),
                    });
                }
                if h.persisted_model_penalty {
                    delta_ring.record_penalty_delete(PenaltyDeleteKeyDto {
                        node_key: h.node_key.clone(),
                        model_scope: h.model.clone(),
                    });
                }
            }

            let reason = format!(
                "identical error signature ({}) reproduced across {} healthy nodes",
                &sig[..12.min(sig.len())],
                hits.len()
            );
            events.emit(
                SchedulerEventKind::PoisonAbort,
                Some(lease.resolved_pool_id.clone()),
                Some(lease.node_key.clone()),
                Some(lease.request_id.clone()),
                Some(reason.clone()),
            );
            return FailureVerdict::PoisonAbort(reason);
        }
    }

    if emit_sunk {
        events.emit(
            SchedulerEventKind::NodeSunk,
            Some(lease.resolved_pool_id.clone()),
            Some(lease.node_key.clone()),
            Some(lease.request_id.clone()),
            Some("429_sunk".to_owned()),
        );
    }
    if let Some(detail) = emit_cooldown_detail {
        events.emit(
            SchedulerEventKind::NodeCooldown,
            Some(lease.resolved_pool_id.clone()),
            Some(lease.node_key.clone()),
            Some(lease.request_id.clone()),
            Some(detail),
        );
    }

    FailureVerdict::Recorded
}

pub fn infer_error_class(f: &FailureReport) -> ErrorClass {
    if f.error_class != ErrorClass::Unknown {
        return f.error_class;
    }
    match f.http_status {
        429 => ErrorClass::RateLimit429,
        529 => ErrorClass::Overloaded529,
        401 => ErrorClass::AuthError,
        403 => ErrorClass::Client4xx,
        400..=499 => ErrorClass::Client4xx,
        500..=599 => ErrorClass::Server5xx,
        _ => ErrorClass::Unknown,
    }
}

/// Request-side faults (bad prompt, JEV, refusal, context overflow, plain 4xx except 403/429)
/// are never the node's fault: no cooldown, no Sink, no sticky unbinding.
pub fn is_request_fault(effective_class: ErrorClass, http_status: u16) -> bool {
    match effective_class {
        ErrorClass::JevBlocked | ErrorClass::Refusal | ErrorClass::ContextTooLong => true,
        ErrorClass::Client4xx => http_status != 403 && http_status != 429,
        _ => false,
    }
}

pub fn mark_provider_healthy(
    provider_last_healthy: &DashMap<Provider, AtomicU64>,
    provider: Provider,
    now_ms: u64,
) {
    provider_last_healthy
        .entry(provider)
        .or_insert_with(|| AtomicU64::new(now_ms))
        .store(now_ms, Ordering::Relaxed);
}

fn is_provider_recently_healthy(
    provider_last_healthy: &DashMap<Provider, AtomicU64>,
    provider: Provider,
    now_ms: u64,
) -> bool {
    match provider_last_healthy.get(&provider) {
        Some(ts) => {
            let last = ts.load(Ordering::Relaxed);
            now_ms.saturating_sub(last) <= PROVIDER_HEALTHY_RECENT_MS
        }
        None => false,
    }
}

/// Manual `/internal/v1/admin/unrest`: clear node/model cooldowns + 429 Sink + permanent block
/// and broadcast `slot_notify` to wake queued waiters.
pub fn unrest_node(
    nodes: &DashMap<NodeKey, Arc<NodeRuntimeState>>,
    delta_ring: &DirtyDeltaRing,
    slot_notify: &Notify,
    events: &EventRingBuffer,
    node_key: &NodeKey,
    model_scope: Option<&str>,
) -> UnrestResponse {
    let mut cleared_cooldowns = 0usize;
    let mut sink_cleared = false;
    let mut cleared_scopes: Vec<CompactString> = Vec::new();

    if let Some(rt) = nodes.get(node_key) {
        let mut st = rt.inner.lock();
        if st.sink_seq > 0 {
            st.sink_seq = 0;
            sink_cleared = true;
        }
        match model_scope
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != "*")
        {
            Some(model) => {
                if st.model_cooldowns.remove(model).is_some() {
                    cleared_cooldowns += 1;
                    cleared_scopes.push(CompactString::from(model));
                }
            }
            None => {
                if st.node_cooldown_until_ms > 0 || st.permanent_unschedulable {
                    cleared_cooldowns += 1;
                    cleared_scopes.push(CompactString::const_new("*"));
                }
                st.node_cooldown_until_ms = 0;
                st.node_cooldown_reason = None;
                st.node_cooldown_step = 0;
                st.permanent_unschedulable = false;
                st.permanent_reason = None;
                st.consecutive_failures = 0;
                st.probe_in_flight = false;
                for (m, _) in st.model_cooldowns.drain() {
                    cleared_cooldowns += 1;
                    cleared_scopes.push(m);
                }
            }
        }
    }

    for scope in cleared_scopes {
        delta_ring.record_penalty_delete(PenaltyDeleteKeyDto {
            node_key: node_key.clone(),
            model_scope: scope,
        });
    }

    slot_notify.notify_waiters();
    events.emit(
        SchedulerEventKind::AdminUnrest,
        None,
        Some(node_key.clone()),
        None,
        Some(format!(
            "cleared_cooldowns={cleared_cooldowns},sink_cleared={sink_cleared}"
        )),
    );

    UnrestResponse {
        ok: true,
        node_key: node_key.clone(),
        cleared_cooldowns,
        sink_cleared,
    }
}
