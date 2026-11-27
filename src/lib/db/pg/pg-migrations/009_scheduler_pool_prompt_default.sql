-- 009_scheduler_pool_prompt_default — Align scheduler_pools.system_prompt_mode DDL default
-- with non-locked provider default ('inherit_global') and repair untouched legacy
-- vm_pools backfill rows that inherited the 008 'passthrough' DDL default.

ALTER TABLE scheduler_pools
  ALTER COLUMN system_prompt_mode SET DEFAULT 'inherit_global';

UPDATE scheduler_pools
SET system_prompt_mode = 'inherit_global'
WHERE system_prompt_mode = 'passthrough'
  AND provider_scope = 'anthropic'
  AND config_version = 1
  AND EXISTS (SELECT 1 FROM vm_pools v WHERE v.id = scheduler_pools.id);
