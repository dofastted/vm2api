export type ProviderScope = 'anthropic' | 'openai' | 'google' | 'api' | 'mixed'

export type PoolRole =
  'primary' | 'standard' | 'overflow' | 'downgrade' | 'dedicated'

export type IntraTierStrategy =
  'least_inflight_swrr' | 'balanced' | 'fill' | 'ordered'

export type SessionOverflowPolicy =
  'spill_immediately' | 'wait_then_spill' | 'strict'

export type SystemPromptMode =
  | 'official'
  | 'zero_inject'
  | 'override'
  | 'append'
  | 'passthrough'
  | 'inherit_global'

export type SystemPromptPreset = 'official_full' | 'official'

export type ClientSystemPolicy =
  'prepend_pool' | 'append_pool' | 'replace_client'

export type JevProfile =
  'inherit_global' | 'enforce' | 'downgrade_only' | 'bypass_trusted'

export type PoolNodeType =
  'claude_vm' | 'codex_vm' | 'gemini_env' | 'api_endpoint'

export type MemberRole = 'active' | 'standby'

export type PoolBindingMode = 'strict_pool' | 'legacy_scope'

export type WeightTierMode = 'manual' | 'auto_7d_reset' | 'auto'

export type SchedulerPoolMember = {
  pool_id?: string
  node_type: PoolNodeType
  node_id: string
  node_key?: string
  enabled: boolean
  member_role: MemberRole
  weight_tier_override: number | null
  sub_weight_override: number | null
  member_order: number
  created_at?: string
  updated_at?: string
  // Live node metadata / telemetry (populated by backend aggregation or client join)
  name?: string | null
  email?: string | null
  provider?: string | null
  plan_tier?: string | null
  protocol?: string | null
  dataplane?: string | null
  runtime_kind?:
    'crag' | 'cli-node' | 'codex' | 'gemini' | 'api' | string | null
  weight_tier_mode?: WeightTierMode | null
  base_weight_tier?: number | null
  effective_weight_tier?: number | null
  effective_sub_weight?: number | null
  inflight?: number
  max_concurrency?: number
  active_sessions?: number
  max_sessions?: number
  quota_util_5h_pct?: number | null
  quota_util_7d_pct?: number | null
  healthy?: boolean
  schedulable?: boolean
  unschedulable_reason?: string | null
  cooldown_until_ms?: number | null
  cooldown_reason?: string | null
  sink_seq?: number
}

export type SchedulerPoolMemberInput = {
  node_type: PoolNodeType
  node_id: string
  enabled: boolean
  member_role: MemberRole
  weight_tier_override: number | null
  sub_weight_override: number | null
  member_order: number
}

export type SchedulerPoolMetrics = {
  total_members?: number
  healthy_members?: number
  active_members?: number
  inflight?: number
  max_concurrency?: number
  active_sessions?: number
  max_sessions?: number
  machine_sticky_hit_rate_1h?: number | null
  session_sticky_hit_rate_1h?: number | null
  spill_rate_1h?: number | null
  bound_keys_count?: number
  active_bound_keys_count?: number
}

export type PoolBoundKeySummary = {
  api_key_id: string
  name?: string | null
  key_prefix?: string | null
  status?: string | null
  is_default?: boolean
  pool_binding_mode?: PoolBindingMode
  max_concurrency?: number
  rpm?: number
  requests?: number
}

export type SchedulerPool = {
  id: string
  slug: string
  name: string
  description: string
  enabled: boolean
  exclusive_members: boolean
  provider_scope: ProviderScope
  plan_tags: string[]
  pool_role: PoolRole
  sort_order: number
  fallback_pool_id: string | null
  allow_cross_prompt_fallback: boolean
  intra_tier_strategy: IntraTierStrategy
  session_queue_max: number
  session_queue_timeout_ms: number
  queue_wait_ms: number
  queue_max: number
  machine_sticky_enabled: boolean
  machine_ttl_seconds: number
  session_sticky_enabled: boolean
  session_ttl_seconds: number
  session_busy_wait_ms: number
  session_overflow_policy: SessionOverflowPolicy
  system_prompt_mode: SystemPromptMode
  system_prompt_preset: SystemPromptPreset
  system_prompt_text: string
  client_system_policy: ClientSystemPolicy
  jev_profile: JevProfile
  config_version?: number
  created_at?: string
  updated_at?: string
  members?: SchedulerPoolMember[]
  metrics?: SchedulerPoolMetrics
  bound_keys?: PoolBoundKeySummary[]
  // Flat summary aliases (tolerant of backend variations)
  total_members?: number
  healthy_members?: number
  inflight?: number
  max_concurrency?: number
  bound_keys_count?: number
  active_bound_keys_count?: number
  vm_ids?: string[]
}

