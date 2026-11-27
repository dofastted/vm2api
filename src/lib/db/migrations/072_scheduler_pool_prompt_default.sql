-- 072_scheduler_pool_prompt_default — Repair untouched legacy vm_pools backfill rows
-- that inherited the 071 DDL default ('passthrough') instead of 'inherit_global'.
-- Manually edited pools have config_version > 1 and are preserved untouched;
-- pools created directly in scheduler_pools (not in vm_pools) are untouched.

UPDATE scheduler_pools
SET system_prompt_mode = 'inherit_global'
WHERE system_prompt_mode = 'passthrough'
  AND provider_scope = 'anthropic'
  AND config_version = 1
  AND EXISTS (SELECT 1 FROM vm_pools v WHERE v.id = scheduler_pools.id);
