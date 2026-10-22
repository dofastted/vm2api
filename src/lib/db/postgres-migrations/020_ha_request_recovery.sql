ALTER TABLE ha_request_contexts ADD COLUMN recovery_kind text
  CHECK (recovery_kind IS NULL OR recovery_kind = 'claude_messages');
ALTER TABLE ha_request_contexts ADD COLUMN recovery_sealed_at timestamptz;
ALTER TABLE ha_request_contexts ADD COLUMN recovery_sealed_by text COLLATE "C";
ALTER TABLE ha_request_contexts ADD COLUMN execution_recovered_at timestamptz;
