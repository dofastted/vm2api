CREATE TABLE execution_circuits (
  account_id text COLLATE "C" PRIMARY KEY,
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  open_until timestamptz,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  probe_admission_id text COLLATE "C"
);

ALTER TABLE execution_admissions ADD COLUMN circuit_revision bigint;
ALTER TABLE execution_admissions ADD COLUMN circuit_outcome text
  CHECK (circuit_outcome IN ('failure', 'success', 'neutral'));
