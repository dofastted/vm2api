/** Independent Antigravity account platform backed by the slot's authenticated runtime. */
// Official reasoning levels, lowest first. The account service exposes each level as its own
// upstream variant (`gemini-4-argon-high`) and expects the same `thinkingConfig.thinkingLevel`.
export const ANTIGRAVITY_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high'])
export const ANTIGRAVITY_DEFAULT_LEVEL = 'medium'
const VARIANT = new RegExp(`^(.+)-(${ANTIGRAVITY_LEVELS.join('|')})$`, 'i')
export const ANTIGRAVITY_CAPABILITIES = Object.freeze({
  experimental_text_session: true,
  streaming: true,
  system: true,
  images: true,
  client_tools: true,
  history_import: true,
  protocols: Object.freeze(['anthropic.messages', 'openai.chat', 'openai.responses', 'openai.completions']),
})

function objectOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function boundedInteger(value, fallback, min, max) {
  if (value == null || value === '') return fallback
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback
}

const MAX_TOKEN_LIMIT = 100_000_000

function tokenLimit(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 && number <= MAX_TOKEN_LIMIT ? number : null
}

export function antigravityModelId(value) {
  const id = String(value || '').trim()
  return /^[a-z0-9][a-z0-9._:-]{0,199}$/i.test(id) ? id : null
}

/** `gemini-4-argon-high` → base `gemini-4-argon`, level `high`; IDs without a level suffix are their own base. */
export function splitAntigravityVariant(value) {
  const id = antigravityModelId(value)
  if (!id) return null
  const match = id.match(VARIANT)
  return match ? { base: match[1], level: match[2].toLowerCase() } : { base: id, level: null }
}

export function antigravityVariantId(base, level) {
  return level ? `${base}-${level}` : base
}

function sortLevels(levels) {
  return ANTIGRAVITY_LEVELS.filter((level) => levels.has(level))
}

/**
 * Public catalog rows are base models with their available levels. Catalog rows stored by
 * earlier releases were one row per upstream variant; they fold into their base model and
 * keep only the variants the administrator left enabled.
 */
export function normalizeAntigravityModels(value) {
  const rows = new Map()
  for (const item of Array.isArray(value) ? value : []) {
    const row = typeof item === 'string' ? { id: item } : objectOf(item)
    const variant = splitAntigravityVariant(row.id)
    if (!variant) continue
    const key = variant.base.toLowerCase()
    const vendor = String(row.vendor || '')
      .trim()
      .toLowerCase()
    const display = String(row.display_name || '')
      .replace(/\s*\((?:minimal|low|medium|high)\)\s*$/i, '')
      .trim()
    const entry = rows.get(key) || {
      id: variant.base,
      display_name: display || variant.base,
      vendor: /^[a-z][a-z0-9-]{0,39}$/.test(vendor) ? vendor : null,
      enabled: false,
      all: new Set(),
      on: new Set(),
    }
    const levels = variant.level
      ? [variant.level]
      : Array.isArray(row.levels)
        ? row.levels.map((level) => String(level).toLowerCase()).filter((level) => ANTIGRAVITY_LEVELS.includes(level))
        : []
    for (const level of levels) {
      entry.all.add(level)
      if (row.enabled !== false) entry.on.add(level)
    }
    if (row.enabled !== false) entry.enabled = true
    entry.context_window ??= tokenLimit(row.context_window)
    entry.max_output_tokens ??= tokenLimit(row.max_output_tokens)
    rows.set(key, entry)
  }
  return [...rows.values()].map(({ all, on, context_window, max_output_tokens, ...entry }) => ({
    ...entry,
    levels: sortLevels(on.size ? on : all),
    ...(context_window ? { context_window } : {}),
    ...(max_output_tokens ? { max_output_tokens } : {}),
  }))
}

/**
 * Picks the upstream variant for a base model. No requested effort uses the default level,
 * or the nearest available one; an explicit level must exist for the model.
 */
export function resolveAntigravityVariant(entry, effort) {
  const levels = entry?.levels || []
  const requested = typeof effort === 'string' && effort.trim() ? effort.trim().toLowerCase() : null
  if (!levels.length) {
    if (requested)
      return { ok: false, message: `模型 ${entry.id} 不支持推理等级，请去掉 reasoning_effort / reasoning.effort。` }
    return { ok: true, level: null, upstream: entry.id }
  }
  if (requested) {
    if (!levels.includes(requested))
      return { ok: false, message: `模型 ${entry.id} 支持的推理等级：${levels.join(', ')}；收到 ${requested}。` }
    return { ok: true, level: requested, upstream: antigravityVariantId(entry.id, requested) }
  }
  const target = ANTIGRAVITY_LEVELS.indexOf(ANTIGRAVITY_DEFAULT_LEVEL)
  const level = [...levels].sort(
    (a, b) =>
      Math.abs(ANTIGRAVITY_LEVELS.indexOf(a) - target) - Math.abs(ANTIGRAVITY_LEVELS.indexOf(b) - target) ||
      ANTIGRAVITY_LEVELS.indexOf(a) - ANTIGRAVITY_LEVELS.indexOf(b),
  )[0]
  return { ok: true, level, upstream: antigravityVariantId(entry.id, level) }
}

