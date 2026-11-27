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
  it('saves Gemini as admin-only OAuth without a VM scope', () => {
    const gemini = {
      ...draft,
      category: 'oauth',
      group_type: 'gemini',
      vm_pool_id: '',
    } as const
    for (const mode of ['create', 'edit'] as const) {
      expect(keyLimitsPayload(gemini, mode)).toMatchObject({
        group_type: 'gemini',
        category: 'oauth',
        allowed_vms: [],
        pool_binding_mode: 'legacy_scope',
        default_pool_id: null,
        allowed_pool_ids: [],
        vm_pool_id: null,
      })
    }
    expect(() =>
      keyLimitsPayload(gemini, 'create', { isAdmin: false })
    ).toThrow('只允许管理员')
    expect(() =>
      keyLimitsPayload({ ...gemini, category: 'api' }, 'create')
    ).toThrow('宿主机 OAuth')
  })

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

  it('sends category and permission fields only for admins', () => {
    const adminPayload = keyLimitsPayload(
      {
        ...draft,
        permission_tier: 'tenant',
        owner_id: 'u_alice',
        allowed_endpoints: ['ep_1', 'ep_1', ' ep_2 '],
        allowed_gemini_envs: ['gem_1', ' '],
      },
      'create',
      { isAdmin: true }
    )
    expect(adminPayload).toMatchObject({
      category: 'api',
      permission_tier: 'tenant',
      owner_id: 'u_alice',
      allowed_endpoints: ['ep_1', 'ep_2'],
      allowed_gemini_envs: ['gem_1'],
    })

    const nonAdmin = keyLimitsPayload(
      {
        ...draft,
        permission_tier: 'tenant',
        owner_id: 'u_alice',
        allowed_endpoints: ['ep_1'],
        allowed_gemini_envs: ['gem_1'],
      },
      'create',
      { isAdmin: false }
    )
    expect(nonAdmin).not.toHaveProperty('category')
    expect(nonAdmin).not.toHaveProperty('permission_tier')
    expect(nonAdmin).not.toHaveProperty('owner_id')
    expect(nonAdmin).not.toHaveProperty('allowed_endpoints')
    expect(nonAdmin).not.toHaveProperty('allowed_gemini_envs')
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
    expect(
      keyLimitsPayload(
        {
          ...draft,
          category: 'all',
          api_endpoint_id: 'ep_tenant',
          group_type: 'anthropic',
          allowed_vms: [],
        },
        'edit'
      )
    ).toMatchObject({
      category: 'all',
      api_endpoint_id: 'ep_tenant',
      group_type: 'anthropic',
      allowed_vms: [],
    })
    expect(
      keyLimitsPayload(
        {
          ...draft,
          category: 'oauth',
          permission_tier: 'tenant',
          owner_id: 'u_alice',
          group_type: 'anthropic',
          allowed_vms: [],
        },
        'edit'
      )
    ).toMatchObject({
      category: 'oauth',
      permission_tier: 'tenant',
      owner_id: 'u_alice',
      group_type: 'anthropic',
      allowed_vms: [],
    })
  })

  it('handles strict_pool & legacy_scope bindings for admin and strips pool fields for non-admin', () => {
    const strictDraft: KeyLimitsDraft = {
      ...draft,
      category: 'oauth',
      group_type: 'all',
      pool_binding_mode: 'strict_pool',
      default_pool_id: 'pool_12345678',
      allowed_pool_ids: ['pool_87654321'],
    }

    const adminCreate = keyLimitsPayload(strictDraft, 'create', {
      isAdmin: true,
    })
    expect(adminCreate).toMatchObject({
      pool_binding_mode: 'strict_pool',
      default_pool_id: 'pool_12345678',
      allowed_pool_ids: ['pool_12345678', 'pool_87654321'],
      vm_pool_id: 'pool_12345678',
      group_type: 'all',
      allowed_vms: [],
    })

    // Empty strict_pool fails closed
    expect(() =>
      keyLimitsPayload(
        {
          ...strictDraft,
          default_pool_id: '',
          allowed_pool_ids: [],
        },
        'create',
        { isAdmin: true }
      )
    ).toThrow('至少选择一个分组池')

    // Legacy mode with cleared pool resets pool fields to null / []
    const adminLegacy = keyLimitsPayload(
      {
        ...draft,
        group_type: 'all',
        pool_binding_mode: 'legacy_scope',
        default_pool_id: '',
        allowed_pool_ids: [],
      },
      'edit',
      { isAdmin: true }
    )
    expect(adminLegacy).toMatchObject({
      pool_binding_mode: 'legacy_scope',
      default_pool_id: null,
      allowed_pool_ids: [],
      vm_pool_id: null,
    })

    // Non-admin payload never carries pool fields
    for (const mode of ['create', 'edit'] as const) {
      const tenant = keyLimitsPayload(strictDraft, mode, { isAdmin: false })
      expect(tenant).not.toHaveProperty('pool_binding_mode')
      expect(tenant).not.toHaveProperty('default_pool_id')
      expect(tenant).not.toHaveProperty('allowed_pool_ids')
      expect(tenant).not.toHaveProperty('vm_pool_id')
      expect(tenant.group_type).toBe('all')
    }
  })
})
