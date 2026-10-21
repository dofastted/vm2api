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
import { integerValue } from '../integers.mjs'

const MAX_ALLOCATIONS_PER_ACCOUNT = 50

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
    `)
    this._update = db.prepare(`
      UPDATE accounts SET vm_id = $1, email = $2, name = $3, type = $4,
                          concurrency = $5, concurrency_override = $6,
                          max_rpm = $7, rpm_override = $8,
                          requests = $9, tokens_in = $10, tokens_out = $11,
                          cache_read_tokens = $12, cache_creation_tokens = $13,
                          extra = $14, updated_at = $15
      WHERE id = $16
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
    return rowToAccount(await this._get.get(accountId))
  }

  async list() {
    return (await this._list.all()).map(rowToAccount)
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

  /** Full-row save of a mutated account object. */
  async save(acc) {
    await this._update.run(
      acc.vm_id ?? null,
      acc.email ?? null,
      acc.name ?? acc.email ?? acc.account_id,
      acc.type ?? 'oauth',
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
      new Date().toISOString(),
      acc.account_id,
    )
    return await this.get(acc.account_id)
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
