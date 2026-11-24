/**
 * In-memory cache for official GET /api/oauth/usage hops.
 *
 * 3 min success TTL, 1 min error TTL,
 * per-account singleflight, 0–800ms jitter on miss.
 * force=true still honors the success TTL; it may replace a negative cache.
 */

import { isOfficialUsageRateLimited } from './crs-usage-probe.mjs'

export const API_CACHE_TTL_MS = 3 * 60_000
export const API_ERROR_CACHE_TTL_MS = 60_000
export const API_QUERY_MAX_JITTER_MS = 800

const USAGE_FETCH_META = Symbol('usage_fetch_meta')

export function attachUsageFetchMeta(result, meta) {
  if (!result || typeof result !== 'object' || !meta) return result
  const target = Object.isFrozen(result) ? { ...result } : result
  Object.defineProperty(target, USAGE_FETCH_META, {
    value: meta,
    enumerable: false,
    configurable: true,
  })
  return target
}

export function getUsageFetchMeta(result) {
  return result && typeof result === 'object' ? result[USAGE_FETCH_META] || null : null
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function asError(result) {
  const err = new Error(result?.error || result?.usage_error || 'usage_probe_failed')
  err.result = result
  err.rate_limited = isOfficialUsageRateLimited(result)
  return err
}

function isFailureResult(result) {
  if (!result || typeof result !== 'object') return true
  if (isOfficialUsageRateLimited(result)) return true
  if (result.ok === true) return false
  const status = Number(result.usage_status || result.status || 0)
  if (status > 0 && status < 400) return false
  return true
}

export function createUsageCache({ now = () => Date.now(), random = Math.random, jitter = true } = {}) {
  const store = new Map()
  const flights = new Map()
  const accountEpochs = new Map()
  let globalEpoch = 0
  const epochOf = (id) => globalEpoch + (accountEpochs.get(id) || 0)
  const startedAt = new Date(now()).toISOString()
  const metrics = {
    requests: 0,
    success_hits: 0,
    error_hits: 0,
    misses: 0,
    singleflight_joins: 0,
    upstream_fetches: 0,
    upstream_failures: 0,
  }

  const peek = (accountId) => {
    const id = String(accountId || '')
    if (!id) return null
    const entry = store.get(id)
    if (!entry) return null
    const age = now() - entry.at
    if (entry.kind === 'ok' && age < API_CACHE_TTL_MS) {
      return { hit: 'ok', result: entry.result, age }
    }
    if (entry.kind === 'error' && age < API_ERROR_CACHE_TTL_MS) {
      return { hit: 'error', result: entry.result, error: entry.error, age }
    }
    return null
  }

  const rememberOk = (id, result) => {
    store.set(id, { kind: 'ok', result, error: null, at: now() })
  }

  const rememberError = (id, error, result = null) => {
    store.set(id, { kind: 'error', result, error, at: now() })
  }

  const load = async (accountId, fetcher, { force = false, skipJitter = false } = {}) => {
    const id = String(accountId || '')
    if (!id) return fetcher()

    metrics.requests += 1
    const cached = peek(id)
    if (cached?.hit === 'ok') {
      metrics.success_hits += 1
      return cached.result
    }
    if (cached?.hit === 'error' && !force) {
      metrics.error_hits += 1
      if (cached.result != null) return cached.result
      throw cached.error
    }

    if (flights.has(id)) {
      metrics.singleflight_joins += 1
      return flights.get(id)
    }

    metrics.misses += 1
    const flightEpoch = epochOf(id)
    const pending = (async () => {
      const again = peek(id)
      if (again?.hit === 'ok') return again.result
      if (again?.hit === 'error' && !force) {
        if (again.result != null) return again.result
        throw again.error
      }
      if (jitter && !skipJitter) {
        const delay = Math.floor(Number(random()) * API_QUERY_MAX_JITTER_MS)
        if (delay > 0) await sleep(delay)
      }
      metrics.upstream_fetches += 1
      const fetchStartedAt = now()
      try {
        const raw = await fetcher()
        const result = getUsageFetchMeta(raw) ? raw : attachUsageFetchMeta(raw, { startedAt: fetchStartedAt })
        if (isFailureResult(result)) {
          metrics.upstream_failures += 1
          if (epochOf(id) === flightEpoch) rememberError(id, asError(result), result)
          return result
        }
        if (epochOf(id) === flightEpoch) rememberOk(id, result)
        return result
      } catch (error) {
        metrics.upstream_failures += 1
        if (epochOf(id) === flightEpoch) rememberError(id, error, error?.result || null)
        throw error
      }
    })().finally(() => {
      if (flights.get(id) === pending) flights.delete(id)
    })

    flights.set(id, pending)
    return pending
  }

  return {
    peek,
    load,
    clear(accountId) {
      if (accountId == null) {
        globalEpoch += 1
        store.clear()
        flights.clear()
      } else {
        const id = String(accountId)
        accountEpochs.set(id, (accountEpochs.get(id) || 0) + 1)
        store.delete(id)
        flights.delete(id)
      }
    },
    size() {
      return store.size
    },
    stats() {
      const observedAt = now()
      let entriesFresh = 0
      let entriesStale = 0
      for (const entry of store.values()) {
        const ttl = entry.kind === 'ok' ? API_CACHE_TTL_MS : API_ERROR_CACHE_TTL_MS
        if (observedAt - entry.at < ttl) entriesFresh += 1
        else entriesStale += 1
      }
      const directHits = metrics.success_hits + metrics.error_hits
      return {
        since: startedAt,
        entries_total: store.size,
        entries_fresh: entriesFresh,
        entries_stale: entriesStale,
        inflight: flights.size,
        ...metrics,
        hit_rate: metrics.requests > 0 ? directHits / metrics.requests : null,
        reuse_rate: metrics.requests > 0 ? (directHits + metrics.singleflight_joins) / metrics.requests : null,
        success_ttl_ms: API_CACHE_TTL_MS,
        error_ttl_ms: API_ERROR_CACHE_TTL_MS,
      }
    },
  }
}

let shared = null

export function getUsageCache() {
  if (!shared) shared = createUsageCache()
  return shared
}

export function resetUsageCache(next = null) {
  shared = next
  return shared
}
