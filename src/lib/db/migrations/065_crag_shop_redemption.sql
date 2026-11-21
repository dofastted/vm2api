-- Associate a device order with the exact voucher before redeeming it. The voucher
-- itself remains private; signed local redemption receipts prove completion after
-- a crash or an administrator's subscription recovery.
ALTER TABLE crag_shop_orders ADD COLUMN redemption_sha256 TEXT
  CHECK (redemption_sha256 IS NULL OR
    (length(redemption_sha256) = 64 AND redemption_sha256 NOT GLOB '*[^0-9a-f]*'));
