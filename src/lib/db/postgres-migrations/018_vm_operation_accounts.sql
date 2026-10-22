-- Account-wide credential changes exclude executions on every VM for that account.
ALTER TABLE vm_operations ADD COLUMN account_id text;

CREATE INDEX vm_operations_active_account
  ON vm_operations (account_id)
  WHERE released_at IS NULL AND account_id IS NOT NULL;
