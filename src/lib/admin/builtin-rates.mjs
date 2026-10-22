/**
 * Official list-price snapshot (USD / 1M tokens), keyed by full canonical model id.
 * Anthropic cache: 5m = 1.25× input, 1h = 2× input unless a published read/write differs.
 * OpenAI cache_5m = published cache_write (0 if none); cache_1h = cache_5m.
 */
export const BUILTIN_SOURCE = 'builtin-2026-10-14'

const WEB_SEARCH = 0.01
const OPENAI_LONG = 272_000

function claude(input, output, cache_read, cache_5m, cache_1h, extra = {}) {
  return {
    input,
    output,
    cache_read,
    cache_5m,
    cache_1h,
    per_call: { web_search: WEB_SEARCH },
    ...extra,
  }
}

function tokenPrice(input, output, cache_read, cache_5m, cache_1h) {
  return { input, output, cache_read, cache_5m, cache_1h }
}

function openaiFrom(std, extra = {}) {
  const writeRatio = std.input ? std.cache_write / std.input : 0
  const band = (input, output, cache_read) => {
    const w = writeRatio ? input * writeRatio : 0
    return { input, output, cache_read, cache_5m: w, cache_1h: w }
  }
  const base = band(std.input, std.output, std.cache_read)
  const unpricedLong = [{ above: OPENAI_LONG, unpriced: true }]
  if (extra.unpriced_long_context) {
    base.tiers = unpricedLong
    const modes = {}
    if (extra.flex) modes.flex = { ...band(...extra.flex), tiers: unpricedLong }
    if (extra.fast) modes.priority = { ...band(...extra.fast), tiers: unpricedLong }
    if (Object.keys(modes).length) base.modes = modes
    return base
  }
  if (extra.long_standard) {
    base.tiers = [{ above: OPENAI_LONG, ...band(...extra.long_standard) }]
  }
  const modes = {}
  if (extra.flex) {
    const m = band(...extra.flex)
    if (extra.long_flex) m.tiers = [{ above: OPENAI_LONG, ...band(...extra.long_flex) }]
    else if (extra.long_standard) m.tiers = unpricedLong
    modes.flex = m
  }
  if (extra.fast) {
    const m = band(...extra.fast)
    if (extra.long_fast) m.tiers = [{ above: OPENAI_LONG, ...band(...extra.long_fast) }]
    else if (extra.long_standard) m.tiers = unpricedLong
    modes.priority = m
  }
  if (Object.keys(modes).length) base.modes = modes
  return base
}

const ANTHROPIC = {
  'claude-fable-5': claude(10, 50, 1, 12.5, 20),
  'claude-fable-5-1': claude(10, 50, 0.25, 12.5, 20),
  'claude-mythos-5': claude(10, 50, 1, 12.5, 20),
  'claude-mythos-5-1': claude(10, 50, 0.25, 12.5, 20),
  'claude-opus-5-5': claude(4, 20, 0.2, 5, 8, {
    modes: { fast: tokenPrice(8, 40, 0.4, 10, 16) },
  }),
  'claude-opus-5': claude(5, 25, 0.5, 6.25, 10, {
    modes: { fast: tokenPrice(10, 50, 1, 12.5, 20) },
  }),
  'claude-opus-4-8': claude(5, 25, 0.5, 6.25, 10, {
    modes: { fast: tokenPrice(10, 50, 1, 12.5, 20) },
  }),
  'claude-opus-4-7': claude(5, 25, 0.5, 6.25, 10),
  'claude-opus-4-6': claude(5, 25, 0.5, 6.25, 10),
  'claude-opus-4-5': claude(5, 25, 0.5, 6.25, 10),
  'claude-opus-4-1': claude(15, 75, 1.5, 18.75, 30),
  'claude-opus-4': claude(15, 75, 1.5, 18.75, 30),
  'claude-3-opus': claude(15, 75, 1.5, 18.75, 30),
  'claude-sonnet-5-5': claude(2, 10, 0.1, 2.5, 4),
  'claude-sonnet-5': claude(2, 10, 0.2, 2.5, 4),
  'claude-sonnet-4-6': claude(3, 15, 0.3, 3.75, 6),
  'claude-sonnet-4-5': claude(3, 15, 0.3, 3.75, 6),
  'claude-sonnet-4': claude(3, 15, 0.3, 3.75, 6),
  'claude-3-7-sonnet': claude(3, 15, 0.3, 3.75, 6),
  'claude-3-5-sonnet': claude(3, 15, 0.3, 3.75, 6),
  'claude-haiku-5-5': claude(0.1, 0.5, 0.01, 0.125, 0.2, {
    tiers: [{ above: 100_000, input: 0.5, output: 2.5, cache_read: 0.05, cache_5m: 0.625, cache_1h: 1 }],
  }),
  'claude-haiku-4-5': claude(1, 5, 0.1, 1.25, 2),
  'claude-3-5-haiku': claude(0.8, 4, 0.08, 1, 1.6),
  'claude-3-haiku': claude(0.25, 1.25, 0.03, 0.3, 0.5),
}

