use crate::types::*;
use compact_str::CompactString;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AffinityWhy {
    SessionHit,
    SessionHitAfterWait,
    SessionSpillBusy,
    SessionNodeUnavailable,
    SubagentFollowParent,
    MachineHomeHit,
    MachineHomeCapacitySpill,
    MachineHomeUnavailable,
    TierRanked,
    PoolFullQueueWake,
    PinnedDiagnostic,
    ProbeOne,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExcludeReason {
    MemberDisabled,
    NodeMissing,
    NodeDisabled,
    KeyScopeFiltered,
    TenantMismatch,
    ModelUnsupported,
    NotSchedulable,
    InactiveHours,
    QuotaExhausted,
    MemoryPressure,
    ProxyNotReady,
    LicenseInvalid,
    PermanentUnschedulable,
    NodeCooldown,
    ModelCooldown,
    ExplicitExclude,
    CapacityFull,
    RpmExceeded,
    SubagentLimitExceeded,
    CrossPromptFallbackBlocked,
    CapabilityMismatch,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SessionGateExplain {
    pub wait_ms: u64,
    pub busy_at_peek: bool,
    pub queue_depth_at_peek: usize,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AffinityExplain {
    pub machine_id_present: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id_source: Option<CompactString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why: Option<AffinityWhy>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<AffinityNote>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine_home_node: Option<NodeKey>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_node: Option<NodeKey>,
    pub stood_in: bool,
    pub preserve_machine_home: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AffinityNote {
    pub why: AffinityWhy,
    pub node: NodeKey,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResolvedPromptPolicy {
    pub mode: SystemPromptMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset: Option<CompactString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_system_policy: Option<ClientSystemPolicy>,
    pub source: PromptPolicySource,
}

impl Default for ResolvedPromptPolicy {
    fn default() -> Self {
        Self {
            mode: SystemPromptMode::Passthrough,
            preset: None,
            text: None,
            client_system_policy: None,
            source: PromptPolicySource::ProviderExempt,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OrderEntry {
    pub node: NodeKey,
    pub tier: u16,
    pub sub_weight: u32,
    pub sub_bucket: u8,
    pub in_flight: u32,
    pub max_conc: u32,
    pub active_sessions: u32,
    pub max_sessions: u32,
    pub sunk: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExcludedEntry {
    pub pool_id: PoolId,
    pub node: NodeKey,
    pub reason: ExcludeReason,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub detail: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DecisionExplain {
    pub request_id: RequestId,
    pub config_version: u64,
    pub origin_pool_id: PoolId,
    pub resolved_pool_id: PoolId,
    pub model: CompactString,
    pub is_downgraded: bool,
    #[serde(default)]
    pub fallback_chain: Vec<PoolId>,
    pub session_gate: SessionGateExplain,
    pub affinity: AffinityExplain,
    pub prompt_policy: ResolvedPromptPolicy,
    #[serde(default)]
    pub order: Vec<OrderEntry>,
    #[serde(default)]
    pub excluded: Vec<ExcludedEntry>,
    pub decide_us: u64,
}

impl DecisionExplain {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        request_id: impl AsRef<str>,
        config_version: u64,
        origin_pool_id: impl AsRef<str>,
        resolved_pool_id: impl AsRef<str>,
        model: impl AsRef<str>,
        is_downgraded: bool,
        machine_id_present: bool,
        session_id_source: Option<CompactString>,
    ) -> Self {
        Self {
            request_id: CompactString::from(request_id.as_ref()),
            config_version,
            origin_pool_id: CompactString::from(origin_pool_id.as_ref()),
            resolved_pool_id: CompactString::from(resolved_pool_id.as_ref()),
            model: CompactString::from(model.as_ref()),
            is_downgraded,
            fallback_chain: Vec::new(),
            session_gate: SessionGateExplain::default(),
            affinity: AffinityExplain {
                machine_id_present,
                session_id_source,
                ..Default::default()
            },
            prompt_policy: ResolvedPromptPolicy::default(),
            order: Vec::new(),
            excluded: Vec::new(),
            decide_us: 0,
        }
    }

    pub fn set_gate_peek(&mut self, busy: bool, queue_depth: usize) {
        self.session_gate.busy_at_peek = busy;
        self.session_gate.queue_depth_at_peek = queue_depth;
    }

    pub fn set_affinity(&mut self, why: AffinityWhy, node: &NodeKey) {
        self.affinity.why = Some(why);
        self.affinity.selected_node = Some(node.clone());
    }

    pub fn note(&mut self, why: AffinityWhy, node: &NodeKey) {
        self.affinity.notes.push(AffinityNote {
            why,
            node: node.clone(),
        });
    }

    pub fn record_fallback(&mut self, to_pool: &PoolId) {
        self.fallback_chain.push(to_pool.clone());
    }
}
