import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  disjointOpenaiUsage,
  extractOpenaiUsage,
  mergeUsage,
  openaiAnthropicUsageFromExtract,
  openaiChatUsageFromExtract,
  preferUsage,
} from '../../src/lib/protocol/openai-usage.mjs'
import { normalizeUsage } from '../../src/lib/admin/pricing.mjs'

test('extractOpenaiUsage reads input_tokens_details like codex-proxy-rs', () => {
  const usage = extractOpenaiUsage({
    usage: {
      input_tokens: 12,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 3, cache_write_tokens: 4 },
    },
  })
  assert.deepEqual(usage, {
    input_tokens: 12,
    output_tokens: 5,
    cached_tokens: 3,
    cache_write_tokens: 4,
    total_tokens: 17,
  })
})

test('extractOpenaiUsage reads prompt_tokens_details and top-level cached_tokens', () => {
  assert.equal(
    extractOpenaiUsage({
      prompt_tokens: 100,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 80 },
    }).cached_tokens,
    20,
  )
  assert.equal(
    extractOpenaiUsage({
      input_tokens: 8,
      output_tokens: 1,
      cached_tokens: 2,
    }).cached_tokens,
    2,
  )
})

test('extractOpenaiUsage does not invent zeros from empty objects', () => {
  assert.equal(extractOpenaiUsage({}), null)
  assert.equal(extractOpenaiUsage({ foo: 1 }), null)
})

test('Chat usage keeps prompt_tokens_details cache breakdown', () => {
  const chat = openaiChatUsageFromExtract(
    extractOpenaiUsage({
      input_tokens: 41,
      output_tokens: 12,
      input_tokens_details: { cached_tokens: 8, cache_write_tokens: 3 },
    }),
  )
  assert.deepEqual(chat, {
    prompt_tokens: 41,
    completion_tokens: 12,
    total_tokens: 53,
    prompt_tokens_details: { cached_tokens: 8, cache_creation_tokens: 3 },
  })
})

test('Anthropic map uses uncached input plus cache read/write', () => {
  const mapped = openaiAnthropicUsageFromExtract(
    extractOpenaiUsage({
      input_tokens: 100,
      output_tokens: 7,
      input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
    }),
  )
  assert.deepEqual(mapped, {
    input_tokens: 70,
    output_tokens: 7,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 10,
  })
})

test('normalizeUsage reads top-level cached_tokens and cache_write_tokens', () => {
  const n = normalizeUsage({
    input_tokens: 100,
    output_tokens: 10,
    cached_tokens: 25,
    cache_write_tokens: 5,
  })
  assert.equal(n.cache_read_tokens, 25)
  assert.equal(n.cache_creation_tokens, 5)
  assert.equal(n.input_tokens, 70)
  assert.equal(n.cache_read_input_tokens, 25)
})

test('extract does not invent cache write from uncached input', () => {
  const extracted = extractOpenaiUsage({
    input_tokens: 240951,
    output_tokens: 58,
    input_tokens_details: { cached_tokens: 240128 },
  })
  assert.equal(extracted.cached_tokens, 240128)
  assert.equal(extracted.cache_write_tokens, undefined)
  const mapped = openaiAnthropicUsageFromExtract(extracted)
  assert.equal(mapped.input_tokens, 823)
  assert.equal(mapped.cache_read_input_tokens, 240128)
  assert.equal(mapped.cache_creation_input_tokens, undefined)
  const normalized = normalizeUsage({
    input_tokens: 240951,
    output_tokens: 58,
    input_tokens_details: { cached_tokens: 240128 },
  })
  assert.equal(normalized.input_tokens, 823)
  assert.equal(normalized.cache_read_tokens, 240128)
  assert.equal(normalized.cache_creation_tokens, undefined)
  assert.equal(normalized.cache_creation_input_tokens, undefined)
})

test('extract keeps an explicit cache_write_tokens of zero', () => {
  const extracted = extractOpenaiUsage({
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 80, cache_write_tokens: 0 },
  })
  assert.equal(extracted.cache_write_tokens, 0)
  assert.equal(openaiAnthropicUsageFromExtract(extracted).cache_creation_input_tokens, 0)
})

