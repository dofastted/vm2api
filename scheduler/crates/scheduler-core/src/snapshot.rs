use scheduler_proto::{
    ApiKeyScope, BackendNodeConfig, ConfigSnapshot, NodeKey, PoolBindingMode, PoolConfig, PoolId,
    PoolRole, PromptPolicySource, ProviderScope, ResolvedPromptPolicy, ScheduleError,
    SystemPromptMode,
};
use std::collections::{HashMap, HashSet};

/// Compiled read-optimized view of `ConfigSnapshot` stored inside `ArcSwap`.
#[derive(Clone, Debug, Default)]
pub struct IndexedSnapshot {
    pub raw: ConfigSnapshot,
    pools_by_id: HashMap<PoolId, usize>,
    nodes_by_key: HashMap<NodeKey, usize>,
    trusted_downgrade_pools: HashSet<PoolId>,
}

impl IndexedSnapshot {
    pub fn from_config(raw: ConfigSnapshot) -> Self {
        let mut pools_by_id = HashMap::with_capacity(raw.pools.len());
        let mut trusted_downgrade_pools: HashSet<PoolId> =
            raw.trusted_downgrade_pool_ids.iter().cloned().collect();

        for (idx, pool) in raw.pools.iter().enumerate() {
            pools_by_id.insert(pool.id.clone(), idx);
            if pool.pool_role == PoolRole::Downgrade {
                trusted_downgrade_pools.insert(pool.id.clone());
            }
        }

        let mut nodes_by_key = HashMap::with_capacity(raw.nodes.len());
        for (idx, node) in raw.nodes.iter().enumerate() {
            nodes_by_key.insert(node.node_key.clone(), idx);
        }

        Self {
            raw,
            pools_by_id,
            nodes_by_key,
            trusted_downgrade_pools,
        }
    }

    #[inline]
    pub fn config_version(&self) -> u64 {
        self.raw.config_version
    }

    pub fn get_pool(&self, pool_id: &str) -> Option<&PoolConfig> {
        self.pools_by_id
            .get(pool_id)
            .and_then(|&idx| self.raw.pools.get(idx))
    }

    pub fn get_node(&self, node_key: &str) -> Option<&BackendNodeConfig> {
        self.nodes_by_key
            .get(node_key)
            .and_then(|&idx| self.raw.nodes.get(idx))
    }

    /// Fail-Closed pool authorization and liveness validation.
    pub fn resolve_authorized_pool(
        &self,
        pool_id: &str,
        scope: &ApiKeyScope,
    ) -> Result<&PoolConfig, ScheduleError> {
        let pool = self
            .get_pool(pool_id)
            .ok_or_else(|| ScheduleError::PoolUnavailable(format!("pool '{pool_id}' not found")))?;

        if !pool.enabled {
            return Err(ScheduleError::PoolUnavailable(format!(
                "pool '{pool_id}' is disabled"
            )));
        }

        if !pool.members.iter().any(|m| m.enabled) {
            return Err(ScheduleError::PoolUnavailable(format!(
                "pool '{pool_id}' has no enabled members"
            )));
        }

        let authorized = match scope.pool_binding_mode {
            PoolBindingMode::StrictPool => {
                scope.allowed_pool_ids.iter().any(|id| id == pool_id)
                    || scope.default_pool_id.as_deref() == Some(pool_id)
            }
            PoolBindingMode::LegacyScope => {
                if scope.allowed_pool_ids.is_empty() {
                    match scope.default_pool_id.as_deref() {
                        Some(dp) if !dp.is_empty() => dp == pool_id,
                        _ => true,
                    }
                } else {
                    scope.allowed_pool_ids.iter().any(|id| id == pool_id)
                        || scope.default_pool_id.as_deref() == Some(pool_id)
                }
            }
        };

        if !authorized {
            return Err(ScheduleError::PoolForbidden(format!(
                "api key '{}' is not authorized for pool '{pool_id}'",
                scope.api_key_id
            )));
        }

        Ok(pool)
    }

