import crypto from 'node:crypto'
import { resolveStoreDb, withTransaction } from '../db/database.mjs'
import { ApiEndpointsRepo } from '../db/repos/api-endpoints-repo.mjs'
import {
  mergeModelLists,
  modelsUrl,
  parseUpstreamModels,
  resolvePreset,
  trimBaseUrl,
  upstreamAuthHeaders,
} from '../pool/api-presets.mjs'
import { forwardApi, readApiJson } from '../transport/api-kernel-client.mjs'
import { AUTH_SCHEME_X_API_KEY, resolveAuthScheme } from '../oauth/auth-scheme.mjs'

function nowIso() {
  return new Date().toISOString()
}

function nid(prefix) {
  return prefix + crypto.randomBytes(6).toString('hex')
}

function trimUrl(url) {
  return trimBaseUrl(url)
}

function maskUpstreamKey(key) {
  const s = String(key || '')
  if (s.length <= 8) return s.slice(0, 2) + '…'
  return s.slice(0, 4) + '…' + s.slice(-4)
}

function endpointAuthScheme(ep = {}, fallbackProtocol = '') {
  const protocol = resolvePreset(ep.kind, ep).protocol || fallbackProtocol
  if (protocol === 'openai') return 'authorization_bearer'
  return (
    resolveAuthScheme({
      mode: 'apikey',
      auth_scheme: ep.auth_scheme || ep.headers?.auth_scheme || ep.headers?.anthropic_apikey_auth_scheme,
    }) || AUTH_SCHEME_X_API_KEY
  )
}

function stripAuthSchemeHeader(headers = {}) {
  const next = { ...(headers || {}) }
  delete next.auth_scheme
  delete next.authScheme
  delete next.anthropic_apikey_auth_scheme
  return next
}

function headersWithAuthScheme(headers = {}, scheme) {
  const next = stripAuthSchemeHeader(headers)
  if (scheme) next.auth_scheme = scheme
  return next
}

export function publicEndpointView(ep, { reveal = false } = {}) {
  if (!ep) return null
  return {
    id: ep.id,
    name: ep.name,
    disabled: !!ep.disabled,
    prefix: ep.prefix || '',
    kind: resolvePreset(ep.kind, ep).kind,
    protocol: resolvePreset(ep.kind, ep).protocol,
    base_url: resolvePreset(ep.kind, ep).base_url || ep.base_url,
    headers: stripAuthSchemeHeader(ep.headers),
    auth_scheme: endpointAuthScheme(ep),
    disable_cooling: !!ep.disable_cooling,
    priority: Number(ep.priority) || 0,
    created_at: ep.created_at,
    updated_at: ep.updated_at,
    api_key_entries: (ep.api_key_entries || []).map((k) => ({
      id: k.id,
      proxy_url: k.proxy_url || '',
      proxy_id: k.proxy_id || '',
      disabled: !!k.disabled,
      cooldown_until: k.cooldown_until || null,
      api_key: reveal ? k.api_key : maskUpstreamKey(k.api_key),
      key_suffix: String(k.api_key || '').slice(-4),
    })),
    models: (ep.models || []).map((m) => ({
      id: m.id,
      name: m.name,
      alias: m.alias,
      image: !!m.image,
      thinking: m.thinking,
    })),
  }
}

export class ApiEndpointStore {
  constructor({ dataDir, db } = {}) {
    this.db = resolveStoreDb({ db, dataDir })
    this.repo = new ApiEndpointsRepo(this.db)
  }

  rebind(db) {
    this.db = db
    this.repo = new ApiEndpointsRepo(db)
  }

  async list({ reveal = false } = {}) {
    return (await this.repo.listHydrated()).map((ep) => publicEndpointView(ep, { reveal }))
  }

  async listRaw() {
    return await this.repo.listHydrated()
  }

  async getRaw(id) {
    return await this.repo.getHydrated(id)
  }

  async create(input = {}) {
    return withTransaction(this.db, async () => {
      const preset = resolvePreset(input.kind, input)
      const base_url = preset.base_url
      if (!/^https?:\/\//i.test(base_url)) {
        throw Object.assign(new Error('base_url must be http(s)'), { code: 'invalid_base_url' })
      }
      const rec = {
        id: nid('ep_'),
        name:
          String(preset.name || 'api')
            .trim()
            .slice(0, 80) || 'api',
        disabled: !!input.disabled,
        prefix: String(input.prefix || '').trim(),
        base_url,
        kind: preset.kind,
        protocol: preset.protocol,
        headers: headersWithAuthScheme(
          input.headers && typeof input.headers === 'object' ? input.headers : {},
          input.auth_scheme || input.authScheme,
        ),
        disable_cooling: !!input.disable_cooling,
        priority: Number(input.priority) || 0,
        created_at: nowIso(),
        updated_at: nowIso(),
      }
      const stored = await this.repo.insertEndpoint(rec)
      const models = Array.isArray(input.models) ? input.models : []
      if (models.length) await this.replaceModels(stored.id, models)
      const keys = Array.isArray(input.api_key_entries) ? input.api_key_entries : []
      for (const k of keys) await this.addKey(stored.id, k)
      return await this.repo.getHydrated(stored.id)
    })
  }

