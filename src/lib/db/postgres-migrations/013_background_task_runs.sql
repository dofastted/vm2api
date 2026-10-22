CREATE TABLE background_task_runs (
  task_key text COLLATE "C" NOT NULL,
  execution_id text COLLATE "C" NOT NULL,
  owner_id text COLLATE "C" NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  unknown_at timestamptz,
  finished_at timestamptz,
  shared_result jsonb,
  PRIMARY KEY (task_key, execution_id)
);

-- A new schedule cannot prove that an older remote side effect has ended.
CREATE UNIQUE INDEX idx_background_task_active ON background_task_runs (task_key) WHERE finished_at IS NULL;