test('Anthropic cache_creation_input_tokens is not OpenAI write evidence', () => {
  const extracted = extractOpenaiUsage({
    input_tokens: 700,
    output_tokens: 50,
    cache_read_input_tokens: 300,
    cache_creation_input_tokens: 50,
    input_tokens_details: { cached_tokens: 300, cache_write_tokens: 50 },
  })
  assert.equal(extracted.cache_write_tokens, undefined)
  const disjoint = disjointOpenaiUsage({
    input_tokens: 700,
    output_tokens: 50,
    cache_read_input_tokens: 300,
    cache_creation_input_tokens: 50,
  })
  assert.equal(disjoint.input_tokens, 700)
  assert.equal(disjoint.cache_read_input_tokens, 300)
  assert.equal(disjoint.cache_creation_input_tokens, 50)
})

test('disjointOpenaiUsage is idempotent and cache-exclusive', () => {
  const raw = {
    input_tokens: 100,
    output_tokens: 7,
    input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
  }
  const once = disjointOpenaiUsage(raw)
  assert.deepEqual(once, {
    input_tokens: 70,
    output_tokens: 7,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 10,
  })
  assert.deepEqual(disjointOpenaiUsage(once), once)
})

test('reasoning_tokens is a subset of output and is never added', () => {
  const extracted = extractOpenaiUsage({
    input_tokens: 10,
    output_tokens: 50,
    output_tokens_details: { reasoning_tokens: 40 },
  })
  assert.equal(extracted.output_tokens, 50)
  assert.equal(extracted.reasoning_tokens, 40)
  const mapped = openaiAnthropicUsageFromExtract(extracted)
  assert.equal(mapped.output_tokens, 50)
  assert.equal(mapped.reasoning_tokens, 40)
  const chat = openaiChatUsageFromExtract(extracted)
  assert.equal(chat.completion_tokens, 50)
  assert.deepEqual(chat.completion_tokens_details, { reasoning_tokens: 40 })
})

test('mergeUsage last-wins without summing tokens or reasoning', () => {
  const merged = mergeUsage(
    {
      input_tokens: 1000,
      output_tokens: 10,
      cache_creation_input_tokens: 500,
      cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 300 },
      output_tokens_details: { reasoning_tokens: 8 },
    },
    {
      output_tokens: 50,
      cache_creation: { ephemeral_5m_input_tokens: 200 },
      output_tokens_details: { reasoning_tokens: 40 },
    },
  )
  assert.equal(merged.input_tokens, 1000)
  assert.equal(merged.output_tokens, 50)
  assert.equal(merged.cache_creation_input_tokens, 500)
  assert.equal(merged.cache_creation.ephemeral_5m_input_tokens, 200)
  assert.equal(merged.cache_creation.ephemeral_1h_input_tokens, 300)
  assert.equal(merged.output_tokens_details.reasoning_tokens, 40)
})

test('mergeUsage preserves non-empty iterations when a later chunk sends empty iterations', () => {
  const iterations = [
    { type: 'message', model: 'claude-sonnet-5', input_tokens: 100, output_tokens: 20 },
    { type: 'advisor_message', model: 'claude-opus-5-5', input_tokens: 300, output_tokens: 40 },
  ]
  const kept = mergeUsage({ input_tokens: 100, iterations }, { output_tokens: 20, iterations: [] })
  assert.deepEqual(kept.iterations, iterations)
  const replaced = mergeUsage(
    { input_tokens: 100, iterations: [{ type: 'message', input_tokens: 100, output_tokens: 5 }] },
    { output_tokens: 20, iterations },
  )
  assert.deepEqual(replaced.iterations, iterations)
})

test('preferUsage keeps inclusive mass and prefers cache detail on a tie', () => {
  const trailer = { input_tokens: 120, output_tokens: 9 }
  const sse = { input_tokens: 120, output_tokens: 9, input_tokens_details: { cached_tokens: 8 } }
  assert.equal(preferUsage(trailer, sse), sse)
  const bigger = { input_tokens: 200, output_tokens: 9 }
  assert.equal(preferUsage(sse, bigger), bigger)
})
