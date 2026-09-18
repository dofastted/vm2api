/**
 * Model capability matrix + availability control.
 * Persisted in settings key "model_policy"; hot-reloaded on PUT.
 *
 * catalog_mode:
 *   policy_only             — console #/models (model-policy) is the catalog (default)
 *   worker_intersect_policy — cache ids ∩ enabled policy entries
 *   worker_only             — ignore policy enabled flags for listing
 */

import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import {
  CONTEXT_1M_BETA,
  DEFAULT_CONTEXT_1M_WHITELIST,
  ensureContext1mBeta,
  normalizeContext1mWhitelist,
  shouldPassContext1m,
  stripClaudeCode1mSuffix,
} from './context-1m.mjs'
import {
  defaultOfficialBetaHeader,
  ensureOauthBeta,
  fullClaudeCodeMimicryBetas,
  HAIKU_BETA_HEADER,
  joinBetas,
} from './claude-code-betas.mjs'

function isCatalogModelId(id) {
  const s = String(id || '')
  if (s.endsWith('-') || s.endsWith('.')) return false
  if (/\.md$/i.test(s)) return false
  if (/^(gpt-[a-z0-9.-]+|codex-[a-z0-9.-]+)$/i.test(s)) return s.split(/[-.]/).length >= 2
  if (!/^claude-(opus|sonnet|haiku|fable|3)[a-z0-9.-]*$/i.test(s)) return false
  return s.split('-').length >= 3
}

const SETTINGS_KEY = 'model_policy'
const CONTEXT_1M = CONTEXT_1M_BETA

const CAP_HAIKU = {
  context_window: 200000,
  supports_1m: false,
  thinking_mode: 'enabled_only',
  supports_adaptive: false,
  requires_adaptive: false,
  supports_interleaved: false,
  supports_effort: false,
  supports_context_management: false,
}

const CAP_SONNET45 = {
  context_window: 200000,
  supports_1m: false,
  thinking_mode: 'enabled_only',
  supports_adaptive: false,
  requires_adaptive: false,
  supports_interleaved: true,
  supports_effort: false,
  supports_context_management: true,
}

const CAP_46 = {
  context_window: 1000000,
  supports_1m: true,
  thinking_mode: 'adaptive_or_enabled',
  supports_adaptive: true,
  requires_adaptive: false,
  supports_interleaved: true,
  supports_effort: true,
  supports_context_management: true,
}

const CAP_ADAPTIVE_ONLY = {
  context_window: 1000000,
  supports_1m: true,
  thinking_mode: 'adaptive_only',
  supports_adaptive: true,
  requires_adaptive: true,
  supports_interleaved: true,
  supports_effort: true,
  supports_context_management: true,
}

const CAP_CODEX = {
  context_window: 272000,
  supports_1m: false,
  thinking_mode: 'enabled_only',
  supports_adaptive: false,
  requires_adaptive: false,
  supports_interleaved: false,
  supports_effort: true,
  supports_context_management: false,
}

function entry(partial) {
  return {
    enabled: true,
    display_name: partial.display_name || partial.id || '',
    family: partial.family || 'other',
    sort: partial.sort ?? 100,
    capabilities: { ...partial.capabilities },
    betas: {
      required: partial.betas?.required || ['oauth-2025-04-20', 'interleaved-thinking-2025-05-14'],
      drop: partial.betas?.drop || [CONTEXT_1M],
      allow_client: partial.betas?.allow_client !== false,
      ...(typeof partial.betas?.pass_context_1m === 'boolean'
        ? { pass_context_1m: partial.betas.pass_context_1m }
        : {}),
    },
    params: {
      max_tokens_default: partial.params?.max_tokens_default ?? 16384,
      max_tokens_cap: partial.params?.max_tokens_cap ?? 64000,
      thinking_fallback_budget: partial.params?.thinking_fallback_budget ?? 4096,
      on_adaptive: partial.params?.on_adaptive || 'passthrough',
      on_enabled: partial.params?.on_enabled || 'passthrough',
    },
    aliases: partial.aliases || [],
  }
}

