-- 008_scheduler_center — PostgreSQL parity for unified scheduler center
-- (scheduler_pools, scheduler_pool_members, api_key_pool_bindings,
-- scheduler_sticky_bindings, scheduler_node_penalties) plus api_keys pool
-- binding columns. Pure additive DDL (zero DML backfill; Leader startup runs
-- idempotent bootstrapSchedulerPools()).

CREATE TABLE IF NOT EXISTS scheduler_pools (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  exclusive_members INTEGER NOT NULL DEFAULT 0,
  provider_scope TEXT NOT NULL DEFAULT 'mixed',
  plan_tags_json TEXT NOT NULL DEFAULT '[]',
  pool_role TEXT NOT NULL DEFAULT 'standard',
  sort_order INTEGER NOT NULL DEFAULT 0,
  fallback_pool_id TEXT,
  allow_cross_prompt_fallback INTEGER NOT NULL DEFAULT 0,
  intra_tier_strategy TEXT NOT NULL DEFAULT 'least_inflight_swrr',
  session_queue_max INTEGER NOT NULL DEFAULT 16,
  session_queue_timeout_ms INTEGER NOT NULL DEFAULT 60000,
  queue_wait_ms INTEGER NOT NULL DEFAULT 15000,
  queue_max INTEGER NOT NULL DEFAULT 50,
  machine_sticky_enabled INTEGER NOT NULL DEFAULT 1,
  machine_ttl_seconds INTEGER NOT NULL DEFAULT 604800,
  session_sticky_enabled INTEGER NOT NULL DEFAULT 1,
  session_ttl_seconds INTEGER NOT NULL DEFAULT 86400,
  session_busy_wait_ms INTEGER NOT NULL DEFAULT 0,
  session_overflow_policy TEXT NOT NULL DEFAULT 'spill_immediately',
  system_prompt_mode TEXT NOT NULL DEFAULT 'passthrough',
  system_prompt_preset TEXT NOT NULL DEFAULT 'official_full',
  system_prompt_text TEXT NOT NULL DEFAULT '',
  client_system_policy TEXT NOT NULL DEFAULT 'prepend_pool',
  jev_profile TEXT NOT NULL DEFAULT 'inherit_global',
  config_version BIGINT NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sched_pools_slug ON scheduler_pools (LOWER(slug));
CREATE UNIQUE INDEX IF NOT EXISTS idx_sched_pools_name ON scheduler_pools (LOWER(name));

CREATE TABLE IF NOT EXISTS scheduler_pool_members (
  pool_id TEXT NOT NULL REFERENCES scheduler_pools (id) ON DELETE CASCADE,
  node_type TEXT NOT NULL,
  node_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  member_role TEXT NOT NULL DEFAULT 'active',
  weight_tier_override INTEGER,
  sub_weight_override INTEGER,
  member_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (pool_id, node_type, node_id)
);
CREATE INDEX IF NOT EXISTS idx_sched_pool_members_node ON scheduler_pool_members (node_type, node_id);

CREATE TABLE IF NOT EXISTS api_key_pool_bindings (
  api_key_id TEXT NOT NULL,
  pool_id TEXT NOT NULL REFERENCES scheduler_pools (id) ON DELETE RESTRICT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (api_key_id, pool_id)
);
CREATE INDEX IF NOT EXISTS idx_key_pool_bindings_pool ON api_key_pool_bindings (pool_id);

CREATE TABLE IF NOT EXISTS scheduler_sticky_bindings (
  scope_kind TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  model_family TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  node_id TEXT NOT NULL,
  machine_id TEXT,
  stood_in INTEGER NOT NULL DEFAULT 0,
  bound_at_ms BIGINT NOT NULL,
  last_seen_ms BIGINT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  hits BIGINT NOT NULL DEFAULT 0,
  generation BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (scope_kind, pool_id, model_family, identity_id)
);
CREATE INDEX IF NOT EXISTS idx_sched_sticky_expires ON scheduler_sticky_bindings (expires_at_ms);
CREATE INDEX IF NOT EXISTS idx_sched_sticky_node ON scheduler_sticky_bindings (node_type, node_id);

CREATE TABLE IF NOT EXISTS scheduler_node_penalties (
  node_type TEXT NOT NULL,
  node_id TEXT NOT NULL,
  model_scope TEXT NOT NULL DEFAULT '*',
  reason TEXT NOT NULL,
  cooldown_until_ms BIGINT NOT NULL,
  ladder_step INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (node_type, node_id, model_scope)
);

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS default_pool_id TEXT;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS pool_binding_mode TEXT NOT NULL DEFAULT 'legacy_scope';
