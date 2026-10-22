import { describe, expect, it } from 'vitest'
import { keyLimitsPayload, type KeyLimitsDraft } from './key-payload'

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
    })
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
      keyLimitsPayload({ ...draft, allowed_vms: [] }, 'create')
    ).toThrow('至少选择一台 VM')
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
