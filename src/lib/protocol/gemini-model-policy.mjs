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

export const GEMINI_SEED_VERSION = 2
export const DEFAULT_GEMINI_EFFORT = 'medium'
export const GEMINI_EFFORT_VALUES = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const GEMINI_EFFORT_SET = new Set(GEMINI_EFFORT_VALUES)

const GEMINI_MODEL_RE = /^gemini-[a-z0-9][a-z0-9._-]{0,95}$/i
const GEMINI_NON_CHAT_RE = /(?:^|[-_])(embedding|aqa|tts|live|audio|robotics|computer-use)(?:$|[-_])/i
const GEMINI_BLOCKED_UPSTREAM_RE = /(?:^tab_|(?:-disabled)$)/i
const GEMINI_DEFAULT_SUPPORTED_4_RE = /^gemini-4-(?:neon|hydrogen|argon|carbon)(?:-(?:low|medium|high|xhigh))?$/i
const GEMINI_DEFAULT_SUPPORTED_38_RE = /^gemini-3\.8-flash(?:-(?:low|medium|high))?$/i
const GEMINI_NANO_BANANA_2_IDS = new Set(['gemini-3.1-flash-image', 'nano-banana-2'])
const GEMINI_VARIANT_SUFFIX_RE = /-(?:thinking|minimal|low|medium|high|xhigh|extra-high|max|latest)$/i
const GEMINI_PREVIEW_SUFFIX_RE = /-preview(?:-\d{2}-\d{2})?$/i
const MODEL_PAREN_EFFORT_RE = /\(([^()]+)\)$/
const MODEL_TIER_SUFFIX_RE = /-(minimal|low|medium|high|xhigh|extra-high|max)$/i

function normalizeImpliedEffortToken(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
  if (!s) return null
  if (s === 'none' || s === 'off' || s === 'disabled' || s === '0') return 'none'
  if (s === 'minimal') return 'minimal'
  if (s === 'low') return 'low'
  if (s === 'medium' || s === 'med' || s === 'auto' || s === 'adaptive') return 'medium'
  if (s === 'high') return 'high'
  if (s === 'xhigh' || s === 'extra_high' || s === 'extra-high' || s === 'max') return 'xhigh'
  if (/^\d+$/.test(s)) {
    const budget = Number(s)
    if (budget === 0) return 'none'
    if (budget <= 1024) return 'minimal'
    if (budget <= 4096) return 'low'
    if (budget <= 12288) return 'medium'
    if (budget <= 24576) return 'high'
    return 'xhigh'
  }
  return null
}

