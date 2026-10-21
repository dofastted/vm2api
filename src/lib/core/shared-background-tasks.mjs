import { randomUUID } from 'node:crypto'
import { getDb, getActivityCoordinator } from '../db/database.mjs'
import { BackgroundTaskRunsRepo } from '../db/repos/background-task-runs-repo.mjs'
import { isKubernetesMode } from './control-plane-mode.mjs'

const services = new WeakMap()

/** Unknown work remains occupied until an explicit recovery protocol proves it ended. */
export class SharedBackgroundTasks {
  constructor(db, { ownerId = randomUUID() } = {}) {
    this.db = db
    this.repo = new BackgroundTaskRunsRepo(db)
    this.ownerId = ownerId
    this.pending = new Set()
  }

  _coordinator() {
    const coordinator = getActivityCoordinator(this.db)
    if (!coordinator && isKubernetesMode()) {
      throw Object.assign(new Error('background activity coordinator unavailable'), { code: 'maintenance_unavailable' })
    }
    return coordinator
  }

  async now() {
    const activity = await this._coordinator()?.admit({ kind: 'background_clock' })
    try {
      return await (activity ? activity.run(() => this.repo.now()) : this.repo.now())
    } finally {
      await activity?.complete({ ended: true, reason: 'clock_read_completed' })
    }
  }

  async tryClaim(plan) {
    const activity = await this._coordinator()?.admit({
      kind: 'background',
      requestId: plan.executionId || plan.taskKey,
    })
    const run = (fn) => (activity ? activity.run(fn) : fn())
    let identity
    try {
      identity = await run(() => this.repo.tryClaim({ ...plan, ownerId: this.ownerId }))
    } catch (error) {
      await activity?.complete({ ended: true, reason: 'background_claim_not_started' })
      throw error
    }
    if (!identity.ok) {
      await activity?.complete({ ended: true, reason: 'background_claim_rejected' })
      return identity
    }
    let unknown = false
    let marking = null
    let completing = null
    return {
      ...identity,
      run,
      markUnknown: () => {
        unknown = true
        if (!marking) {
          const pending = (async () => {
            const result = await run(() => this.markUnknown(identity))
            await activity?.markUncertain('background_task_unknown')
            return result
          })()
          marking = pending
          pending.catch(() => {
            if (marking === pending) marking = null
          })
        }
        return marking
      },
      complete: async (options) => {
        if (unknown) {
          if (marking) await marking
          return { completed: false }
        }
        if (!completing) {
          const pending = (async () => {
            const result = await run(() => this.complete(identity, options))
            if (result.completed) await activity?.complete({ ended: true, reason: 'background_task_completed' })
            else await activity?.markUncertain('background_task_completion_unconfirmed')
            return result
          })()
          completing = pending
          pending.then(
            (result) => {
              if (!result.completed && completing === pending) completing = null
            },
            () => {
              if (completing === pending) completing = null
            },
          )
        }
        return completing
      },
    }
  }

  markUnknown(identity) {
    return this.repo.markUnknown(identity)
  }

  complete(identity, options) {
    return this.repo.complete(identity, options)
  }

  run(plan, callback) {
    return this.track(this._run(plan, callback))
  }

  track(pending) {
    this.pending.add(pending)
    pending.then(
      () => this.pending.delete(pending),
      () => this.pending.delete(pending),
    )
    return pending
  }

  async _run(plan, callback) {
    const claim = await this.tryClaim(plan)
    if (!claim.ok)
      return {
        ran: false,
        code: claim.code,
        ...(Object.hasOwn(claim, 'sharedResult') ? { sharedResult: claim.sharedResult } : {}),
      }
    let outcome
    try {
      outcome = await claim.run(callback)
    } catch (error) {
      if (error?.taskNotStarted === true || error?.taskTerminal === true) await this._complete(claim)
      else await claim.markUnknown()
      throw error
    }
    const terminal = outcome?.terminal === true || outcome?.notStarted === true
    if (terminal) {
      await this._complete(
        claim,
        Object.hasOwn(outcome, 'sharedResult') ? { sharedResult: outcome.sharedResult } : undefined,
      )
    } else {
      await claim.markUnknown()
    }
    return { ran: true, value: outcome?.value, unknown: !terminal }
  }

  async _complete(claim, options) {
    if (!(await claim.complete(options)).completed) {
      throw Object.assign(new Error('background task completion unconfirmed'), {
        code: 'background_task_completion_unconfirmed',
      })
    }
  }

  async flush() {
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }
}

export function getSharedBackgroundTasks(db = getDb()) {
  let service = services.get(db)
  if (!service) {
    service = new SharedBackgroundTasks(db)
    services.set(db, service)
  }
  return service
}

/** Tests can inject a service; standalone keeps its original local scheduling. */
export function backgroundTasksFor(injected) {
  if (injected !== undefined) return injected
  return isKubernetesMode() ? getSharedBackgroundTasks() : null
}
