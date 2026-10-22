CREATE TABLE execution_seats (
  seat_key text COLLATE "C" PRIMARY KEY,
  generation text COLLATE "C" NOT NULL UNIQUE,
  vm_id text COLLATE "C" NOT NULL,
  account_id text COLLATE "C" NOT NULL,
  slot_index integer NOT NULL CHECK (slot_index >= 0),
  grace_ms integer NOT NULL CHECK (grace_ms >= 0 AND grace_ms <= 120000),
  grace_until timestamptz,
  UNIQUE (vm_id, slot_index)
);

CREATE INDEX idx_execution_seats_vm ON execution_seats (vm_id);
