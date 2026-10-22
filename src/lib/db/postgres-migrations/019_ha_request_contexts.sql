CREATE TABLE ha_request_contexts (
  id text COLLATE "C" PRIMARY KEY,
  activity_id text COLLATE "C" NOT NULL,
  activity_owner_id text COLLATE "C" NOT NULL,
  activity_epoch bigint NOT NULL CHECK (activity_epoch > 0),
  accepting_children boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  handler_returned_at timestamptz
);

-- Private coordination tables deliberately are not foreign-key dependencies:
-- a business-schema restore must not replace the maintenance authority.
ALTER TABLE api_key_admissions ADD COLUMN ha_request_id text COLLATE "C" REFERENCES ha_request_contexts(id);
ALTER TABLE session_turns ADD COLUMN ha_request_id text COLLATE "C" REFERENCES ha_request_contexts(id);
ALTER TABLE execution_admissions ADD COLUMN ha_request_id text COLLATE "C" REFERENCES ha_request_contexts(id);
ALTER TABLE request_attempts ADD COLUMN ha_request_id text COLLATE "C" REFERENCES ha_request_contexts(id);
ALTER TABLE execution_jobs ADD COLUMN ha_request_id text COLLATE "C" REFERENCES ha_request_contexts(id);
ALTER TABLE execution_jobs ADD COLUMN attempt_no integer CHECK (attempt_no > 0);

CREATE UNIQUE INDEX idx_api_key_admissions_ha_request ON api_key_admissions(ha_request_id) WHERE ha_request_id IS NOT NULL;
CREATE INDEX idx_session_turns_ha_request ON session_turns(ha_request_id) WHERE ha_request_id IS NOT NULL;
CREATE INDEX idx_execution_admissions_ha_request ON execution_admissions(ha_request_id) WHERE ha_request_id IS NOT NULL;
CREATE INDEX idx_request_attempts_ha_request ON request_attempts(ha_request_id, attempt_no) WHERE ha_request_id IS NOT NULL;
CREATE INDEX idx_execution_jobs_ha_request ON execution_jobs(ha_request_id, attempt_no) WHERE ha_request_id IS NOT NULL;
