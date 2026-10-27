-- Upstream SQLite migration 042, adapted to the PostgreSQL migration history.
-- Existing token totals and historical migration checksums stay unchanged.
ALTER TABLE usage_logs ADD COLUMN image_model text;
ALTER TABLE usage_logs ADD COLUMN image_usage text;
ALTER TABLE usage_logs ADD COLUMN image_input_tokens bigint NOT NULL DEFAULT 0;
ALTER TABLE usage_logs ADD COLUMN image_output_tokens bigint NOT NULL DEFAULT 0;
ALTER TABLE usage_logs ADD COLUMN image_cost double precision;
