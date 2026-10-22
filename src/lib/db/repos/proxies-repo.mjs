/**
 * proxies repository — SOCKS5 pool rows + pool config in settings.
 * Runtime mutations update only the intended rows and columns. replaceAll is
 * retained for the offline legacy importer, never for pool health persistence.
 */

import { getDb, withTransaction } from '../database.mjs'
import { SettingsRepo } from './settings-repo.mjs'

const CONFIG_KEY = 'proxy_pool_config'

const COLUMNS = [
  'id',
  'protocol',
  'host',
  'port',
  'username',
  'password',
  'raw',
  'status',
  'enabled',
  'name',
  'label',
  'owner_user_id',
  'bound_vm_id',
  'consecutive_failures',
  'latency_ms',
  'last_probe_at',
  'last_error',
  'geo_ip',
  'geo_country',
  'geo_country_code',
  'geo_region',
  'geo_city',
  'geo_isp',
  'geo_timezone',
  'geo_checked_at',
  'geo_error',
  'geo_v6_ip',
  'geo_v6_country',
  'geo_v6_country_code',
  'geo_v6_region',
  'geo_v6_city',
  'geo_v6_isp',
  'geo_v6_timezone',
  'geo_v6_checked_at',
  'geo_v6_error',
  'created_at',
  'updated_at',
  'domain_forward',
]

export const PROXY_COLUMNS = COLUMNS
export const PROXY_HEALTH_COLUMNS = COLUMNS.filter(
  (column) =>
    ['status', 'enabled', 'consecutive_failures', 'latency_ms', 'last_probe_at', 'last_error'].includes(column) ||
    column.startsWith('geo_'),
)

function valueFor(proxy, column) {
  if (column === 'enabled') return proxy.enabled === false ? 0 : 1
  if (column === 'domain_forward') return proxy.domain_forward ? 1 : 0
  if (column === 'protocol') return proxy.protocol ?? proxy.scheme ?? 'socks5'
  if (column === 'name')
    return proxy.name ?? (proxy.host && proxy.port != null ? `${proxy.host}:${proxy.port}` : proxy.id)
  return proxy[column] ?? null
}

function rowToProxy(row) {
  if (!row) return null
  // ProxyPool still speaks `scheme`; the column is sub2api's `protocol`.
  return { ...row, scheme: row.protocol, enabled: !!row.enabled, domain_forward: !!row.domain_forward }
}

export class ProxiesRepo {
  constructor(db = getDb()) {
    this.db = db
    this.settings = new SettingsRepo(db)
    this._all = db.prepare('SELECT * FROM proxies ORDER BY created_at, id')
    this._clear = db.prepare('DELETE FROM proxies')
    this._insert = db.prepare(`
      INSERT INTO proxies (${COLUMNS.join(', ')})
      VALUES (${COLUMNS.map((_, i) => '$' + (i + 1)).join(', ')})
    `)
  }

  async loadAll() {
    return (await this._all.all()).map(rowToProxy)
  }

  /** One statement provides a consistent committed config/rows snapshot. */
  async snapshot() {
    const row = await this.db
      .prepare(`SELECT
      (SELECT value FROM settings WHERE key = $1) AS config,
      COALESCE((SELECT json_agg(p ORDER BY created_at, id) FROM proxies p), '[]'::json) AS proxies`)
      .get(CONFIG_KEY)
    let config = {}
    try {
      config = row.config ? JSON.parse(row.config) : {}
    } catch {}
    return { config, proxies: row.proxies.map(rowToProxy) }
  }

  async lockMutations() {
    await this.db.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
      this.db.schema,
      'proxy-pool:mutations',
    ])
  }

  async getById(id, { forUpdate = false } = {}) {
    return rowToProxy(
      await this.db.prepare(`SELECT * FROM proxies WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`).get(id),
    )
  }

  async insert(proxy) {
    await this._insert.run(...COLUMNS.map((column) => valueFor(proxy, column)))
    return this.getById(proxy.id)
  }

  async patchConfig(id, patch) {
    return this._patch(id, patch, { bumpRevision: true })
  }

  async patchHealth(id, patch, expectedRevision) {
    const allowed = Object.fromEntries(
      Object.entries(patch).filter(([column]) => PROXY_HEALTH_COLUMNS.includes(column)),
    )
    return this._patch(id, allowed, { expectedRevision })
  }

  async _patch(id, patch, { bumpRevision = false, expectedRevision } = {}) {
    const columns = Object.keys(patch).filter((column) => column !== 'id' && COLUMNS.includes(column))
    if (!columns.length) return this.getById(id)
    const assignments = columns.map((column, i) => `${column} = $${i + 1}`)
    if (bumpRevision) assignments.push('config_revision = config_revision + 1')
    const params = [...columns.map((column) => valueFor(patch, column)), id]
    let condition = `id = $${params.length}`
    if (expectedRevision !== undefined) {
      params.push(expectedRevision)
      condition += ` AND config_revision = $${params.length}`
    }
    return rowToProxy(
      await this.db
        .prepare(`UPDATE proxies SET ${assignments.join(', ')} WHERE ${condition} RETURNING *`)
        .get(...params),
    )
  }

  async remove(id) {
    return (await this.db.prepare('DELETE FROM proxies WHERE id = $1').run(id)).changes > 0
  }

  async replaceAll(proxies = []) {
    await withTransaction(this.db, async () => {
      await this._clear.run()
      for (const p of proxies) {
        await this._insert.run(
          ...COLUMNS.map((c) => {
            if (c === 'enabled') return p.enabled === false ? 0 : 1
            if (c === 'domain_forward') return p.domain_forward ? 1 : 0
            if (c === 'protocol') return p.protocol ?? p.scheme ?? 'socks5'
            if (c === 'name') return p.name ?? (p.host && p.port != null ? `${p.host}:${p.port}` : p.id)
            return p[c] ?? null
          }),
        )
      }
    })
  }

  async getConfig(fallback = null) {
    return await this.settings.get(CONFIG_KEY, fallback)
  }

  async setConfig(config) {
    return await this.settings.set(CONFIG_KEY, config)
  }

  async patchPoolConfig(patch) {
    const row = await this.db
      .prepare(`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)
      ON CONFLICT (key) DO UPDATE SET
        value = (settings.value::jsonb || excluded.value::jsonb)::text,
        updated_at = excluded.updated_at RETURNING value`)
      .get(CONFIG_KEY, JSON.stringify(patch), new Date().toISOString())
    const config = JSON.parse(row.value)
    this.db.afterCommit(() => this.db.settingsState?.set(CONFIG_KEY, config))
    return config
  }
}