/** Official seed matrix (Aug 2026). Panel "reset" restores this. */
export function seedDefaultPolicy() {
  const models = {}
  const add = (id, cfg) => {
    models[id] = entry({ id, ...cfg })
  }

  add('claude-haiku-4-5-20251001', {
    display_name: 'Haiku 4.5',
    family: 'haiku',
    sort: 10,
    capabilities: CAP_HAIKU,
    betas: {
      required: ['oauth-2025-04-20', 'interleaved-thinking-2025-05-14'],
      drop: [CONTEXT_1M, 'effort-2025-11-24', 'context-management-2025-06-27'],
      pass_context_1m: false,
    },
    params: {
      max_tokens_default: 8192,
      max_tokens_cap: 64000,
      thinking_fallback_budget: 4096,
      on_adaptive: 'convert_to_enabled',
      on_enabled: 'passthrough',
    },
    aliases: ['haiku', 'claude-haiku-4-5', 'claude-3-5-haiku', 'claude-3-5-haiku-latest'],
  })

  add('claude-haiku-4-5', {
    display_name: 'Haiku 4.5 (alias id)',
    family: 'haiku',
    sort: 11,
    capabilities: CAP_HAIKU,
    betas: {
      required: ['oauth-2025-04-20', 'interleaved-thinking-2025-05-14'],
      drop: [CONTEXT_1M, 'effort-2025-11-24', 'context-management-2025-06-27'],
      pass_context_1m: false,
    },
    params: {
      max_tokens_default: 8192,
      max_tokens_cap: 64000,
      thinking_fallback_budget: 4096,
      on_adaptive: 'convert_to_enabled',
    },
    aliases: [],
  })

  add('claude-sonnet-4-5-20250929', {
    display_name: 'Sonnet 4.5',
    family: 'sonnet',
    sort: 15,
    capabilities: CAP_SONNET45,
    betas: { pass_context_1m: false },
    params: { on_adaptive: 'convert_to_enabled', max_tokens_default: 16384 },
    aliases: ['claude-sonnet-4-5'],
  })

  add('claude-sonnet-4-6', {
    display_name: 'Sonnet 4.6',
    family: 'sonnet',
    sort: 20,
    capabilities: CAP_46,
    betas: {
      required: ['claude-code-20250219', 'oauth-2025-04-20', 'interleaved-thinking-2025-05-14'],
      drop: [CONTEXT_1M],
      pass_context_1m: false,
    },
    params: { max_tokens_default: 16384, max_tokens_cap: 64000, on_adaptive: 'passthrough' },
    aliases: ['sonnet'],
  })

  add('claude-opus-4-6', {
    display_name: 'Opus 4.6',
    family: 'opus',
    sort: 25,
    capabilities: CAP_46,
    betas: {
      required: ['claude-code-20250219', 'oauth-2025-04-20', 'interleaved-thinking-2025-05-14'],
      drop: [CONTEXT_1M],
      pass_context_1m: false,
    },
    params: { max_tokens_default: 32000, max_tokens_cap: 128000, on_adaptive: 'passthrough' },
    aliases: [],
  })

  add('claude-opus-4-7', {
    display_name: 'Opus 4.7',
    family: 'opus',
    sort: 28,
    capabilities: CAP_ADAPTIVE_ONLY,
    betas: { pass_context_1m: false },
    params: {
      max_tokens_default: 32000,
      max_tokens_cap: 128000,
      on_adaptive: 'passthrough',
      on_enabled: 'passthrough',
    },
  })

  add('claude-opus-4-8', {
    display_name: 'Opus 4.8',
    family: 'opus',
    sort: 29,
    capabilities: CAP_ADAPTIVE_ONLY,
    betas: { pass_context_1m: false },
    params: {
      max_tokens_default: 32000,
      max_tokens_cap: 128000,
      on_adaptive: 'passthrough',
      on_enabled: 'passthrough',
    },
  })

  add('claude-sonnet-5', {
    display_name: 'Sonnet 5',
    family: 'sonnet',
    sort: 30,
    capabilities: CAP_ADAPTIVE_ONLY,
    betas: { pass_context_1m: true },
    params: {
      max_tokens_default: 16384,
      max_tokens_cap: 128000,
      on_adaptive: 'passthrough',
      on_enabled: 'passthrough',
    },
    aliases: [],
  })

  add('claude-opus-5', {
    display_name: 'Opus 5',
    family: 'opus',
    sort: 35,
    capabilities: CAP_ADAPTIVE_ONLY,
    betas: { pass_context_1m: false },
    params: {
      max_tokens_default: 32000,
      max_tokens_cap: 128000,
      on_adaptive: 'passthrough',
      on_enabled: 'passthrough',
    },
    aliases: ['opus'],
  })

  add('claude-fable-5', {
    display_name: 'Fable 5',
    family: 'fable',
    sort: 40,
    capabilities: CAP_ADAPTIVE_ONLY,
    betas: { pass_context_1m: false },
    params: {
      max_tokens_default: 32000,
      max_tokens_cap: 128000,
      on_adaptive: 'passthrough',
      on_enabled: 'passthrough',
    },
    aliases: ['fable'],
  })

  add('claude-fable-5.1', {
    display_name: 'Fable 5.1',
    family: 'fable',
    sort: 41,
    capabilities: CAP_ADAPTIVE_ONLY,
    betas: { pass_context_1m: false },
    params: {
      max_tokens_default: 32000,
      max_tokens_cap: 128000,
      on_adaptive: 'passthrough',
      on_enabled: 'passthrough',
    },
    aliases: [],
  })

  return {
    version: 1,
    updated_at: new Date().toISOString(),
    source: 'seed',
    defaults: {
      enabled: true,
      max_tokens: 16384,
      thinking_fallback_budget: 4096,
      strip_context_1m: true,
      // Fallback only: used when models[id].betas.pass_context_1m is unset.
      context_1m_whitelist: [...DEFAULT_CONTEXT_1M_WHITELIST],
      normalize_thinking: true,
    },
    models,
    aliases: {
      sonnet: 'claude-sonnet-4-6',
      opus: 'claude-opus-5',
      haiku: 'claude-haiku-4-5-20251001',
      'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
      'claude-3-5-haiku': 'claude-haiku-4-5-20251001',
      'claude-3-5-haiku-latest': 'claude-haiku-4-5-20251001',
      fable: 'claude-fable-5',
    },
    catalog_mode: 'policy_only',
  }
}

