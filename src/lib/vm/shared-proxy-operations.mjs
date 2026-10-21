import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { getDb, withTransaction } from '../db/database.mjs'
import { ProxiesRepo } from '../db/repos/proxies-repo.mjs'
import { BackgroundTaskRunsRepo } from '../db/repos/background-task-runs-repo.mjs'
import { ExecutionAdmissionsRepo } from '../db/repos/execution-admissions-repo.mjs'
import { currentVmOperationIds } from './shared-vm-operations.mjs'
import { physicalVmAliases } from './vm-physical-target.mjs'
import { parseBoundVmIds } from './proxy-pool.mjs'

const TASK_KEY = 'proxy_operation:pool'
const callbacks = new AsyncLocalStorage()
const services = new WeakMap()

function error(code, status = 409) {
  return Object.assign(new Error(code.replaceAll('_', ' ')), { code, status })
}

function contextFor(db) {
  return (callbacks.getStore() || []).findLast(
    (context) =>
      context.active &&
      !context.claim.uncertain &&
      context.db.schema === db.schema &&
      context.db.connectionString === db.connectionString,
  )
}

/** Typed control operations use one pool claim, including when no VM is bound yet. */
export class SharedProxyOperations {
  constructor(db, { ownerId = randomUUID() } = {}) {
    if (typeof ownerId !== 'string' || !ownerId.trim() || ownerId.length > 200)
      throw error('invalid_proxy_operation', 400)
    this.db = db
    this.ownerId = ownerId
    this.runs = new BackgroundTaskRunsRepo(db)
  }

  async tryAcquire() {
    if (this.db.isTransaction) throw error('proxy_operation_transaction_active', 500)
    return withTransaction(this.db, async () => {
      await new ProxiesRepo(this.db).lockMutations()
      const active = await this.db
        .prepare('SELECT execution_id FROM background_task_runs WHERE task_key = $1 AND finished_at IS NULL')
        .get(TASK_KEY)
      if (active) return { ok: false, code: 'proxy_operation_active' }
      // Older callers can already hold a VM claim before reaching their proxy work.
      const rows = await this.db.prepare('SELECT bound_vm_id FROM proxies WHERE bound_vm_id IS NOT NULL').all()
      const ids = [...new Set(rows.flatMap((row) => parseBoundVmIds(row.bound_vm_id)))]
      if (ids.length) {
        await new ExecutionAdmissionsRepo(this.db).lockResources({ vmIds: ids })
        const current = currentVmOperationIds(this.db)
        const operations = await this.db
          .prepare('SELECT id, uncertain_at FROM vm_operations WHERE vm_id = ANY($1::text[]) AND released_at IS NULL')
          .all([...new Set(ids.flatMap(physicalVmAliases))])
        if (operations.some((operation) => !current.has(operation.id) || operation.uncertain_at))
          return { ok: false, code: 'vm_operation_active' }
      }
      const identity = { taskKey: TASK_KEY, executionId: randomUUID(), ownerId: this.ownerId }
      await this.db
        .prepare('INSERT INTO background_task_runs (task_key, execution_id, owner_id) VALUES ($1, $2, $3)')
        .run(identity.taskKey, identity.executionId, identity.ownerId)
      return this._handle(identity)
    })
  }

  _handle(identity) {
    let uncertain = false
    let closed = false
    let marking = null
    let releasing = null
    const claim = {
      ok: true,
      ...identity,
      get uncertain() {
        return uncertain
      },
      run: async (callback) => {
        if (closed || uncertain) throw error('proxy_operation_inactive')
        const parents = callbacks.getStore() || []
        const context = { db: this.db, identity, claim, active: true }
        try {
          return await callbacks.run([...parents, context], () => callback(claim))
        } finally {
          context.active = false
        }
      },
      markUncertain: () => {
        uncertain = true
        if (!marking) {
          const pending = this.runs.markUnknown(identity)
          marking = pending
          pending.catch(() => {
            if (marking === pending) marking = null
          })
        }
        return marking
      },
      release: async () => {
        if (uncertain) {
          if (marking) await marking
          return { released: false }
        }
        if (!releasing) {
          const pending = this.runs.complete(identity).then((result) => {
            if (result.completed) closed = true
            return { released: result.completed }
          })
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
    return claim
  }

  async run(callback) {
    const parent = contextFor(this.db)
    if (parent) {
      let nested
      try {
        nested = await callback(parent.claim)
      } catch (failure) {
        if (failure?.proxyOperationNotStarted !== true) await parent.claim.markUncertain()
        throw failure
      }
      if (nested?.terminal !== true && nested?.notStarted !== true) await parent.claim.markUncertain()
      return nested?.value
    }
    const claim = await this.tryAcquire()
    if (!claim.ok) throw error(claim.code)
    let result
    try {
      result = await claim.run(callback)
    } catch (failure) {
      if (failure?.proxyOperationNotStarted === true && !claim.uncertain) {
        if (!(await claim.release()).released) throw error('proxy_operation_release_unconfirmed')
      } else await claim.markUncertain()
      throw failure
    }
    if (claim.uncertain || (result?.terminal !== true && result?.notStarted !== true)) await claim.markUncertain()
    else if (!(await claim.release()).released) throw error('proxy_operation_release_unconfirmed')
    return result?.value
  }
}

/** Called under ProxiesRepo.lockMutations, so a claim cannot race a binding transaction. */
export async function assertCurrentProxyOperation(db) {
  if (!db.isTransaction) throw error('proxy_operation_transaction_required', 500)
  const row = await db
    .prepare(
      'SELECT task_key, execution_id, owner_id, unknown_at FROM background_task_runs WHERE task_key = $1 AND finished_at IS NULL',
    )
    .get(TASK_KEY)
  if (!row) {
    if (
      (callbacks.getStore() || []).some(
        (context) => context.db.schema === db.schema && context.db.connectionString === db.connectionString,
      )
    )
      throw error('proxy_operation_inactive')
    return
  }
  const current = contextFor(db)?.identity
  if (
    row.unknown_at ||
    !current ||
    current.taskKey !== row.task_key ||
    current.executionId !== row.execution_id ||
    current.ownerId !== row.owner_id
  )
    throw error('proxy_operation_active')
}

export function markCurrentProxyOperationUncertain(db) {
  return contextFor(db)?.claim.markUncertain()
}

export function getSharedProxyOperations(db = getDb()) {
  if (!services.has(db)) services.set(db, new SharedProxyOperations(db))
  return services.get(db)
}
