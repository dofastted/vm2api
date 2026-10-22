/**
 * Official request cost from the three-layer price catalog.
 * Usage reaching this module is treated as DISJOINT after normalizeUsage:
 * input_tokens excludes cache read/write.
 */
import { extractOpenaiUsage, isOpenaiWireUsage } from '../protocol/openai-usage.mjs'
import { resolvePrice } from './price-catalog.mjs'

export const PRICING_CURRENCY = 'USD'
export const UNPRICED_MODEL = 'unpriced'

/** Response `usage.speed` is authoritative; request `speed` is the fallback. */
export function billedSpeed(usage = {}) {
  const raw = usage?.speed ?? usage?.requested_speed
  return String(raw ?? '')
    .trim()
    .toLowerCase() === 'fast'
    ? 'fast'
    : 'standard'
}

/** Request/response `service_tier` → billing band. Unknown tiers stay unpriced. */
export function normalizeOpenaiServiceTier(raw) {
  const t = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (!t || t === 'default' || t === 'standard' || t === 'auto') return 'standard'
  if (t === 'flex') return 'flex'
  if (t === 'fast' || t === 'priority') return 'fast'
  return null
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

function n(v) {
  const x = Number(v)
  return Number.isFinite(x) && x > 0 ? x : 0
}

function webSearchRequestsOf(usage) {
  const v = usage?.server_tool_use?.web_search_requests ?? usage?.web_search_requests ?? 0
  const x = Number(v)
  return Number.isFinite(x) && x > 0 ? x : 0
}

/**
 * DISJOINT usage, idempotent. OpenAI wire shape (inclusive input) is converted
 * to Anthropic cache names so a second pass is a no-op.
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
  const web_search_requests = webSearchRequestsOf(usage)
  if (isOpenaiWireUsage(usage)) {
    const read = n(cacheRead)
    const write = n(cacheCreate)
    const inp = n(input)
    return {
      ...usage,
      input_tokens: Math.max(inp - read - write, 0),
      output_tokens: output,
      cache_read_tokens: read,
      cache_read_input_tokens: read,
      cache_creation_tokens: write,
      cache_creation_input_tokens: write,
      web_search_requests,
    }
  }
  return {
    ...usage,
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? cacheRead,
    cache_creation_tokens: cacheCreate,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? cacheCreate,
    web_search_requests,
  }
}

function usd(tokens, perMTok) {
  if (!tokens || !perMTok) return 0
  return (tokens / 1_000_000) * perMTok
}

function round8(v) {
  return Math.round((Number(v) || 0) * 1e8) / 1e8
}

function cacheSplit(u) {
  let cache5m = n(u.cache_creation_5m_tokens ?? u.cache_creation?.ephemeral_5m_input_tokens)
  let cache1h = n(u.cache_creation_1h_tokens ?? u.cache_creation?.ephemeral_1h_input_tokens)
  const cacheCreate = n(u.cache_creation_tokens ?? u.cache_creation_input_tokens)
  if (!cache5m && !cache1h && cacheCreate) {
    // Explicit TTL only — never DEFAULT_CACHE_TTL (which is 1h for upstream).
    if (u.cache_ttl === '1h') cache1h = cacheCreate
    else cache5m = cacheCreate
  }
  return { cache5m, cache1h, cacheCreate }
}

function emptyCost(extra = {}) {
  return {
    price_source: extra.price_source ?? null,
    price_version: extra.price_version ?? null,
    currency: PRICING_CURRENCY,
    known: false,
    rates: null,
    mode: extra.mode ?? 'standard',
    long_context: extra.long_context ?? false,
    input_cost: 0,
    output_cost: 0,
    cache_read_cost: 0,
    cache_creation_cost: 0,
    cache_creation_5m_cost: 0,
    cache_creation_1h_cost: 0,
    web_search_cost: 0,
    total_cost: 0,
    ...extra,
  }
}

function openaiBillingMode(usage) {
  const tier = normalizeOpenaiServiceTier(usage.service_tier)
  if (!tier) return { tier: null, mode: null }
  if (tier === 'flex') return { tier, mode: 'flex' }
  if (tier === 'fast') return { tier, mode: 'priority' }
  return { tier, mode: 'standard' }
}

function selectBand(price, mode, prompt) {
  let band = price
  let selectedMode = 'standard'
  if (mode && mode !== 'standard') {
    if (!price.modes?.[mode]) return { unpriced: true, mode, long_context: false }
    band = price.modes[mode]
    selectedMode = mode
  }
  let long_context = false
  if (Array.isArray(band.tiers) && band.tiers.length) {
    let chosen = null
    for (const t of band.tiers) {
      if (prompt > t.above) chosen = t
    }
    if (chosen) {
      long_context = true
      if (chosen.unpriced) return { unpriced: true, mode: selectedMode, long_context }
      band = chosen
    }
  }
  return { rates: band, mode: selectedMode, long_context, unpriced: false }
}

/**
 * Official standard cost for one request's usage object.
 * After normalizeUsage, input_tokens is the uncached bucket for every vendor.
 */
export function calculateCost(usage = {}, model = null) {
  const u = normalizeUsage(usage)
  const mid = model || u.model || u.upstream_model || u.requested_model || ''
  const resolved = resolvePrice(mid)
  const outputTokens = n(u.output_tokens)
  const cacheRead = n(u.cache_read_tokens)
  const { cache5m, cache1h } = cacheSplit(u)
  const inputTokens = n(u.input_tokens)
  const webSearchRequests = n(u.web_search_requests)
  const tokens = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheRead,
    cache_creation_5m_tokens: cache5m,
    cache_creation_1h_tokens: cache1h,
    web_search_requests: webSearchRequests,
  }

  if (!resolved) {
    return emptyCost({
      model: mid || null,
      pricing_key: null,
      ...tokens,
    })
  }

  const { platform, price, source, version, id } = resolved
  let mode = 'standard'
  let service_tier = null
  if (platform === 'openai') {
    const billed = openaiBillingMode(u)
    service_tier = billed.tier
    if (!billed.mode) {
      return emptyCost({
        model: mid || null,
        pricing_key: id,
        price_source: source,
        price_version: version,
        service_tier: null,
        ...tokens,
      })
    }
    mode = billed.mode
  } else if (billedSpeed(u) === 'fast' && price.modes?.fast) {
    mode = 'fast'
  }

  const prompt = inputTokens + cacheRead + cache5m + cache1h
  const selected = selectBand(price, mode, prompt)
  if (selected.unpriced) {
    return emptyCost({
      model: mid || null,
      pricing_key: id,
      price_source: source,
      price_version: version,
      mode: selected.mode,
      service_tier,
      speed: selected.mode === 'fast' ? 'fast' : platform === 'anthropic' ? 'standard' : billedSpeed(u),
      long_context: selected.long_context,
      ...tokens,
    })
  }

  const rates = selected.rates
  const input_cost = usd(inputTokens, rates.input)
  const output_cost = usd(outputTokens, rates.output)
  const cache_read_cost = usd(cacheRead, rates.cache_read)
  const cache_creation_5m_cost = usd(cache5m, rates.cache_5m)
  const cache_creation_1h_cost = usd(cache1h, rates.cache_1h)
  const cache_creation_cost = cache_creation_5m_cost + cache_creation_1h_cost
  const web_search_cost = webSearchRequests * (price.per_call?.web_search || 0)
  const total_cost = input_cost + output_cost + cache_read_cost + cache_creation_cost + web_search_cost
  const speed = selected.mode === 'fast' ? 'fast' : 'standard'

  return {
    model: mid || null,
    pricing_key: id,
    price_source: source,
    price_version: version,
    currency: PRICING_CURRENCY,
    known: true,
    rates,
    mode: selected.mode,
    service_tier,
    speed,
    long_context: selected.long_context,
    ...tokens,
    input_cost: round8(input_cost),
    output_cost: round8(output_cost),
    cache_read_cost: round8(cache_read_cost),
    cache_creation_cost: round8(cache_creation_cost),
    cache_creation_5m_cost: round8(cache_creation_5m_cost),
    cache_creation_1h_cost: round8(cache_creation_1h_cost),
    web_search_cost: round8(web_search_cost),
    total_cost: round8(total_cost),
  }
}

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

