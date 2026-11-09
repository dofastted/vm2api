import type { ApiKeyItem } from '@/types/panel-keys'
import { describe, expect, it } from 'vitest'
import {
  keyIsDead,
  keyModelsText,
  keyQuotaLabel,
  keyQuotaPct,
  keyStatusTone,
} from './key-format'

const key = (patch: Partial<ApiKeyItem>): ApiKeyItem => ({
  id: 'k1',
  status: 'active',
  ...patch,
})

describe('API key status and quota', () => {
  it('does not show an exhausted USD key as enabled', () => {
    const k = key({
      status: 'quota_exhausted',
      quota_usd: 5,
      quota_usd_used: 5.2,
    })
    expect(keyStatusTone(k).text).toBe('额度用完')
    expect(keyStatusTone(k).key).toBe('bad')
    expect(keyIsDead(k)).toBe(true)
  })

  it('flags a used-up request quota even while status is active', () => {
    const k = key({ quota_requests: 10, quota_used: 10 })
    expect(keyStatusTone(k).text).toBe('额度用完')
  })

  it('shows the USD quota in the quota column', () => {
    expect(keyQuotaLabel(key({ quota_usd: 5, quota_usd_used: 1.5 }))).toBe(
      '$1.500 / $5.000'
    )
    expect(
      keyQuotaLabel(
        key({
          quota_requests: 100,
          quota_used: 40,
          quota_usd: 5,
          quota_usd_used: 1,
        })
      )
    ).toBe('40 / 100 次 · $1.000 / $5.000')
    expect(keyQuotaLabel(key({ quota_used: 3 }))).toBe('不限 · 已用 3')
  })

  it('progress follows whichever quota is closer to the cap', () => {
    expect(
      keyQuotaPct(
        key({
          quota_requests: 100,
          quota_used: 10,
          quota_usd: 5,
          quota_usd_used: 4,
        })
      )
    ).toBe(80)
    expect(keyQuotaPct(key({}))).toBeNull()
  })

  it('an ordinary key stays enabled', () => {
    expect(keyStatusTone(key({ quota_usd: 5, quota_usd_used: 1 })).text).toBe(
      '启用'
    )
  })
})

describe('API key model allowlist', () => {
  it('reads an empty or missing list as unlimited', () => {
    expect(keyModelsText(key({}))).toEqual({ text: '模型不限' })
    expect(keyModelsText(key({ allowed_models: [] }))).toEqual({
      text: '模型不限',
    })
  })

  it('counts a limited list and lists the names in the title', () => {
    expect(
      keyModelsText(key({ allowed_models: ['claude-sonnet-5', 'gpt-6-sol'] }))
    ).toEqual({ text: '限 2 个模型', title: 'claude-sonnet-5\ngpt-6-sol' })
  })
})
