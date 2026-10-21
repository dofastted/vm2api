-- Stable ordering for observing a refresh attempt across controller processes.
-- The identity sequence belongs to the existing table and follows schema backups.
ALTER TABLE background_task_runs
  ADD COLUMN claim_sequence bigint GENERATED ALWAYS AS IDENTITY;

CREATE INDEX background_task_runs_latest
  ON background_task_runs (task_key, claim_sequence DESC);
