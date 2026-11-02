import { getDb, withTransaction } from '../database.mjs'
import { shanghaiUsageDay } from '../../protocol/jev-usage.mjs'

const FIELDS = [
  'id',
  'created_at',
  'request_id',
  'provider',
  'model',
  'key_fingerprint',
  'http_status',
  'outcome',
  'duration_ms',
  'input_tokens',
  'output_tokens',
  'estimated_cost_nano_usd',
  'input_nano_usd_per_token',
  'output_nano_usd_per_token',
  'pricing_basis',
]
const COUNTS = [
  'requests',
  'successful',
  'input_tokens',
  'output_tokens',
  'unknown_usage_requests',
  'estimated_cost_nano_usd',
  'unknown_cost_requests',
]
const empty = () => Object.fromEntries(COUNTS.map((name) => [name, 0]))

export class JevUsageRepo {
  constructor(db = getDb(), { now = Date.now } = {}) {
    this.db = db
    this.now = now
    this.nextPruneAt = 0
    this.insert = db.prepare(
      `INSERT INTO jev_usage_events (${FIELDS.join(',')}) VALUES (${FIELDS.map(() => '?').join(',')})`,
    )
    this.sum = db.prepare(`INSERT INTO jev_usage_totals (period,${COUNTS.join(',')}) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(period) DO UPDATE SET ${COUNTS.map((name) => `${name}=${name}+excluded.${name}`).join(',')}`)
  }
  record(event) {
    const amounts = [
      1,
      event.outcome === 'success' ? 1 : 0,
      event.input_tokens ?? 0,
      event.output_tokens ?? 0,
      event.input_tokens === null || event.output_tokens === null ? 1 : 0,
      event.estimated_cost_nano_usd ?? 0,
      event.estimated_cost_nano_usd === null ? 1 : 0,
    ]
    withTransaction(this.db, () => {
      this.insert.run(...FIELDS.map((name) => event[name]))
      this.sum.run('all', ...amounts)
      this.sum.run(shanghaiUsageDay(event.created_at), ...amounts)
    })
    const now = this.now()
    if (now >= this.nextPruneAt) {
      this.nextPruneAt = now + 60000
      // Both deletes are indexed and bounded; lifetime counters are never removed.
      this.db
        .prepare(
          'DELETE FROM jev_usage_events WHERE id IN (SELECT id FROM jev_usage_events WHERE created_at < ? ORDER BY created_at,id LIMIT 500)',
        )
        .run(new Date(now - 30 * 86400000).toISOString())
      this.db
        .prepare(
          "DELETE FROM jev_usage_totals WHERE period IN (SELECT period FROM jev_usage_totals WHERE period <> 'all' AND period < ? LIMIT 32)",
        )
        .run(shanghaiUsageDay(new Date(now - 90 * 86400000).toISOString()))
    }
  }
  configuredKeys(keys) {
    const rows = this.db
      .prepare(`SELECT key_fingerprint,
      COUNT(*) AS requests,
      SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END) AS successful,
      SUM(COALESCE(estimated_cost_nano_usd,0)) AS estimated_cost_nano_usd,
      SUM(CASE WHEN estimated_cost_nano_usd IS NULL THEN 1 ELSE 0 END) AS unknown_cost_requests
      FROM jev_usage_events GROUP BY key_fingerprint`)
      .all()
    const totals = new Map(rows.map((row) => [row.key_fingerprint, row]))
    const latest = this.db.prepare(`SELECT created_at,http_status,outcome FROM jev_usage_events
      WHERE key_fingerprint=? ORDER BY created_at DESC,id DESC LIMIT 1`)
    return keys.map((key) => {
      const last = latest.get(key.key_fingerprint)
      const status =
        last?.http_status === 402
          ? 'insufficient_balance'
          : last?.outcome === 'success'
            ? 'normal'
            : last?.http_status === 401 || last?.http_status === 403
              ? 'auth_error'
              : last?.http_status === 429
                ? 'rate_limited'
                : last
                  ? 'request_error'
                  : key.retired
                    ? 'paused'
                    : 'unrequested'
      return {
        ...key,
        requests: 0,
        successful: 0,
        estimated_cost_nano_usd: 0,
        unknown_cost_requests: 0,
        ...totals.get(key.key_fingerprint),
        status,
        last_request_at: last?.created_at ?? null,
        last_http_status: last?.http_status ?? null,
      }
    })
  }
  overview() {
    const today = shanghaiUsageDay(new Date(this.now()).toISOString())
    const rows = this.db.prepare("SELECT * FROM jev_usage_totals WHERE period IN ('all', ?)").all(today)
    const total = empty(),
      daily = empty()
    for (const row of rows) {
      const target = row.period === 'all' ? total : daily
      for (const name of COUNTS) target[name] += row[name]
    }
    return {
      started_at: this.db.prepare('SELECT started_at FROM jev_usage_meta WHERE id=1').get()?.started_at ?? null,
      day: today,
      timezone: 'Asia/Shanghai',
      total,
      today: daily,
      detail_retention_days: 30,
    }
  }
  list({ limit = 50, cursor_created_at = '', cursor_id = '', key_fingerprint = '' } = {}) {
    limit = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 50)))
    const where = [],
      args = []
    if (cursor_created_at || cursor_id) {
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cursor_created_at) ||
        !/^[a-f0-9-]{36}$/.test(cursor_id)
      )
        throw new TypeError('Invalid cursor')
      where.push('(created_at,id) < (?,?)')
      args.push(cursor_created_at, cursor_id)
    }
    if (key_fingerprint) {
      if (!/^[a-f0-9]{12}$/.test(key_fingerprint)) throw new TypeError('Invalid key fingerprint')
      where.push('key_fingerprint=?')
      args.push(key_fingerprint)
    }
    const rows = this.db
      .prepare(
        `SELECT ${FIELDS.join(',')} FROM jev_usage_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC,id DESC LIMIT ?`,
      )
      .all(...args, limit + 1)
    const more = rows.length > limit
    if (more) rows.pop()
    const last = rows.at(-1)
    return {
      rows,
      has_more: more,
      next_cursor: more && last ? { created_at: last.created_at, id: last.id } : null,
    }
  }
}
