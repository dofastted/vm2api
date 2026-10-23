-- Count one durable root assignment per account, independently of short-lived seats.
-- Existing binding keys, destinations and TTLs are unchanged. A resumed root is
-- marked only after the request identifies its exact family binding.
ALTER TABLE sticky_sessions ADD COLUMN assignment_root INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_sticky_root_load ON sticky_sessions(account_id, expires_at)
  WHERE assignment_root = 1;