/** Upstream variant IDs the slot runtime may call. */
export function antigravityUpstreamIds(models) {
  return models.flatMap((model) =>
    model.levels.length ? model.levels.map((level) => antigravityVariantId(model.id, level)) : [model.id],
  )
}

export function normalizeAntigravityRouting(raw = {}) {
  const src = objectOf(raw)
  const cli = typeof src.cli_bin === 'string' ? src.cli_bin.trim() : ''
  return {
    enabled: src.enabled === true,
    cli_bin: cli && !/[\0\r\n]/.test(cli) ? cli : 'agy',
    models: normalizeAntigravityModels(src.models),
    max_sessions: boundedInteger(src.max_sessions, 1, 1, 20),
    idle_ttl_seconds: boundedInteger(src.idle_ttl_seconds, 600, 1, 86400),
    timeout_ms: boundedInteger(src.timeout_ms, 180000, 1000, 3600000),
    queue_timeout_ms: boundedInteger(src.queue_timeout_ms, 120000, 1000, 300000),
    affinity_wait_ms: boundedInteger(src.affinity_wait_ms, 15000, 0, 120000),
  }
}

/** Per-slot in-flight cap: the global `max_sessions` unless an operator pinned this slot (never above it). */
export function antigravitySlotConcurrency(vm, config) {
  const policy = vm?.policy || {}
  const pinned = policy.concurrencyOverride === true ? Number(policy.maxConcurrency) : 0
  return Math.max(
    1,
    Math.min(config.max_sessions, Number.isInteger(pinned) && pinned > 0 ? pinned : config.max_sessions),
  )
}

/** Strict write validation; reads remain defensive for older config files. */
export function validateAntigravityRoutingPatch(body = {}) {
  if (!Object.prototype.hasOwnProperty.call(body || {}, 'antigravity')) return
  const raw = body.antigravity
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw Object.assign(new TypeError('antigravity 必须是对象'), { code: 'invalid_antigravity' })
  }
  if ('enabled' in raw && typeof raw.enabled !== 'boolean') {
    throw Object.assign(new TypeError('antigravity.enabled 必须是布尔'), { code: 'invalid_antigravity' })
  }
  if ('cli_bin' in raw && (typeof raw.cli_bin !== 'string' || !raw.cli_bin.trim() || /[\0\r\n]/.test(raw.cli_bin))) {
    throw Object.assign(new TypeError('antigravity.cli_bin 必须是可执行文件路径或名称'), {
      code: 'invalid_antigravity',
    })
  }
  for (const [field, min, max] of [
    ['max_sessions', 1, 20],
    ['idle_ttl_seconds', 1, 86400],
    ['timeout_ms', 1000, 3600000],
    ['queue_timeout_ms', 1000, 300000],
    ['affinity_wait_ms', 0, 120000],
  ]) {
    if (field in raw && (!Number.isInteger(raw[field]) || raw[field] < min || raw[field] > max)) {
      throw Object.assign(new TypeError(`antigravity.${field} 必须是 ${min} 到 ${max} 的整数`), {
        code: 'invalid_antigravity',
      })
    }
  }
  if ('models' in raw) {
    if (
      !Array.isArray(raw.models) ||
      raw.models.some((item) => {
        const row = typeof item === 'string' ? { id: item } : objectOf(item)
        return (
          !antigravityModelId(row.id) ||
          ('enabled' in row && typeof row.enabled !== 'boolean') ||
          ('levels' in row &&
            (!Array.isArray(row.levels) || row.levels.some((level) => !ANTIGRAVITY_LEVELS.includes(level)))) ||
          ['context_window', 'max_output_tokens'].some((field) => row[field] != null && tokenLimit(row[field]) == null)
        )
      })
    ) {
      throw Object.assign(
        new TypeError('antigravity.models 必须是有效的模型 ID 或模型对象数组（token 上限须为正整数）'),
        {
          code: 'invalid_antigravity',
        },
      )
    }
  }
}

export function listAntigravityPublicModels(routing = {}) {
  const config = normalizeAntigravityRouting(routing)
  if (!config.enabled) return []
  return config.models
    .filter((model) => model.enabled)
    .map((model) => {
      const variant = resolveAntigravityVariant(model, null)
      return {
        id: model.id,
        object: 'model',
        type: 'model',
        display_name: model.display_name,
        owned_by: model.vendor || 'antigravity',
        platform: 'antigravity',
        family: 'antigravity',
        vendor: model.vendor,
        reasoning_levels: model.levels,
        default_reasoning_level: variant.level,
        context_window: model.context_window ?? null,
        max_output_tokens: model.max_output_tokens ?? null,
        enabled: true,
        experimental: false,
        capabilities: ANTIGRAVITY_CAPABILITIES,
        source: 'antigravity-routing',
      }
    })
}
