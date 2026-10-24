import test from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateCost,
  shanghaiDay,
  shanghaiDayStartIso,
  costColumnsFromUsage,
  imageCostFromUsage,
  normalizeUsage,
} from '../../src/lib/admin/pricing.mjs'
import { resolvePrice } from '../../src/lib/admin/price-catalog.mjs'

test('official family aliases resolve to current list prices', () => {
  assert.equal(resolvePrice('fable').id, 'claude-fable-5')
  assert.equal(resolvePrice('opus').id, 'claude-opus-5')
  assert.equal(resolvePrice('sonnet').id, 'claude-sonnet-5-5')
  assert.equal(resolvePrice('haiku').id, 'claude-haiku-4-5')
  assert.equal(resolvePrice('mythos').id, 'claude-mythos-5')
})

test('dated and calling ids map to the official band', () => {
  assert.equal(resolvePrice('claude-sonnet-5').id, 'claude-sonnet-5')
  assert.equal(resolvePrice('claude-opus-5').id, 'claude-opus-5')
  assert.equal(resolvePrice('claude-fable-5').id, 'claude-fable-5')
  assert.equal(resolvePrice('claude-haiku-4-5-20251001').id, 'claude-haiku-4-5')
  assert.equal(resolvePrice('claude-haiku-5-5').id, 'claude-haiku-5-5')
  assert.equal(resolvePrice('claude-sonnet-4-6').id, 'claude-sonnet-4-6')
  assert.equal(resolvePrice('claude-opus-4-6').id, 'claude-opus-4-6')
  assert.equal(resolvePrice('claude-opus-4-1-20250805').id, 'claude-opus-4-1')
})

test('Haiku 5.5 bills base rates under 100K and the premium band above', () => {
  const base = calculateCost(
    {
      input_tokens: 50_000,
      output_tokens: 1_000_000,
      cache_read_tokens: 0,
      cache_creation_tokens: 50_000,
      cache_ttl: '1h',
    },
    'claude-haiku-5-5',
  )
  assert.equal(base.long_context, false)
  assert.equal(base.input_cost, 0.005)
  assert.equal(base.output_cost, 0.5)
  assert.equal(base.cache_creation_cost, 0.01)
  const premium = calculateCost(
    {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_tokens: 1_000_000,
      cache_creation_tokens: 1_000_000,
      cache_ttl: '5m',
    },
    'claude-haiku-5-5',
  )
  assert.equal(premium.pricing_key, 'claude-haiku-5-5')
  assert.equal(premium.long_context, true)
  assert.equal(premium.input_cost, 0.5)
  assert.equal(premium.output_cost, 2.5)
  assert.equal(premium.cache_read_cost, 0.05)
  assert.equal(premium.cache_creation_cost, 0.625)
})

test('Opus 5 official: $5 / $25 / cache 5m $6.25 / 1h $10 / read $0.50 per MTok', () => {
  const c = calculateCost(
    {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_tokens: 1_000_000,
      cache_creation_5m_tokens: 1_000_000,
      cache_creation_1h_tokens: 1_000_000,
    },
    'claude-opus-5',
  )
  assert.equal(c.known, true)
  assert.equal(c.input_cost, 5)
  assert.equal(c.output_cost, 25)
  assert.equal(c.cache_read_cost, 0.5)
  assert.equal(c.cache_creation_5m_cost, 6.25)
  assert.equal(c.cache_creation_1h_cost, 10)
  assert.equal(c.total_cost, 46.75)
})

test('Opus 5.5 official: $4 / $20 / cache read $0.20 per MTok', () => {
  assert.equal(resolvePrice('claude-opus-5-5').id, 'claude-opus-5-5')
  assert.equal(resolvePrice('claude-opus-5.5').id, 'claude-opus-5-5')
  assert.equal(resolvePrice('claude-opus-5').id, 'claude-opus-5')
  const c = calculateCost(
    {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_tokens: 1_000_000,
      cache_creation_5m_tokens: 1_000_000,
      cache_creation_1h_tokens: 1_000_000,
    },
    'claude-opus-5-5',
  )
  assert.equal(c.input_cost, 4)
  assert.equal(c.output_cost, 20)
  assert.equal(c.cache_read_cost, 0.2)
  assert.equal(c.cache_creation_5m_cost, 5)
  assert.equal(c.cache_creation_1h_cost, 8)
})

