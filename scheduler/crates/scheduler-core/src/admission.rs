//! Stage 0: Fail-Closed hard admission filter and all-cooled `probeOne` selection.

use crate::node_state::{NodeMetricsSnapshot, NodeRuntimeState};
use crate::snapshot::IndexedSnapshot;
use compact_str::CompactString;
use dashmap::DashMap;
use scheduler_proto::{
    AcquireRequest, BackendNodeConfig, ExcludeReason, ExcludedEntry, MemberRole, NodeKey, NodeType,
    PoolConfig, Provider,
};
use std::cmp::Reverse;
use std::sync::Arc;

#[derive(Clone, Debug)]
pub struct AdmittedCandidate<'a> {
    pub node_key: NodeKey,
    pub node_type: NodeType,
    pub node_id: CompactString,
    pub provider: Provider,
    pub effective_weight_tier: u16,
    pub sub_weight: u32,
    pub member_role: MemberRole,
    pub member_order: i32,
    pub is_probe_one: bool,
    pub node_cfg: &'a BackendNodeConfig,
    pub metrics: NodeMetricsSnapshot,
}

struct CooledCandidate<'a> {
    candidate: AdmittedCandidate<'a>,
    cooldown_until_ms: u64,
    probe_in_flight: bool,
    excluded_idx: usize,
}

