import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import {
  accountStatus,
  accountUsable,
  claudeTier,
  credentialStatus,
  fleetCounts,
  fleetGroup,
  isRestrictedSchedule,
  poolStatus,
  restrictionCopy,
  scheduleStateLabel,
  vmCircuit,
  vmCircuitTitle,
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

  it('does not paint quota restriction as 调度关', () => {
    const vm = liveVm({
      schedulable: true,
      schedule_state: 'restricted',
      restriction_reason: 'quota_5h_header',
      restriction_until: Date.now() + 3600_000,
      availability: {
        key: 'quota',
        usable: true,
        text: '5h 限制',
        reason: 'quota_5h_header',
      },
    })
    expect(poolStatus(vm)).toMatchObject({
      key: 'quota',
      text: '5h 限制',
      cls: 'warn',
    })
    expect(accountStatus(vm)).toMatchObject({ key: 'quota', cls: 'warn' })
  })

  it('paints leftover quota-off as restriction, not 调度关', () => {
    const vm = liveVm({
      schedulable: false,
      schedule_disabled_reason: 'quota_5h_header',
      availability: {
        key: 'off',
        usable: false,
        text: '调度关',
        reason: 'quota_5h_header',
      },
    })
    expect(poolStatus(vm)).toMatchObject({
      key: 'quota',
      text: '5h 限制',
      cls: 'warn',
    })
    expect(poolStatus(vm).text).not.toBe('调度关')
    expect(accountStatus(vm).cls).not.toBe('off')
    expect(accountStatus(vm).text).not.toBe('调度关')
  })
})

describe('fleetGroup splits 受限 from 在池 and 关闭调用', () => {
  it('returns restricted when poolStatus is cool or quota', () => {
    const cool = liveVm({
      schedule_state: 'restricted',
      restriction_reason: 'rate_limited',
      restriction_until: Date.now() + 300_000,
      availability: { key: 'cool', usable: true, text: '冷却中' },
    })
    const quota = liveVm({
      schedulable: true,
      schedule_state: 'restricted',
      restriction_reason: 'quota_5h_header',
      restriction_until: Date.now() + 3600_000,
      availability: {
        key: 'quota',
        usable: true,
        text: '5h 限制',
        reason: 'quota_5h_header',
      },
    })
    expect(fleetGroup(cool)).toBe('restricted')
    expect(fleetGroup(quota)).toBe('restricted')
    expect(isRestrictedSchedule(quota)).toBe(true)
    expect(scheduleStateLabel(quota)).toBe('受限')
    expect(restrictionCopy(quota)).toBe('5h 限制')
  })

  it('does not count restricted into 在池', () => {
    const pool = liveVm({ schedule_state: 'on', schedulable: true })
    const restricted = liveVm({
      schedulable: true,
      schedule_state: 'restricted',
      restriction_reason: 'quota_7d_safety',
      availability: {
        key: 'quota',
        usable: true,
        text: '7d 限制',
        reason: 'quota_7d_safety',
      },
    })
    const counts = fleetCounts([pool, restricted])
    expect(fleetGroup(pool)).toBe('pool')
    expect(counts.pool).toBe(1)
    expect(counts.restricted).toBe(1)
    expect(counts.off).toBe(0)
  })

  it('keeps 关闭调用 as operator off only', () => {
    const off = liveVm({
      schedulable: false,
      schedule_state: 'off',
      schedule_manual: true,
      availability: {
        key: 'off',
        usable: false,
        text: '调度关',
        reason: 'disabled',
      },
    })
    const leftoverQuota = liveVm({
      schedulable: false,
      schedule_disabled_reason: 'quota_5h_header',
      availability: {
        key: 'off',
        usable: false,
        text: '调度关',
        reason: 'quota_5h_header',
      },
    })
    expect(fleetGroup(off)).toBe('off')
    expect(scheduleStateLabel(off)).toBe('关')
    expect(fleetGroup(leftoverQuota)).toBe('restricted')
    expect(scheduleStateLabel(leftoverQuota)).toBe('受限')
    expect(fleetCounts([off, leftoverQuota])).toMatchObject({
      off: 1,
      restricted: 1,
      pool: 0,
    })
  })

  it('keeps 5h/7d warning in 在池, not 受限', () => {
    const withAvailability = liveVm({
      schedulable: true,
      schedule_state: 'on',
      near_limit: true,
      utilization_5h: 0.86,
      status_5h: 'allowed_warning',
    })
    const fallback5h = liveVm({
      schedulable: true,
      schedule_state: 'on',
      near_limit: true,
      utilization_5h: 0.86,
      status_5h: 'allowed_warning',
      availability: undefined,
    })
    const fallback7d = liveVm({
      schedulable: true,
      schedule_state: 'on',
      utilization_7d: 0.9,
      status_7d: 'allowed_warning',
      availability: undefined,
    })
    expect(fleetGroup(withAvailability)).toBe('pool')
    expect(isRestrictedSchedule(withAvailability)).toBe(false)
    expect(poolStatus(fallback5h)).toMatchObject({
      key: 'quota',
      text: '5h 警告',
    })
    expect(fleetGroup(fallback5h)).toBe('pool')
    expect(poolStatus(fallback7d)).toMatchObject({
      key: 'quota',
      text: '7d 警告',
    })
    expect(fleetGroup(fallback7d)).toBe('pool')
  })
})

describe('unit circuit', () => {
  const circuit = (over: Partial<NonNullable<Vm['circuit']>> = {}) => ({
    state: 'closed' as const,
    failures: 0,
    threshold: 3,
    open_until: null,
    open_ms: 30000,
    ...over,
  })

  it('closed circuit leaves pool status alone', () => {
    const vm = liveVm({ circuit: circuit() })
    expect(vmCircuit(vm)).toBeNull()
    expect(poolStatus(vm).cls).toBe('ok')
  })

  it('open circuit paints the pool status and counts down', () => {
    const now = 1_000_000
    const vm = liveVm({
      circuit: circuit({
        state: 'open',
        failures: 3,
        open_until: now + 12_000,
      }),
    })
    expect(vmCircuit(vm, now)).toMatchObject({ state: 'open', left: 12_000 })
    expect(vmCircuitTitle(vm, now)).toBe(
      '熔断中 · 连续 3/3 次 5xx · 12s 后放行探测'
    )
    expect(
      poolStatus({
        ...vm,
        circuit: { ...vm.circuit!, open_until: Date.now() + 5000 },
      })
    ).toMatchObject({
      key: 'circuit',
      text: '熔断中',
      cls: 'bad',
    })
  })

  it('expired open reads as half-open probe', () => {
    const vm = liveVm({
      circuit: circuit({ state: 'open', failures: 3, open_until: 10 }),
    })
    expect(vmCircuit(vm, 20)?.state).toBe('half_open')
    expect(poolStatus(vm)).toMatchObject({ text: '熔断探测', cls: 'caution' })
  })

  it('operator off wins over circuit', () => {
    const vm = liveVm({
      schedule_state: 'off',
      schedulable: false,
      availability: { key: 'off', usable: false, text: '调度关' },
      circuit: circuit({
        state: 'open',
        failures: 3,
        open_until: Date.now() + 5000,
      }),
    })
    expect(poolStatus(vm).key).toBe('off')
  })
})
