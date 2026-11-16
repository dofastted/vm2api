ALTER TABLE refusal_device_blocks ADD COLUMN subject_kind TEXT NOT NULL DEFAULT 'device';
ALTER TABLE refusal_device_blocks ADD COLUMN identity_value TEXT;
ALTER TABLE refusal_device_blocks ADD COLUMN session_id TEXT;
ALTER TABLE refusal_device_blocks ADD COLUMN violations INTEGER NOT NULL DEFAULT 1;
ALTER TABLE refusal_device_blocks ADD COLUMN expires_at TEXT;

CREATE TABLE risk_device_aliases (
  alias_key TEXT PRIMARY KEY,
  device_key TEXT NOT NULL REFERENCES refusal_device_blocks(device_id) ON DELETE CASCADE
);
CREATE INDEX idx_risk_device_aliases_device ON risk_device_aliases(device_key);

ALTER TABLE usage_logs ADD COLUMN upstream_status INTEGER;
ALTER TABLE usage_logs ADD COLUMN upstream_400_message TEXT;
CREATE INDEX idx_usage_logs_upstream_400 ON usage_logs(created_at DESC, id DESC) WHERE upstream_status = 400;
CREATE INDEX idx_usage_logs_request_id ON usage_logs(request_id);
