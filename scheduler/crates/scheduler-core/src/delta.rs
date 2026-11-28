//! Deduplicating dirty-delta ring for Node single-writer persistence (`/persistence/drain`).
//!
//! Guarantees:
//! - Multiple updates to the same sticky/penalty key coalesce into one latest delta.
//! - Failed DB writes (missing `ack_batch_id`) keep un-ACKed deltas for retry.
//! - Mutations arriving AFTER a drain snapshot carry a newer `rev` and are NOT erased
//!   when the earlier `batch_id` is ACKed.

use parking_lot::Mutex;
use scheduler_proto::{
    DrainResponse, NodePenaltyDto, PenaltyDeleteKeyDto, StickyBindingDto, StickyDeleteKeyDto,
};
use std::collections::HashMap;

#[derive(Clone, Debug)]
enum StickyDeltaOp {
    Upsert(StickyBindingDto),
    Delete(StickyDeleteKeyDto),
}

#[derive(Clone, Debug)]
enum PenaltyDeltaOp {
    Upsert(NodePenaltyDto),
    Delete(PenaltyDeleteKeyDto),
}

#[derive(Clone, Debug)]
struct Versioned<T> {
    rev: u64,
    op: T,
}

#[derive(Clone, Debug)]
enum BatchMarker {
    Sticky(StickyDeleteKeyDto, u64),
    Penalty(PenaltyDeleteKeyDto, u64),
}

#[derive(Default)]
struct DeltaState {
    next_rev: u64,
    next_batch_id: u64,
    sticky: HashMap<StickyDeleteKeyDto, Versioned<StickyDeltaOp>>,
    penalties: HashMap<PenaltyDeleteKeyDto, Versioned<PenaltyDeltaOp>>,
    inflight_batches: HashMap<u64, Vec<BatchMarker>>,
}

#[derive(Default)]
pub struct DirtyDeltaRing {
    inner: Mutex<DeltaState>,
}

impl DirtyDeltaRing {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn pending_count(&self) -> usize {
        let g = self.inner.lock();
        g.sticky.len() + g.penalties.len()
    }

    pub fn record_sticky_upsert(&self, dto: StickyBindingDto) {
        let key = StickyDeleteKeyDto {
            scope_kind: dto.scope_kind,
            pool_id: dto.pool_id.clone(),
            model_family: dto.model_family,
            identity_id: dto.identity_id.clone(),
        };
        let mut g = self.inner.lock();
        g.next_rev += 1;
        let rev = g.next_rev;
        g.sticky.insert(
            key,
            Versioned {
                rev,
                op: StickyDeltaOp::Upsert(dto),
            },
        );
    }

    pub fn record_sticky_delete(&self, key: StickyDeleteKeyDto) {
        let mut g = self.inner.lock();
        g.next_rev += 1;
        let rev = g.next_rev;
        g.sticky.insert(
            key.clone(),
            Versioned {
                rev,
                op: StickyDeltaOp::Delete(key),
            },
        );
    }

    pub fn record_penalty_upsert(&self, dto: NodePenaltyDto) {
        let key = PenaltyDeleteKeyDto {
            node_key: dto.node_key.clone(),
            model_scope: dto.model_scope.clone(),
        };
        let mut g = self.inner.lock();
        g.next_rev += 1;
        let rev = g.next_rev;
        g.penalties.insert(
            key,
            Versioned {
                rev,
                op: PenaltyDeltaOp::Upsert(dto),
            },
        );
    }

    pub fn record_penalty_delete(&self, key: PenaltyDeleteKeyDto) {
        let mut g = self.inner.lock();
        g.next_rev += 1;
        let rev = g.next_rev;
        g.penalties.insert(
            key.clone(),
            Versioned {
                rev,
                op: PenaltyDeltaOp::Delete(key),
            },
        );
    }

    /// Acknowledge an optional previous `ack_batch_id` and optionally drain up to `max_items`.
    pub fn drain(
        &self,
        max_items: usize,
        ack_batch_id: Option<u64>,
        ack_only: bool,
    ) -> DrainResponse {
        let mut g = self.inner.lock();

        if let Some(bid) = ack_batch_id {
            if let Some(markers) = g.inflight_batches.remove(&bid) {
                for marker in markers {
                    match marker {
                        BatchMarker::Sticky(k, rev) => {
                            if g.sticky.get(&k).is_some_and(|v| v.rev == rev) {
                                g.sticky.remove(&k);
                            }
                        }
                        BatchMarker::Penalty(k, rev) => {
                            if g.penalties.get(&k).is_some_and(|v| v.rev == rev) {
                                g.penalties.remove(&k);
                            }
                        }
                    }
                }
            }
        }

        if ack_only || max_items == 0 {
            return DrainResponse {
                ok: true,
                batch_id: None,
                sticky_upserts: Vec::new(),
                sticky_deletes: Vec::new(),
                penalty_upserts: Vec::new(),
                penalty_deletes: Vec::new(),
                remaining: g.sticky.len() + g.penalties.len(),
            };
        }

        let mut sticky_upserts = Vec::new();
        let mut sticky_deletes = Vec::new();
        let mut penalty_upserts = Vec::new();
        let mut penalty_deletes = Vec::new();
        let mut markers = Vec::new();
        let mut taken = 0usize;

        for (k, v) in &g.sticky {
            if taken >= max_items {
                break;
            }
            match &v.op {
                StickyDeltaOp::Upsert(dto) => sticky_upserts.push(dto.clone()),
                StickyDeltaOp::Delete(dk) => sticky_deletes.push(dk.clone()),
            }
            markers.push(BatchMarker::Sticky(k.clone(), v.rev));
            taken += 1;
        }

        for (k, v) in &g.penalties {
            if taken >= max_items {
                break;
            }
            match &v.op {
                PenaltyDeltaOp::Upsert(dto) => penalty_upserts.push(dto.clone()),
                PenaltyDeltaOp::Delete(dk) => penalty_deletes.push(dk.clone()),
            }
            markers.push(BatchMarker::Penalty(k.clone(), v.rev));
            taken += 1;
        }

        let batch_id = if markers.is_empty() {
            None
        } else {
            g.next_batch_id += 1;
            let bid = g.next_batch_id;
            // Keep bounded inflight batch history in case old callers crashed without ACK.
            if g.inflight_batches.len() > 64 {
                if let Some(&oldest_bid) = g.inflight_batches.keys().min() {
                    g.inflight_batches.remove(&oldest_bid);
                }
            }
            g.inflight_batches.insert(bid, markers);
            Some(bid)
        };

        let total_pending = g.sticky.len() + g.penalties.len();
        DrainResponse {
            ok: true,
            batch_id,
            sticky_upserts,
            sticky_deletes,
            penalty_upserts,
            penalty_deletes,
            remaining: total_pending.saturating_sub(taken),
        }
    }
}
