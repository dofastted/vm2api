/**
 * accounts + account_allocations repository (sub2api-shaped table).
 *
 * The table follows the sub2api Account columns (id/platform/type/extra/
 * priority/schedulable/rate_limited_at/…, ISO-8601 TEXT timestamps) while the
 * public record shape stays what the pool/panel layers always consumed:
 * account_id, max_concurrency, unified, last_blocked, last_cli_rate_limit.
 * The unified/blocked/rate-limit snapshots live inside the `extra` JSON.
 */

import { getDb, withTransaction } from '../database.mjs'
import { addInteger, integerValue } from '../integers.mjs'
import { isDeepStrictEqual } from 'node:util'

const MAX_ALLOCATIONS_PER_ACCOUNT = 50
const COUNTERS = ['requests', 'tokens_in', 'tokens_out', 'cache_read_tokens', 'cache_creation_tokens']
const FIELDS = {
  vm_id: 'vm_id',
  email: 'email',
  name: 'name',
  platform: 'platform',
  type: 'type',
  status: 'status',
  priority: 'priority',
  rate_multiplier: 'rate_multiplier',
  schedulable: 'schedulable',
  max_concurrency: 'concurrency',
  concurrency_override: 'concurrency_override',
  max_rpm: 'max_rpm',
  rpm_override: 'rpm_override',
}

function observationChanges(before, after, path, out) {
  if (isDeepStrictEqual(before, after)) return
  if (after && typeof after === 'object' && !Array.isArray(after)) {
    const previous = before && typeof before === 'object' && !Array.isArray(before) ? before : {}
    for (const key of new Set([...Object.keys(previous), ...Object.keys(after)])) {
      observationChanges(previous[key], after[key], [...path, key], out)
    }
  } else {
    out.push({ path, value: after, before })
  }
}

function touchObservation(before, after, path, out) {
  if (after && typeof after === 'object' && !Array.isArray(after) && Object.keys(after).length) {
    for (const key of Object.keys(after)) touchObservation(before?.[key], after[key], [...path, key], out)
    return
  }
  if (!out.some((change) => isDeepStrictEqual(change.path, path))) out.push({ path, value: after, before })
}

/** Describe the caller's mutations, never persist the unchanged parts of its cached account. */
export function accountChanges(before, after, { paths = [] } = {}) {
  const fields = {}
  const deltas = {}
  const observations = []
  for (const field of Object.keys(FIELDS)) {
    if (!isDeepStrictEqual(before[field], after[field])) fields[field] = after[field] ?? null
  }
  for (const field of COUNTERS) {
    const delta = addInteger(after[field], (-BigInt(integerValue(before[field]))).toString())
    if (delta !== 0) deltas[field] = delta
  }
  for (const field of ['unified', 'last_blocked', 'last_cli_rate_limit']) {
    observationChanges(before[field], after[field], [field], observations)
  }
  for (const path of paths) touchObservation(valueAt(before, path), valueAt(after, path), path, observations)
  for (const change of observations) {
    const path = change.path
    // Reset/status/utilization describe one window. A stale cleanup must compare the whole window.
    const window =
      path[0] === 'unified' && ['headers', 'official'].includes(path[1]) ? path.slice(0, 3) : path.slice(0, 2)
    change.guardPath =
      path[0] === 'unified' && ['5h', '7d', '7d_oi', 'last_probe', 'fable'].includes(window.at(-1)) ? window : path
    change.guardBefore = valueAt(before, change.guardPath)
  }
  return { fields, deltas, observations }
}

function valueAt(object, path) {
  return path.reduce((value, key) => value?.[key], object)
}

function setAt(object, path, value) {
  let target = object
  for (const key of path.slice(0, -1)) {
    if (!Object.hasOwn(target, key) || !target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
      Object.defineProperty(target, key, { value: {}, writable: true, enumerable: true, configurable: true })
    }
    target = target[key]
  }
  if (value === undefined) delete target[path.at(-1)]
  else
    Object.defineProperty(target, path.at(-1), {
      value: structuredClone(value),
      writable: true,
      enumerable: true,
      configurable: true,
    })
}

function overlapping(left, right) {
  return left.slice(0, Math.min(left.length, right.length)).every((key, index) => key === right[index])
}

function parse(json, fallback = null) {
  if (json == null) return fallback
  try {
    return JSON.parse(json)
  } catch {
    return fallback
  }
}

const DEFAULT_UNIFIED = () => ({
  '5h': { utilization: 0, reset: null, status: 'active' },
  '7d': { utilization: 0, reset: null, status: 'active' },
  representative_claim: null,
  overage_status: null,
  updated_at: null,
})

