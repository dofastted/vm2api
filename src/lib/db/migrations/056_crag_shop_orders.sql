CREATE TABLE crag_shop_orders (
  order_id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL CHECK (length(owner) > 0),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  sku TEXT NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('wxpay', 'alipay')),
  reserved_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'pending', 'paid', 'fulfilled')),
  created_at INTEGER,
  term TEXT CHECK (term IN ('1m', '3m', '1y')),
  amount_minor INTEGER CHECK (amount_minor > 0),
  slot_limit ANY CHECK (slot_limit = 'unlimited' OR (typeof(slot_limit) = 'integer' AND slot_limit BETWEEN 1 AND 2147483647)),
  UNIQUE (owner, request_id),
  CHECK ((status = 'reserved' AND created_at IS NULL AND term IS NULL AND amount_minor IS NULL AND slot_limit IS NULL) OR
         (status <> 'reserved' AND created_at IS NOT NULL AND term IS NOT NULL AND amount_minor IS NOT NULL AND slot_limit IS NOT NULL))
) STRICT;

CREATE INDEX crag_shop_orders_owner_recent ON crag_shop_orders(owner, reserved_at DESC, order_id DESC);
