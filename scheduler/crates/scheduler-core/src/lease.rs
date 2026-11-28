//! Per-attempt active lease tracking, idempotency cache, and bounded pool-queue guard.

use crate::session_gate::GateToken;
use compact_str::CompactString;
use dashmap::DashMap;
use scheduler_proto::{
    AcquireResponse, LeaseId, ModelFamily, NodeKey, NodeType, PoolId, Provider, RequestId,
    ScopedSessionKey,
};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

pub const IDEMPOTENCY_TTL_MS: u64 = 60_000;

/// Active per-attempt lease.
/// Carries immutable `(gate_key, gate_token)` which `/schedule/switch` inherits verbatim
/// without ever releasing `SessionGate` or recomputing `gate_key`.
#[derive(Clone, Debug)]
pub struct ActiveLease {
    pub lease_id: LeaseId,
    pub request_id: RequestId,
    pub attempt_no: u32,
    pub controller_epoch: CompactString,
    pub origin_pool_id: PoolId,
    pub resolved_pool_id: PoolId,
    pub model: CompactString,
    pub model_family: ModelFamily,
    pub provider: Provider,
    pub node_key: NodeKey,
    pub node_type: NodeType,
    pub node_id: CompactString,
    /// `(resolved_pool_id, model_family, session_id)` used for `active_sessions` & `session_sticks`.
    pub session_key: ScopedSessionKey,
    /// Optional parent session key `(resolved_pool_id, model_family, parent_session_id)`.
    pub parent_session_key: Option<ScopedSessionKey>,
    pub machine_id: Option<CompactString>,
    pub is_ephemeral_probe: bool,
    pub is_probe_one: bool,
    pub stood_in: bool,
    pub preserve_machine_home: bool,
    /// Borrowed for one request because the session home was model-gated:
    /// commit must not move the session pin.
    pub keep_session_pin: bool,
    pub committed: bool,
    pub strict_session_overflow: bool,
    /// Immutable `(gate_key, gate_token)` frozen at `acquire()`.
    pub gate_hold: Option<(ScopedSessionKey, GateToken)>,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug)]
pub struct CachedLeaseReply {
    pub response: AcquireResponse,
    pub expires_at_ms: u64,
}

/// RAII guard for per-pool full-load queue counter (`queue_max` enforcement).
pub struct PoolQueueGuard {
    counter: Arc<AtomicU32>,
}

impl PoolQueueGuard {
    pub fn try_enter(
        pool_queues: &DashMap<PoolId, Arc<AtomicU32>>,
        pool_id: &PoolId,
        queue_max: u32,
    ) -> Option<Self> {
        if queue_max == 0 {
            return None;
        }
        let counter = pool_queues
            .entry(pool_id.clone())
            .or_insert_with(|| Arc::new(AtomicU32::new(0)))
            .clone();

        loop {
            let cur = counter.load(Ordering::Acquire);
            if cur >= queue_max {
                return None;
            }
            if counter
                .compare_exchange_weak(cur, cur + 1, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return Some(Self { counter });
            }
        }
    }
}

impl Drop for PoolQueueGuard {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::AcqRel);
    }
}