function rowToAccount(row) {
  if (!row) return null
  const extra = parse(row.extra, {}) || {}
  return {
    account_id: row.id,
    vm_id: row.vm_id,
    email: row.email,
    name: row.name || null,
    platform: row.platform || 'claude',
    type: row.type || 'oauth',
    status: row.status || 'active',
    priority: row.priority ?? 50,
    rate_multiplier: row.rate_multiplier ?? 1,
    schedulable: row.schedulable == null ? true : !!row.schedulable,
    max_concurrency: row.concurrency,
    concurrency_override: row.concurrency_override ? 1 : 0,
    max_rpm: row.max_rpm ?? 0,
    rpm_override: row.rpm_override ? 1 : 0,
    requests: row.requests || 0,
    tokens_in: row.tokens_in || 0,
    tokens_out: row.tokens_out || 0,
    cache_read_tokens: row.cache_read_tokens || 0,
    cache_creation_tokens: row.cache_creation_tokens || 0,
    unified: extra.unified ?? DEFAULT_UNIFIED(),
    last_blocked: extra.last_blocked ?? null,
    last_cli_rate_limit: extra.last_cli_rate_limit ?? null,
    updated_at: row.updated_at,
  }
}

function buildExtra(acc) {
  return JSON.stringify({
    unified: acc.unified ?? null,
    last_blocked: acc.last_blocked ?? null,
    last_cli_rate_limit: acc.last_cli_rate_limit ?? null,
  })
}

export class AccountsRepo {
  constructor(db = getDb()) {
    this.db = db
    this.snapshots = new WeakMap()
    this._get = db.prepare('SELECT * FROM accounts WHERE id = $1')
    this._list = db.prepare('SELECT * FROM accounts ORDER BY id')
    this._insert = db.prepare(`
      INSERT INTO accounts (id, vm_id, email, name, platform, type, status,
                            concurrency, concurrency_override,
                            max_rpm, rpm_override,
                            requests, tokens_in, tokens_out,
                            cache_read_tokens, cache_creation_tokens,
                            extra, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      ON CONFLICT (id) DO NOTHING
    `)
    this._nextObservation = db.prepare("SELECT nextval('account_observation_seq') AS observation")
    this._lock = db.prepare('SELECT * FROM accounts WHERE id = $1 FOR UPDATE')
    this._observe = db.prepare(`
      UPDATE accounts SET extra = $1, observation_versions = $2::jsonb, updated_at = $3
      WHERE id = $4
    `)
    this._insertAlloc = db.prepare(`
      INSERT INTO account_allocations (account_id, at, source, util_5h, util_7d, status_5h, status_7d, claim, tokens_in, tokens_out)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `)
    this._trimAlloc = db.prepare(`
      DELETE FROM account_allocations WHERE account_id = $1 AND id NOT IN (
        SELECT id FROM account_allocations WHERE account_id = $2 ORDER BY id DESC LIMIT $3
      )
    `)
    this._recentAlloc = db.prepare(`
      SELECT * FROM account_allocations WHERE account_id = $1 ORDER BY id DESC LIMIT $2
    `)
    this._removeAllocs = db.prepare('DELETE FROM account_allocations WHERE account_id = $1')
    this._removeGroups = db.prepare('DELETE FROM account_groups WHERE account_id = $1')
    this._remove = db.prepare('DELETE FROM accounts WHERE id = $1')
    this._linkGroup = db.prepare(`
      INSERT INTO account_groups (account_id, group_id, priority, created_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT(account_id, group_id) DO NOTHING
    `)
  }

  async get(accountId) {
    const account = rowToAccount(await this._get.get(accountId))
    if (account) this.snapshots.set(account, structuredClone(account))
    return account
  }

  async list() {
    return (await this._list.all()).map((row) => {
      const account = rowToAccount(row)
      this.snapshots.set(account, structuredClone(account))
      return account
    })
  }

  /** Insert if missing, returns stored account. New accounts join the coding group (id=1). */
  async insert(acc) {
    return withTransaction(this.db, async () => {
      const now = new Date().toISOString()
      await this._insert.run(
        acc.account_id,
        acc.vm_id ?? null,
        acc.email ?? null,
        acc.name ?? acc.email ?? acc.account_id,
        acc.platform ?? 'claude',
        acc.type ?? 'oauth',
        acc.status ?? 'active',
        acc.max_concurrency ?? 2,
        acc.concurrency_override ? 1 : 0,
        acc.max_rpm ?? 0,
        acc.rpm_override ? 1 : 0,
        integerValue(acc.requests),
        integerValue(acc.tokens_in),
        integerValue(acc.tokens_out),
        integerValue(acc.cache_read_tokens),
        integerValue(acc.cache_creation_tokens),
        buildExtra(acc),
        acc.created_at ?? now,
        acc.updated_at ?? now,
      )
      await this._linkGroup.run(acc.account_id, acc.group_id ?? 1, acc.group_priority ?? 50, now)
      return await this.get(acc.account_id)
    })
  }

  /** Compatibility for callers mutating a snapshot returned by this repository. */
  async save(acc) {
    for (const field of COUNTERS) integerValue(acc[field])
    const before = this.snapshots.get(acc)
    if (!before) throw new Error('account save requires a repository snapshot; use an explicit patch')
    const stored = await this.applyChanges(acc.account_id, accountChanges(before, acc))
    this.snapshots.set(acc, structuredClone(acc))
    return stored
  }

