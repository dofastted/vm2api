use crate::types::*;
use compact_str::CompactString;
use serde::{Deserialize, Serialize};

fn default_true() -> bool {
    true
}

fn default_weight_tier() -> u16 {
    5
}

fn default_sub_weight() -> u32 {
    10
}

fn default_max_concurrency() -> u32 {
    4
}

fn default_max_sessions() -> u32 {
    4
}

fn default_session_queue_max() -> u32 {
    16
}

fn default_session_queue_timeout_ms() -> u64 {
    60_000
}

fn default_queue_wait_ms() -> u64 {
    15_000
}

fn default_queue_max() -> u32 {
    50
}

fn default_machine_ttl_seconds() -> u64 {
    604_800 // 7 days
}

fn default_session_ttl_seconds() -> u64 {
    86_400 // 24 hours
}

fn default_prompt_preset() -> CompactString {
    CompactString::const_new("official_full")
}

fn default_global_prompt_mode() -> SystemPromptMode {
    SystemPromptMode::Official
}

fn default_pool_prompt_mode() -> SystemPromptMode {
    SystemPromptMode::InheritGlobal
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GlobalPromptPolicy {
    #[serde(default = "default_global_prompt_mode")]
    pub mode: SystemPromptMode,
    #[serde(default = "default_prompt_preset")]
    pub preset: CompactString,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub client_system_policy: ClientSystemPolicy,
}

impl Default for GlobalPromptPolicy {
    fn default() -> Self {
        Self {
            mode: default_global_prompt_mode(),
            preset: default_prompt_preset(),
            text: String::new(),
            client_system_policy: ClientSystemPolicy::PrependPool,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ConfigSnapshot {
    #[serde(default)]
    pub config_version: u64,
    #[serde(default)]
    pub global_prompt_policy: GlobalPromptPolicy,
    #[serde(default)]
    pub trusted_downgrade_pool_ids: Vec<PoolId>,
    #[serde(default)]
    pub pools: Vec<PoolConfig>,
    #[serde(default)]
    pub nodes: Vec<BackendNodeConfig>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PoolConfig {
    pub id: PoolId,
    #[serde(default)]
    pub slug: CompactString,
    #[serde(default)]
    pub name: CompactString,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub exclusive_members: bool,
    #[serde(default)]
    pub provider_scope: ProviderScope,
    #[serde(default)]
    pub plan_tags: Vec<CompactString>,
    #[serde(default)]
    pub pool_role: PoolRole,
    #[serde(default)]
    pub sort_order: i32,
    #[serde(default)]
    pub fallback_pool_id: Option<PoolId>,
    #[serde(default)]
    pub allow_cross_prompt_fallback: bool,
    #[serde(default)]
    pub intra_tier_strategy: IntraTierStrategy,
    #[serde(default = "default_session_queue_max")]
    pub session_queue_max: u32,
    #[serde(default = "default_session_queue_timeout_ms")]
    pub session_queue_timeout_ms: u64,
    #[serde(default = "default_queue_wait_ms")]
    pub queue_wait_ms: u64,
    #[serde(default = "default_queue_max")]
    pub queue_max: u32,
    #[serde(default = "default_true")]
    pub machine_sticky_enabled: bool,
    #[serde(default = "default_machine_ttl_seconds")]
    pub machine_ttl_seconds: u64,
    #[serde(default = "default_true")]
    pub session_sticky_enabled: bool,
    #[serde(default = "default_session_ttl_seconds")]
    pub session_ttl_seconds: u64,
    /// Locked D2 default: 0ms (spill immediately, no waiting).
    #[serde(default)]
    pub session_busy_wait_ms: u64,
    /// Locked D2 default: SpillImmediately.
    #[serde(default)]
    pub session_overflow_policy: SessionOverflowPolicy,
    #[serde(default = "default_pool_prompt_mode")]
    pub system_prompt_mode: SystemPromptMode,
    #[serde(default = "default_prompt_preset")]
    pub system_prompt_preset: CompactString,
    #[serde(default)]
    pub system_prompt_text: String,
    #[serde(default)]
    pub client_system_policy: ClientSystemPolicy,
    #[serde(default)]
    pub jev_profile: JevProfile,
    /// Optional pool-level runtime capability gate (e.g. `os_kvm_native_smbios`,
    /// `vsock_transport_v1`). Empty/omitted preserves 100% legacy behavior.
    #[serde(default)]
    pub required_runtime_capabilities: Vec<String>,
    #[serde(default)]
    pub members: Vec<PoolMemberConfig>,
}

impl Default for PoolConfig {
    fn default() -> Self {
        Self {
            id: CompactString::const_new(""),
            slug: CompactString::const_new(""),
            name: CompactString::const_new(""),
            enabled: true,
            exclusive_members: false,
            provider_scope: ProviderScope::Mixed,
            plan_tags: Vec::new(),
            pool_role: PoolRole::Standard,
            sort_order: 0,
            fallback_pool_id: None,
            allow_cross_prompt_fallback: false,
            intra_tier_strategy: IntraTierStrategy::LeastInflightSwrr,
            session_queue_max: default_session_queue_max(),
            session_queue_timeout_ms: default_session_queue_timeout_ms(),
            queue_wait_ms: default_queue_wait_ms(),
            queue_max: default_queue_max(),
            machine_sticky_enabled: true,
            machine_ttl_seconds: default_machine_ttl_seconds(),
            session_sticky_enabled: true,
            session_ttl_seconds: default_session_ttl_seconds(),
            session_busy_wait_ms: 0,
            session_overflow_policy: SessionOverflowPolicy::SpillImmediately,
            system_prompt_mode: default_pool_prompt_mode(),
            system_prompt_preset: default_prompt_preset(),
            system_prompt_text: String::new(),
            client_system_policy: ClientSystemPolicy::PrependPool,
            jev_profile: JevProfile::InheritGlobal,
            required_runtime_capabilities: Vec::new(),
            members: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PoolMemberConfig {
    pub node_key: NodeKey,
    pub node_type: NodeType,
    pub node_id: CompactString,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub member_role: MemberRole,
    #[serde(default)]
    pub weight_tier_override: Option<u16>,
    #[serde(default)]
    pub sub_weight_override: Option<u32>,
    #[serde(default)]
    pub member_order: i32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NodeCapacityConfig {
    #[serde(default = "default_max_concurrency")]
    pub max_concurrency: u32,
    #[serde(default = "default_max_sessions")]
    pub max_sessions: u32,
    #[serde(default)]
    pub max_primary_sessions: Option<u32>,
    #[serde(default)]
    pub max_subagents_per_session: Option<u32>,
    #[serde(default)]
    pub max_rpm: Option<u32>,
}

impl Default for NodeCapacityConfig {
    fn default() -> Self {
        Self {
            max_concurrency: default_max_concurrency(),
            max_sessions: default_max_sessions(),
            max_primary_sessions: None,
            max_subagents_per_session: None,
            max_rpm: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BackendNodeConfig {
    pub node_key: NodeKey,
    pub node_type: NodeType,
    pub node_id: CompactString,
    pub provider: Provider,
    /// Protocol for api_endpoint nodes (e.g. "anthropic", "openai", "google").
    #[serde(default)]
    pub protocol: Option<CompactString>,
    #[serde(default)]
    pub owner_id: Option<CompactString>,
    #[serde(default)]
    pub plan_tier: Option<CompactString>,
    #[serde(default)]
    pub weight_tier_mode: WeightTierMode,
    #[serde(default = "default_weight_tier")]
    pub weight_tier: u16,
    /// Pre-computed 1..7 tier when `weight_tier_mode == Auto7dReset`.
    #[serde(default)]
    pub auto_weight_tier: Option<u16>,
    #[serde(default = "default_sub_weight")]
    pub sub_weight: u32,
    /// Empty means all models for this node's provider are supported.
    #[serde(default)]
    pub supported_models: Vec<CompactString>,
    #[serde(default)]
    pub capacity: NodeCapacityConfig,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

impl BackendNodeConfig {
    pub fn effective_base_weight_tier(&self) -> u16 {
        let raw = match self.weight_tier_mode {
            WeightTierMode::Manual => self.weight_tier,
            WeightTierMode::Auto7dReset => self.auto_weight_tier.unwrap_or(self.weight_tier),
        };
        raw.clamp(1, 10)
    }

    pub fn is_anthropic_prompt_eligible(&self) -> bool {
        match self.node_type {
            NodeType::ClaudeVm => true,
            NodeType::CodexVm | NodeType::GeminiEnv => false,
            NodeType::ApiEndpoint => self
                .protocol
                .as_deref()
                .map(|p| p.eq_ignore_ascii_case("anthropic"))
                .unwrap_or(self.provider == Provider::Anthropic),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ApiKeyScope {
    #[serde(default)]
    pub api_key_id: CompactString,
    #[serde(default)]
    pub pool_binding_mode: PoolBindingMode,
    #[serde(default)]
    pub default_pool_id: Option<PoolId>,
    #[serde(default)]
    pub allowed_pool_ids: Vec<PoolId>,
    /// Empty means no additional model restriction.
    #[serde(default)]
    pub allowed_models: Vec<CompactString>,
    #[serde(default)]
    pub owner_id: Option<CompactString>,
    /// When true, key may only use nodes explicitly owned by `owner_id`.
    #[serde(default)]
    pub strict_tenant_only: bool,
    /// Optional legacy per-node allowlist; empty means all pool members allowed.
    #[serde(default)]
    pub allowed_node_keys: Vec<NodeKey>,
}

#[cfg(test)]
mod tests {
    use super::PoolConfig;
    use crate::explain::ExcludeReason;

    #[test]
    fn pool_config_required_runtime_capabilities_defaults_to_empty_for_compat() {
        let legacy_json = r#"{
            "id": "pool_legacy",
            "members": []
        }"#;
        let pool: PoolConfig = serde_json::from_str(legacy_json).expect("legacy PoolConfig json");
        assert!(pool.required_runtime_capabilities.is_empty());
        assert_eq!(
            serde_json::to_string(&ExcludeReason::CapabilityMismatch).unwrap(),
            "\"capability_mismatch\""
        );
    }
}
