-- 073_api_endpoint_body_policy_default — Backfill existing api_endpoints rows
-- that inherited the 063 DDL/store default ('persona') instead of 'caller'.

UPDATE api_endpoints
SET body_policy = 'caller'
WHERE body_policy = 'persona';
