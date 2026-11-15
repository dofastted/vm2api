CREATE TABLE crag_shop_orders_commerce (
  order_id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL CHECK (length(owner) > 0),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  sku TEXT NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('wxpay', 'alipay')),
  reserved_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'pending', 'paid', 'fulfilled')),
  created_at INTEGER,
  term TEXT CHECK (term IN ('1m', '3m', '1y', 'custom', 'monthly')),
  amount_minor INTEGER CHECK (amount_minor > 0),
  slot_limit ANY CHECK (slot_limit = 'unlimited' OR (typeof(slot_limit) = 'integer' AND slot_limit BETWEEN 1 AND 2147483647)),
  purchase_json TEXT,
  expected_amount_minor INTEGER CHECK (expected_amount_minor BETWEEN 1 AND 9007199254740991),
  months INTEGER CHECK (months BETWEEN 1 AND 2147483647),
  subtotal_minor INTEGER CHECK (subtotal_minor BETWEEN 0 AND 9007199254740991),
  discount_minor INTEGER CHECK (discount_minor BETWEEN 0 AND 9007199254740991),
  remaining INTEGER CHECK (remaining BETWEEN 0 AND 9007199254740991),
  renewable INTEGER CHECK (renewable IN (0, 1)),
  UNIQUE (owner, request_id),
  CHECK ((status = 'reserved' AND created_at IS NULL AND term IS NULL AND amount_minor IS NULL AND slot_limit IS NULL) OR
         (status <> 'reserved' AND created_at IS NOT NULL AND term IS NOT NULL AND amount_minor IS NOT NULL AND slot_limit IS NOT NULL))
) STRICT;

INSERT INTO crag_shop_orders_commerce
  (order_id, owner, request_id, sku, payment_method, reserved_at, status, created_at, term, amount_minor, slot_limit)
SELECT order_id, owner, request_id, sku, payment_method, reserved_at, status, created_at, term, amount_minor, slot_limit
FROM crag_shop_orders;

DROP TABLE crag_shop_orders;
ALTER TABLE crag_shop_orders_commerce RENAME TO crag_shop_orders;
CREATE INDEX crag_shop_orders_owner_recent ON crag_shop_orders(owner, reserved_at DESC, order_id DESC);