test('Sonnet 5 official: $2 / $10 (standard, not the old $3/$15 intro)', () => {
  const c = calculateCost({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'claude-sonnet-5')
  assert.equal(c.input_cost, 2)
  assert.equal(c.output_cost, 10)
  assert.equal(c.total_cost, 12)
})

test('Sonnet 5.5 cache read is $0.10 per MTok', () => {
  const c = calculateCost({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 1_000_000 }, 'claude-sonnet-5-5')
  assert.equal(c.pricing_key, 'claude-sonnet-5-5')
  assert.equal(c.cache_read_cost, 0.1)
})

test('Fable 5 official: $10 / $50', () => {
  const c = calculateCost({ input_tokens: 100_000, output_tokens: 20_000 }, 'claude-fable-5')
  assert.equal(c.input_cost, 1)
  assert.equal(c.output_cost, 1)
  assert.equal(c.total_cost, 2)
})

test('Fable 5.1 and Mythos 5.1 cache read is $0.25 per MTok', () => {
  const fable = calculateCost({ cache_read_tokens: 1_000_000 }, 'claude-fable-5-1')
  assert.equal(fable.cache_read_cost, 0.25)
  const dotted = calculateCost({ cache_read_tokens: 1_000_000 }, 'claude-fable-5.1')
  assert.equal(dotted.cache_read_cost, 0.25)
  const mythos = calculateCost({ cache_read_tokens: 1_000_000 }, 'claude-mythos-5-1')
  assert.equal(mythos.cache_read_cost, 0.25)
})

test('cache creation marked cache_ttl=1h bills the 1h list price', () => {
  const c = calculateCost(
    {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 1_000_000,
      cache_ttl: '1h',
    },
    'claude-sonnet-5',
  )
  assert.equal(c.cache_creation_1h_tokens, 1_000_000)
  assert.equal(c.cache_creation_5m_tokens, 0)
  assert.equal(c.cache_creation_cost, 4)
})

test('cache creation without TTL breakdown bills as 5m', () => {
  const c = calculateCost(
    {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 1_000_000,
    },
    'claude-sonnet-5',
  )
  assert.equal(c.cache_creation_5m_tokens, 1_000_000)
  assert.equal(c.cache_creation_1h_tokens, 0)
  assert.equal(c.cache_creation_cost, 2.5)
  assert.equal(c.total_cost, 2.5)
})

test('OpenAI-shaped usage is converted to disjoint Anthropic names', () => {
  const c = calculateCost(
    {
      prompt_tokens: 1_000_000,
      completion_tokens: 1_000_000,
      prompt_tokens_details: { cached_tokens: 1_000_000, cache_creation_tokens: 1_000_000 },
      cache_ttl: '5m',
    },
    'claude-sonnet-5',
  )
  assert.equal(c.input_tokens, 0)
  assert.equal(c.input_cost, 0)
  assert.equal(c.output_cost, 10)
  assert.equal(c.cache_read_cost, 0.2)
  assert.equal(c.cache_creation_cost, 2.5)
  assert.equal(c.total_cost, 12.7)
})

test('unknown model stays unpriced rather than guessing $0', () => {
  const c = calculateCost({ input_tokens: 100, output_tokens: 10 }, 'not-a-priced-model')
  assert.equal(c.known, false)
  assert.equal(c.pricing_key, null)
  const cols = costColumnsFromUsage({ input_tokens: 100 }, 'not-a-priced-model')
  assert.equal(cols.total_cost, null)
  assert.equal(cols.pricing_model, 'unpriced')
})

test('GPT-5.5 official standard: $5 / $30 per MTok', () => {
  const c = calculateCost({ input_tokens: 200_000, output_tokens: 200_000 }, 'gpt-5.5')
  assert.equal(c.known, true)
  assert.equal(c.price_source, 'builtin')
  assert.equal(c.price_version, 'builtin-2026-10-14')
  assert.equal(c.input_cost, 1)
  assert.equal(c.output_cost, 6)
  assert.equal(c.total_cost, 7)
})

test('GPT-5.6-sol bills uncached input plus official cache_write_tokens', () => {
  const c = calculateCost(
    {
      input_tokens: 100,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
    },
    'gpt-5.6-sol',
  )
  assert.equal(c.known, true)
  assert.equal(c.input_tokens, 70)
  assert.equal(c.input_cost, 0.00035)
  assert.equal(c.output_cost, 0.00015)
  assert.equal(c.cache_read_cost, 0.00001)
  assert.equal(c.cache_creation_cost, 0.0000625)
  assert.equal(c.total_cost, 0.0005725)
})

test('GPT-5.6-sol bills uncached input plus official cache write', () => {
  const c = calculateCost(
    {
      input_tokens: 100,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 20, cache_creation_tokens: 10 },
    },
    'gpt-5.6-sol',
  )
  assert.equal(c.known, true)
  assert.equal(c.input_tokens, 70)
  assert.equal(c.input_cost, 0.00035)
  assert.equal(c.output_cost, 0.00015)
  assert.equal(c.cache_read_cost, 0.00001)
  assert.equal(c.cache_creation_cost, 0.0000625)
  assert.equal(c.total_cost, 0.0005725)
})

