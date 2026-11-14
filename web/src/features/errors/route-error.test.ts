import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import { describeRouteError } from './route-error'

describe('route error presentation', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://example.test/a.js?token=secret',
    'Importing a module script failed.',
    'error loading dynamically imported module',
    'Loading chunk 42 failed.',
  ])(
    'identifies a failed page resource without exposing its URL: %s',
    (message) => {
      const result = describeRouteError(new TypeError(message))
      expect(result.title).toBe('页面资源加载失败')
      expect(JSON.stringify(result)).not.toMatch(/secret|https:|500/)
    }
  )

  it('only shows an HTTP status when the API actually supplied it', () => {
    expect(
      describeRouteError(new ApiError('secret', 503)).description
    ).toContain('HTTP 503')
    expect(
      describeRouteError(new ApiError('secret')).description
    ).not.toContain('HTTP')
    expect(describeRouteError(new Error('secret')).title).toBe('页面出现异常')
  })

  it.each([undefined, null, 'secret', new Error('secret')])(
    'does not expose arbitrary thrown values',
    (error) => {
      expect(JSON.stringify(describeRouteError(error))).not.toMatch(
        /secret|500/
      )
    }
  )
})
