-- 025_usage_logs_pricing_tier — persist the billing band a row was priced at.
--
-- service_tier: OpenAI request/response tier as seen (lowercased, raw).
-- speed:        Anthropic usage.speed, falling back to the request speed.
-- long_context: 1 when the long-context band applied, 0 when not, NULL if unpriced.
-- Backfill needs these to re-price with the original band; without them it
-- would silently fall back to standard rates. Historical rows stay NULL.

ALTER TABLE usage_logs ADD COLUMN service_tier TEXT;
ALTER TABLE usage_logs ADD COLUMN speed TEXT;
ALTER TABLE usage_logs ADD COLUMN long_context INTEGER;
