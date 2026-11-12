import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeRedaction } from '../../src/lib/redaction/policy.mjs'

describe('redaction policy', () => {
  it('rejects coerced booleans and unknown fields', () => {
    assert.throws(() => normalizeRedaction({ enabled: 'false', secrets: true, personal: true }), {
      code: 'invalid_redaction_config',
      status: 400,
    })
    assert.throws(() => normalizeRedaction({ enabled: false, secrets: true, personal: true, shape: true }), {
      code: 'invalid_redaction_config',
      status: 400,
    })
  })

  it('rejects an enabled policy with nothing to protect', () => {
    assert.throws(
      () => normalizeRedaction({ enabled: true, secrets: false, personal: false, words: ['  '], rules: [] }),
      { code: 'invalid_redaction_config', status: 400 },
    )
  })

  it('keeps words when the switch is off and drops blanks', () => {
    const policy = normalizeRedaction({
      enabled: false,
      secrets: true,
      personal: false,
      words: [' 夜莺 ', '夜莺', ''],
      rules: [],
    })
    assert.deepEqual(policy.words, ['夜莺'])
  })

  it('trims rule prefixes and normalizes the allow list', () => {
    const policy = normalizeRedaction({
      enabled: true,
      secrets: true,
      personal: true,
      rules: [{ kind: 'GATEWAY_KEY', prefix: ' oc_sk_ ' }, { prefix: ' ' }],
      allow: [' build-01 ', 'build-01', ''],
    })
    assert.deepEqual(policy.allow, ['build-01'])
    assert.deepEqual(
      policy.rules.map(({ kind, prefix }) => ({ kind, prefix })),
      [{ kind: 'GATEWAY_KEY', prefix: 'oc_sk_' }],
    )
  })
})
