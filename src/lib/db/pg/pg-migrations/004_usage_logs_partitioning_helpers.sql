-- 004_usage_logs_partitioning_helpers.sql
-- Maintenance & observability helpers inspired by sub2api (035_usage_logs_partitioning.sql).
-- Preserves full unique request_id and upsert compatibility while adding fast analytics
-- indexes and a safe retention/table-stats helper function.

CREATE INDEX IF NOT EXISTS idx_usage_logs_model_created
  ON usage_logs (model, created_at DESC)
  WHERE model IS NOT NULL AND model <> '';

CREATE INDEX IF NOT EXISTS idx_usage_logs_api_key_status_created
  ON usage_logs (api_key_id, status, created_at DESC)
  WHERE api_key_id IS NOT NULL;

CREATE OR REPLACE FUNCTION vm2api_table_sizes()
RETURNS TABLE (
  table_name TEXT,
  total_bytes BIGINT,
  table_bytes BIGINT,
  index_bytes BIGINT,
  est_rows BIGINT
)
LANGUAGE SQL
STABLE
AS $$
  SELECT
    c.relname::TEXT AS table_name,
    pg_total_relation_size(c.oid)::BIGINT AS total_bytes,
    pg_relation_size(c.oid)::BIGINT AS table_bytes,
    pg_indexes_size(c.oid)::BIGINT AS index_bytes,
    GREATEST(c.reltuples::BIGINT, 0) AS est_rows
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema()
    AND c.relkind IN ('r', 'p')
  ORDER BY pg_total_relation_size(c.oid) DESC;
$$;
