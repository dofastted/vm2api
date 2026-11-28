use compact_str::CompactString;
use parking_lot::Mutex;
use scheduler_proto::{
    BackendNodeConfig, NodeCapacityConfig, NodeTelemetryUpdate, ScopedSessionKey,
};
use std::collections::{BTreeMap, HashMap, VecDeque};

#[derive(Clone, Debug)]
pub struct ModelCooldownEntry {
    pub until_ms: u64,
    pub reason: CompactString,
    pub ladder_step: u32,
}

#[derive(Clone, Debug)]
pub struct NodeMutable {
    // Telemetry state (updated in-place via /nodes/telemetry without ArcSwap rebuild)
    pub schedulable: bool,
    pub unschedulable_reason: Option<CompactString>,
    pub active_hours_ok: bool,
    pub quota_util_5h_pct: f32,
    pub quota_util_7d_pct: f32,
    pub host_memory_pressure: bool,
    pub proxy_ready: bool,
    pub crag_license_ok: bool,
    pub temp_unschedulable_until_ms: Option<u64>,
    pub temp_unschedulable_reason: Option<CompactString>,
    /// Set after any telemetry update to `temp_unschedulable_until_ms` (park, clear, or `0`).
    pub temp_park_live_authoritative: bool,
    pub external_in_flight: u32,
    pub runtime_capabilities: BTreeMap<String, bool>,

    // Live capacity / concurrency state
    pub in_flight: u32,
    pub active_sessions: HashMap<ScopedSessionKey, u32>,
    pub active_primary_sessions: HashMap<ScopedSessionKey, u32>,
    pub active_subagents: HashMap<ScopedSessionKey, u32>,
    pub rpm_ring: VecDeque<u64>,

    // Health / cooldown / sink state
    pub sink_seq: u64,
    pub permanent_unschedulable: bool,
    pub permanent_reason: Option<CompactString>,
    pub node_cooldown_until_ms: u64,
    pub node_cooldown_reason: Option<CompactString>,
    pub node_cooldown_step: u32,
    pub consecutive_failures: u32,
    pub model_cooldowns: HashMap<CompactString, ModelCooldownEntry>,
    pub probe_in_flight: bool,
}

impl Default for NodeMutable {
    fn default() -> Self {
        Self {
            schedulable: true,
            unschedulable_reason: None,
            active_hours_ok: true,
            quota_util_5h_pct: 0.0,
            quota_util_7d_pct: 0.0,
            host_memory_pressure: false,
            proxy_ready: true,
            crag_license_ok: true,
            temp_unschedulable_until_ms: None,
            temp_unschedulable_reason: None,
            temp_park_live_authoritative: false,
            external_in_flight: 0,
            runtime_capabilities: BTreeMap::new(),
            in_flight: 0,
            active_sessions: HashMap::new(),
            active_primary_sessions: HashMap::new(),
            active_subagents: HashMap::new(),
            rpm_ring: VecDeque::new(),
            sink_seq: 0,
            permanent_unschedulable: false,
            permanent_reason: None,
            node_cooldown_until_ms: 0,
            node_cooldown_reason: None,
            node_cooldown_step: 0,
            consecutive_failures: 0,
            model_cooldowns: HashMap::new(),
            probe_in_flight: false,
        }
    }
}

impl NodeMutable {
    pub fn apply_telemetry(&mut self, upd: &NodeTelemetryUpdate) -> bool {
        let mut became_freer = false;
        if let Some(v) = upd.schedulable {
            if v && !self.schedulable {
                became_freer = true;
            }
            self.schedulable = v;
        }
        if let Some(reason) = &upd.unschedulable_reason {
            self.unschedulable_reason = reason.clone();
        }
        if let Some(v) = upd.active_hours_ok {
            if v && !self.active_hours_ok {
                became_freer = true;
            }
            self.active_hours_ok = v;
        }
        if let Some(v) = upd.quota_util_5h_pct {
            if v < self.quota_util_5h_pct {
                became_freer = true;
            }
            self.quota_util_5h_pct = v.clamp(0.0, 100.0);
        }
        if let Some(v) = upd.quota_util_7d_pct {
            if v < self.quota_util_7d_pct {
                became_freer = true;
            }
            self.quota_util_7d_pct = v.clamp(0.0, 100.0);
        }
        if let Some(v) = upd.host_memory_pressure {
            if !v && self.host_memory_pressure {
                became_freer = true;
            }
            self.host_memory_pressure = v;
        }
        if let Some(v) = upd.proxy_ready {
            if v && !self.proxy_ready {
                became_freer = true;
            }
            self.proxy_ready = v;
        }
        if let Some(v) = upd.crag_license_ok {
            if v && !self.crag_license_ok {
                became_freer = true;
            }
            self.crag_license_ok = v;
        }
        if let Some(v) = &upd.temp_unschedulable_until_ms {
            self.temp_park_live_authoritative = true;
            let normalized = match v {
                None | Some(0) => None,
                Some(until) => Some(*until),
            };
            if normalized.is_none() && self.temp_unschedulable_until_ms.is_some() {
                became_freer = true;
            } else if let Some(until) = normalized {
                if self
                    .temp_unschedulable_until_ms
                    .map(|prev| prev > until)
                    .unwrap_or(false)
                {
                    became_freer = true;
                }
            }
            self.temp_unschedulable_until_ms = normalized;
        }
        if let Some(v) = &upd.temp_unschedulable_reason {
            if v.is_none() && self.temp_unschedulable_reason.is_some() {
                became_freer = true;
            }
            self.temp_unschedulable_reason = v.clone();
        }
        if let Some(v) = upd.external_in_flight {
            if v < self.external_in_flight {
                became_freer = true;
            }
            self.external_in_flight = v;
        }
        if let Some(caps) = &upd.runtime_capabilities {
            if caps
                .iter()
                .any(|(k, &v)| v && !self.runtime_capabilities.get(k).copied().unwrap_or(false))
            {
                became_freer = true;
            }
            self.runtime_capabilities = caps.clone();
        }
        became_freer
    }

