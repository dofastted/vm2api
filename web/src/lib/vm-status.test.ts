import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import {
  accountStatus,
  accountUsable,
  claudeTier,
  credentialStatus,
  poolStatus,
} from './vm-status'

function liveVm(over: Partial<Vm> = {}): Vm {
  return {
    id: 'vm-05',
    has_token: true,
    has_refresh: true,
    availability: {
      key: 'ok',
      usable: true,
      text: '可用',
    },
    ...over,
  }
}

describe('health probe must not paint a live ticket unavailable', () => {
  it('ignores availability.bad from test-chat credential_refresh_failed', () => {
    const vm = liveVm({
      availability: {
        key: 'bad',
        usable: false,
        text: '无效凭证',
        reason: 'credential_refresh_failed',
      },
      last_probe: {
        at: new Date().toISOString(),
        source: 'test-chat',
        error: 'invalid_grant',
      },
      cred_status: { key: 'bad', text: '无效凭证', tone: 'bad' },
    })
    expect(accountStatus(vm).cls).toBe('ok')
    expect(accountUsable(vm)).toBe(true)
    expect(poolStatus(vm).cls).toBe('ok')
  })

  it('ignores leftover invalid_grant when official /usage probe succeeded', () => {
    const vm = liveVm({
      expires_at: new Date(Date.now() - 3600_000).toISOString(),
      availability: {
        key: 'bad',
        usable: false,
        text: '无效凭证',
        reason: 'credential_refresh_failed',
      },
      last_probe: {
        at: new Date().toISOString(),
        ok: true,
        source: 'official-cc-usage',
        error: null as unknown as string,
        transport: false,
      },
      refresh_error: 'invalid_grant',
      cred_status: { key: 'bad', text: '无效凭证', tone: 'bad' },
    })
    expect(accountStatus(vm).cls).toBe('ok')
    expect(accountUsable(vm)).toBe(true)
    expect(poolStatus(vm)).toMatchObject({ cls: 'ok' })
  })

  it('maps transport probe failure to 探测失败, not 无效凭证', () => {
    const vm = liveVm({
      availability: {
        key: 'bad',
        usable: false,
        text: '无效凭证',
        reason: 'credential_refresh_failed',
      },
      last_probe: {
        at: new Date().toISOString(),
        ok: false,
        source: 'official-cc-usage',
        error:
          'OAuth refresh transport: Post "https://platform.claude.com/v1/oauth/token": SOCKS',
        transport: true,
      },
      worker_credential: {
        last_error_class: 'retryable',
        last_error: 'OAuth refresh transport: SOCKS',
      },
      cred_status: { key: 'bad', text: '无效凭证', tone: 'bad' },
    })
    expect(accountStatus(vm)).toMatchObject({
      cls: 'caution',
      text: '探测失败',
    })
    expect(accountUsable(vm)).toBe(true)
    expect(poolStatus(vm)).toMatchObject({ cls: 'caution', text: '探测失败' })
  })

  it('keeps transport probe as 调度关 when the slot is off', () => {
    const vm = liveVm({
      schedulable: false,
      availability: {
        key: 'bad',
        usable: false,
        text: '无效凭证',
        reason: 'credential_refresh_failed',
      },
      last_probe: {
        ok: false,
        source: 'official-cc-usage',
        transport: true,
        error: 'slot proxy is required',
      },
    })
    expect(poolStatus(vm)).toMatchObject({ cls: 'off', text: '调度关' })
  })

  it('still paints real invalid_grant probe as 无效凭证', () => {
    const vm = liveVm({
      availability: {
        key: 'bad',
        usable: false,
        text: '无效凭证',
        reason: 'credential_refresh_failed',
      },
      last_probe: {
        ok: false,
        source: 'official-cc-usage',
        transport: false,
        error: 'OAuth refresh failed (invalid_grant): Refresh token not found',
      },
      refresh_error: 'invalid_grant',
    })
    expect(poolStatus(vm).cls).toBe('bad')
    expect(accountUsable(vm)).toBe(false)
  })

  it('maps quota to warn, not bad', () => {
    const vm = liveVm({
      availability: {
        key: 'quota',
        usable: true,
        text: '5h 限制',
        reason: 'quota_5h_safety',
      },
    })
    expect(accountStatus(vm)).toMatchObject({ key: 'quota', cls: 'warn' })
    expect(accountUsable(vm)).toBe(true)
  })

  it('maps off before !usable, not bad', () => {
    const vm = liveVm({
      availability: {
        key: 'off',
        usable: false,
        text: '调度关',
        reason: 'disabled',
      },
      schedulable: false,
    })
    expect(accountStatus(vm).cls).toBe('off')
    expect(accountUsable(vm)).toBe(true)
  })

  it('paints parked oauth_invalid_grant as 无效凭证, not 调度关', () => {
    const vm = liveVm({
      schedulable: false,
      schedule_disabled_reason: 'oauth_invalid_grant',
      refresh_error: 'invalid_grant',
      availability: {
        key: 'bad',
        usable: false,
        text: '无效凭证',
        reason: 'credential_refresh_failed',
      },
      last_probe: {
        at: '2026-09-02T17:22:30.178Z',
        ok: true,
        source: 'official-cc-usage',
        error: null as unknown as string,
        transport: false,
      },
      cred_status: { key: 'bad', text: '无效凭证', tone: 'bad' },
    })
    expect(accountStatus(vm)).toMatchObject({
      cls: 'bad',
      text: '无效凭证',
    })
    expect(credentialStatus(vm)).toMatchObject({
      cls: 'bad',
      text: '无效凭证',
    })
    expect(poolStatus(vm)).toMatchObject({ cls: 'bad', text: '无效凭证' })
    expect(accountUsable(vm)).toBe(false)
  })

  it('shows 无效凭证 not English revoke for oauth_revoked', () => {
    const vm = liveVm({
      schedulable: false,
      schedule_disabled_reason: 'oauth_revoked',
      refresh_error: 'oauth_revoked',
      availability: {
        key: 'off',
        usable: false,
        text: '调度关',
        reason: 'oauth_revoked',
      },
    })
    expect(accountStatus(vm)).toMatchObject({
      key: 'revoke',
      text: '无效凭证',
    })
    expect(poolStatus(vm).text).toBe('无效凭证')
  })
})

describe('claudeTier follows usage Fable presence', () => {
  it('treats usage Fable as Max even when stored Pro and hop denied', () => {
    expect(
      claudeTier(
        liveVm({
          account_tier: 'pro',
          usage_has_fable: true,
          fable: { plan_denied: true, ok: false, status: 403 },
        })
      ).key
    ).toBe('max')
  })

  it('treats a real 7d_oi window as Max over stored Pro', () => {
    expect(
      claudeTier(
        liveVm({
          account_tier: 'pro',
          utilization_7d_oi: 0.21,
          reset_7d_oi: '2026-08-24T00:00:00Z',
        })
      ).key
    ).toBe('max')
  })

  it('keeps Pro when usage has no Fable evidence', () => {
    expect(
      claudeTier(
        liveVm({
          account_tier: 'pro',
          fable: { plan_denied: true, status: 403 },
        })
      ).key
    ).toBe('pro')
  })
})
