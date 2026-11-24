-- 002_dashboard_aggregation.sql
-- Pre-aggregated hourly & daily dashboard tables inspired by sub2api
-- (034_usage_dashboard_aggregation_tables.sql). Keeps dashboard & trend
-- queries fast even at millions of usage_logs rows.

CREATE TABLE IF NOT EXISTS usage_dashboard_hourly (
  bucket_start TIMESTAMPTZ PRIMARY KEY,
  total_requests BIGINT NOT NULL DEFAULT 0,
  error_requests BIGINT NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  total_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  actual_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_duration_ms BIGINT NOT NULL DEFAULT 0,
  duration_count BIGINT NOT NULL DEFAULT 0,
  active_users BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS usage_dashboard_daily (
  bucket_date DATE PRIMARY KEY,
  total_requests BIGINT NOT NULL DEFAULT 0,
  error_requests BIGINT NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  total_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  actual_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_duration_ms BIGINT NOT NULL DEFAULT 0,
  duration_count BIGINT NOT NULL DEFAULT 0,
  active_users BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS usage_dashboard_hourly_users (
  bucket_start TIMESTAMPTZ NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (bucket_start, user_id)
);
CREATE INDEX IF NOT EXISTS idx_udh_users_bucket ON usage_dashboard_hourly_users (bucket_start);

CREATE TABLE IF NOT EXISTS usage_dashboard_daily_users (
  bucket_date DATE NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (bucket_date, user_id)
);
CREATE INDEX IF NOT EXISTS idx_udd_users_bucket ON usage_dashboard_daily_users (bucket_date);

CREATE TABLE IF NOT EXISTS usage_dashboard_hourly_models (
  bucket_start TIMESTAMPTZ NOT NULL,
  model TEXT NOT NULL,
  total_requests BIGINT NOT NULL DEFAULT 0,
  error_requests BIGINT NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  total_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  actual_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_start, model)
);
CREATE INDEX IF NOT EXISTS idx_udh_models_bucket ON usage_dashboard_hourly_models (bucket_start DESC);

CREATE TABLE IF NOT EXISTS usage_dashboard_aggregation_watermark (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_aggregated_at TEXT NOT NULL DEFAULT '',
  last_aggregated_id TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO usage_dashboard_aggregation_watermark (id, last_aggregated_at, last_aggregated_id)
VALUES (1, '', '')
ON CONFLICT (id) DO NOTHING;
