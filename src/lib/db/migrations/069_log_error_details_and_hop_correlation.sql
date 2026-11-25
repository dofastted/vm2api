-- 069_log_error_details_and_hop_correlation — persist safe scalar error
-- metadata (upstream_type, #1705 partial-continuation fields, 410 reason) on
-- normal usage_logs & request_attempts rows, plus per-hop & providerResult
-- correlation IDs on request_attempts (Refs #1845).
--
-- Purely additive nullable columns so SQLite blue-green upgrades stay online.

ALTER TABLE usage_logs ADD COLUMN upstream_type TEXT;
ALTER TABLE usage_logs ADD COLUMN error_details TEXT;

ALTER TABLE request_attempts ADD COLUMN error_code TEXT;
ALTER TABLE request_attempts ADD COLUMN upstream_type TEXT;
ALTER TABLE request_attempts ADD COLUMN error_details_json TEXT;
ALTER TABLE request_attempts ADD COLUMN hop_request_id TEXT;
ALTER TABLE request_attempts ADD COLUMN provider_run_id TEXT;
ALTER TABLE request_attempts ADD COLUMN provider_turn_id TEXT;
ALTER TABLE request_attempts ADD COLUMN provider_attempt_id INTEGER;
ALTER TABLE request_attempts ADD COLUMN provider_request_id TEXT;
