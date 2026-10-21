import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { withTransaction } from '../db/database.mjs'
import { ExecutionAdmissionsRepo } from '../db/repos/execution-admissions-repo.mjs'
import { physicalVmAliases } from './vm-physical-target.mjs'

const callbacks = new AsyncLocalStorage()

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

  async tryAcquire({ vmId, kind = 'mutation' } = {}) {
    validateOperationVmId(vmId)
    identifier(kind)
    // The claim must commit independently before its owner can perform remote effects.
    if (this.db.isTransaction) throw operationError('vm_operation_transaction_active', 500)
    return withTransaction(this.db, async () => {
      // Identical namespace and VM resource to ExecutionAdmissionsRepo.tryReserve.
      await this.executions.lockVm(vmId)
      const active = await this.db
        .prepare('SELECT id FROM vm_operations WHERE vm_id = ANY($1::text[]) AND released_at IS NULL LIMIT 1')
        .get(physicalVmAliases(vmId))
      if (active) return { ok: false, code: 'vm_operation_active' }
      const execution = await this.db
        .prepare('SELECT id FROM execution_admissions WHERE vm_id = ANY($1::text[]) AND released_at IS NULL LIMIT 1')
        .get(physicalVmAliases(vmId))
      if (execution) return { ok: false, code: 'vm_execution_active' }
      const operationId = crypto.randomUUID()
      await this.db
        .prepare('INSERT INTO vm_operations (id, vm_id, owner_id, kind) VALUES ($1, $2, $3, $4)')
        .run(operationId, vmId, this.ownerId, kind)
      return this._handle({ operationId, vmId, ownerId: this.ownerId, kind })
    })
  }

  _handle(identity) {
    let uncertain = false
    let marking = null
    let releasing = null
    return {
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
    }
  }

  async markUncertain({ operationId, ownerId }) {
    const result = await this.db
      .prepare(`UPDATE vm_operations
      SET uncertain_at = COALESCE(uncertain_at, clock_timestamp())
      WHERE id = $1 AND owner_id = $2 AND released_at IS NULL`)
      .run(operationId, ownerId)
    return { uncertain: result.changes > 0 }
  }

  async release({ operationId, ownerId }) {
    const result = await this.db
      .prepare(`UPDATE vm_operations
      SET released_at = COALESCE(released_at, clock_timestamp())
      WHERE id = $1 AND owner_id = $2 AND uncertain_at IS NULL`)
      .run(operationId, ownerId)
    return { released: result.changes > 0 }
  }

  async run(vmId, callback, { kind = 'mutation' } = {}) {
    validateOperationVmId(vmId)
    const parents = callbacks.getStore() || []
    const nested = parents.findLast(
      (context) =>
        context.active &&
        context.vmId === vmId &&
        context.db.schema === this.db.schema &&
        context.db.connectionString === this.db.connectionString,
    )
    if (nested) return callback(nested.operation)
    const operation = await this.tryAcquire({ vmId, kind })
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
