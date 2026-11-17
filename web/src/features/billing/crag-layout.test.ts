import { describe, expect, it } from 'vitest'
import {
  FEATURED_LABEL_MAX,
  commerceColumnClass,
  densityClass,
  normalizeLayout,
  pickerColumnClass,
} from './crag-layout'

const defaults = {
  planColumns: 2,
  cardDensity: 'regular',
  ordersPosition: 'below',
  showMonthlyPrice: true,
  featuredSku: null,
  featuredLabel: null,
}

describe('normalizeLayout 缺省语义', () => {
  it('空对象解析为约定的缺省排版：2 列 / regular / below / 显示月价 / 无推荐', () => {
    expect(normalizeLayout({})).toEqual(defaults)
  })

  it('缺失、非对象、数组都解析为同一份缺省排版，而不是另一种状态', () => {
    for (const value of [undefined, null, [], 'layout', 1, true])
      expect(normalizeLayout(value)).toEqual(defaults)
    expect(normalizeLayout({})).toEqual(defaults)
  })
})

describe('normalizeLayout 合法取值', () => {
  it('完整 layout 原样解析到驼峰字段', () => {
    expect(
      normalizeLayout({
        plan_columns: 3,
        card_density: 'compact',
        orders_position: 'side',
        show_monthly_price: false,
        featured_sku: 'quarter',
        featured_label: '最超值',
      })
    ).toEqual({
      planColumns: 3,
      cardDensity: 'compact',
      ordersPosition: 'side',
      showMonthlyPrice: false,
      featuredSku: 'quarter',
      featuredLabel: '最超值',
    })
  })

  it('每个列数与枚举值都被接受', () => {
    for (const plan_columns of [1, 2, 3] as const)
      expect(normalizeLayout({ plan_columns })?.planColumns).toBe(plan_columns)
    for (const card_density of ['regular', 'compact'] as const)
      expect(normalizeLayout({ card_density })?.cardDensity).toBe(card_density)
    for (const orders_position of ['below', 'side'] as const)
      expect(normalizeLayout({ orders_position })?.ordersPosition).toBe(
        orders_position
      )
  })

  it('show_monthly_price=false 被保留，不被缺省 true 覆盖', () => {
    expect(
      normalizeLayout({ show_monthly_price: false })?.showMonthlyPrice
    ).toBe(false)
  })
})

describe('normalizeLayout 宽容容错', () => {
  it('非法字段丢弃回落默认，不抛错也不污染其他字段', () => {
    for (const bad of [
      { plan_columns: 0 },
      { plan_columns: 4 },
      { plan_columns: -1 },
      { plan_columns: 2.5 },
      { plan_columns: '2' },
      { plan_columns: null },
      { card_density: 'cozy' },
      { card_density: 1 },
      { orders_position: 'above' },
      { orders_position: true },
      { show_monthly_price: 'true' },
      { show_monthly_price: 1 },
      { featured_sku: '' },
      { featured_sku: '   ' },
      { featured_sku: 42 },
      { featured_sku: null },
      { featured_label: '' },
      { featured_label: 99 },
    ])
      expect(normalizeLayout(bad)).toEqual(defaults)
  })

  it('未知键被忽略，不影响已知字段解析', () => {
    expect(
      normalizeLayout({ plan_columns: 3, hero_video: 'x', nested: { a: 1 } })
    ).toEqual({ ...defaults, planColumns: 3 })
  })

  it('全部字段非法时仍返回默认解析结果', () => {
    expect(normalizeLayout({ plan_columns: 9, card_density: 'x' })).toEqual(
      defaults
    )
  })
})

describe('normalizeLayout featured_label 长度', () => {
  it(`恰好 ${FEATURED_LABEL_MAX} 字被接受`, () => {
    const label = '推'.repeat(FEATURED_LABEL_MAX)
    expect(normalizeLayout({ featured_label: label })?.featuredLabel).toBe(
      label
    )
  })

  it('超长被忽略而非截断，避免产出 Auth 未授权的文案', () => {
    expect(
      normalizeLayout({ featured_label: '推'.repeat(FEATURED_LABEL_MAX + 1) })
        ?.featuredLabel
    ).toBeNull()
  })

  it('按字符数而非 UTF-16 码元计数，emoji 不被误判超长', () => {
    const label = '🎉'.repeat(FEATURED_LABEL_MAX)
    expect(label.length).toBeGreaterThan(FEATURED_LABEL_MAX)
    expect(normalizeLayout({ featured_label: label })?.featuredLabel).toBe(
      label
    )
  })
})

describe('排版类名表', () => {
  it('plan_columns=2 的输出等于各处现有硬编码值，保证默认排版不变', () => {
    expect(pickerColumnClass[2]).toBe('lg:grid-cols-2')
    expect(commerceColumnClass[2]).toBe('sm:grid-cols-2')
  })

  it('单列不带任何 grid-cols 前缀，窄屏恒单列', () => {
    expect(pickerColumnClass[1]).toBe('')
    expect(commerceColumnClass[1]).toBe('')
  })

  it('3 列在 xl 才放开，lg/sm 仍是 2 列', () => {
    expect(pickerColumnClass[3]).toContain('xl:grid-cols-3')
    expect(pickerColumnClass[3]).toContain('lg:grid-cols-2')
    expect(commerceColumnClass[3]).toContain('xl:grid-cols-3')
    expect(commerceColumnClass[3]).toContain('sm:grid-cols-2')
  })

  it('类名是静态字面量，不含模板插值残留', () => {
    for (const table of [pickerColumnClass, commerceColumnClass])
      for (const value of Object.values(table)) expect(value).not.toContain('$')
  })

  it('compact 比 regular 更紧凑', () => {
    expect(densityClass.regular.card).toBe('p-4')
    expect(densityClass.compact.card).toBe('p-3')
    expect(densityClass.regular).not.toEqual(densityClass.compact)
  })
})