export type SchedulerPoolDraft = {
  name: string
  slug: string
  description: string
  enabled: boolean
  exclusive_members: boolean
  provider_scope: ProviderScope
  plan_tags: string[]
  pool_role: PoolRole
  sort_order: number
  fallback_pool_id: string | null
  allow_cross_prompt_fallback: boolean
  intra_tier_strategy: IntraTierStrategy
  session_queue_max: number
  session_queue_timeout_ms: number
  queue_wait_ms: number
  queue_max: number
  machine_sticky_enabled: boolean
  machine_ttl_seconds: number
  session_sticky_enabled: boolean
  session_ttl_seconds: number
  session_busy_wait_ms: number
  session_overflow_policy: SessionOverflowPolicy
  system_prompt_mode: SystemPromptMode
  system_prompt_preset: SystemPromptPreset
  system_prompt_text: string
  client_system_policy: ClientSystemPolicy
  jev_profile: JevProfile
}

export type SchedulerExplainRequest = {
  api_key_id?: string
  api_key?: string
  pool_id?: string
  model: string
  machine_id?: string
  session_id?: string
  parent_session_id?: string
  protocol?: string
}

export type SchedulerExplainOrderItem = {
  node_key: string
  node_type?: string
  node_id?: string
  name?: string
  member_role?: MemberRole | string
  effective_weight_tier?: number
  sub_bucket?: number
  inflight?: number
  max_concurrency?: number
  load_ratio_bps?: number
  sink_seq?: number
  selected?: boolean
}

export type SchedulerExplainExcludedItem = {
  node_key: string
  pool_id?: string
  reason: string
  detail?: string
}

export type SchedulerExplainResponse = {
  origin_pool_id?: string | null
  resolved_pool_id?: string | null
  resolved_pool_name?: string | null
  fallback_chain?: string[]
  jev_profile?: JevProfile | string | null
  jev_decision?: {
    action?: 'allow' | 'block' | 'downgrade' | string
    reason?: string | null
    downgrade_pool_id?: string | null
  } | null
  session_gate?: {
    key?: string | null
    held?: boolean
    queue_depth?: number
    queue_max?: number
    would_wait?: boolean
  } | null
  selected_node?: {
    node_key: string
    node_type?: string
    node_id?: string
    name?: string
    effective_weight_tier?: number
    stood_in?: boolean
  } | null
  affinity?: {
    why?: string | null
    target_node_key?: string | null
    stood_in?: boolean
    preserve_machine_home?: boolean
    notes?: Array<{ why: string; node_key?: string }>
  } | null
  prompt_policy?: {
    mode?: SystemPromptMode
    preset?: SystemPromptPreset | string
    applies?: boolean
    reason?: string | null
  } | null
  order?: SchedulerExplainOrderItem[]
  excluded?: SchedulerExplainExcludedItem[]
  error?: {
    code?: string
    message?: string
  } | null
}

export type SchedulerStickyBinding = {
  scope_kind: 'machine' | 'session'
  pool_id: string
  model_family: string
  identity_id: string
  node_type: PoolNodeType | string
  node_id: string
  node_key?: string
  machine_id?: string | null
  stood_in?: boolean
  bound_at_ms?: number
  last_seen_ms?: number
  expires_at_ms?: number
  hits?: number
  generation?: number
}

export type SchedulerEventItem = {
  id?: string
  cursor?: string
  epoch?: number
  seq?: number
  ts?: number | string
  event_type?: string
  type?: string
  pool_id?: string
  node_key?: string
  model?: string
  session_id?: string
  machine_id?: string
  affinity_why?: string
  wait_ms?: number
  outcome?: string
  message?: string
  [key: string]: unknown
}

export type PoolBriefRef = {
  id: string
  name: string
  provider_scope: ProviderScope
  system_prompt_mode: SystemPromptMode
  pool_role: PoolRole
  enabled: boolean
}
