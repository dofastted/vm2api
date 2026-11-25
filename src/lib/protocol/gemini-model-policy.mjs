/**
 * Google / Gemini model catalog and default thinking policy (SSOT).
 * Persisted in settings key "gemini_model_policy" — isolated from Claude
 * `model_policy` and OpenAI `gpt_model_policy`.
 *
 * Scope: ONLY Google Gemini series models (`gemini-*`) and Gemini slots.
 * Default thinking effort is always `medium` unless overridden per model.
 */
import { SettingsRepo } from '../db/repos/settings-repo.mjs'

const SETTINGS_KEY = 'gemini_model_policy'

export const GEMINI_SEED_VERSION = 1
export const DEFAULT_GEMINI_EFFORT = 'medium'
export const GEMINI_EFFORT_VALUES = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const GEMINI_EFFORT_SET = new Set(GEMINI_EFFORT_VALUES)

const GEMINI_MODEL_RE = /^gemini-[a-z0-9][a-z0-9._-]{0,95}$/i
const GEMINI_NON_CHAT_RE = /(?:^|[-_])(embedding|aqa|tts|live|audio|robotics|computer-use)(?:$|[-_])/i
const GEMINI_VARIANT_SUFFIX_RE = /-(?:thinking|minimal|low|medium|high|xhigh|max)$/i
const GEMINI_PREVIEW_SUFFIX_RE = /-preview(?:-\d{2}-\d{2})?$/i

const CAP_GEMINI = Object.freeze({
  context_window: 1_000_000,
  supports_1m: true,
  thinking_mode: 'level',
  supports_adaptive: false,
  requires_adaptive: false,
  supports_interleaved: false,
  supports_effort: true,
  supports_context_management: false,
})

