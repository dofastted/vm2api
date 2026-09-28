/**
 * Official OpenAI API list prices (USD / 1M tokens), standard tier.
 * Source: https://developers.openai.com/api/docs/pricing
 * Verified 2026-09-28 against the official pricing page and codex-proxy-rs.
 * cache_write is 1.25× input when the official table publishes a cache-write column.
 */
export const OPENAI_PRICING_SOURCE = 'openai-official-2026-09'

/** USD per million tokens. cache_write 0 = not billed. */
export const OPENAI_OFFICIAL_RATES = {
  'gpt-6-astra': { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
  'gpt-6-sol': { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  'gpt-6-luna': { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 },
  'gpt-5.6-sol': { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 },
  'gpt-5.6-terra': { input: 2, output: 12, cache_read: 0.2, cache_write: 2.5 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2, cache_read: 0.02, cache_write: 0.25 },
  'gpt-5.6': { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 },
  'gpt-5.5-pro': { input: 30, output: 180, cache_read: 0, cache_write: 0 },
  'gpt-5.5': { input: 5, output: 30, cache_read: 0.5, cache_write: 0 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, cache_read: 0.075, cache_write: 0 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25, cache_read: 0.02, cache_write: 0 },
  'gpt-5.4-pro': { input: 30, output: 180, cache_read: 0, cache_write: 0 },
  'gpt-5.4': { input: 2.5, output: 15, cache_read: 0.25, cache_write: 0 },
  'gpt-5.3-codex': { input: 1.75, output: 14, cache_read: 0.175, cache_write: 0 },
  'gpt-5.2-pro': { input: 21, output: 168, cache_read: 0, cache_write: 0 },
  'gpt-5.2': { input: 1.75, output: 14, cache_read: 0.175, cache_write: 0 },
  'gpt-5.1': { input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 },
  'gpt-5-mini': { input: 0.25, output: 2, cache_read: 0.025, cache_write: 0 },
  'gpt-5-nano': { input: 0.05, output: 0.4, cache_read: 0.005, cache_write: 0 },
  'gpt-5-pro': { input: 15, output: 120, cache_read: 0, cache_write: 0 },
  'gpt-5': { input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cache_read: 0.1, cache_write: 0 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4, cache_read: 0.025, cache_write: 0 },
  'gpt-4.1': { input: 2, output: 8, cache_read: 0.5, cache_write: 0 },
  'gpt-4o-2024-05-13': { input: 5, output: 15, cache_read: 0, cache_write: 0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cache_read: 0.075, cache_write: 0 },
  'gpt-4o': { input: 2.5, output: 10, cache_read: 1.25, cache_write: 0 },
  'o1-pro': { input: 150, output: 600, cache_read: 0, cache_write: 0 },
  o1: { input: 15, output: 60, cache_read: 7.5, cache_write: 0 },
  'o3-pro': { input: 20, output: 80, cache_read: 0, cache_write: 0 },
  'o3-mini': { input: 1.1, output: 4.4, cache_read: 0.55, cache_write: 0 },
  o3: { input: 2, output: 8, cache_read: 0.5, cache_write: 0 },
  'o4-mini': { input: 1.1, output: 4.4, cache_read: 0.275, cache_write: 0 },
  'gpt-4-turbo': { input: 10, output: 30, cache_read: 0, cache_write: 0 },
  'gpt-4': { input: 30, output: 60, cache_read: 0, cache_write: 0 },
  'gpt-3.5-turbo-instruct': { input: 1.5, output: 2, cache_read: 0, cache_write: 0 },
  'gpt-3.5-turbo-1106': { input: 1, output: 2, cache_read: 0, cache_write: 0 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5, cache_read: 0, cache_write: 0 },
  'gpt-5.1-codex-mini': { input: 0.25, output: 2, cache_read: 0.025, cache_write: 0 },
  'gpt-5.3-chat-latest': { input: 1.75, output: 14, cache_read: 0.175, cache_write: 0 },
  'gpt-5.6-cyber': { input: 12.5, output: 75, cache_read: 1.25, cache_write: 15.625 },
  'gpt-5.5-cyber': { input: 12.5, output: 75, cache_read: 1.25, cache_write: 0 },
  'chat-latest': { input: 5, output: 30, cache_read: 0.5, cache_write: 0 },
  'gpt-5-codex': { input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 },
  'gpt-5.1-codex': { input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 },
  'gpt-5.1-codex-max': { input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 },
  'gpt-5-chat-latest': { input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 },
  'gpt-5.1-chat-latest': { input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 },
  'gpt-5.2-codex': { input: 1.75, output: 14, cache_read: 0.175, cache_write: 0 },
  'gpt-5.2-chat-latest': { input: 1.75, output: 14, cache_read: 0.175, cache_write: 0 },
}

/** Standard-tier rows above; this table adds the published Flex / Fast (priority) and
 * long-context (>272K input incl. cache) columns from codex-proxy-rs PRICING_RULES.
 * [input, output, cache_read] USD / 1M tokens. Missing band = not offered → unpriced. */
export const OPENAI_LONG_CONTEXT_THRESHOLD = 272_000

const OPENAI_TIER_RATES = {
  'gpt-6-astra': {
    flex: [5, 25, 0.5],
    fast: [20, 100, 2],
    long_standard: [20, 75, 2],
    long_flex: [10, 37.5, 1],
    long_fast: [40, 150, 4],
  },
  'gpt-6-sol': {
    flex: [1, 5, 0.1],
    fast: [4, 20, 0.4],
  },
  'gpt-6-luna': {
    flex: [0.05, 0.25, 0.005],
    fast: [0.2, 1, 0.02],
  },
  'gpt-5.6-sol': {
    flex: [2.5, 15, 0.25],
    fast: [10, 60, 1],
    long_standard: [10, 45, 1],
    long_flex: [5, 22.5, 0.5],
    long_fast: [20, 90, 2],
  },
  'gpt-5.6-terra': {
    flex: [1, 6, 0.1],
    fast: [4, 24, 0.4],
    long_standard: [4, 18, 0.4],
    long_flex: [2, 9, 0.2],
    long_fast: [8, 36, 0.8],
  },
  'gpt-5.6-luna': {
    flex: [0.1, 0.6, 0.01],
    fast: [0.4, 2.4, 0.04],
    long_standard: [0.4, 1.8, 0.04],
    long_flex: [0.2, 0.9, 0.02],
    long_fast: [0.8, 3.6, 0.08],
  },
  'gpt-5.6': {
    flex: [2.5, 15, 0.25],
    fast: [10, 60, 1],
    long_standard: [10, 45, 1],
    long_flex: [5, 22.5, 0.5],
    long_fast: [20, 90, 2],
  },
  'gpt-5.5-pro': { flex: [15, 90, 0], long_standard: [60, 270, 0] },
  'gpt-5.5': {
    flex: [2.5, 15, 0.25],
    fast: [12.5, 75, 1.25],
    long_standard: [10, 45, 1],
    long_flex: [5, 22.5, 0.5],
  },
  'gpt-5.4-mini': { flex: [0.375, 2.25, 0.0375], fast: [1.5, 9, 0.15] },
  'gpt-5.4-nano': { flex: [0.1, 0.625, 0.01] },
  'gpt-5.4-pro': { flex: [15, 90, 0], long_standard: [60, 270, 0], long_flex: [30, 135, 0] },
  'gpt-5.4': {
    flex: [1.25, 7.5, 0.13],
    fast: [5, 30, 0.5],
    long_standard: [5, 22.5, 0.5],
    long_flex: [2.5, 11.25, 0.25],
  },
  'gpt-5.3-codex': { fast: [3.5, 28, 0.35] },
  'gpt-5.2': { flex: [0.875, 7, 0.0875], fast: [3.5, 28, 0.35] },
  'gpt-5.1': { flex: [0.625, 5, 0.0625], fast: [2.5, 20, 0.25] },
  'gpt-5-mini': { flex: [0.125, 1, 0.0125], fast: [0.45, 3.6, 0.045] },
  'gpt-5-nano': { flex: [0.025, 0.2, 0.0025] },
  'gpt-5': { flex: [0.625, 5, 0.0625], fast: [2.5, 20, 0.25] },
  'gpt-4.1-mini': { fast: [0.7, 2.8, 0.175] },
  'gpt-4.1-nano': { fast: [0.2, 0.8, 0.05] },
  'gpt-4.1': { fast: [3.5, 14, 0.875] },
  'gpt-4o-2024-05-13': { fast: [8.75, 26.25, 0] },
  'gpt-4o-mini': { fast: [0.25, 1, 0.125] },
  'gpt-4o': { fast: [4.25, 17, 2.125] },
  o3: { flex: [1, 4, 0.25], fast: [3.5, 14, 0.875] },
  'o4-mini': { flex: [0.55, 2.2, 0.138], fast: [2, 8, 0.5] },
  // Cyber long-context sources disagree upstream — leave >272K unpriced.
  'gpt-5.6-cyber': { unpriced_long_context: true },
  'gpt-5.5-cyber': { unpriced_long_context: true },
}

/** Only verified snapshot aliases. Unknown suffixes do not inherit a parent price. */
const OPENAI_ALIASES = {
  'gpt-3.5-turbo-0125': 'gpt-3.5-turbo',
  'gpt-4-0314': 'gpt-4',
  'gpt-4-0613': 'gpt-4',
  'gpt-4-turbo-2024-04-09': 'gpt-4-turbo',
  'gpt-4.1-2025-04-14': 'gpt-4.1',
  'gpt-4.1-mini-2025-04-14': 'gpt-4.1-mini',
  'gpt-4.1-nano-2025-04-14': 'gpt-4.1-nano',
  'gpt-4o-2024-08-06': 'gpt-4o',
  'gpt-4o-2024-11-20': 'gpt-4o',
  'gpt-4o-mini-2024-07-18': 'gpt-4o-mini',
  'gpt-5-2025-08-07': 'gpt-5',
  'gpt-5-mini-2025-08-07': 'gpt-5-mini',
  'gpt-5-nano-2025-08-07': 'gpt-5-nano',
  'gpt-5-pro-2025-10-06': 'gpt-5-pro',
  'gpt-5.1-2025-11-13': 'gpt-5.1',
  'gpt-5.2-2025-12-11': 'gpt-5.2',
  'gpt-5.2-pro-2025-12-11': 'gpt-5.2-pro',
  'gpt-5.4-2026-03-05': 'gpt-5.4',
  'gpt-5.4-mini-2026-03-17': 'gpt-5.4-mini',
  'gpt-5.4-nano-2026-03-17': 'gpt-5.4-nano',
  'gpt-5.4-pro-2026-03-05': 'gpt-5.4-pro',
  'gpt-5.5-2026-04-23': 'gpt-5.5',
  'gpt-5.5-pro-2026-04-23': 'gpt-5.5-pro',
  'gpt-daybreak-blue-latest': 'gpt-5.6-sol',
  'gpt-daybreak-red-latest': 'gpt-5.6-cyber',
  'o1-2024-12-17': 'o1',
  'o1-pro-2025-03-19': 'o1-pro',
  'o3-2025-04-16': 'o3',
  'o3-mini-2025-01-31': 'o3-mini',
  'o3-pro-2025-06-10': 'o3-pro',
  'o4-mini-2025-04-16': 'o4-mini',
}

export function resolveOpenaiPricingKey(raw) {
  const m = (
    String(raw || '')
      .split('/')
      .filter(Boolean)
      .pop() || ''
  )
    .replace(/\[[^\]]+\]$/g, '')
    .replace(/-fast$/i, '')
    .trim()
    .toLowerCase()
  if (!m) return null
  if (OPENAI_ALIASES[m]) return OPENAI_ALIASES[m]
  if (OPENAI_OFFICIAL_RATES[m]) return m
  return null
}

export function resolveOpenaiOfficialRates(raw) {
  const key = resolveOpenaiPricingKey(raw)
  const rates = key ? OPENAI_OFFICIAL_RATES[key] : null
  return {
    key,
    rates: rates ? { ...rates } : null,
    source: OPENAI_PRICING_SOURCE,
    known: !!rates,
    family: 'openai',
  }
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

/**
 * Pick the band for one request (codex-proxy-rs `effective_rates`):
 * only models publishing a long-context column switch above the threshold;
 * a band the model does not offer returns null (unpriced, never guessed).
 * cache_write keeps the model's standard write/input ratio (1.25× where published).
 */
export function selectOpenaiRates(key, { serviceTier = null, inputTokens = 0 } = {}) {
  const std = key ? OPENAI_OFFICIAL_RATES[key] : null
  const tier = normalizeOpenaiServiceTier(serviceTier)
  if (!std || !tier) return null
  const extra = OPENAI_TIER_RATES[key] || {}
  const overThreshold = Number(inputTokens) > OPENAI_LONG_CONTEXT_THRESHOLD
  if (overThreshold && extra.unpriced_long_context) return null
  const longContext = overThreshold && !!extra.long_standard
  const band = longContext ? `long_${tier}` : tier
  let rates
  if (band === 'standard') rates = { ...std }
  else {
    const row = extra[band]
    if (!row) return null
    const [input, output, cache_read] = row
    const writeRatio = std.input ? std.cache_write / std.input : 0
    rates = { input, output, cache_read, cache_write: writeRatio ? input * writeRatio : 0 }
  }
  return { rates, band, service_tier: tier, long_context: longContext }
}
