/**
 * Gemini / CRAGGemini routing, scheduling, concurrency, sharded daemon, and SHM config (SSOT).
 * Modeled after Anthropic pool/sticky/failover and OpenAI codex-route conventions.
 */

export const GEMINI_STRATEGIES = Object.freeze(['balanced', 'fill', 'round_robin'])

export const DEFAULT_GEMINI_ROUTING = Object.freeze({
  enabled: true,
  official_passthrough: true,
  protocols: Object.freeze({
    'google.gemini': Object.freeze({ mode: 'native', enabled: true }),
    'anthropic.messages': Object.freeze({ mode: 'convert', enabled: true }),
    'openai.chat': Object.freeze({ mode: 'convert', enabled: true }),
    'openai.responses': Object.freeze({ mode: 'convert', enabled: true }),
    'google.gemini.session': Object.freeze({ mode: 'native', enabled: true }),
  }),
  pool: Object.freeze({
    strategy: 'balanced',
    accounts_per_daemon: 50,
    daemon_fault_isolation: true,
    max_concurrency_per_account: 20,
    max_sessions_per_account: 20,
    min_warm_slots: 1,
    session_idle_ttl_secs: 600,
    max_queue: 32,
    queue_timeout_ms: 10_000,
    timeout_ms: 120_000,
    first_byte_timeout_ms: 90_000,
    idle_timeout_ms: 15_000,
    circuit_failure_threshold: 3,
    circuit_open_ms: 30_000,
    eligibility_probe_interval_secs: 180,
  }),
  sticky: Object.freeze({
    enabled: true,
    ttl_seconds: 3600,
  }),
  failover: Object.freeze({
    max_account_switches: 3,
    quota_cooldown_ms: 60_000,
    account_cooldown_ms: 300_000,
  }),
  shm: Object.freeze({
    require_shm: true,
    request_mb: 4,
    response_mb: 16,
  }),
})

const PROTOCOL_KEYS = Object.freeze(Object.keys(DEFAULT_GEMINI_ROUTING.protocols))

function typedError(message, code) {
  const error = new TypeError(message)
  error.code = code
  return error
}

function asObject(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
}

function clampInt(raw, min, max, fallback) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

function validateIntRange(obj, key, min, max, path, code) {
  if (!Object.hasOwn(obj, key) || obj[key] === undefined) return
  const val = obj[key]
  if (typeof val !== 'number' || !Number.isInteger(val) || val < min || val > max) {
    throw typedError(`${path}.${key} 必须是 ${min} 到 ${max} 之间的整数`, code)
  }
}

function validateBoolean(obj, key, path, code) {
  if (!Object.hasOwn(obj, key) || obj[key] === undefined) return
  if (typeof obj[key] !== 'boolean') {
    throw typedError(`${path}.${key} 必须是布尔值`, code)
  }
}

