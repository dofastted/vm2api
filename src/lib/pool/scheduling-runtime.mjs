/** Loaded scheduling state keeps eligibility checks and reservations synchronous. */
import { isDeepStrictEqual } from 'node:util'
import { AccountRuntimeRepo } from '../db/repos/account-runtime-repo.mjs'
import { WriteQueue } from './write-queue.mjs'

const WINDOW_FIELDS = {
  rateLimitedAt: 'rate_limited_at',
  rateLimitResetAt: 'rate_limit_reset_at',
  overloadUntil: 'overload_until',
  sessionWindowStart: 'session_window_start',
  sessionWindowEnd: 'session_window_end',
  sessionWindowStatus: 'session_window_status',
}

function state(input, current = {}) {
  return {
    cooldown_until: null,
    cooldown_reason: null,
    last_used_at: null,
    credential_generation: 0,
    refresh_status: null,
    worker_heartbeat_at: null,
    worker_status: null,
    rate_limited_at: null,
    rate_limit_reset_at: null,
    overload_until: null,
    session_window_start: null,
    session_window_end: null,
    session_window_status: null,
    ...current,
    ...structuredClone(input),
    status: input.status ?? current.status ?? 'unknown',
    priority: Number(input.priority ?? current.priority ?? 0),
    weight: Math.max(0, Number(input.weight ?? current.weight ?? 1)),
    model_states: structuredClone(input.model_states ?? current.model_states ?? {}),
    updated_at: new Date().toISOString(),
  }
}

export class SchedulingRuntime {
  constructor(db) {
    this.persistence = new AccountRuntimeRepo(db)
    this.rows = new Map()
    this.revisions = new Map()
    this.refreshStarted = 0
    this.refreshPublished = 0
    this.writes = this.persistence.db.schedulingWriteQueue ||= new WriteQueue(this.persistence.db)
  }

  async init() {
    await this.refresh()
    return this
  }
  flush() {
    return this.writes.flush()
  }
  beginObservation() {
    return this.persistence.beginObservation()
  }
  get(id) {
    return structuredClone(this.rows.get(id) || null)
  }
  list() {
    return [...this.rows.values()].map((row) => structuredClone(row))
  }

  async refresh() {
    await this.flush()
    const refresh = ++this.refreshStarted
    const revisions = new Map(this.revisions)
    const rows = await this.persistence.list()
    if (refresh < this.refreshPublished) return
    this.refreshPublished = refresh
    const present = new Set(rows.map((row) => row.account_id))
    for (const row of rows) {
      if (this.revisions.get(row.account_id) === revisions.get(row.account_id)) this.rows.set(row.account_id, row)
    }
    for (const id of this.rows.keys()) {
      if (!present.has(id) && this.revisions.get(id) === revisions.get(id)) this.rows.delete(id)
    }
  }

  ticket(observation) {
    const ticket = observation ?? this.beginObservation()
    ticket?.catch?.(() => {})
    return ticket
  }

  publish(next, write) {
    const id = next.account_id
    const revision = (this.revisions.get(id) || 0) + 1
    this.revisions.set(id, revision)
    this.rows.set(id, next)
    this.writes.enqueue(async () => {
      const stored = await write()
      if (stored && this.revisions.get(id) === revision) this.rows.set(id, stored)
    })
    return structuredClone(next)
  }

  upsert(input = {}, { observation, vmId } = {}) {
    const current = this.get(input.account_id) || {}
    if (!input.account_id || (input.vm_id !== undefined && !input.vm_id) || !(input.vm_id || current.vm_id || vmId))
      return null
    const next = state(input, { ...current, vm_id: current.vm_id || vmId })
    const patch = { account_id: input.account_id }
    for (const key of Object.keys(input)) {
      if (['account_id', 'model_states', 'updated_at'].includes(key)) continue
      // A caller can still supply a cached merged record. Persist its mutations,
      // while an explicit observation also versions unchanged observed fields.
      if (observation !== undefined || !isDeepStrictEqual(current[key], next[key])) patch[key] = next[key]
    }
    const modelPatch = {}
    if (input.model_states !== undefined) {
      for (const model of new Set([
        ...Object.keys(current.model_states || {}),
        ...Object.keys(input.model_states || {}),
      ])) {
        if (
          observation !== undefined ||
          !isDeepStrictEqual(current.model_states?.[model], input.model_states?.[model])
        ) {
          modelPatch[model] = input.model_states?.[model] ?? null
        }
      }
    }
    const ticket = this.ticket(observation)
    return this.publish(next, () =>
      this.persistence.upsert(patch, { observation: ticket, modelPatch, vmId: vmId || input.vm_id || current.vm_id }),
    )
  }

  remove(id) {
    const removed = this.rows.delete(id)
    this.revisions.set(id, (this.revisions.get(id) || 0) + 1)
    this.writes.enqueue(() => this.persistence.remove(id))
    return removed
  }

