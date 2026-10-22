/** Only scheduled-test execution metadata may be appended to an unchanged plan. */
export class VmTestScheduleResultsRepo {
  constructor(db) {
    this.db = db
  }

  async listPlans() {
    const rows = await this.db
      .prepare('SELECT key, value FROM settings WHERE left(key, length($1)) = $1 ORDER BY key')
      .all('vm_test_schedule:')
    return Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]))
  }

  async isCurrent(vmId, revision) {
    return !!(await this.db
      .prepare(`SELECT key FROM settings WHERE key = $1
        AND value::jsonb->>'revision' = $2 AND value::jsonb->'enabled' = 'true'::jsonb`)
      .get(`vm_test_schedule:${vmId}`, revision))
  }

  async record(vmId, revision, result) {
    const patch = {
      last_run_at: result.last_run_at,
      last_ok: result.last_ok,
      last_duration_ms: result.last_duration_ms,
      last_error: result.last_error,
    }
    const stored = await this.db
      .prepare(`UPDATE settings SET value = (value::jsonb || $3::jsonb)::text,
        updated_at = clock_timestamp()::text WHERE key = $1 AND value::jsonb->>'revision' = $2`)
      .run(`vm_test_schedule:${vmId}`, revision, JSON.stringify(patch))
    return stored.changes > 0
  }
}
