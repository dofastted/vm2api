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

const picker = {
  sku: 'quarter',
  term: '季卡',
  price: '¥599',
  locks: '10 把应用锁',
} as const

const draft = {
  sku: 'quarter',
  term: '3m',
  amount_minor: 59900,
  slot_limit: 10,
} as const

describe('layout 驱动的套餐卡展示', () => {
  it('缺省不渲染推荐角标与折合月价，保持引入 layout 之前的输出', () => {
    const html = renderToStaticMarkup(<PickerPlanContent plan={picker} />)
    expect(html).not.toContain('/ 月')
    expect(html).not.toContain('bg-primary/10')
    expect(
      renderToStaticMarkup(<CommercePlanContent plan={draft} />)
    ).not.toContain('/ 月')
  })

  it('推荐角标渲染传入文案；两种卡片都支持', () => {
    expect(
      renderToStaticMarkup(
        <PickerPlanContent plan={picker} featured='最超值' />
      )
    ).toContain('最超值')
    expect(
      renderToStaticMarkup(<CommercePlanContent plan={draft} featured='推荐' />)
    ).toContain('推荐')
  })

  it('角标接受 ReactNode，供预览画布塞入内联编辑控件', () => {
    const html = renderToStaticMarkup(
      <PickerPlanContent
        plan={picker}
        featured={<button type='button'>编辑角标</button>}
      />
    )
    expect(html).toContain('<button type="button">编辑角标</button>')
  })

  it('折合月价按传入值渲染，不传则不出现', () => {
    expect(
      renderToStaticMarkup(
        <PickerPlanContent plan={picker} monthly='¥199.67' />
      )
    ).toContain('约 ¥199.67 / 月')
    expect(
      renderToStaticMarkup(
        <CommercePlanContent plan={draft} monthly='¥199.67' />
      )
    ).toContain('约 ¥199.67 / 月')
    expect(
      renderToStaticMarkup(<PickerPlanContent plan={picker} monthly={null} />)
    ).not.toContain('/ 月')
  })

  it('compact 比 regular 收紧内容间距，且不删减任何信息', () => {
    const regular = renderToStaticMarkup(
      <PickerPlanContent plan={picker} density='regular' />
    )
    const compact = renderToStaticMarkup(
      <PickerPlanContent plan={picker} density='compact' />
    )
    expect(regular).toContain('gap-1')
    expect(compact).toContain('gap-0.5')
    expect(regular).not.toEqual(compact)
    for (const html of [regular, compact]) {
      expect(html).toContain('季卡')
      expect(html).toContain('10 把应用锁')
      expect(html).toContain('¥599')
    }
  })

  it('density 缺省等价于 regular，保证既有调用点输出不变', () => {
    expect(renderToStaticMarkup(<PickerPlanContent plan={picker} />)).toBe(
      renderToStaticMarkup(
        <PickerPlanContent plan={picker} density='regular' />
      )
    )
    expect(renderToStaticMarkup(<CommercePlanContent plan={draft} />)).toBe(
      renderToStaticMarkup(
        <CommercePlanContent plan={draft} density='regular' />
      )
    )
  })
})
