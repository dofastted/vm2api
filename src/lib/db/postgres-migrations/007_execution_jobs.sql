CREATE TABLE execution_jobs (
  request_id text COLLATE "C" PRIMARY KEY,
  admission_id text COLLATE "C" NOT NULL REFERENCES execution_admissions (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  started boolean,
  reason text COLLATE "C"
);

CREATE INDEX idx_execution_jobs_admission_pending ON execution_jobs (admission_id) WHERE ended_at IS NULL;

-- Binding happens before submission; NULL started means it is not yet known.
-- Pending jobs have no expiry. Admission history is removed only after release.
