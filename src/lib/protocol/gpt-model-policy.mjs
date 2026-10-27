/**
 * GPT catalog. Separate settings key from Claude model_policy.
 * Live ids from ChatGPT sync; seed is empty-catalog fallback.
 */
import { RuntimeSettings as SettingsRepo } from '../db/settings-state.mjs'
import { getDb } from '../db/database.mjs'
import { SettingsRepo as PersistentSettingsRepo } from '../db/repos/settings-repo.mjs'
import { isGptSeriesId, isSyncableGptCatalogId } from './gpt-ids.mjs'
import { IMAGE_TOOL_MODELS, canonicalImageToolModel } from './image-tool-models.mjs'

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

/** Known image model ids only; `enabled` must be a boolean. Unlisted ids keep `base`. */
function normalizeImageTools(raw, base = null) {
  const out = {}
  for (const model of IMAGE_TOOL_MODELS) {
    out[model.id] = { enabled: base?.[model.id]?.enabled !== false }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, row] of Object.entries(raw)) {
    const canonical = canonicalImageToolModel(id)
    if (canonical && typeof row?.enabled === 'boolean') out[canonical] = { enabled: row.enabled }
  }
  return out
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
    image_tools: normalizeImageTools(null),
  }
}

let policy = seedGptPolicy()
let loaded = false

async function persist(next = policy) {
  const db = getDb()
  await new PersistentSettingsRepo(db).set(SETTINGS_KEY, next)
  db.afterCommit(() => {
    policy = next
    loaded = true
  })
}

function normalizeGptPolicy(stored) {
  if (!stored || typeof stored !== 'object' || !stored.models || typeof stored.models !== 'object') return null
  const live = stored.source === 'codex' && Object.keys(stored.models).length
  const seed = seedGptPolicy()
  const normalized = {
    ...(live ? stored : { ...seed, ...stored, models: { ...seed.models, ...stored.models } }),
    platform: 'openai',
  }
  normalized.image_tools = normalizeImageTools(stored.image_tools)
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
      // Catalog facts come from the upstream sync only; a stale panel draft must not overwrite them.
      const { catalog: _drop, ...edits } = row
      const catalog = policy.models?.[id]?.catalog
      models[id] = { ...models[id], ...edits, id, family: 'codex' }
      if (catalog) models[id].catalog = catalog
    }
  }
  const currentImageTools = policy.image_tools
  const saved = {
    ...seed,
    ...next,
    models,
    image_tools: normalizeImageTools(next?.image_tools, currentImageTools),
    platform: 'openai',
    updated_at: new Date().toISOString(),
    source: 'panel',
  }
  await persist(saved)
  return saved
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

/** false = known and disabled; null = not a gateway image model (the upstream decides). */
export function isImageToolModelEnabled(id) {
  const canonical = canonicalImageToolModel(id)
  if (!canonical) return null
  if (!loaded) loadGptModelPolicy()
  return policy.image_tools?.[canonical]?.enabled !== false
}

export function listImageToolModels() {
  if (!loaded) loadGptModelPolicy()
  return IMAGE_TOOL_MODELS.map((model) => ({
    id: model.id,
    display_name: model.display_name,
    snapshots: [...model.snapshots],
    upstream_default: model.upstream_default,
    sort: model.sort,
    enabled: policy.image_tools?.[model.id]?.enabled !== false,
  }))
}

export async function resetGptModelPolicy() {
  const saved = seedGptPolicy()
  await persist(saved)
  return saved
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
      catalog: typeof item === 'object' && item?.catalog && typeof item.catalog === 'object' ? item.catalog : null,
    })
  }
  if (!live.length) {
    return { ok: true, synced: 0, added: [], ids: listGptPolicyModels().map((m) => m.id) }
  }
  const db = getDb()
  const added = []
  const saved = await new PersistentSettingsRepo(db).update(SETTINGS_KEY, (current) => {
    const previous = normalizeGptPolicy(current) || seedGptPolicy()
    const models = {}
    for (const row of live) {
      const prev = previous.models[row.id]
      if (!prev) added.push(row.id)
      models[row.id] = entry(row.id, {
        ...prev,
        display_name: row.display_name || prev?.display_name || displayNameOf?.(row.id) || row.id,
        enabled: prev ? prev.enabled !== false : false,
        source: 'codex',
      })
      const catalog = row.catalog ? { ...row.catalog, synced_at: new Date().toISOString() } : prev?.catalog
      if (catalog) models[row.id].catalog = catalog
    }
    return { ...previous, models, platform: 'openai', updated_at: new Date().toISOString(), source: 'codex' }
  })
  db.afterCommit(() => {
    policy = saved
    loaded = true
  })
  return {
    ok: true,
    synced: live.length,
    added,
    ids: Object.values(saved.models)
      .filter((row) => row.enabled !== false)
      .map((row) => row.id),
  }
}
