/**
 * Three-layer price catalog: override > models.dev > builtin.
 * ID matching is exact / alias / Claude date-strip — no fuzzy family regex.
 */
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { BUILTIN_ALIASES, BUILTIN_RATES, BUILTIN_SOURCE } from './builtin-rates.mjs'

export const PRICE_FIELDS = ['input', 'output', 'cache_read', 'cache_5m', 'cache_1h']
export const MODE_NAMES = ['fast', 'flex', 'priority']
export const MODELS_DEV_URL = 'https://models.dev/api.json'
export const MODELS_DEV_TIMEOUT_MS = 30_000
export const MODELS_DEV_MAX_BYTES = 64 * 1024 * 1024
export const MODELS_DEV_STALE_MS = 6 * 60 * 60 * 1000

const SETTINGS_SNAPSHOT = 'price_catalog_modelsdev'
const SETTINGS_OVERRIDES = 'model_price_overrides'
const OVERRIDE_KEY_RE = /^(anthropic|openai|\*)\/([a-z0-9._-]+|\*)$/
const CLAUDE_DATE_RE = /-\d{8}$/
const CLAUDE_LATEST_RE = /-latest$/
const FAMILY_IDS = new Set(['fable', 'mythos', 'opus', 'sonnet', 'haiku'])
const EPS = 1e-9

const EMPTY_STATUS = { fetched_at: null, status: 'never', error: null, models: 0 }

let injectedSettings = null
let injectedFetch = null
let backgroundRefresh = true
let catalogMemo = null
let refreshInflight = null

export function setPriceCatalogTestHooks(hooks = null) {
  if (!hooks) {
    injectedSettings = null
    injectedFetch = null
    backgroundRefresh = true
  } else {
    if ('settings' in hooks) injectedSettings = hooks.settings
    if ('fetchImpl' in hooks) injectedFetch = hooks.fetchImpl
    if ('backgroundRefresh' in hooks) backgroundRefresh = hooks.backgroundRefresh
  }
  invalidatePriceCatalog()
}

export function invalidatePriceCatalog() {
  catalogMemo = null
}

function settingsRepo() {
  if (injectedSettings) return injectedSettings
  try {
    return new SettingsRepo()
  } catch {
    return {
      get(_key, fallback = null) {
        return fallback
      },
      set(_key, value) {
        return value
      },
    }
  }
}

function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v))
}

function isRate(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

function stripDecorations(raw) {
  const s =
    String(raw || '')
      .split('/')
      .filter(Boolean)
      .pop() || ''
  return s
    .replace(/\[[^\]]*\]$/g, '')
    .replace(/-fast$/i, '')
    .trim()
    .toLowerCase()
}

export function platformOfModel(raw) {
  const id = stripDecorations(raw)
  if (!id) return null
  if (FAMILY_IDS.has(id) || id.startsWith('claude-')) return 'anthropic'
  if (BUILTIN_RATES.anthropic[id]) return 'anthropic'
  const aliased = BUILTIN_ALIASES[id]
  if (aliased && BUILTIN_RATES.anthropic[aliased]) return 'anthropic'
  if (BUILTIN_RATES.openai[id]) return 'openai'
  if (aliased && BUILTIN_RATES.openai[aliased]) return 'openai'
  if (/^(gpt-|o[1-9]|chatgpt|codex-|chat-latest$)/.test(id)) return 'openai'
  return null
}

function addCandidate(out, id) {
  if (id && !out.includes(id)) out.push(id)
}

function expandClaude(out, id) {
  const dashed = id.replaceAll('.', '-')
  addCandidate(out, dashed)
  addCandidate(out, id.replace(CLAUDE_DATE_RE, '').replace(CLAUDE_LATEST_RE, ''))
  addCandidate(out, dashed.replace(CLAUDE_DATE_RE, '').replace(CLAUDE_LATEST_RE, ''))
}

