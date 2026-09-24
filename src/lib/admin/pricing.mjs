/**
 * Official Anthropic Messages API list prices (USD).
 * Source: https://docs.anthropic.com/en/docs/about-claude/pricing (2026-08)
 *
 * KIN is an OAuth proxy — this is the official standard cost of the tokens
 * that went through the gateway, not Claude Code included-quota or extra-usage.
 */
import { normalizeCacheTtl } from '../protocol/cache-ttl.mjs'
import { extractOpenaiUsage } from '../protocol/openai-usage.mjs'
import { OPENAI_PRICING_SOURCE, resolveOpenaiOfficialRates, selectOpenaiRates } from './openai-pricing.mjs'

export const PRICING_SOURCE = 'anthropic-official-2026-08'
export const PRICING_CURRENCY = 'USD'

/** USD per million tokens. Cache write 5m = 1.25× input, 1h = 2×, read = 0.1×. */
export const OFFICIAL_RATES = {
  'fable-5': { input: 10, output: 50, cache_5m: 12.5, cache_1h: 20, cache_read: 1 },
  'mythos-5': { input: 10, output: 50, cache_5m: 12.5, cache_1h: 20, cache_read: 1 },
  'opus-5': { input: 5, output: 25, cache_5m: 6.25, cache_1h: 10, cache_read: 0.5 },
  // 2.1.280 tier_4_20_cache_read_0_20. Write stays 1.25× / 2×; read is the published $0.20, not 0.1×.
  'opus-5.5': { input: 4, output: 20, cache_5m: 5, cache_1h: 8, cache_read: 0.2 },
  'opus-4.5': { input: 5, output: 25, cache_5m: 6.25, cache_1h: 10, cache_read: 0.5 },
  'opus-4': { input: 15, output: 75, cache_5m: 18.75, cache_1h: 30, cache_read: 1.5 },
  'sonnet-5': { input: 2, output: 10, cache_5m: 2.5, cache_1h: 4, cache_read: 0.2 },
  'sonnet-4.6': { input: 3, output: 15, cache_5m: 3.75, cache_1h: 6, cache_read: 0.3 },
  'sonnet-4': { input: 3, output: 15, cache_5m: 3.75, cache_1h: 6, cache_read: 0.3 },
  'haiku-4.5': { input: 1, output: 5, cache_5m: 1.25, cache_1h: 2, cache_read: 0.1 },
  'haiku-3.5': { input: 0.8, output: 4, cache_5m: 1, cache_1h: 1.6, cache_read: 0.08 },
}

/**
 * Long-context premium: only Sonnet 4 / 4.5 (1M beta). Claude 4.6+ bill the full 1M
 * window at standard rates. Above 200K prompt tokens (input + cache read + cache write)
 * the whole request switches: input/cache 2×, output 1.5×.
 */
export const ANTHROPIC_LONG_CONTEXT_THRESHOLD = 200_000
export const LONG_CONTEXT_RATES = {
  'sonnet-4': { input: 6, output: 22.5, cache_5m: 7.5, cache_1h: 12, cache_read: 0.6 },
}

/**
 * Fast mode (research preview, Claude API only): Opus 5.5 $8/$40, Opus 5 / 4.8 $10/$50.
 * Applies across the full context; cache multipliers stack on the fast input price
 * (5m 1.25×, 1h 2×, read 0.1× — Opus 5.5 read 0.05×).
 */
export const FAST_MODE_RATES = {
  'opus-5.5': { input: 8, output: 40, cache_5m: 10, cache_1h: 16, cache_read: 0.4 },
  'opus-5': { input: 10, output: 50, cache_5m: 12.5, cache_1h: 20, cache_read: 1 },
  'opus-4.8': { input: 10, output: 50, cache_5m: 12.5, cache_1h: 20, cache_read: 1 },
}

/** Fast-mode pricing row for a model, or null when the model has no fast mode (4.6 runs standard, 4.7 errors). */
export function resolveFastModeKey(raw) {
  const key = resolvePricingKey(raw)
  if (key === 'opus-5.5' || key === 'opus-5') return key
  if (key === 'opus-4.5' && /opus-4[-.]8(?![0-9])/.test(normalizeModelId(raw))) return 'opus-4.8'
  return null
}

