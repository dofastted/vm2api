-- Record sanitized failure diagnostics when an automatic CRAG order activation attempt fails.
--
-- Only validated identifier codes, bounded non-transient credential-recovery causes, and
-- UUID v4 correlation IDs may be stored here; raw supplier/Authority error messages,
-- vouchers, bearer secrets, and local paths are never persisted.
ALTER TABLE crag_shop_orders ADD COLUMN activation_error_code TEXT
  CHECK (activation_error_code IS NULL OR
    (length(activation_error_code) BETWEEN 2 AND 64 AND
     activation_error_code GLOB '[a-z]*' AND
     activation_error_code NOT GLOB '*[^a-z0-9_]*'));
ALTER TABLE crag_shop_orders ADD COLUMN activation_error_recovery TEXT
  CHECK (activation_error_recovery IS NULL OR
    activation_error_recovery IN ('not_activated', 'host_id_collision', 'failed'));
ALTER TABLE crag_shop_orders ADD COLUMN activation_request_id TEXT
  CHECK (activation_request_id IS NULL OR
    (length(activation_request_id) = 36 AND
     length(replace(activation_request_id, '-', '')) = 32 AND
     substr(activation_request_id, 9, 1) = '-' AND
     substr(activation_request_id, 14, 2) = '-4' AND
     substr(activation_request_id, 19, 1) = '-' AND
     substr(activation_request_id, 20, 1) GLOB '[89ABab]' AND
     substr(activation_request_id, 24, 1) = '-' AND
     replace(activation_request_id, '-', '') NOT GLOB '*[^0-9A-Fa-f]*'));