export function catalogIdCandidates(raw, platform = null) {
  const id = stripDecorations(raw)
  if (!id) return []
  const plat = platform || platformOfModel(id)
  const out = []
  addCandidate(out, id)
  if (plat !== 'openai') expandClaude(out, id)
  const extras = []
  for (const c of out) {
    const alias = BUILTIN_ALIASES[c]
    if (alias) extras.push(alias)
  }
  for (const alias of extras) {
    addCandidate(out, alias)
    if (plat !== 'openai') expandClaude(out, alias)
    const nested = BUILTIN_ALIASES[alias]
    if (nested) addCandidate(out, nested)
  }
  return out
}

function fillLeaf(price, platform, parent = null) {
  const input = isRate(price.input) ? price.input : parent?.input
  const output = isRate(price.output) ? price.output : parent?.output
  const cache_read = isRate(price.cache_read) ? price.cache_read : parent?.cache_read
  const out = { input, output, cache_read }
  if (platform === 'anthropic') {
    out.cache_5m = isRate(price.cache_5m) ? price.cache_5m : out.input * 1.25
    out.cache_1h = isRate(price.cache_1h) ? price.cache_1h : out.input * 2
  } else {
    out.cache_5m = isRate(price.cache_5m) ? price.cache_5m : 0
    out.cache_1h = isRate(price.cache_1h) ? price.cache_1h : out.cache_5m
  }
  return out
}

function fillPrice(price, platform) {
  const base = fillLeaf(price, platform)
  if (Array.isArray(price.tiers) && price.tiers.length) {
    base.tiers = price.tiers
      .map((t) => {
        if (!t || typeof t !== 'object') return null
        if (t.unpriced) return { above: t.above, unpriced: true }
        return { above: t.above, ...fillLeaf(t, platform, base) }
      })
      .filter((t) => t && Number.isFinite(t.above) && t.above > 0)
      .sort((a, b) => a.above - b.above)
    if (!base.tiers.length) delete base.tiers
  }
  if (price.modes && typeof price.modes === 'object') {
    const modes = {}
    for (const m of MODE_NAMES) {
      if (price.modes[m] && typeof price.modes[m] === 'object') {
        modes[m] = fillPrice(price.modes[m], platform)
      }
    }
    if (Object.keys(modes).length) base.modes = modes
  }
  if (price.per_call && typeof price.per_call === 'object' && isRate(price.per_call.web_search)) {
    base.per_call = { web_search: price.per_call.web_search }
  }
  if (price.image && ['input', 'output', 'cache_read'].every((f) => isRate(price.image[f]))) {
    base.image = { input: price.image.input, output: price.image.output, cache_read: price.image.cache_read }
  }
  return base
}

export function validatePrice(price, { platform } = {}) {
  if (!price || typeof price !== 'object' || Array.isArray(price)) {
    return { ok: false, error: 'price must be an object' }
  }
  for (const f of ['input', 'output', 'cache_read']) {
    if (!isRate(price[f])) return { ok: false, error: `missing or invalid ${f}` }
  }
  for (const f of ['cache_5m', 'cache_1h']) {
    if (price[f] != null && !isRate(price[f])) return { ok: false, error: `invalid ${f}` }
  }
  if (price.tiers != null) {
    if (!Array.isArray(price.tiers)) return { ok: false, error: 'tiers must be an array' }
    for (let i = 0; i < price.tiers.length; i++) {
      const t = price.tiers[i]
      if (!t || typeof t !== 'object') return { ok: false, error: `invalid tier ${i + 1}` }
      if (!Number.isFinite(t.above) || t.above <= 0) return { ok: false, error: `invalid tier ${i + 1} above` }
      if (t.unpriced === true) continue
      const inner = validatePrice(t, { platform })
      if (!inner.ok) return { ok: false, error: `tier ${i + 1}: ${inner.error}` }
    }
  }
  if (price.modes != null) {
    if (typeof price.modes !== 'object' || Array.isArray(price.modes)) {
      return { ok: false, error: 'modes must be an object' }
    }
    for (const m of MODE_NAMES) {
      if (price.modes[m] == null) continue
      const inner = validatePrice(price.modes[m], { platform })
      if (!inner.ok) return { ok: false, error: `modes.${m}: ${inner.error}` }
    }
  }
  if (price.image != null) {
    if (typeof price.image !== 'object' || Array.isArray(price.image)) {
      return { ok: false, error: 'image must be an object' }
    }
    for (const f of ['input', 'output', 'cache_read']) {
      if (!isRate(price.image[f])) return { ok: false, error: `missing or invalid image.${f}` }
    }
  }
  if (price.per_call != null) {
    if (typeof price.per_call !== 'object' || Array.isArray(price.per_call)) {
      return { ok: false, error: 'per_call must be an object' }
    }
    if (price.per_call.web_search != null && !isRate(price.per_call.web_search)) {
      return { ok: false, error: 'invalid per_call.web_search' }
    }
  }
  return { ok: true, price: fillPrice(price, platform) }
}

