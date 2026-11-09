import { describe, expect, it } from 'vitest'
import { defaultRedaction, normalizeRedaction } from '../../src/lib/redaction/policy.mjs'

describe('redaction policy', () => {
  it('treats a missing block as off without inventing protection', () => {
    expect(normalizeRedaction(undefined)).toEqual(defaultRedaction())
  })

  it('rejects coerced booleans and unknown fields', () => {
    expect(() => normalizeRedaction({ enabled: 'false', secrets: true, personal: true })).toThrow(/enabled/)
    expect(() => normalizeRedaction({ enabled: false, secrets: true, personal: true, shape: true })).toThrow(/unknown/)
  })

  it('rejects an enabled policy with nothing to protect', () => {
    expect(() =>
      normalizeRedaction({ enabled: true, secrets: false, personal: false, words: ['  '], rules: [] }),
    ).toThrow(/requires/)
  })

  it('keeps words when the switch is off and drops blanks', () => {
    expect(
      normalizeRedaction({
        enabled: false,
        secrets: true,
        personal: false,
        words: [' 夜莺 ', '夜莺', ''],
        rules: [],
      }),
    ).toEqual({
      enabled: false,
      secrets: true,
      personal: false,
      words: ['夜莺'],
      wordsAnyCase: false,
      rules: [],
      kinds: {},
      allow: [],
    })
  })

  it('keeps kind overrides, case folding, and the allow list', () => {
    expect(
      normalizeRedaction({
        enabled: true,
        secrets: true,
        personal: true,
        words: ['Nightjar'],
        wordsAnyCase: true,
        rules: [{ kind: 'GATEWAY_KEY', prefix: 'oc_sk_' }],
        kinds: { ip: true, home: false },
        allow: [' build-01 '],
      }),
    ).toMatchObject({
      wordsAnyCase: true,
      kinds: { ip: true, home: false },
      allow: ['build-01'],
      rules: [{ kind: 'GATEWAY_KEY', prefix: 'oc_sk_', regex: '' }],
    })
  })
})
