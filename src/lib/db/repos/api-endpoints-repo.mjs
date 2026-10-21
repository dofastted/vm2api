import { getDb, withTransaction } from '../database.mjs'

const EP_COLS = [
  'id',
  'name',
  'disabled',
  'prefix',
  'base_url',
  'headers_json',
  'disable_cooling',
  'priority',
  'kind',
  'protocol',
  'created_at',
  'updated_at',
]
const KEY_COLS = ['id', 'endpoint_id', 'api_key', 'proxy_url', 'proxy_id', 'disabled', 'cooldown_until', 'created_at']
const MODEL_COLS = ['id', 'endpoint_id', 'sort', 'upstream_name', 'alias', 'image', 'thinking_levels_json']

function bool01(v) {
  return v ? 1 : 0
}

function rowEp(row) {
  if (!row) return null
  let headers = {}
  try {
    headers = row.headers_json ? JSON.parse(row.headers_json) : {}
  } catch {
    headers = {}
  }
  return {
    id: row.id,
    name: row.name,
    disabled: !!row.disabled,
    prefix: row.prefix || '',
    base_url: row.base_url,
    headers,
    disable_cooling: !!row.disable_cooling,
    priority: Number(row.priority) || 0,
    kind: row.kind || 'custom',
    protocol: row.protocol || 'anthropic',
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function rowKey(row) {
  if (!row) return null
  return {
    id: row.id,
    endpoint_id: row.endpoint_id,
    api_key: row.api_key,
    proxy_url: row.proxy_url || '',
    proxy_id: row.proxy_id || '',
    disabled: !!row.disabled,
    cooldown_until: row.cooldown_until || null,
    created_at: row.created_at,
  }
}

function rowModel(row) {
  if (!row) return null
  let thinking_levels = null
  try {
    thinking_levels = row.thinking_levels_json ? JSON.parse(row.thinking_levels_json) : null
  } catch {
    thinking_levels = null
  }
  return {
    id: row.id,
    endpoint_id: row.endpoint_id,
    sort: Number(row.sort) || 0,
    name: row.upstream_name,
    alias: row.alias,
    image: !!row.image,
    thinking: thinking_levels ? { levels: thinking_levels } : undefined,
  }
}

export class ApiEndpointsRepo {
  constructor(db = getDb()) {
    this.db = db
    this._listEp = db.prepare('SELECT * FROM api_endpoints ORDER BY priority DESC, created_at, id')
    this._getEp = db.prepare('SELECT * FROM api_endpoints WHERE id = $1')
    this._insEp = db.prepare(
      `INSERT INTO api_endpoints (${EP_COLS.join(',')}) VALUES (${EP_COLS.map((_, i) => '$' + (i + 1)).join(',')})`,
    )
    this._delEp = db.prepare('DELETE FROM api_endpoints WHERE id = $1')
    this._listKeys = db.prepare('SELECT * FROM api_endpoint_keys WHERE endpoint_id = $1 ORDER BY created_at, id')
    this._getKey = db.prepare('SELECT * FROM api_endpoint_keys WHERE id = $1')
    this._insKey = db.prepare(
      `INSERT INTO api_endpoint_keys (${KEY_COLS.join(',')}) VALUES (${KEY_COLS.map((_, i) => '$' + (i + 1)).join(',')})`,
    )
    this._delKey = db.prepare('DELETE FROM api_endpoint_keys WHERE id = $1')
    this._delKeysEp = db.prepare('DELETE FROM api_endpoint_keys WHERE endpoint_id = $1')
    this._listModels = db.prepare('SELECT * FROM api_endpoint_models WHERE endpoint_id = $1 ORDER BY sort, id')
    this._insModel = db.prepare(
      `INSERT INTO api_endpoint_models (${MODEL_COLS.join(',')}) VALUES (${MODEL_COLS.map((_, i) => '$' + (i + 1)).join(',')})`,
    )
    this._delModelsEp = db.prepare('DELETE FROM api_endpoint_models WHERE endpoint_id = $1')
    this._cool = db.prepare('UPDATE api_endpoint_keys SET cooldown_until = $1 WHERE id = $2')
    this._updKey = db.prepare(
      'UPDATE api_endpoint_keys SET api_key = $1, proxy_url = $2, proxy_id = $3, disabled = $4, cooldown_until = $5 WHERE id = $6',
    )
  }

  async listHydrated() {
    return Promise.all((await this._listEp.all()).map((row) => this.hydrate(rowEp(row))))
  }

  async getHydrated(id) {
    return await this.hydrate(rowEp(await this._getEp.get(id)))
  }

  async hydrate(ep) {
    if (!ep) return null
    return {
      ...ep,
      api_key_entries: (await this._listKeys.all(ep.id)).map(rowKey),
      models: (await this._listModels.all(ep.id)).map(rowModel),
    }
  }

  _epValues(rec) {
    return {
      id: rec.id,
      name: rec.name,
      disabled: bool01(rec.disabled),
      prefix: rec.prefix || '',
      base_url: rec.base_url,
      headers_json: JSON.stringify(rec.headers || {}),
      disable_cooling: bool01(rec.disable_cooling),
      priority: Number(rec.priority) || 0,
      kind: rec.kind || 'custom',
      protocol: rec.protocol || 'anthropic',
      created_at: rec.created_at,
      updated_at: rec.updated_at,
    }
  }

  async insertEndpoint(rec) {
    const vals = this._epValues(rec)
    await this._insEp.run(...EP_COLS.map((c) => vals[c] ?? null))
    return await this.getHydrated(rec.id)
  }

  async updateEndpoint(rec) {
    const vals = this._epValues(rec)
    const cols = EP_COLS.filter((c) => c !== 'id')
    await this.db
      .prepare(
        `UPDATE api_endpoints SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${cols.length + 1}`,
      )
      .run(...cols.map((c) => vals[c] ?? null), rec.id)
    return await this.getHydrated(rec.id)
  }

  async removeEndpoint(id) {
    return await withTransaction(this.db, async () => {
      await this._delKeysEp.run(id)
      await this._delModelsEp.run(id)
      return (await this._delEp.run(id)).changes > 0
    })
  }

  async insertKey(rec) {
    await this._insKey.run(
      rec.id,
      rec.endpoint_id,
      rec.api_key,
      rec.proxy_url || '',
      rec.proxy_id || '',
      bool01(rec.disabled),
      rec.cooldown_until || null,
      rec.created_at,
    )
    return rowKey(await this._getKey.get(rec.id))
  }

  async removeKey(id) {
    return (await this._delKey.run(id)).changes > 0
  }

  async updateKey(id, patch = {}) {
    return withTransaction(this.db, async () => {
      await this.db.prepare('SELECT id FROM api_endpoint_keys WHERE id = $1 FOR UPDATE').get(id)

      const rec = rowKey(await this._getKey.get(id))
      if (!rec) return null
      if (patch.api_key != null) {
        const next = String(patch.api_key).trim()
        if (next.length >= 4) rec.api_key = next
      }
      if (patch.proxy_url != null) rec.proxy_url = String(patch.proxy_url).trim()
      if (patch.proxy_id != null) rec.proxy_id = String(patch.proxy_id).trim()
      if (patch.disabled != null) rec.disabled = !!patch.disabled
      if (patch.cooldown_until !== undefined) rec.cooldown_until = patch.cooldown_until || null
      await this._updKey.run(
        rec.api_key,
        rec.proxy_url || '',
        rec.proxy_id || '',
        bool01(rec.disabled),
        rec.cooldown_until,
        rec.id,
      )
    })
  }

  async setKeyCooldown(id, untilIso) {
    await this._cool.run(untilIso, id)
  }

  async replaceModels(endpointId, models = []) {
    return withTransaction(this.db, async () => {
      await this.db.prepare('SELECT id FROM api_endpoints WHERE id = $1 FOR UPDATE').get(endpointId)

      await withTransaction(this.db, async () => {
        await this._delModelsEp.run(endpointId)
        await Promise.all(
          models.map(async (m, i) => {
            const levels = Array.isArray(m.thinking?.levels)
              ? m.thinking.levels
              : Array.isArray(m.thinking_levels)
                ? m.thinking_levels
                : null
            await this._insModel.run(
              m.id,
              endpointId,
              Number(m.sort ?? i),
              m.name || m.upstream_name,
              m.alias || m.name,
              bool01(m.image),
              levels ? JSON.stringify(levels) : null,
            )
          }),
        )
      })
      return await this.getHydrated(endpointId)
    })
  }
}
