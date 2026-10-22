CREATE TABLE vm_operations (
  id text COLLATE "C" PRIMARY KEY,
  vm_id text COLLATE "C" NOT NULL,
  owner_id text COLLATE "C" NOT NULL,
  kind text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  uncertain_at timestamptz,
  released_at timestamptz
);

-- Neither elapsed time nor a controller disconnect proves remote mutation ended.
CREATE UNIQUE INDEX idx_vm_operations_vm_active ON vm_operations (vm_id) WHERE released_at IS NULL;
