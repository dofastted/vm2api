/** Explicitly loaded settings for synchronous policy callbacks. Writes remain asynchronous. */
import { getDb } from './database.mjs'
import { SettingsRepo } from './repos/settings-repo.mjs'

export async function loadSettingsState(db = getDb()) {
  await new SettingsRepo(db).all()
  return db.settingsState
}

export class RuntimeSettings {
  constructor(db = getDb()) {
    this.db = db
    this.repo = new SettingsRepo(db)
  }

  /** Refresh the shared snapshot before calling synchronous policy readers. */
  async refresh() {
    await this.repo.all()
    return this.all()
  }

  get(key, fallback = null) {
    if (!this.db.settingsState) throw new Error('settings not loaded; await loadSettingsState() before startup')
    return this.db.settingsState.has(key) ? structuredClone(this.db.settingsState.get(key)) : fallback
  }

  has(key) {
    if (!this.db.settingsState) throw new Error('settings not loaded; await loadSettingsState() before startup')
    return this.db.settingsState.has(key)
  }

  async set(key, value) {
    const next = structuredClone(value)
    return this.repo.set(key, next)
  }

  async remove(key) {
    await this.repo.remove(key)
  }

  all() {
    if (!this.db.settingsState) throw new Error('settings not loaded; await loadSettingsState() before startup')
    return Object.fromEntries([...this.db.settingsState].map(([key, value]) => [key, structuredClone(value)]))
  }
}
