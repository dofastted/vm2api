import { describe, expect, it, vi } from 'vitest'
import type { VmPatch } from '@/lib/api'
import {
  cchEnabledFromCompat,
  inheritProtocolOnSlots,
  protocolInheritPatch,
} from './protocol-authority'

describe('cchEnabledFromCompat', () => {
  it('disables CCH assignment for explicit false', () => {
    expect(cchEnabledFromCompat({ cch_enabled: false })).toBe(false)
    expect(cchEnabledFromCompat(undefined)).toBe(true)
  })
})

describe('protocolInheritPatch', () => {
  it('returns null when the slot already inherits', () => {
    expect(
      protocolInheritPatch({
        id: 'vm-05',
        persona_preset: '',
        inference_engine: null,
      })
    ).toBeNull()
  })
  it('clears explicit persona so settings → 协议 wins', () => {
    expect(
      protocolInheritPatch({
        id: 'vm-10',
        persona_preset: 'official',
        inference_engine: 'rust',
      })
    ).toEqual({ persona_preset: '' })
  })

  it('does not strip a slot engine on protocol save', () => {
    expect(
      protocolInheritPatch({
        id: 'vm-10',
        persona_preset: '',
        inference_engine: 'go',
      })
    ).toBeNull()
  })

  it('does not inherit Claude engine onto GPT slots', () => {
    expect(
      protocolInheritPatch({
        id: 'vm-gpt',
        platform: 'openai',
        family: 'codex',
        inference_engine: 'rust',
      })
    ).toBeNull()
  })
})

describe('inheritProtocolOnSlots', () => {
  it('patches only slots that override the protocol page', async () => {
    const apply = vi.fn(async (_id: string, _body: VmPatch) => ({}) as const)
    const result = await inheritProtocolOnSlots(
      [
        { id: 'vm-05', persona_preset: 'official', inference_engine: 'rust' },
        { id: 'vm-13', persona_preset: '', inference_engine: null },
      ],
      apply
    )
    expect(result).toEqual({ changed: 1, errors: [] })
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith('vm-05', {
      persona_preset: '',
    })
  })

  it('keeps going when one slot fails', async () => {
    const apply = vi.fn(async (id: string) => {
      if (id === 'vm-05') throw new Error('config_missing')
    })
    const result = await inheritProtocolOnSlots(
      [
        { id: 'vm-05', persona_preset: 'official' },
        { id: 'vm-06', persona_preset: 'zero' },
      ],
      apply
    )
    expect(result.changed).toBe(1)
    expect(result.errors).toEqual([{ id: 'vm-05', message: 'config_missing' }])
  })
})
