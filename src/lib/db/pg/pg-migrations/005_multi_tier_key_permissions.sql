-- 005_multi_tier_key_permissions — PostgreSQL parity for multi-tier key
-- permissions and two-way owner isolation across API endpoints & Gemini envs.

ALTER TABLE api_endpoints ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_api_endpoints_owner ON api_endpoints (owner_user_id);

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS permission_tier TEXT NOT NULL DEFAULT 'platform';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS owner_id TEXT;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS allowed_endpoints TEXT NOT NULL DEFAULT '[]';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS allowed_gemini_envs TEXT NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS idx_api_keys_owner_id ON api_keys (owner_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_permission_tier ON api_keys (permission_tier);

CREATE TABLE IF NOT EXISTS gemini_environment_owners (
  env_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_gemini_env_owners_user ON gemini_environment_owners (owner_user_id);
