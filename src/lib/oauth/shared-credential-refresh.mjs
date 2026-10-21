import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { getDb, getActivityCoordinator, withTransaction } from '../db/database.mjs'
import { getSharedBackgroundTasks } from '../core/shared-background-tasks.mjs'
import { SharedVmOperations, currentVmOperationIds } from '../vm/shared-vm-operations.mjs'

const services = new WeakMap()
const refreshAttempts = new AsyncLocalStorage()
export function currentCredentialRefreshAttempt(db) {
  const context = refreshAttempts.getStore()
  if (
    !context?.active ||
    context.operation.uncertain ||
    context.db.schema !== db.schema ||
    context.db.connectionString !== db.connectionString
  )
    return null
  return context
}
const admissionContext = new AsyncLocalStorage()

export async function withRefreshAdmission(db, admission, callback) {
  if (!admission?.admissionId) return admissionContext.run(null, callback)
  const context = { db, admission: { ...admission, db }, active: true }
  try {
    return await admissionContext.run(context, callback)
  } finally {
    context.active = false
  }
}

export function currentRefreshAdmission(db = null) {
  const context = admissionContext.getStore()
  if (
    !context?.active ||
    (db && (context.db.schema !== db.schema || context.db.connectionString !== db.connectionString))
  )
    return null
  return context.admission
}

function failure(code) {
  return Object.assign(new Error(code.replaceAll('_', ' ')), { code, status: 409 })
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    )
  return value
}

/** An opaque observation of a credential; tokens are never written to task results. */
export function credentialGeneration(credential) {
  if (!credential || typeof credential !== 'object') throw failure('credential_generation_required')
  return createHash('sha256')
    .update(JSON.stringify(canonical(credential)))
    .digest('hex')
}

function checkCurrent(current) {
  if (typeof current?.generation !== 'string' || !current.generation || !current.credential)
    throw failure('credential_generation_required')
  return current
}

/** A refresh claim remains occupied until publication and its terminal SQL are confirmed. */
export class SharedCredentialRefresh {
  constructor(db, { ownerId } = {}) {
    this.db = db
    this.tasks = getSharedBackgroundTasks(db)
    this.mutations = new SharedVmOperations(db, ownerId ? { ownerId } : undefined)
  }

  run(input, callbacks) {
    return this.tasks.track(this._activity(input, callbacks))
  }

  async _activity(input, callbacks) {
    if (typeof input?.expectedGeneration !== 'string' || !input.expectedGeneration)
      throw failure('credential_generation_required')
    if (!['claude', 'codex'].includes(input.platform) || !input.vmId || !input.accountId)
      throw failure('invalid_credential_refresh')
    let activity
    try {
      activity = await getActivityCoordinator(this.db)?.admit({ kind: 'credential_refresh' })
    } catch (error) {
      if (error.code === 'database_maintenance') error.credentialRefreshNotStarted = true
      throw error
    }
    const state = { unknown: false }
    try {
      const invoke = () => this._run(input, callbacks, state)
      return await (activity ? activity.run(invoke) : invoke())
    } finally {
      if (state.unknown) await activity?.markUncertain('credential_refresh_unknown')
      else await activity?.complete({ ended: true, reason: 'credential_refresh_completed' })
    }
  }