export function extractImpliedModelEffort(raw) {
  let s = String(raw || '').trim()
  if (!s) return null
  s = (s.split('/').filter(Boolean).pop() || s).replace(/^models\//i, '').trim()
  s = s.replace(/\[1m\]$/i, '')
  const parenMatch = MODEL_PAREN_EFFORT_RE.exec(s)
  if (parenMatch) {
    const parsed = normalizeImpliedEffortToken(parenMatch[1])
    if (parsed) return parsed
    s = s.slice(0, parenMatch.index)
  }
  s = s.replace(/-latest$/i, '').replace(/-thinking$/i, '')
  const tierMatch = MODEL_TIER_SUFFIX_RE.exec(s)
  if (tierMatch) {
    return normalizeImpliedEffortToken(tierMatch[1])
  }
  return null
}

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
  let bare = (s.split('/').filter(Boolean).pop() || s).replace(/^models\//i, '').trim()
  bare = bare.replace(/\[1m\]$/i, '')
  const parenMatch = MODEL_PAREN_EFFORT_RE.exec(bare)
  if (parenMatch && normalizeImpliedEffortToken(parenMatch[1])) {
    bare = bare.slice(0, parenMatch.index)
  }
  return bare.trim()
}

function isBlockedUpstreamId(raw) {
  const bare = bareModelId(raw)
  if (!bare) return false
  const stripped = bare.toLowerCase().startsWith('ag-') ? bare.slice(3) : bare
  return GEMINI_BLOCKED_UPSTREAM_RE.test(bare) || GEMINI_BLOCKED_UPSTREAM_RE.test(stripped)
}

export function isGeminiSeriesId(id) {
  const bare = bareModelId(id)
  if (!bare) return false
  if (bare.endsWith('-') || bare.endsWith('.')) return false
  return GEMINI_MODEL_RE.test(bare)
}

export function isDefaultSupportedGeminiModel(modelId) {
  const bare = bareModelId(modelId).toLowerCase()
  if (!bare || isBlockedUpstreamId(bare)) return false
  if (GEMINI_NANO_BANANA_2_IDS.has(bare)) return true
  return GEMINI_DEFAULT_SUPPORTED_4_RE.test(bare) || GEMINI_DEFAULT_SUPPORTED_38_RE.test(bare)
}

export function isSyncableGeminiCatalogId(id) {
  const bare = bareModelId(id)
  if (isBlockedUpstreamId(bare)) return false
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
    ['gemini-4-carbon', { display_name: 'Gemini 4 Carbon', sort: 15 }],
    ['gemini-3.8-flash', { display_name: 'Gemini 3.8 Flash', sort: 20 }],
    [
      'gemini-3.1-flash-image',
      {
        display_name: 'Nano Banana 2',
        sort: 30,
        aliases: ['nano-banana-2'],
        capabilities: { supports_effort: false, thinking_mode: 'none' },
        params: { default_effort: 'off' },
      },
    ],
  ]) {
    models[id] = entry(id, extra)
  }
  return {
    version: 1,
    seed_version: GEMINI_SEED_VERSION,
    updated_at: new Date().toISOString(),
    source: 'seed',
    platform: 'google',
    allow_third_party_models: false,
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
      if (!isGeminiSeriesId(id) || isBlockedUpstreamId(id) || !row || typeof row !== 'object') continue
      const base = out[id] || seed[id] || null
      const merged = entry(id, {
        ...(base || {}),
        ...row,
        capabilities: { ...(base?.capabilities || {}), ...(row.capabilities || {}) },
        params: { ...(base?.params || {}), ...(row.params || {}) },
        aliases: Array.isArray(row.aliases) && row.aliases.length ? row.aliases : base?.aliases || [],
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
      const storedSeedVersion = Number(stored.seed_version) || 0
      const shouldMigrateDefaults = storedSeedVersion < GEMINI_SEED_VERSION && stored.source !== 'panel'
      if (shouldMigrateDefaults) {
        const seed = seedGeminiPolicy()
        const normalized = normalizeStoredModels(stored.models, { mergeSeed: true })
        for (const [id, row] of Object.entries(normalized)) {
          row.enabled = isDefaultSupportedGeminiModel(id)
          const seedRow = seed.models[id]
          if (seedRow) {
            if (!row.aliases?.length && seedRow.aliases?.length) {
              row.aliases = [...seedRow.aliases]
            }
            if (id === 'gemini-3.1-flash-image') {
              row.display_name = row.display_name || seedRow.display_name
              row.capabilities = { ...row.capabilities, ...seedRow.capabilities }
              row.params = { ...row.params, default_effort: seedRow.params.default_effort }
            }
          }
        }
        policy = {
          ...seed,
          ...stored,
          platform: 'google',
          seed_version: GEMINI_SEED_VERSION,
          allow_third_party_models: stored.allow_third_party_models === true,
          models: normalized,
          updated_at: new Date().toISOString(),
        }
        policy.source = policy.source || 'settings'
        persist()
      } else {
        const live = (stored.source === 'google' || stored.source === 'panel') && Object.keys(stored.models).length > 0
        policy = {
          ...seedGeminiPolicy(),
          ...stored,
          platform: 'google',
          seed_version: GEMINI_SEED_VERSION,
          allow_third_party_models: stored.allow_third_party_models === true,
          models: normalizeStoredModels(stored.models, { mergeSeed: !live }),
        }
        policy.source = policy.source || 'settings'
      }
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
    if (!isGeminiSeriesId(id) || isBlockedUpstreamId(id) || !row || typeof row !== 'object') continue
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
  const allowThirdParty =
    next && typeof next === 'object' && Object.hasOwn(next, 'allow_third_party_models')
      ? next.allow_third_party_models === true
      : policy.allow_third_party_models === true
  policy = {
    ...seed,
    ...next,
    allow_third_party_models: allowThirdParty,
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
    .filter(([id, cfg]) => isGeminiSeriesId(id) && !isBlockedUpstreamId(id) && cfg?.enabled !== false)
    .map(([id, cfg]) => ({ id, ...cfg, family: 'gemini' }))
    .sort((a, b) => (a.sort ?? 80) - (b.sort ?? 80) || String(a.id).localeCompare(String(b.id)))
}

export function getGeminiPolicyCatalogIds({ enabledOnly = false } = {}) {
  if (!loaded) loadGeminiModelPolicy()
  return Object.entries(policy.models || {})
    .filter(([id, cfg]) => isGeminiSeriesId(id) && !isBlockedUpstreamId(id) && (!enabledOnly || cfg?.enabled !== false))
    .map(([id]) => id)
}

function findPolicyRow(modelId, activePolicy = null) {
  const targetPolicy = activePolicy && typeof activePolicy === 'object' ? activePolicy : getGeminiModelPolicy()
  const bare = bareModelId(modelId)
  if (!bare || isBlockedUpstreamId(bare)) return null
  const lower = bare.toLowerCase()
  const models = targetPolicy.models || {}
  if (models[bare]) return models[bare]
  for (const [id, row] of Object.entries(models)) {
    if (id.toLowerCase() === lower) return row
  }
  for (const row of Object.values(models)) {
    if (!Array.isArray(row?.aliases)) continue
    if (
      row.aliases.some(
        (alias) =>
          String(alias || '')
            .trim()
            .toLowerCase() === lower,
      )
    ) {
      return row
    }
  }
  if (!isGeminiSeriesId(bare)) return null
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
 * Fail-closed gate for Gemini / Antigravity models.
 * Accepts either `(modelId)` or `(policyObj, modelId)`.
 *
 * - Always rejects blocked upstream placeholders (`*-disabled`, `tab_*`).
 * - Google Gemini models & configured aliases (`nano-banana-2` -> `gemini-3.1-flash-image`)
 *   must be explicitly enabled in policy (unlisted legacy models fail closed).
 * - Non-Google Antigravity 3P models (`ag-*`, `claude-*`, `gpt-*`) are rejected unless
 *   `policy.allow_third_party_models === true` and not explicitly disabled.
 */
export function isGeminiModelEnabled(policyOrModelId, maybeModelId) {
  let activePolicy
  let rawModelId
  if (maybeModelId !== undefined || (policyOrModelId !== null && typeof policyOrModelId === 'object')) {
    activePolicy =
      policyOrModelId && typeof policyOrModelId === 'object' && policyOrModelId.models
        ? policyOrModelId
        : getGeminiModelPolicy()
    rawModelId = maybeModelId
  } else {
    activePolicy = getGeminiModelPolicy()
    rawModelId = policyOrModelId
  }
  const bare = bareModelId(rawModelId)
  if (!bare || isBlockedUpstreamId(bare)) return false
  const row = findPolicyRow(bare, activePolicy)
  if (row) return row.enabled === true
  if (isGeminiSeriesId(bare) || GEMINI_NANO_BANANA_2_IDS.has(bare.toLowerCase())) {
    return false
  }
  if (activePolicy?.allow_third_party_models !== true) return false
  const stripped = bare.toLowerCase().startsWith('ag-') ? bare.slice(3) : bare
  const models = activePolicy.models || {}
  const explicit =
    models[bare] ||
    models[stripped] ||
    Object.entries(models).find(
      ([id]) => id.toLowerCase() === bare.toLowerCase() || id.toLowerCase() === stripped.toLowerCase(),
    )?.[1] ||
    null
  return explicit ? explicit.enabled !== false : true
}

/**
 * Resolve default thinking effort for a Gemini series model.
 * Returns `null` for non-Gemini models; otherwise returns the model's configured
 * `params.default_effort` (`'off'` disables injection), defaulting to `'medium'`.
 */
export function resolveGeminiDefaultEffort(modelId) {
  const bare = bareModelId(modelId)
  if (!bare || isBlockedUpstreamId(bare)) return null
  const row = findPolicyRow(bare)
  if (row) {
    return normalizeGeminiDefaultEffort(row?.params?.default_effort, DEFAULT_GEMINI_EFFORT)
  }
  if (!isGeminiSeriesId(bare)) return null
  return DEFAULT_GEMINI_EFFORT
}

/**
 * Merge newly discovered Google Gemini models into `gemini_model_policy`.
 * Existing rows keep their operator edits (`enabled`, `default_effort`, etc.);
 * newly discovered models outside `isDefaultSupportedGeminiModel` are added disabled by default.
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
    if (isGeminiSeriesId(id) && !isBlockedUpstreamId(id)) next[id] = entry(id, row)
    if (row?.catalog && next[id]) next[id].catalog = row.catalog
  }
  const added = []
  const nowIso = new Date().toISOString()
  for (const row of incoming) {
    const existingKey = Object.keys(next).find((k) => k.toLowerCase() === row.id.toLowerCase())
    const key = existingKey || row.id
    const seedRow = seed[row.id] || seed[row.id.toLowerCase()] || null
    const prev = existingKey ? next[key] : seedRow
    if (!existingKey) added.push(row.id)
    const ctxWin = row.context || contextOf?.(row.id) || prev?.capabilities?.context_window || CAP_GEMINI.context_window
    const enabled = existingKey
      ? prev.enabled !== false
      : seedRow
        ? seedRow.enabled !== false
        : isDefaultSupportedGeminiModel(row.id)
    next[key] = entry(key, {
      ...(prev || {}),
      display_name: row.display_name || prev?.display_name || displayNameOf?.(row.id) || key,
      enabled,
      capabilities: {
        ...(prev?.capabilities || CAP_GEMINI),
        context_window: ctxWin,
        supports_1m: ctxWin >= 1_000_000,
      },
      params: {
        ...(prev?.params || {}),
        default_effort: normalizeGeminiDefaultEffort(prev?.params?.default_effort, DEFAULT_GEMINI_EFFORT),
      },
      aliases: prev?.aliases?.length ? prev.aliases : seedRow?.aliases || [],
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
    allow_third_party_models: policy.allow_third_party_models === true,
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