/** Response `usage.speed` is authoritative; request `speed` is the fallback. */
export function billedSpeed(usage = {}) {
  const raw = usage?.speed ?? usage?.requested_speed
  return String(raw ?? '')
    .trim()
    .toLowerCase() === 'fast'
    ? 'fast'
    : 'standard'
}

const FAMILY_ALIASES = {
  fable: 'fable-5',
  mythos: 'mythos-5',
  opus: 'opus-5',
  sonnet: 'sonnet-4',
  haiku: 'haiku-4.5',
}

export function shanghaiDay(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

/** Shanghai calendar-day start as UTC ISO (for request_logs.ts). */
export function shanghaiDayStartIso(d = new Date()) {
  return new Date(`${shanghaiDay(d)}T00:00:00+08:00`).toISOString()
}

export function normalizeModelId(raw) {
  const s =
    String(raw || '')
      .split('/')
      .filter(Boolean)
      .pop() || ''
  return s
    .replace(/\[[^\]]+\]$/g, '')
    .replace(/-fast$/i, '')
    .trim()
    .toLowerCase()
}

export function resolvePricingKey(raw) {
  const m = normalizeModelId(raw)
  if (!m) return null
  if (FAMILY_ALIASES[m]) return FAMILY_ALIASES[m]
  if (/fable/.test(m)) return 'fable-5'
  if (/mythos/.test(m)) return 'mythos-5'
  if (/haiku-3-5|haiku-3\.5/.test(m)) return 'haiku-3.5'
  if (/haiku/.test(m)) return 'haiku-4.5'
  if (/sonnet-5/.test(m)) return 'sonnet-5'
  if (/sonnet-4[-.][6-9]/.test(m)) return 'sonnet-4.6'
  if (/sonnet/.test(m)) return 'sonnet-4'
  if (/opus-5(?:[-.]5)(?:-|$)/.test(m)) return 'opus-5.5'
  if (/opus-5/.test(m)) return 'opus-5'
  if (/opus-4-[5-9]|opus-4\.[5-9]/.test(m)) return 'opus-4.5'
  if (/opus/.test(m)) return 'opus-4'
  return null
}

export function resolveOfficialRates(raw) {
  const key = resolvePricingKey(raw)
  const rates = key ? OFFICIAL_RATES[key] : null
  return {
    key,
    rates: rates ? { ...rates } : null,
    source: PRICING_SOURCE,
    known: !!rates,
  }
}

function n(v) {
  const x = Number(v)
  return Number.isFinite(x) && x > 0 ? x : 0
}

/**
 * Accept Anthropic usage plus OpenAI-shaped aliases
 * (prompt_tokens / completion_tokens / prompt_tokens_details).
 * Does not invent zeros — missing fields stay undefined.
 */
export function normalizeUsage(usage = {}) {
  if (!usage || typeof usage !== 'object') return {}
  const extracted = extractOpenaiUsage(usage)
  const details = usage.input_tokens_details || usage.prompt_tokens_details || {}
  const input = usage.input_tokens ?? usage.tokens_in ?? usage.prompt_tokens ?? extracted?.input_tokens
  const output = usage.output_tokens ?? usage.tokens_out ?? usage.completion_tokens ?? extracted?.output_tokens
  const cacheRead =
    usage.cache_read_tokens ?? usage.cache_read_input_tokens ?? details.cached_tokens ?? extracted?.cached_tokens
  const cacheCreate =
    usage.cache_creation_tokens ??
    usage.cache_creation_input_tokens ??
    details.cache_creation_tokens ??
    details.cache_write_tokens ??
    extracted?.cache_write_tokens
  return {
    ...usage,
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? cacheRead,
    cache_creation_tokens: cacheCreate,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? cacheCreate,
  }
}

function usd(tokens, perMTok) {
  if (!tokens || !perMTok) return 0
  return (tokens / 1_000_000) * perMTok
}

