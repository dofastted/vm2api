import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import { cragLicenseErrorMessage } from './crag-license-editor'
import { cragSubscriptionErrors } from './crag-subscription-errors'

const message = (code: string) =>
  cragLicenseErrorMessage(new ApiError(code, 409, code))

describe('cragLicenseErrorMessage', () => {
  it('keeps the three redeem conflicts distinguishable', () => {
    const texts = [
      message('host_redeem_conflict'),
      message('license_redeem_conflict'),
      message('payload_key_conflict'),
    ]
    expect(new Set(texts).size).toBe(3)
    expect(texts[0]).toContain('其他宿主机')
    expect(texts[1]).toContain('另一台设备')
    expect(texts[2]).toContain('内核版本冲突')
    expect(texts[1]).not.toContain('内核')
  })

  it('shares one message per subscription code with the host panel', () => {
    for (const [code, text] of Object.entries(cragSubscriptionErrors))
      expect(message(code)).toBe(text)
  })

  it('points a full quota at the two visible numbers and at topping up', () => {
    for (const code of ['slot_limit_reached', 'license_crag_host_over_quota']) {
      const text = message(code)
      expect(text).toContain('使用中的槽位')
      expect(text).toContain('充值可用槽位')
      expect(text).toContain('继续充值')
      expect(text).not.toContain('可用槽位已用完')
    }
  })
})
