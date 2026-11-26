-- 070_usage_logs_advisor_billing — Per-model advisor_message usage detail and cost.
-- Anthropic's top-level usage counts the executor model alone; each advisor_message
-- iteration bills independently at its own model's rates. advisor_usage stores the
-- grouped per-model breakdown JSON so backfill / repriceRange can recompute advisor_cost
-- without altering executor token columns. Historical rows: NULL.

ALTER TABLE usage_logs ADD COLUMN advisor_usage TEXT;
ALTER TABLE usage_logs ADD COLUMN advisor_cost REAL;