function round8(v) {
  return Math.round((Number(v) || 0) * 1e8) / 1e8
}

/**
 * Official standard cost for one request's usage object.
 * Anthropic `input_tokens` is the uncached bucket.
 * OpenAI Responses `input_tokens` includes cache; uncached = input - cached - billed cache-write.
 */
export function calculateCost(usage = {}, model = null) {
  const u = normalizeUsage(usage)
  const mid = model || u.model || u.upstream_model || u.requested_model || ''
  const openai = resolveOpenaiOfficialRates(mid)
  const anthropic = resolveOfficialRates(mid)
  const resolved = openai.known ? openai : anthropic
  let rates = resolved.rates
  const outputTokens = n(u.output_tokens)
  const cacheRead = n(u.cache_read_tokens)
  let cache5m = n(u.cache_creation_5m_tokens ?? u.cache_creation?.ephemeral_5m_input_tokens)
  let cache1h = n(u.cache_creation_1h_tokens ?? u.cache_creation?.ephemeral_1h_input_tokens)
  const cacheCreate = n(u.cache_creation_tokens)
  const inputTokens = n(u.input_tokens)

  if (openai.known) {
    const selected = selectOpenaiRates(resolved.key, { serviceTier: u.service_tier, inputTokens })
    if (cacheRead + cacheCreate > inputTokens || !selected) {
      return emptyCost({
        model: mid || null,
        pricing_key: null,
        pricing_source: OPENAI_PRICING_SOURCE,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheRead,
        cache_creation_5m_tokens: cacheCreate,
        cache_creation_1h_tokens: 0,
      })
    }
    rates = selected.rates
    const billedRead = rates.cache_read ? cacheRead : 0
    const billedWrite = rates.cache_write ? cacheCreate : 0
    const uncached = inputTokens - billedRead - billedWrite
    const input_cost = usd(uncached, rates.input)
    const output_cost = usd(outputTokens, rates.output)
    const cache_read_cost = usd(billedRead, rates.cache_read)
    const cache_creation_cost = usd(billedWrite, rates.cache_write)
    const total_cost = input_cost + output_cost + cache_read_cost + cache_creation_cost
    return {
      model: mid || null,
      pricing_key: resolved.key,
      pricing_source: OPENAI_PRICING_SOURCE,
      currency: PRICING_CURRENCY,
      known: true,
      rates,
      service_tier: selected.service_tier,
      long_context: selected.long_context,
      input_tokens: uncached,
      output_tokens: outputTokens,
      cache_read_tokens: billedRead,
      cache_creation_5m_tokens: billedWrite,
      cache_creation_1h_tokens: 0,
      input_cost: round8(input_cost),
      output_cost: round8(output_cost),
      cache_read_cost: round8(cache_read_cost),
      cache_creation_cost: round8(cache_creation_cost),
      cache_creation_5m_cost: round8(cache_creation_cost),
      cache_creation_1h_cost: 0,
      total_cost: round8(total_cost),
    }
  }

  if (!cache5m && !cache1h && cacheCreate) {
    if (normalizeCacheTtl(u.cache_ttl) === '1h') cache1h = cacheCreate
    else cache5m = cacheCreate
  } else if (normalizeCacheTtl(u.cache_ttl) === '1h' && cache5m && !cache1h) {
    cache1h = cache5m
    cache5m = 0
  }

  if (!rates) {
    return emptyCost({
      model: mid || null,
      pricing_key: null,
      known: false,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheRead,
      cache_creation_5m_tokens: cache5m,
      cache_creation_1h_tokens: cache1h,
    })
  }

  const fastKey = billedSpeed(u) === 'fast' ? resolveFastModeKey(mid) : null
  const promptTokens = inputTokens + cacheRead + cache5m + cache1h
  const longContext = !fastKey && !!LONG_CONTEXT_RATES[resolved.key] && promptTokens > ANTHROPIC_LONG_CONTEXT_THRESHOLD
  if (fastKey) rates = { ...FAST_MODE_RATES[fastKey] }
  else if (longContext) rates = { ...LONG_CONTEXT_RATES[resolved.key] }

  const input_cost = usd(inputTokens, rates.input)
  const output_cost = usd(outputTokens, rates.output)
  const cache_read_cost = usd(cacheRead, rates.cache_read)
  const cache_creation_5m_cost = usd(cache5m, rates.cache_5m)
  const cache_creation_1h_cost = usd(cache1h, rates.cache_1h)
  const cache_creation_cost = cache_creation_5m_cost + cache_creation_1h_cost
  const total_cost = input_cost + output_cost + cache_read_cost + cache_creation_cost

  return {
    model: mid || null,
    pricing_key: resolved.key,
    pricing_source: PRICING_SOURCE,
    currency: PRICING_CURRENCY,
    known: true,
    rates,
    speed: fastKey ? 'fast' : 'standard',
    long_context: longContext,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheRead,
    cache_creation_5m_tokens: cache5m,
    cache_creation_1h_tokens: cache1h,
    input_cost: round8(input_cost),
    output_cost: round8(output_cost),
    cache_read_cost: round8(cache_read_cost),
    cache_creation_cost: round8(cache_creation_cost),
    cache_creation_5m_cost: round8(cache_creation_5m_cost),
    cache_creation_1h_cost: round8(cache_creation_1h_cost),
    total_cost: round8(total_cost),
  }
}

