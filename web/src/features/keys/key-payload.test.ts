import { describe, expect, it } from 'vitest'
import {
  keyLimitsPayload,
  parseModelList,
  type KeyLimitsDraft,
} from './key-payload'

const draft: KeyLimitsDraft = {
  name: ' ops ',
  category: 'api',
  max_concurrency: 4,
  quota_requests: 12,
  quota_usd: 3.5,
  rpm: 60,
  expires_in_days: 30,
  group_type: 'anthropic',
  allowed_vms: ['vm-01', 'vm-01', ' '],
  allowed_models: '',
}

describe('API key limit payload', () => {
  it('keeps request and USD quotas separate', () => {
    expect(keyLimitsPayload(draft, 'create')).toEqual({
      name: 'ops',
      category: 'api',
      max_concurrency: 4,
      quota_requests: 12,
      quota_usd: 3.5,
      rpm: 60,
      expires_in_days: 30,
      group_type: 'anthropic',
      allowed_vms: ['vm-01'],
      allowed_models: [],
    })
  })

  it('splits allowed models on commas, spaces and new lines, deduping by case', () => {
    expect(
      parseModelList(
        ' claude-sonnet-5, gpt-6-sol，CLAUDE-SONNET-5\nclaude-haiku-4-5  '
      )
    ).toEqual(['claude-sonnet-5', 'gpt-6-sol', 'claude-haiku-4-5'])
    expect(parseModelList(' ,  ')).toEqual([])
  })

  it('sends allowed models on create and edit; empty clears the limit', () => {
    const limited = { ...draft, allowed_models: 'claude-sonnet-5, gpt-6-sol' }
    for (const mode of ['create', 'edit'] as const) {
      expect(keyLimitsPayload(limited, mode).allowed_models).toEqual([
        'claude-sonnet-5',
        'gpt-6-sol',
      ])
      expect(
        keyLimitsPayload(limited, mode, { isAdmin: false }).allowed_models
      ).toEqual(['claude-sonnet-5', 'gpt-6-sol'])
    }
    expect(keyLimitsPayload(draft, 'edit').allowed_models).toEqual([])
    const tooMany = Array.from({ length: 201 }, (_, i) => `m-${i}`).join(',')
    expect(() =>
      keyLimitsPayload({ ...draft, allowed_models: tooMany }, 'create')
    ).toThrow('最多 200 个')
  })

  it('sends category only for admins', () => {
    expect(keyLimitsPayload(draft, 'create', { isAdmin: true }).category).toBe(
      'api'
    )
    expect(
      keyLimitsPayload(draft, 'create', { isAdmin: false })
    ).not.toHaveProperty('category')
    expect(
      keyLimitsPayload(draft, 'edit', { isAdmin: false })
    ).not.toHaveProperty('category')
  })

  it('omits create-only fields from edits and rejects invalid quotas', () => {
    expect(keyLimitsPayload(draft, 'edit')).not.toHaveProperty('name')
    expect(keyLimitsPayload(draft, 'edit')).not.toHaveProperty(
      'expires_in_days'
    )
    expect(() =>
      keyLimitsPayload({ ...draft, quota_requests: 1.5 }, 'create')
    ).toThrow('请求额度')
    expect(() =>
      keyLimitsPayload({ ...draft, quota_usd: -1 }, 'create')
    ).toThrow('USD 额度')
    expect(
      keyLimitsPayload(
        { ...draft, group_type: 'all', allowed_vms: ['vm-01'] },
        'create'
      )
    ).toMatchObject({
      group_type: 'all',
      allowed_vms: [],
    })
    expect(() =>
      keyLimitsPayload(
        { ...draft, category: 'oauth', allowed_vms: [] },
        'create'
      )
    ).toThrow('至少选择一台 VM')
    expect(
      keyLimitsPayload(
        { ...draft, category: 'api', group_type: 'openai', allowed_vms: [] },
        'create'
      )
    ).toMatchObject({
      category: 'api',
      group_type: 'openai',
      allowed_vms: [],
    })
  })

  it('handles vm_pool_id for admin and strips it for non-admin', () => {
    const pooledDraft: KeyLimitsDraft = {
      ...draft,
      group_type: 'pool',
      vm_pool_id: 'pool_12345678',
    }

    // Admin creates key with pool
    const adminCreate = keyLimitsPayload(pooledDraft, 'create', {
      isAdmin: true,
    })
    expect(adminCreate.vm_pool_id).toBe('pool_12345678')
    expect(adminCreate.group_type).toBe('all')
    expect(adminCreate.allowed_vms).toEqual([])

    // Admin edits key with non-pool group_type -> vm_pool_id cleared to null
    const adminEditAll = keyLimitsPayload(
      { ...draft, group_type: 'all', vm_pool_id: 'pool_12345678' },
      'edit',
      { isAdmin: true }
    )
    expect(adminEditAll.vm_pool_id).toBeNull()

    // Non-admin payload must not carry vm_pool_id under any mode or group_type
    const tenantCreate = keyLimitsPayload(
      { ...draft, group_type: 'all', vm_pool_id: 'pool_12345678' },
      'create',
      { isAdmin: false }
    )
    expect(tenantCreate).not.toHaveProperty('vm_pool_id')

    const tenantEdit = keyLimitsPayload(
      { ...draft, group_type: 'all', vm_pool_id: 'pool_12345678' },
      'edit',
      { isAdmin: false }
    )
    expect(tenantEdit).not.toHaveProperty('vm_pool_id')

    // If non-admin passes group_type: 'pool' (e.g. from tampered client state), fallback cleanly without vm_pool_id
    const tenantTampered = keyLimitsPayload(pooledDraft, 'create', {
      isAdmin: false,
    })
    expect(tenantTampered).not.toHaveProperty('vm_pool_id')
    expect(tenantTampered.group_type).toBe('all')
  })
})
