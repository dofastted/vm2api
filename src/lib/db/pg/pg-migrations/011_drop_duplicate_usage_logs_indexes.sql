-- 011_drop_duplicate_usage_logs_indexes.sql
-- Drop strictly duplicate non-constraint indexes on usage_logs to reduce
-- PostgreSQL write amplification on high-throughput request logging:
--   1. idx_reqlog_cost_ts (created_at DESC) duplicates idx_reqlog_ts (created_at DESC)
--   2. idx_usage_logs_request_id (request_id) duplicates UNIQUE idx_reqlog_reqid (request_id)
--
-- Neither dropped index backs a primary key, unique constraint, or ON CONFLICT
-- target (idx_reqlog_reqid remains intact for ON CONFLICT (request_id)).

DROP INDEX IF EXISTS idx_reqlog_cost_ts;
DROP INDEX IF EXISTS idx_usage_logs_request_id;
