/**
 * Incremental dashboard usage aggregator for PostgreSQL.
 *
 * Modeled on sub2api's `DashboardAggregationService` (`034_usage_dashboard_aggregation_tables.sql`):
 * rolls up `usage_logs` into `usage_dashboard_hourly`, `usage_dashboard_daily`,
 * `usage_dashboard_hourly_users`, `usage_dashboard_daily_users`, and
 * `usage_dashboard_hourly_models` under a PG advisory lock.
 */

const AGG_LOCK_KEY = 'vm2api_dashboard_aggregator_v1'
const DEFAULT_INTERVAL_MS = 60_000

let timer = null
let running = false

/**
 * Run a single incremental (or full backfill) rollup pass.
 * Re-aggregates any hour/day buckets touched since the watermark (with a 2-hour
 * overlap guard for late writes/repricing) so numbers are always exact and idempotent.
 */
export async function runDashboardAggregation(pool, { fullBackfill = false } = {}) {
  if (!pool) return { skipped: true, reason: 'no_pool' }
  const client = await pool.connect()
  let locked = false
  try {
    const lockRes = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [AGG_LOCK_KEY])
    locked = Boolean(lockRes.rows?.[0]?.locked)
    if (!locked) return { skipped: true, reason: 'lock_busy' }

    const wmRes = await client.query(
      'SELECT last_aggregated_at, last_aggregated_id FROM usage_dashboard_aggregation_watermark WHERE id = 1',
    )
    const prevAt = fullBackfill ? '' : String(wmRes.rows?.[0]?.last_aggregated_at || '')

    // Look back 2 hours from watermark for idempotent bucket refresh on late/repriced rows.
    let sinceIso = ''
    if (prevAt) {
      const parsed = Date.parse(prevAt)
      if (Number.isFinite(parsed)) {
        sinceIso = new Date(parsed - 2 * 3_600_000).toISOString()
      }
    }

    const maxRes = await client.query('SELECT created_at, id FROM usage_logs ORDER BY created_at DESC, id DESC LIMIT 1')
    const latestRow = maxRes.rows?.[0] || null
    if (!latestRow) {
      return { skipped: false, hourlyBuckets: 0, dailyBuckets: 0, latestAt: '' }
    }

    const whereClause = sinceIso ? 'WHERE created_at >= $1' : ''
    const params = sinceIso ? [sinceIso] : []

    await client.query('BEGIN')
    try {
      // 1. Hourly user set
      await client.query(
        `
        INSERT INTO usage_dashboard_hourly_users (bucket_start, user_id)
        SELECT DISTINCT
          date_trunc('hour', created_at::timestamptz) AS bucket_start,
          user_id
        FROM usage_logs
        ${whereClause ? `${whereClause} AND user_id IS NOT NULL AND user_id <> ''` : "WHERE user_id IS NOT NULL AND user_id <> ''"}
        ON CONFLICT (bucket_start, user_id) DO NOTHING
        `,
        params,
      )

      // 2. Daily user set (UTC)
      await client.query(
        `
        INSERT INTO usage_dashboard_daily_users (bucket_date, user_id)
        SELECT DISTINCT
          (created_at::timestamptz AT TIME ZONE 'UTC')::date AS bucket_date,
          user_id
        FROM usage_logs
        ${whereClause ? `${whereClause} AND user_id IS NOT NULL AND user_id <> ''` : "WHERE user_id IS NOT NULL AND user_id <> ''"}
        ON CONFLICT (bucket_date, user_id) DO NOTHING
        `,
        params,
      )

      // 3. Hourly aggregate
      const hourlyRes = await client.query(
        `
        WITH affected AS (
          SELECT DISTINCT date_trunc('hour', created_at::timestamptz) AS bucket_start
          FROM usage_logs
          ${whereClause}
        ),
        agg AS (
          SELECT
            date_trunc('hour', u.created_at::timestamptz) AS bucket_start,
            COUNT(*)::bigint AS total_requests,
            SUM(CASE WHEN u.status >= 400 OR (u.error_code IS NOT NULL AND u.error_code <> '') THEN 1 ELSE 0 END)::bigint AS error_requests,
            COALESCE(SUM(u.input_tokens), 0)::bigint AS input_tokens,
            COALESCE(SUM(u.output_tokens), 0)::bigint AS output_tokens,
            COALESCE(SUM(u.cache_creation_tokens), 0)::bigint AS cache_creation_tokens,
            COALESCE(SUM(u.cache_read_tokens), 0)::bigint AS cache_read_tokens,
            COALESCE(SUM(u.total_cost), 0)::double precision AS total_cost,
            COALESCE(SUM(COALESCE(u.actual_cost, u.total_cost)), 0)::double precision AS actual_cost,
            COALESCE(SUM(u.duration_ms), 0)::bigint AS total_duration_ms,
            COUNT(u.duration_ms)::bigint AS duration_count,
            COUNT(DISTINCT NULLIF(u.user_id, ''))::bigint AS active_users
          FROM usage_logs u
          JOIN affected a ON date_trunc('hour', u.created_at::timestamptz) = a.bucket_start
          GROUP BY 1
        )
        INSERT INTO usage_dashboard_hourly (
          bucket_start, total_requests, error_requests, input_tokens, output_tokens,
          cache_creation_tokens, cache_read_tokens, total_cost, actual_cost,
          total_duration_ms, duration_count, active_users, updated_at
        )
        SELECT
          bucket_start, total_requests, error_requests, input_tokens, output_tokens,
          cache_creation_tokens, cache_read_tokens, total_cost, actual_cost,
          total_duration_ms, duration_count, active_users, NOW()
        FROM agg
        ON CONFLICT (bucket_start) DO UPDATE SET
          total_requests = EXCLUDED.total_requests,
          error_requests = EXCLUDED.error_requests,
          input_tokens = EXCLUDED.input_tokens,
          output_tokens = EXCLUDED.output_tokens,
          cache_creation_tokens = EXCLUDED.cache_creation_tokens,
          cache_read_tokens = EXCLUDED.cache_read_tokens,
          total_cost = EXCLUDED.total_cost,
          actual_cost = EXCLUDED.actual_cost,
          total_duration_ms = EXCLUDED.total_duration_ms,
          duration_count = EXCLUDED.duration_count,
          active_users = EXCLUDED.active_users,
          updated_at = NOW()
        `,
        params,
      )

      // 4. Daily aggregate (UTC)
      const dailyRes = await client.query(
        `
        WITH affected AS (
          SELECT DISTINCT (created_at::timestamptz AT TIME ZONE 'UTC')::date AS bucket_date
          FROM usage_logs
          ${whereClause}
        ),
        agg AS (
          SELECT
            (u.created_at::timestamptz AT TIME ZONE 'UTC')::date AS bucket_date,
            COUNT(*)::bigint AS total_requests,
            SUM(CASE WHEN u.status >= 400 OR (u.error_code IS NOT NULL AND u.error_code <> '') THEN 1 ELSE 0 END)::bigint AS error_requests,
            COALESCE(SUM(u.input_tokens), 0)::bigint AS input_tokens,
            COALESCE(SUM(u.output_tokens), 0)::bigint AS output_tokens,
            COALESCE(SUM(u.cache_creation_tokens), 0)::bigint AS cache_creation_tokens,
            COALESCE(SUM(u.cache_read_tokens), 0)::bigint AS cache_read_tokens,
            COALESCE(SUM(u.total_cost), 0)::double precision AS total_cost,
            COALESCE(SUM(COALESCE(u.actual_cost, u.total_cost)), 0)::double precision AS actual_cost,
            COALESCE(SUM(u.duration_ms), 0)::bigint AS total_duration_ms,
            COUNT(u.duration_ms)::bigint AS duration_count,
            COUNT(DISTINCT NULLIF(u.user_id, ''))::bigint AS active_users
          FROM usage_logs u
          JOIN affected a ON (u.created_at::timestamptz AT TIME ZONE 'UTC')::date = a.bucket_date
          GROUP BY 1
        )
        INSERT INTO usage_dashboard_daily (
          bucket_date, total_requests, error_requests, input_tokens, output_tokens,
          cache_creation_tokens, cache_read_tokens, total_cost, actual_cost,
          total_duration_ms, duration_count, active_users, updated_at
        )
        SELECT
          bucket_date, total_requests, error_requests, input_tokens, output_tokens,
          cache_creation_tokens, cache_read_tokens, total_cost, actual_cost,
          total_duration_ms, duration_count, active_users, NOW()
        FROM agg
        ON CONFLICT (bucket_date) DO UPDATE SET
          total_requests = EXCLUDED.total_requests,
          error_requests = EXCLUDED.error_requests,
          input_tokens = EXCLUDED.input_tokens,
          output_tokens = EXCLUDED.output_tokens,
          cache_creation_tokens = EXCLUDED.cache_creation_tokens,
          cache_read_tokens = EXCLUDED.cache_read_tokens,
          total_cost = EXCLUDED.total_cost,
          actual_cost = EXCLUDED.actual_cost,
          total_duration_ms = EXCLUDED.total_duration_ms,
          duration_count = EXCLUDED.duration_count,
          active_users = EXCLUDED.active_users,
          updated_at = NOW()
        `,
        params,
      )

      // 5. Hourly model breakdown
      await client.query(
        `
        WITH affected AS (
          SELECT DISTINCT date_trunc('hour', created_at::timestamptz) AS bucket_start
          FROM usage_logs
          ${whereClause}
        ),
        agg AS (
          SELECT
            date_trunc('hour', u.created_at::timestamptz) AS bucket_start,
            COALESCE(NULLIF(u.model, ''), '__unknown__') AS model,
            COUNT(*)::bigint AS total_requests,
            SUM(CASE WHEN u.status >= 400 OR (u.error_code IS NOT NULL AND u.error_code <> '') THEN 1 ELSE 0 END)::bigint AS error_requests,
            COALESCE(SUM(u.input_tokens), 0)::bigint AS input_tokens,
            COALESCE(SUM(u.output_tokens), 0)::bigint AS output_tokens,
            COALESCE(SUM(u.cache_creation_tokens), 0)::bigint AS cache_creation_tokens,
            COALESCE(SUM(u.cache_read_tokens), 0)::bigint AS cache_read_tokens,
            COALESCE(SUM(u.total_cost), 0)::double precision AS total_cost,
            COALESCE(SUM(COALESCE(u.actual_cost, u.total_cost)), 0)::double precision AS actual_cost
          FROM usage_logs u
          JOIN affected a ON date_trunc('hour', u.created_at::timestamptz) = a.bucket_start
          GROUP BY 1, 2
        )
        INSERT INTO usage_dashboard_hourly_models (
          bucket_start, model, total_requests, error_requests, input_tokens, output_tokens,
          cache_creation_tokens, cache_read_tokens, total_cost, actual_cost
        )
        SELECT
          bucket_start, model, total_requests, error_requests, input_tokens, output_tokens,
          cache_creation_tokens, cache_read_tokens, total_cost, actual_cost
        FROM agg
        ON CONFLICT (bucket_start, model) DO UPDATE SET
          total_requests = EXCLUDED.total_requests,
          error_requests = EXCLUDED.error_requests,
          input_tokens = EXCLUDED.input_tokens,
          output_tokens = EXCLUDED.output_tokens,
          cache_creation_tokens = EXCLUDED.cache_creation_tokens,
          cache_read_tokens = EXCLUDED.cache_read_tokens,
          total_cost = EXCLUDED.total_cost,
          actual_cost = EXCLUDED.actual_cost
        `,
        params,
      )

      // 6. Advance watermark
      await client.query(
        `
        UPDATE usage_dashboard_aggregation_watermark
        SET last_aggregated_at = $1, last_aggregated_id = $2, updated_at = NOW()
        WHERE id = 1
        `,
        [String(latestRow.created_at), String(latestRow.id)],
      )

      await client.query('COMMIT')
      return {
        skipped: false,
        hourlyBuckets: hourlyRes.rowCount || 0,
        dailyBuckets: dailyRes.rowCount || 0,
        latestAt: String(latestRow.created_at),
      }
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {}
      throw err
    }
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [AGG_LOCK_KEY])
      } catch {}
    }
    client.release()
  }
}

export function startDashboardAggregator(pool, { intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  stopDashboardAggregator()
  if (!pool) return
  const tick = async () => {
    if (running) return
    running = true
    try {
      await runDashboardAggregation(pool)
    } catch (err) {
      console.warn('[dashboard-aggregator]', err?.message || err)
    } finally {
      running = false
    }
  }
  // Initial non-blocking catch-up after startup settles
  const kickoff = setTimeout(tick, 5_000)
  kickoff.unref?.()
  timer = setInterval(tick, Math.max(10_000, Number(intervalMs) || DEFAULT_INTERVAL_MS))
  timer.unref?.()
}

export function stopDashboardAggregator() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