/** Strict validation for PUT /api/panel/routing when `body.gemini` is provided. */
export function validateGeminiRoutingPatch(body = {}) {
  if (!asObject(body) || !Object.hasOwn(body, 'gemini') || body.gemini === undefined) return
  const gem = asObject(body.gemini)
  if (!gem) throw typedError('gemini 必须是对象', 'invalid_gemini_routing')
  validateBoolean(gem, 'enabled', 'gemini', 'invalid_gemini_routing')
  validateBoolean(gem, 'official_passthrough', 'gemini', 'invalid_gemini_routing')

  if (Object.hasOwn(gem, 'protocols') && gem.protocols !== undefined) {
    const protocols = asObject(gem.protocols)
    if (!protocols) throw typedError('gemini.protocols 必须是对象', 'invalid_gemini_protocols')
    for (const [key, item] of Object.entries(protocols)) {
      if (!PROTOCOL_KEYS.includes(key)) {
        throw typedError(`gemini.protocols.${key} 不受支持`, 'invalid_gemini_protocols')
      }
      const entry = asObject(item)
      if (!entry) throw typedError(`gemini.protocols.${key} 必须是对象`, 'invalid_gemini_protocols')
      validateBoolean(entry, 'enabled', `gemini.protocols.${key}`, 'invalid_gemini_protocols')
      if (
        Object.hasOwn(entry, 'mode') &&
        entry.mode !== undefined &&
        !['native', 'convert', 'reject'].includes(entry.mode)
      ) {
        throw typedError(`gemini.protocols.${key}.mode 必须是 native、convert 或 reject`, 'invalid_gemini_protocols')
      }
    }
  }

  if (Object.hasOwn(gem, 'pool') && gem.pool !== undefined) {
    const pool = asObject(gem.pool)
    if (!pool) throw typedError('gemini.pool 必须是对象', 'invalid_gemini_pool')
    if (Object.hasOwn(pool, 'strategy') && pool.strategy !== undefined && !GEMINI_STRATEGIES.includes(pool.strategy)) {
      throw typedError('gemini.pool.strategy 必须是 balanced、fill 或 round_robin', 'invalid_gemini_pool')
    }
    validateIntRange(pool, 'accounts_per_daemon', 1, 256, 'gemini.pool', 'invalid_gemini_pool')
    validateBoolean(pool, 'daemon_fault_isolation', 'gemini.pool', 'invalid_gemini_pool')
    validateIntRange(pool, 'max_concurrency_per_account', 1, 64, 'gemini.pool', 'invalid_gemini_pool')
    validateIntRange(pool, 'max_sessions_per_account', 1, 64, 'gemini.pool', 'invalid_gemini_pool')
    validateIntRange(pool, 'min_warm_slots', 0, 16, 'gemini.pool', 'invalid_gemini_pool')
    if (
      Object.hasOwn(pool, 'min_warm_slots') &&
      Object.hasOwn(pool, 'max_concurrency_per_account') &&
      pool.min_warm_slots > pool.max_concurrency_per_account
    ) {
      throw typedError('gemini.pool.min_warm_slots 不能大于 max_concurrency_per_account', 'invalid_gemini_pool')
    }
    if (Object.hasOwn(pool, 'session_idle_ttl_secs') && pool.session_idle_ttl_secs !== undefined) {
      const ttl = pool.session_idle_ttl_secs
      if (typeof ttl !== 'number' || !Number.isInteger(ttl) || (ttl !== 0 && (ttl < 10 || ttl > 86_400))) {
        throw typedError('gemini.pool.session_idle_ttl_secs 必须是 0 或 10 到 86400 之间的整数', 'invalid_gemini_pool')
      }
    }
    if (Object.hasOwn(pool, 'eligibility_probe_interval_secs') && pool.eligibility_probe_interval_secs !== undefined) {
      const interval = pool.eligibility_probe_interval_secs
      if (
        typeof interval !== 'number' ||
        !Number.isInteger(interval) ||
        (interval !== 0 && (interval < 30 || interval > 3_600))
      ) {
        throw typedError(
          'gemini.pool.eligibility_probe_interval_secs 必须是 0 或 30 到 3600 之间的整数',
          'invalid_gemini_pool',
        )
      }
    }
    validateIntRange(pool, 'max_queue', 0, 64, 'gemini.pool', 'invalid_gemini_pool')
    validateIntRange(pool, 'queue_timeout_ms', 100, 600_000, 'gemini.pool', 'invalid_gemini_pool')
    validateIntRange(pool, 'timeout_ms', 100, 600_000, 'gemini.pool', 'invalid_gemini_pool')
    validateIntRange(pool, 'first_byte_timeout_ms', 100, 600_000, 'gemini.pool', 'invalid_gemini_pool')
    validateIntRange(pool, 'idle_timeout_ms', 100, 600_000, 'gemini.pool', 'invalid_gemini_pool')
    validateIntRange(pool, 'circuit_failure_threshold', 0, 20, 'gemini.pool', 'invalid_gemini_pool')
    validateIntRange(pool, 'circuit_open_ms', 1_000, 600_000, 'gemini.pool', 'invalid_gemini_pool')
  }

  if (Object.hasOwn(gem, 'sticky') && gem.sticky !== undefined) {
    const sticky = asObject(gem.sticky)
    if (!sticky) throw typedError('gemini.sticky 必须是对象', 'invalid_gemini_sticky')
    validateBoolean(sticky, 'enabled', 'gemini.sticky', 'invalid_gemini_sticky')
    validateIntRange(sticky, 'ttl_seconds', 0, 604_800, 'gemini.sticky', 'invalid_gemini_sticky')
  }

  if (Object.hasOwn(gem, 'failover') && gem.failover !== undefined) {
    const failover = asObject(gem.failover)
    if (!failover) throw typedError('gemini.failover 必须是对象', 'invalid_gemini_failover')
    validateIntRange(failover, 'max_account_switches', 0, 20, 'gemini.failover', 'invalid_gemini_failover')
    validateIntRange(failover, 'quota_cooldown_ms', 5_000, 3_600_000, 'gemini.failover', 'invalid_gemini_failover')
    validateIntRange(failover, 'account_cooldown_ms', 10_000, 3_600_000, 'gemini.failover', 'invalid_gemini_failover')
  }

  if (Object.hasOwn(gem, 'shm') && gem.shm !== undefined) {
    const shm = asObject(gem.shm)
    if (!shm) throw typedError('gemini.shm 必须是对象', 'invalid_gemini_shm')
    validateBoolean(shm, 'require_shm', 'gemini.shm', 'invalid_gemini_shm')
    validateIntRange(shm, 'request_mb', 1, 64, 'gemini.shm', 'invalid_gemini_shm')
    validateIntRange(shm, 'response_mb', 1, 64, 'gemini.shm', 'invalid_gemini_shm')
  }
}

