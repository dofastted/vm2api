import type { UsageLogRow } from '@/types/panel-usage-logs'
import { describe, expect, it } from 'vitest'
import { evidenceOf, riskSearch, stageViaFilter } from './model'

describe('risk audit navigation', () => {
  it.each(['distill', 'hard-regex', 'refusal'])(
    'opens the matching preflight rule from a legacy %s link',
    (rule) => {
      expect(riskSearch({ view: rule })).toEqual({ view: 'preflight', rule })
    }
  )

  it('keeps explicit Jev and preflight deep links', () => {
    expect(riskSearch({ view: 'jev', rule: 'refusal' })).toEqual({
      view: 'jev',
    })
    expect(riskSearch({ view: 'preflight', rule: 'refusal' })).toEqual({
      view: 'preflight',
      rule: 'refusal',
    })
  })

  it('defaults to status for previous overview links and unrecognized pages', () => {
    for (const view of [undefined, 'all', 'pass', 'status', 'invalid']) {
      expect(riskSearch({ view, rule: 'refusal' })).toEqual({ view: 'status' })
    }
    expect(riskSearch({ view: 'preflight', rule: 'invalid' })).toEqual({
      view: 'preflight',
      rule: 'distill',
    })
  })

  it('maps refusal_session labels and server-side via filters', () => {
    expect(stageViaFilter('jev')).toBe('jev')
    expect(stageViaFilter('distill')).toBe('distill-detect')
    expect(stageViaFilter('refusal')).toBe('refusal-guard')
    expect(stageViaFilter('all')).toBeUndefined()
    expect(
      evidenceOf({
        via: 'refusal-guard',
        finalState: 'refusal_session',
      } as UsageLogRow)
    ).toBe('封禁会话')
  })
})
