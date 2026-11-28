-- 010_api_endpoint_body_policy_default — Align api_endpoints.body_policy DDL default
-- with 'caller' (raw body passthrough) and backfill existing 'persona' rows.

ALTER TABLE api_endpoints
  ALTER COLUMN body_policy SET DEFAULT 'caller';

UPDATE api_endpoints
SET body_policy = 'caller'
WHERE body_policy = 'persona';
