/**
 * settings repository — key → JSON value store.
 * Used for: legacy_import_done, backup_schedule, proxy_pool_config, active_vm …
 */

import { getDb } from '../database.mjs'

export class SettingsRepo {
  constructor(db = getDb()) {
    this.db = db
    this._get = db.prepare('SELECT value FROM settings WHERE key = $1')
    this._set = db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `)
    this._del = db.prepare('DELETE FROM settings WHERE key = $1')
    this._all = db.prepare('SELECT key, value, updated_at FROM settings ORDER BY key')
  }

  async get(key, fallback = null) {
    const row = await this._get.get(key)
    if (!row) return fallback
    try {
      return JSON.parse(row.value)
    } catch {
      return fallback
    }
  }

  async set(key, value) {
    await this._set.run(key, JSON.stringify(value), new Date().toISOString())
    this.db.afterCommit(() => this.db.settingsState?.set(key, value))
    return value
  }

  async has(key) {
    return !!(await this._get.get(key))
  }

  async remove(key) {
    await this._del.run(key)
    this.db.afterCommit(() => this.db.settingsState?.delete(key))
  }

  async all() {
    const out = {}
    for (const row of await this._all.all()) {
      try {
        out[row.key] = JSON.parse(row.value)
      } catch {
        out[row.key] = null
      }
    }
    this.db.afterCommit(() => {
      this.db.settingsState = new Map(Object.entries(out))
    })
    return out
  }
}