  async beginObservation() {
    return (await this._nextObservation.get()).observation
  }

  async patchFields(accountId, fields) {
    const entries = Object.entries(fields)
    for (const [field] of entries) {
      if (!Object.hasOwn(FIELDS, field)) throw new Error(`unsupported account field: ${field}`)
    }
    if (!entries.length) return this.get(accountId)
    const values = entries.map(([field, value]) =>
      ['schedulable', 'concurrency_override', 'rpm_override'].includes(field) ? (value ? 1 : 0) : value,
    )
    const assignments = entries.map(([field], index) => `${FIELDS[field]} = $${index + 1}`)
    values.push(new Date().toISOString(), accountId)
    const row = await this.db
      .prepare(`UPDATE accounts SET ${assignments.join(', ')},
      updated_at = $${values.length - 1} WHERE id = $${values.length} RETURNING *`)
      .get(...values)
    return rowToAccount(row)
  }

  async incrementUsage(accountId, deltas) {
    const values = COUNTERS.map((field) => integerValue(deltas[field]))
    values.push(new Date().toISOString(), accountId)
    return rowToAccount(
      await this.db
        .prepare(`UPDATE accounts SET
      ${COUNTERS.map((field, index) => `${field} = COALESCE(${field}, 0) + $${index + 1}::bigint`).join(', ')},
      updated_at = $6 WHERE id = $7 RETURNING *`)
        .get(...values),
    )
  }

  async patchObservation(accountId, changes, observation, { conditional = false, probeBase } = {}) {
    const sequence = BigInt(observation)
    return withTransaction(this.db, async () => {
      const row = await this._lock.get(accountId)
      if (!row) return null
      const extra = parse(row.extra, {}) || {}
      const versions = row.observation_versions || {}
      const probeChanged = probeBase !== undefined && !isDeepStrictEqual(extra.unified?.last_probe ?? null, probeBase)
      const applicable = changes.map(
        (change) =>
          !conditional ||
          isDeepStrictEqual(valueAt(extra, change.guardPath || change.path), change.guardBefore ?? change.before),
      )
      let changed = false
      for (const [index, change] of changes.entries()) {
        if (!['unified', 'last_blocked', 'last_cli_rate_limit'].includes(change.path[0])) {
          throw new Error('unsupported account observation')
        }
        if (
          Object.entries(versions).some(
            ([path, version]) => overlapping(JSON.parse(path), change.path) && BigInt(version) > sequence,
          )
        )
          continue
        if (probeChanged && change.path[0] === 'unified' && change.path[1] === 'last_probe') continue
        if (!applicable[index]) continue
        setAt(extra, change.path, change.value)
        versions[JSON.stringify(change.path)] = sequence.toString()
        changed = true
      }
      if (changed)
        await this._observe.run(JSON.stringify(extra), JSON.stringify(versions), new Date().toISOString(), accountId)
      return this.get(accountId)
    })
  }

  async applyChanges(accountId, { fields = {}, deltas = {}, observations = [] }, options = {}) {
    const observation = observations.length ? await (options.observation ?? this.beginObservation()) : null
    return withTransaction(this.db, async () => {
      if (Object.keys(fields).length) await this.patchFields(accountId, fields)
      if (Object.keys(deltas).length) await this.incrementUsage(accountId, deltas)
      if (observations.length) await this.patchObservation(accountId, observations, observation, options)
      return this.get(accountId)
    })
  }

  async remove(accountId) {
    return withTransaction(this.db, async () => {
      await this._removeAllocs.run(accountId)
      await this._removeGroups.run(accountId)
      const info = await this._remove.run(accountId)
      return info.changes > 0
    })
  }

  async addAllocation(accountId, alloc, { max = MAX_ALLOCATIONS_PER_ACCOUNT } = {}) {
    return withTransaction(this.db, async () => {
      await this._insertAlloc.run(
        accountId,
        alloc.at || new Date().toISOString(),
        alloc.source ?? null,
        alloc.util_5h ?? null,
        alloc.util_7d ?? null,
        alloc.status_5h ?? null,
        alloc.status_7d ?? null,
        alloc.claim ?? null,
        alloc.tokens_in == null ? null : integerValue(alloc.tokens_in),
        alloc.tokens_out == null ? null : integerValue(alloc.tokens_out),
      )
      await this._trimAlloc.run(accountId, accountId, max)
    })
  }

  async recentAllocations(accountId, limit = 5) {
    return (await this._recentAlloc.all(accountId, limit)).reverse().map((r) => ({
      at: r.at,
      source: r.source ?? undefined,
      util_5h: r.util_5h,
      util_7d: r.util_7d,
      status_5h: r.status_5h ?? undefined,
      status_7d: r.status_7d ?? undefined,
      claim: r.claim,
      tokens_in: r.tokens_in,
      tokens_out: r.tokens_out,
    }))
  }

  async allocationCount(accountId) {
    return (await this.db.prepare('SELECT COUNT(*) c FROM account_allocations WHERE account_id = $1').get(accountId)).c
  }
}
