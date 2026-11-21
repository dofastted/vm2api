import { describe, expect, it } from 'vitest'
import { STATS_RANGES } from './stats-format'

describe('statistics range wording', () => {
  it('names partial current days as included', () => {
    const labels = Object.fromEntries(
      STATS_RANGES.map((range) => [range.id, range.label])
    )
    expect(labels).toMatchObject({
      today: '今天',
      '7days': '近 7 天（含今天）',
      '30days': '近 30 天（含今天）',
      thisMonth: '本月',
    })
    expect(Object.values(labels).join(' ')).not.toContain('过去')
  })
})
