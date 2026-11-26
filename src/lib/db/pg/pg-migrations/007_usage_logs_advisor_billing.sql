-- 007_usage_logs_advisor_billing — PostgreSQL parity for per-model advisor_message
-- usage detail and independent advisor_cost billing.

ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS advisor_usage TEXT;
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS advisor_cost DOUBLE PRECISION;
