import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { formatPlanDetails, termLabel } from './crag-catalog'
import { CommercePlanContent, PickerPlanContent } from './crag-plan-content'

vi.mock('@/lib/api', () => {
  throw new Error('Shared catalog presentation must not import APIs')
})

describe('shared catalog presentation', () => {
  it('preserves published price and slot formatting, including zero values', () => {
    expect(formatPlanDetails(12345, 2)).toEqual({
      price: '¥123.45',
      locks: '2 把应用锁',
    })
    expect(formatPlanDetails(0, 0)).toEqual({
      price: '¥0',
      locks: '0 把应用锁',
    })
    expect(formatPlanDetails(100, 'unlimited')).toEqual({
      price: '¥1',
      locks: '应用锁不限',
    })
    expect(formatPlanDetails(null, null)).toEqual({
      price: '未定价',
      locks: '槽位待填写',
    })
  })

  it('preserves legacy and explicit-month term labels', () => {
    expect(termLabel('1m', 'monthly')).toBe('月卡')
    expect(termLabel('3m', 'quarterly')).toBe('季卡')
    expect(termLabel('1y', 'yearly')).toBe('年卡')
    expect(termLabel('6m', 'half-year')).toBe('6 个月')
    expect(termLabel('legacy', 'old-plan')).toBe('old-plan')
    expect(termLabel(null, 'renewal')).toBe('续费')
    expect(termLabel('1m', 'renewal', 6)).toBe('续费 · 6 个月')
  })

  it('preserves commerce labels without imposing draft validation on published plans', () => {
    const html = renderToStaticMarkup(
      <CommercePlanContent
        plan={{
          sku: 'legacy',
          term: 'legacy',
          amount_minor: 0,
          slot_limit: 0,
          name: '原套餐',
          description: '<b>原说明</b>',
          remaining: 0,
          renewable: false,
        }}
      />
    )
    expect(html).toContain('原套餐')
    expect(html).toContain('0 槽位 / legacy 个月')
    expect(html).toContain('¥0')
    expect(html).toContain('&lt;b&gt;原说明&lt;/b&gt;')
    expect(html).toContain('首批售罄')
    expect(html).toContain('不可续费')
  })

  it('retains duplicate-term identification and picker metadata', () => {
    const html = renderToStaticMarkup(
      <PickerPlanContent
        plan={{
          sku: 'monthly-second',
          term: '月卡',
          price: '¥50',
          locks: '1 把应用锁',
          name: '第二月卡',
          remaining: 7,
          renewable: true,
        }}
        duplicateTerm
      />
    )
    expect(html).toContain('monthly-second')
    expect(html).toContain('月卡 · 1 把应用锁')
    expect(html).toContain('剩余 7 份')
    expect(html).toContain('可续费')
    expect(html).toContain('text-lg font-bold')
  })
})
