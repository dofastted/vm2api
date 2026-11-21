ALTER TABLE api_endpoints ADD COLUMN body_policy TEXT NOT NULL DEFAULT 'persona' CHECK (body_policy IN ('persona', 'caller'));
