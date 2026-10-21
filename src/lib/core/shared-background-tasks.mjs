import { randomUUID } from 'node:crypto'
import { getDb } from '../db/database.mjs'
import { BackgroundTaskRunsRepo } from '../db/repos/background-task-runs-repo.mjs'
import { isKubernetesMode } from './control-plane-mode.mjs'

const services = new WeakMap()

/** Unknown work remains occupied until an explicit recovery protocol proves it ended. */
export class SharedBackgroundTasks {
  constructor(db, { ownerId = randomUUID() } = {}) {
    this.repo = new BackgroundTaskRunsRepo(db)
    this.ownerId = ownerId
    this.pending = new Set()
  }

  now() {
    return this.repo.now()
  }

  async tryClaim(plan) {
    const identity = await this.repo.tryClaim({ ...plan, ownerId: this.ownerId })
    if (!identity.ok) return identity
    let unknown = false
    let marking = null
    let completing = null
    return {
      ...identity,
      markUnknown: () => {
        unknown = true
        if (!marking) {
          const pending = this.markUnknown(identity)
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
          const pending = this.complete(identity, options)
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
    const pending = this._run(plan, callback)
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
      outcome = await callback()
    } catch (error) {
      if (error?.taskNotStarted === true) await this._complete(claim)
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
