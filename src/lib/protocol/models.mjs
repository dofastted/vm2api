/**
 * Gateway model catalog.
 * Claude: console model-policy. GPT: gpt_model_policy from Codex /codex/models.
 * GET /v1/models returns both. Never hop a slot worker `/internal/v1/models`.
 */

import {
  isModelEnabled,
  filterPublicModelIds,
  getModelEntry,
  getModelPolicy,
  getPolicyCatalogIds,
  loadModelPolicy,
  seedDefaultPolicy,
} from './model-policy.mjs'
import { hasClaudeCode1mSuffix, stripClaudeCode1mSuffix } from './context-1m.mjs'
import { isGptSeriesId } from './gpt-ids.mjs'
import { listGptPolicyModels } from './gpt-model-policy.mjs'

const FAMILY_ALIASES = new Map([
  ['sonnet', 'sonnet'],
  ['opus', 'opus'],
  ['haiku', 'haiku'],
  ['fable', 'fable'],
])

/** @type {{ at: number, ids: string[], aliases: string[], source: string|null }} */
let cache = { at: 0, ids: [], aliases: [], source: null }

function catalogIsTestPinned() {
  return cache.source === 'go-slot-worker' && (cache.ids || []).length > 0
}

export function seedModelCatalog() {
  if (catalogIsTestPinned()) return cache
  let ids = [...SEED_MODEL_IDS]
  try {
    loadModelPolicy()
    const fromPolicy = getPolicyCatalogIds()
    if (fromPolicy.length) ids = fromPolicy
  } catch {}
  return setModelCatalog(ids, { source: 'model-policy' })
}

function listGptPublicModels() {
  try {
    return listGptPolicyModels().map((m) => ({
      id: m.id,
      object: 'model',
      type: 'model',
      display_name: m.display_name || m.label || m.id,
      owned_by: 'openai',
      family: 'codex',
      enabled: m.enabled !== false,
      source: 'gpt-model-policy',
    }))
  } catch {
    return []
  }
}

/** Local catalog for GET /v1/models and boot. Does not touch workers. */
export function gatewayModelCatalog() {
  seedModelCatalog()
  try {
    loadModelPolicy()
  } catch {}
  const gpt = listGptPublicModels()
  const claude = listOfficialModels()
  return {
    object: 'list',
    data: [...gpt, ...claude],
    source: cache.source || 'model-policy',
  }
}

export function isCatalogModelId(id) {
  const s = String(id || '')
  if (s.endsWith('-') || s.endsWith('.')) return false
  if (/\.md$/i.test(s)) return false
  if (/^(gpt-[a-z0-9.-]+|codex-[a-z0-9.-]+)$/i.test(s)) return s.split(/[-.]/).length >= 2
  if (!/^claude-(opus|sonnet|haiku|fable|3)[a-z0-9.-]*$/i.test(s)) return false
  return s.split('-').length >= 3
}

export function isCodexCatalogModel(id) {
  return isGptSeriesId(id)
}

/** Default seed = every id on the console models page (seedDefaultPolicy). */
export const SEED_MODEL_IDS = Object.freeze(
  Object.keys(seedDefaultPolicy().models || {}).filter((id) => isCatalogModelId(id)),
)

function modelRank(id) {
  const body = String(id).replace(/^claude-(opus|sonnet|haiku|fable|3)-/i, '')
  return body.split(/[-.]/).map((p) => {
    if (/^\d{8}$/.test(p)) return Number(p)
    if (/^\d+$/.test(p)) return Number(p)
    return -1
  })
}

function cmpRank(a, b) {
  const ra = modelRank(a)
  const rb = modelRank(b)
  const n = Math.max(ra.length, rb.length)
  for (let i = 0; i < n; i++) {
    const da = ra[i] ?? -1
    const db = rb[i] ?? -1
    if (db !== da) return db - da
  }
  return a.length - b.length
}

export function latestIdForFamily(family, ids) {
  const fam = String(family || '').toLowerCase()
  const preferred = (ids || []).filter((id) => {
    if (!id.toLowerCase().startsWith(`claude-${fam}-`)) return false
    if (/-fast$/i.test(id) || /-latest$/i.test(id) || /-v\d+$/i.test(id)) return false
    return true
  })
  preferred.sort(cmpRank)
  return preferred[0] || null
}

/** Anthropic calling alias: claude-haiku-4-5 → claude-haiku-4-5-20251001 */
export function undatedAliasOf(id) {
  return String(id || '').replace(/-\d{8}$/, '')
}

export function latestIdForUndatedAlias(raw, ids) {
  const lower = String(raw || '').toLowerCase()
  if (!lower) return null
  const hits = (ids || []).filter((id) => undatedAliasOf(id).toLowerCase() === lower)
  hits.sort(cmpRank)
  return hits[0] || null
}

function resolvePolicyAliasToCatalog(raw, ids) {
  try {
    loadModelPolicy()
    const policy = getModelPolicy()
    const lower = String(raw || '').toLowerCase()
    const candidates = []
    const top = policy.aliases?.[lower]
    if (top) candidates.push(String(top))
    for (const [id, cfg] of Object.entries(policy.models || {})) {
      if (id.toLowerCase() === lower) candidates.push(id)
      if ((cfg.aliases || []).some((a) => String(a).toLowerCase() === lower)) candidates.push(id)
    }
    for (const c of candidates) {
      const exact = (ids || []).find((x) => x.toLowerCase() === String(c).toLowerCase())
      if (exact) return exact
      const dated = latestIdForUndatedAlias(c, ids)
      if (dated) return dated
    }
  } catch {}
  return null
}

