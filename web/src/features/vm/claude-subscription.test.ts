import { describe, expect, it } from 'vitest'
import { subscriptionDate, subscriptionDateText } from './claude-subscription'

describe('Claude subscription dates', () => {
  it('preserves date-only billing values without a timezone conversion', () => {
    expect(subscriptionDate('2026-11-05', true)).toBe('2026-11-05')
    expect(
      subscriptionDateText({
        configured: true,
        expires_at: '2026-11-05',
        expires_date_only: true,
      })
    ).toBe('到期：2026-11-05')
  })
  it('distinguishes renewal, expiration and unknown dates', () => {
    expect(
      subscriptionDateText({
        configured: true,
        renews_at: '2026-11-05',
        renews_date_only: true,
      })
    ).toBe('续费：2026-11-05')
    expect(subscriptionDateText({ configured: true })).toBe('订阅日期：未知')
    expect(subscriptionDateText(undefined)).toBe('订阅日期：未获取')
  })
})
