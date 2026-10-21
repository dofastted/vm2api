CREATE TABLE execution_admissions (
  id text COLLATE "C" PRIMARY KEY,
  owner_id text COLLATE "C" NOT NULL,
  request_id text COLLATE "C" NOT NULL,
  account_id text COLLATE "C" NOT NULL,
  vm_id text COLLATE "C" NOT NULL,
  model_family text COLLATE "C",
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  uncertain_at timestamptz,
  released_at timestamptz,
  seat_key text COLLATE "C",
  seat_generation text COLLATE "C",
  slot_index integer
);

CREATE INDEX idx_execution_admissions_account_window ON execution_admissions (account_id, created_at);
CREATE INDEX idx_execution_admissions_account_active ON execution_admissions (account_id) WHERE released_at IS NULL;
CREATE INDEX idx_execution_admissions_vm_active ON execution_admissions (vm_id) WHERE released_at IS NULL;
CREATE INDEX idx_execution_admissions_seat_active ON execution_admissions (seat_key, seat_generation) WHERE released_at IS NULL;

-- No TTL or cascading resource deletion can prove that execution ended.
-- Released rows remain RPM history until their complete minute has elapsed.