test('GPT-6 Sol and Luna use the official standard rates', () => {
  const sol = calculateCost(
    {
      input_tokens: 3_000_000,
      output_tokens: 1_000_000,
      input_tokens_details: { cached_tokens: 1_000_000, cache_write_tokens: 1_000_000 },
    },
    'gpt-6-sol',
  )
  assert.equal(sol.known, true)
  assert.equal(sol.pricing_key, 'gpt-6-sol')
  assert.equal(sol.input_cost, 2)
  assert.equal(sol.output_cost, 10)
  assert.equal(sol.cache_read_cost, 0.2)
  assert.equal(sol.cache_creation_cost, 2.5)
  assert.equal(sol.total_cost, 14.7)

  const luna = calculateCost({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'gpt-6-luna')
  assert.equal(luna.known, true)
  assert.equal(luna.pricing_key, 'gpt-6-luna')
  assert.equal(luna.input_cost, 0.1)
  assert.equal(luna.output_cost, 0.5)
  assert.equal(luna.total_cost, 0.6)
})

test('GPT-6 Sol and Luna use the published Flex and Fast bands', () => {
  const solFlex = calculateCost(
    { input_tokens: 1_000_000, output_tokens: 1_000_000, service_tier: 'flex' },
    'gpt-6-sol',
  )
  assert.equal(solFlex.known, true)
  assert.equal(solFlex.mode, 'flex')
  assert.equal(solFlex.total_cost, 6)

  const lunaFast = calculateCost(
    { input_tokens: 1_000_000, output_tokens: 1_000_000, service_tier: 'priority' },
    'gpt-6-luna',
  )
  assert.equal(lunaFast.known, true)
  assert.equal(lunaFast.mode, 'priority')
  assert.equal(lunaFast.service_tier, 'fast')
  assert.equal(lunaFast.total_cost, 1.2)
})

test('GPT-6.1 Sol uses the published standard, Flex, and Fast rates', () => {
  const standard = calculateCost(
    {
      input_tokens: 250_000,
      output_tokens: 100_000,
      input_tokens_details: { cached_tokens: 100_000, cache_write_tokens: 50_000 },
    },
    'gpt-6.1-sol',
  )
  assert.equal(standard.known, true)
  assert.equal(standard.long_context, false)
  assert.equal(standard.pricing_key, 'gpt-6.1-sol')
  assert.equal(standard.input_cost, 0.2)
  assert.equal(standard.output_cost, 1)
  assert.equal(standard.cache_read_cost, 0.01)
  assert.equal(standard.cache_creation_cost, 0.125)
  assert.equal(standard.total_cost, 1.335)

  const flex = calculateCost({ input_tokens: 100_000, output_tokens: 100_000, service_tier: 'flex' }, 'gpt-6.1-sol')
  assert.equal(flex.known, true)
  assert.equal(flex.long_context, false)
  assert.equal(flex.total_cost, 0.6)

  const fast = calculateCost({ input_tokens: 100_000, output_tokens: 100_000, service_tier: 'priority' }, 'gpt-6.1-sol')
  assert.equal(fast.known, true)
  assert.equal(fast.service_tier, 'fast')
  assert.equal(fast.mode, 'priority')
  assert.equal(fast.long_context, false)
  assert.equal(fast.total_cost, 2.4)
})

test('GPT-6.1 Sol above 272K uses 2x input and cache and 1.5x output', () => {
  const atThreshold = calculateCost({ input_tokens: 272_000, output_tokens: 0 }, 'gpt-6.1-sol')
  assert.equal(atThreshold.long_context, false)
  assert.equal(atThreshold.input_cost, 0.544)

  const long = calculateCost(
    {
      input_tokens: 3_000_000,
      output_tokens: 1_000_000,
      input_tokens_details: { cached_tokens: 1_000_000, cache_write_tokens: 1_000_000 },
    },
    'gpt-6.1-sol',
  )
  assert.equal(long.long_context, true)
  assert.equal(long.input_cost, 4)
  assert.equal(long.cache_read_cost, 0.2)
  assert.equal(long.cache_creation_cost, 5)
  assert.equal(long.output_cost, 15)
  assert.equal(long.total_cost, 24.2)

  const flex = calculateCost({ input_tokens: 300_000, output_tokens: 1_000_000, service_tier: 'flex' }, 'gpt-6.1-sol')
  assert.equal(flex.long_context, true)
  assert.equal(flex.total_cost, 8.1)

  const fast = calculateCost(
    { input_tokens: 300_000, output_tokens: 1_000_000, service_tier: 'priority' },
    'gpt-6.1-sol',
  )
  assert.equal(fast.long_context, true)
  assert.equal(fast.service_tier, 'fast')
  assert.equal(fast.total_cost, 32.4)
})

test('gpt-reserve has no published price and stays unbilled', () => {
  const c = calculateCost({ input_tokens: 100, output_tokens: 10 }, 'gpt-reserve')
  assert.equal(c.known, false)
  const cols = costColumnsFromUsage({ input_tokens: 100 }, 'gpt-reserve')
  assert.equal(cols.total_cost, null)
})

test('worked example from Anthropic docs: 10k in + 15k out Opus 5 = $0.425', () => {
  const c = calculateCost({ input_tokens: 10000, output_tokens: 15000 }, 'claude-opus-5')
  assert.equal(c.input_cost, 0.05)
  assert.equal(c.output_cost, 0.375)
  assert.equal(c.total_cost, 0.425)
})

test('shanghai day start is Asia/Shanghai midnight as UTC ISO', () => {
  assert.match(shanghaiDay(), /^\d{4}-\d{2}-\d{2}$/)
  const iso = shanghaiDayStartIso(new Date('2026-08-20T16:30:00+08:00'))
  assert.equal(iso, '2026-08-19T16:00:00.000Z')
})

test('Sonnet 4 / 4.5 / 4.6 bill >200K prompts at standard rates (no long-context premium)', () => {
  for (const model of [
    'claude-sonnet-4',
    'claude-sonnet-4-5',
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-sonnet-5',
  ]) {
    const c = calculateCost({ input_tokens: 300_000, output_tokens: 0 }, model)
    assert.equal(c.long_context, false, model)
  }
  const c = calculateCost({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'claude-sonnet-4-6')
  assert.equal(c.total_cost, 18)
})

test('GPT-5.5 long context (>272K incl. cache) uses official long column for all buckets', () => {
  const c = calculateCost(
    { input_tokens: 300_000, output_tokens: 1000, input_tokens_details: { cached_tokens: 250_000 } },
    'gpt-5.5',
  )
  assert.equal(c.long_context, true)
  assert.equal(c.input_cost, 0.5)
  assert.equal(c.cache_read_cost, 0.25)
  assert.equal(c.output_cost, 0.045)
  assert.equal(c.total_cost, 0.795)
})

test('GPT-5.5 at exactly 272K stays standard', () => {
  const c = calculateCost({ input_tokens: 272_000, output_tokens: 0 }, 'gpt-5.5')
  assert.equal(c.long_context, false)
  assert.equal(c.input_cost, 1.36)
})

test('GPT service_tier flex / priority pick the published band', () => {
  const u = { input_tokens: 100_000, output_tokens: 100_000 }
  const flex = calculateCost({ ...u, service_tier: 'flex' }, 'gpt-5.4')
  assert.equal(flex.service_tier, 'flex')
  assert.equal(flex.total_cost, 0.875)
  const fast = calculateCost({ ...u, service_tier: 'priority' }, 'gpt-5.5')
  assert.equal(fast.service_tier, 'fast')
  assert.equal(fast.mode, 'priority')
  assert.equal(fast.total_cost, 8.75)
  const auto = calculateCost({ ...u, service_tier: 'auto' }, 'gpt-5.5')
  assert.equal(auto.total_cost, 3.5)
  assert.equal(calculateCost({ input_tokens: 300_000, service_tier: 'priority' }, 'gpt-5.5').known, false)
})

test('GPT tier the model does not offer, or unknown tier, stays unpriced', () => {
  assert.equal(calculateCost({ input_tokens: 10, service_tier: 'flex' }, 'gpt-5.3-codex').known, false)
  assert.equal(calculateCost({ input_tokens: 10, service_tier: 'scale' }, 'gpt-5.5').known, false)
})

test('GPT-5.6-sol fast long context keeps 1.25x cache write on the long-fast input', () => {
  const c = calculateCost(
    {
      input_tokens: 400_000,
      output_tokens: 0,
      input_tokens_details: { cached_tokens: 100_000, cache_write_tokens: 100_000 },
      service_tier: 'priority',
    },
    'gpt-5.6-sol',
  )
  assert.equal(c.long_context, true)
  assert.equal(c.input_cost, 4)
  assert.equal(c.cache_read_cost, 0.2)
  assert.equal(c.cache_creation_cost, 2.5)
})

test('GPT-5.6-cyber above 272K is left unpriced (no reliable official column)', () => {
  assert.equal(calculateCost({ input_tokens: 300_000 }, 'gpt-5.6-cyber').known, false)
  assert.equal(calculateCost({ input_tokens: 100_000 }, 'gpt-5.6-cyber').known, true)
})

test('models without a long column keep standard rates above 272K', () => {
  const c = calculateCost({ input_tokens: 1_000_000, output_tokens: 0 }, 'gpt-5.2')
  assert.equal(c.long_context, false)
  assert.equal(c.input_cost, 1.75)
})

test('Anthropic fast mode: usage.speed=fast bills the official fast column', () => {
  const u = { input_tokens: 1_000_000, output_tokens: 1_000_000, speed: 'fast' }
  const o55 = calculateCost(u, 'claude-opus-5-5')
  assert.equal(o55.speed, 'fast')
  assert.equal(o55.mode, 'fast')
  assert.equal(o55.input_cost, 8)
  assert.equal(o55.output_cost, 40)
  const o5 = calculateCost(u, 'claude-opus-5')
  assert.equal(o5.input_cost, 10)
  assert.equal(o5.output_cost, 50)
  const o48 = calculateCost(u, 'claude-opus-4-8')
  assert.equal(o48.pricing_key, 'claude-opus-4-8')
  assert.equal(o48.total_cost, 60)
})

test('Anthropic fast mode: cache multipliers stack on the fast input price', () => {
  const c = calculateCost(
    {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
      speed: 'fast',
    },
    'claude-opus-5-5',
  )
  assert.equal(c.cache_read_cost, 0.4)
  assert.equal(c.cache_creation_5m_cost, 10)
  assert.equal(c.cache_creation_1h_cost, 16)
})

test('Anthropic fast mode: response speed wins over requested speed', () => {
  const standard = calculateCost(
    { input_tokens: 1_000_000, output_tokens: 0, speed: 'standard', requested_speed: 'fast' },
    'claude-opus-5',
  )
  assert.equal(standard.speed, 'standard')
  assert.equal(standard.input_cost, 5)
  const fallback = calculateCost(
    { input_tokens: 1_000_000, output_tokens: 0, requested_speed: 'fast' },
    'claude-opus-5',
  )
  assert.equal(fallback.input_cost, 10)
})

test('Anthropic fast mode: unsupported models stay on standard rates', () => {
  for (const model of ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-5', 'claude-fable-5']) {
    const c = calculateCost({ input_tokens: 1_000_000, output_tokens: 0, speed: 'fast' }, model)
    assert.equal(c.speed, 'standard', model)
  }
  assert.equal(calculateCost({ input_tokens: 1_000_000, speed: 'fast' }, 'claude-opus-4-7').input_cost, 5)
})

test('Anthropic fast mode on 1M context is not double-charged as long context', () => {
  const c = calculateCost({ input_tokens: 500_000, output_tokens: 0, speed: 'fast' }, 'claude-opus-5')
  assert.equal(c.long_context, false)
  assert.equal(c.input_cost, 5)
})

test('web search 3 calls bills $0.03 on Anthropic', () => {
  const c = calculateCost(
    { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 3 } },
    'claude-sonnet-5-5',
  )
  assert.equal(c.web_search_requests, 3)
  assert.equal(c.web_search_cost, 0.03)
  assert.equal(c.total_cost, 0.03)
  const cols = costColumnsFromUsage({ input_tokens: 0, web_search_requests: 3 }, 'claude-sonnet-5-5')
  assert.equal(cols.web_search_cost, 0.03)
})

test('normalizeUsage is idempotent and Codex 100k/80k cached becomes 20k', () => {
  const raw = {
    input_tokens: 100_000,
    output_tokens: 2,
    input_tokens_details: { cached_tokens: 80_000 },
  }
  const once = normalizeUsage(raw)
  assert.equal(once.input_tokens, 20_000)
  assert.equal(once.cache_read_tokens, 80_000)
  assert.equal(once.cache_read_input_tokens, 80_000)
  const twice = normalizeUsage(once)
  assert.equal(twice.input_tokens, 20_000)
  assert.equal(twice.cache_read_tokens, 80_000)
  const billed = calculateCost(raw, 'gpt-5.5')
  assert.equal(billed.input_tokens, 20_000)
  assert.equal(billed.cache_read_tokens, 80_000)
})

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`)

function imageUsage(over = {}) {
  return {
    input_tokens: 300,
    input_tokens_details: { text_tokens: 100, image_tokens: 200 },
    output_tokens: 1000,
    output_tokens_details: { image_tokens: 1000, text_tokens: 0 },
    total_tokens: 1300,
    ...over,
  }
}

test('gpt-image-2.5 builtin prices text and image tokens separately', () => {
  for (const id of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst-2026-09-08']) {
    const got = resolvePrice(id)
    assert.equal(got.platform, 'openai')
    assert.equal(got.price.input, 5)
    assert.equal(got.price.cache_read, 1.25)
    assert.equal(got.price.output, 0)
    assert.deepEqual(got.price.image, { input: 8, output: 30, cache_read: 2 })
  }
  assert.equal(resolvePrice('gpt-image-2.5-sunburst-2026-09-08').id, 'gpt-image-2.5-sunburst')
})

test('imageCostFromUsage matches the codex-proxy-rs image token formula', () => {
  const c = imageCostFromUsage(imageUsage(), 'gpt-image-2.5-sunburst')
  assert.equal(c.known, true)
  assert.equal(c.pricing_key, 'gpt-image-2.5-sunburst')
  // 100 text × $5 + 200 image × $8 + 1000 output × $30, per 1M
  close(c.image_cost, 0.0005 + 0.0016 + 0.03)
  assert.equal(c.image_input_tokens, 300)
  assert.equal(c.image_output_tokens, 1000)
})

test('imageCostFromUsage splits cached input only when the split is unambiguous', () => {
  const textOnly = {
    input_tokens: 100,
    input_tokens_details: { text_tokens: 100, image_tokens: 0, cached_tokens: 40 },
    output_tokens: 0,
  }
  close(imageCostFromUsage(textOnly, 'gpt-image-2.5-flare').image_cost, (60 * 5 + 40 * 1.25) / 1e6)
  const imageOnly = {
    input_tokens: 200,
    input_tokens_details: { text_tokens: 0, image_tokens: 200, cached_tokens: 100 },
    output_tokens: 0,
  }
  close(imageCostFromUsage(imageOnly, 'gpt-image-2.5-flare').image_cost, (100 * 8 + 100 * 2) / 1e6)
  const allCached = imageUsage({ input_tokens_details: { text_tokens: 100, image_tokens: 200, cached_tokens: 300 } })
  close(imageCostFromUsage(allCached, 'gpt-image-2.5-flare').image_cost, (100 * 1.25 + 200 * 2 + 1000 * 30) / 1e6)
  const partial = imageUsage({ input_tokens_details: { text_tokens: 100, image_tokens: 200, cached_tokens: 50 } })
  assert.equal(imageCostFromUsage(partial, 'gpt-image-2.5-flare').known, false)
})

test('imageCostFromUsage refuses inconsistent or incomplete usage', () => {
  const bad = [
    imageUsage({ input_tokens: 301 }),
    imageUsage({ total_tokens: 1299 }),
    imageUsage({ output_tokens_details: { image_tokens: 900, text_tokens: 100 } }),
    imageUsage({ input_tokens_details: { text_tokens: 100, image_tokens: 200, cached_tokens: 301 } }),
    { input_tokens: 300, output_tokens: 1000 },
    imageUsage({ output_tokens: -1 }),
    null,
  ]
  for (const usage of bad)
    assert.equal(imageCostFromUsage(usage, 'gpt-image-2.5-flare').known, false, JSON.stringify(usage))
  assert.equal(imageCostFromUsage(imageUsage(), 'gpt-image-9').known, false)
})

test('imageCostFromUsage prices an omitted model at the shared 2.5 price', () => {
  const c = imageCostFromUsage(imageUsage(), null)
  assert.equal(c.known, true)
  close(c.image_cost, 0.0321)
})

test('Responses image tool: main model cost plus image cost', () => {
  const main = { input_tokens: 1000, output_tokens: 100 }
  const plain = costColumnsFromUsage(main, 'gpt-6-luna')
  const both = costColumnsFromUsage(main, 'gpt-6-luna', { usage: imageUsage(), model: 'gpt-image-2.5-flare' })
  assert.equal(plain.image_cost, null)
  close(both.image_cost, 0.0321)
  close(both.total_cost, plain.total_cost + 0.0321)
  assert.equal(both.pricing_model, 'gpt-6-luna')
})

test('Responses image tool with unpriceable image usage leaves the whole row unpriced', () => {
  const row = costColumnsFromUsage({ input_tokens: 1000, output_tokens: 100 }, 'gpt-6-luna', {
    usage: { input_tokens: 300, output_tokens: 1000 },
    model: null,
  })
  assert.equal(row.pricing_model, 'unpriced')
  assert.equal(row.total_cost, null)
  assert.equal(row.image_cost, null)
})

test('Images endpoint rows bill only the image usage', () => {
  const row = costColumnsFromUsage({}, 'gpt-image-2.5-sunburst', {
    usage: imageUsage(),
    model: 'gpt-image-2.5-sunburst',
    only: true,
  })
  assert.equal(row.pricing_model, 'gpt-image-2.5-sunburst')
  close(row.image_cost, 0.0321)
  close(row.total_cost, 0.0321)
  assert.equal(row.input_cost, 0)
  const unpriced = costColumnsFromUsage({}, 'gpt-image-2.5-sunburst', {
    usage: null,
    model: 'gpt-image-2.5-sunburst',
    only: true,
  })
  assert.equal(unpriced.pricing_model, 'unpriced')
  assert.equal(unpriced.total_cost, null)
})

test('cache creation above the TTL split bills the remainder (#678)', () => {
  const usage = {
    input_tokens: 6,
    output_tokens: 1593,
    cache_creation_tokens: 14890,
    cache_creation_5m_tokens: 0,
    cache_creation_1h_tokens: 119,
  }
  const priced = calculateCost(usage, 'claude-opus-5-5')
  const as5m = calculateCost({ ...usage, cache_creation_5m_tokens: 14771 }, 'claude-opus-5-5')
  assert.equal(priced.cache_creation_cost, as5m.cache_creation_cost)
  const pinned = calculateCost({ ...usage, cache_ttl: '1h' }, 'claude-opus-5-5')
  const as1h = calculateCost({ ...usage, cache_creation_1h_tokens: 14890 }, 'claude-opus-5-5')
  assert.equal(pinned.cache_creation_cost, as1h.cache_creation_cost)
})
