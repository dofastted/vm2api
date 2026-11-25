-- 006_log_error_details_and_hop_correlation — PostgreSQL parity for safe
-- scalar error metadata and kernel hop / providerResult correlation IDs
-- (Refs #1845).

ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS upstream_type TEXT;
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS error_details TEXT;

ALTER TABLE request_attempts ADD COLUMN IF NOT EXISTS error_code TEXT;
ALTER TABLE request_attempts ADD COLUMN IF NOT EXISTS upstream_type TEXT;
ALTER TABLE request_attempts ADD COLUMN IF NOT EXISTS error_details_json TEXT;
ALTER TABLE request_attempts ADD COLUMN IF NOT EXISTS hop_request_id TEXT;
ALTER TABLE request_attempts ADD COLUMN IF NOT EXISTS provider_run_id TEXT;
ALTER TABLE request_attempts ADD COLUMN IF NOT EXISTS provider_turn_id TEXT;
ALTER TABLE request_attempts ADD COLUMN IF NOT EXISTS provider_attempt_id BIGINT;
ALTER TABLE request_attempts ADD COLUMN IF NOT EXISTS provider_request_id TEXT;
