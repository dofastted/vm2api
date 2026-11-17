ALTER TABLE crag_shop_orders ADD COLUMN dispatch_state TEXT NOT NULL DEFAULT 'submitted'
  CHECK (dispatch_state IN ('unsent', 'submitted', 'cancelled') AND
    (dispatch_state = 'submitted' OR status = 'reserved'));
