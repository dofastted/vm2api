import { CLAUDE_OFFICIAL_URL, OPENAI_OFFICIAL_URL, normalizeProtocol, trimBaseUrl } from './api-presets.mjs'
import {
  isCatalogModelId,
  isCodexCatalogModel,
  listGptPublicModels,
  listOfficialModels,
  resolveCatalogModel,
} from '../protocol/models.mjs'
import { isGptSeriesId } from '../protocol/gpt-ids.mjs'

/**
 * CLIProxy-shaped picker: grouped round-robin by endpoint then key.
 * Same alias across endpoints shares a model id; prefix/alias pins an endpoint.
 */

function norm(s) {
  return String(s || '').trim()
}

function lower(s) {
  return norm(s).toLowerCase()
}

function isOfficialClaude(ep) {
  if (!ep) return false
  if (ep.kind === 'claude') return true
  const u = trimBaseUrl(ep.base_url)
  return u === CLAUDE_OFFICIAL_URL
}

function isOfficialOpenAI(ep) {
  if (!ep) return false
  if (ep.kind === 'openai') return true
  const u = trimBaseUrl(ep.base_url)
  return u === OPENAI_OFFICIAL_URL
}

export function stripPrefix(model, prefix) {
  const p = norm(prefix)
  if (!p) return norm(model)
  const needle = p + '/'
  const raw = norm(model)
  if (raw.toLowerCase().startsWith(needle.toLowerCase())) return raw.slice(needle.length)
  return raw
}

export function modelIdsForEndpoint(ep, { forcePrefix = false } = {}) {
  const prefix = norm(ep.prefix)
  const ids = []
  const seen = new Set()
  const add = (alias) => {
    const a = norm(alias)
    if (!a) return
    if (!forcePrefix || !prefix) {
      if (!seen.has(lower(a))) {
        seen.add(lower(a))
        ids.push(a)
      }
    }
    if (prefix) {
      const pref = `${prefix}/${a}`
      if (!seen.has(lower(pref))) {
        seen.add(lower(pref))
        ids.push(pref)
      }
    }
  }
  for (const m of ep?.models || []) {
    add(m.alias || m.name)
  }
  if (isOfficialClaude(ep)) {
    try {
      for (const m of listOfficialModels()) {
        add(m.id)
      }
    } catch {}
  } else if (isOfficialOpenAI(ep)) {
    try {
      for (const m of listGptPublicModels()) {
        add(m.id)
      }
    } catch {}
  }
  return ids
}

export function resolveUpstreamPool(ep, requestedModel) {
  const want = lower(stripPrefix(requestedModel, ep?.prefix))
  if (!want) return []
  const out = []
  const seen = new Set()
  for (const m of ep?.models || []) {
    if (lower(m.alias) !== want) continue
    const name = norm(m.name) || norm(m.alias)
    const key = lower(name)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  if (out.length > 0) return out
  if (isOfficialClaude(ep)) {
    const raw = stripPrefix(requestedModel, ep?.prefix)
    const resolved = resolveCatalogModel(raw)
    if (resolved?.ok && resolved.model) return [resolved.model]
    if (isCatalogModelId(raw)) return [raw]
  } else if (isOfficialOpenAI(ep)) {
    const raw = stripPrefix(requestedModel, ep?.prefix)
    if (isGptSeriesId(raw) || isCodexCatalogModel(raw)) return [raw]
  }
  return []
}

export function endpointMatchesModel(ep, requestedModel) {
  if (!ep || ep.disabled) return false
  const raw = norm(requestedModel)
  const prefix = norm(ep.prefix)
  if (prefix && raw.toLowerCase().startsWith((prefix + '/').toLowerCase())) {
    return resolveUpstreamPool(ep, raw).length > 0
  }
  return resolveUpstreamPool(ep, raw).length > 0
}

function keyReady(key, now, disableCooling) {
  if (!key || key.disabled) return false
  if (disableCooling) return true
  if (!key.cooldown_until) return true
  return Date.parse(key.cooldown_until) <= now
}

export class ApiScheduler {
  constructor() {
    this.endpoints = []
    this.parentCursor = 0
    this.childCursor = new Map()
    this.modelCursor = new Map()
    this.forcePrefix = false
  }

  reload(endpoints = []) {
    this.endpoints = Array.isArray(endpoints) ? endpoints : []
  }

  catalog({ groupType = 'all' } = {}) {
    const data = []
    const seen = new Set()
    const targetGroup = String(groupType || 'all').toLowerCase()
    for (const ep of this.endpoints) {
      if (ep.disabled) continue
      const proto = normalizeProtocol(ep.protocol, ep.kind)
      if (targetGroup === 'anthropic' && proto !== 'anthropic') continue
      if (targetGroup === 'openai' && proto !== 'openai') continue
      for (const id of modelIdsForEndpoint(ep, { forcePrefix: this.forcePrefix })) {
        const k = lower(id)
        if (seen.has(k)) continue
        seen.add(k)
        data.push({
          id,
          object: 'model',
          type: 'model',
          display_name: id,
          owned_by: ep.name || 'api',
        })
      }
    }
    return { object: 'list', data, source: 'api-endpoints' }
  }

  pick(requestedModel, now = Date.now(), { groupType = 'all' } = {}) {
    const targetGroup = String(groupType || 'all').toLowerCase()
    const parents = this.endpoints
      .filter((ep) => {
        if (ep.disabled) return false
        const proto = normalizeProtocol(ep.protocol, ep.kind)
        if (targetGroup === 'anthropic' && proto !== 'anthropic') return false
        if (targetGroup === 'openai' && proto !== 'openai') return false
        return endpointMatchesModel(ep, requestedModel)
      })
      .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0))
    if (!parents.length) {
      return { ok: false, code: 'model_not_found', message: `no api endpoint serves ${requestedModel}` }
    }
    const start = this.parentCursor % parents.length
    for (let off = 0; off < parents.length; off++) {
      const ep = parents[(start + off) % parents.length]
      const keys = (ep.api_key_entries || []).filter((k) => keyReady(k, now, ep.disable_cooling))
      if (!keys.length) continue
      const c = this.childCursor.get(ep.id) || 0
      const key = keys[c % keys.length]
      this.childCursor.set(ep.id, c + 1)
      this.parentCursor = start + off + 1
      const pool = resolveUpstreamPool(ep, requestedModel)
      const mk = `${ep.id}:${lower(requestedModel)}`
      const mi = this.modelCursor.get(mk) || 0
      const upstreamModel = pool[mi % pool.length] || requestedModel
      this.modelCursor.set(mk, mi + 1)
      return {
        ok: true,
        endpoint: ep,
        key,
        upstream_model: upstreamModel,
        requested_model: requestedModel,
      }
    }
    return { ok: false, code: 'api_pool_exhausted', message: 'no ready api key for this model' }
  }
}
