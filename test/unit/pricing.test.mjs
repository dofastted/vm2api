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
  assert.equal(resolvePricingKey('claude-sonnet-4-6'), 'sonnet-4')
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
  const c = calculateCost({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'gpt-5.5')
  assert.equal(c.known, true)
  assert.equal(c.pricing_source, 'openai-official-2026-09')
  assert.equal(c.input_cost, 5)
  assert.equal(c.output_cost, 30)
  assert.equal(c.total_cost, 35)
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
