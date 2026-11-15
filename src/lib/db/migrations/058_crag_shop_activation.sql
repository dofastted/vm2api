-- NULL VM IDs identify manual orders, including all orders from earlier schema versions.
ALTER TABLE crag_shop_orders ADD COLUMN activation_vm_id TEXT;
ALTER TABLE crag_shop_orders ADD COLUMN activation_fingerprint TEXT
  CHECK ((activation_vm_id IS NULL AND activation_fingerprint IS NULL) OR
         (activation_vm_id IS NOT NULL AND activation_fingerprint IS NOT NULL AND
          length(activation_fingerprint) = 64 AND sku <> 'renewal'));
ALTER TABLE crag_shop_orders ADD COLUMN activation_phase TEXT NOT NULL DEFAULT 'waiting'
  CHECK (activation_phase IN ('waiting', 'redeemed', 'active'));
ALTER TABLE crag_shop_orders ADD COLUMN activation_next_at INTEGER;
ALTER TABLE crag_shop_orders ADD COLUMN activation_deadline INTEGER;
ALTER TABLE crag_shop_orders ADD COLUMN activation_attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX crag_shop_orders_activation_due ON crag_shop_orders(activation_next_at, order_id)
  WHERE activation_vm_id IS NOT NULL AND activation_next_at IS NOT NULL;