function overridePlatform(key) {
  const plat = String(key || '').split('/')[0]
  return plat === 'anthropic' || plat === 'openai' ? plat : null
}

function mapModelsDevTier(t) {
  if (!t || typeof t !== 'object') return null
  let above = t.above
  if (t.tier && typeof t.tier === 'object') {
    if (t.tier.type && t.tier.type !== 'context') return null
    if (Number.isFinite(t.tier.size)) above = t.tier.size
  }
  if (!Number.isFinite(above) || above <= 0) return null
  if (t.unpriced) return { above, unpriced: true }
  const row = { above }
  for (const f of ['input', 'output', 'cache_read']) {
    if (t[f] != null) row[f] = t[f]
  }
  if (t.cache_5m != null) row.cache_5m = t.cache_5m
  else if (t.cache_write != null) row.cache_5m = t.cache_write
  if (t.cache_1h != null) row.cache_1h = t.cache_1h
  return row
}

function parseModelsDevCost(cost, platform) {
  if (!cost || typeof cost !== 'object') return null
  if (!isRate(cost.input) || !isRate(cost.output)) return null
  const raw = {
    input: cost.input,
    output: cost.output,
    cache_read: isRate(cost.cache_read) ? cost.cache_read : 0,
  }
  if (isRate(cost.cache_5m)) raw.cache_5m = cost.cache_5m
  else if (isRate(cost.cache_write)) raw.cache_5m = cost.cache_write
  if (isRate(cost.cache_1h)) raw.cache_1h = cost.cache_1h
  if (Array.isArray(cost.tiers)) {
    const tiers = cost.tiers.map(mapModelsDevTier).filter(Boolean)
    if (tiers.length) raw.tiers = tiers
  }
  const v = validatePrice(raw, { platform })
  return v.ok ? v.price : null
}

export function parseModelsDev(json) {
  const out = { anthropic: {}, openai: {} }
  if (!json || typeof json !== 'object') return out
  for (const platform of ['anthropic', 'openai']) {
    const models = json[platform]?.models
    if (!models || typeof models !== 'object') continue
    for (const [id, row] of Object.entries(models)) {
      if (!id || !row || typeof row !== 'object') continue
      const price = parseModelsDevCost(row.cost, platform)
      const context = Number(row.limit?.context)
      out[platform][id] = {
        name: typeof row.name === 'string' ? row.name : null,
        context: Number.isFinite(context) && context > 0 ? context : null,
        price,
      }
    }
  }
  return out
}

const LIMIT_VENDORS = [
  ['gemini-', 'google'],
  ['claude-', 'anthropic'],
  ['gpt-', 'openai'],
]

function modeOf(values) {
  const counts = new Map()
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1)
  let best = null
  for (const [v, n] of counts)
    if (best == null || n > counts.get(best) || (n === counts.get(best) && v > best)) best = v
  return best
}

/**
 * Context/output limits for vendor model IDs that Antigravity can serve. The vendor's own
 * provider wins; otherwise the value most resellers agree on (e.g. gpt-oss-120b).
 */
