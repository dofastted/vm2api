use crate::config::*;
use crate::error::ErrorCode;
use crate::explain::{DecisionExplain, ResolvedPromptPolicy};
use crate::types::*;
use compact_str::CompactString;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

fn default_attempt_no() -> u32 {
    1
}

fn default_max_items() -> usize {
    500
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HealthResponse {
    pub ok: bool,
    pub bootstrapped: bool,
    pub role: Role,
    pub config_version: u64,
    pub epoch: CompactString,
    pub active_leases: usize,
    pub active_session_gates: usize,
    pub dirty_deltas: usize,
    pub uptime_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StickyBindingDto {
    pub scope_kind: StickyScopeKind,
    pub pool_id: PoolId,
    pub model_family: ModelFamily,
    pub identity_id: CompactString,
    pub node_key: NodeKey,
    pub node_type: NodeType,
    pub node_id: CompactString,
    #[serde(default)]
    pub machine_id: Option<CompactString>,
    #[serde(default)]
    pub stood_in: bool,
    pub bound_at_ms: u64,
    pub last_seen_ms: u64,
    pub expires_at_ms: u64,
    #[serde(default)]
    pub hits: u64,
    #[serde(default)]
    pub generation: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
pub struct StickyDeleteKeyDto {
    pub scope_kind: StickyScopeKind,
    pub pool_id: PoolId,
    pub model_family: ModelFamily,
    pub identity_id: CompactString,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NodePenaltyDto {
    pub node_key: NodeKey,
    pub node_type: NodeType,
    pub node_id: CompactString,
    /// `"*"` for node-level cooldown, or specific model name for model-level cooldown.
    pub model_scope: CompactString,
    pub reason: CompactString,
    pub cooldown_until_ms: u64,
    #[serde(default)]
    pub ladder_step: u32,
    #[serde(default)]
    pub permanent: bool,
    pub updated_at_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
pub struct PenaltyDeleteKeyDto {
    pub node_key: NodeKey,
    pub model_scope: CompactString,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct NodeTelemetryUpdate {
    pub node_key: NodeKey,
    #[serde(default)]
    pub schedulable: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::serde_patch::double_option"
    )]
    pub unschedulable_reason: Option<Option<CompactString>>,
    #[serde(default)]
    pub active_hours_ok: Option<bool>,
    #[serde(default)]
    pub quota_util_5h_pct: Option<f32>,
    #[serde(default)]
    pub quota_util_7d_pct: Option<f32>,
    #[serde(default)]
    pub host_memory_pressure: Option<bool>,
    #[serde(default)]
    pub proxy_ready: Option<bool>,
    #[serde(default)]
    pub crag_license_ok: Option<bool>,
    /// External in-flight load (e.g. blue/green handover-load.json).
    #[serde(default)]
    pub external_in_flight: Option<u32>,
    #[serde(default)]
    pub runtime_capabilities: Option<BTreeMap<String, bool>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::serde_patch::double_option"
    )]
    pub temp_unschedulable_until_ms: Option<Option<u64>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::serde_patch::double_option"
    )]
    pub temp_unschedulable_reason: Option<Option<CompactString>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TelemetryBatchRequest {
    #[serde(default, alias = "updates")]
    pub nodes: Vec<NodeTelemetryUpdate>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TelemetryBatchResponse {
    pub ok: bool,
    pub updated: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BootstrapRequest {
    pub controller_epoch: CompactString,
    #[serde(default)]
    pub role: Role,
    #[serde(default)]
    pub config_version: Option<u64>,
    pub config_snapshot: ConfigSnapshot,
    #[serde(default)]
    pub active_sticky_bindings: Vec<StickyBindingDto>,
    #[serde(default)]
    pub active_penalties: Vec<NodePenaltyDto>,
    #[serde(default)]
    pub initial_telemetry: Vec<NodeTelemetryUpdate>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BootstrapResponse {
    pub ok: bool,
    pub bootstrapped: bool,
    pub role: Role,
    pub epoch: CompactString,
    pub config_version: u64,
    pub orphans_reaped: usize,
    pub sticky_loaded: usize,
    pub penalties_loaded: usize,
    pub telemetry_loaded: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConfigSyncRequest {
    pub config_version: u64,
    pub config_snapshot: ConfigSnapshot,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConfigSyncResponse {
    pub ok: bool,
    pub applied: bool,
    pub config_version: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AcquireRequest {
    pub request_id: RequestId,
    #[serde(default = "default_attempt_no")]
    pub attempt_no: u32,
    #[serde(default)]
    pub controller_epoch: CompactString,
    #[serde(default)]
    pub min_config_version: u64,
    pub origin_pool_id: PoolId,
    #[serde(default)]
    pub jev_downgrade_pool_id: Option<PoolId>,
    #[serde(default)]
    pub api_key_scope: ApiKeyScope,
    pub model: CompactString,
    #[serde(default)]
    pub model_family: ModelFamily,
    #[serde(default)]
    pub protocol: CompactString,
    #[serde(default)]
    pub machine_id: Option<CompactString>,
    pub session_id: CompactString,
    #[serde(default)]
    pub session_id_source: Option<CompactString>,
    #[serde(default)]
    pub parent_session_id: Option<CompactString>,
    #[serde(default)]
    pub is_ephemeral_probe: bool,
    #[serde(default)]
    pub no_queue: bool,
    #[serde(default)]
    pub is_admin_diagnostic: bool,
    #[serde(default)]
    pub pin_node_key: Option<NodeKey>,
    #[serde(default)]
    pub exclude_nodes: Vec<NodeKey>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SelectedNodeInfo {
    pub node_key: NodeKey,
    pub node_type: NodeType,
    pub node_id: CompactString,
    pub provider: Provider,
    pub effective_weight_tier: u16,
    pub sub_weight: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AcquireResponse {
    pub lease_id: LeaseId,
    pub lease_ttl_ms: u64,
    pub selected_node: SelectedNodeInfo,
    pub resolved_pool_id: PoolId,
    pub prompt_policy: ResolvedPromptPolicy,
    pub stood_in: bool,
    pub preserve_machine_home: bool,
    pub session_gate_wait_ms: u64,
    pub explain: DecisionExplain,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct QuotaHeaders {
    #[serde(default)]
    pub quota_util_5h_pct: Option<f32>,
    #[serde(default)]
    pub quota_util_7d_pct: Option<f32>,
    #[serde(default)]
    pub resets_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct FailureReport {
    #[serde(default)]
    pub http_status: u16,
    #[serde(default)]
    pub error_class: ErrorClass,
    #[serde(default)]
    pub error_signature: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
    #[serde(default)]
    pub retry_after_sec: Option<u64>,
    #[serde(default)]
    pub quota_headers: Option<QuotaHeaders>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SwitchRequest {
    pub release_lease_id: LeaseId,
    #[serde(default)]
    pub failure: FailureReport,
    pub next_attempt: AcquireRequest,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HeartbeatRequest {
    pub controller_epoch: CompactString,
    #[serde(default)]
    pub lease_ids: Vec<LeaseId>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HeartbeatResponse {
    pub ok: bool,
    pub renewed: usize,
    #[serde(default)]
    pub missing: Vec<LeaseId>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CommitRequest {
    pub lease_id: LeaseId,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CommitResponse {
    pub ok: bool,
    pub committed: bool,
    pub already_committed: bool,
    pub lease_found: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReleaseRequest {
    pub lease_id: LeaseId,
    #[serde(default)]
    pub outcome: ReleaseOutcome,
    #[serde(default)]
    pub http_status: Option<u16>,
    #[serde(default)]
    pub error_class: Option<ErrorClass>,
    #[serde(default)]
    pub error_signature: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
    #[serde(default)]
    pub retry_after_sec: Option<u64>,
    #[serde(default)]
    pub ttft_ms: Option<u64>,
    #[serde(default)]
    pub tokens_used: Option<u64>,
    #[serde(default)]
    pub quota_headers: Option<QuotaHeaders>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReleaseResponse {
    pub ok: bool,
    pub released: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExplainResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_node: Option<SelectedNodeInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_pool_id: Option<PoolId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_policy: Option<ResolvedPromptPolicy>,
    pub stood_in: bool,
    pub preserve_machine_home: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<ErrorCode>,
    pub explain: DecisionExplain,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DrainRequest {
    #[serde(default = "default_max_items")]
    pub max_items: usize,
    #[serde(default)]
    pub ack_batch_id: Option<u64>,
    #[serde(default)]
    pub ack_only: bool,
}

impl Default for DrainRequest {
    fn default() -> Self {
        Self {
            max_items: default_max_items(),
            ack_batch_id: None,
            ack_only: false,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DrainResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<u64>,
    #[serde(default)]
    pub sticky_upserts: Vec<StickyBindingDto>,
    #[serde(default)]
    pub sticky_deletes: Vec<StickyDeleteKeyDto>,
    #[serde(default)]
    pub penalty_upserts: Vec<NodePenaltyDto>,
    #[serde(default)]
    pub penalty_deletes: Vec<PenaltyDeleteKeyDto>,
    pub remaining: usize,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct StickyQuery {
    #[serde(default)]
    pub pool_id: Option<PoolId>,
    #[serde(default)]
    pub scope_kind: Option<StickyScopeKind>,
    #[serde(default)]
    pub model_family: Option<ModelFamily>,
    #[serde(default)]
    pub machine_id: Option<CompactString>,
    #[serde(default)]
    pub session_id: Option<CompactString>,
    #[serde(default)]
    pub node_key: Option<NodeKey>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StickyListResponse {
    pub ok: bool,
    pub bindings: Vec<StickyBindingDto>,
    pub total: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StickyDeleteResponse {
    pub ok: bool,
    pub deleted: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UnrestRequest {
    pub node_key: NodeKey,
    #[serde(default)]
    pub model_scope: Option<CompactString>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UnrestResponse {
    pub ok: bool,
    pub node_key: NodeKey,
    pub cleared_cooldowns: usize,
    pub sink_cleared: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SchedulerEventKind {
    Bootstrap,
    ConfigSync,
    LeaseAcquired,
    LeaseSwitched,
    LeaseCommitted,
    LeaseReleased,
    LeaseExpired,
    NodeCooldown,
    NodeSunk,
    PoisonAbort,
    AdminUnrest,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SchedulerEvent {
    pub cursor: String,
    pub epoch: CompactString,
    pub seq: u64,
    pub ts_ms: u64,
    pub kind: SchedulerEventKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pool_id: Option<PoolId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_key: Option<NodeKey>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<RequestId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}
