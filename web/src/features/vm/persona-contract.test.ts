import { describe, expect, it, vi } from 'vitest'
import { patchVm } from '@/lib/api'
import {
  SLOT_PERSONA_OPTIONS,
  normalizeSlotPersonaPreset,
  slotPersonaPatchValue,
} from './persona-contract'

vi.mock('@/lib/session', () => ({
  apiBase: () => '',
  clearSession: vi.fn(),
  hasSession: () => true,
  sessionToken: () => '',
}))

describe('VM persona preset contract', () => {
  it('exposes inherit, official, official_full, zero, and official_303', () => {
    expect(SLOT_PERSONA_OPTIONS.map((option) => option.value)).toEqual([
      'inherit',
      'official',
      'official_full',
      'zero',
      'official_303',
    ])
    expect(normalizeSlotPersonaPreset('303')).toBe('official_303')
  })

  it.each([
    ['inherit', ''],
    ['official', 'official'],
    ['official_full', 'official_full'],
    ['zero', 'zero'],
    ['official_303', 'official_303'],
  ] as const)('maps %s to the Gateway PATCH value %s', (preset, expected) => {
    expect(slotPersonaPatchValue(preset)).toBe(expected)
  })

  it('reads stored official_full instead of collapsing to official', () => {
    expect(normalizeSlotPersonaPreset('official_full')).toBe('official_full')
    expect(normalizeSlotPersonaPreset('official')).toBe('official')
    expect(normalizeSlotPersonaPreset('')).toBe('inherit')
    expect(normalizeSlotPersonaPreset('custom')).toBe('inherit')
  })

  it('encodes the VM id and sends only the per-VM PATCH body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    await patchVm('vm/with spaces', { persona_preset: 'official_full' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/panel/vms/vm%2Fwith%20spaces',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ persona_preset: 'official_full' }),
      })
    )
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain('/routing')
    fetchMock.mockRestore()
  })
})
