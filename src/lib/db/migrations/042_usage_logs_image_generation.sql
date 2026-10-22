-- 042_usage_logs_image_generation — GPT image generation usage and cost.
-- image_usage keeps the raw `tool_usage.image_gen` / Images `usage` JSON so a reprice can split
-- text and image tokens again. Text-model token columns and PROMPT/TOTAL aggregates are unchanged.
-- Historical rows: image_* NULL / 0.

ALTER TABLE usage_logs ADD COLUMN image_model TEXT;
ALTER TABLE usage_logs ADD COLUMN image_usage TEXT;
ALTER TABLE usage_logs ADD COLUMN image_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_logs ADD COLUMN image_output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_logs ADD COLUMN image_cost REAL;
