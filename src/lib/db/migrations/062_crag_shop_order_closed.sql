-- Closing an unpaid order locally cannot use dispatch_state: migration 060 constrains
-- 'cancelled' to status = 'reserved', so a submitted order that reached 'pending' can
-- never be marked there. The supplier protocol has no cancel endpoint and no expired
-- state, so an unpaid checkout link has to be closed on this side.
--
-- closed_at records that decision without rewriting the order's real dispatch/status
-- history, and clearing it restores the order if the buyer pays late.
ALTER TABLE crag_shop_orders ADD COLUMN closed_at INTEGER
  CHECK (closed_at IS NULL OR closed_at > 0);
