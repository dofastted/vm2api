//! Unified `SchedulerEngine` facade orchestrating all 5 scheduling stages, SessionGate,
//! atomic `/schedule/switch`, telemetry, persistence drain, SSE events, and lease reaping.
//!
//! Strict lock-order invariant:
//! - `session_gates` (`DashMap` shard lock), `NodeMutable` (`Mutex`), and `SwrrRound` (`Mutex`)
//!   are NEVER nested simultaneously and NEVER held across `.await`.

use crate::admission::{self, AdmittedCandidate};
use crate::affinity::{self, MachineStick, SessionStick};
use crate::delta::DirtyDeltaRing;
use crate::events::EventRingBuffer;
use crate::health::{self, FailureVerdict, PoisonWindow};
use crate::lease::{ActiveLease, CachedLeaseReply, IDEMPOTENCY_TTL_MS, PoolQueueGuard};
use crate::node_state::{ModelCooldownEntry, NodeRuntimeState};
use crate::now_ms;
use crate::session_gate::{GateHoldGuard, SessionGateTable};
use crate::snapshot::IndexedSnapshot;
use crate::tier_rank::{self, SwrrRound, TierBucketKey};
use arc_swap::ArcSwap;
use compact_str::CompactString;
use dashmap::DashMap;
use parking_lot::Mutex;
use scheduler_proto::{
    AcquireRequest, AcquireResponse, AffinityWhy, BootstrapRequest, BootstrapResponse,
    CommitRequest, CommitResponse, ConfigSyncRequest, ConfigSyncResponse, DecisionExplain,
    DrainRequest, DrainResponse, ExplainResponse, FailureReport, HealthResponse, HeartbeatRequest,
    HeartbeatResponse, LeaseId, NodeKey, PoolConfig, PoolId, Provider, ReleaseOutcome,
    ReleaseRequest, ReleaseResponse, RequestId, Role, ScheduleError, SchedulerEvent,
    SchedulerEventKind, ScopedMachineKey, ScopedSessionKey, SelectedNodeInfo,
    SessionOverflowPolicy, StickyBindingDto, StickyDeleteKeyDto, StickyDeleteResponse,
    StickyListResponse, StickyQuery, StickyScopeKind, SwitchRequest, TelemetryBatchRequest,
    TelemetryBatchResponse, UnrestRequest, UnrestResponse,
};
use smallvec::SmallVec;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::{Notify, broadcast};

#[derive(Clone, Debug)]
pub struct EngineOptions {
    pub lease_ttl_ms: u64,
    pub config_barrier_timeout_ms: u64,
}

impl Default for EngineOptions {
    fn default() -> Self {
        Self {
            lease_ttl_ms: 120_000,
            config_barrier_timeout_ms: 2_000,
        }
    }
}

pub struct SchedulerEngine {
    opts: EngineOptions,
    started_at: Instant,
    boot_nonce: u64,
    bootstrapped: AtomicBool,
    role: Mutex<Role>,
    config: ArcSwap<IndexedSnapshot>,
    config_notify: Arc<Notify>,
    pub session_gates: Arc<SessionGateTable>,
    nodes: DashMap<NodeKey, Arc<NodeRuntimeState>>,
    session_sticks: DashMap<ScopedSessionKey, SessionStick>,
    machine_sticks: DashMap<ScopedMachineKey, MachineStick>,
    swrr_states: DashMap<TierBucketKey, Mutex<SwrrRound>>,
    leases: DashMap<LeaseId, ActiveLease>,
    idempotency: DashMap<(RequestId, u32), CachedLeaseReply>,
    poison_tracker: DashMap<RequestId, PoisonWindow>,
    provider_last_healthy: DashMap<Provider, AtomicU64>,
    pool_queues: DashMap<PoolId, Arc<AtomicU32>>,
    delta_ring: Arc<DirtyDeltaRing>,
    slot_notify: Arc<Notify>,
    events: Arc<EventRingBuffer>,
    lease_seq: AtomicU64,
    sink_seq: AtomicU64,
    pub expired_leases_total: AtomicU64,
}

impl SchedulerEngine {
    pub fn new(opts: EngineOptions) -> Self {
        let now = now_ms();
        let boot_nonce = (now << 16) ^ (std::process::id() as u64);
        Self {
            opts,
            started_at: Instant::now(),
            boot_nonce,
            bootstrapped: AtomicBool::new(false),
            role: Mutex::new(Role::Leader),
            config: ArcSwap::from_pointee(IndexedSnapshot::default()),
            config_notify: Arc::new(Notify::new()),
            session_gates: Arc::new(SessionGateTable::new()),
            nodes: DashMap::new(),
            session_sticks: DashMap::new(),
            machine_sticks: DashMap::new(),
            swrr_states: DashMap::new(),
            leases: DashMap::new(),
            idempotency: DashMap::new(),
            poison_tracker: DashMap::new(),
            provider_last_healthy: DashMap::new(),
            pool_queues: DashMap::new(),
            delta_ring: Arc::new(DirtyDeltaRing::new()),
            slot_notify: Arc::new(Notify::new()),
            events: Arc::new(EventRingBuffer::new("uninitialized")),
            lease_seq: AtomicU64::new(1),
            sink_seq: AtomicU64::new(0),
            expired_leases_total: AtomicU64::new(0),
        }
    }

    pub fn lease_ttl_ms(&self) -> u64 {
        self.opts.lease_ttl_ms
    }

    fn next_lease_id(&self) -> LeaseId {
        let seq = self.lease_seq.fetch_add(1, Ordering::Relaxed);
        CompactString::from(format!(
            "ls_{:012x}_{:08x}",
            self.boot_nonce & 0xFFFF_FFFF_FFFF,
            seq
        ))
    }

    fn ensure_node_state(&self, node_key: &NodeKey) -> Arc<NodeRuntimeState> {
        self.nodes
            .entry(node_key.clone())
            .or_insert_with(|| Arc::new(NodeRuntimeState::new()))
            .clone()
    }

    pub fn health(&self) -> HealthResponse {
        let snap = self.config.load();
        HealthResponse {
            ok: true,
            bootstrapped: self.bootstrapped.load(Ordering::Acquire),
            role: *self.role.lock(),
            config_version: snap.config_version(),
            epoch: self.events.current_epoch(),
            active_leases: self.leases.len(),
            active_session_gates: self.session_gates.active_count(),
            dirty_deltas: self.delta_ring.pending_count(),
            uptime_ms: self.started_at.elapsed().as_millis() as u64,
        }
    }

    /// `/internal/v1/bootstrap`: Full warm-up, orphan epoch lease reaping (also releasing
    /// associated SessionGates!), sticky/penalty/telemetry hydration.
    pub fn bootstrap(&self, mut req: BootstrapRequest) -> BootstrapResponse {
        let now = now_ms();
        if let Some(ver) = req.config_version {
            req.config_snapshot.config_version = ver;
        }
        let config_version = req.config_snapshot.config_version;

        // 1. Reap ALL orphan leases belonging to any previous controller_epoch!
        let orphan_ids: Vec<LeaseId> = self
            .leases
            .iter()
            .filter(|entry| entry.value().controller_epoch != req.controller_epoch)
            .map(|entry| entry.key().clone())
            .collect();
        let mut orphans_reaped = 0usize;
        for lid in orphan_ids {
            if self.release_lease_internal(&lid, ReleaseOutcome::Aborted, None) {
                orphans_reaped += 1;
            }
        }

        // 2. Store role, epoch, and snapshot
        *self.role.lock() = req.role;
        self.events.set_epoch(&req.controller_epoch);

        for node in &req.config_snapshot.nodes {
            self.ensure_node_state(&node.node_key);
            health::mark_provider_healthy(&self.provider_last_healthy, node.provider, now);
        }

        let indexed = IndexedSnapshot::from_config(req.config_snapshot);
        self.config.store(Arc::new(indexed));

        // 3. Hydrate live sticky bindings (without marking dirty in DirtyDeltaRing!)
        let mut sticky_loaded = 0usize;
        for binding in &req.active_sticky_bindings {
            if binding.expires_at_ms < now {
                continue;
            }
            match binding.scope_kind {
                StickyScopeKind::Session => {
                    let key = ScopedSessionKey::new(
                        &binding.pool_id,
                        binding.model_family,
                        &binding.identity_id,
                    );
                    self.session_sticks
                        .insert(key, SessionStick::from_dto(binding));
                    sticky_loaded += 1;
                }
                StickyScopeKind::Machine => {
                    let key = ScopedMachineKey::new(
                        &binding.pool_id,
                        binding.model_family,
                        &binding.identity_id,
                    );
                    self.machine_sticks
                        .insert(key, MachineStick::from_dto(binding));
                    sticky_loaded += 1;
                }
            }
        }

        // 4. Hydrate active penalties (without marking dirty!)
        let mut penalties_loaded = 0usize;
        for p in &req.active_penalties {
            if !p.permanent && p.cooldown_until_ms <= now {
                continue;
            }
            let rt = self.ensure_node_state(&p.node_key);
            let mut st = rt.inner.lock();
            if p.permanent {
                st.permanent_unschedulable = true;
                st.permanent_reason = Some(p.reason.clone());
            } else if p.model_scope.as_str() == "*" {
                st.node_cooldown_until_ms = st.node_cooldown_until_ms.max(p.cooldown_until_ms);
                st.node_cooldown_reason = Some(p.reason.clone());
                st.node_cooldown_step = p.ladder_step;
            } else {
                st.model_cooldowns.insert(
                    p.model_scope.clone(),
                    ModelCooldownEntry {
                        until_ms: p.cooldown_until_ms,
                        reason: p.reason.clone(),
                        ladder_step: p.ladder_step,
                    },
                );
            }
            penalties_loaded += 1;
        }

        // 5. Hydrate initial telemetry
        let mut telemetry_loaded = 0usize;
        for upd in &req.initial_telemetry {
            let rt = self.ensure_node_state(&upd.node_key);
            rt.inner.lock().apply_telemetry(upd);
            telemetry_loaded += 1;
        }

        self.bootstrapped.store(true, Ordering::Release);
        self.config_notify.notify_waiters();
        self.slot_notify.notify_waiters();

        self.events.emit(
            SchedulerEventKind::Bootstrap,
            None,
            None,
            None,
            Some(format!(
                "config_version={config_version},orphans_reaped={orphans_reaped}"
            )),
        );

        BootstrapResponse {
            ok: true,
            bootstrapped: true,
            role: req.role,
            epoch: req.controller_epoch,
            config_version,
            orphans_reaped,
            sticky_loaded,
            penalties_loaded,
            telemetry_loaded,
        }
    }