/// Filter pool members against all hard safety, authorization, tenant, model, health,
/// quota, active-hours, and cooldown gates, capturing `NodeMetricsSnapshot` in the same
/// lock acquisition (zero redundant locks, zero `BackendNodeConfig` clones).
pub fn filter_members<'a>(
    snap: &'a IndexedSnapshot,
    pool: &PoolConfig,
    req: &AcquireRequest,
    nodes: &DashMap<NodeKey, Arc<NodeRuntimeState>>,
    now_ms: u64,
) -> (Vec<AdmittedCandidate<'a>>, Vec<ExcludedEntry>) {
    let mut admitted = Vec::with_capacity(pool.members.len());
    let mut excluded = Vec::new();
    let mut cooled: Vec<CooledCandidate<'a>> = Vec::new();

    for member in &pool.members {
        if !member.enabled {
            excluded.push(ExcludedEntry {
                pool_id: pool.id.clone(),
                node: member.node_key.clone(),
                reason: ExcludeReason::MemberDisabled,
                detail: String::new(),
            });
            continue;
        }

        let Some(node) = snap.get_node(&member.node_key) else {
            excluded.push(ExcludedEntry {
                pool_id: pool.id.clone(),
                node: member.node_key.clone(),
                reason: ExcludeReason::NodeMissing,
                detail: "node missing from config snapshot".to_owned(),
            });
            continue;
        };

        if !node.enabled {
            excluded.push(ExcludedEntry {
                pool_id: pool.id.clone(),
                node: node.node_key.clone(),
                reason: ExcludeReason::NodeDisabled,
                detail: String::new(),
            });
            continue;
        }

        if req.exclude_nodes.contains(&node.node_key) {
            excluded.push(ExcludedEntry {
                pool_id: pool.id.clone(),
                node: node.node_key.clone(),
                reason: ExcludeReason::ExplicitExclude,
                detail: "excluded by attempt history".to_owned(),
            });
            continue;
        }

        // Legacy per-node allowlist intersection
        if !req.api_key_scope.allowed_node_keys.is_empty()
            && !req.api_key_scope.allowed_node_keys.contains(&node.node_key)
        {
            excluded.push(ExcludedEntry {
                pool_id: pool.id.clone(),
                node: node.node_key.clone(),
                reason: ExcludeReason::KeyScopeFiltered,
                detail: "not in api_key allowed_node_keys".to_owned(),
            });
            continue;
        }

        // Tenant isolation
        if let Some(req_owner) = req.api_key_scope.owner_id.as_deref() {
            let mismatch = match node.owner_id.as_deref() {
                Some(node_owner) => node_owner != req_owner,
                None => req.api_key_scope.strict_tenant_only,
            };
            if mismatch {
                excluded.push(ExcludedEntry {
                    pool_id: pool.id.clone(),
                    node: node.node_key.clone(),
                    reason: ExcludeReason::TenantMismatch,
                    detail: format!("tenant owner_id mismatch (key={req_owner})"),
                });
                continue;
            }
        }

        // Model allowlist on API key
        if !req.api_key_scope.allowed_models.is_empty()
            && !model_matches(&req.api_key_scope.allowed_models, &req.model)
        {
            excluded.push(ExcludedEntry {
                pool_id: pool.id.clone(),
                node: node.node_key.clone(),
                reason: ExcludeReason::ModelUnsupported,
                detail: format!("model '{}' not in api_key allowed_models", req.model),
            });
            continue;
        }

        // Model support on node
        if !node.supported_models.is_empty() && !model_matches(&node.supported_models, &req.model) {
            excluded.push(ExcludedEntry {
                pool_id: pool.id.clone(),
                node: node.node_key.clone(),
                reason: ExcludeReason::ModelUnsupported,
                detail: format!("node does not support model '{}'", req.model),
            });
            continue;
        }

        let effective_weight_tier = member
            .weight_tier_override
            .unwrap_or_else(|| node.effective_base_weight_tier())
            .clamp(1, 10);
        let sub_weight = member
            .sub_weight_override
            .unwrap_or(node.sub_weight)
            .clamp(1, 1000);

        let build_cand = |is_probe_one: bool, metrics: NodeMetricsSnapshot| AdmittedCandidate {
            node_key: node.node_key.clone(),
            node_type: node.node_type,
            node_id: node.node_id.clone(),
            provider: node.provider,
            effective_weight_tier,
            sub_weight,
            member_role: member.member_role,
            member_order: member.member_order,
            is_probe_one,
            node_cfg: node,
            metrics,
        };

        // Check runtime telemetry + cooldown state and snapshot metrics in ONE short non-nested lock
        let metrics = if let Some(rt) = nodes.get(&node.node_key) {
            let st = rt.inner.lock();
            if st.permanent_unschedulable {
                excluded.push(ExcludedEntry {
                    pool_id: pool.id.clone(),
                    node: node.node_key.clone(),
                    reason: ExcludeReason::PermanentUnschedulable,
                    detail: st
                        .permanent_reason
                        .as_deref()
                        .unwrap_or("permanently unschedulable")
                        .to_owned(),
                });
                continue;
            }
            if !st.schedulable {
                excluded.push(ExcludedEntry {
                    pool_id: pool.id.clone(),
                    node: node.node_key.clone(),
                    reason: ExcludeReason::NotSchedulable,
                    detail: st
                        .unschedulable_reason
                        .as_deref()
                        .unwrap_or("unschedulable")
                        .to_owned(),
                });
                continue;
            }
            if !st.active_hours_ok {
                excluded.push(ExcludedEntry {
                    pool_id: pool.id.clone(),
                    node: node.node_key.clone(),
                    reason: ExcludeReason::InactiveHours,
                    detail: "outside active_hours".to_owned(),
                });
                continue;
            }
            if st.quota_util_5h_pct >= 95.0 || st.quota_util_7d_pct >= 95.0 {
                excluded.push(ExcludedEntry {
                    pool_id: pool.id.clone(),
                    node: node.node_key.clone(),
                    reason: ExcludeReason::QuotaExhausted,
                    detail: format!(
                        "quota_5h={:.1}%,quota_7d={:.1}%",
                        st.quota_util_5h_pct, st.quota_util_7d_pct
                    ),
                });
                continue;
            }
            if st.host_memory_pressure {
                excluded.push(ExcludedEntry {
                    pool_id: pool.id.clone(),
                    node: node.node_key.clone(),
                    reason: ExcludeReason::MemoryPressure,
                    detail: "host_memory_pressure=true".to_owned(),
                });
                continue;
            }
            if !st.proxy_ready {
                excluded.push(ExcludedEntry {
                    pool_id: pool.id.clone(),
                    node: node.node_key.clone(),
                    reason: ExcludeReason::ProxyNotReady,
                    detail: "proxy_ready=false".to_owned(),
                });
                continue;
            }
            if !st.crag_license_ok {
                excluded.push(ExcludedEntry {
                    pool_id: pool.id.clone(),
                    node: node.node_key.clone(),
                    reason: ExcludeReason::LicenseInvalid,
                    detail: "crag_license_ok=false".to_owned(),
                });
                continue;
            }
            if !pool.required_runtime_capabilities.is_empty() {
                let missing: Vec<&str> = pool
                    .required_runtime_capabilities
                    .iter()
                    .map(|cap| cap.as_str())
                    .filter(|cap| !st.runtime_capabilities.get(*cap).copied().unwrap_or(false))
                    .collect();
                if !missing.is_empty() {
                    excluded.push(ExcludedEntry {
                        pool_id: pool.id.clone(),
                        node: node.node_key.clone(),
                        reason: ExcludeReason::CapabilityMismatch,
                        detail: format!("missing required capabilities: {}", missing.join(",")),
                    });
                    continue;
                }
            }

            let snap_m = st.snapshot_metrics(&node.capacity);

            if st.node_cooldown_until_ms > now_ms {
                let left = st.node_cooldown_until_ms.saturating_sub(now_ms);
                let idx = excluded.len();
                excluded.push(ExcludedEntry {
                    pool_id: pool.id.clone(),
                    node: node.node_key.clone(),
                    reason: ExcludeReason::NodeCooldown,
                    detail: format!("cooldown_left_ms={left}"),
                });
                cooled.push(CooledCandidate {
                    candidate: build_cand(true, snap_m),
                    cooldown_until_ms: st.node_cooldown_until_ms,
                    probe_in_flight: st.probe_in_flight,
                    excluded_idx: idx,
                });
                continue;
            }

            if let Some(mc) = st.model_cooldowns.get(&req.model) {
                if mc.until_ms > now_ms {
                    let left = mc.until_ms.saturating_sub(now_ms);
                    let idx = excluded.len();
                    excluded.push(ExcludedEntry {
                        pool_id: pool.id.clone(),
                        node: node.node_key.clone(),
                        reason: ExcludeReason::ModelCooldown,
                        detail: format!("cooldown_left_ms={left}"),
                    });
                    cooled.push(CooledCandidate {
                        candidate: build_cand(true, snap_m),
                        cooldown_until_ms: mc.until_ms,
                        probe_in_flight: st.probe_in_flight,
                        excluded_idx: idx,
                    });
                    continue;
                }
            }

            snap_m
        } else {
            if !pool.required_runtime_capabilities.is_empty() {
                excluded.push(ExcludedEntry {
                    pool_id: pool.id.clone(),
                    node: node.node_key.clone(),
                    reason: ExcludeReason::CapabilityMismatch,
                    detail: format!(
                        "missing required capabilities: {}",
                        pool.required_runtime_capabilities.join(",")
                    ),
                });
                continue;
            }
            NodeMetricsSnapshot {
                in_flight: 0,
                max_concurrency: node.capacity.max_concurrency,
                active_sessions: 0,
                max_sessions: node.capacity.max_sessions,
                quota_util_5h_pct: 0.0,
                quota_util_7d_pct: 0.0,
                sink_seq: 0,
            }
        };

        admitted.push(build_cand(false, metrics));
    }

    // All-cooled `probeOne`: release ONLY the single soonest-expiring cooled node when no healthy
    // candidate remains and no probe is currently active on it.
    if admitted.is_empty() && !cooled.is_empty() {
        cooled.sort_by_key(|c| {
            (
                c.cooldown_until_ms,
                Reverse(c.candidate.effective_weight_tier),
                c.candidate.member_order,
            )
        });
        let soonest = &cooled[0];
        if !soonest.probe_in_flight {
            if let Some(entry) = excluded.get_mut(soonest.excluded_idx) {
                entry.detail.push_str("; selected_for_probe_one");
            }
            admitted.push(soonest.candidate.clone());
        }
    }

    (admitted, excluded)
}

fn model_matches(allowed: &[CompactString], model: &str) -> bool {
    allowed
        .iter()
        .any(|m| m.as_str() == "*" || m.eq_ignore_ascii_case(model))
}
