import { describe, expect, it } from 'vitest'
import { matchesAllowedModel, toggleAllowedModel } from './allowed-models'

const fable5 = 'claude-fable-5'
const fable51 = 'claude-fable-5-1'
const legacyFable51 = 'claude-fable-5.1'

describe('slot model allowlist compatibility', () => {
  it('checks the canonical model for a saved dotted id', () => {
    expect(matchesAllowedModel(fable51, legacyFable51)).toBe(true)
    expect(matchesAllowedModel(legacyFable51, fable51)).toBe(true)
    expect(matchesAllowedModel(fable51, ' CLAUDE-FABLE-5.1 ')).toBe(true)
  })

  it('keeps Fable 5 and Fable 5.1 independently selectable', () => {
    for (const version51 of [fable51, legacyFable51]) {
      expect(matchesAllowedModel(fable5, version51)).toBe(false)
      expect(matchesAllowedModel(version51, fable5)).toBe(false)
    }
    expect(matchesAllowedModel(fable51, 'claude-fable-5-10')).toBe(false)
    expect(matchesAllowedModel(fable51, 'claude-fable-5-1-20260919')).toBe(true)
    expect(
      matchesAllowedModel('claude-haiku-4-5-20251001', 'claude-haiku-4-5')
    ).toBe(true)
  })

  it('unchecks a saved legacy id without removing Fable 5', () => {
    const saved = [legacyFable51, fable5, 'claude-sonnet-5']
    expect(toggleAllowedModel(saved, fable51, false)).toEqual([
      fable5,
      'claude-sonnet-5',
    ])
    expect(saved).toEqual([legacyFable51, fable5, 'claude-sonnet-5'])
  })

  it('saves canonical ids without duplicate legacy entries', () => {
    expect(toggleAllowedModel([legacyFable51, fable51], fable51, true)).toEqual(
      [fable51]
    )
    expect(toggleAllowedModel(['CLAUDE-FABLE-5-1'], fable51, true)).toEqual([
      fable51,
    ])
    expect(toggleAllowedModel([legacyFable51], fable5, true)).toEqual([
      fable51,
      fable5,
    ])
  })
})
