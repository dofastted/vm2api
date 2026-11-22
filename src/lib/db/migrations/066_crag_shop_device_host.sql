-- Record which host a device order was bought for, so an order can be recovered onto
-- the same machine after its checkout cookie is gone.
--
-- A device order's owner is sha256(host_id:cookie_token), which binds it to one browser
-- and cannot be reversed. Losing the cookie therefore orphaned the order permanently:
-- it disappeared from the listing and could no longer be applied, so a paid order could
-- never be delivered. The order id is a randomUUID and acts as the buyer's own proof,
-- but without this column there is no way to confirm that the order belongs to the
-- machine asking for it, and entitlements only ever apply to the host that bought them.
--
-- Orders created before this column exists keep NULL. They are recovered on the order id
-- alone, and the host is recorded at that point.
ALTER TABLE crag_shop_orders ADD COLUMN device_host TEXT
  CHECK (device_host IS NULL OR
    (length(device_host) = 64 AND device_host NOT GLOB '*[^0-9a-f]*'));
