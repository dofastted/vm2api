import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import { keyLimitsPayload, type KeyLimitsDraft } from './key-payload'
import { keyVmSelection } from './key-vm-selection'

const draft: KeyLimitsDraft = {
  name: 'tenant-client',
  category: 'oauth',
  max_concurrency: 2,
  quota_requests: 0,
  quota_usd: 7,
  rpm: 30,
  expires_in_days: 0,
  group_type: 'anthropic',
  allowed_vms: ['previous-owner-vm'],
  allowed_models: 'claude-sonnet-4-6',
}
const inventory = [
  { id: 'vm-04', platform: 'anthropic' },
  { id: 'gpt-slot', platform: 'openai' },
] as Vm[]

describe('key VM selection after reassignment', () => {
  it('submits only the visible checked VM, excluding an invisible old selection', () => {
    const selected = {
      ...draft,
      allowed_vms: ['previous-owner-vm', 'vm-04', 'vm-04'],
    }
    const result = keyVmSelection(selected, inventory, true)
    expect(result.blocked).toBe(false)
    expect(result.removed).toEqual(['previous-owner-vm'])
    expect(
      keyLimitsPayload(result.draft, 'edit', { isAdmin: false })
    ).toMatchObject({
      group_type: 'anthropic',
      allowed_vms: ['vm-04'],
      max_concurrency: 2,
      quota_usd: 7,
      rpm: 30,
      allowed_models: ['claude-sonnet-4-6'],
    })
    expect(selected.allowed_vms).toHaveLength(3)
  })

  it('requires explicit selection instead of assigning another VM automatically', () => {
    const result = keyVmSelection(draft, inventory, true)
    expect(result.blocked).toBe(true)
    expect(result.draft.allowed_vms).toEqual([])
    expect(() => keyLimitsPayload(result.draft, 'edit')).toThrow(
      '至少选择一台 VM'
    )
  })

  it('preserves the draft while the inventory is loading, refetching or failed', () => {
    for (const vms of [[], inventory]) {
      const result = keyVmSelection(draft, vms, false)
      expect(result.blocked).toBe(true)
      expect(result.draft).toBe(draft)
      expect(result.removed).toEqual([])
    }
    const result = keyVmSelection(draft, [], true)
    expect(result.draft.allowed_vms).toEqual([])
    expect(result.blocked).toBe(true)
  })

  it('reconciles inventory changes without resetting edited fields', () => {
    const edited = {
      ...draft,
      quota_usd: 11,
      allowed_vms: ['vm-04', 'gpt-slot'],
    }
    const result = keyVmSelection(edited, inventory, true)
    expect(result.draft.allowed_vms).toEqual(['vm-04'])
    expect(result.draft.quota_usd).toBe(11)
    const revoked = keyVmSelection(edited, [], true)
    expect(revoked.blocked).toBe(true)
    const restored = keyVmSelection(edited, inventory, true)
    expect(restored.draft.allowed_vms).toEqual(['vm-04'])
    expect(restored.draft.quota_usd).toBe(11)
  })

  it('preserves API, global, pool and Gemini semantics', () => {
    const cases: KeyLimitsDraft[] = [
      { ...draft, category: 'api' },
      ...(['all', 'pool', 'gemini'] as const).map((group_type) => ({
        ...draft,
        group_type,
      })),
    ]
    for (const value of cases) {
      const result = keyVmSelection(value, [], false)
      expect(result.draft).toBe(value)
      expect(result.blocked).toBe(false)
    }
  })
})
