import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyMinMaxTokens,
  normalizeMinMaxTokensConfig,
  normalizeMinMaxTokensMode,
} from '../../src/lib/protocol/min-max-tokens.mjs'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'

test('raises caller max_tokens below the floor in default mode', () => {
  assert.equal(applyMinMaxTokens({ max_tokens: 1 }, undefined).max_tokens, 128)
  assert.equal(applyMinMaxTokens({ max_tokens: 16 }, { enabled: true, value: 128 }).max_tokens, 128)
  assert.equal(applyMinMaxTokens({ max_tokens: 64 }, { enabled: true, value: 128 }).max_tokens, 128)
  assert.equal(applyMinMaxTokens({ max_tokens: 1 }, { value: 512 }).max_tokens, 512)
})

test('passes through max_tokens at or above the floor', () => {
  assert.equal(applyMinMaxTokens({ max_tokens: 128 }, { value: 128 }).max_tokens, 128)
  assert.equal(applyMinMaxTokens({ max_tokens: 200 }, { value: 128 }).max_tokens, 200)
})

test('不改 mode keeps caller max_tokens below the floor', () => {
  assert.equal(applyMinMaxTokens({ max_tokens: 64 }, { enabled: true, value: 128, mode: '不改' }).max_tokens, 64)
  assert.equal(applyMinMaxTokens({ max_tokens: 1 }, { enabled: true, value: 128, no_raise: true }).max_tokens, 1)
})

test('leaves missing max_tokens alone', () => {
  const missing = { model: 'claude-haiku-4-5' }
  assert.equal(applyMinMaxTokens(missing, {}), missing)
})

test('disabled config passes max_tokens through', () => {
  assert.equal(applyMinMaxTokens({ max_tokens: 1 }, { enabled: false, value: 128 }).max_tokens, 1)
})

test('default floor applies through cli-hop preparation', () => {
  const body = applyMinMaxTokens(
    { model: 'claude-haiku-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'Print integers.' }] },
    { enabled: true, value: 128 },
  )
  assert.equal(prepareCliHopBody(body).max_tokens, 128)
})

test('不改 mode preserves caller budget through cli-hop preparation', () => {
  const body = applyMinMaxTokens(
    { model: 'claude-haiku-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'Print integers.' }] },
    { enabled: true, value: 128, mode: '不改' },
  )
  assert.equal(prepareCliHopBody(body).max_tokens, 64)
})

test('floor config stays clamped', () => {
  assert.deepEqual(normalizeMinMaxTokensConfig({ value: 99999 }), {
    enabled: true,
    value: 4096,
    mode: 'floor',
  })
  assert.deepEqual(normalizeMinMaxTokensConfig({ value: 0 }), {
    enabled: true,
    value: 128,
    mode: 'floor',
  })
  assert.deepEqual(normalizeMinMaxTokensConfig(256), {
    enabled: true,
    value: 256,
    mode: 'floor',
  })
})

test('normalizeMinMaxTokensMode accepts tier aliases', () => {
  assert.equal(normalizeMinMaxTokensMode({ mode: '不改' }), 'preserve')
  assert.equal(normalizeMinMaxTokensMode({ tier: 'preserve' }), 'preserve')
  assert.equal(normalizeMinMaxTokensMode({ raise: false }), 'preserve')
  assert.equal(normalizeMinMaxTokensMode({}), 'floor')
})

test('explicit modes take precedence over legacy raise flags', () => {
  for (const mode of ['preserve', 'unchanged', '不改', ' preserve ']) {
    assert.equal(applyMinMaxTokens({ max_tokens: 64 }, { mode, raise: true }).max_tokens, 64)
  }
  for (const mode of ['floor', 'default', 'raise']) {
    assert.equal(applyMinMaxTokens({ max_tokens: 64 }, { mode, no_raise: true }).max_tokens, 128)
  }
  assert.equal(applyMinMaxTokens({ max_tokens: 64 }, { mode: 'unknown', no_raise: true }).max_tokens, 64)
})

test('enabled thinking keeps max_tokens above budget_tokens', () => {
  const out = applyMinMaxTokens({ max_tokens: 1024, thinking: { type: 'enabled', budget_tokens: 2048 } }, {})
  assert.equal(out.max_tokens, 2048 + 128)
  const adaptive = applyMinMaxTokens({ max_tokens: 1024, thinking: { type: 'adaptive' } }, {})
  assert.equal(adaptive.max_tokens, 1024)
})

test('不改 still pads enabled thinking when budget violates upstream rules', () => {
  const out = applyMinMaxTokens(
    { max_tokens: 1024, thinking: { type: 'enabled', budget_tokens: 2048 } },
    { mode: '不改', value: 64 },
  )
  assert.equal(out.max_tokens, 2048 + 64)
})

test('does not mutate the input body', () => {
  const body = { max_tokens: 1 }
  applyMinMaxTokens(body, {})
  assert.equal(body.max_tokens, 1)
})