export function parseModelLimits(json) {
  const rows = new Map()
  if (!json || typeof json !== 'object') return {}
  for (const [provider, entry] of Object.entries(json)) {
    const models = entry?.models
    if (!models || typeof models !== 'object') continue
    for (const [rawId, row] of Object.entries(models)) {
      const id = String(rawId).split('/').pop().toLowerCase()
      const vendor = LIMIT_VENDORS.find(([prefix]) => id.startsWith(prefix))?.[1]
      const context = Number(row?.limit?.context)
      const output = Number(row?.limit?.output)
      if (!vendor || !(context > 0) || !(output > 0)) continue
      const list = rows.get(id) || []
      list.push({ firstParty: provider === vendor && rawId === id, context, output })
      rows.set(id, list)
    }
  }
  const out = {}
  for (const [id, list] of rows) {
    const own = list.find((item) => item.firstParty)
    out[id] = own
      ? { context: own.context, output: own.output }
      : { context: modeOf(list.map((item) => item.context)), output: modeOf(list.map((item) => item.output)) }
  }
  return out
}

function countSnapshotModels(snap) {
  let n = 0
  for (const platform of ['anthropic', 'openai']) {
    const dict = snap?.[platform]
    if (!dict) continue
    n += Object.keys(dict).length
  }
  return n
}

function readSnapshot() {
  const raw = settingsRepo().get(SETTINGS_SNAPSHOT, null)
  if (!raw || typeof raw !== 'object') return null
  return raw
}

function readOverrides() {
  const raw = settingsRepo().get(SETTINGS_OVERRIDES, null)
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
}

function persistOverrides(next) {
  settingsRepo().set(SETTINGS_OVERRIDES, next)
}

function persistSnapshot(next) {
  settingsRepo().set(SETTINGS_SNAPSHOT, next)
}

function statusOf(snap) {
  if (!snap || typeof snap !== 'object') return { ...EMPTY_STATUS }
  return {
    fetched_at: snap.fetched_at || null,
    status: snap.status || (snap.fetched_at ? 'ok' : 'never'),
    error: snap.error ?? null,
    models: countSnapshotModels(snap),
  }
}

export function getModelsDevStatus() {
  return statusOf(readSnapshot())
}

async function readCappedBody(res, maxBytes) {
  const len = Number(res.headers?.get?.('content-length'))
  if (Number.isFinite(len) && len > maxBytes) throw new Error('models.dev response exceeds 64 MiB')
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader()
    const chunks = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        try {
          await reader.cancel()
        } catch {}
        throw new Error('models.dev response exceeds 64 MiB')
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
  }
  const text = await res.text()
  if (Buffer.byteLength(text) > maxBytes) throw new Error('models.dev response exceeds 64 MiB')
  return text
}

export async function syncModelsDev({ fetchImpl } = {}) {
  const prev = readSnapshot() || {}
  const fetchFn = fetchImpl || injectedFetch || globalThis.fetch
  try {
    if (typeof fetchFn !== 'function') throw new Error('fetch is not available')
    const res = await fetchFn(MODELS_DEV_URL, { signal: AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS) })
    if (!res || res.ok === false) throw new Error(`models.dev HTTP ${res?.status || 0}`)
    const text = await readCappedBody(res, MODELS_DEV_MAX_BYTES)
    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw new Error('models.dev invalid JSON')
    }
    const parsed = parseModelsDev(json)
    const snap = {
      fetched_at: new Date().toISOString(),
      status: 'ok',
      error: null,
      anthropic: parsed.anthropic,
      openai: parsed.openai,
      limits: parseModelLimits(json),
    }
    persistSnapshot(snap)
    invalidatePriceCatalog()
    return statusOf(snap)
  } catch (e) {
    const snap = {
      fetched_at: prev.fetched_at || null,
      status: 'error',
      error: String(e?.message || e),
      anthropic: prev.anthropic || {},
      openai: prev.openai || {},
      limits: prev.limits || {},
    }
    persistSnapshot(snap)
    invalidatePriceCatalog()
    return statusOf(snap)
  }
}

function canPersist() {
  if (injectedSettings) return true
  try {
    new SettingsRepo()
    return true
  } catch {
    return false
  }
}