/** @type {ReturnType<typeof seedDefaultPolicy>} */
let policy = seedDefaultPolicy()
let loaded = false

function deepMergeEntry(base, patch) {
  if (!patch || typeof patch !== 'object') return base
  const out = { ...base, ...patch }
  if (patch.capabilities) out.capabilities = { ...base.capabilities, ...patch.capabilities }
  if (patch.betas) {
    out.betas = {
      ...base.betas,
      ...patch.betas,
      required: patch.betas.required ?? base.betas.required,
      drop: patch.betas.drop ?? base.betas.drop,
    }
  }
  if (patch.params) out.params = { ...base.params, ...patch.params }
  if (patch.aliases) out.aliases = patch.aliases
  return out
}

export function normalizePolicy(raw) {
  const seed = seedDefaultPolicy()
  if (!raw || typeof raw !== 'object') return seed
  const models = { ...seed.models }
  if (raw.models && typeof raw.models === 'object') {
    for (const [id, cfg] of Object.entries(raw.models)) {
      if (!id) continue
      const base =
        models[id] ||
        entry({
          id,
          display_name: id,
          family: id.includes('haiku')
            ? 'haiku'
            : id.includes('opus')
              ? 'opus'
              : id.includes('fable')
                ? 'fable'
                : 'sonnet',
          capabilities: heuristicCapabilities(id),
          params: {},
        })
      models[id] = deepMergeEntry(base, cfg)
    }
  }
  for (const [id, cfg] of Object.entries(models)) {
    if (cfg.params?.on_enabled === 'convert_to_adaptive') {
      cfg.params = { ...cfg.params, on_enabled: 'passthrough' }
    }
    if (typeof cfg.betas?.pass_context_1m !== 'boolean') {
      const seeded = seed.models[id]?.betas?.pass_context_1m
      cfg.betas = {
        ...cfg.betas,
        pass_context_1m:
          typeof seeded === 'boolean' ? seeded : shouldPassContext1m(id, seed.defaults.context_1m_whitelist),
      }
    }
  }
  const rawDefaults = raw.defaults && typeof raw.defaults === 'object' ? raw.defaults : {}
  const hasWhitelist = Object.prototype.hasOwnProperty.call(rawDefaults, 'context_1m_whitelist')
  return {
    version: Number(raw.version) || 1,
    updated_at: raw.updated_at || new Date().toISOString(),
    source: raw.source || 'panel',
    defaults: {
      ...seed.defaults,
      ...rawDefaults,
      context_1m_whitelist: hasWhitelist
        ? normalizeContext1mWhitelist(rawDefaults.context_1m_whitelist, [])
        : [...seed.defaults.context_1m_whitelist],
    },
    models,
    aliases: { ...seed.aliases, ...(raw.aliases || {}) },
    catalog_mode: raw.catalog_mode || seed.catalog_mode,
  }
}

