CREATE TABLE api_key_admissions (
  id text COLLATE "C" PRIMARY KEY,
  key_id text COLLATE "C" NOT NULL,
  user_id text COLLATE "C",
  owner_id text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  released_at timestamptz
);

CREATE INDEX idx_api_key_admissions_key_window ON api_key_admissions (key_id, created_at);
CREATE INDEX idx_api_key_admissions_key_active ON api_key_admissions (key_id) WHERE released_at IS NULL;
CREATE INDEX idx_api_key_admissions_user_active ON api_key_admissions (user_id) WHERE released_at IS NULL;

-- A reservation has no expiry: an old request may still execute upstream.
-- owner_id identifies the controller for a future fenced recovery protocol.
-- Key deletion must retain an executing request's user concurrency reservation.
