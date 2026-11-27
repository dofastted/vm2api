//! Value-stored, ABA-free, strict FIFO single-session serialization gate.
//!
//! Invariants:
//! 1. Stored **by value** inside `DashMap<ScopedSessionKey, SessionGateState>` (no inner
//!    `Arc<Mutex<_>>`), eliminating Detached-`Arc` ABA races by construction.
//! 2. Maximum true concurrency for any `(start_pool_id, model_family, session_id)` is strictly 1.
//! 3. Acquire, enqueue, direct FIFO handoff, and empty-entry `occ.remove()` execute atomically
//!    under a single `DashMap::entry(key)` shard lock with zero `.await` while locked.
//! 4. `SessionWaitGuard::drop` closes `rx` FIRST before entering `OccupiedEntry`, then removes
//!    the waiter or relays any in-flight handed-off token to the next FIFO waiter.
//! 5. Never nested with `NodeMutable` or `SwrrRound` locks.

use dashmap::DashMap;
use dashmap::mapref::entry::{Entry, OccupiedEntry};
use scheduler_proto::{ScheduleError, ScopedSessionKey};
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::oneshot;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct GateToken(pub u64);

struct GateWaiter {
    waiter_id: u64,
    tx: oneshot::Sender<GateToken>,
}

/// Stored by value in `DashMap<ScopedSessionKey, SessionGateState>`.
pub struct SessionGateState {
    holder: Option<GateToken>,
    waiters: VecDeque<GateWaiter>,
}

#[derive(Debug, Default)]
pub struct SessionGateMetrics {
    pub reject_in_flight: AtomicU64,
    pub reject_queue_full: AtomicU64,
    pub reject_timeout: AtomicU64,
}

pub struct SessionGateTable {
    gates: DashMap<ScopedSessionKey, SessionGateState>,
    next_token: AtomicU64,
    next_waiter_id: AtomicU64,
    pub metrics: SessionGateMetrics,
}

impl Default for SessionGateTable {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionGateTable {
    pub fn new() -> Self {
        Self {
            gates: DashMap::new(),
            next_token: AtomicU64::new(1),
            next_waiter_id: AtomicU64::new(1),
            metrics: SessionGateMetrics::default(),
        }
    }

    #[inline]
    fn alloc_token(&self) -> GateToken {
        GateToken(self.next_token.fetch_add(1, Ordering::Relaxed))
    }

    #[inline]
    fn alloc_waiter_id(&self) -> u64 {
        self.next_waiter_id.fetch_add(1, Ordering::Relaxed)
    }

    /// Read-only peek for `/explain` dry-run; never blocks or mutates state.
    pub fn peek(&self, key: &ScopedSessionKey) -> (bool, usize) {
        match self.gates.get(key) {
            Some(entry) => (entry.holder.is_some(), entry.waiters.len()),
            None => (false, 0),
        }
    }

    pub fn active_count(&self) -> usize {
        self.gates.len()
    }

    /// Acquire exclusive single-session gate in strict FIFO order.
    pub async fn acquire(
        self: &Arc<Self>,
        key: &ScopedSessionKey,
        no_queue: bool,
        queue_max: u32,
        timeout_ms: u64,
    ) -> Result<GateHoldGuard, ScheduleError> {
        let wait_rx = {
            // Single shard lock critical section: zero `.await`, zero nested locks.
            match self.gates.entry(key.clone()) {
                Entry::Vacant(vacant) => {
                    let tok = self.alloc_token();
                    vacant.insert(SessionGateState {
                        holder: Some(tok),
                        waiters: VecDeque::new(),
                    });
                    return Ok(GateHoldGuard::new(Arc::clone(self), key.clone(), tok));
                }
                Entry::Occupied(mut occ) => {
                    let state = occ.get_mut();
                    if state.holder.is_none() {
                        let tok = self.alloc_token();
                        state.holder = Some(tok);
                        return Ok(GateHoldGuard::new(Arc::clone(self), key.clone(), tok));
                    }
                    if no_queue {
                        self.metrics
                            .reject_in_flight
                            .fetch_add(1, Ordering::Relaxed);
                        return Err(ScheduleError::SessionInFlight);
                    }
                    if state.waiters.len() >= queue_max as usize {
                        self.metrics
                            .reject_queue_full
                            .fetch_add(1, Ordering::Relaxed);
                        return Err(ScheduleError::SessionQueueFull);
                    }
                    let waiter_id = self.alloc_waiter_id();
                    let (tx, rx) = oneshot::channel();
                    state.waiters.push_back(GateWaiter { waiter_id, tx });
                    (waiter_id, rx)
                }
            }
        };

        let mut wait_guard = SessionWaitGuard {
            table: Arc::clone(self),
            gate_key: key.clone(),
            waiter_id: wait_rx.0,
            rx: wait_rx.1,
            completed: false,
        };

        match tokio::time::timeout(Duration::from_millis(timeout_ms), &mut wait_guard.rx).await {
            Ok(Ok(tok)) => {
                wait_guard.completed = true;
                Ok(GateHoldGuard::new(Arc::clone(self), key.clone(), tok))
            }
            Ok(Err(_)) | Err(_) => {
                // `wait_guard` drops here: closes `rx` first, then either removes itself from
                // `waiters` or relays an already-handed-off token inside the same shard lock.
                self.metrics.reject_timeout.fetch_add(1, Ordering::Relaxed);
                Err(ScheduleError::SessionQueueTimeout)
            }
        }
    }