  async update(id, patch = {}) {
    return withTransaction(this.db, async () => {
      await this.db.prepare('SELECT id FROM api_endpoints WHERE id = $1 FOR UPDATE').get(id)

      const rec = await this.repo.getHydrated(id)
      if (!rec) return null
      if (patch.name != null) rec.name = String(patch.name).trim().slice(0, 80) || rec.name
      if (patch.disabled != null) rec.disabled = !!patch.disabled
      if (patch.prefix != null) rec.prefix = String(patch.prefix).trim()
      if (patch.kind != null || patch.protocol != null || patch.base_url != null) {
        const preset = resolvePreset(patch.kind ?? rec.kind, {
          ...rec,
          ...patch,
          base_url: patch.base_url != null ? patch.base_url : rec.base_url,
        })
        rec.kind = preset.kind
        rec.protocol = preset.protocol
        rec.base_url = preset.base_url
        if (!/^https?:\/\//i.test(rec.base_url)) {
          throw Object.assign(new Error('base_url must be http(s)'), { code: 'invalid_base_url' })
        }
      }
      if (patch.headers != null && typeof patch.headers === 'object') rec.headers = patch.headers
      if (patch.auth_scheme != null || patch.authScheme != null) {
        rec.headers = headersWithAuthScheme(rec.headers, patch.auth_scheme || patch.authScheme)
      }
      if (patch.disable_cooling != null) rec.disable_cooling = !!patch.disable_cooling
      if (patch.priority != null) rec.priority = Number(patch.priority) || 0
      rec.updated_at = nowIso()
      await this.repo.updateEndpoint(rec)
      if (Array.isArray(patch.models)) await this.replaceModels(id, patch.models)
      return await this.repo.getHydrated(id)
    })
  }

  async remove(id) {
    return await this.repo.removeEndpoint(id)
  }

  async addKey(endpointId, input = {}) {
    const ep = await this.repo.getHydrated(endpointId)
    if (!ep) throw Object.assign(new Error('endpoint not found'), { code: 'endpoint_not_found' })
    const api_key = String(input.api_key || '').trim()
    if (api_key.length < 4) throw Object.assign(new Error('api_key too short'), { code: 'key_too_short' })
    return await this.repo.insertKey({
      id: nid('ek_'),
      endpoint_id: endpointId,
      api_key,
      proxy_url: String(input.proxy_url || '').trim(),
      proxy_id: String(input.proxy_id || '').trim(),
      disabled: !!input.disabled,
      cooldown_until: null,
      created_at: nowIso(),
    })
  }

  async removeKey(id) {
    return await this.repo.removeKey(id)
  }

  async updateKey(id, patch = {}) {
    return await this.repo.updateKey(id, patch)
  }

  async replaceModels(endpointId, models = []) {
    const rows = models
      .map((m, i) => ({
        id: m.id || nid('em_'),
        sort: i,
        name: String(m.name || m.upstream_name || '').trim(),
        alias: String(m.alias || m.name || '').trim(),
        image: !!m.image,
        thinking: m.thinking,
      }))
      .filter((m) => m.name && m.alias)
    return await this.repo.replaceModels(endpointId, rows)
  }

  async setKeyCooldown(id, untilIso) {
    await this.repo.setKeyCooldown(id, untilIso)
  }

  async mergeFetchedModels(endpointId, fetched = []) {
    const ep = await this.repo.getHydrated(endpointId)
    if (!ep) return null
    return await this.replaceModels(endpointId, mergeModelLists(ep.models, fetched))
  }
}

export { API_ENDPOINT_PRESETS, normalizeKind } from '../pool/api-presets.mjs'

export async function fetchUpstreamModels({
  cfg,
  kind,
  protocol,
  base_url,
  api_key,
  proxy_url = '',
  headers = {},
  auth_scheme,
  forward = forwardApi,
} = {}) {
  const preset = resolvePreset(kind, { protocol, base_url })
  const key = String(api_key || '').trim()
  if (key.length < 4) {
    throw Object.assign(new Error('需要上游 key 才能获取模型'), { code: 'key_required' })
  }
  if (!/^https?:\/\//i.test(preset.base_url)) {
    throw Object.assign(new Error('base_url must be http(s)'), { code: 'invalid_base_url' })
  }

  const models = []
  let afterId = ''
  for (let page = 0; page < 8; page++) {
    const upstream = await forward({
      cfg,
      method: 'GET',
      url: modelsUrl(preset.base_url, { afterId }),
      headers: {
        accept: 'application/json',
        ...upstreamAuthHeaders(preset.protocol, key, {
          ...headers,
          auth_scheme: auth_scheme || headers.auth_scheme || headers.anthropic_apikey_auth_scheme,
        }),
      },
      body: '',
      proxyUrl: proxy_url,
      timeoutMs: 30_000,
    })
    const status = Number(upstream.statusCode) || 502
    const payload = await readApiJson(upstream)
    if (status >= 400) {
      const message = payload?.error?.message || payload?.message || `upstream ${status}`
      throw Object.assign(new Error(String(message).slice(0, 300)), {
        code: 'fetch_models_failed',
        status,
      })
    }
    models.push(...parseUpstreamModels(payload, preset.protocol))
    if (!payload?.has_more || !payload?.last_id) break
    afterId = payload.last_id
  }
  return { kind: preset.kind, protocol: preset.protocol, base_url: preset.base_url, models }
}