export function maybeRefreshModelsDev({ now } = {}) {
  if (!backgroundRefresh) return
  if (!canPersist()) return
  if (refreshInflight) return
  const snap = readSnapshot()
  const fetchedAt = snap?.fetched_at ? Date.parse(snap.fetched_at) : 0
  const t = now ?? Date.now()
  if (fetchedAt && Number.isFinite(fetchedAt) && t - fetchedAt < MODELS_DEV_STALE_MS) return
  refreshInflight = Promise.resolve()
    .then(() => syncModelsDev())
    .catch(() => {})
    .finally(() => {
      refreshInflight = null
    })
}

function storedPrice(entry, platform) {
  if (!entry || typeof entry !== 'object') return null
  const { updated_at: _updated, ...rest } = entry
  const v = validatePrice(rest, { platform })
  return v.ok ? v.price : null
}

function fillGaps(base, builtin, source) {
  const price = clone(base)
  const mode_sources = {}
  if (price.per_call == null && builtin?.per_call) price.per_call = clone(builtin.per_call)
  if (price.image == null && builtin?.image) price.image = clone(builtin.image)
  if (price.tiers == null && builtin?.tiers) price.tiers = clone(builtin.tiers)
  for (const m of MODE_NAMES) {
    if (price.modes?.[m]) mode_sources[m] = source
    else if (builtin?.modes?.[m]) {
      price.modes = { ...price.modes, [m]: clone(builtin.modes[m]) }
      mode_sources[m] = 'builtin'
    }
  }
  return { price, mode_sources }
}

function pickOverride(platform, id, overrides) {
  const keys = [`${platform}/${id}`, `${platform}/*`, `*/${id}`]
  for (const key of keys) {
    const raw = overrides[key]
    const plat = overridePlatform(key) || platform
    const price = storedPrice(raw, plat)
    if (price) return { key, raw, price }
  }
  return null
}

function resolveLayers(platform, id, catalog) {
  if (!platform || !id) return null
  const ov = pickOverride(platform, id, catalog.overrides)
  const md = catalog.snap?.[platform]?.[id]
  const builtin = BUILTIN_RATES[platform]?.[id] || null
  let base = null
  let source = null
  let version = null
  if (ov) {
    base = ov.price
    source = 'override'
    version = ov.raw.updated_at || null
  } else if (md?.price) {
    base = md.price
    source = 'models.dev'
    version = catalog.snap.fetched_at || null
  } else if (builtin) {
    base = builtin
    source = 'builtin'
    version = BUILTIN_SOURCE
  }
  if (!base) return null
  const filled = fillGaps(base, builtin, source)
  return {
    id,
    platform,
    price: filled.price,
    source,
    version,
    mode_sources: filled.mode_sources,
  }
}

function pricesDiffer(a, b) {
  if (!a || !b) return false
  for (const f of PRICE_FIELDS) {
    if (Math.abs((a[f] ?? 0) - (b[f] ?? 0)) > EPS) return true
  }
  const ta = a.tiers || []
  const tb = b.tiers || []
  if (ta.length !== tb.length) return true
  for (let i = 0; i < ta.length; i++) {
    if (ta[i].above !== tb[i].above) return true
    if (!!ta[i].unpriced !== !!tb[i].unpriced) return true
    if (ta[i].unpriced) continue
    if (Math.abs((ta[i].input ?? 0) - (tb[i].input ?? 0)) > EPS) return true
    if (Math.abs((ta[i].output ?? 0) - (tb[i].output ?? 0)) > EPS) return true
  }
  return false
}

function makeEntry(platform, id, catalog) {
  const resolved = resolveLayers(platform, id, catalog)
  const builtin = BUILTIN_RATES[platform]?.[id] || null
  const md = catalog.snap?.[platform]?.[id] || null
  const ov = pickOverride(platform, id, catalog.overrides)
  return {
    platform,
    id,
    name: md?.name ?? null,
    context: md?.context ?? null,
    effective: resolved ? clone(resolved.price) : null,
    source: resolved?.source ?? null,
    version: resolved?.version ?? null,
    mode_sources: resolved?.mode_sources ?? {},
    builtin: builtin ? clone(builtin) : null,
    models_dev: md?.price ? clone(md.price) : null,
    override: ov ? clone(ov.raw) : null,
    override_key: ov?.key ?? null,
    diff: pricesDiffer(builtin, md?.price),
    in_policy: false,
  }
}