export function mergeGeminiRouting(previous = {}, patch = {}) {
  const prev = normalizeGeminiRouting(previous)
  const src = asObject(patch) || {}
  const nextProtocols = { ...prev.protocols }
  if (asObject(src.protocols)) {
    for (const key of PROTOCOL_KEYS) {
      if (asObject(src.protocols[key])) {
        nextProtocols[key] = { ...nextProtocols[key], ...src.protocols[key] }
      }
    }
  }
  return normalizeGeminiRouting({
    ...prev,
    ...src,
    protocols: nextProtocols,
    pool: { ...prev.pool, ...(asObject(src.pool) || {}) },
    sticky: { ...prev.sticky, ...(asObject(src.sticky) || {}) },
    failover: { ...prev.failover, ...(asObject(src.failover) || {}) },
    shm: { ...prev.shm, ...(asObject(src.shm) || {}) },
  })
}

export function normalizeGeminiRouting(raw = {}) {
  const src = asObject(raw) || {}
  const rawProtocols = asObject(src.protocols) || {}
  const protocols = {}
  for (const key of PROTOCOL_KEYS) {
    const def = DEFAULT_GEMINI_ROUTING.protocols[key]
    const item = asObject(rawProtocols[key]) || {}
    const mode = ['native', 'convert', 'reject'].includes(item.mode) ? item.mode : def.mode
    const enabled = item.enabled !== undefined ? item.enabled !== false && mode !== 'reject' : def.enabled
    protocols[key] = { mode, enabled }
  }

  const rawPool = asObject(src.pool) || {}
  const defPool = DEFAULT_GEMINI_ROUTING.pool
  const maxConc = clampInt(rawPool.max_concurrency_per_account, 1, 64, defPool.max_concurrency_per_account)
  const maxSessions = clampInt(rawPool.max_sessions_per_account, 1, 64, defPool.max_sessions_per_account)
  const minWarm = Math.min(maxConc, clampInt(rawPool.min_warm_slots, 0, 16, defPool.min_warm_slots))
  const rawTtl = rawPool.session_idle_ttl_secs
  const idleTtl = rawTtl === 0 ? 0 : clampInt(rawTtl, 10, 86_400, defPool.session_idle_ttl_secs)
  const rawProbeInterval = rawPool.eligibility_probe_interval_secs
  const eligibilityProbeInterval =
    rawProbeInterval === 0 ? 0 : clampInt(rawProbeInterval, 30, 3_600, defPool.eligibility_probe_interval_secs)
  const pool = {
    strategy: GEMINI_STRATEGIES.includes(rawPool.strategy) ? rawPool.strategy : defPool.strategy,
    accounts_per_daemon: clampInt(rawPool.accounts_per_daemon, 1, 256, defPool.accounts_per_daemon),
    daemon_fault_isolation: rawPool.daemon_fault_isolation !== false,
    max_concurrency_per_account: maxConc,
    max_sessions_per_account: maxSessions,
    min_warm_slots: minWarm,
    session_idle_ttl_secs: idleTtl,
    max_queue: clampInt(rawPool.max_queue, 0, 64, defPool.max_queue),
    queue_timeout_ms: clampInt(rawPool.queue_timeout_ms, 100, 600_000, defPool.queue_timeout_ms),
    timeout_ms: clampInt(rawPool.timeout_ms, 100, 600_000, defPool.timeout_ms),
    first_byte_timeout_ms: clampInt(rawPool.first_byte_timeout_ms, 100, 600_000, defPool.first_byte_timeout_ms),
    idle_timeout_ms: clampInt(rawPool.idle_timeout_ms, 100, 600_000, defPool.idle_timeout_ms),
    circuit_failure_threshold: clampInt(rawPool.circuit_failure_threshold, 0, 20, defPool.circuit_failure_threshold),
    circuit_open_ms: clampInt(rawPool.circuit_open_ms, 1_000, 600_000, defPool.circuit_open_ms),
    eligibility_probe_interval_secs: eligibilityProbeInterval,
  }

  const rawSticky = asObject(src.sticky) || {}
  const defSticky = DEFAULT_GEMINI_ROUTING.sticky
  const sticky = {
    enabled: rawSticky.enabled !== false,
    ttl_seconds: clampInt(rawSticky.ttl_seconds, 0, 604_800, defSticky.ttl_seconds),
  }

  const rawFailover = asObject(src.failover) || {}
  const defFailover = DEFAULT_GEMINI_ROUTING.failover
  const failover = {
    max_account_switches: clampInt(rawFailover.max_account_switches, 0, 20, defFailover.max_account_switches),
    quota_cooldown_ms: clampInt(rawFailover.quota_cooldown_ms, 5_000, 3_600_000, defFailover.quota_cooldown_ms),
    account_cooldown_ms: clampInt(rawFailover.account_cooldown_ms, 10_000, 3_600_000, defFailover.account_cooldown_ms),
  }

  const rawShm = asObject(src.shm) || {}
  const defShm = DEFAULT_GEMINI_ROUTING.shm
  const shm = {
    require_shm: rawShm.require_shm !== false,
    request_mb: clampInt(rawShm.request_mb, 1, 64, defShm.request_mb),
    response_mb: clampInt(rawShm.response_mb, 1, 64, defShm.response_mb),
  }

  return {
    enabled: src.enabled !== false,
    official_passthrough: src.official_passthrough !== false,
    protocols,
    pool,
    sticky,
    failover,
    shm,
  }
}

export function isGeminiProtocolAllowed(protocol, routing = {}) {
  const gemini = normalizeGeminiRouting(routing?.gemini || routing)
  if (!gemini.enabled) {
    return { ok: false, status: 403, code: 'gemini_disabled', message: 'Gemini routing is disabled.' }
  }
  const entry = gemini.protocols[protocol]
  if (!entry || entry.enabled === false || entry.mode === 'reject') {
    return {
      ok: false,
      status: 403,
      code: 'gemini_protocol_disabled',
      message: `Gemini protocol entry '${protocol}' is disabled.`,
    }
  }
  return { ok: true, mode: entry.mode }
}
