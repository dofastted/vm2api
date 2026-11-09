-- 054_api_keys_allowed_models — optional per-key model allowlist.
-- JSON array of model names the client may send (exact, case-insensitive, before any mapping).
-- '[]' = no limit, so existing keys keep every model.

ALTER TABLE api_keys ADD COLUMN allowed_models TEXT NOT NULL DEFAULT '[]';