function loadCatalog() {
  if (catalogMemo) return catalogMemo
  const overrides = readOverrides()
  const snap = readSnapshot() || {}
  const seen = new Set()
  const entries = []
  const add = (platform, id) => {
    if (!platform || !id || id === '*') return
    const key = `${platform}/${id}`
    if (seen.has(key)) return
    seen.add(key)
    entries.push(makeEntry(platform, id, { overrides, snap }))
  }
  for (const platform of ['anthropic', 'openai']) {
    for (const id of Object.keys(BUILTIN_RATES[platform] || {})) add(platform, id)
    for (const id of Object.keys(snap[platform] || {})) add(platform, id)
  }
  for (const key of Object.keys(overrides)) {
    const m = OVERRIDE_KEY_RE.exec(key)
    if (!m) continue
    const platform = m[1]
    const id = m[2]
    if (platform === '*' || id === '*') continue
    add(platform, id)
  }
  entries.sort((a, b) => a.platform.localeCompare(b.platform) || a.id.localeCompare(b.id))
  catalogMemo = { entries, overrides, snap }
  return catalogMemo
}

function hasExactLayer(platform, id, catalog) {
  return !!(
    catalog.overrides[`${platform}/${id}`] ||
    catalog.overrides[`*/${id}`] ||
    catalog.snap?.[platform]?.[id] ||
    BUILTIN_RATES[platform]?.[id]
  )
}

export function resolvePrice(rawModel) {
  // Antigravity subscriptions are a distinct billing platform. A model vendor
  // name must not inherit the vendor's direct API price or wildcard overrides.
  if (/^antigravity\//i.test(String(rawModel || '').trim())) return null
  const platform = platformOfModel(rawModel)
  const candidates = catalogIdCandidates(rawModel, platform)
  const catalog = loadCatalog()
  const plats = platform ? [platform] : ['anthropic', 'openai']
  // Settle the canonical id before layering, so a `provider/*` override cannot bind to a
  // dated alias and lose the canonical model's builtin modes / tiers. An exact override on
  // any candidate wins first: pricing `claude-haiku-4-5` must also price its dated snapshot.
  const hasOverride = (p, c) => !!(catalog.overrides[`${p}/${c}`] || catalog.overrides[`*/${c}`])
  for (const p of plats) {
    const id = candidates.find((c) => hasOverride(p, c)) || candidates.find((c) => hasExactLayer(p, c, catalog))
    if (id) return resolveLayers(p, id, catalog)
  }
  for (const p of plats) {
    const got = candidates.length ? resolveLayers(p, candidates[0], catalog) : null
    if (got) return got
  }
  maybeRefreshModelsDev()
  return null
}

export function listPriceCatalog() {
  return loadCatalog().entries
}

export function listPriceOverrides() {
  return clone(readOverrides())
}

export function setPriceOverride(key, price) {
  const k = String(key || '').trim()
  if (!OVERRIDE_KEY_RE.test(k) || k === '*/*') {
    return { ok: false, error: 'invalid override key' }
  }
  const overrides = { ...readOverrides() }
  if (price == null) {
    delete overrides[k]
    persistOverrides(overrides)
    invalidatePriceCatalog()
    return { ok: true }
  }
  const plat = overridePlatform(k) || platformOfModel(k.split('/')[1])
  const v = validatePrice(price, { platform: plat })
  if (!v.ok) return { ok: false, error: v.error }
  overrides[k] = { ...v.price, updated_at: new Date().toISOString() }
  persistOverrides(overrides)
  invalidatePriceCatalog()
  return { ok: true }
}

export function modelsDevMeta(platform, id) {
  const row = readSnapshot()?.[platform]?.[id]
  if (!row) return null
  return { name: row.name ?? null, context: row.context ?? null }
}

/** models.dev context/output limits for a vendor model ID; null when unknown or unreadable. */
export function modelsDevLimits(id) {
  try {
    const row = readSnapshot()?.limits?.[String(id || '').toLowerCase()]
    return row ? { context: row.context, output: row.output } : null
  } catch {
    return null
  }
}