  updateWindow(accountId, { vmId = null, observation, ...input } = {}) {
    const current = this.get(accountId) || { account_id: accountId, vm_id: vmId }
    current.vm_id ||= vmId
    if (!current.vm_id) return null
    const fields = {}
    for (const [key, field] of Object.entries(WINDOW_FIELDS)) if (input[key] !== undefined) fields[field] = input[key]
    const ticket = this.ticket(observation)
    return this.publish(state(fields, current), () =>
      this.persistence.updateWindow(accountId, { vmId, ...input, observation: ticket }),
    )
  }

  markCooldown(accountId, { vmId, until, reason, model = null, status = 'cooldown', observation } = {}) {
    const current = this.get(accountId) || { account_id: accountId, vm_id: vmId }
    current.vm_id ||= vmId
    if (!current.vm_id) return null
    const fields = model
      ? {
          model_states: {
            ...(current.model_states || {}),
            [model]: {
              status,
              cooldown_until: Number(until) || null,
              reason: reason || null,
              updated_at: new Date().toISOString(),
            },
          },
        }
      : {
          status,
          cooldown_until: Number(until) || null,
          cooldown_reason: reason || null,
          ...(/rate_limited|quota_exhausted/i.test(String(reason || ''))
            ? { rate_limited_at: Date.now(), rate_limit_reset_at: Number(until) || null }
            : {}),
        }
    const ticket = this.ticket(observation)
    return this.publish(state(fields, current), () =>
      this.persistence.markCooldown(accountId, { vmId, until, reason, model, status, observation: ticket }),
    )
  }

  static AUTH_COOLDOWN = AccountRuntimeRepo.AUTH_COOLDOWN
  static GRANT_REVOKE_COOLDOWN = AccountRuntimeRepo.GRANT_REVOKE_COOLDOWN
  isAuthCooldown(current) {
    return this.persistence.isAuthCooldown(current)
  }
  isGrantRevokeCooldown(current) {
    return this.persistence.isGrantRevokeCooldown(current)
  }

  clearAuthCooldown(accountId, options = {}) {
    return this.clearCooldown('clearAuthCooldown', accountId, options)
  }
  clearGrantRevokeCooldown(accountId, options = {}) {
    return this.clearCooldown('clearGrantRevokeCooldown', accountId, options)
  }
  clearAccountCooldown(accountId, options = {}) {
    return this.clearCooldown('clearAccountCooldown', accountId, options)
  }
  clearQuotaCooldown(accountId, options = {}) {
    return this.clearCooldown('clearQuotaCooldown', accountId, options)
  }

  clearCooldown(method, accountId, { vmId = null, observation } = {}) {
    const current = this.get(accountId)
    if (!current) return false
    if (method === 'clearAuthCooldown' && !this.isAuthCooldown(current)) return false
    if (method === 'clearGrantRevokeCooldown' && !this.isGrantRevokeCooldown(current)) return false
    if (method === 'clearQuotaCooldown' && !this.persistence.isQuotaCooldown(current)) return false
    const management = method === 'clearAccountCooldown'
    const fields = {
      status: 'ready',
      cooldown_until: null,
      cooldown_reason: null,
      ...(management ? { rate_limit_reset_at: null, overload_until: null, model_states: {} } : {}),
      ...(method === 'clearQuotaCooldown' ? { rate_limit_reset_at: null } : {}),
    }
    const ticket = this.ticket(observation)
    this.publish(state(fields, current), async () => {
      await this.persistence[method](accountId, {
        vmId,
        observation: ticket,
        ...(management
          ? {}
          : {
              expected: {
                cooldown_until: current.cooldown_until,
                cooldown_reason: current.cooldown_reason,
                ...(method === 'clearQuotaCooldown'
                  ? { rate_limit_reset_at: current.rate_limit_reset_at, overload_until: current.overload_until }
                  : {}),
              },
            }),
      })
      return this.persistence.get(accountId)
    })
    return true
  }

  clearExpired(now = Date.now()) {
    const changed = new Map()
    for (const current of this.list()) {
      const fields = {}
      if (current.cooldown_until && current.cooldown_until <= now)
        Object.assign(fields, { status: 'ready', cooldown_until: null, cooldown_reason: null })
      for (const field of ['rate_limit_reset_at', 'overload_until'])
        if (current[field] && current[field] <= now) fields[field] = null
      const models = { ...(current.model_states || {}) }
      for (const [model, value] of Object.entries(models))
        if (value?.cooldown_until && Number(value.cooldown_until) <= now) {
          delete models[model]
          fields.model_states = models
        }
      if (!Object.keys(fields).length) continue
      const id = current.account_id
      const revision = (this.revisions.get(id) || 0) + 1
      this.revisions.set(id, revision)
      this.rows.set(id, state(fields, current))
      changed.set(id, revision)
    }
    if (!changed.size) return
    this.writes.enqueue(async () => {
      // Re-evaluate committed values under the account row lock. A local
      // snapshot expiring cannot delete a newer or extended remote cooldown.
      await this.persistence.clearExpired(now)
      for (const [id, revision] of changed) {
        const stored = await this.persistence.get(id)
        if (stored && this.revisions.get(id) === revision) this.rows.set(id, stored)
      }
    })
  }
}
