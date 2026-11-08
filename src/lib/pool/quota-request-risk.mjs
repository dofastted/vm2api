/**
 * Best-effort size/cache risk for the 5h/7d critical band.
 *
 * Does not convert dollars to percent. Cache hits and final output cannot be
 * known before the hop. The number compared to the threshold is marginal
 * cache-miss input: the whole prompt when cold, or only the last user turn
 * when this account+session prefix is confirmed warm. max_tokens is an output
 * ceiling, not a cache write, and is not added (#385).
 */
import { peekCachePrefix } from '../protocol/cache-prefix.mjs'

/**
 * 100k cache-miss tokens: above a normal turn (usually <10k new tokens) and
 * below the #342 sample (514k cache-write). Do not add max_tokens. Claude Code
 * and the gateway default both use 128000, so the ceiling alone used to clear
 * this line and the critical band rejected every Opus request (#385). A cold
 * prompt under the threshold is still admitted; lower
 * large_cold_uncached_tokens to catch it instead of putting the ceiling back.
 */
export const DEFAULT_LARGE_COLD_UNCACHED_TOKENS = 100_000
/** Unknown images are treated as uncached vision tiles. */
const IMAGE_TOKENS = 1600
const IMAGE_TYPES = new Set(['image', 'input_image', 'image_url'])

export function largeColdThresholdOf(quota = {}) {
  const n = Number(quota?.large_cold_uncached_tokens)
  if (Number.isFinite(n) && n > 0) return Math.floor(n)
  return DEFAULT_LARGE_COLD_UNCACHED_TOKENS
}

export function guardLargeColdEnabled(quota = {}) {
  return quota?.guard_large_cold !== false
}

/** Test spy: cache misses are real body walks. Hits reuse WeakMap / quotaRequest. */
export const promptEstimateStats = { misses: 0, hits: 0 }

export function resetPromptEstimateStats() {
  promptEstimateStats.misses = 0
  promptEstimateStats.hits = 0
}

const promptTokenCache = new WeakMap()

/** CJK ≈ 1 token/char; other text chars/3 so the uncached estimate leans high. */
export function estimateTextTokens(text) {
  const s = String(text || '')
  if (!s) return 0
  let cjk = 0
  let other = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    if (cp > 0x2e80) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 3)
}

function estimateValue(value, depth = 0) {
  if (value == null || depth > 48) return 0
  const t = typeof value
  if (t === 'string') return estimateTextTokens(value)
  if (t === 'number' || t === 'boolean') return 1
  if (Array.isArray(value)) {
    let n = 0
    for (const item of value) n += estimateValue(item, depth + 1)
    return n
  }
  if (t !== 'object') return 0
  const kind = String(value.type || '')
  if (IMAGE_TYPES.has(kind) || value.image_url || value.source?.type === 'base64') return IMAGE_TOKENS
  let n = 0
  for (const [key, child] of Object.entries(value)) {
    if (key === 'cache_control') continue
    n += estimateValue(child, depth + 1)
  }
  return n
}

function lastUserMessage(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return messages[i]
  }
  return null
}

function cachedPromptParts(body, quotaRequest = null) {
  if (quotaRequest?._promptParts) {
    promptEstimateStats.hits += 1
    return quotaRequest._promptParts
  }
  if (!body || typeof body !== 'object') {
    const empty = { prompt: 0, lastUser: 0, maxOut: 0 }
    if (quotaRequest) quotaRequest._promptParts = empty
    return empty
  }
  let parts = promptTokenCache.get(body)
  if (parts) {
    promptEstimateStats.hits += 1
    if (quotaRequest) quotaRequest._promptParts = parts
    return parts
  }
  promptEstimateStats.misses += 1
  parts = {
    prompt: estimateValue(body.system) + estimateValue(body.messages) + estimateValue(body.tools),
    lastUser: estimateValue(lastUserMessage(body)),
    maxOut: Math.max(0, Math.floor(Number(body.max_tokens) || 0)),
  }
  promptTokenCache.set(body, parts)
  if (quotaRequest) quotaRequest._promptParts = parts
  return parts
}

export function estimatePromptTokens(body, quotaRequest = null) {
  return cachedPromptParts(body, quotaRequest).prompt
}

/**
 * First turn / prefix break / unconfirmed attempt / missing session → cold.
 * Warm only after a previous hop on this account+session was confirmed.
 */
export function cacheColdForAccount({
  accountId = null,
  sessionId = null,
  body = null,
  now = Date.now(),
  preserveMessageCache = null,
  ctx = null,
} = {}) {
  const account = String(accountId || '').trim()
  const session = String(sessionId || '').trim()
  if (!account || !session || !body) return { cold: true, reason: 'unknown', prefix: null }
  const prefix = peekCachePrefix(`${account}:${session}`, body, now, { preserveMessageCache, ctx })
  if (!prefix) return { cold: true, reason: 'unknown', prefix: null }
  if (prefix.turn <= 1) return { cold: true, reason: 'first_turn', prefix }
  if (!prefix.confirmed) return { cold: true, reason: 'unconfirmed', prefix }
  if (prefix.break) return { cold: true, reason: 'prefix_break', prefix }
  return { cold: false, reason: 'warm', prefix }
}

export function estimateRequestRisk(
  body,
  {
    accountId = null,
    sessionId = null,
    now = Date.now(),
    threshold = DEFAULT_LARGE_COLD_UNCACHED_TOKENS,
    quotaRequest = null,
  } = {},
) {
  const parts = cachedPromptParts(body, quotaRequest)
  const cache = cacheColdForAccount({
    accountId,
    sessionId,
    body,
    now,
    preserveMessageCache: quotaRequest?.preserveMessageCache,
    ctx: quotaRequest?.bodyCtx || null,
  })
  const uncached = cache.cold ? parts.prompt : parts.lastUser
  return {
    estimatedPromptTokens: parts.prompt,
    maxTokens: parts.maxOut,
    uncachedTokens: uncached,
    cold: cache.cold,
    coldReason: cache.reason,
    largeCold: cache.cold && uncached >= threshold,
    model: body?.model || null,
  }
}

export function resolveRequestRisk(opts = {}, accountId, quota = {}) {
  if (opts?.requestRisk && typeof opts.requestRisk === 'object') return opts.requestRisk
  const req = opts?.quotaRequest
  if (!req?.body) return null
  return estimateRequestRisk(req.body, {
    accountId,
    sessionId: req.sessionId,
    now: req.now,
    threshold: largeColdThresholdOf(quota),
    quotaRequest: req,
  })
}