    /// `/internal/v1/config/sync`: Atomic higher-version snapshot replacement via `ArcSwap`.
    pub fn sync_config(&self, mut req: ConfigSyncRequest) -> ConfigSyncResponse {
        let cur = self.config.load();
        let cur_ver = cur.config_version();
        if req.config_version <= cur_ver {
            return ConfigSyncResponse {
                ok: true,
                applied: false,
                config_version: cur_ver,
            };
        }

        let now = now_ms();
        req.config_snapshot.config_version = req.config_version;
        for node in &req.config_snapshot.nodes {
            self.ensure_node_state(&node.node_key);
            self.provider_last_healthy
                .entry(node.provider)
                .or_insert_with(|| AtomicU64::new(now));
        }

        let indexed = IndexedSnapshot::from_config(req.config_snapshot);
        self.config.store(Arc::new(indexed));
        self.config_notify.notify_waiters();
        self.slot_notify.notify_waiters();

        self.events.emit(
            SchedulerEventKind::ConfigSync,
            None,
            None,
            None,
            Some(format!("config_version={}", req.config_version)),
        );

        ConfigSyncResponse {
            ok: true,
            applied: true,
            config_version: req.config_version,
        }
    }

    /// `/internal/v1/nodes/telemetry`: High-frequency in-place runtime state update.
    /// Zero `config_version` bump, zero `ArcSwap` rebuild.
    pub fn update_telemetry(&self, req: TelemetryBatchRequest) -> TelemetryBatchResponse {
        let mut updated = 0usize;
        let mut any_freer = false;

        for upd in &req.nodes {
            let rt = self.ensure_node_state(&upd.node_key);
            if rt.inner.lock().apply_telemetry(upd) {
                any_freer = true;
            }
            updated += 1;
        }

        if any_freer {
            self.slot_notify.notify_waiters();
        }

        TelemetryBatchResponse { ok: true, updated }
    }

