/**
 * proxies repository — SOCKS5 pool rows + pool config in settings.
 * The ProxyPool keeps its working set in memory (probe loop mutates it);
 * this repo is the persistence surface: loadAll / replaceAll.
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
  'created_at',
  'updated_at',
]

function rowToProxy(row) {
  if (!row) return null
  // ProxyPool still speaks `scheme`; the column is sub2api's `protocol`.
  return { ...row, scheme: row.protocol, enabled: !!row.enabled }
}

export class ProxiesRepo {
  constructor(db = getDb()) {
    this.db = db
    this.settings = new SettingsRepo(db)
    this._all = db.prepare('SELECT * FROM proxies ORDER BY created_at, id')
    this._clear = db.prepare('DELETE FROM proxies')
    this._insert = db.prepare(`
      INSERT INTO proxies (${COLUMNS.join(', ')})
      VALUES (${COLUMNS.map(() => '?').join(', ')})
    `)
  }

  loadAll() {
    return this._all.all().map(rowToProxy)
  }

  replaceAll(proxies = []) {
    withTransaction(this.db, () => {
      this._clear.run()
      for (const p of proxies) {
        this._insert.run(
          ...COLUMNS.map((c) => {
            if (c === 'enabled') return p.enabled === false ? 0 : 1
            if (c === 'protocol') return p.protocol ?? p.scheme ?? 'socks5'
            if (c === 'name') return p.name ?? (p.host && p.port != null ? `${p.host}:${p.port}` : p.id)
            return p[c] ?? null
          }),
        )
      }
    })
  }

  getConfig(fallback = null) {
    return this.settings.get(CONFIG_KEY, fallback)
  }

  setConfig(config) {
    return this.settings.set(CONFIG_KEY, config)
  }
}