// Both GPT Image 2.5 variants share one price; an omitted model is priced with it.
const IMAGE_DEFAULT_PRICE_ID = 'gpt-image-2.5-flare'

function tokenCount(v) {
  return Number.isSafeInteger(v) && v >= 0 ? v : null
}

/**
 * Image generation usage (`tool_usage.image_gen`, or an Images response `usage`), priced like
 * codex-proxy-rs `image_calculated_cost`: text input at the base rates, image input and output
 * at `price.image`. A split that does not add up stays unpriced; nothing is guessed.
 */
export function imageCostFromUsage(usage, imageModel = null) {
  const unknown = {
    known: false,
    image_cost: null,
    image_input_tokens: tokenCount(usage?.input_tokens) ?? 0,
    image_output_tokens: tokenCount(usage?.output_tokens) ?? 0,
    pricing_key: null,
    price_source: null,
    price_version: null,
  }
  if (!usage || typeof usage !== 'object') return unknown
  const resolved = resolvePrice(imageModel || IMAGE_DEFAULT_PRICE_ID)
  const rates = resolved?.price
  if (!rates?.image) return unknown
  const input = tokenCount(usage.input_tokens)
  const output = tokenCount(usage.output_tokens)
  const text = tokenCount(usage.input_tokens_details?.text_tokens)
  const image = tokenCount(usage.input_tokens_details?.image_tokens)
  const cached =
    usage.input_tokens_details?.cached_tokens == null ? 0 : tokenCount(usage.input_tokens_details.cached_tokens)
  if (input == null || output == null || text == null || image == null || cached == null) return unknown
  if (text + image !== input || cached > input) return unknown
  if (usage.total_tokens != null && usage.total_tokens !== input + output) return unknown
  // The model only outputs images; any other output modality cannot use the image rate.
  const outDetails = usage.output_tokens_details
  if (outDetails != null && (outDetails.image_tokens !== output || outDetails.text_tokens !== 0)) return unknown
  // A cached total alone cannot be split across mixed text and image input.
  let cachedText = 0
  let cachedImage = 0
  if (cached) {
    if (image === 0) cachedText = cached
    else if (text === 0) cachedImage = cached
    else if (cached === input) {
      cachedText = text
      cachedImage = image
    } else return unknown
  }
  const cost =
    usd(text - cachedText, rates.input) +
    usd(cachedText, rates.cache_read) +
    usd(image - cachedImage, rates.image.input) +
    usd(cachedImage, rates.image.cache_read) +
    usd(output, rates.image.output)
  return {
    known: true,
    image_cost: round8(cost),
    image_input_tokens: input,
    image_output_tokens: output,
    pricing_key: resolved.id,
    price_source: resolved.source,
    price_version: resolved.version,
  }
}