function emptyCost(extra = {}) {
  return {
    pricing_source: PRICING_SOURCE,
    currency: PRICING_CURRENCY,
    known: false,
    rates: null,
    input_cost: 0,
    output_cost: 0,
    cache_read_cost: 0,
    cache_creation_cost: 0,
    cache_creation_5m_cost: 0,
    cache_creation_1h_cost: 0,
    total_cost: 0,
    ...extra,
  }
}

export const UNPRICED_MODEL = 'unpriced'

/** Raw billing band inputs, persisted so a later backfill re-prices with the same band. */
export function billingBandFromUsage(usage = {}) {
  const tier = String(usage?.service_tier ?? '')
    .trim()
    .toLowerCase()
  const speed = String(usage?.speed ?? usage?.requested_speed ?? '')
    .trim()
    .toLowerCase()
  return { service_tier: tier || null, speed: speed || null }
}

export function costColumnsFromUsage(usage, model) {
  const c = calculateCost(usage, model)
  return {
    input_cost: c.known ? c.input_cost : null,
    output_cost: c.known ? c.output_cost : null,
    cache_read_cost: c.known ? c.cache_read_cost : null,
    cache_creation_cost: c.known ? c.cache_creation_cost : null,
    total_cost: c.known ? c.total_cost : null,
    // 'unpriced' marks a deliberate no-estimate so backfill never guesses a price for it.
    pricing_model: c.known ? c.pricing_key : UNPRICED_MODEL,
    ...billingBandFromUsage(normalizeUsage(usage)),
    long_context: c.known ? (c.long_context ? 1 : 0) : null,
  }
}

export function emptyCostBucket() {
  return {
    requests: 0,
    success: 0,
    errors: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    input_cost: 0,
    output_cost: 0,
    cache_read_cost: 0,
    cache_creation_cost: 0,
    total_cost: 0,
  }
}

export function sumCostBuckets(rows = []) {
  const out = emptyCostBucket()
  for (const r of rows) {
    out.requests += n(r.requests)
    out.success += n(r.success)
    out.errors += n(r.errors)
    out.input_tokens += n(r.input_tokens)
    out.output_tokens += n(r.output_tokens)
    out.cache_read_tokens += n(r.cache_read_tokens)
    out.cache_creation_tokens += n(r.cache_creation_tokens)
    out.input_cost = round8(out.input_cost + n(r.input_cost))
    out.output_cost = round8(out.output_cost + n(r.output_cost))
    out.cache_read_cost = round8(out.cache_read_cost + n(r.cache_read_cost))
    out.cache_creation_cost = round8(out.cache_creation_cost + n(r.cache_creation_cost))
    out.total_cost = round8(out.total_cost + n(r.total_cost))
  }
  return out
}
