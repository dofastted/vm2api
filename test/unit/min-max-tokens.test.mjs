import test from 'node:test'
import assert from 'node:assert/strict'
import { applyMinMaxTokens, normalizeMinMaxTokensConfig } from '../../src/lib/protocol/min-max-tokens.mjs'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'

test('raises small max_tokens to the default floor', () => {
  assert.equal(applyMinMaxTokens({ max_tokens: 1 }, undefined).max_tokens, 128)
  assert.equal(applyMinMaxTokens({ max_tokens: 16 }, { enabled: true, value: 128 }).max_tokens, 128)
})

test('keeps values at or above the floor and leaves missing max_tokens alone', () => {
  const body = { max_tokens: 200 }
  assert.equal(applyMinMaxTokens(body, {}), body)
  const missing = { model: 'claude-haiku-4-5' }
  assert.equal(applyMinMaxTokens(missing, {}), missing)
})

test('disabled floor passes max_tokens through', () => {
  assert.equal(applyMinMaxTokens({ max_tokens: 1 }, { enabled: false, value: 128 }).max_tokens, 1)
})

test('disabling the floor preserves the caller budget through cli-hop preparation', () => {
  const body = applyMinMaxTokens(
    { model: 'claude-haiku-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'Print integers.' }] },
    { enabled: false },
  )
  assert.equal(prepareCliHopBody(body).max_tokens, 64)
})

test('custom floor value is honored and clamped', () => {
  assert.equal(applyMinMaxTokens({ max_tokens: 1 }, { value: 512 }).max_tokens, 512)
  assert.deepEqual(normalizeMinMaxTokensConfig({ value: 99999 }), { enabled: true, value: 4096 })
  assert.deepEqual(normalizeMinMaxTokensConfig({ value: 0 }), { enabled: true, value: 128 })
})

test('enabled thinking keeps max_tokens above budget_tokens', () => {
  const out = applyMinMaxTokens({ max_tokens: 1024, thinking: { type: 'enabled', budget_tokens: 2048 } }, {})
  assert.equal(out.max_tokens, 2048 + 128)
  const adaptive = applyMinMaxTokens({ max_tokens: 1024, thinking: { type: 'adaptive' } }, {})
  assert.equal(adaptive.max_tokens, 1024)
})

test('does not mutate the input body', () => {
  const body = { max_tokens: 1 }
  applyMinMaxTokens(body, {})
  assert.equal(body.max_tokens, 1)
})
