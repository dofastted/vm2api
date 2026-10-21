import crypto from 'node:crypto'
import { withTransaction } from '../database.mjs'

function invalid(field) {
  return Object.assign(new Error(`Invalid execution admission ${field}`), { code: 'invalid_execution_admission' })
}

function identifier(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(field)
  return value
}

function limit(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid(field)
  return value
}

function denied(code, inflight, max, extra = {}) {
  return { ok: false, code, reason: code, detail: { inflight, max }, ...extra }
}

/** Short PostgreSQL transactions for global account/VM execution limits. */
export class ExecutionAdmissionsRepo {
  constructor(db, { ownerId = 'controller_' + crypto.randomUUID() } = {}) {
    this.db = db
    this.ownerId = identifier(ownerId, 'ownerId')
  }

  /** Shared order: device (caller), account, then every involved VM sorted. */
  async lockResources({ accountId, vmIds = [] } = {}) {
    if (!this.db.isTransaction) {
      throw Object.assign(new Error('Execution resource locks require a transaction'), {
        code: 'execution_transaction_required',
      })
    }
    if (!Array.isArray(vmIds)) throw invalid('vmIds')
    const resources = vmIds.map((id) => 'vm:' + identifier(id, 'vmId'))
    if (accountId != null) resources.push('account:' + identifier(accountId, 'accountId'))
    for (const resource of [...new Set(resources)].sort()) {
      await this.db.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        `vm2api:execution:${this.db.schema}`,
        resource,
      ])
    }
  }

  async lockVm(vmId) {
    return this.lockResources({ vmIds: [vmId] })
  }

  async _counts(accountId, vmId, now) {
    const row = await this.db
      .prepare(`SELECT
        count(*) FILTER (WHERE account_id = $1 AND released_at IS NULL) AS account_inflight,
        count(*) FILTER (WHERE vm_id = $2 AND released_at IS NULL) AS vm_inflight,
        count(*) FILTER (WHERE account_id = $1 AND released_at IS NULL AND model_family = 'fable') AS fable_inflight,
        count(*) FILTER (WHERE account_id = $1 AND created_at > $3::timestamptz - interval '60 seconds') AS rpm_count,
        min(created_at) FILTER (WHERE account_id = $1 AND created_at > $3::timestamptz - interval '60 seconds') AS rpm_oldest
        FROM execution_admissions WHERE account_id = $1 OR vm_id = $2`)
      .get(accountId, vmId, now)
    return {
      accountInflight: row.account_inflight,
      vmInflight: row.vm_inflight,
      fableInflight: row.fable_inflight,
      rpmCount: row.rpm_count,
      rpmResetAt: row.rpm_oldest ? row.rpm_oldest.getTime() + 60_000 : null,
    }
  }

  /** An eligibility snapshot only; tryReserve is the atomic admission gate. */
  async getCounts({ accountId, vmId } = {}) {
    if (accountId != null) identifier(accountId, 'accountId')
    if (vmId != null) identifier(vmId, 'vmId')
    if (accountId == null && vmId == null) throw invalid('resource')
    const { now } = await this.db.prepare('SELECT clock_timestamp() AS now').get()
    return this._counts(accountId ?? null, vmId ?? null, now)
  }

  async tryReserve(input = {}) {
    const accountId = identifier(input.accountId, 'accountId')
    const vmId = identifier(input.vmId, 'vmId')
    const ownerId = identifier(input.ownerId === undefined ? this.ownerId : input.ownerId, 'ownerId')
    const requestId = identifier(input.requestId === undefined ? crypto.randomUUID() : input.requestId, 'requestId')
    const accountLimit = limit(input.accountLimit, 'accountLimit')
    const vmLimit = limit(input.vmLimit, 'vmLimit')
    const fableLimit = limit(input.fableLimit, 'fableLimit')
    const rpmLimit = limit(input.rpmLimit, 'rpmLimit')
    const family = input.family == null ? null : identifier(input.family, 'family')
    return withTransaction(this.db, async () => {
      await this.lockResources({ accountId, vmIds: [vmId] })
      const { now } = await this.db.prepare('SELECT clock_timestamp() AS now').get()
      await this.db
        .prepare(`DELETE FROM execution_admissions WHERE account_id = $1
          AND released_at IS NOT NULL AND created_at <= $2::timestamptz - interval '60 seconds'`)
        .run(accountId, now)
      const counts = await this._counts(accountId, vmId, now)
      // Concurrency zero disables execution; RPM/Fable zero adds no sublimit.
      if (counts.accountInflight >= accountLimit)
        return denied('concurrency_limit', counts.accountInflight, accountLimit)
      if (counts.vmInflight >= vmLimit) return denied('vm_concurrency_limit', counts.vmInflight, vmLimit)
      if (family === 'fable' && fableLimit > 0 && counts.fableInflight >= fableLimit) {
        return denied('fable_concurrency', counts.fableInflight, fableLimit)
      }
      if (rpmLimit > 0 && counts.rpmCount >= rpmLimit) {
        return denied('rpm_limit', counts.rpmCount, rpmLimit, {
          retry_after_ms: Math.max(1, counts.rpmResetAt - now.getTime()),
        })
      }
      const admissionId = crypto.randomUUID()
      const record = await this.db
        .prepare(`INSERT INTO execution_admissions (id, owner_id, request_id, account_id, vm_id, model_family, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`)
        .get(admissionId, ownerId, requestId, accountId, vmId, family, now)
      const handle = { admissionId, ownerId }
      return {
        ok: true,
        admissionId,
        ownerId,
        requestId,
        accountId,
        vmId,
        record,
        release: (options) => this.release(handle, options),
        markUncertain: () => this.markUncertain(handle),
      }
    })
  }

  async markUncertain({ admissionId, ownerId }) {
    const result = await this.db
      .prepare(`UPDATE execution_admissions SET uncertain_at = COALESCE(uncertain_at, clock_timestamp())
        WHERE id = $1 AND owner_id = $2 AND released_at IS NULL`)
      .run(admissionId, ownerId)
    return { uncertain: result.changes > 0 }
  }

  async release(handle, { uncertain = false } = {}) {
    if (uncertain) return this.markUncertain(handle)
    const result = await this.db
      .prepare(`UPDATE execution_admissions SET released_at = clock_timestamp()
        WHERE id = $1 AND owner_id = $2 AND released_at IS NULL AND uncertain_at IS NULL`)
      .run(handle.admissionId, handle.ownerId)
    return { released: result.changes > 0 }
  }
}
