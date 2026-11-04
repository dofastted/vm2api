ALTER TABLE api_endpoints ADD COLUMN risk_review_enabled INTEGER NOT NULL DEFAULT 0 CHECK (risk_review_enabled IN (0, 1));
