import { describe, expect, it } from 'vitest'
import {
  ccEntrypointFromCompat,
  cchEnabledFromCompat,
} from './protocol-authority'

describe('ccEntrypointFromCompat', () => {
  it('defaults to cli when unset', () => {
    expect(ccEntrypointFromCompat(undefined)).toBe('cli')
    expect(ccEntrypointFromCompat({})).toBe('cli')
  })

  it('honors explicit sdk-cli', () => {
    expect(ccEntrypointFromCompat({ cc_entrypoint: 'sdk-cli' })).toBe('sdk-cli')
  })
})

describe('cchEnabledFromCompat', () => {
  it('disables CCH assignment for explicit false', () => {
    expect(cchEnabledFromCompat({ cch_enabled: false })).toBe(false)
    expect(cchEnabledFromCompat(undefined)).toBe(true)
  })
})
