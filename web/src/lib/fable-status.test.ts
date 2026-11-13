import { describe, expect, it } from 'vitest'
import { fableCardInfo, fableState, fableUsedOf } from './fable-status'

describe('Fable quota readings', () => {
  it('uses the returned window regardless of the subscription tier', () => {
    for (const account_tier of ['pro', 'max', 'team', undefined]) {
      const subject = { account_tier, utilization_7d_oi: 0.25 }
      expect(fableUsedOf(subject)).toBe(0.25)
      expect(fableState(subject).usedPct).toBe(25)
      expect(fableCardInfo(subject, 4).usedPct).toBe(25)
    }
  })

  it('keeps a measured zero distinct from absent or invalid readings', () => {
    expect(fableUsedOf({ utilization_7d_oi: 0 })).toBe(0)
    for (const utilization_7d_oi of [
      undefined,
      null,
      '',
      ' ',
      'invalid',
      -1,
      NaN,
    ]) {
      const subject = { account_tier: 'pro', utilization_7d_oi }
      expect(fableUsedOf(subject)).toBeNull()
      expect(fableState(subject).tone.text).toBe('未探测')
      expect(fableCardInfo(subject, 4)).toMatchObject({
        usedPct: null,
        badgeText: '未探测',
        badgeCls: 'none',
      })
    }
  })

  it('retains upstream permission denials without drawing a full usage bar', () => {
    const subject = {
      account_tier: 'pro',
      utilization_7d_oi: 1,
      fable: { status: 403, error: 'Fable requires a Max plan' },
    }
    expect(fableUsedOf(subject)).toBeNull()
    expect(fableState(subject).tone.text).toBe('无 Fable 权限')
    expect(fableCardInfo(subject, 4)).toMatchObject({
      usedPct: null,
      badgeText: '无 Fable 权限',
      badgeCls: 'bad',
    })
  })

  it('includes the returned reset time with a measured window', () => {
    const reset = new Date(Date.now() + 3600_000).toISOString()
    const info = fableCardInfo({ utilization_7d_oi: 0, reset_7d_oi: reset }, 4)
    expect(info.reset).toBe(reset)
    expect(info.bits.some((bit) => bit.includes('后重置'))).toBe(true)
  })
})
