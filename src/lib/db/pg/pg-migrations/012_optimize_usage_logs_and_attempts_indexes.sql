-- 012_optimize_usage_logs_and_attempts_indexes.sql
-- Production-safe, idempotent index optimization for high-throughput (10K-20K RPM)
-- PostgreSQL logging without table rewrites or destructive partitioning lockups.
--
-- ============================================================================
-- 1. request_attempts: drop strictly duplicate non-unique index
-- ============================================================================
--   - DROP idx_request_attempt_request (request_id, attempt_no)
--     100% duplicate of UNIQUE idx_request_attempt_unique (request_id, attempt_no),
--     which already backs ON CONFLICT (request_id, attempt_no) and all request_id
--     lookups/ordering in request-attempts-repo.mjs and usage-logs-view.mjs.
--   - Preserved on request_attempts (3 total):
--       1. request_attempts_pkey (id)
--       2. idx_request_attempt_unique UNIQUE (request_id, attempt_no)
--       3. idx_request_attempt_account (account_id, started_at DESC)
DROP INDEX IF EXISTS idx_request_attempt_request;

-- ============================================================================
-- 2. usage_logs: trim redundant & low-selectivity indexes (18 -> 9 secondary)
-- ============================================================================
-- Audited against usage-logs-view.mjs, usage-logs-repo.mjs, statistics-repo.mjs,
-- dashboard-aggregator.mjs, warmup-monitor.mjs, and pg-log-writer.mjs:
--
--   - DROP idx_reqlog_ts (created_at DESC)
--     Strict left-prefix duplicate of idx_usage_logs_created_id (created_at DESC, id DESC).
--     All created_at range scans, ORDER BY created_at DESC, and retention pruning use
--     idx_usage_logs_created_id identically.
--   - DROP idx_reqlog_requested_model (requested_model)
--     Low-cardinality (~5-20 models) single-column index without created_at; never
--     queried standalone (panel model filter uses OR across model/requested_model).
--   - DROP idx_reqlog_status (status, created_at DESC)
--     Ultra-low cardinality (status=200 on 95-99% of traffic creates hot leaf contention
--     on every INSERT). Keyset pagination uses idx_usage_logs_created_id; ERROR_PRED is
--     an OR across status and error_code that cannot use this index alone.
--   - DROP idx_usage_logs_group_created (group_id, created_at)
--     Unused: zero WHERE group_id predicates against usage_logs in the codebase.
--   - DROP idx_usage_logs_inbound_device (inbound_device_id, created_at)
--     Unused: zero WHERE inbound_device_id predicates against usage_logs in the codebase.
--   - DROP idx_usage_logs_api_key_status_created (api_key_id, status, created_at DESC)
--     Redundant with idx_reqlog_key (api_key_id, created_at DESC), which already bounds
--     per-key reads tightly; api_key_id IS NOT NULL matches ~99% of rows, causing full
--     write amplification on every authenticated request.
--   - DROP idx_usage_logs_model_created (model, created_at DESC)
--     Low-cardinality (~5-20 models) across ~99.9% of rows. Dashboard model trends &
--     leaderboards read from pre-aggregated usage_dashboard_hourly_models + short tail
--     via idx_usage_logs_created_id; panel filter uses (model = ? OR requested_model = ?).
--   - DROP idx_usage_logs_session_created (session_id, created_at)
--     High-entropy UUID B-tree updated on every request (heavy random page/WAL cost).
--     activeSessions scans recent created_at window via idx_usage_logs_created_id and
--     sessionSuggestions uses idx_usage_logs_outbound_session_created.
--   - DROP idx_reqlog_account (account_id, created_at DESC)
--     Panel account filter uses (account_id = ? OR final_account_id = ?) where
--     final_account_id is unindexed; billing aggregates scan created_at windows; per-VM
--     health/SLA queries use idx_reqlog_vm.
--
--   Preserved on usage_logs (1 PK + 9 secondary = 7 full + 2 near-zero-cost partial):
--     0. usage_logs_pkey                         PRIMARY KEY (id)
--     1. idx_reqlog_reqid                        UNIQUE (request_id)
--     2. idx_usage_logs_created_id               (created_at DESC, id DESC)
--     3. idx_reqlog_key                          (api_key_id, created_at DESC)
--     4. idx_usage_logs_user_created             (user_id, created_at)
--     5. idx_usage_logs_vm_owner                 (vm_owner_user_id, created_at)
--     6. idx_reqlog_vm                           (vm_id, created_at DESC)
--     7. idx_usage_logs_outbound_session_created (outbound_session_id, created_at)
--     8. idx_usage_logs_upstream_400             (created_at DESC, id DESC) WHERE upstream_status = 400
--     9. idx_usage_logs_pricing_null             (id) WHERE pricing_model IS NULL
DROP INDEX IF EXISTS idx_reqlog_ts;
DROP INDEX IF EXISTS idx_reqlog_requested_model;
DROP INDEX IF EXISTS idx_reqlog_status;
DROP INDEX IF EXISTS idx_usage_logs_group_created;
DROP INDEX IF EXISTS idx_usage_logs_inbound_device;
DROP INDEX IF EXISTS idx_usage_logs_api_key_status_created;
DROP INDEX IF EXISTS idx_usage_logs_model_created;
DROP INDEX IF EXISTS idx_usage_logs_session_created;
DROP INDEX IF EXISTS idx_reqlog_account;

-- ============================================================================
-- 3. account_allocations: add composite (account_id, id DESC) index
-- ============================================================================
-- Note: account_allocations uses `at` (already indexed by idx_alloc_account_at
-- ON account_allocations (account_id, at DESC)) and has no `created_at` column.
-- All hot queries in accounts-repo.mjs and account-quota.mjs filter/partition by
-- account_id and order by id DESC (top-N recent allocations & pruning); this
-- composite index eliminates seq_scan + sort on account_allocations.
CREATE INDEX IF NOT EXISTS idx_alloc_account_id_desc
  ON account_allocations (account_id, id DESC);