// GPT Image 2.5 (developers.openai.com/api/docs/pricing; codex-proxy-rs verified 2026-09-09):
// text input 5 / cached 1.25, image tokens 8 / cached 2 / output 30. Both variants share one price.
function gptImage() {
  return { ...tokenPrice(5, 0, 1.25, 0, 0), image: { input: 8, output: 30, cache_read: 2 } }
}

const OPENAI = {
  'gpt-6-astra': openaiFrom(
    { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
    {
      flex: [5, 25, 0.5],
      fast: [20, 100, 2],
      long_standard: [20, 75, 2],
      long_flex: [10, 37.5, 1],
      long_fast: [40, 150, 4],
    },
  ),
  'gpt-6.1-sol': openaiFrom(
    { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 },
    {
      flex: [1, 5, 0.05],
      fast: [4, 20, 0.2],
      long_standard: [4, 15, 0.2],
      long_flex: [2, 7.5, 0.1],
      long_fast: [8, 30, 0.4],
    },
  ),
  'gpt-6-sol': openaiFrom(
    { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
    { flex: [1, 5, 0.1], fast: [4, 20, 0.4] },
  ),
  'gpt-6-luna': openaiFrom(
    { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 },
    { flex: [0.05, 0.25, 0.005], fast: [0.2, 1, 0.02] },
  ),
  'gpt-5.6-sol': openaiFrom(
    { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 },
    {
      flex: [2.5, 15, 0.25],
      fast: [10, 60, 1],
      long_standard: [10, 45, 1],
      long_flex: [5, 22.5, 0.5],
      long_fast: [20, 90, 2],
    },
  ),
  'gpt-5.6-terra': openaiFrom(
    { input: 2, output: 12, cache_read: 0.2, cache_write: 2.5 },
    {
      flex: [1, 6, 0.1],
      fast: [4, 24, 0.4],
      long_standard: [4, 18, 0.4],
      long_flex: [2, 9, 0.2],
      long_fast: [8, 36, 0.8],
    },
  ),
  'gpt-5.6-luna': openaiFrom(
    { input: 0.2, output: 1.2, cache_read: 0.02, cache_write: 0.25 },
    {
      flex: [0.1, 0.6, 0.01],
      fast: [0.4, 2.4, 0.04],
      long_standard: [0.4, 1.8, 0.04],
      long_flex: [0.2, 0.9, 0.02],
      long_fast: [0.8, 3.6, 0.08],
    },
  ),
  'gpt-5.6': openaiFrom(
    { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 },
    {
      flex: [2.5, 15, 0.25],
      fast: [10, 60, 1],
      long_standard: [10, 45, 1],
      long_flex: [5, 22.5, 0.5],
      long_fast: [20, 90, 2],
    },
  ),
  'gpt-5.5-pro': openaiFrom(
    { input: 30, output: 180, cache_read: 0, cache_write: 0 },
    { flex: [15, 90, 0], long_standard: [60, 270, 0] },
  ),
  'gpt-5.5': openaiFrom(
    { input: 5, output: 30, cache_read: 0.5, cache_write: 0 },
    {
      flex: [2.5, 15, 0.25],
      fast: [12.5, 75, 1.25],
      long_standard: [10, 45, 1],
      long_flex: [5, 22.5, 0.5],
    },
  ),
  'gpt-5.4-mini': openaiFrom(
    { input: 0.75, output: 4.5, cache_read: 0.075, cache_write: 0 },
    { flex: [0.375, 2.25, 0.0375], fast: [1.5, 9, 0.15] },
  ),
  'gpt-5.4-nano': openaiFrom(
    { input: 0.2, output: 1.25, cache_read: 0.02, cache_write: 0 },
    { flex: [0.1, 0.625, 0.01] },
  ),
  'gpt-5.4-pro': openaiFrom(
    { input: 30, output: 180, cache_read: 0, cache_write: 0 },
    { flex: [15, 90, 0], long_standard: [60, 270, 0], long_flex: [30, 135, 0] },
  ),
  'gpt-5.4': openaiFrom(
    { input: 2.5, output: 15, cache_read: 0.25, cache_write: 0 },
    {
      flex: [1.25, 7.5, 0.13],
      fast: [5, 30, 0.5],
      long_standard: [5, 22.5, 0.5],
      long_flex: [2.5, 11.25, 0.25],
    },
  ),
  'gpt-5.3-codex': openaiFrom(
    { input: 1.75, output: 14, cache_read: 0.175, cache_write: 0 },
    { fast: [3.5, 28, 0.35] },
  ),
  'gpt-5.2-pro': openaiFrom({ input: 21, output: 168, cache_read: 0, cache_write: 0 }),
  'gpt-5.2': openaiFrom(
    { input: 1.75, output: 14, cache_read: 0.175, cache_write: 0 },
    { flex: [0.875, 7, 0.0875], fast: [3.5, 28, 0.35] },
  ),
  'gpt-5.1': openaiFrom(
    { input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 },
    { flex: [0.625, 5, 0.0625], fast: [2.5, 20, 0.25] },
  ),
  'gpt-5-mini': openaiFrom(
    { input: 0.25, output: 2, cache_read: 0.025, cache_write: 0 },
    { flex: [0.125, 1, 0.0125], fast: [0.45, 3.6, 0.045] },
  ),
  'gpt-5-nano': openaiFrom(
    { input: 0.05, output: 0.4, cache_read: 0.005, cache_write: 0 },
    { flex: [0.025, 0.2, 0.0025] },
  ),
  'gpt-5-pro': openaiFrom({ input: 15, output: 120, cache_read: 0, cache_write: 0 }),
  'gpt-5': openaiFrom(
    { input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 },
    { flex: [0.625, 5, 0.0625], fast: [2.5, 20, 0.25] },
  ),
  'gpt-4.1-mini': openaiFrom({ input: 0.4, output: 1.6, cache_read: 0.1, cache_write: 0 }, { fast: [0.7, 2.8, 0.175] }),
  'gpt-4.1-nano': openaiFrom(
    { input: 0.1, output: 0.4, cache_read: 0.025, cache_write: 0 },
    { fast: [0.2, 0.8, 0.05] },
  ),
  'gpt-4.1': openaiFrom({ input: 2, output: 8, cache_read: 0.5, cache_write: 0 }, { fast: [3.5, 14, 0.875] }),
  'gpt-4o-2024-05-13': openaiFrom({ input: 5, output: 15, cache_read: 0, cache_write: 0 }, { fast: [8.75, 26.25, 0] }),
  'gpt-4o-mini': openaiFrom(
    { input: 0.15, output: 0.6, cache_read: 0.075, cache_write: 0 },
    { fast: [0.25, 1, 0.125] },
  ),
  'gpt-4o': openaiFrom({ input: 2.5, output: 10, cache_read: 1.25, cache_write: 0 }, { fast: [4.25, 17, 2.125] }),
  'o1-pro': openaiFrom({ input: 150, output: 600, cache_read: 0, cache_write: 0 }),
  o1: openaiFrom({ input: 15, output: 60, cache_read: 7.5, cache_write: 0 }),
  'o3-pro': openaiFrom({ input: 20, output: 80, cache_read: 0, cache_write: 0 }),
  'o3-mini': openaiFrom({ input: 1.1, output: 4.4, cache_read: 0.55, cache_write: 0 }),
  o3: openaiFrom(
    { input: 2, output: 8, cache_read: 0.5, cache_write: 0 },
    { flex: [1, 4, 0.25], fast: [3.5, 14, 0.875] },
  ),
  'o4-mini': openaiFrom(
    { input: 1.1, output: 4.4, cache_read: 0.275, cache_write: 0 },
    { flex: [0.55, 2.2, 0.138], fast: [2, 8, 0.5] },
  ),
  'gpt-4-turbo': openaiFrom({ input: 10, output: 30, cache_read: 0, cache_write: 0 }),
  'gpt-4': openaiFrom({ input: 30, output: 60, cache_read: 0, cache_write: 0 }),
  'gpt-3.5-turbo-instruct': openaiFrom({ input: 1.5, output: 2, cache_read: 0, cache_write: 0 }),
  'gpt-3.5-turbo-1106': openaiFrom({ input: 1, output: 2, cache_read: 0, cache_write: 0 }),
  'gpt-3.5-turbo': openaiFrom({ input: 0.5, output: 1.5, cache_read: 0, cache_write: 0 }),
  'gpt-5.1-codex-mini': openaiFrom({ input: 0.25, output: 2, cache_read: 0.025, cache_write: 0 }),
  'gpt-5.3-chat-latest': openaiFrom({ input: 1.75, output: 14, cache_read: 0.175, cache_write: 0 }),
  'gpt-5.6-cyber': openaiFrom(
    { input: 12.5, output: 75, cache_read: 1.25, cache_write: 15.625 },
    { unpriced_long_context: true },
  ),
  'gpt-5.5-cyber': openaiFrom(
    { input: 12.5, output: 75, cache_read: 1.25, cache_write: 0 },
    { unpriced_long_context: true },
  ),
  'chat-latest': openaiFrom({ input: 5, output: 30, cache_read: 0.5, cache_write: 0 }),
  'gpt-5-codex': openaiFrom({ input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 }),
  'gpt-5.1-codex': openaiFrom({ input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 }),
  'gpt-5.1-codex-max': openaiFrom({ input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 }),
  'gpt-5-chat-latest': openaiFrom({ input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 }),
  'gpt-5.1-chat-latest': openaiFrom({ input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 }),
  'gpt-5.2-codex': openaiFrom({ input: 1.75, output: 14, cache_read: 0.175, cache_write: 0 }),
  'gpt-5.2-chat-latest': openaiFrom({ input: 1.75, output: 14, cache_read: 0.175, cache_write: 0 }),
  'gpt-image-2.5-flare': gptImage(),
  'gpt-image-2.5-sunburst': gptImage(),
}

/** Dated / legacy / family ids → canonical priced id. OpenAI: verified snapshot aliases only. */
export const BUILTIN_ALIASES = {
  fable: 'claude-fable-5',
  mythos: 'claude-mythos-5',
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-4-5-20251001',
  'claude-fable-5.1': 'claude-fable-5-1',
  'claude-mythos-5.1': 'claude-mythos-5-1',
  'claude-opus-5.5': 'claude-opus-5-5',
  'claude-sonnet-5.5': 'claude-sonnet-5-5',
  'claude-haiku-5.5': 'claude-haiku-5-5',
  'claude-haiku-3-5': 'claude-3-5-haiku',
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
  'gpt-image-2.5-flare-2026-09-08': 'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst-2026-09-08': 'gpt-image-2.5-sunburst',
  'gpt-daybreak-blue-latest': 'gpt-5.6-sol',
  'gpt-daybreak-red-latest': 'gpt-5.6-cyber',
  'o1-2024-12-17': 'o1',
  'o1-pro-2025-03-19': 'o1-pro',
  'o3-2025-04-16': 'o3',
  'o3-mini-2025-01-31': 'o3-mini',
  'o3-pro-2025-06-10': 'o3-pro',
  'o4-mini-2025-04-16': 'o4-mini',
}

export const BUILTIN_RATES = { anthropic: ANTHROPIC, openai: OPENAI }

export function builtinOf(id) {
  if (ANTHROPIC[id]) return { platform: 'anthropic', id, price: ANTHROPIC[id] }
  if (OPENAI[id]) return { platform: 'openai', id, price: OPENAI[id] }
  return null
}
