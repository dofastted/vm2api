CREATE TABLE session_turns (
  sequence bigserial PRIMARY KEY,
  id text COLLATE "C" NOT NULL UNIQUE,
  session_key text COLLATE "C" NOT NULL,
  owner_id text COLLATE "C" NOT NULL,
  request_id text COLLATE "C",
  state text COLLATE "C" NOT NULL CHECK (state IN ('waiting', 'active')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  activated_at timestamptz,
  uncertain_at timestamptz
);

CREATE INDEX idx_session_turns_queue ON session_turns (session_key, sequence);
CREATE UNIQUE INDEX idx_session_turns_active ON session_turns (session_key) WHERE state = 'active';

-- Active turns have no expiry: losing an owner connection does not end its execution.
