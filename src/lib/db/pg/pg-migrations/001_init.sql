-- 001_init.sql — Complete PostgreSQL baseline schema for vm2api
-- Equivalent to SQLite migrations 001..067 (31 active tables + thinking_signature_owners).
-- ISO-8601 UTC TEXT timestamps are preserved for 100% query & keyset pagination parity;
-- all counters, token totals, byte sizes, durations, and epoch-ms columns use BIGINT.

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  balance DOUBLE PRECISION NOT NULL DEFAULT 0,
  concurrency INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT NOT NULL DEFAULT '',
  last_login_at TEXT,
  last_active_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  deleted_at TEXT,
  vm_create_quota INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_active
  ON users (LOWER(username)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_active
  ON users (email) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_status ON users (status);
CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users (deleted_at);

CREATE TABLE IF NOT EXISTS groups (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  rate_multiplier DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  is_exclusive INTEGER NOT NULL DEFAULT 0,
  platform TEXT NOT NULL DEFAULT 'claude',
  rpm_limit INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT,
  updated_at TEXT,
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_name_active
  ON groups (name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_groups_status ON groups (status);
CREATE INDEX IF NOT EXISTS idx_groups_deleted_at ON groups (deleted_at);

INSERT INTO groups (id, name, description, sort_order, created_at, updated_at)
VALUES
  (1, 'coding', 'Coding pool (default)', 0,
    to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  (2, 'other', 'Other traffic', 1,
    to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
ON CONFLICT (id) DO NOTHING;

SELECT setval(
  pg_get_serial_sequence('groups', 'id'),
  GREATEST((SELECT COALESCE(MAX(id), 1) FROM groups), 2),
  true
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  vm_id TEXT,
  email TEXT,
  concurrency INTEGER DEFAULT 2,
  requests BIGINT DEFAULT 0,
  tokens_in BIGINT DEFAULT 0,
  tokens_out BIGINT DEFAULT 0,
  updated_at TEXT,
  cache_read_tokens BIGINT DEFAULT 0,
  cache_creation_tokens BIGINT DEFAULT 0,
  concurrency_override INTEGER NOT NULL DEFAULT 0,
  max_rpm INTEGER NOT NULL DEFAULT 0,
  rpm_override INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT 'claude',
  type TEXT NOT NULL DEFAULT 'oauth',
  credentials TEXT NOT NULL DEFAULT '{}',
  extra TEXT NOT NULL DEFAULT '{}',
  proxy_id TEXT,
  load_factor INTEGER,
  priority INTEGER NOT NULL DEFAULT 50,
  rate_multiplier DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  status TEXT NOT NULL DEFAULT 'active',
  error_message TEXT,
  last_used_at TEXT,
  expires_at TEXT,
  schedulable INTEGER NOT NULL DEFAULT 1,
  rate_limited_at TEXT,
  rate_limit_reset_at TEXT,
  overload_until TEXT,
  temp_unschedulable_until TEXT,
  temp_unschedulable_reason TEXT,
  session_window_start TEXT,
  session_window_end TEXT,
  session_window_status TEXT,
  created_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_accounts_deleted_at ON accounts (deleted_at);
CREATE INDEX IF NOT EXISTS idx_accounts_priority ON accounts (priority);
CREATE INDEX IF NOT EXISTS idx_accounts_schedulable ON accounts (schedulable);
CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts (status);
CREATE INDEX IF NOT EXISTS idx_accounts_type ON accounts (type);

CREATE TABLE IF NOT EXISTS account_groups (
  account_id TEXT NOT NULL,
  group_id BIGINT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 50,
  created_at TEXT,
  PRIMARY KEY (account_id, group_id)
);
CREATE INDEX IF NOT EXISTS idx_account_groups_group ON account_groups (group_id);
CREATE INDEX IF NOT EXISTS idx_account_groups_priority ON account_groups (priority);

CREATE TABLE IF NOT EXISTS account_runtime (
  account_id TEXT PRIMARY KEY,
  vm_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  model_states_json TEXT,
  credential_generation BIGINT NOT NULL DEFAULT 0,
  refresh_status TEXT,
  worker_heartbeat_at BIGINT,
  worker_status_json TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_runtime_vm_new ON account_runtime (vm_id);

CREATE TABLE IF NOT EXISTS account_allocations (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL,
  at TEXT NOT NULL,
  source TEXT,
  util_5h DOUBLE PRECISION,
  util_7d DOUBLE PRECISION,
  status_5h TEXT,
  status_7d TEXT,
  claim TEXT,
  tokens_in BIGINT,
  tokens_out BIGINT
);
CREATE INDEX IF NOT EXISTS idx_alloc_account_at ON account_allocations (account_id, at DESC);

CREATE TABLE IF NOT EXISTS account_lifetime_usage_archive (
  account_id TEXT PRIMARY KEY,
  total_cost DOUBLE PRECISION NOT NULL,
  total_tokens BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_endpoints (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  prefix TEXT,
  base_url TEXT NOT NULL,
  headers_json TEXT,
  disable_cooling INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  kind TEXT NOT NULL DEFAULT 'custom',
  protocol TEXT NOT NULL DEFAULT 'anthropic',
  risk_review_enabled INTEGER NOT NULL DEFAULT 0 CHECK (risk_review_enabled IN (0, 1)),
  body_policy TEXT NOT NULL DEFAULT 'persona' CHECK (body_policy IN ('persona', 'caller'))
);

CREATE TABLE IF NOT EXISTS api_endpoint_keys (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  api_key TEXT NOT NULL,
  proxy_url TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  cooldown_until TEXT,
  created_at TEXT,
  proxy_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_api_endpoint_keys_ep ON api_endpoint_keys (endpoint_id);

CREATE TABLE IF NOT EXISTS api_endpoint_models (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  upstream_name TEXT NOT NULL,
  alias TEXT NOT NULL,
  image INTEGER NOT NULL DEFAULT 0,
  thinking_levels_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_endpoint_models_ep ON api_endpoint_models (endpoint_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT,
  key TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'active',
  max_concurrency INTEGER DEFAULT 2,
  quota_requests BIGINT DEFAULT 0,
  quota_requests_used BIGINT DEFAULT 0,
  rpm INTEGER DEFAULT 0,
  expires_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  last_used_at TEXT,
  requests BIGINT DEFAULT 0,
  tokens_in BIGINT DEFAULT 0,
  tokens_out BIGINT DEFAULT 0,
  key_hash TEXT,
  key_prefix TEXT,
  key_suffix TEXT,
  cache_read_tokens BIGINT DEFAULT 0,
  cache_creation_tokens BIGINT DEFAULT 0,
  category TEXT NOT NULL DEFAULT 'oauth',
  key_secret TEXT,
  user_id TEXT,
  group_id BIGINT,
  quota DOUBLE PRECISION NOT NULL DEFAULT 0,
  quota_used DOUBLE PRECISION NOT NULL DEFAULT 0,
  rate_limit_5h DOUBLE PRECISION NOT NULL DEFAULT 0,
  rate_limit_1d DOUBLE PRECISION NOT NULL DEFAULT 0,
  rate_limit_7d DOUBLE PRECISION NOT NULL DEFAULT 0,
  usage_5h DOUBLE PRECISION NOT NULL DEFAULT 0,
  usage_1d DOUBLE PRECISION NOT NULL DEFAULT 0,
  usage_7d DOUBLE PRECISION NOT NULL DEFAULT 0,
  window_5h_start TEXT,
  window_1d_start TEXT,
  window_7d_start TEXT,
  ip_whitelist TEXT,
  ip_blacklist TEXT,
  deleted_at TEXT,
  group_type TEXT NOT NULL DEFAULT 'all',
  allowed_vms TEXT NOT NULL DEFAULT '[]',
  vm_pool_id TEXT,
  api_endpoint_id TEXT,
  allowed_models TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_api_keys_deleted_at ON api_keys (deleted_at);
CREATE INDEX IF NOT EXISTS idx_api_keys_expires ON api_keys (expires_at);
CREATE INDEX IF NOT EXISTS idx_api_keys_group ON api_keys (group_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys (key_hash) WHERE key_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_status ON api_keys (status);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id);

CREATE TABLE IF NOT EXISTS backup_records (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  kind TEXT,
  status TEXT NOT NULL,
  file_path TEXT,
  file_name TEXT,
  size_bytes BIGINT,
  sha256 TEXT,
  db_bytes BIGINT,
  includes_json TEXT,
  error TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS cluster_nodes (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  auth_type TEXT NOT NULL CHECK (auth_type IN ('key', 'password')),
  password TEXT,
  private_key TEXT,
  passphrase TEXT,
  host_key_alg TEXT NOT NULL,
  host_key_sha256 TEXT NOT NULL,
  jump_node_id TEXT REFERENCES cluster_nodes (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'linux'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cluster_nodes_endpoint
  ON cluster_nodes (host, port, username);

CREATE TABLE IF NOT EXISTS cluster_node_direct_links (
  node_id TEXT PRIMARY KEY REFERENCES cluster_nodes (id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  port INTEGER NOT NULL,
  token TEXT NOT NULL,
  cert_sha256 TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS crag_shop_orders (
  order_id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL CHECK (length(owner) > 0),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  sku TEXT NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('wxpay', 'alipay')),
  reserved_at BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'pending', 'paid', 'fulfilled')),
  created_at BIGINT,
  term TEXT CHECK (term IN ('1m', '3m', '1y', 'custom', 'monthly')),
  amount_minor BIGINT CHECK (amount_minor > 0),
  slot_limit TEXT CHECK (
    slot_limit IS NULL
    OR slot_limit = 'unlimited'
    OR (slot_limit ~ '^[1-9][0-9]*$' AND slot_limit::bigint BETWEEN 1 AND 2147483647)
  ),
  purchase_json TEXT,
  expected_amount_minor BIGINT CHECK (expected_amount_minor BETWEEN 1 AND 9007199254740991),
  months INTEGER CHECK (months BETWEEN 1 AND 2147483647),
  subtotal_minor BIGINT CHECK (subtotal_minor BETWEEN 0 AND 9007199254740991),
  discount_minor BIGINT CHECK (discount_minor BETWEEN 0 AND 9007199254740991),
  remaining BIGINT CHECK (remaining BETWEEN 0 AND 9007199254740991),
  renewable INTEGER CHECK (renewable IN (0, 1)),
  activation_vm_id TEXT,
  activation_fingerprint TEXT CHECK (
    (activation_vm_id IS NULL AND activation_fingerprint IS NULL)
    OR (
      activation_vm_id IS NOT NULL
      AND activation_fingerprint IS NOT NULL
      AND length(activation_fingerprint) = 64
      AND sku <> 'renewal'
    )
  ),
  activation_phase TEXT NOT NULL DEFAULT 'waiting' CHECK (activation_phase IN ('waiting', 'redeemed', 'active')),
  activation_next_at BIGINT,
  activation_deadline BIGINT,
  activation_attempts INTEGER NOT NULL DEFAULT 0,
  dispatch_state TEXT NOT NULL DEFAULT 'submitted' CHECK (
    dispatch_state IN ('unsent', 'submitted', 'cancelled')
    AND (dispatch_state = 'submitted' OR status = 'reserved')
  ),
  closed_at BIGINT CHECK (closed_at IS NULL OR closed_at > 0),
  redemption_sha256 TEXT CHECK (
    redemption_sha256 IS NULL OR redemption_sha256 ~ '^[0-9a-f]{64}$'
  ),
  device_host TEXT CHECK (
    device_host IS NULL OR device_host ~ '^[0-9a-f]{64}$'
  ),
  activation_error_code TEXT CHECK (
    activation_error_code IS NULL OR activation_error_code ~ '^[a-z][a-z0-9_]{1,63}$'
  ),
  activation_error_recovery TEXT CHECK (
    activation_error_recovery IS NULL
    OR activation_error_recovery IN ('not_activated', 'host_id_collision', 'failed')
  ),
  activation_request_id TEXT CHECK (
    activation_request_id IS NULL
    OR activation_request_id ~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-4[0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$'
  ),
  UNIQUE (owner, request_id),
  CHECK (
    (status = 'reserved' AND created_at IS NULL AND term IS NULL AND amount_minor IS NULL AND slot_limit IS NULL)
    OR (status <> 'reserved' AND created_at IS NOT NULL AND term IS NOT NULL AND amount_minor IS NOT NULL AND slot_limit IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS crag_shop_orders_activation_due
  ON crag_shop_orders (activation_next_at, order_id)
  WHERE activation_vm_id IS NOT NULL AND activation_next_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS crag_shop_orders_owner_recent
  ON crag_shop_orders (owner, reserved_at DESC, order_id DESC);

CREATE TABLE IF NOT EXISTS jev_usage_events (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  request_id TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  http_status INTEGER,
  outcome TEXT NOT NULL,
  duration_ms BIGINT NOT NULL,
  input_tokens BIGINT,
  output_tokens BIGINT,
  estimated_cost_nano_usd BIGINT,
  input_nano_usd_per_token BIGINT,
  output_nano_usd_per_token BIGINT,
  pricing_basis TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jev_usage_key_recent
  ON jev_usage_events (key_fingerprint, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_jev_usage_recent
  ON jev_usage_events (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS jev_usage_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  started_at TEXT NOT NULL
);
INSERT INTO jev_usage_meta (id, started_at)
VALUES (1, to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS jev_usage_totals (
  period TEXT PRIMARY KEY,
  requests BIGINT NOT NULL DEFAULT 0,
  successful BIGINT NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  unknown_usage_requests BIGINT NOT NULL DEFAULT 0,
  estimated_cost_nano_usd BIGINT NOT NULL DEFAULT 0,
  unknown_cost_requests BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS proxies (
  id TEXT PRIMARY KEY,
  protocol TEXT DEFAULT 'socks5',
  host TEXT,
  port INTEGER,
  username TEXT,
  password TEXT,
  raw TEXT,
  status TEXT DEFAULT 'unknown',
  enabled INTEGER DEFAULT 1,
  bound_vm_id TEXT,
  consecutive_failures INTEGER DEFAULT 0,
  latency_ms INTEGER,
  last_probe_at TEXT,
  last_error TEXT,
  created_at TEXT,
  name TEXT NOT NULL DEFAULT '',
  updated_at TEXT,
  deleted_at TEXT,
  owner_user_id TEXT,
  geo_ip TEXT,
  geo_country TEXT,
  geo_country_code TEXT,
  geo_region TEXT,
  geo_city TEXT,
  geo_isp TEXT,
  geo_timezone TEXT,
  geo_checked_at TEXT,
  geo_error TEXT,
  label TEXT,
  geo_v6_ip TEXT,
  geo_v6_country TEXT,
  geo_v6_country_code TEXT,
  geo_v6_region TEXT,
  geo_v6_city TEXT,
  geo_v6_isp TEXT,
  geo_v6_timezone TEXT,
  geo_v6_checked_at TEXT,
  geo_v6_error TEXT,
  domain_forward INTEGER NOT NULL DEFAULT 0,
  dns_disable_svcb_https INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_proxies_deleted_at ON proxies (deleted_at);
CREATE INDEX IF NOT EXISTS idx_proxies_owner ON proxies (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_proxies_status ON proxies (status);

CREATE TABLE IF NOT EXISTS redeem_codes (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'balance',
  value DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unused',
  used_by TEXT,
  used_at TEXT,
  notes TEXT,
  expires_at TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_redeem_codes_status ON redeem_codes (status);
CREATE INDEX IF NOT EXISTS idx_redeem_codes_used_by ON redeem_codes (used_by);

CREATE TABLE IF NOT EXISTS refusal_device_blocks (
  device_id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  hit_count BIGINT NOT NULL DEFAULT 0,
  source_request_id TEXT,
  fingerprint TEXT,
  reason TEXT,
  subject_kind TEXT NOT NULL DEFAULT 'device',
  identity_value TEXT,
  session_id TEXT,
  violations INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_refusal_device_last_seen ON refusal_device_blocks (last_seen_at);

CREATE TABLE IF NOT EXISTS risk_device_aliases (
  alias_key TEXT PRIMARY KEY,
  device_key TEXT NOT NULL REFERENCES refusal_device_blocks (device_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_risk_device_aliases_device ON risk_device_aliases (device_key);

CREATE TABLE IF NOT EXISTS refusal_guards (
  fingerprint TEXT PRIMARY KEY,
  model TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  hit_count BIGINT NOT NULL DEFAULT 0,
  source_request_id TEXT,
  error_message TEXT,
  preview TEXT,
  expires_at TEXT,
  signature TEXT
);
CREATE INDEX IF NOT EXISTS idx_refusal_guards_last_seen ON refusal_guards (last_seen_at);
CREATE INDEX IF NOT EXISTS idx_refusal_guards_model ON refusal_guards (model);

CREATE TABLE IF NOT EXISTS refusal_session_blocks (
  session_id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  hit_count BIGINT NOT NULL DEFAULT 0,
  source_request_id TEXT,
  account_id TEXT,
  model TEXT,
  preview TEXT,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_refusal_session_last_seen ON refusal_session_blocks (last_seen_at);

CREATE TABLE IF NOT EXISTS request_attempts (
  id BIGSERIAL PRIMARY KEY,
  request_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  vm_id TEXT,
  account_id TEXT,
  model TEXT,
  selection_reason TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  upstream_status INTEGER,
  error_scope TEXT,
  action TEXT,
  cooldown_until BIGINT,
  downstream_committed INTEGER NOT NULL DEFAULT 0,
  terminal_state TEXT,
  usage_json TEXT,
  wait_ms BIGINT,
  ttft_ms BIGINT,
  latency_ms BIGINT,
  queue_wait_ms BIGINT CHECK (queue_wait_ms >= 0),
  scheduling_ms BIGINT CHECK (scheduling_ms >= 0)
);
CREATE INDEX IF NOT EXISTS idx_request_attempt_account ON request_attempts (account_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_attempt_request ON request_attempts (request_id, attempt_no);
CREATE UNIQUE INDEX IF NOT EXISTS idx_request_attempt_unique ON request_attempts (request_id, attempt_no);

CREATE TABLE IF NOT EXISTS request_log_debug (
  request_id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  record_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reqdbg_ts ON request_log_debug (ts DESC);

CREATE TABLE IF NOT EXISTS sticky_sessions (
  key TEXT PRIMARY KEY,
  account_id TEXT,
  vm_id TEXT,
  session_id TEXT,
  bound_at BIGINT,
  expires_at BIGINT,
  hits BIGINT DEFAULT 0,
  device_id TEXT,
  generation BIGINT NOT NULL DEFAULT 0,
  slot_index INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sticky_device ON sticky_sessions (device_id);
CREATE INDEX IF NOT EXISTS idx_sticky_expires ON sticky_sessions (expires_at);

CREATE TABLE IF NOT EXISTS usage_logs (
  id TEXT PRIMARY KEY,
  request_id TEXT,
  created_at TEXT NOT NULL,
  log_mode TEXT,
  method TEXT,
  path TEXT,
  protocol TEXT,
  model TEXT,
  stream INTEGER,
  status INTEGER,
  duration_ms BIGINT,
  api_key_kind TEXT,
  api_key_id TEXT,
  vm_id TEXT,
  account_id TEXT,
  workspace TEXT,
  input_tokens BIGINT,
  output_tokens BIGINT,
  error_code TEXT,
  error_message TEXT,
  user_agent TEXT,
  ip_address TEXT,
  has_tools INTEGER,
  via TEXT,
  cache_read_tokens BIGINT,
  cache_creation_tokens BIGINT,
  attempt_count INTEGER,
  final_state TEXT,
  final_account_id TEXT,
  cache_creation_5m_tokens BIGINT,
  cache_creation_1h_tokens BIGINT,
  requested_model TEXT,
  upstream_model TEXT,
  model_mismatch INTEGER,
  first_token_ms BIGINT,
  stop_reason TEXT,
  input_cost DOUBLE PRECISION,
  output_cost DOUBLE PRECISION,
  cache_read_cost DOUBLE PRECISION,
  cache_creation_cost DOUBLE PRECISION,
  total_cost DOUBLE PRECISION,
  pricing_model TEXT,
  api_key_presented TEXT,
  user_id TEXT,
  group_id BIGINT,
  actual_cost DOUBLE PRECISION,
  rate_multiplier DOUBLE PRECISION,
  service_tier TEXT,
  speed TEXT,
  long_context INTEGER,
  session_id TEXT,
  reasoning_effort TEXT,
  outbound_session_id TEXT,
  intercept TEXT,
  vm_owner_user_id TEXT,
  web_search_requests INTEGER NOT NULL DEFAULT 0,
  web_search_cost DOUBLE PRECISION,
  price_source TEXT,
  price_version TEXT,
  inbound_device_id TEXT,
  image_model TEXT,
  image_usage TEXT,
  image_input_tokens BIGINT NOT NULL DEFAULT 0,
  image_output_tokens BIGINT NOT NULL DEFAULT 0,
  image_cost DOUBLE PRECISION,
  first_byte_ms BIGINT,
  generation_ms BIGINT,
  jev_state TEXT,
  upstream_service_tier TEXT,
  usage_account_id TEXT,
  upstream_status INTEGER,
  upstream_400_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_reqlog_account ON usage_logs (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reqlog_cost_ts ON usage_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reqlog_key ON usage_logs (api_key_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reqlog_reqid ON usage_logs (request_id);
CREATE INDEX IF NOT EXISTS idx_reqlog_requested_model ON usage_logs (requested_model);
CREATE INDEX IF NOT EXISTS idx_reqlog_status ON usage_logs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reqlog_ts ON usage_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reqlog_vm ON usage_logs (vm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_logs_created_id ON usage_logs (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_usage_logs_group_created ON usage_logs (group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_logs_inbound_device ON usage_logs (inbound_device_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_logs_outbound_session_created ON usage_logs (outbound_session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_logs_request_id ON usage_logs (request_id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_session_created ON usage_logs (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_logs_upstream_400
  ON usage_logs (created_at DESC, id DESC) WHERE upstream_status = 400;
CREATE INDEX IF NOT EXISTS idx_usage_logs_user_created ON usage_logs (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_logs_vm_owner ON usage_logs (vm_owner_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_logs_pricing_null
  ON usage_logs (id) WHERE pricing_model IS NULL;

CREATE TABLE IF NOT EXISTS vm_pools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vm_pools_name ON vm_pools (LOWER(name));

CREATE TABLE IF NOT EXISTS vm_pool_members (
  pool_id TEXT NOT NULL REFERENCES vm_pools (id) ON DELETE CASCADE,
  vm_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (pool_id, vm_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vm_pool_members_vm ON vm_pool_members (vm_id);

CREATE TABLE IF NOT EXISTS vms (
  id TEXT PRIMARY KEY,
  name TEXT,
  status TEXT,
  schedulable INTEGER DEFAULT 1,
  email TEXT,
  account_uuid TEXT,
  org_uuid TEXT,
  access_token TEXT,
  refresh_token TEXT,
  session_key TEXT,
  oauth_expires_at TEXT,
  oauth_source TEXT,
  proxy_id TEXT,
  claude_code_version TEXT,
  timezone TEXT,
  locale TEXT,
  vm_json TEXT NOT NULL,
  encrypted INTEGER DEFAULT 0,
  file_mtime_ms BIGINT,
  synced_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  owner_user_id TEXT,
  origin TEXT NOT NULL DEFAULT 'platform'
);
CREATE INDEX IF NOT EXISTS idx_vms_account ON vms (account_uuid);
CREATE INDEX IF NOT EXISTS idx_vms_origin ON vms (origin);
CREATE INDEX IF NOT EXISTS idx_vms_owner ON vms (owner_user_id);

-- Thinking block ownership registry (BIGINT created_at for ms epoch)
CREATE TABLE IF NOT EXISTS thinking_signature_owners (
  key TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thinking_owner_created ON thinking_signature_owners (created_at);