    pub fn prune_rpm(&mut self, now_ms: u64) {
        let cutoff = now_ms.saturating_sub(60_000);
        while let Some(&front) = self.rpm_ring.front() {
            if front < cutoff {
                self.rpm_ring.pop_front();
            } else {
                break;
            }
        }
    }

    pub fn effective_in_flight(&self) -> u32 {
        self.in_flight.saturating_add(self.external_in_flight)
    }

    pub fn max_quota_pct(&self) -> f32 {
        self.quota_util_5h_pct.max(self.quota_util_7d_pct)
    }

    pub fn snapshot_metrics(&self, cap: &NodeCapacityConfig) -> NodeMetricsSnapshot {
        NodeMetricsSnapshot {
            in_flight: self.effective_in_flight(),
            max_concurrency: cap.max_concurrency,
            active_sessions: self.active_sessions.len() as u32,
            max_sessions: cap.max_sessions,
            quota_util_5h_pct: self.quota_util_5h_pct,
            quota_util_7d_pct: self.quota_util_7d_pct,
            sink_seq: self.sink_seq,
        }
    }
}

/// Per-node runtime state protected by a fine-grained non-nested `parking_lot::Mutex`.
#[derive(Default)]
pub struct NodeRuntimeState {
    pub inner: Mutex<NodeMutable>,
}

impl NodeRuntimeState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn snapshot_metrics(&self, node_cfg: &BackendNodeConfig) -> NodeMetricsSnapshot {
        let guard = self.inner.lock();
        guard.snapshot_metrics(&node_cfg.capacity)
    }
}

/// Lock-free copyable snapshot used during tier ranking so `NodeMutable` is never held
/// while acquiring `SwrrRound` locks.
#[derive(Clone, Copy, Debug, Default)]
pub struct NodeMetricsSnapshot {
    pub in_flight: u32,
    pub max_concurrency: u32,
    pub active_sessions: u32,
    pub max_sessions: u32,
    pub quota_util_5h_pct: f32,
    pub quota_util_7d_pct: f32,
    pub sink_seq: u64,
}

impl NodeMetricsSnapshot {
    #[inline]
    pub fn max_quota_pct(&self) -> f32 {
        self.quota_util_5h_pct.max(self.quota_util_7d_pct)
    }

    #[inline]
    pub fn has_free_slot(&self) -> bool {
        self.max_concurrency > 0
            && self.in_flight < self.max_concurrency
            && (self.max_sessions == 0 || self.active_sessions < self.max_sessions)
    }

    /// Load ratio in basis points (0..=10_000), combining concurrency & active sessions.
    #[inline]
    pub fn load_ratio_bps(&self) -> u32 {
        let conc_bps = if self.max_concurrency == 0 {
            10_000
        } else {
            ((self.in_flight as u64 * 10_000) / self.max_concurrency as u64).min(10_000) as u32
        };
        let sess_bps = if self.max_sessions == 0 {
            0
        } else {
            ((self.active_sessions as u64 * 10_000) / self.max_sessions as u64).min(10_000) as u32
        };
        conc_bps.max(sess_bps)
    }

    /// Quota headroom in basis points (0..=10_000, higher is healthier).
    #[inline]
    pub fn quota_headroom_bps(&self) -> u32 {
        let used = (self.max_quota_pct().clamp(0.0, 100.0) * 100.0) as u32;
        10_000u32.saturating_sub(used)
    }
}
