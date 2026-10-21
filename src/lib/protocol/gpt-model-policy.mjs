/**
 * GPT catalog. Separate settings key from Claude model_policy.
 * Live ids from ChatGPT sync; seed is empty-catalog fallback.
 */
import { RuntimeSettings as SettingsRepo } from '../db/settings-state.mjs'
import { isGptSeriesId, isSyncableGptCatalogId } from './gpt-ids.mjs'

const SETTINGS_KEY = 'gpt_model_policy'

const CAP_GPT = {
  context_window: 272000,
  supports_1m: false,
  thinking_mode: 'enabled_only',
  supports_adaptive: false,
  requires_adaptive: false,
  supports_interleaved: false,
  supports_effort: false,
  supports_context_management: false,
}

function entry(id, extra = {}) {
  return {
    id,
    display_name: extra.display_name || extra.label || id,
    family: 'codex',
    enabled: extra.enabled !== false,
    sort: extra.sort || 80,
    capabilities: extra.capabilities || { ...CAP_GPT },
    params: extra.params || { max_tokens_default: 16384, max_tokens_cap: 128000 },
    aliases: extra.aliases || [],
  }
}

export function seedGptPolicy() {
  const models = {}
  for (const [id, extra] of [
    ['gpt-6-sol', { display_name: 'GPT-6 Sol', sort: 70 }],
    ['gpt-6-luna', { display_name: 'GPT-6 Luna', sort: 71 }],
    ['gpt-5.6', { display_name: 'GPT-5.6', sort: 76 }],
    ['gpt-5.5', { display_name: 'GPT-5.5', sort: 77 }],
    ['gpt-5.4', { display_name: 'GPT-5.4', sort: 80, aliases: ['codex'] }],
    ['gpt-5.4-mini', { display_name: 'GPT-5.4 Mini', sort: 81 }],
    ['gpt-5.3-codex', { display_name: 'GPT-5.3 Codex', sort: 82 }],
  ]) {
    models[id] = entry(id, extra)
  }
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    source: 'seed',
    platform: 'openai',
    models,
  }
}

let policy = seedGptPolicy()
let loaded = false

async function persist() {
  try {
    await new SettingsRepo().set(SETTINGS_KEY, policy)
  } catch (e) {
    console.warn('[gpt-model-policy] persist failed', e?.message || e)
  }
}

function normalizeGptPolicy(stored) {
  if (!stored || typeof stored !== 'object' || !stored.models || typeof stored.models !== 'object') return null
  const live = stored.source === 'codex' && Object.keys(stored.models).length
  const seed = seedGptPolicy()
  const normalized = {
    ...(live ? stored : { ...seed, ...stored, models: { ...seed.models, ...stored.models } }),
    platform: 'openai',
  }
  normalized.source = normalized.source || 'settings'
  return normalized
}

export async function loadGptModelPolicy({ force = false } = {}) {
  if (loaded && !force) return policy
  try {
    policy = normalizeGptPolicy(new SettingsRepo().get(SETTINGS_KEY, null))
    if (!policy) {
      policy = seedGptPolicy()
      await persist()
    }
  } catch {
    policy = seedGptPolicy()
  }
  loaded = true
  return policy
}

/** Apply a refreshed settings value without persisting missing-policy defaults. */
export function refreshGptModelPolicy(stored) {
  policy = normalizeGptPolicy(stored) || seedGptPolicy()
  loaded = true
  return policy
}

export function getGptModelPolicy() {
  return policy
}

export async function saveGptModelPolicy(next) {
  const seed = seedGptPolicy()
  const models = { ...(seed.models || {}) }
  if (next?.models && typeof next.models === 'object') {
    for (const [id, row] of Object.entries(next.models)) {
      if (!isGptSeriesId(id) || !row || typeof row !== 'object') continue
      models[id] = { ...models[id], ...row, id, family: 'codex' }
    }
  }
  policy = {
    ...seed,
    ...next,
    models,
    platform: 'openai',
    updated_at: new Date().toISOString(),
    source: 'panel',
  }
  await persist()
  return policy
}
export function listGptPolicyModels() {
  return Object.entries(policy.models || {})
    .filter(([id, cfg]) => isGptSeriesId(id) && cfg?.enabled !== false)
    .map(([id, cfg]) => ({ id, ...cfg, family: 'codex' }))
    .sort((a, b) => (a.sort || 80) - (b.sort || 80) || String(a.id).localeCompare(String(b.id)))
}

export function getGptPolicyCatalogIds({ enabledOnly = false } = {}) {
  return Object.entries(policy.models || {})
    .filter(([id, cfg]) => isGptSeriesId(id) && (!enabledOnly || cfg?.enabled !== false))
    .map(([id]) => id)
}

export function isGptModelEnabled(id) {
  if (!isGptSeriesId(id)) return false
  const row = policy.models?.[id]
  if (row) return row.enabled !== false
  if (policy.source === 'codex' && Object.keys(policy.models || {}).length) return false
  return true
}

export async function resetGptModelPolicy() {
  policy = seedGptPolicy()
  loaded = true
  await persist()
  return policy
}

/**
 * Replace the GPT catalog with the live Codex list. Existing rows keep their edits;
 * a GPT id the policy has never seen starts disabled until the admin enables it
 * (GPT has no worker_only mode).
 */
export async function syncGptIdsIntoPolicy(ids = [], { displayNameOf = null } = {}) {
  const live = []
  const seen = new Set()
  for (const item of ids || []) {
    const id = String(typeof item === 'string' ? item : item?.id || '').trim()
    if (!isSyncableGptCatalogId(id) || seen.has(id.toLowerCase())) continue
    seen.add(id.toLowerCase())
    live.push({
      id,
      display_name: String((typeof item === 'object' && item?.display_name) || '').trim(),
    })
  }
  if (!live.length) {
    return { ok: true, synced: 0, added: [], ids: listGptPolicyModels().map((m) => m.id) }
  }
  const next = {}
  const added = []
  for (const row of live) {
    const prev = policy.models[row.id]
    if (!prev) added.push(row.id)
    next[row.id] = entry(row.id, {
      ...prev,
      display_name: row.display_name || prev?.display_name || displayNameOf?.(row.id) || row.id,
      enabled: prev ? prev.enabled !== false : false,
      source: 'codex',
    })
  }
  policy = {
    ...policy,
    models: next,
    platform: 'openai',
    updated_at: new Date().toISOString(),
    source: 'codex',
  }
  await persist()
  return {
    ok: true,
    synced: live.length,
    added,
    ids: listGptPolicyModels().map((m) => m.id),
  }
}
