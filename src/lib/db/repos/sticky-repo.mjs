/**
 * sticky_sessions repository — conversation key → account/VM bindings.
 */

import { getDb, withTransaction } from '../database.mjs'

function rowToEntry(row) {
  if (!row) return null
  return {
    account_id: row.account_id,
    vm_id: row.vm_id,
    session_id: row.session_id,
    device_id: row.device_id || null,
    bound_at: row.bound_at,
    expires_at: row.expires_at,
    hits: row.hits || 0,
    generation: Number(row.generation) || 0,
    slot_index: row.slot_index == null ? null : Number(row.slot_index),
  }
}

export class StickyRepo {
  constructor(db = getDb()) {
    this.db = db
    this._get = db.prepare('SELECT * FROM sticky_sessions WHERE key = $1 AND deleted_at IS NULL')
    this._upsert = db.prepare(`
      INSERT INTO sticky_sessions (key, account_id, vm_id, session_id, device_id, bound_at, expires_at, hits, generation, slot_index)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT(key) DO UPDATE SET
        account_id = excluded.account_id,
        vm_id = excluded.vm_id,
        session_id = excluded.session_id,
        device_id = COALESCE(excluded.device_id, sticky_sessions.device_id),
        bound_at = excluded.bound_at,
        expires_at = excluded.expires_at,
        hits = excluded.hits,
        generation = excluded.generation,
        slot_index = excluded.slot_index,
        deleted_at = NULL
    `)
    this._delete = db.prepare('DELETE FROM sticky_sessions WHERE key = $1')
    this._deleteByAccount = db.prepare('DELETE FROM sticky_sessions WHERE account_id = $1 OR vm_id = $2')
    this._purge = db.prepare('DELETE FROM sticky_sessions WHERE expires_at < $1')
    this._dropAlias = db.prepare(`
      DELETE FROM sticky_sessions
      WHERE key = 'envelope'
        OR ascii_fold(key) LIKE 'ch:%'
        OR ascii_fold(key) LIKE 'dev:%'
        OR ascii_fold(key) LIKE '%:envelope'
        OR ascii_fold(key) LIKE '%:ch:%'
        OR ascii_fold(key) LIKE '%:dev:%'
    `)
    this._all = db.prepare('SELECT * FROM sticky_sessions WHERE deleted_at IS NULL')
    this._count = db.prepare('SELECT COUNT(*) c FROM sticky_sessions WHERE deleted_at IS NULL')
  }

  async get(key) {
    return rowToEntry(await this._get.get(key))
  }

  async upsert(key, ent) {
    await this._upsert.run(
      key,
      ent.account_id ?? null,
      ent.vm_id ?? null,
      ent.session_id ?? null,
      ent.device_id ?? null,
      ent.bound_at ?? Date.now(),
      ent.expires_at ?? null,
      ent.hits ?? 0,
      Number(ent.generation) || 0,
      ent.slot_index == null ? null : Number(ent.slot_index),
    )
  }

  async remove(key) {
    await this._delete.run(key)
  }

  async removeByAccount({ accountId = null, vmId = null } = {}) {
    if (!accountId && !vmId) return 0
    return (await this._deleteByAccount.run(accountId || '', vmId || '')).changes
  }

  async purgeExpired(now = Date.now()) {
    return (await this._purge.run(now)).changes
  }

  /** Content fingerprints and device aliases are not conversation slots. */
  async dropAliasKeys() {
    return (await this._dropAlias.run()).changes
  }

  async all() {
    const out = {}
    for (const row of await this._all.all()) out[row.key] = rowToEntry(row)
    return out
  }

  async count() {
    return (await this._count.get()).c
  }

  async snapshot() {
    const sessions = {}
    const versions = {}
    for (const row of await this.db.prepare('SELECT * FROM sticky_sessions').all()) {
      versions[row.key] = Number(row.generation)
      if (row.deleted_at == null) sessions[row.key] = rowToEntry(row)
    }
    return { sessions, versions }
  }

