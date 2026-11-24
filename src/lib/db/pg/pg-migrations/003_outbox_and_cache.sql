-- 003_outbox_and_cache.sql
-- Transactional outbox tables inspired by sub2api (036_scheduler_outbox.sql)
-- to guarantee reliable multi-instance scheduler & auth cache invalidation.

CREATE TABLE IF NOT EXISTS scheduler_outbox (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  account_id TEXT,
  group_id BIGINT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scheduler_outbox_created ON scheduler_outbox (created_at);

CREATE TABLE IF NOT EXISTS auth_cache_invalidation_outbox (
  id BIGSERIAL PRIMARY KEY,
  key_hash TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'updated',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_cache_outbox_created ON auth_cache_invalidation_outbox (created_at);