  async _joined(taskKey, latest, { readCurrent }) {
    // Waiting never changes ownership or treats elapsed time as execution completion.
    for (let count = 0; latest && !latest.finishedAt && !latest.unknownAt && count < 200; count++) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      latest = await this.tasks.repo.latest(taskKey)
    }
    if (!latest?.finishedAt) return { finished: false, unknown: true, shared: true }
    const current = checkCurrent(await readCurrent())
    const meta = latest.sharedResult
    if (meta?.ok && current.generation !== meta.generation) throw failure('credential_projection_stale')
    return {
      finished: true,
      unknown: false,
      shared: true,
      current,
      value: { ok: meta?.ok === true, ...(meta?.code ? { error: meta.code } : {}) },
    }
  }

  async _run(input, callbacks, state) {
    const { platform, vmId, accountId, expectedGeneration, admission } = input
    const { readCurrent, refresh, publish } = callbacks
    const taskKey = `oauth-refresh:${platform}:${accountId}`
    const observed = await this.tasks.repo.latest(taskKey)
    if (observed && !observed.finishedAt) return this._joined(taskKey, observed, callbacks)
    const current = checkCurrent(await readCurrent())
    if (current.generation !== expectedGeneration)
      return { finished: true, unknown: false, shared: true, current, value: { ok: true } }
    if (
      observed?.sharedResult?.ok &&
      observed.sharedResult.inputGeneration === expectedGeneration &&
      observed.sharedResult.generation !== expectedGeneration
    )
      throw failure('credential_projection_stale')
    let claim
    try {
      claim = await this.tasks.tryClaim({
        taskKey,
        executionId: randomUUID(),
        ifPreviousExecutionId: observed?.executionId ?? null,
      })
    } catch (error) {
      if (error.code === 'database_maintenance') error.credentialRefreshNotStarted = true
      throw error
    }
    if (!claim.ok) return this._joined(taskKey, await this.tasks.repo.latest(taskKey), callbacks)
    let acquired = false
    let metadata
    try {
      const inherited = currentVmOperationIds(this.db)
      const result = await claim.run(() =>
        this.mutations.run(
          vmId,
          async (operation) => {
            acquired = true
            const fresh = checkCurrent(await readCurrent())
            let outcome = { finished: true, value: { ok: true } }
            let next = fresh
            if (fresh.generation === expectedGeneration) {
              const attempt = { db: this.db, operation, claim, accountId, vmId, active: true }
              try {
                outcome = await refreshAttempts.run(attempt, () => refresh(fresh, { operation, claim }))
              } finally {
                attempt.active = false
              }
              if (outcome?.finished !== true) {
                state.unknown = true
                return {
                  finished: false,
                  unknown: true,
                  shared: false,
                  value: outcome?.value,
                  vmOperationUncertain: true,
                }
              }
              if (outcome.value?.ok === true) next = checkCurrent(await publish(fresh, outcome.value))
            }
            metadata = {
              ok: outcome.value?.ok === true,
              inputGeneration: expectedGeneration,
              generation: next.generation,
              // Only an explicit machine code can cross the shared-result boundary.
              ...(typeof outcome.value?.error === 'string' && /^[a-z][a-z0-9_]{0,100}$/.test(outcome.value.error)
                ? { code: outcome.value.error }
                : {}),
            }
            await withTransaction(this.db, async () => {
              if (!(await this.tasks.complete(claim, { sharedResult: metadata })).completed)
                throw failure('credential_refresh_completion_unconfirmed')
              if (!inherited.has(operation.operationId) && !(await this.mutations.release(operation)).released)
                throw failure('vm_operation_release_unconfirmed')
            })
            return { finished: true, unknown: false, shared: false, current: next, value: outcome.value }
          },
          { kind: 'credential_refresh', accountId, admission },
        ),
      )
      if (result.unknown) {
        await claim.markUnknown()
        return result
      }
      if (!(await claim.complete({ sharedResult: metadata })).completed)
        throw failure('credential_refresh_completion_unconfirmed')
      return result
    } catch (error) {
      if (acquired && error.vmOperationNotStarted === true && error.credentialRefreshNotStarted === true) {
        if (!(await claim.complete({ sharedResult: { ok: false, code: 'refresh_not_started' } })).completed)
          throw failure('credential_refresh_completion_unconfirmed')
      } else if (acquired) {
        state.unknown = true
        await claim.markUnknown()
      } else {
        // No mutation callback ran; the claim has caused no remote or credential effect.
        if (!(await claim.complete({ sharedResult: { ok: false, code: 'refresh_not_started' } })).completed)
          throw failure('credential_refresh_completion_unconfirmed')
        if (['vm_operation_active', 'vm_execution_active'].includes(error.code))
          error.credentialRefreshNotStarted = true
      }
      throw error
    }
  }
}

export function getSharedCredentialRefresh(db = getDb()) {
  let service = services.get(db)
  if (!service) {
    service = new SharedCredentialRefresh(db)
    services.set(db, service)
  }
  return service
}