function bareModelId(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  return (s.split('/').filter(Boolean).pop() || s).replace(/^models\//i, '').trim()
}

export function isGeminiSeriesId(id) {
  const bare = bareModelId(id)
  if (!bare) return false
  if (bare.endsWith('-') || bare.endsWith('.')) return false
  return GEMINI_MODEL_RE.test(bare)
}

export function isSyncableGeminiCatalogId(id) {
  const bare = bareModelId(id)
  if (!isGeminiSeriesId(bare)) return false
  if (GEMINI_NON_CHAT_RE.test(bare)) return false
  return true
}

export function normalizeGeminiDefaultEffort(value, fallback = DEFAULT_GEMINI_EFFORT) {
  if (value == null) return fallback
  const s = String(value).trim().toLowerCase()
  if (!s) return fallback
  return GEMINI_EFFORT_SET.has(s) ? s : fallback
}

function stripVariantSuffixes(id) {
  let cur = String(id || '').trim()
  for (let i = 0; i < 3; i += 1) {
    const next = cur.replace(GEMINI_VARIANT_SUFFIX_RE, '').replace(GEMINI_PREVIEW_SUFFIX_RE, '')
    if (next === cur) break
    cur = next
  }
  return cur
}

function entry(id, extra = {}) {
  const caps = {
    ...CAP_GEMINI,
    ...(extra.capabilities && typeof extra.capabilities === 'object' ? extra.capabilities : {}),
  }
  const rawParams = extra.params && typeof extra.params === 'object' ? extra.params : {}
  return {
    id,
    display_name: extra.display_name || extra.label || id,
    family: 'gemini',
    enabled: extra.enabled !== false,
    sort: Number.isFinite(Number(extra.sort)) ? Number(extra.sort) : 80,
    capabilities: caps,
    params: {
      max_tokens_default: Number(rawParams.max_tokens_default) || 16384,
      max_tokens_cap: Number(rawParams.max_tokens_cap) || 65536,
      default_effort: normalizeGeminiDefaultEffort(rawParams.default_effort, DEFAULT_GEMINI_EFFORT),
    },
    aliases: Array.isArray(extra.aliases) ? extra.aliases.filter((a) => typeof a === 'string' && a.trim()) : [],
  }
}

export function seedGeminiPolicy() {
  const models = {}
  for (const [id, extra] of [
    ['gemini-4-neon', { display_name: 'Gemini 4 Neon', sort: 10 }],
    ['gemini-4-argon', { display_name: 'Gemini 4 Argon', sort: 12 }],
    ['gemini-4-hydrogen', { display_name: 'Gemini 4 Hydrogen', sort: 14 }],
    ['gemini-3.8-flash', { display_name: 'Gemini 3.8 Flash', sort: 20 }],
    ['gemini-3.5-flash-lite', { display_name: 'Gemini 3.5 Flash Lite', sort: 22 }],
    ['gemini-3.1-pro', { display_name: 'Gemini 3.1 Pro', sort: 25 }],
    ['gemini-3.1-flash-lite', { display_name: 'Gemini 3.1 Flash Lite', sort: 27 }],
    ['gemini-3-pro', { display_name: 'Gemini 3 Pro', sort: 30 }],
    ['gemini-3-flash', { display_name: 'Gemini 3 Flash', sort: 32 }],
    ['gemini-2.5-pro', { display_name: 'Gemini 2.5 Pro', sort: 40 }],
    ['gemini-2.5-flash', { display_name: 'Gemini 2.5 Flash', sort: 42 }],
    ['gemini-2.5-flash-lite', { display_name: 'Gemini 2.5 Flash Lite', sort: 44 }],
    ['gemini-2.0-flash', { display_name: 'Gemini 2.0 Flash', sort: 50 }],
    ['gemini-2.0-flash-lite', { display_name: 'Gemini 2.0 Flash Lite', sort: 52 }],
  ]) {
    models[id] = entry(id, extra)
  }
  return {
    version: 1,
    seed_version: GEMINI_SEED_VERSION,
    updated_at: new Date().toISOString(),
    source: 'seed',
    platform: 'google',
    models,
  }
}

let policy = seedGeminiPolicy()
let loaded = false
let injectedSettings = null

export function setGeminiModelPolicyTestHooks(hooks = null) {
  injectedSettings = hooks?.settings ?? null
  loaded = false
  policy = seedGeminiPolicy()
}

function settingsRepo() {
  if (injectedSettings) return injectedSettings
  return new SettingsRepo()
}

function persist() {
  try {
    settingsRepo().set(SETTINGS_KEY, policy)
  } catch (e) {
    console.warn('[gemini-model-policy] persist failed', e?.message || e)
  }
}

function normalizeStoredModels(rawModels, { mergeSeed = true } = {}) {
  const seed = seedGeminiPolicy().models
  const out = {}
  if (mergeSeed) {
    for (const [id, row] of Object.entries(seed)) {
      out[id] = entry(id, row)
    }
  }
  if (rawModels && typeof rawModels === 'object') {
    for (const [rawId, row] of Object.entries(rawModels)) {
      const id = bareModelId(rawId)
      if (!isGeminiSeriesId(id) || !row || typeof row !== 'object') continue
      const base = out[id] || seed[id] || null
      const merged = entry(id, {
        ...(base || {}),
        ...row,
        capabilities: { ...(base?.capabilities || {}), ...(row.capabilities || {}) },
        params: { ...(base?.params || {}), ...(row.params || {}) },
      })
      if (row.catalog && typeof row.catalog === 'object') merged.catalog = row.catalog
      out[id] = merged
    }
  }
  return out
}

export function loadGeminiModelPolicy({ force = false } = {}) {
  if (loaded && !force) return policy
  try {
    const stored = settingsRepo().get(SETTINGS_KEY, null)
    if (stored && typeof stored === 'object' && stored.models && typeof stored.models === 'object') {
      const live = stored.source === 'google' && Object.keys(stored.models).length > 0
      policy = {
        ...seedGeminiPolicy(),
        ...stored,
        platform: 'google',
        seed_version: GEMINI_SEED_VERSION,
        models: normalizeStoredModels(stored.models, { mergeSeed: !live }),
      }
      policy.source = policy.source || 'settings'
    } else {
      policy = seedGeminiPolicy()
      persist()
    }
  } catch {
    policy = seedGeminiPolicy()
  }
  loaded = true
  return policy
}

export function getGeminiModelPolicy() {
  if (!loaded) loadGeminiModelPolicy()
  return policy
}

export function saveGeminiModelPolicy(next) {
  if (!loaded) loadGeminiModelPolicy()
  const seed = seedGeminiPolicy()
  const models = {}
  const incoming = next?.models && typeof next.models === 'object' ? next.models : {}
  const baseSource = Object.keys(incoming).length ? incoming : seed.models
  for (const [rawId, row] of Object.entries(baseSource)) {
    const id = bareModelId(rawId)
    if (!isGeminiSeriesId(id) || !row || typeof row !== 'object') continue
    const { catalog: _drop, ...edits } = row
    const prev = policy.models?.[id] || seed.models[id] || null
    models[id] = entry(id, {
      ...(prev || {}),
      ...edits,
      capabilities: { ...(prev?.capabilities || {}), ...(edits.capabilities || {}) },
      params: { ...(prev?.params || {}), ...(edits.params || {}) },
    })
    if (prev?.catalog) models[id].catalog = prev.catalog
  }
  policy = {
    ...seed,
    ...next,
    models,
    platform: 'google',
    seed_version: GEMINI_SEED_VERSION,
    updated_at: new Date().toISOString(),
    source: 'panel',
  }
  loaded = true
  persist()
  return policy
}

export function resetGeminiModelPolicy() {
  policy = seedGeminiPolicy()
  loaded = true
  persist()
  return policy
}

export function listGeminiPolicyModels() {
  if (!loaded) loadGeminiModelPolicy()
  return Object.entries(policy.models || {})
    .filter(([id, cfg]) => isGeminiSeriesId(id) && cfg?.enabled !== false)
    .map(([id, cfg]) => ({ id, ...cfg, family: 'gemini' }))
    .sort((a, b) => (a.sort ?? 80) - (b.sort ?? 80) || String(a.id).localeCompare(String(b.id)))
}

export function getGeminiPolicyCatalogIds({ enabledOnly = false } = {}) {
  if (!loaded) loadGeminiModelPolicy()
  return Object.entries(policy.models || {})
    .filter(([id, cfg]) => isGeminiSeriesId(id) && (!enabledOnly || cfg?.enabled !== false))
    .map(([id]) => id)
}

function findPolicyRow(modelId) {
  if (!loaded) loadGeminiModelPolicy()
  const bare = bareModelId(modelId)
  if (!isGeminiSeriesId(bare)) return null
  const lower = bare.toLowerCase()
  const models = policy.models || {}
  if (models[bare]) return models[bare]
  for (const [id, row] of Object.entries(models)) {
    if (id.toLowerCase() === lower) return row
  }
  const stripped = stripVariantSuffixes(lower)
  if (stripped && stripped !== lower) {
    for (const [id, row] of Object.entries(models)) {
      if (id.toLowerCase() === stripped) return row
    }
  }
  return null
}

export function resolveGeminiPolicyEntry(modelId) {
  return findPolicyRow(modelId)
}

/**
 * Only Gemini series models (`gemini-*`) are governed by `gemini_model_policy`.
 * Non-Gemini Antigravity models (`ag-claude-*`, `ag-gpt-*`) stay untouched here.
 */
export function isGeminiModelEnabled(modelId) {
  const bare = bareModelId(modelId)
  if (!isGeminiSeriesId(bare)) return true
  const row = findPolicyRow(bare)
  if (!row) return true
  return row.enabled !== false
}

/**
 * Resolve default thinking effort for a Gemini series model.
 * Returns `null` for non-Gemini models; otherwise returns the model's configured
 * `params.default_effort` (`'off'` disables injection), defaulting to `'medium'`.
 */
export function resolveGeminiDefaultEffort(modelId) {
  const bare = bareModelId(modelId)
  if (!isGeminiSeriesId(bare)) return null
  const row = findPolicyRow(bare)
  return normalizeGeminiDefaultEffort(row?.params?.default_effort, DEFAULT_GEMINI_EFFORT)
}

/**
 * Merge newly discovered Google Gemini models into `gemini_model_policy`.
 * Existing rows keep their operator edits (`enabled`, `default_effort`, etc.);
 * newly discovered Gemini models are added enabled with `default_effort: 'medium'`.
 */
export function syncGeminiIdsIntoPolicy(
  items = [],
  { displayNameOf = null, contextOf = null, source = 'google' } = {},
) {
  if (!loaded) loadGeminiModelPolicy()
  const incoming = []
  const seen = new Set()
  for (const raw of items || []) {
    const id = bareModelId(typeof raw === 'string' ? raw : raw?.id)
    if (!isSyncableGeminiCatalogId(id) || seen.has(id.toLowerCase())) continue
    seen.add(id.toLowerCase())
    incoming.push({
      id,
      display_name: String((typeof raw === 'object' && raw?.display_name) || '').trim(),
      context:
        typeof raw === 'object' && Number.isFinite(Number(raw?.context)) && Number(raw.context) > 0
          ? Number(raw.context)
          : null,
      catalog: typeof raw === 'object' && raw?.catalog && typeof raw.catalog === 'object' ? raw.catalog : null,
    })
  }
  if (!incoming.length) {
    return { ok: true, synced: 0, added: [], ids: listGeminiPolicyModels().map((m) => m.id) }
  }
  const seed = seedGeminiPolicy().models
  const next = {}
  // Keep existing entries first so operator toggles / custom models are never lost when a partial source syncs.
  for (const [id, row] of Object.entries(policy.models || {})) {
    if (isGeminiSeriesId(id)) next[id] = entry(id, row)
    if (row?.catalog && next[id]) next[id].catalog = row.catalog
  }
  const added = []
  const nowIso = new Date().toISOString()
  for (const row of incoming) {
    const existingKey = Object.keys(next).find((k) => k.toLowerCase() === row.id.toLowerCase())
    const key = existingKey || row.id
    const prev = next[key] || seed[row.id] || null
    if (!existingKey) added.push(row.id)
    const ctxWin = row.context || contextOf?.(row.id) || prev?.capabilities?.context_window || CAP_GEMINI.context_window
    next[key] = entry(key, {
      ...(prev || {}),
      display_name: row.display_name || prev?.display_name || displayNameOf?.(row.id) || key,
      enabled: prev ? prev.enabled !== false : true,
      capabilities: {
        ...(prev?.capabilities || CAP_GEMINI),
        context_window: ctxWin,
        supports_1m: ctxWin >= 1_000_000,
      },
      params: {
        ...(prev?.params || {}),
        default_effort: normalizeGeminiDefaultEffort(prev?.params?.default_effort, DEFAULT_GEMINI_EFFORT),
      },
    })
    const catalog = row.catalog
      ? { ...row.catalog, synced_at: nowIso }
      : prev?.catalog
        ? { ...prev.catalog, synced_at: nowIso }
        : { context_window: ctxWin, synced_at: nowIso }
    next[key].catalog = catalog
  }
  policy = {
    ...policy,
    models: next,
    platform: 'google',
    seed_version: GEMINI_SEED_VERSION,
    updated_at: nowIso,
    source,
  }
  persist()
  return {
    ok: true,
    synced: incoming.length,
    added,
    ids: listGeminiPolicyModels().map((m) => m.id),
  }
}
