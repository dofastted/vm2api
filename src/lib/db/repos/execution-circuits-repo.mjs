import { withTransaction } from '../database.mjs'

function configOf(config) {
  if (
    !Number.isSafeInteger(config?.failureThreshold) ||
    config.failureThreshold < 1 ||
    !Number.isSafeInteger(config?.openMs) ||
    config.openMs < 1
  ) {
    throw Object.assign(new Error('Invalid execution circuit configuration'), { code: 'invalid_execution_circuit' })
  }
  return config
}

function view(row, now, config) {
  const state = row?.open_until ? (row.open_until > now ? 'open' : 'half_open') : 'closed'
  return {
    state,
    failures: row?.failures || 0,
    threshold: config.failureThreshold,
    open_until: state === 'open' ? row.open_until.getTime() : null,
    open_ms: config.openMs,
    probeHeld: !!row?.probe_admission_id,
  }
}

/** Circuit writes share the account admission lock; probes belong to durable admissions. */
export class ExecutionCircuitsRepo {
  constructor(executions) {
    this.executions = executions
    this.db = executions.db
  }

  async inspect(accountId, config) {
    configOf(config)
    const { now } = await this.db.prepare('SELECT clock_timestamp() AS now').get()
    const row = await this.db.prepare('SELECT * FROM execution_circuits WHERE account_id = $1').get(accountId)
    const current = view(row, now, config)
    if (current.state === 'open') return { ...current, ok: false, reason: 'circuit_open', until: current.open_until }
    if (current.probeHeld)
      return { ...current, ok: false, reason: 'circuit_probe', until: now.getTime() + config.openMs }
    return { ...current, ok: true }
  }

  async admit(accountId, admissionId, now, config) {
    configOf(config)
    await this.db
      .prepare('INSERT INTO execution_circuits (account_id) VALUES ($1) ON CONFLICT DO NOTHING')
      .run(accountId)
    const row = await this.db
      .prepare('SELECT * FROM execution_circuits WHERE account_id = $1 FOR UPDATE')
      .get(accountId)
    if (row.open_until && row.open_until > now)
      return { ok: false, code: 'circuit_open', retry_after_ms: Math.max(1, row.open_until - now) }
    if (row.probe_admission_id) return { ok: false, code: 'circuit_probe' }
    if (row.open_until) {
      await this.db
        .prepare('UPDATE execution_circuits SET probe_admission_id = $2 WHERE account_id = $1')
        .run(accountId, admissionId)
    }
    return { ok: true, revision: row.revision }
  }

  async noteResult(handle, outcome, config) {
    configOf(config)
    if (!['failure', 'success', 'neutral'].includes(outcome))
      throw Object.assign(new Error('Invalid execution circuit outcome'), { code: 'invalid_execution_circuit' })
    return withTransaction(this.db, async () => {
      const before = await this.db
        .prepare('SELECT account_id FROM execution_admissions WHERE id = $1 AND owner_id = $2')
        .get(handle.admissionId, handle.ownerId)
      if (!before) return { updated: false }
      await this.executions.lockResources({ accountId: before.account_id })
      const admission = await this.executions._lockAdmission(handle)
      if (!admission || admission.released_at || admission.circuit_revision == null || admission.circuit_outcome)
        return { updated: false }
      await this.db
        .prepare('UPDATE execution_admissions SET circuit_outcome = $2 WHERE id = $1')
        .run(handle.admissionId, outcome)
      const row = await this.db
        .prepare('SELECT * FROM execution_circuits WHERE account_id = $1 FOR UPDATE')
        .get(admission.account_id)
      if (!row || row.revision !== admission.circuit_revision || admission.uncertain_at) return { updated: false }
      // An older closed-state request cannot finish a newer half-open probe.
      if (row.probe_admission_id && row.probe_admission_id !== admission.id) return { updated: false }
      if (outcome === 'failure') {
        const failures = row.failures + 1
        if (row.probe_admission_id || failures >= config.failureThreshold) {
          await this.db
            .prepare(`UPDATE execution_circuits SET failures = $2,
              open_until = clock_timestamp() + $3::integer * interval '1 millisecond',
              revision = revision + 1, probe_admission_id = NULL WHERE account_id = $1`)
            .run(admission.account_id, config.failureThreshold, config.openMs)
        } else {
          await this.db
            .prepare('UPDATE execution_circuits SET failures = $2 WHERE account_id = $1')
            .run(admission.account_id, failures)
        }
      } else if (outcome === 'success') {
        await this.db
          .prepare(`UPDATE execution_circuits SET failures = 0, open_until = NULL,
            probe_admission_id = NULL, revision = revision + CASE WHEN open_until IS NULL THEN 0 ELSE 1 END
            WHERE account_id = $1`)
          .run(admission.account_id)
      }
      return { updated: true }
    })
  }

  async releaseProbe(admissionId) {
    await this.db
      .prepare('UPDATE execution_circuits SET probe_admission_id = NULL WHERE probe_admission_id = $1')
      .run(admissionId)
  }

  async reset(accountId, config) {
    configOf(config)
    return withTransaction(this.db, async () => {
      await this.executions.lockResources({ accountId })
      await this.db
        .prepare(`INSERT INTO execution_circuits (account_id, revision) VALUES ($1, 1)
          ON CONFLICT (account_id) DO UPDATE SET failures = 0, open_until = NULL,
          probe_admission_id = NULL, revision = execution_circuits.revision + 1`)
        .run(accountId)
      return this.inspect(accountId, config)
    })
  }
}
