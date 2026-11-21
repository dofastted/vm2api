import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TimeFilters } from './time-filters'
import {
  dateWithClockToTimestamp,
  detectQuickPeriod,
  detectQuickTimePreset,
  getQuickTimeRange,
  shiftDateRange,
} from './time-range'

describe('time range helpers', () => {
  const now = new Date(2026, 0, 14, 15, 30) // Wednesday

  it('builds an exclusive end for today and this week', () => {
    const today = getQuickTimeRange('today', now)
    expect(today.endTime - today.startTime).toBe(86_400_000)
    const week = getQuickTimeRange('this-week', now)
    expect(new Date(week.startTime).getDay()).toBe(1)
    expect(week.endTime - week.startTime).toBe(7 * 86_400_000)
    expect(detectQuickTimePreset(week.startTime, week.endTime, now)).toBe(
      'this-week'
    )
  })

  it('detects quick periods and shifts by span', () => {
    expect(detectQuickPeriod('2026-01-08', '2026-01-14', now)).toBe('last7days')
    expect(
      shiftDateRange({ startDate: '2026-01-08', endDate: '2026-01-14' }, 'prev')
    ).toEqual({ startDate: '2026-01-01', endDate: '2026-01-07' })
  })

  it('rejects impossible calendar dates', () => {
    expect(dateWithClockToTimestamp('2026-02-30', '00:00:00')).toBeUndefined()
  })
})

describe('log date preset wording', () => {
  it('names presets as browser calendar days including today', () => {
    const html = renderToStaticMarkup(
      createElement(TimeFilters, {
        filters: {},
        onChange: () => undefined,
      })
    )
    expect(html).toContain('按浏览器时区的自然日')
    expect(html).toContain('近7天（含今天）')
    expect(html).toContain('近30天（含今天）')
    expect(html).toContain('>昨天<')
  })
})