    async fn ensure_fresh_snapshot(
        &self,
        min_config_version: u64,
    ) -> Result<Arc<IndexedSnapshot>, ScheduleError> {
        if !self.bootstrapped.load(Ordering::Acquire) {
            return Err(ScheduleError::NotBootstrapped);
        }
        let snap = self.config.load_full();
        if snap.config_version() >= min_config_version {
            return Ok(snap);
        }

        let deadline = tokio::time::Instant::now()
            + Duration::from_millis(self.opts.config_barrier_timeout_ms);
        loop {
            let notified = self.config_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            let snap = self.config.load_full();
            if snap.config_version() >= min_config_version {
                return Ok(snap);
            }

            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                let current = self.config.load().config_version();
                if current >= min_config_version {
                    return Ok(self.config.load_full());
                }
                return Err(ScheduleError::ConfigVersionTimeout {
                    requested: min_config_version,
                    current,
                });
            }
        }
    }

    /// `/internal/v1/schedule/acquire`
    pub async fn acquire(&self, req: AcquireRequest) -> Result<AcquireResponse, ScheduleError> {
        self.acquire_inner(req, false).await
    }

    /// `/internal/v1/schedule/explain` (strictly read-only dry-run; never blocks SessionGate).
    pub async fn explain(&self, req: AcquireRequest) -> Result<ExplainResponse, ScheduleError> {
        match self.acquire_inner(req, true).await {
            Ok(resp) => Ok(ExplainResponse {
                ok: true,
                selected_node: Some(resp.selected_node),
                resolved_pool_id: Some(resp.resolved_pool_id),
                prompt_policy: Some(resp.prompt_policy),
                stood_in: resp.stood_in,
                preserve_machine_home: resp.preserve_machine_home,
                error_code: None,
                explain: resp.explain,
            }),
            Err(err) => {
                let code = err.code();
                match err {
                    ScheduleError::PoolExhausted { explain }
                    | ScheduleError::PoolQueueFull { explain }
                    | ScheduleError::SessionNodeBusy { explain, .. }
                    | ScheduleError::NodeBusy { explain, .. } => Ok(ExplainResponse {
                        ok: false,
                        selected_node: None,
                        resolved_pool_id: None,
                        prompt_policy: None,
                        stood_in: false,
                        preserve_machine_home: false,
                        error_code: Some(code),
                        explain: *explain,
                    }),
                    other => Err(other),
                }
            }
        }
    }

    async fn acquire_inner(
        &self,
        req: AcquireRequest,
        dry_run: bool,
    ) -> Result<AcquireResponse, ScheduleError> {
        let t_total = Instant::now();

        if !dry_run {
            let now = now_ms();
            let idem_key = (req.request_id.clone(), req.attempt_no);
            if let Some(hit) = self.idempotency.get(&idem_key) {
                if now <= hit.expires_at_ms {
                    return Ok(hit.response.clone());
                }
            }
        }

        let snap = self.ensure_fresh_snapshot(req.min_config_version).await?;

        // 1. Fail-Closed authorization on origin_pool_id + trusted JEV downgrade pool check.
        let origin_pool = snap.resolve_authorized_pool(&req.origin_pool_id, &req.api_key_scope)?;
        let (start_pool, is_downgraded) = match req.jev_downgrade_pool_id.as_deref() {
            Some(dp_id) if !dp_id.is_empty() => (
                snap.resolve_trusted_downgrade_pool(dp_id, &req.api_key_scope)?,
                true,
            ),
            _ => (origin_pool, false),
        };

        // 2. Admin diagnostic pin_node_key bypass (strictly requires is_admin_diagnostic=true).
        if let Some(pin_key) = req.pin_node_key.as_deref().filter(|s| !s.is_empty()) {
            if !req.is_admin_diagnostic {
                return Err(ScheduleError::Forbidden(
                    "pin_node_key requires is_admin_diagnostic=true".to_owned(),
                ));
            }
            return self.acquire_pinned(&snap, start_pool, pin_key, &req, dry_run, t_total);
        }

        // 3. ★ Entry Atomic FIFO SessionGate (BEFORE any candidate filtering or slot reservation!) ★
        //    Key uses `start_pool.id` so Turn 1 fallback to P2 and Turn 2 share the exact same gate.
        let gate_key = ScopedSessionKey::new(&start_pool.id, req.model_family, &req.session_id);
        let mut gate_wait_ms = 0u64;
        let gate_guard: Option<GateHoldGuard> =
            if !dry_run && !req.is_ephemeral_probe && !req.skip_session_gate {
                let t_gate = Instant::now();
                let g = self
                    .session_gates
                    .acquire(
                        &gate_key,
                        req.no_queue,
                        start_pool.session_queue_max,
                        start_pool.session_queue_timeout_ms,
                    )
                    .await?;
                gate_wait_ms = t_gate.elapsed().as_millis() as u64;
                Some(g)
            } else {
                None
            };

        self.plan_and_reserve_holding_gate(
            &snap,
            start_pool,
            is_downgraded,
            &req,
            gate_guard,
            gate_wait_ms,
            dry_run,
            t_total,
            SchedulerEventKind::LeaseAcquired,
        )
        .await
    }

    /// `/internal/v1/schedule/switch`: Single-RTT atomic slot switch during Try Loop.
    /// Releases ONLY the old VM slot, records error / runs poison detection, and inherits the
    /// exact immutable `(gate_key, gate_token)` WITHOUT releasing SessionGate!
    pub async fn switch(&self, mut req: SwitchRequest) -> Result<AcquireResponse, ScheduleError> {
        let t_total = Instant::now();
        let now = now_ms();
        let idem_key = (
            req.next_attempt.request_id.clone(),
            req.next_attempt.attempt_no,
        );
        if let Some(hit) = self.idempotency.get(&idem_key) {
            if now <= hit.expires_at_ms {
                return Ok(hit.response.clone());
            }
        }

        // 1. Pop old lease, free ONLY its node slot, and re-arm its immutable GateHoldGuard.
        let (old_lease, gate_guard) = self.release_node_slot_keeping_gate(&req.release_lease_id)?;

        // 2. Apply failure attribution & poison detection.
        //    On PoisonAbort, returning Err drops `gate_guard`, releasing SessionGate & waking FIFO head!
        if let FailureVerdict::PoisonAbort(reason) = health::apply_failure(
            &old_lease,
            &req.failure,
            &self.nodes,
            &self.poison_tracker,
            &self.provider_last_healthy,
            &self.sink_seq,
            &self.delta_ring,
            &self.events,
            now,
        ) {
            return Err(ScheduleError::PoisonAbort { reason });
        }

        // Always exclude the failed node on the next attempt.
        if !req.next_attempt.exclude_nodes.contains(&old_lease.node_key) {
            req.next_attempt
                .exclude_nodes
                .push(old_lease.node_key.clone());
        }

        // 3. Plan & reserve holding the EXACT same SessionGate!
        //    If planning fails or is cancelled, `gate_guard` Drop releases the gate automatically.
        let snap = self
            .ensure_fresh_snapshot(req.next_attempt.min_config_version)
            .await?;
        let origin_pool = snap.resolve_authorized_pool(
            &req.next_attempt.origin_pool_id,
            &req.next_attempt.api_key_scope,
        )?;
        let (start_pool, is_downgraded) = match req.next_attempt.jev_downgrade_pool_id.as_deref() {
            Some(dp_id) if !dp_id.is_empty() => (
                snap.resolve_trusted_downgrade_pool(dp_id, &req.next_attempt.api_key_scope)?,
                true,
            ),
            _ => (origin_pool, false),
        };

        self.plan_and_reserve_holding_gate(
            &snap,
            start_pool,
            is_downgraded,
            &req.next_attempt,
            gate_guard,
            0,
            false,
            t_total,
            SchedulerEventKind::LeaseSwitched,
        )
        .await
    }

    fn acquire_pinned(
        &self,
        snap: &IndexedSnapshot,
        start_pool: &PoolConfig,
        pin_key: &str,
        req: &AcquireRequest,
        dry_run: bool,
        t_total: Instant,
    ) -> Result<AcquireResponse, ScheduleError> {
        let node = snap
            .get_node(pin_key)
            .ok_or_else(|| ScheduleError::NodeNotFound(format!("node '{pin_key}' not found")))?;

        let mut explain = DecisionExplain::new(
            &req.request_id,
            snap.config_version(),
            &req.origin_pool_id,
            &start_pool.id,
            &req.model,
            false,
            req.machine_id.is_some(),
            req.session_id_source.clone(),
        );

        let cand = AdmittedCandidate {
            node_key: node.node_key.clone(),
            node_type: node.node_type,
            node_id: node.node_id.clone(),
            provider: node.provider,
            effective_weight_tier: node.effective_base_weight_tier(),
            sub_weight: node.sub_weight.clamp(1, 1000),
            member_role: scheduler_proto::MemberRole::Active,
            member_order: 0,
            is_probe_one: false,
            node_cfg: node,
            metrics: Default::default(),
        };

        let s_key = ScopedSessionKey::new(&start_pool.id, req.model_family, &req.session_id);
        let mut no_gate: Option<GateHoldGuard> = None;

        if let Some(lease) = self.try_reserve_node(
            &cand,
            start_pool,
            req,
            &s_key,
            false,
            true,
            &mut no_gate,
            dry_run,
        ) {
            explain.set_affinity(AffinityWhy::PinnedDiagnostic, &cand.node_key);
            Ok(self.finalize_acquire(
                lease,
                &cand,
                snap,
                start_pool,
                0,
                explain,
                dry_run,
                t_total,
                SchedulerEventKind::LeaseAcquired,
            ))
        } else {
            Err(ScheduleError::NodeBusy {
                node_key: pin_key.to_owned(),
                explain: Box::new(explain),
            })
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn plan_and_reserve_holding_gate(
        &self,
        snap: &IndexedSnapshot,
        start_pool: &PoolConfig,
        is_downgraded: bool,
        req: &AcquireRequest,
        mut gate_guard: Option<GateHoldGuard>,
        gate_wait_ms: u64,
        dry_run: bool,
        t_total: Instant,
        event_kind: SchedulerEventKind,
    ) -> Result<AcquireResponse, ScheduleError> {
        let mut explain = DecisionExplain::new(
            &req.request_id,
            snap.config_version(),
            &req.origin_pool_id,
            &start_pool.id,
            &req.model,
            is_downgraded,
            req.machine_id.is_some(),
            req.session_id_source.clone(),
        );
        explain.session_gate.wait_ms = gate_wait_ms;

        if dry_run && !req.is_ephemeral_probe && !req.skip_session_gate {
            let gk = ScopedSessionKey::new(&start_pool.id, req.model_family, &req.session_id);
            let (busy, depth) = self.session_gates.peek(&gk);
            explain.set_gate_peek(busy, depth);
        }

        let now = now_ms();
        let mut cur_pool = if !is_downgraded && !req.is_ephemeral_probe {
            affinity::locate_existing_session_pool(snap, start_pool, req, &self.session_sticks, now)
        } else {
            start_pool
        };

        let mut visited_pools = SmallVec::<[PoolId; 4]>::new();

        loop {
            visited_pools.push(cur_pool.id.clone());
            explain.resolved_pool_id = cur_pool.id.clone();

            // Stage 0: Hard admission filter. The node this conversation (or its
            // parent) is pinned to keeps the new-session-only gates open.
            let s_key = ScopedSessionKey::new(&cur_pool.id, req.model_family, &req.session_id);
            let continuing_node = if cur_pool.session_sticky_enabled {
                affinity::get_live_session_stick(&self.session_sticks, &s_key, now)
                    .map(|s| s.pinned_node)
                    .or_else(|| {
                        let pid = req.parent_session_id.as_deref().filter(|s| !s.is_empty())?;
                        let p_key = ScopedSessionKey::new(&cur_pool.id, req.model_family, pid);
                        affinity::get_live_session_stick(&self.session_sticks, &p_key, now)
                            .map(|s| s.pinned_node)
                    })
            } else {
                None
            };
            let (admitted, excluded) = admission::filter_members_for(
                snap,
                cur_pool,
                req,
                &self.nodes,
                now,
                continuing_node.as_ref(),
            );
            explain.excluded.extend(excluded);

            if !admitted.is_empty() {
                let mut skip_machine_stage = false;
                let mut preserve_machine_home = is_downgraded;
                let mut spill_exclude = SmallVec::<[NodeKey; 4]>::new();
                let mut machine_home_node_key: Option<NodeKey> = None;
                let mut borrow_session_pin = false;

                // Ephemeral (summary fork, seatless probe): read-only follow of the
                // session's pin, else the parent's. No stick, gate or session count.
                if req.is_ephemeral_probe && cur_pool.session_sticky_enabled {
                    let pinned =
                        affinity::get_live_session_stick(&self.session_sticks, &s_key, now)
                            .map(|s| s.pinned_node)
                            .or_else(|| {
                                let pid =
                                    req.parent_session_id.as_deref().filter(|s| !s.is_empty())?;
                                let p_key =
                                    ScopedSessionKey::new(&cur_pool.id, req.model_family, pid);
                                affinity::get_live_session_stick(&self.session_sticks, &p_key, now)
                                    .map(|s| s.pinned_node)
                            });
                    if let Some(cand) = pinned
                        .as_ref()
                        .and_then(|p| admitted.iter().find(|c| c.node_key == *p))
                    {
                        if let Some(lease) = self.try_reserve_node(
                            cand,
                            cur_pool,
                            req,
                            &s_key,
                            true,
                            true,
                            &mut gate_guard,
                            dry_run,
                        ) {
                            explain
                                .set_affinity(AffinityWhy::EphemeralFollowSession, &cand.node_key);
                            return Ok(self.finalize_acquire(
                                lease,
                                cand,
                                snap,
                                cur_pool,
                                gate_wait_ms,
                                explain,
                                dry_run,
                                t_total,
                                event_kind,
                            ));
                        }
                    }
                }

                // Stage 1: L1 session_id 1:1 stickiness
                if cur_pool.session_sticky_enabled && !req.is_ephemeral_probe {
                    if let Some(stick) =
                        affinity::get_live_session_stick(&self.session_sticks, &s_key, now)
                    {
                        if let Some(cand) =
                            admitted.iter().find(|c| c.node_key == stick.pinned_node)
                        {
                            if let Some(lease) = self.try_reserve_node(
                                cand,
                                cur_pool,
                                req,
                                &s_key,
                                stick.stood_in,
                                true,
                                &mut gate_guard,
                                dry_run,
                            ) {
                                explain.set_affinity(AffinityWhy::SessionHit, &cand.node_key);
                                if !dry_run {
                                    tier_rank::compensate_swrr_for_sticky(
                                        cur_pool,
                                        cand,
                                        &admitted,
                                        &self.swrr_states,
                                    );
                                }
                                return Ok(self.finalize_acquire(
                                    lease,
                                    cand,
                                    snap,
                                    cur_pool,
                                    gate_wait_ms,
                                    explain,
                                    dry_run,
                                    t_total,
                                    event_kind,
                                ));
                            }

                            // ★ Scenario C: bound node busy by other sessions ★
                            // Default locked to D2: `SpillImmediately` + `session_busy_wait_ms=0`!
                            let wait_ms = if req.no_queue {
                                0
                            } else {
                                cur_pool.session_busy_wait_ms
                            };
                            match cur_pool.session_overflow_policy {
                                SessionOverflowPolicy::SpillImmediately => {
                                    skip_machine_stage = true;
                                    preserve_machine_home = true;
                                    spill_exclude.push(cand.node_key.clone());
                                    explain.note(AffinityWhy::SessionSpillBusy, &cand.node_key);
                                }
                                SessionOverflowPolicy::WaitThenSpill => {
                                    if wait_ms > 0 && !dry_run {
                                        if let Some(lease) = self
                                            .wait_single_node(
                                                cand,
                                                cur_pool,
                                                req,
                                                &s_key,
                                                stick.stood_in,
                                                true,
                                                &mut gate_guard,
                                                wait_ms,
                                            )
                                            .await
                                        {
                                            explain.set_affinity(
                                                AffinityWhy::SessionHitAfterWait,
                                                &cand.node_key,
                                            );
                                            tier_rank::compensate_swrr_for_sticky(
                                                cur_pool,
                                                cand,
                                                &admitted,
                                                &self.swrr_states,
                                            );
                                            return Ok(self.finalize_acquire(
                                                lease,
                                                cand,
                                                snap,
                                                cur_pool,
                                                gate_wait_ms,
                                                explain,
                                                false,
                                                t_total,
                                                event_kind,
                                            ));
                                        }
                                    }
                                    skip_machine_stage = true;
                                    preserve_machine_home = true;
                                    spill_exclude.push(cand.node_key.clone());
                                    explain.note(AffinityWhy::SessionSpillBusy, &cand.node_key);
                                }
                                SessionOverflowPolicy::Strict => {
                                    if wait_ms > 0 && !dry_run {
                                        if let Some(lease) = self
                                            .wait_single_node(
                                                cand,
                                                cur_pool,
                                                req,
                                                &s_key,
                                                stick.stood_in,
                                                true,
                                                &mut gate_guard,
                                                wait_ms,
                                            )
                                            .await
                                        {
                                            explain.set_affinity(
                                                AffinityWhy::SessionHitAfterWait,
                                                &cand.node_key,
                                            );
                                            tier_rank::compensate_swrr_for_sticky(
                                                cur_pool,
                                                cand,
                                                &admitted,
                                                &self.swrr_states,
                                            );
                                            return Ok(self.finalize_acquire(
                                                lease,
                                                cand,
                                                snap,
                                                cur_pool,
                                                gate_wait_ms,
                                                explain,
                                                false,
                                                t_total,
                                                event_kind,
                                            ));
                                        }
                                    }
                                    explain.note(AffinityWhy::SessionSpillBusy, &cand.node_key);
                                    explain.decide_us = t_total.elapsed().as_micros() as u64;
                                    return Err(ScheduleError::SessionNodeBusy {
                                        retry_after_sec: 2,
                                        explain: Box::new(explain),
                                    });
                                }
                            }
                        } else {
                            skip_machine_stage = true;
                            preserve_machine_home = true;
                            borrow_session_pin = req.keep_pin_on_model_gate
                                && pinned_node_model_gated(req, &explain, &stick.pinned_node);
                            explain.note(AffinityWhy::SessionNodeUnavailable, &stick.pinned_node);
                        }
                    } else if let Some(parent_sid) =
                        req.parent_session_id.as_deref().filter(|s| !s.is_empty())
                    {
                        // Sub-agent follows parent session's VM when capacity & subagent limit allow.
                        let p_key =
                            ScopedSessionKey::new(&cur_pool.id, req.model_family, parent_sid);
                        if let Some(p_stick) =
                            affinity::get_live_session_stick(&self.session_sticks, &p_key, now)
                        {
                            if let Some(cand) =
                                admitted.iter().find(|c| c.node_key == p_stick.pinned_node)
                            {
                                if let Some(lease) = self.try_reserve_node(
                                    cand,
                                    cur_pool,
                                    req,
                                    &s_key,
                                    false,
                                    true,
                                    &mut gate_guard,
                                    dry_run,
                                ) {
                                    explain.set_affinity(
                                        AffinityWhy::SubagentFollowParent,
                                        &cand.node_key,
                                    );
                                    return Ok(self.finalize_acquire(
                                        lease,
                                        cand,
                                        snap,
                                        cur_pool,
                                        gate_wait_ms,
                                        explain,
                                        dry_run,
                                        t_total,
                                        event_kind,
                                    ));
                                }
                            }
                        }
                    }
                }

                // Stage 2: L2 machine_id stickiness weight 1 (only when Stage 1 did not spill).
                if !skip_machine_stage && cur_pool.machine_sticky_enabled && !req.is_ephemeral_probe
                {
                    if let Some(mid) = req.machine_id.as_deref().filter(|s| !s.is_empty()) {
                        let m_key = ScopedMachineKey::new(&cur_pool.id, req.model_family, mid);
                        if let Some(m_stick) =
                            affinity::get_live_machine_stick(&self.machine_sticks, &m_key, now)
                        {
                            explain.affinity.machine_home_node = Some(m_stick.home_node.clone());
                            machine_home_node_key = Some(m_stick.home_node.clone());
                            if let Some(home_cand) =
                                admitted.iter().find(|c| c.node_key == m_stick.home_node)
                            {
                                if let Some(lease) = self.try_reserve_node(
                                    home_cand,
                                    cur_pool,
                                    req,
                                    &s_key,
                                    false,
                                    is_downgraded,
                                    &mut gate_guard,
                                    dry_run,
                                ) {
                                    explain.set_affinity(
                                        AffinityWhy::MachineHomeHit,
                                        &home_cand.node_key,
                                    );
                                    if !dry_run {
                                        tier_rank::compensate_swrr_for_sticky(
                                            cur_pool,
                                            home_cand,
                                            &admitted,
                                            &self.swrr_states,
                                        );
                                    }
                                    return Ok(self.finalize_acquire(
                                        lease,
                                        home_cand,
                                        snap,
                                        cur_pool,
                                        gate_wait_ms,
                                        explain,
                                        dry_run,
                                        t_total,
                                        event_kind,
                                    ));
                                }
                                // ★ Scenario B: home VM full -> zero-wait, zero-cooldown immediate spill!
                                //   Original `machine_id -> home_node` binding stays untouched.
                                preserve_machine_home = true;
                                spill_exclude.push(home_cand.node_key.clone());
                                explain.note(
                                    AffinityWhy::MachineHomeCapacitySpill,
                                    &home_cand.node_key,
                                );
                            } else {
                                explain
                                    .note(AffinityWhy::MachineHomeUnavailable, &m_stick.home_node);
                            }
                        }
                    }
                }

                // Stage 3: Strict weight_tier ranking + 85% soft quota sub-buckets + prefix SWRR
                let eligible: Vec<&AdmittedCandidate<'_>> = admitted
                    .iter()
                    .filter(|c| !spill_exclude.contains(&c.node_key))
                    .collect();
                let ranked = tier_rank::rank_candidates(
                    cur_pool,
                    &eligible,
                    &self.swrr_states,
                    &mut explain,
                );

                for cand in &ranked {
                    if let Some(mut lease) = self.try_reserve_node(
                        cand,
                        cur_pool,
                        req,
                        &s_key,
                        preserve_machine_home,
                        preserve_machine_home,
                        &mut gate_guard,
                        dry_run,
                    ) {
                        if borrow_session_pin {
                            self.mark_session_pin_borrowed(&mut lease, dry_run);
                        }
                        let why = if cand.is_probe_one {
                            AffinityWhy::ProbeOne
                        } else if !spill_exclude.is_empty() && machine_home_node_key.is_some() {
                            AffinityWhy::MachineHomeCapacitySpill
                        } else if !spill_exclude.is_empty() {
                            AffinityWhy::SessionSpillBusy
                        } else {
                            AffinityWhy::TierRanked
                        };
                        explain.set_affinity(why, &cand.node_key);
                        if !dry_run {
                            tier_rank::commit_swrr_pick(
                                cur_pool,
                                cand,
                                &admitted,
                                &self.swrr_states,
                            );
                        }
                        return Ok(self.finalize_acquire(
                            lease,
                            cand,
                            snap,
                            cur_pool,
                            gate_wait_ms,
                            explain,
                            dry_run,
                            t_total,
                            event_kind,
                        ));
                    }
                }

                // All healthy nodes in this pool are full -> bounded work-stealing wait.
                // Re-include `spill_exclude` so single-node pools or early home-node releases work!
                if !dry_run && !req.no_queue && cur_pool.queue_wait_ms > 0 {
                    let wait_candidates: Vec<&AdmittedCandidate<'_>> = if spill_exclude.is_empty() {
                        ranked
                    } else {
                        let all_refs: Vec<&AdmittedCandidate<'_>> = admitted.iter().collect();
                        tier_rank::rank_candidates(
                            cur_pool,
                            &all_refs,
                            &self.swrr_states,
                            &mut explain,
                        )
                    };

                    if let Some((mut lease, cand)) = self
                        .wait_any_ready_node(
                            cur_pool,
                            &wait_candidates,
                            req,
                            &s_key,
                            preserve_machine_home,
                            machine_home_node_key.as_ref(),
                            &mut gate_guard,
                            &explain,
                        )
                        .await?
                    {
                        if borrow_session_pin {
                            self.mark_session_pin_borrowed(&mut lease, false);
                        }
                        explain.set_affinity(AffinityWhy::PoolFullQueueWake, &cand.node_key);
                        tier_rank::commit_swrr_pick(cur_pool, cand, &admitted, &self.swrr_states);
                        return Ok(self.finalize_acquire(
                            lease,
                            cand,
                            snap,
                            cur_pool,
                            gate_wait_ms,
                            explain,
                            false,
                            t_total,
                            event_kind,
                        ));
                    }
                }
            }

            // Stage 4: Pool-level ordered fallback chain (max depth 3, cycle-safe, auth + prompt guard)
            match cur_pool.fallback_pool_id.as_ref() {
                Some(next_id)
                    if !is_downgraded
                        && visited_pools.len() < 3
                        && !visited_pools.contains(next_id) =>
                {
                    if let Ok(next_pool) = snap.resolve_authorized_pool(next_id, &req.api_key_scope)
                    {
                        if snap.fallback_prompt_allowed(cur_pool, next_pool) {
                            explain.record_fallback(&next_pool.id);
                            cur_pool = next_pool;
                            continue;
                        }
                        explain.excluded.push(scheduler_proto::ExcludedEntry {
                            pool_id: next_pool.id.clone(),
                            node: CompactString::from(format!("pool:{}", next_pool.id)),
                            reason: scheduler_proto::ExcludeReason::CrossPromptFallbackBlocked,
                            detail: "cross-prompt fallback disabled".to_owned(),
                        });
                    }
                    explain.decide_us = t_total.elapsed().as_micros() as u64;
                    return Err(ScheduleError::PoolExhausted {
                        explain: Box::new(explain),
                    });
                }
                _ => {
                    explain.decide_us = t_total.elapsed().as_micros() as u64;
                    return Err(ScheduleError::PoolExhausted {
                        explain: Box::new(explain),
                    });
                }
            }
        }
    }

    fn mark_session_pin_borrowed(&self, lease: &mut ActiveLease, dry_run: bool) {
        lease.keep_session_pin = true;
        if !dry_run {
            if let Some(mut entry) = self.leases.get_mut(&lease.lease_id) {
                entry.keep_session_pin = true;
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn try_reserve_node(
        &self,
        cand: &AdmittedCandidate<'_>,
        pool: &PoolConfig,
        req: &AcquireRequest,
        session_key: &ScopedSessionKey,
        stood_in: bool,
        preserve_machine_home: bool,
        gate_guard: &mut Option<GateHoldGuard>,
        dry_run: bool,
    ) -> Option<ActiveLease> {
        let now = now_ms();
        let rt = self.ensure_node_state(&cand.node_key);
        let cap = &cand.node_cfg.capacity;
        let parent_key = req
            .parent_session_id
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(|pid| ScopedSessionKey::new(&pool.id, req.model_family, pid));

        {
            let mut st = rt.inner.lock();

            // Re-check health/probe invariants atomically inside the NodeMutable lock
            if st.permanent_unschedulable || !st.schedulable || !st.active_hours_ok {
                return None;
            }
            if cand.is_probe_one {
                if st.probe_in_flight {
                    return None;
                }
            } else if st.node_cooldown_until_ms > now
                || st
                    .model_cooldowns
                    .get(&req.model)
                    .is_some_and(|mc| mc.until_ms > now)
            {
                return None;
            }

            // Concurrency limit
            if cap.max_concurrency == 0 || st.effective_in_flight() >= cap.max_concurrency {
                return None;
            }

            // Non-ephemeral session, primary-session, subagent, and RPM checks
            if !req.is_ephemeral_probe {
                if cap.max_sessions > 0 {
                    let already_active = st.active_sessions.contains_key(session_key);
                    if !already_active && (st.active_sessions.len() as u32) >= cap.max_sessions {
                        return None;
                    }
                }

                if parent_key.is_none() {
                    if let Some(max_primary) = cap.max_primary_sessions {
                        let already_active = st.active_primary_sessions.contains_key(session_key);
                        if !already_active
                            && (st.active_primary_sessions.len() as u32) >= max_primary
                        {
                            return None;
                        }
                    }
                } else if let (Some(max_sub), Some(pk)) =
                    (cap.max_subagents_per_session, parent_key.as_ref())
                {
                    let cur_subs = st.active_subagents.get(pk).copied().unwrap_or(0);
                    if cur_subs >= max_sub {
                        return None;
                    }
                }

                if let Some(max_rpm) = cap.max_rpm {
                    st.prune_rpm(now);
                    if (st.rpm_ring.len() as u32) >= max_rpm {
                        return None;
                    }
                }
            }

            if !dry_run {
                st.in_flight = st.in_flight.saturating_add(1);
                if cand.is_probe_one {
                    st.probe_in_flight = true;
                }
                if !req.is_ephemeral_probe {
                    *st.active_sessions.entry(session_key.clone()).or_insert(0) += 1;
                    if let Some(pk) = parent_key.as_ref() {
                        *st.active_subagents.entry(pk.clone()).or_insert(0) += 1;
                    } else {
                        *st.active_primary_sessions
                            .entry(session_key.clone())
                            .or_insert(0) += 1;
                    }
                    st.rpm_ring.push_back(now);
                }
            }
        } // NodeMutable lock released here!

        let lease_id = if dry_run {
            CompactString::const_new("dry_run")
        } else {
            self.next_lease_id()
        };

        let gate_hold = if dry_run {
            None
        } else {
            gate_guard.take().map(GateHoldGuard::disarm_into_parts)
        };

        let lease = ActiveLease {
            lease_id: lease_id.clone(),
            request_id: req.request_id.clone(),
            attempt_no: req.attempt_no,
            controller_epoch: if req.controller_epoch.is_empty() {
                self.events.current_epoch()
            } else {
                req.controller_epoch.clone()
            },
            origin_pool_id: req.origin_pool_id.clone(),
            resolved_pool_id: pool.id.clone(),
            model: req.model.clone(),
            model_family: req.model_family,
            provider: cand.provider,
            node_key: cand.node_key.clone(),
            node_type: cand.node_type,
            node_id: cand.node_id.clone(),
            session_key: session_key.clone(),
            parent_session_key: parent_key,
            machine_id: req.machine_id.clone(),
            is_ephemeral_probe: req.is_ephemeral_probe,
            is_probe_one: cand.is_probe_one,
            stood_in,
            preserve_machine_home,
            keep_session_pin: false,
            committed: false,
            strict_session_overflow: pool.session_overflow_policy == SessionOverflowPolicy::Strict,
            gate_hold,
            created_at_ms: now,
            expires_at_ms: now.saturating_add(self.opts.lease_ttl_ms),
        };

        if !dry_run {
            self.leases.insert(lease_id, lease.clone());
        }

        Some(lease)
    }

    #[allow(clippy::too_many_arguments)]
    async fn wait_single_node(
        &self,
        cand: &AdmittedCandidate<'_>,
        pool: &PoolConfig,
        req: &AcquireRequest,
        session_key: &ScopedSessionKey,
        stood_in: bool,
        preserve_machine_home: bool,
        gate_guard: &mut Option<GateHoldGuard>,
        wait_ms: u64,
    ) -> Option<ActiveLease> {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(wait_ms);
        loop {
            let notified = self.slot_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            if let Some(lease) = self.try_reserve_node(
                cand,
                pool,
                req,
                session_key,
                stood_in,
                preserve_machine_home,
                gate_guard,
                false,
            ) {
                return Some(lease);
            }

            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return None;
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn wait_any_ready_node<'a, 'b>(
        &self,
        pool: &PoolConfig,
        candidates: &[&'a AdmittedCandidate<'b>],
        req: &AcquireRequest,
        session_key: &ScopedSessionKey,
        preserve_machine_home: bool,
        machine_home_key: Option<&NodeKey>,
        gate_guard: &mut Option<GateHoldGuard>,
        explain: &DecisionExplain,
    ) -> Result<Option<(ActiveLease, &'a AdmittedCandidate<'b>)>, ScheduleError> {
        let Some(_queue_guard) =
            PoolQueueGuard::try_enter(&self.pool_queues, &pool.id, pool.queue_max)
        else {
            return Err(ScheduleError::PoolQueueFull {
                explain: Box::new(explain.clone()),
            });
        };

        let deadline = tokio::time::Instant::now() + Duration::from_millis(pool.queue_wait_ms);
        loop {
            let notified = self.slot_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            for &cand in candidates {
                let is_original_home = machine_home_key.is_some_and(|hk| *hk == cand.node_key);
                let preserve = if is_original_home {
                    false
                } else {
                    preserve_machine_home
                };
                if let Some(lease) = self.try_reserve_node(
                    cand,
                    pool,
                    req,
                    session_key,
                    preserve,
                    preserve,
                    gate_guard,
                    false,
                ) {
                    return Ok(Some((lease, cand)));
                }
            }

            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return Ok(None);
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn finalize_acquire(
        &self,
        lease: ActiveLease,
        cand: &AdmittedCandidate<'_>,
        snap: &IndexedSnapshot,
        pool: &PoolConfig,
        gate_wait_ms: u64,
        mut explain: DecisionExplain,
        dry_run: bool,
        t_total: Instant,
        event_kind: SchedulerEventKind,
    ) -> AcquireResponse {
        let prompt_policy = snap.resolve_prompt_policy(pool, cand.node_cfg);
        explain.resolved_pool_id = pool.id.clone();
        explain.prompt_policy = prompt_policy.clone();
        explain.affinity.selected_node = Some(cand.node_key.clone());
        explain.affinity.stood_in = lease.stood_in;
        explain.affinity.preserve_machine_home = lease.preserve_machine_home;
        explain.decide_us = t_total.elapsed().as_micros() as u64;

        let resp = AcquireResponse {
            lease_id: lease.lease_id.clone(),
            lease_ttl_ms: self.opts.lease_ttl_ms,
            selected_node: SelectedNodeInfo {
                node_key: cand.node_key.clone(),
                node_type: cand.node_type,
                node_id: cand.node_id.clone(),
                provider: cand.provider,
                effective_weight_tier: cand.effective_weight_tier,
                sub_weight: cand.sub_weight,
            },
            resolved_pool_id: pool.id.clone(),
            prompt_policy,
            stood_in: lease.stood_in,
            preserve_machine_home: lease.preserve_machine_home,
            session_gate_wait_ms: gate_wait_ms,
            explain,
        };

        if !dry_run {
            let now = now_ms();
            self.idempotency.insert(
                (lease.request_id.clone(), lease.attempt_no),
                CachedLeaseReply {
                    response: resp.clone(),
                    expires_at_ms: now.saturating_add(IDEMPOTENCY_TTL_MS),
                },
            );
            self.events.emit(
                event_kind,
                Some(pool.id.clone()),
                Some(cand.node_key.clone()),
                Some(lease.request_id.clone()),
                Some(format!(
                    "lease_id={},attempt={},stood_in={}",
                    lease.lease_id, lease.attempt_no, lease.stood_in
                )),
            );
        }

        resp
    }

    /// `/internal/v1/schedule/heartbeat`: Batch lease TTL renewal (also keeps associated
    /// SessionGate alive by preventing lease expiration).
    pub fn heartbeat(&self, req: HeartbeatRequest) -> HeartbeatResponse {
        let now = now_ms();
        let new_exp = now.saturating_add(self.opts.lease_ttl_ms);
        let mut renewed = 0usize;
        let mut missing = Vec::new();

        for lid in req.lease_ids {
            if let Some(mut lease) = self.leases.get_mut(&lid) {
                if req.controller_epoch.is_empty() || lease.controller_epoch == req.controller_epoch
                {
                    lease.expires_at_ms = new_exp;
                    renewed += 1;
                } else {
                    missing.push(lid);
                }
            } else {
                missing.push(lid);
            }
        }

        HeartbeatResponse {
            ok: true,
            renewed,
            missing,
        }
    }

    /// `/internal/v1/schedule/commit`: Idempotent first-byte / success commit writing sticky
    /// bindings (honoring `preserve_machine_home` and `!stood_in`) and clearing Sink/failures.
    pub fn commit(&self, req: CommitRequest) -> CommitResponse {
        let now = now_ms();
        let (lease_snapshot, already_committed) = match self.leases.get_mut(&req.lease_id) {
            Some(mut entry) => {
                let already = entry.committed;
                entry.committed = true;
                (entry.clone(), already)
            }
            None => {
                return CommitResponse {
                    ok: true,
                    committed: false,
                    already_committed: false,
                    lease_found: false,
                };
            }
        };

        if already_committed {
            return CommitResponse {
                ok: true,
                committed: true,
                already_committed: true,
                lease_found: true,
            };
        }

        // Clear node Sink, consecutive failures, and cooldown on confirmed success.
        if let Some(rt) = self.nodes.get(&lease_snapshot.node_key) {
            let mut st = rt.inner.lock();
            st.sink_seq = 0;
            st.consecutive_failures = 0;
            if lease_snapshot.is_probe_one {
                st.node_cooldown_until_ms = 0;
                st.node_cooldown_reason = None;
                st.node_cooldown_step = 0;
                st.model_cooldowns.remove(&lease_snapshot.model);
            }
        }
        health::mark_provider_healthy(&self.provider_last_healthy, lease_snapshot.provider, now);

        if !lease_snapshot.is_ephemeral_probe {
            let snap = self.config.load();
            let (sess_enabled, sess_ttl_ms, mach_enabled, mach_ttl_ms) = snap
                .get_pool(&lease_snapshot.resolved_pool_id)
                .map(|p| {
                    (
                        p.session_sticky_enabled,
                        p.session_ttl_seconds.saturating_mul(1000),
                        p.machine_sticky_enabled,
                        p.machine_ttl_seconds.saturating_mul(1000),
                    )
                })
                .unwrap_or((true, 86_400_000, true, 604_800_000));

            // L1 session_sticks write
            if sess_enabled {
                let s_key = lease_snapshot.session_key.clone();
                let dto = {
                    let mut entry =
                        self.session_sticks
                            .entry(s_key.clone())
                            .or_insert_with(|| SessionStick {
                                pinned_node: lease_snapshot.node_key.clone(),
                                node_type: lease_snapshot.node_type,
                                node_id: lease_snapshot.node_id.clone(),
                                machine_id: lease_snapshot.machine_id.clone(),
                                stood_in: lease_snapshot.stood_in,
                                bound_at_ms: now,
                                last_seen_ms: now,
                                expires_at_ms: now.saturating_add(sess_ttl_ms),
                                hits: 0,
                                generation: 1,
                            });
                    if entry.pinned_node != lease_snapshot.node_key
                        && !lease_snapshot.keep_session_pin
                    {
                        entry.pinned_node = lease_snapshot.node_key.clone();
                        entry.node_type = lease_snapshot.node_type;
                        entry.node_id = lease_snapshot.node_id.clone();
                        entry.generation = entry.generation.saturating_add(1);
                    }
                    if !lease_snapshot.keep_session_pin {
                        entry.machine_id = lease_snapshot.machine_id.clone();
                        entry.stood_in = lease_snapshot.stood_in;
                    }
                    entry.last_seen_ms = now;
                    entry.expires_at_ms = now.saturating_add(sess_ttl_ms);
                    entry.hits = entry.hits.saturating_add(1);
                    entry.to_dto(&s_key)
                };
                self.delta_ring.record_sticky_upsert(dto);
            }

            // L2 machine_sticks write ONLY when `!preserve_machine_home && !stood_in`!
            if mach_enabled && !lease_snapshot.preserve_machine_home && !lease_snapshot.stood_in {
                if let Some(mid) = lease_snapshot
                    .machine_id
                    .as_deref()
                    .filter(|s| !s.is_empty())
                {
                    let m_key = ScopedMachineKey::new(
                        &lease_snapshot.resolved_pool_id,
                        lease_snapshot.model_family,
                        mid,
                    );
                    let dto = {
                        let mut entry =
                            self.machine_sticks.entry(m_key.clone()).or_insert_with(|| {
                                MachineStick {
                                    home_node: lease_snapshot.node_key.clone(),
                                    node_type: lease_snapshot.node_type,
                                    node_id: lease_snapshot.node_id.clone(),
                                    bound_at_ms: now,
                                    last_seen_ms: now,
                                    expires_at_ms: now.saturating_add(mach_ttl_ms),
                                    hits: 0,
                                    generation: 1,
                                }
                            });
                        if entry.home_node != lease_snapshot.node_key {
                            entry.home_node = lease_snapshot.node_key.clone();
                            entry.node_type = lease_snapshot.node_type;
                            entry.node_id = lease_snapshot.node_id.clone();
                            entry.generation = entry.generation.saturating_add(1);
                        }
                        entry.last_seen_ms = now;
                        entry.expires_at_ms = now.saturating_add(mach_ttl_ms);
                        entry.hits = entry.hits.saturating_add(1);
                        entry.to_dto(&m_key)
                    };
                    self.delta_ring.record_sticky_upsert(dto);
                }
            }
        }

        self.events.emit(
            SchedulerEventKind::LeaseCommitted,
            Some(lease_snapshot.resolved_pool_id),
            Some(lease_snapshot.node_key),
            Some(lease_snapshot.request_id),
            Some(format!("lease_id={}", lease_snapshot.lease_id)),
        );

        CommitResponse {
            ok: true,
            committed: true,
            already_committed: false,
            lease_found: true,
        }
    }

    /// `/internal/v1/schedule/release`: Idempotent final release of VM slot + SessionGate.
    pub fn release(&self, req: ReleaseRequest) -> ReleaseResponse {
        let failure = if req.outcome != ReleaseOutcome::Ok
            && (req.http_status.is_some()
                || req.error_class.is_some()
                || req.error_signature.is_some()
                || req.error_message.is_some()
                || req.quota_headers.is_some())
        {
            Some(FailureReport {
                http_status: req.http_status.unwrap_or(0),
                error_class: req.error_class.unwrap_or_default(),
                error_signature: req.error_signature,
                error_message: req.error_message,
                retry_after_sec: req.retry_after_sec,
                quota_headers: req.quota_headers,
            })
        } else {
            if let Some(qh) = req.quota_headers {
                if let Some(lease) = self.leases.get(&req.lease_id) {
                    if let Some(rt) = self.nodes.get(&lease.node_key) {
                        health::apply_quota_headers(&rt, &qh);
                    }
                }
            }
            None
        };

        let released = self.release_lease_internal(&req.lease_id, req.outcome, failure.as_ref());
        ReleaseResponse { ok: true, released }
    }

    /// Release ONLY the node concurrency/session slot while extracting the immutable
    /// `(gate_key, gate_token)` back into a live `GateHoldGuard` for `/schedule/switch`.
    fn release_node_slot_keeping_gate(
        &self,
        lease_id: &str,
    ) -> Result<(ActiveLease, Option<GateHoldGuard>), ScheduleError> {
        let Some((_, lease)) = self.leases.remove(lease_id) else {
            return Err(ScheduleError::LeaseNotFound(format!(
                "lease '{lease_id}' not found"
            )));
        };

        // Release node slot (NodeMutable lock only, never nested with SessionGate!)
        self.decrement_node_slot(&lease);
        self.slot_notify.notify_waiters();

        // Re-arm the EXACT immutable `(gate_key, gate_token)` WITHOUT releasing the gate!
        let gate_guard = lease
            .gate_hold
            .clone()
            .map(|(gk, tok)| self.session_gates.rearm_guard(gk, tok));

        Ok((lease, gate_guard))
    }

    /// Unified single exit point for normal release, abort, timeout reap, and epoch orphan reap.
    ///
    /// Strict lock sequence (never nested!):
    /// 1. Lock `NodeMutable` -> decrement `in_flight` & `active_sessions` -> unlock -> `slot_notify.notify_waiters()`.
    /// 2. Lock `session_gates.entry(gate_key)` -> direct FIFO handoff or `occ.remove()` -> unlock.
    /// 3. Error attribution / stale sticky cleanup.
    fn release_lease_internal(
        &self,
        lease_id: &str,
        outcome: ReleaseOutcome,
        failure: Option<&FailureReport>,
    ) -> bool {
        let Some((_, lease)) = self.leases.remove(lease_id) else {
            return false;
        };

        // Step 1: Release VM slot + wake waiters (NodeMutable lock ONLY)
        self.decrement_node_slot(&lease);
        self.slot_notify.notify_waiters();

        // Step 2: Release immutable SessionGate + FIFO handoff (session_gates shard lock ONLY)
        if let Some((gate_key, gate_token)) = &lease.gate_hold {
            self.session_gates.release(gate_key, *gate_token);
        }

        // Step 3: Post-release health / sticky attribution
        let now = now_ms();
        if outcome == ReleaseOutcome::Ok {
            if let Some(rt) = self.nodes.get(&lease.node_key) {
                let mut st = rt.inner.lock();
                st.consecutive_failures = 0;
                st.sink_seq = 0;
                if lease.is_probe_one {
                    st.node_cooldown_until_ms = 0;
                    st.node_cooldown_reason = None;
                    st.node_cooldown_step = 0;
                    st.model_cooldowns.remove(&lease.model);
                }
            }
            health::mark_provider_healthy(&self.provider_last_healthy, lease.provider, now);
        } else {
            // Unbind the session stick only on a node-side hard failure before first byte.
            // Client aborts, timeouts, orphan reaps and request-side faults keep the 1:1 binding.
            let node_fault = outcome == ReleaseOutcome::Error
                && failure.is_some_and(|f| {
                    !health::is_request_fault(health::infer_error_class(f), f.http_status)
                });
            if node_fault
                && !lease.committed
                && !lease.strict_session_overflow
                && !lease.is_ephemeral_probe
            {
                // Hard failure before first-byte commit: unbind stale session binding to this node.
                let removed = self
                    .session_sticks
                    .remove_if(&lease.session_key, |_, v| v.pinned_node == lease.node_key)
                    .is_some();
                if removed {
                    self.delta_ring.record_sticky_delete(StickyDeleteKeyDto {
                        scope_kind: StickyScopeKind::Session,
                        pool_id: lease.session_key.pool_id.clone(),
                        model_family: lease.session_key.model_family,
                        identity_id: lease.session_key.session_id.clone(),
                    });
                }
            }
            if let Some(f) = failure {
                health::apply_failure(
                    &lease,
                    f,
                    &self.nodes,
                    &self.poison_tracker,
                    &self.provider_last_healthy,
                    &self.sink_seq,
                    &self.delta_ring,
                    &self.events,
                    now,
                );
            }
        }

        let ev_kind = if outcome == ReleaseOutcome::Timeout {
            SchedulerEventKind::LeaseExpired
        } else {
            SchedulerEventKind::LeaseReleased
        };
        self.events.emit(
            ev_kind,
            Some(lease.resolved_pool_id),
            Some(lease.node_key),
            Some(lease.request_id),
            Some(format!("lease_id={lease_id},outcome={outcome:?}")),
        );

        true
    }

    fn decrement_node_slot(&self, lease: &ActiveLease) {
        if let Some(rt) = self.nodes.get(&lease.node_key) {
            let mut st = rt.inner.lock();
            st.in_flight = st.in_flight.saturating_sub(1);
            if lease.is_probe_one {
                st.probe_in_flight = false;
            }
            if !lease.is_ephemeral_probe {
                if let Some(cnt) = st.active_sessions.get_mut(&lease.session_key) {
                    if *cnt <= 1 {
                        st.active_sessions.remove(&lease.session_key);
                    } else {
                        *cnt -= 1;
                    }
                }
                if let Some(pk) = lease.parent_session_key.as_ref() {
                    if let Some(cnt) = st.active_subagents.get_mut(pk) {
                        if *cnt <= 1 {
                            st.active_subagents.remove(pk);
                        } else {
                            *cnt -= 1;
                        }
                    }
                } else if let Some(cnt) = st.active_primary_sessions.get_mut(&lease.session_key) {
                    if *cnt <= 1 {
                        st.active_primary_sessions.remove(&lease.session_key);
                    } else {
                        *cnt -= 1;
                    }
                }
            }
        }
    }

    /// `/internal/v1/persistence/drain`: Leader-only dirty delta pull + ACK.
    pub fn drain_persistence(&self, req: DrainRequest) -> Result<DrainResponse, ScheduleError> {
        if *self.role.lock() == Role::Standby {
            return Err(ScheduleError::StandbyDrainForbidden);
        }
        Ok(self
            .delta_ring
            .drain(req.max_items, req.ack_batch_id, req.ack_only))
    }

    /// `GET /internal/v1/sticky`
    pub fn query_sticky(&self, q: &StickyQuery) -> StickyListResponse {
        let now = now_ms();
        let mut out: Vec<StickyBindingDto> = Vec::new();
        let limit = q.limit.unwrap_or(500);

        let want_session = q.scope_kind.is_none() || q.scope_kind == Some(StickyScopeKind::Session);
        let want_machine = q.scope_kind.is_none() || q.scope_kind == Some(StickyScopeKind::Machine);

        if want_session {
            for entry in self.session_sticks.iter() {
                if out.len() >= limit {
                    break;
                }
                let (k, v) = (entry.key(), entry.value());
                if now > v.expires_at_ms {
                    continue;
                }
                if q.pool_id.as_ref().is_some_and(|p| *p != k.pool_id) {
                    continue;
                }
                if q.model_family.is_some_and(|mf| mf != k.model_family) {
                    continue;
                }
                if q.session_id.as_ref().is_some_and(|s| *s != k.session_id) {
                    continue;
                }
                if q.machine_id
                    .as_ref()
                    .is_some_and(|m| v.machine_id.as_ref() != Some(m))
                {
                    continue;
                }
                if q.node_key.as_ref().is_some_and(|n| *n != v.pinned_node) {
                    continue;
                }
                out.push(v.to_dto(k));
            }
        }

        if want_machine {
            for entry in self.machine_sticks.iter() {
                if out.len() >= limit {
                    break;
                }
                let (k, v) = (entry.key(), entry.value());
                if now > v.expires_at_ms {
                    continue;
                }
                if q.pool_id.as_ref().is_some_and(|p| *p != k.pool_id) {
                    continue;
                }
                if q.model_family.is_some_and(|mf| mf != k.model_family) {
                    continue;
                }
                if q.machine_id.as_ref().is_some_and(|m| *m != k.machine_id) {
                    continue;
                }
                if q.session_id.is_some() {
                    continue;
                }
                if q.node_key.as_ref().is_some_and(|n| *n != v.home_node) {
                    continue;
                }
                out.push(v.to_dto(k));
            }
        }

        let total = out.len();
        StickyListResponse {
            ok: true,
            bindings: out,
            total,
        }
    }

    /// `DELETE /internal/v1/sticky`
    pub fn delete_sticky(&self, q: &StickyQuery) -> StickyDeleteResponse {
        let mut deleted = 0usize;

        let want_session = q.scope_kind.is_none() || q.scope_kind == Some(StickyScopeKind::Session);
        let want_machine = q.scope_kind.is_none() || q.scope_kind == Some(StickyScopeKind::Machine);

        if want_session {
            let keys: Vec<ScopedSessionKey> = self
                .session_sticks
                .iter()
                .filter(|e| {
                    let (k, v) = (e.key(), e.value());
                    q.pool_id.as_ref().is_none_or(|p| *p == k.pool_id)
                        && q.model_family.is_none_or(|mf| mf == k.model_family)
                        && q.session_id.as_ref().is_none_or(|s| *s == k.session_id)
                        && q.machine_id
                            .as_ref()
                            .is_none_or(|m| v.machine_id.as_ref() == Some(m))
                        && q.node_key.as_ref().is_none_or(|n| *n == v.pinned_node)
                })
                .map(|e| e.key().clone())
                .collect();

            for k in keys {
                if self.session_sticks.remove(&k).is_some() {
                    deleted += 1;
                    self.delta_ring.record_sticky_delete(StickyDeleteKeyDto {
                        scope_kind: StickyScopeKind::Session,
                        pool_id: k.pool_id,
                        model_family: k.model_family,
                        identity_id: k.session_id,
                    });
                }
            }
        }

        if want_machine && q.session_id.is_none() {
            let keys: Vec<ScopedMachineKey> = self
                .machine_sticks
                .iter()
                .filter(|e| {
                    let (k, v) = (e.key(), e.value());
                    q.pool_id.as_ref().is_none_or(|p| *p == k.pool_id)
                        && q.model_family.is_none_or(|mf| mf == k.model_family)
                        && q.machine_id.as_ref().is_none_or(|m| *m == k.machine_id)
                        && q.node_key.as_ref().is_none_or(|n| *n == v.home_node)
                })
                .map(|e| e.key().clone())
                .collect();

            for k in keys {
                if self.machine_sticks.remove(&k).is_some() {
                    deleted += 1;
                    self.delta_ring.record_sticky_delete(StickyDeleteKeyDto {
                        scope_kind: StickyScopeKind::Machine,
                        pool_id: k.pool_id,
                        model_family: k.model_family,
                        identity_id: k.machine_id,
                    });
                }
            }
        }

        StickyDeleteResponse { ok: true, deleted }
    }

    /// `POST /internal/v1/admin/unrest`
    pub fn unrest(&self, req: UnrestRequest) -> UnrestResponse {
        health::unrest_node(
            &self.nodes,
            &self.delta_ring,
            &self.slot_notify,
            &self.events,
            &req.node_key,
            req.model_scope.as_deref(),
        )
    }

    /// `GET /internal/v1/events?after=<epoch:seq>`
    pub fn subscribe_events(
        &self,
        after: Option<&str>,
    ) -> Result<(Vec<SchedulerEvent>, broadcast::Receiver<SchedulerEvent>), ScheduleError> {
        self.events.subscribe(after)
    }

    /// Background 5s reaper: expires overdue leases (simultaneously releasing node slots +
    /// SessionGates!), purges stale 60s idempotency entries, 120s poison windows, and expired sticks.
    pub fn reap_expired(&self) -> usize {
        let now = now_ms();

        // 1. Reap expired leases + linked SessionGates
        let expired_lease_ids: Vec<LeaseId> = self
            .leases
            .iter()
            .filter(|e| now >= e.value().expires_at_ms)
            .map(|e| e.key().clone())
            .collect();

        let mut reaped = 0usize;
        for lid in expired_lease_ids {
            if self.release_lease_internal(&lid, ReleaseOutcome::Timeout, None) {
                reaped += 1;
                self.expired_leases_total.fetch_add(1, Ordering::Relaxed);
            }
        }

        // 2. Purge expired idempotency replies (60s TTL)
        self.idempotency.retain(|_, v| now <= v.expires_at_ms);

        // 3. Purge expired poison windows (120s TTL)
        self.poison_tracker.retain(|_, v| now <= v.expires_at_ms);

        // 4. Purge expired sticky bindings
        self.session_sticks.retain(|_, v| now <= v.expires_at_ms);
        self.machine_sticks.retain(|_, v| now <= v.expires_at_ms);

        reaped
    }

    /// Helper for tests & observability to inspect current in-flight count on a node.
    pub fn node_inflight(&self, node_key: &str) -> u32 {
        self.nodes
            .get(node_key)
            .map(|rt| rt.inner.lock().in_flight)
            .unwrap_or(0)
    }

    /// Helper for tests & observability to inspect current active sessions on a node.
    pub fn node_active_sessions(&self, node_key: &str) -> usize {
        self.nodes
            .get(node_key)
            .map(|rt| rt.inner.lock().active_sessions.len())
            .unwrap_or(0)
    }

    /// Helper for tests to inspect whether a node is currently in cooldown or sunk.
    pub fn node_health_snapshot(&self, node_key: &str) -> (u64, u64, bool, u32) {
        self.nodes
            .get(node_key)
            .map(|rt| {
                let st = rt.inner.lock();
                (
                    st.node_cooldown_until_ms,
                    st.sink_seq,
                    st.permanent_unschedulable,
                    st.consecutive_failures,
                )
            })
            .unwrap_or((0, 0, false, 0))
    }

    /// Helper for tests to check poison tracker entry count.
    pub fn poison_tracker_len(&self) -> usize {
        self.poison_tracker.len()
    }
}

/// The session's pinned node was excluded only because it cannot serve this
/// model: either the caller reported it as model-gated, or Rust admission
/// dropped it for a model reason (and for nothing else).
fn pinned_node_model_gated(
    req: &AcquireRequest,
    explain: &DecisionExplain,
    pinned: &NodeKey,
) -> bool {
    if req.model_gated_node_keys.iter().any(|k| k == pinned) {
        return true;
    }
    let mut any = false;
    for e in explain.excluded.iter().filter(|e| e.node == *pinned) {
        match e.reason {
            scheduler_proto::ExcludeReason::ModelCooldown
            | scheduler_proto::ExcludeReason::ModelUnsupported => any = true,
            _ => return false,
        }
    }
    any
}
