/**
 * Repository for `accounts` and `account_allocations`.
 *
 * The `accounts` table stores id/platform/type/extra/priority/schedulable/
 * rate_limited_at/… with timestamps as ISO-8601 TEXT. The public record
 * keeps the fields used by the pool and panel layers:
 * account_id, max_concurrency, unified, last_blocked, last_cli_rate_limit.
 * The unified/blocked/rate-limit snapshots live inside the `extra` JSON.
 */

import { getDb } from '../database.mjs'

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

export function rowToAccount(row) {
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
    window_history: extra.window_history ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at,
  }
}

function buildExtra(acc) {
  return JSON.stringify({
    unified: acc.unified ?? null,
    last_blocked: acc.last_blocked ?? null,
    last_cli_rate_limit: acc.last_cli_rate_limit ?? null,
    window_history: acc.window_history ?? null,
  })
}

export class AccountsRepo {
  constructor(db = getDb()) {
    this.db = db
    this._get = db.prepare('SELECT * FROM accounts WHERE id = ?')
    this._list = db.prepare('SELECT * FROM accounts ORDER BY id')
    this._insert = db.prepare(`
      INSERT INTO accounts (id, vm_id, email, name, platform, type, status,
                            concurrency, concurrency_override,
                            max_rpm, rpm_override,
                            requests, tokens_in, tokens_out,
                            cache_read_tokens, cache_creation_tokens,
                            extra, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this._update = db.prepare(`
      UPDATE accounts SET vm_id = ?, email = ?, name = ?, type = ?,
                          concurrency = ?, concurrency_override = ?,
                          max_rpm = ?, rpm_override = ?,
                          requests = ?, tokens_in = ?, tokens_out = ?,
                          cache_read_tokens = ?, cache_creation_tokens = ?,
                          extra = ?, updated_at = ?
      WHERE id = ?
    `)
    this._insertAlloc = db.prepare(`
      INSERT INTO account_allocations (account_id, at, source, util_5h, util_7d, status_5h, status_7d, claim, tokens_in, tokens_out)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this._trimAlloc = db.prepare(`
      DELETE FROM account_allocations WHERE account_id = ? AND id NOT IN (
        SELECT id FROM account_allocations WHERE account_id = ? ORDER BY id DESC LIMIT ?
      )
    `)
    this._recentAlloc = db.prepare(`
      SELECT * FROM account_allocations WHERE account_id = ? ORDER BY id DESC LIMIT ?
    `)
    this._removeAllocs = db.prepare('DELETE FROM account_allocations WHERE account_id = ?')
    this._remove = db.prepare('DELETE FROM accounts WHERE id = ?')
  }

  get(accountId) {
    return rowToAccount(this._get.get(accountId))
  }

  list() {
    return this._list.all().map(rowToAccount)
  }

  /** Insert if missing, returns stored account. */
  insert(acc) {
    const now = new Date().toISOString()
    this._insert.run(
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
      acc.requests ?? 0,
      acc.tokens_in ?? 0,
      acc.tokens_out ?? 0,
      acc.cache_read_tokens ?? 0,
      acc.cache_creation_tokens ?? 0,
      buildExtra(acc),
      acc.created_at ?? now,
      acc.updated_at ?? now,
    )
    return this.get(acc.account_id)
  }

  /** Full-row save of a mutated account object. */
  save(acc) {
    this._update.run(
      acc.vm_id ?? null,
      acc.email ?? null,
      acc.name ?? acc.email ?? acc.account_id,
      acc.type ?? 'oauth',
      acc.max_concurrency ?? 2,
      acc.concurrency_override ? 1 : 0,
      acc.max_rpm ?? 0,
      acc.rpm_override ? 1 : 0,
      acc.requests ?? 0,
      acc.tokens_in ?? 0,
      acc.tokens_out ?? 0,
      acc.cache_read_tokens ?? 0,
      acc.cache_creation_tokens ?? 0,
      buildExtra(acc),
      new Date().toISOString(),
      acc.account_id,
    )
    return this.get(acc.account_id)
  }

  remove(accountId) {
    this._removeAllocs.run(accountId)
    const info = this._remove.run(accountId)
    return info.changes > 0
  }

  addAllocation(accountId, alloc, { max = MAX_ALLOCATIONS_PER_ACCOUNT } = {}) {
    this._insertAlloc.run(
      accountId,
      alloc.at || new Date().toISOString(),
      alloc.source ?? null,
      alloc.util_5h ?? null,
      alloc.util_7d ?? null,
      alloc.status_5h ?? null,
      alloc.status_7d ?? null,
      alloc.claim ?? null,
      alloc.tokens_in ?? null,
      alloc.tokens_out ?? null,
    )
    this._trimAlloc.run(accountId, accountId, max)
  }

  recentAllocations(accountId, limit = 5) {
    return this._recentAlloc
      .all(accountId, limit)
      .reverse()
      .map((r) => ({
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

  allocationCount(accountId) {
    return this.db.prepare('SELECT COUNT(*) c FROM account_allocations WHERE account_id = ?').get(accountId).c
  }
}