  async withKeys(keys, change) {
    return withTransaction(this.db, async () => {
      for (const key of [...new Set(keys.filter(Boolean))].sort()) {
        await this.db.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
          `vm2api:sticky:${this.db.schema}`,
          key,
        ])
      }
      return change()
    })
  }

  async current(key) {
    const row = await this.db.prepare('SELECT * FROM sticky_sessions WHERE key = $1 FOR UPDATE').get(key)
    if (!row) return { entry: null, generation: 0 }
    const generation = Number(row.generation)
    if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('invalid sticky generation')
    return { entry: row.deleted_at == null ? rowToEntry(row) : null, generation }
  }

  async nextGeneration(minimum = 0) {
    // Legacy imports/single-process writes can carry explicit generations. Keep
    // the sequence ahead of them before allocating a shared token. This lock
    // covers only the short metadata transaction, never inference execution.
    await this.db.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
      `vm2api:sticky-generation:${this.db.schema}`,
      'allocator',
    ])
    const sequence = await this.db.prepare('SELECT last_value FROM sticky_generation_seq').get()
    if (Number(sequence.last_value) <= minimum) {
      await this.db.prepare("SELECT setval('sticky_generation_seq', $1, true)").get(minimum)
    }
    const row = await this.db.prepare("SELECT nextval('sticky_generation_seq') AS generation").get()
    const generation = Number(row.generation)
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('invalid sticky generation')
    return generation
  }

  /** The callback derives the new entry from the locked PG row, never a cached snapshot. */
  async compareAndSet(key, ifGeneration, change, { now = Date.now(), expire = true } = {}) {
    if (!Number.isSafeInteger(ifGeneration) || ifGeneration < 0) throw new Error('sticky generation is required')
    return this.withKeys([key], async () => {
      let current = await this.current(key)
      if (expire && current.entry?.expires_at != null && current.entry.expires_at < now) {
        const generation = await this.nextGeneration(current.generation)
        await this.db
          .prepare(`UPDATE sticky_sessions SET deleted_at = $3, generation = $2
          WHERE key = $1 AND generation = $4`)
          .run(key, generation, now, current.generation)
        current = await this.current(key)
      }
      if (current.generation !== ifGeneration) return { applied: false, ...current, reason: 'sticky_changed' }
      const next = change(current.entry)
      if (!next) {
        const generation = await this.nextGeneration(current.generation)
        const result =
          current.generation === 0
            ? await this.db
                .prepare(`INSERT INTO sticky_sessions (key, generation, deleted_at) VALUES ($1, $2, $3)
              ON CONFLICT (key) DO NOTHING RETURNING generation`)
                .get(key, generation, now)
            : await this.db
                .prepare(`UPDATE sticky_sessions SET deleted_at = $3, generation = $2
              WHERE key = $1 AND generation = $4 RETURNING generation`)
                .get(key, generation, now, current.generation)
        if (!result) return { applied: false, ...(await this.current(key)), reason: 'sticky_changed' }
        return { applied: true, entry: null, generation }
      }
      const identity = ['account_id', 'vm_id', 'session_id', 'device_id', 'slot_index']
      const changed =
        !current.entry || identity.some((field) => (current.entry[field] ?? null) !== (next[field] ?? null))
      const generation = changed ? await this.nextGeneration(current.generation) : current.generation
      const fields = ['account_id', 'vm_id', 'session_id', 'device_id', 'bound_at', 'expires_at', 'hits', 'slot_index']
      const values = fields.map((field) => next[field] ?? null)
      let row
      if (current.generation === 0) {
        row = await this.db
          .prepare(`INSERT INTO sticky_sessions (key, generation, ${fields.join(', ')})
          VALUES ($1, $2, ${fields.map((_, index) => `$${index + 3}`).join(', ')})
          ON CONFLICT (key) DO NOTHING RETURNING *`)
          .get(key, generation, ...values)
      } else {
        row = await this.db
          .prepare(`UPDATE sticky_sessions SET generation = $2, deleted_at = NULL,
          ${fields.map((field, index) => `${field} = $${index + 3}`).join(', ')}
          WHERE key = $1 AND generation = $11 RETURNING *`)
          .get(key, generation, ...values, current.generation)
      }
      if (!row) return { applied: false, ...(await this.current(key)), reason: 'sticky_changed' }
      return { applied: true, entry: rowToEntry(row), generation }
    })
  }

  /** Bulk invalidation selects authoritative PG keys even when the caller cache is empty. */
  async invalidateShared(where, params = [], now = Date.now()) {
    const keys = (
      await this.db.prepare(`SELECT key FROM sticky_sessions WHERE deleted_at IS NULL AND (${where})`).all(...params)
    ).map((row) => row.key)
    return this.withKeys(keys, async () => {
      const results = []
      for (const key of keys.sort()) {
        const row = await this.db
          .prepare(`SELECT generation FROM sticky_sessions
          WHERE key = $1 AND deleted_at IS NULL AND (${where.replace(/\$(\d+)/g, (_, index) => `$${Number(index) + 1}`)})
          FOR UPDATE`)
          .get(key, ...params)
        if (!row) continue
        const result = await this.compareAndSet(key, Number(row.generation), () => null, { now, expire: false })
        if (result.applied) results.push({ key, ...result })
      }
      return results
    })
  }

  async removeByAccountShared({ accountId = null, vmId = null } = {}) {
    if (!accountId && !vmId) return []
    return this.invalidateShared('account_id = $1 OR vm_id = $2', [accountId || '', vmId || ''])
  }

  async purgeExpiredShared(now = Date.now()) {
    return this.invalidateShared('expires_at < $1', [now], now)
  }

  async dropAliasKeysShared() {
    return this.invalidateShared(`key = 'envelope' OR ascii_fold(key) LIKE 'ch:%' OR ascii_fold(key) LIKE 'dev:%'
      OR ascii_fold(key) LIKE '%:envelope' OR ascii_fold(key) LIKE '%:ch:%' OR ascii_fold(key) LIKE '%:dev:%'`)
  }
}
