CREATE TABLE claude_subscriptions (
  vm_id text PRIMARY KEY REFERENCES vms(id) ON DELETE CASCADE,
  account_uuid text NOT NULL,
  org_uuid text NOT NULL,
  version uuid NOT NULL,
  encrypted_session_key text NOT NULL,
  snapshot jsonb NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error text
);