export function resolveCatalogModel(raw, ids = cache.ids) {
  const m = String(raw || '').trim()
  if (!m) return { ok: false, reason: 'empty' }
  const popped = m.split('/').filter(Boolean).pop() || m
  const want1m = hasClaudeCode1mSuffix(popped)
  const bare = stripClaudeCode1mSuffix(popped)
  const lower = bare.toLowerCase()
  if (FAMILY_ALIASES.has(lower)) {
    const fam = FAMILY_ALIASES.get(lower)
    const latest = latestIdForFamily(fam, ids)
    if (latest) return { ok: true, model: latest, alias: fam, want1m }
  }
  const id = /^claude-/i.test(bare) ? bare : stripClaudeCode1mSuffix(m)
  if (ids.length && ids.some((x) => x.toLowerCase() === id.toLowerCase())) {
    return { ok: true, model: id, want1m }
  }
  const dated = latestIdForUndatedAlias(id, ids)
  if (dated) return { ok: true, model: dated, alias: id, want1m }
  const viaPolicy = resolvePolicyAliasToCatalog(id, ids)
  if (viaPolicy) return { ok: true, model: viaPolicy, alias: id, want1m }
  // Fail closed: empty catalog or unknown id → reject. Never passthrough unverified claude-*.
  return { ok: false, model: id, want1m, reason: ids.length ? 'not_in_catalog' : 'catalog_unavailable' }
}

/**
 * Replace the cached catalog. Production feed: Go slot worker models responses.
 * Tests inject a catalog with the same call.
 */
export function setModelCatalog(ids, { source = 'go-slot-worker' } = {}) {
  cache = {
    at: Date.now(),
    ids: [
      ...new Set(
        (ids || [])
          .map((id) => (id === 'claude-fable-5.1' ? 'claude-fable-5-1' : id))
          .filter((id) => isCatalogModelId(id)),
      ),
    ],
    aliases: [...FAMILY_ALIASES.keys()],
    source,
  }
  return cache
}

/** Merge worker model list objects ({ data: [{id}] }) into the catalog. */
export function ingestWorkerModels(list) {
  const ids = (Array.isArray(list?.data) ? list.data : [])
    .map((m) => (typeof m === 'string' ? m : m?.id))
    .filter(Boolean)
  if (!ids.length) return cache
  return setModelCatalog([...new Set([...cache.ids, ...ids])], { source: 'go-slot-worker' })
}

export function getCatalogIds() {
  return [...(cache.ids || [])]
}

export function clearModelsCache() {
  cache = { at: 0, ids: [], aliases: [], source: null }
}

export function listOfficialModels() {
  try {
    loadModelPolicy()
  } catch {}
  const ids = filterPublicModelIds(cache.ids || [])
  return ids.map((id) => {
    let display = id
    let extra = {}
    try {
      const e = getModelEntry(id)
      display = e.display_name || id
      extra = {
        family: e.family,
        enabled: e.enabled !== false,
        capabilities: e.capabilities,
      }
    } catch {}
    return {
      id,
      object: 'model',
      type: 'model',
      display_name: display,
      owned_by: extra.family === 'codex' ? 'openai' : 'anthropic',
      source: cache.source || 'model-policy',
      ...extra,
    }
  })
}

/**
 * Only names the worker catalog knows.
 * Provider prefixes (anthropic/…, openrouter/anthropic/…) are stripped first.
 * Family aliases (sonnet/opus/haiku/fable) resolve to the latest catalog id.
 */
export function validateOfficialModel(model) {
  const m = String(model || '').trim()
  if (!m) {
    return {
      ok: false,
      error: {
        message: 'model is required. Use a model from the gateway model catalog.',
        type: 'invalid_request_error',
        code: 'model_required',
      },
    }
  }

  const bare = stripClaudeCode1mSuffix(m.split('/').filter(Boolean).pop() || m)
  const id = bare

  if (
    /^(gemini|deepseek|mistral|grok|text-|davinci)/i.test(id) ||
    (/^(gpt-|o1|o3|o4)/i.test(id) && !isCodexCatalogModel(id))
  ) {
    return {
      ok: false,
      error: {
        message: `model '${m}' is not supported. Only official Claude and Codex models are accepted.`,
        type: 'invalid_request_error',
        code: 'model_not_supported',
        param: 'model',
      },
    }
  }

  if (!catalogIsTestPinned()) seedModelCatalog()
  const resolved = resolveCatalogModel(m, cache.ids)
  if (resolved.ok) {
    try {
      if (!isModelEnabled(resolved.model)) {
        return {
          ok: false,
          error: {
            message: `model '${m}' is disabled by gateway model policy.`,
            type: 'invalid_request_error',
            code: 'model_disabled',
            param: 'model',
          },
        }
      }
    } catch {}
    return { ok: true, model: resolved.model, alias: resolved.alias || null, want1m: !!resolved.want1m }
  }
  if (!cache.ids.length && isCatalogModelId(id)) {
    return { ok: true, model: id, alias: null, want1m: hasClaudeCode1mSuffix(m), source: 'worker_catalog_pending' }
  }

  return {
    ok: false,
    error: {
      message: `model '${m}' is not recognized by the gateway model catalog. Request rejected; no hop.`,
      type: 'invalid_request_error',
      code: 'model_not_supported',
      param: 'model',
    },
  }
}
