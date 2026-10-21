import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { withTransaction } from '../db/database.mjs'
import { ExecutionAdmissionsRepo } from '../db/repos/execution-admissions-repo.mjs'
import { physicalVmAliases } from './vm-physical-target.mjs'
import { revokeNodeOperationGrants } from '../db/node-management-authority.mjs'

const callbacks = new AsyncLocalStorage()

/** Exact active claims inherited by this callback, never merely a controller owner ID. */
export function currentVmOperationIds(db) {
  return new Set(
    (callbacks.getStore() || [])
      .filter(
        (context) =>
          context.active &&
          !context.operation.uncertain &&
          context.db.schema === db.schema &&
          context.db.connectionString === db.connectionString,
      )
      .map((context) => context.operation.operationId),
  )
}

function operationError(code, status = 409) {
  return Object.assign(new Error(code.replaceAll('_', ' ')), { code, status })
}

function validateOperationVmId(vmId) {
  if (typeof vmId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(vmId)) {
    throw operationError('invalid_vm_operation', 400)
  }
  return vmId
}

function identifier(value) {
  if (typeof value !== 'string' || !value.trim()) throw operationError('invalid_vm_operation', 400)
  return value
}

/** Durable mutual exclusion with execution admission; unknown operations require explicit recovery. */
export class SharedVmOperations {
  constructor(db, { ownerId = crypto.randomUUID() } = {}) {
    this.db = db
    this.ownerId = identifier(ownerId)
    this.executions = new ExecutionAdmissionsRepo(db, { ownerId: this.ownerId })
  }

  async _executionException({ vmId, accountId, admission }) {
    if (!admission) return { ok: true, admissionId: null }
    if (
      !admission.db ||
      admission.db.schema !== this.db.schema ||
      admission.db.connectionString !== this.db.connectionString ||
      admission.vmId !== vmId ||
      admission.accountId !== accountId ||
      !admission.admissionId ||
      !admission.ownerId
    )
      return { ok: false, code: 'refresh_admission_invalid' }
    const row = await this.db
      .prepare(`SELECT * FROM execution_admissions WHERE id=$1 AND owner_id=$2 FOR UPDATE`)
      .get(admission.admissionId, admission.ownerId)
    if (!row || row.vm_id !== vmId || row.account_id !== accountId || row.released_at || row.uncertain_at)
      return { ok: false, code: 'refresh_admission_invalid' }
    const jobs = await this.db
      .prepare(`SELECT count(*) AS total,
      count(*) FILTER (WHERE ended_at IS NULL) AS pending FROM execution_jobs WHERE admission_id=$1`)
      .get(row.id)
    if (!jobs.total || jobs.pending) return { ok: false, code: 'refresh_execution_unfinished' }
    return { ok: true, admissionId: row.id }
  }

  async _otherExecution(vmId, accountId, admissionId) {
    return this.db
      .prepare(`SELECT id FROM execution_admissions
      WHERE released_at IS NULL AND (vm_id=ANY($1::text[]) OR ($2::text IS NOT NULL AND account_id=$2))
      AND ($3::text IS NULL OR id<>$3) LIMIT 1`)
      .get(physicalVmAliases(vmId), accountId ?? null, admissionId)
  }

  async tryAcquire({ vmId, kind = 'mutation', accountId = null, admission = null } = {}) {
    validateOperationVmId(vmId)
    identifier(kind)
    if (accountId != null) identifier(accountId)
    // The claim must commit independently before its owner can perform remote effects.
    if (this.db.isTransaction) throw operationError('vm_operation_transaction_active', 500)
    return withTransaction(this.db, async () => {
      // Identical namespace and VM resource to ExecutionAdmissionsRepo.tryReserve.
      await this.executions.lockResources({ accountId, vmIds: [vmId] })
      const active = await this.db
        .prepare(`SELECT id FROM vm_operations WHERE released_at IS NULL
          AND (vm_id = ANY($1::text[]) OR account_id=$2) LIMIT 1`)
        .get(physicalVmAliases(vmId), accountId)
      if (active) return { ok: false, code: 'vm_operation_active' }
      const exception = await this._executionException({ vmId, accountId, admission })
      if (!exception.ok) return exception
      const execution = await this._otherExecution(vmId, accountId, exception.admissionId)
      if (execution) return { ok: false, code: 'vm_execution_active' }
      const operationId = crypto.randomUUID()
      await this.db
        .prepare('INSERT INTO vm_operations (id, vm_id, owner_id, kind, account_id) VALUES ($1, $2, $3, $4, $5)')
        .run(operationId, vmId, this.ownerId, kind, accountId)
      return this._handle({ operationId, vmId, ownerId: this.ownerId, kind, accountId })
    })
  }

