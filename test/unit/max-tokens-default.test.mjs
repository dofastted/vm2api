import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeAnthropicBody } from '../../src/lib/protocol/sanitize.mjs'
import { defaultMaxTokensForModel, getModelParams } from '../../src/lib/protocol/model-policy.mjs'
import { toStandardAnthropicBody } from '../../src/lib/protocol/anthropic-policy.mjs'
import { toClaudeMessages } from '../../src/lib/protocol/convert.mjs'

test('missing max_tokens follows official per-model defaults', () => {
  assert.equal(defaultMaxTokensForModel('claude-haiku-4-5'), 8192)
  assert.equal(defaultMaxTokensForModel('claude-haiku-5-5'), 100000)
  assert.equal(defaultMaxTokensForModel('claude-sonnet-5'), 64000)
  assert.equal(defaultMaxTokensForModel('claude-sonnet-5-5'), 128000)
  assert.equal(defaultMaxTokensForModel('claude-opus-5'), 32000)
  assert.equal(defaultMaxTokensForModel('claude-opus-5-5'), 128000)
  assert.equal(defaultMaxTokensForModel('claude-opus-5.5'), 128000)
  assert.equal(defaultMaxTokensForModel('claude-fable-5'), 32000)
  assert.equal(defaultMaxTokensForModel('not-a-catalog-model'), 16384)
})

test('sanitize fills model default and never overwrites inbound', () => {
  const filled = sanitizeAnthropicBody({
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(filled.max_tokens, 64000)

  const kept = sanitizeAnthropicBody({
    model: 'claude-sonnet-5',
    max_tokens: 512,
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(kept.max_tokens, 512)

  const haiku = sanitizeAnthropicBody({
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(haiku.max_tokens, 8192)
})

test('OpenAI chat convert uses the same per-model default', () => {
  const { claude } = toClaudeMessages('openai.chat', {
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(claude.max_tokens, 32000)
})
test('front protocol cleaning caps oversized budgets without raising explicit caller budgets', () => {
  const model = 'claude-opus-5'
  const cap = Number(getModelParams(model).max_tokens_cap)
  const explicit = Math.floor(cap / 2)
  for (const [requested, expected] of [
    [cap + 1, cap],
    [explicit, explicit],
  ]) {
    const input = {
      model,
      max_tokens: requested,
      messages: [{ role: 'user', content: 'hi' }],
    }
    const out = toStandardAnthropicBody(input).body
    assert.equal(out.max_tokens, expected)
    assert.equal(input.max_tokens, requested)
  }
})