/**
 * `image` = `{ usage, model, only }`: image generation usage on the same row. `only` marks an
 * Images endpoint row, which has no text-model usage. Either part unpriced → the whole row is.
 */
export function costColumnsFromUsage(usage, model, image = null) {
  const img = image ? imageCostFromUsage(image.usage, image.model) : null
  const band = billingBandFromUsage(normalizeUsage(usage))
  if (image?.only) {
    const known = img.known
    return {
      input_cost: known ? 0 : null,
      output_cost: known ? 0 : null,
      cache_read_cost: known ? 0 : null,
      cache_creation_cost: known ? 0 : null,
      web_search_cost: known ? 0 : null,
      image_cost: known ? img.image_cost : null,
      total_cost: known ? img.image_cost : null,
      pricing_model: known ? img.pricing_key : UNPRICED_MODEL,
      price_source: known ? img.price_source : null,
      price_version: known ? img.price_version : null,
      ...band,
      long_context: known ? 0 : null,
    }
  }
  const c = calculateCost(usage, model)
  const known = c.known && (!img || img.known)
  return {
    input_cost: known ? c.input_cost : null,
    output_cost: known ? c.output_cost : null,
    cache_read_cost: known ? c.cache_read_cost : null,
    cache_creation_cost: known ? c.cache_creation_cost : null,
    web_search_cost: known ? c.web_search_cost : null,
    image_cost: known && img ? img.image_cost : null,
    total_cost: known ? round8(c.total_cost + (img?.image_cost || 0)) : null,
    pricing_model: known ? c.pricing_key : UNPRICED_MODEL,
    price_source: known ? c.price_source : null,
    price_version: known ? c.price_version : null,
    ...band,
    long_context: known ? (c.long_context ? 1 : 0) : null,
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
