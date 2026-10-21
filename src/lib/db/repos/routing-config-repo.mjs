import { getDb, withTransaction } from '../database.mjs'

const KEY = 'routing_config'

function stale() {
  return Object.assign(new Error('routing configuration revision changed'), {
    code: 'routing_config_stale',
    status: 409,
  })
}

function decode(row) {
  if (!row) return null
  const value = JSON.parse(row.value)
  if (
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !value.config ||
    typeof value.config !== 'object'
  ) {
    throw new Error('invalid shared routing configuration')
  }
  return value
}

export class RoutingConfigRepo {
  constructor(db = getDb()) {
    this.db = db
  }

  async get() {
    return decode(await this.db.prepare('SELECT value FROM settings WHERE key = $1').get(KEY))
  }

  async seed(load) {
    const present = await this.get()
    if (present) return present
    const config = load()
    return withTransaction(this.db, async () => {
      await this.db.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [this.db.schema, KEY])
      const existing = await this.get()
      if (existing) return existing
      const value = { revision: 1, config }
      await this.db
        .prepare('INSERT INTO settings (key, value, updated_at) VALUES ($1,$2,$3)')
        .run(KEY, JSON.stringify(value), new Date().toISOString())
      return value
    })
  }

  async patch(change, { ifRevision } = {}) {
    return withTransaction(this.db, async () => {
      const current = decode(await this.db.prepare('SELECT value FROM settings WHERE key = $1 FOR UPDATE').get(KEY))
      if (!current || (ifRevision != null && ifRevision !== current.revision)) throw stale()
      const revision = current.revision + 1
      if (!Number.isSafeInteger(revision)) throw new Error('routing revision overflow')
      const next = { revision, config: change(structuredClone(current.config)) }
      await this.db
        .prepare('UPDATE settings SET value = $2, updated_at = $3 WHERE key = $1')
        .run(KEY, JSON.stringify(next), new Date().toISOString())
      return next
    })
  }

  /** Call inside admission's transaction, before resource locks. */
  async assertRevision(revision) {
    return withTransaction(this.db, async () => {
      const current = decode(await this.db.prepare('SELECT value FROM settings WHERE key = $1 FOR SHARE').get(KEY))
      if (!current || current.revision !== revision) throw stale()
      return true
    })
  }
}
