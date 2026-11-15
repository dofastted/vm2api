import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CragPlanPicker } from './crag-plan-picker'

describe('CragPlanPicker', () => {
  it('keeps published order and plain metadata while hiding disabled plans', () => {
    const html = renderToStaticMarkup(
      <CragPlanPicker
        plans={[
          {
            sku: 'second',
            term: '3 个月',
            price: '¥100',
            locks: '2 把应用锁',
            name: '第二套餐',
            description: '<b>说明</b>',
            remaining: 0,
            renewable: false,
          },
          {
            sku: 'hidden',
            term: '1 个月',
            price: '¥1',
            locks: '1 把应用锁',
            enabled: false,
          },
          {
            sku: 'first',
            term: '1 个月',
            price: '¥50',
            locks: '1 把应用锁',
            name: '第一套餐',
            remaining: null,
            renewable: true,
          },
        ]}
        selectedSku='first'
        onSelect={vi.fn()}
      />
    )
    expect(html.indexOf('第二套餐')).toBeLessThan(html.indexOf('第一套餐'))
    expect(html).toContain('&lt;b&gt;说明&lt;/b&gt;')
    expect(html).not.toContain('<b>说明</b>')
    expect(html).not.toContain('value="hidden"')
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*value="second"/)
    expect(html).toContain('3 个月')
    expect(html).toContain('已售罄')
    expect(html).toContain('不可续费')
    expect(html).toContain('可续费')
  })

  it('retains the legacy labels without assuming absent inventory is sold out', () => {
    const html = renderToStaticMarkup(
      <CragPlanPicker
        plans={[
          { sku: 'legacy', term: '月卡', price: '¥50', locks: '1 把应用锁' },
        ]}
        selectedSku='legacy'
        onSelect={vi.fn()}
      />
    )
    expect(html).toContain('月卡')
    expect(html).toContain('1 把应用锁')
    expect(html).not.toContain('disabled=""')
    expect(html).not.toContain('已售罄')
  })
})