  _handle(identity) {
    let uncertain = false
    let marking = null
    let releasing = null
    return Object.freeze({
      ok: true,
      ...identity,
      get uncertain() {
        return uncertain
      },
      markUncertain: () => {
        uncertain = true
        if (!marking) {
          const pending = this.markUncertain(identity)
          marking = pending
          pending.then(
            (result) => {
              if (!result.uncertain && marking === pending) marking = null
            },
            () => {
              if (marking === pending) marking = null
            },
          )
        }
        return marking
      },
      release: async () => {
        if (uncertain) {
          if (marking) await marking
          return { released: false }
        }
        if (!releasing) {
          const pending = this.release(identity)
          releasing = pending
          pending.then(
            (result) => {
              if (!result.released && releasing === pending) releasing = null
            },
            () => {
              if (releasing === pending) releasing = null
            },
          )
        }
        return releasing
      },
    })
  }

  async markUncertain({ operationId, ownerId }) {
    return withTransaction(this.db, async () => {
      const row = await this.db
        .prepare('SELECT id FROM vm_operations WHERE id=$1 AND owner_id=$2 AND released_at IS NULL FOR UPDATE')
        .get(operationId, ownerId)
      if (!row) return { uncertain: false }
      await revokeNodeOperationGrants(this.db, { operationId, ownerId })
      const result = await this.db
        .prepare(`UPDATE vm_operations SET uncertain_at=COALESCE(uncertain_at,clock_timestamp())
        WHERE id=$1 AND owner_id=$2 AND released_at IS NULL`)
        .run(operationId, ownerId)
      return { uncertain: result.changes > 0 }
    })
  }

  async release({ operationId, ownerId }) {
    return withTransaction(this.db, async () => {
      const row = await this.db
        .prepare('SELECT id FROM vm_operations WHERE id=$1 AND owner_id=$2 AND uncertain_at IS NULL FOR UPDATE')
        .get(operationId, ownerId)
      if (!row) return { released: false }
      await revokeNodeOperationGrants(this.db, { operationId, ownerId })
      const result = await this.db
        .prepare(`UPDATE vm_operations SET released_at=COALESCE(released_at,clock_timestamp())
        WHERE id=$1 AND owner_id=$2 AND uncertain_at IS NULL`)
        .run(operationId, ownerId)
      return { released: result.changes > 0 }
    })
  }

  async run(vmId, callback, { kind = 'mutation', accountId = null, admission = null } = {}) {
    validateOperationVmId(vmId)
    const parents = callbacks.getStore() || []
    const nested = parents.findLast(
      (context) =>
        context.active &&
        context.vmId === vmId &&
        context.db.schema === this.db.schema &&
        context.db.connectionString === this.db.connectionString,
    )
    if (nested) {
      if (nested.operation.uncertain) throw operationError('vm_operation_inactive')
      const valid = await withTransaction(this.db, async () => {
        await this.executions.lockResources({ accountId, vmIds: [vmId] })
        const current = await this.db
          .prepare(`SELECT id,account_id FROM vm_operations
          WHERE id=$1 AND owner_id=$2 AND vm_id=$3 AND released_at IS NULL AND uncertain_at IS NULL`)
          .get(nested.operation.operationId, nested.operation.ownerId, vmId)
        if (!current) return { ok: false, code: 'vm_operation_inactive' }
        if (accountId && current.account_id && current.account_id !== accountId)
          return { ok: false, code: 'vm_operation_account_mismatch' }
        if (accountId) {
          const other = await this.db
            .prepare(`SELECT id FROM vm_operations
            WHERE account_id=$1 AND id<>$2 AND released_at IS NULL LIMIT 1`)
            .get(accountId, current.id)
          if (other) return { ok: false, code: 'vm_operation_active' }
        }
        const exception = await this._executionException({ vmId, accountId, admission })
        if (!exception.ok) return exception
        if (await this._otherExecution(vmId, accountId, exception.admissionId))
          return { ok: false, code: 'vm_execution_active' }
        if (accountId && !current.account_id)
          await this.db.prepare('UPDATE vm_operations SET account_id=$1 WHERE id=$2').run(accountId, current.id)
        return { ok: true }
      })
      if (!valid.ok) throw operationError(valid.code)
      try {
        const result = await callback(nested.operation)
        if (result?.vmOperationUncertain === true) await nested.operation.markUncertain()
        return result
      } catch (error) {
        if (error?.vmOperationNotStarted !== true || nested.operation.uncertain) await nested.operation.markUncertain()
        throw error
      }
    }
    const operation = await this.tryAcquire({ vmId, kind, accountId, admission })
    if (!operation.ok) throw operationError(operation.code)
    const context = { db: this.db, vmId, operation, active: true }
    let result
    try {
      result = await callbacks.run([...parents, context], () => callback(operation))
    } catch (error) {
      context.active = false
      if (error?.vmOperationNotStarted === true && !operation.uncertain) {
        const released = await operation.release()
        if (!released.released) throw operationError('vm_operation_release_unconfirmed')
      } else {
        await operation.markUncertain()
      }
      throw error
    } finally {
      // Descendant async work must not reuse the claim after its callback has returned.
      context.active = false
    }
    if (result?.vmOperationUncertain === true || operation.uncertain) {
      await operation.markUncertain()
    } else {
      const released = await operation.release()
      if (!released.released) throw operationError('vm_operation_release_unconfirmed')
    }
    return result
  }
}