    /// Second-stage verification for server-side trusted `jev_downgrade_pool_id`.
    /// Exempts `allowed_pool_ids` whitelist while preserving pool enabled/trusted checks
    /// (tenant/model/health boundaries remain strictly enforced in Stage 0).
    pub fn resolve_trusted_downgrade_pool(
        &self,
        dp_id: &str,
        _scope: &ApiKeyScope,
    ) -> Result<&PoolConfig, ScheduleError> {
        let pool = self.get_pool(dp_id).ok_or_else(|| {
            ScheduleError::PoolUnavailable(format!("downgrade pool '{dp_id}' not found"))
        })?;

        if !pool.enabled {
            return Err(ScheduleError::PoolUnavailable(format!(
                "downgrade pool '{dp_id}' is disabled"
            )));
        }

        if !self.trusted_downgrade_pools.contains(dp_id) {
            return Err(ScheduleError::PoolForbidden(format!(
                "pool '{dp_id}' is not a trusted JEV downgrade pool"
            )));
        }

        if !pool.members.iter().any(|m| m.enabled) {
            return Err(ScheduleError::PoolUnavailable(format!(
                "downgrade pool '{dp_id}' has no enabled members"
            )));
        }

        Ok(pool)
    }

    /// Resolve effective SystemPromptPolicy for `(pool, node)`.
    /// OpenAI / Google pools and non-Anthropic nodes are strictly locked to `passthrough`.
    pub fn resolve_prompt_policy(
        &self,
        pool: &PoolConfig,
        node: &BackendNodeConfig,
    ) -> ResolvedPromptPolicy {
        if !node.is_anthropic_prompt_eligible()
            || matches!(
                pool.provider_scope,
                ProviderScope::Openai | ProviderScope::Google
            )
        {
            return ResolvedPromptPolicy {
                mode: SystemPromptMode::Passthrough,
                preset: None,
                text: None,
                client_system_policy: None,
                source: PromptPolicySource::ProviderExempt,
            };
        }

        if pool.system_prompt_mode == SystemPromptMode::InheritGlobal {
            let g = &self.raw.global_prompt_policy;
            return build_prompt_policy(
                g.mode,
                &g.preset,
                &g.text,
                g.client_system_policy,
                PromptPolicySource::Global,
            );
        }

        build_prompt_policy(
            pool.system_prompt_mode,
            &pool.system_prompt_preset,
            &pool.system_prompt_text,
            pool.client_system_policy,
            PromptPolicySource::Pool,
        )
    }

    /// Check Anthropic cross-prompt fallback guard between `from` and `to`.
    pub fn fallback_prompt_allowed(&self, from: &PoolConfig, to: &PoolConfig) -> bool {
        if from.allow_cross_prompt_fallback {
            return true;
        }
        if !matches!(
            from.provider_scope,
            ProviderScope::Anthropic | ProviderScope::Mixed | ProviderScope::Api
        ) {
            return true;
        }
        let m1 = effective_pool_prompt_mode(&self.raw, from);
        let m2 = effective_pool_prompt_mode(&self.raw, to);
        m1 == m2
    }
}

fn effective_pool_prompt_mode(raw: &ConfigSnapshot, pool: &PoolConfig) -> SystemPromptMode {
    let raw_mode = if pool.system_prompt_mode == SystemPromptMode::InheritGlobal {
        raw.global_prompt_policy.mode
    } else {
        pool.system_prompt_mode
    };
    if raw_mode == SystemPromptMode::InheritGlobal {
        SystemPromptMode::Official
    } else {
        raw_mode
    }
}

fn build_prompt_policy(
    mode: SystemPromptMode,
    preset: &compact_str::CompactString,
    text: &str,
    client_policy: scheduler_proto::ClientSystemPolicy,
    source: PromptPolicySource,
) -> ResolvedPromptPolicy {
    match mode {
        SystemPromptMode::Official | SystemPromptMode::InheritGlobal => ResolvedPromptPolicy {
            mode: SystemPromptMode::Official,
            preset: Some(if preset.is_empty() {
                compact_str::CompactString::const_new("official_full")
            } else {
                preset.clone()
            }),
            text: None,
            client_system_policy: None,
            source,
        },
        SystemPromptMode::ZeroInject | SystemPromptMode::Passthrough => ResolvedPromptPolicy {
            mode,
            preset: None,
            text: None,
            client_system_policy: None,
            source,
        },
        SystemPromptMode::Override => ResolvedPromptPolicy {
            mode,
            preset: None,
            text: Some(text.to_owned()),
            client_system_policy: Some(client_policy),
            source,
        },
        SystemPromptMode::Append => ResolvedPromptPolicy {
            mode,
            preset: None,
            text: Some(text.to_owned()),
            // Append always appends at tail to preserve Prompt Cache prefix.
            client_system_policy: None,
            source,
        },
    }
}