export function familyOfModelId(id = '') {
  const s = String(id || '').toLowerCase()
  if (/^(gpt-|codex-)/i.test(s)) return 'codex'
  if (s.includes('haiku')) return 'haiku'
  if (s.includes('opus')) return 'opus'
  if (s.includes('fable')) return 'fable'
  if (s.includes('sonnet')) return 'sonnet'
  return 'other'
}

function heuristicCapabilities(modelId = '') {
  const m = String(modelId).toLowerCase()
  if (/^(gpt-|codex-)/i.test(m)) return { ...CAP_CODEX }
  if (m.includes('haiku') || /claude-3[.-]/.test(m)) return { ...CAP_HAIKU }
  if (/claude-(sonnet|opus)-4-5/.test(m)) return { ...CAP_SONNET45 }
  if (/claude-(opus|sonnet|fable|mythos)-5/.test(m) || /claude-opus-4-[78]/.test(m)) {
    return { ...CAP_ADAPTIVE_ONLY }
  }
  if (/claude-(sonnet|opus)-4-6/.test(m)) return { ...CAP_46 }
  return { ...CAP_46 }
}

export function loadModelPolicy({ force = false } = {}) {
  if (loaded && !force) return policy
  try {
    const repo = new SettingsRepo()
    const stored = repo.get(SETTINGS_KEY, null)
    if (stored) {
      policy = normalizePolicy(stored)
      policy.source = policy.source || 'settings'
    } else {
      policy = seedDefaultPolicy()
      repo.set(SETTINGS_KEY, policy)
    }
  } catch {
    policy = seedDefaultPolicy()
  }
  loaded = true
  return policy
}

export function getModelPolicy() {
  if (!loaded) loadModelPolicy()
  return policy
}

export function saveModelPolicy(next) {
  policy = normalizePolicy(next)
  policy.updated_at = new Date().toISOString()
  policy.source = 'panel'
  try {
    const repo = new SettingsRepo()
    repo.set(SETTINGS_KEY, policy)
  } catch (e) {
    console.warn('[model-policy] persist failed', e?.message || e)
  }
  loaded = true
  return policy
}

export function resetModelPolicy() {
  policy = seedDefaultPolicy()
  try {
    const repo = new SettingsRepo()
    repo.set(SETTINGS_KEY, policy)
  } catch {}
  loaded = true
  return policy
}

export function resolvePolicyModelId(raw = '') {
  if (!loaded) loadModelPolicy()
  const m = String(raw || '').trim()
  if (!m) return null
  const bare = m.split('/').filter(Boolean).pop() || m
  const lower = stripClaudeCode1mSuffix(bare).toLowerCase()

  const aliasTarget = policy.aliases[lower] || policy.aliases[bare]
  if (aliasTarget && policy.models[aliasTarget]) return aliasTarget

  if (policy.models[bare]) return bare
  if (policy.models[lower]) return lower

  for (const [id, cfg] of Object.entries(policy.models)) {
    if ((cfg.aliases || []).some((a) => String(a).toLowerCase() === lower)) return id
  }

  for (const id of Object.keys(policy.models)) {
    if (id.toLowerCase() === lower) return id
  }

  return bare
}

export function getModelEntry(modelId = '') {
  if (!loaded) loadModelPolicy()
  const key = resolvePolicyModelId(modelId)
  if (key && policy.models[key]) return { id: key, ...policy.models[key] }
  const id = key || String(modelId || '')
  const caps = heuristicCapabilities(id)
  return {
    id,
    enabled: policy.defaults.enabled !== false,
    display_name: id,
    family: 'other',
    sort: 999,
    capabilities: caps,
    betas: {
      required: ['oauth-2025-04-20', 'interleaved-thinking-2025-05-14'],
      drop: policy.defaults.strip_context_1m !== false ? [CONTEXT_1M] : [],
      allow_client: true,
    },
    params: {
      max_tokens_default: policy.defaults.max_tokens || 16384,
      max_tokens_cap: 64000,
      thinking_fallback_budget: policy.defaults.thinking_fallback_budget || 4096,
      on_adaptive: caps.supports_adaptive ? 'passthrough' : 'convert_to_enabled',
      on_enabled: 'passthrough',
    },
    aliases: [],
    _heuristic: true,
  }
}

export function isModelEnabled(modelId = '') {
  return getModelEntry(modelId).enabled !== false
}

