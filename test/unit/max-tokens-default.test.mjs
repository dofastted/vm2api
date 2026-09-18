import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeAnthropicBody } from '../../src/lib/protocol/sanitize.mjs'
import { defaultMaxTokensForModel } from '../../src/lib/protocol/model-policy.mjs'
import { toClaudeMessages } from '../../src/lib/protocol/convert.mjs'

test('missing max_tokens follows official per-model defaults', () => {
  assert.equal(defaultMaxTokensForModel('claude-haiku-4-5'), 8192)
  assert.equal(defaultMaxTokensForModel('claude-sonnet-5'), 16384)
  assert.equal(defaultMaxTokensForModel('claude-opus-5'), 32000)
  assert.equal(defaultMaxTokensForModel('claude-fable-5'), 32000)
  assert.equal(defaultMaxTokensForModel('not-a-catalog-model'), 16384)
})

test('sanitize fills model default and never overwrites inbound', () => {
  const filled = sanitizeAnthropicBody({
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(filled.max_tokens, 16384)

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