    /// Release gate held by `expected_tok`, handing off directly to FIFO head or removing entry.
    pub fn release(&self, key: &ScopedSessionKey, expected_tok: GateToken) {
        if let Entry::Occupied(occ) = self.gates.entry(key.clone()) {
            handoff_or_remove_occupied(occ, expected_tok, &self.next_token);
        }
    }

    /// Re-arm a `GateHoldGuard` from an immutable `(gate_key, gate_token)` extracted from
    /// an `ActiveLease` during `/schedule/switch` (never releases the gate!).
    pub fn rearm_guard(
        self: &Arc<Self>,
        gate_key: ScopedSessionKey,
        token: GateToken,
    ) -> GateHoldGuard {
        GateHoldGuard::new(Arc::clone(self), gate_key, token)
    }
}

/// Atomically hand off the gate to the next live FIFO waiter, or remove the empty entry
/// under the exact same `OccupiedEntry` shard lock (zero ABA, zero leaks).
fn handoff_or_remove_occupied(
    mut occ: OccupiedEntry<'_, ScopedSessionKey, SessionGateState>,
    expected_tok: GateToken,
    next_token: &AtomicU64,
) {
    let state = occ.get_mut();
    if state.holder != Some(expected_tok) {
        return;
    }

    while let Some(waiter) = state.waiters.pop_front() {
        let next_tok = GateToken(next_token.fetch_add(1, Ordering::Relaxed));
        if waiter.tx.send(next_tok).is_ok() {
            state.holder = Some(next_tok);
            return;
        }
        // Waiter already cancelled and closed `rx`; skip to next FIFO waiter.
    }

    state.holder = None;
    occ.remove();
}

/// RAII guard for an active gate holder prior to committing into `ActiveLease`.
/// Automatically releases the gate if planning fails, errors, or the request future is aborted.
pub struct GateHoldGuard {
    table: Arc<SessionGateTable>,
    gate_key: ScopedSessionKey,
    token: GateToken,
    armed: bool,
}

impl GateHoldGuard {
    fn new(table: Arc<SessionGateTable>, gate_key: ScopedSessionKey, token: GateToken) -> Self {
        Self {
            table,
            gate_key,
            token,
            armed: true,
        }
    }

    pub fn gate_key(&self) -> &ScopedSessionKey {
        &self.gate_key
    }

    pub fn token(&self) -> GateToken {
        self.token
    }

    /// Disarm RAII drop and transfer immutable ownership into `ActiveLease`.
    pub fn disarm_into_parts(mut self) -> (ScopedSessionKey, GateToken) {
        self.armed = false;
        (self.gate_key.clone(), self.token)
    }
}

impl Drop for GateHoldGuard {
    fn drop(&mut self) {
        if self.armed {
            self.armed = false;
            self.table.release(&self.gate_key, self.token);
        }
    }
}

/// RAII cancellation guard for a queued FIFO waiter.
/// Guarantees zero deadlocks and zero lost wakeups on timeout or HTTP client abort.
struct SessionWaitGuard {
    table: Arc<SessionGateTable>,
    gate_key: ScopedSessionKey,
    waiter_id: u64,
    rx: oneshot::Receiver<GateToken>,
    completed: bool,
}

impl Drop for SessionWaitGuard {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        // 1. Close `rx` BEFORE taking the shard lock so any concurrent releaser sees send failure
        //    and skips us, while preserving any token ALREADY sent before `close()`.
        self.rx.close();

        // 2. Enter the exact same DashMap shard lock.
        if let Entry::Occupied(mut occ) = self.table.gates.entry(self.gate_key.clone()) {
            let state = occ.get_mut();
            if let Some(pos) = state
                .waiters
                .iter()
                .position(|w| w.waiter_id == self.waiter_id)
            {
                state.waiters.remove(pos);
                if state.holder.is_none() && state.waiters.is_empty() {
                    occ.remove();
                }
            } else if let Ok(tok) = self.rx.try_recv() {
                // Race fallback: previous holder already popped us and handed off `tok` before
                // `rx.close()`. Relay `tok` directly to the next FIFO waiter (or remove if empty)
                // within this exact same `OccupiedEntry` shard lock!
                handoff_or_remove_occupied(occ, tok, &self.table.next_token);
            }
        }
    }
}