export function getCapabilities(modelId = '') {
  return getModelEntry(modelId).capabilities
}

export function getBetaPolicy(modelId = '') {
  return getModelEntry(modelId).betas
}

export function getContext1mWhitelist() {
  if (!loaded) loadModelPolicy()
  return normalizeContext1mWhitelist(policy.defaults?.context_1m_whitelist, DEFAULT_CONTEXT_1M_WHITELIST)
}

/**
 * Official 1M beta: matrix flag wins; whitelist is fallback for unset / heuristic ids.
 * strip_context_1m=false passes every official model.
 */
export function resolveContext1mPass(
  modelId = '',
  { entry = null, whitelist = DEFAULT_CONTEXT_1M_WHITELIST, strip = true } = {},
) {
  if (strip === false) return true
  if (typeof entry?.betas?.pass_context_1m === 'boolean') return entry.betas.pass_context_1m
  return shouldPassContext1m(modelId, whitelist)
}

export function shouldPassContext1mByPolicy(modelId = '') {
  if (!loaded) loadModelPolicy()
  return resolveContext1mPass(modelId, {
    entry: getModelEntry(modelId),
    whitelist: getContext1mWhitelist(),
    strip: policy.defaults.strip_context_1m !== false,
  })
}

export function getModelParams(modelId = '') {
  return getModelEntry(modelId).params
}

export const MIN_THINKING_BUDGET = 1024

/** Anthropic rejects thinking.enabled.budget_tokens < 1024. Raise max_tokens with it. */
export function clampEnabledThinkingBudget(body = {}) {
  const thinking = body?.thinking
  if (!thinking || typeof thinking !== 'object') return body
  if (String(thinking.type || '').toLowerCase() !== 'enabled') return body
  const fallback = Number(getModelParams(body.model || '').thinking_fallback_budget) || 4096
  let budget = Number(thinking.budget_tokens)
  if (!Number.isFinite(budget) || budget <= 0) budget = fallback
  if (Number(thinking.budget_tokens) !== budget) {
    body.thinking = { ...thinking, type: 'enabled', budget_tokens: budget }
  }
  // max_tokens is the caller's total thinking budget; never silently replace it.
  // The worker/provider is responsible for rejecting an incompatible budget.
  return body
}

export function normalizeThinkingByPolicy(body = {}) {
  if (!loaded) loadModelPolicy()
  if (!body || typeof body !== 'object') return body
  if (policy.defaults.normalize_thinking === false) return body
  const thinking = body.thinking
  if (!thinking || typeof thinking !== 'object') return body

  const model = body.model || ''
  const entry = getModelEntry(model)
  const type = String(thinking.type || '').toLowerCase()
  const params = entry.params || {}
  const caps = entry.capabilities || {}

  if (type === 'adaptive') {
    const action = params.on_adaptive || (caps.supports_adaptive ? 'passthrough' : 'convert_to_enabled')
    if (action === 'strip') {
      delete body.thinking
      return body
    }
    if (action === 'convert_to_enabled') {
      const budget =
        Number(thinking.budget_tokens) > 0
          ? Number(thinking.budget_tokens)
          : params.thinking_fallback_budget || policy.defaults.thinking_fallback_budget || 4096
      body.thinking = { type: 'enabled', budget_tokens: budget }
      return clampEnabledThinkingBudget(body)
    }
  }

  if (type === 'enabled') {
    // OAuth (sub2api): keep thinking.enabled. convert_to_adaptive is ignored.
    const action = params.on_enabled || 'passthrough'
    if (action === 'strip') {
      delete body.thinking
      return body
    }
  }

  return clampEnabledThinkingBudget(body)
}

function stripTokens(header, tokens) {
  const drop = new Set(tokens)
  return String(header || '')
    .split(',')
    .map((s) => s.trim())
    .filter((t) => t && !drop.has(t))
    .join(',')
}

