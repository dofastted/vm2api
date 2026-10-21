ALTER TABLE execution_jobs ADD COLUMN billing_snapshot jsonb;
ALTER TABLE execution_jobs ADD COLUMN node_receipt jsonb;
ALTER TABLE ha_request_contexts ADD COLUMN billable_command_id text COLLATE "C";

-- Keep the audit when a key or short-lived admission/job history is deleted.
-- Their exact IDs and original node evidence are copied while those rows are locked.
CREATE TABLE ha_request_settlements (
  ha_request_id text COLLATE "C" PRIMARY KEY REFERENCES ha_request_contexts(id),
  reservation_id text COLLATE "C" NOT NULL UNIQUE,
  key_id text COLLATE "C" NOT NULL,
  user_id text COLLATE "C",
  command_id text COLLATE "C",
  node_binding jsonb,
  node_receipt jsonb,
  billing_snapshot jsonb,
  outcome text NOT NULL CHECK (outcome IN ('charged','key_deleted','already_settled','not_dispatched')),
  official_cost double precision,
  actual_cost double precision,
  tokens_in bigint,
  tokens_out bigint,
  cache_read_tokens bigint,
  cache_creation_tokens bigint,
  settled_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
