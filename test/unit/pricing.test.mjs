import test from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateCost,
  resolvePricingKey,
  shanghaiDay,
  shanghaiDayStartIso,
  costColumnsFromUsage,
} from '../../src/lib/admin/pricing.mjs'

test('official family aliases resolve to current list prices', () => {
  assert.equal(resolvePricingKey('fable'), 'fable-5')
  assert.equal(resolvePricingKey('opus'), 'opus-5')
  assert.equal(resolvePricingKey('sonnet'), 'sonnet-4')
  assert.equal(resolvePricingKey('haiku'), 'haiku-4.5')
})

test('dated and calling ids map to the official band', () => {
  assert.equal(resolvePricingKey('claude-sonnet-5'), 'sonnet-5')
  assert.equal(resolvePricingKey('claude-opus-5'), 'opus-5')
  assert.equal(resolvePricingKey('claude-fable-5'), 'fable-5')
  assert.equal(resolvePricingKey('claude-haiku-4-5-20251001'), 'haiku-4.5')
  assert.equal(resolvePricingKey('claude-sonnet-4-6'), 'sonnet-4.6')
  assert.equal(resolvePricingKey('claude-opus-4-6'), 'opus-4.5')
  assert.equal(resolvePricingKey('claude-opus-4-1-20250805'), 'opus-4')
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
  assert.equal(resolvePricingKey('claude-opus-5-5'), 'opus-5.5')
  assert.equal(resolvePricingKey('claude-opus-5.5'), 'opus-5.5')
  assert.equal(resolvePricingKey('claude-opus-5'), 'opus-5')
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

test('Fable 5 official: $10 / $50', () => {
  const c = calculateCost({ input_tokens: 100_000, output_tokens: 20_000 }, 'claude-fable-5')
  assert.equal(c.input_cost, 1)
  assert.equal(c.output_cost, 1)
  assert.equal(c.total_cost, 2)
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

test('cache creation without TTL breakdown bills as default 1h', () => {
  const c = calculateCost(
    {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 1_000_000,
    },
    'claude-sonnet-5',
  )
  assert.equal(c.cache_creation_1h_tokens, 1_000_000)
  assert.equal(c.cache_creation_cost, 4)
  assert.equal(c.total_cost, 4)
})

test('OpenAI-shaped usage (prompt_tokens + details) bills like Anthropic', () => {
  const c = calculateCost(
    {
      prompt_tokens: 1_000_000,
      completion_tokens: 1_000_000,
      prompt_tokens_details: { cached_tokens: 1_000_000, cache_creation_tokens: 1_000_000 },
      cache_ttl: '5m',
    },
    'claude-sonnet-5',
  )
  assert.equal(c.input_cost, 2)
  assert.equal(c.output_cost, 10)
  assert.equal(c.cache_read_cost, 0.2)
  assert.equal(c.cache_creation_cost, 2.5)
  assert.equal(c.total_cost, 14.7)
})

test('unknown model stays at zero rather than guessing', () => {
  const c = calculateCost({ input_tokens: 100, output_tokens: 10 }, 'not-a-priced-model')
  assert.equal(c.known, false)
  assert.equal(c.total_cost, 0)
  const cols = costColumnsFromUsage({ input_tokens: 100 }, 'not-a-priced-model')
  assert.equal(cols.total_cost, null)
})

test('GPT-5.5 official standard: $5 / $30 per MTok', () => {
  const c = calculateCost({ input_tokens: 200_000, output_tokens: 200_000 }, 'gpt-5.5')
  assert.equal(c.known, true)
  assert.equal(c.pricing_source, 'openai-official-2026-09')
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
  const solFlex = calculateCost({ input_tokens: 1_000_000, output_tokens: 1_000_000, service_tier: 'flex' }, 'gpt-6-sol')
  assert.equal(solFlex.known, true)
  assert.equal(solFlex.total_cost, 6)

  const lunaFast = calculateCost(
    { input_tokens: 1_000_000, output_tokens: 1_000_000, service_tier: 'priority' },
    'gpt-6-luna',
  )
  assert.equal(lunaFast.known, true)
  assert.equal(lunaFast.service_tier, 'fast')
  assert.equal(lunaFast.total_cost, 1.2)
})

test('gpt-reserve has no published price and stays unbilled', () => {
  const c = calculateCost({ input_tokens: 100, output_tokens: 10 }, 'gpt-reserve')
  assert.equal(c.known, false)
  assert.equal(c.total_cost, 0)
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

test('Sonnet 4.6+ and Opus 4.6+ bill >200K prompts at standard rates (no long-context premium)', () => {
  assert.equal(resolvePricingKey('claude-sonnet-4-6'), 'sonnet-4.6')
  for (const model of ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-opus-5', 'claude-sonnet-5']) {
    const c = calculateCost({ input_tokens: 300_000, output_tokens: 0 }, model)
    assert.equal(c.long_context, false, model)
  }
  const c = calculateCost({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'claude-sonnet-4-6')
  assert.equal(c.total_cost, 18)
})

test('Sonnet 4 / 4.5 long context: >200K prompt (incl. cache) switches the whole request to 2x in / 1.5x out', () => {
  const c = calculateCost(
    {
      input_tokens: 100_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 100_000,
      cache_creation: { ephemeral_5m_input_tokens: 10_000 },
      cache_creation_input_tokens: 10_000,
      cache_ttl: '5m',
    },
    'claude-sonnet-4-5-20250929',
  )
  assert.equal(c.pricing_key, 'sonnet-4')
  assert.equal(c.long_context, true)
  assert.equal(c.input_cost, 0.6)
  assert.equal(c.output_cost, 22.5)
  assert.equal(c.cache_read_cost, 0.06)
  assert.equal(c.cache_creation_5m_cost, 0.075)
})

test('Sonnet 4.5 exactly at 200K stays on standard rates', () => {
  const c = calculateCost({ input_tokens: 150_000, cache_read_input_tokens: 50_000 }, 'claude-sonnet-4-5')
  assert.equal(c.long_context, false)
  assert.equal(c.input_cost, 0.45)
  assert.equal(c.cache_read_cost, 0.015)
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
  assert.equal(fast.total_cost, 8.75)
  const auto = calculateCost({ ...u, service_tier: 'auto' }, 'gpt-5.5')
  assert.equal(auto.total_cost, 3.5)
  // gpt-5.5 publishes no long-fast column → >272K priority is unpriced
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
  assert.equal(o55.input_cost, 8)
  assert.equal(o55.output_cost, 40)
  const o5 = calculateCost(u, 'claude-opus-5')
  assert.equal(o5.input_cost, 10)
  assert.equal(o5.output_cost, 50)
  const o48 = calculateCost(u, 'claude-opus-4-8')
  assert.equal(o48.pricing_key, 'opus-4.5')
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