export function applyBetaPolicyToHeader(
  existingBeta = '',
  modelId = '',
  { isOfficial = false, whitelist, want1m = false } = {},
) {
  if (!loaded) loadModelPolicy()
  const pass =
    whitelist !== undefined
      ? resolveContext1mPass(modelId, {
          whitelist: normalizeContext1mWhitelist(whitelist, []),
          strip: policy.defaults.strip_context_1m !== false,
        })
      : shouldPassContext1mByPolicy(modelId)
  if (isOfficial) {
    let beta = String(existingBeta || '').trim() ? ensureOauthBeta(existingBeta) : defaultOfficialBetaHeader(modelId)
    if (!pass) return stripTokens(beta, [CONTEXT_1M])
    return want1m ? ensureContext1mBeta(beta) : beta
  }
  // Unofficial / OAuth mimic. Client/stored betas are ignored.
  // Bare unofficial never gets context-1m. Trailing [1m] on an allowed
  // model (pass_context_1m / whitelist) is an explicit 1M opt-in.
  const mimic = unofficialMimicryBetaHeader(modelId)
  if (want1m && pass) return ensureContext1mBeta(mimic)
  return mimic
}

export function unofficialMimicryBetaHeader(modelId = '') {
  const caps = getCapabilities(modelId)
  if (caps?.supports_context_management === false || /haiku/i.test(String(modelId || ''))) {
    return HAIKU_BETA_HEADER
  }
  return joinBetas(fullClaudeCodeMimicryBetas().filter((t) => t !== CONTEXT_1M))
}

/** All policy model ids that look like Claude catalog ids (disabled included). */
export function getPolicyCatalogIds({ enabledOnly = false } = {}) {
  if (!loaded) loadModelPolicy()
  return Object.entries(policy.models || {})
    .filter(([id, cfg]) => isCatalogModelId(id) && (!enabledOnly || cfg.enabled !== false))
    .map(([id]) => id)
}

export function filterPublicModelIds(workerIds = []) {
  if (!loaded) loadModelPolicy()
  const mode = policy.catalog_mode || 'policy_only'
  const ids = [...new Set((workerIds || []).filter(Boolean))]

  if (mode === 'worker_only') return ids

  // policy_only and legacy worker_intersect_policy: #/models is the catalog.
  return getPolicyCatalogIds({ enabledOnly: true })
}

export function listPolicyModels() {
  if (!loaded) loadModelPolicy()
  return Object.entries(policy.models)
    .map(([id, cfg]) => ({ id, ...cfg }))
    .sort((a, b) => (a.sort ?? 100) - (b.sort ?? 100) || a.id.localeCompare(b.id))
}

export function syncWorkerModelsIntoPolicy(workerIds = []) {
  if (!loaded) loadModelPolicy()
  let changed = false
  for (const id of workerIds || []) {
    if (!id || !isCatalogModelId(id)) continue
    if (/^gpt/i.test(id)) continue
    if (policy.models[id]) continue
    const family = familyOfModelId(id)
    const caps = heuristicCapabilities(id)
    policy.models[id] = entry({
      id,
      display_name: id,
      family,
      capabilities: caps,
      betas: family === 'codex' ? { required: [], drop: [CONTEXT_1M], pass_context_1m: false } : undefined,
      params:
        family === 'codex'
          ? {
              max_tokens_default: 16384,
              max_tokens_cap: 128000,
              on_adaptive: 'passthrough',
              on_enabled: 'passthrough',
            }
          : {
              on_adaptive: caps.supports_adaptive ? 'passthrough' : 'convert_to_enabled',
              on_enabled: 'passthrough',
            },
    })
    // pass_context_1m left unset → inherit defaults.context_1m_whitelist
    changed = true
  }
  if (changed) {
    policy.updated_at = new Date().toISOString()
    policy.source = 'worker_merge'
    try {
      new SettingsRepo().set(SETTINGS_KEY, policy)
    } catch {}
  }
  return policy
}

/** Last-resort fill when the model has no policy default. Probe / short tests use this. */
export const FALLBACK_MAX_TOKENS = 4096

/** Official per-model default for a missing caller max_tokens. Never overwrites inbound. */
export function defaultMaxTokensForModel(modelId = '') {
  if (!loaded) loadModelPolicy()
  const params = getModelParams(modelId)
  const n = Number(params.max_tokens_default)
  const cap = Number(params.max_tokens_cap)
  let out = Number.isFinite(n) && n > 0 ? n : FALLBACK_MAX_TOKENS
  if (Number.isFinite(cap) && cap > 0 && out > cap) out = cap
  return out
}

export function applyMaxTokensCap(body = {}) {
  if (!body || typeof body !== 'object') return body
  const params = getModelParams(body.model || '')
  const cap = Number(params.max_tokens_cap)
  if (!cap || !Number.isFinite(cap)) return body
  const mt = Number(body.max_tokens)
  if (Number.isFinite(mt) && mt > cap) body.max_tokens = cap
  return body
}
