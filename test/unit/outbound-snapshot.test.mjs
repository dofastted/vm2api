import assert from 'node:assert/strict'
import test from 'node:test'
import { capOutboundBody, truncateToTokens } from '../../src/lib/protocol/outbound-snapshot.mjs'

test('the panel keeps the first 10000 tokens of a reported body', () => {
  const cut = truncateToTokens('a'.repeat(40_004))
  assert.equal(cut.text.length, 40_000)
  assert.equal(cut.truncated, true)
  const stored = capOutboundBody('汉'.repeat(10_050))
  assert.equal(stored.length, 10_000)
})
