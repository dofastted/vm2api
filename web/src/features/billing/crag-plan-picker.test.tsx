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

const plans = [
  {
    sku: 'monthly',
    term: '月卡',
    price: '¥59',
    locks: '1 把应用锁',
    monthly: null,
  },
  {
    sku: 'quarter',
    term: '季卡',
    price: '¥599',
    locks: '10 把应用锁',
    monthly: '¥199.67',
  },
] as const

function render(layout?: Parameters<typeof CragPlanPicker>[0]['layout']) {
  return renderToStaticMarkup(
    <CragPlanPicker
      plans={plans}
      selectedSku='quarter'
      onSelect={vi.fn()}
      layout={layout}
    />
  )
}

const base = {
  planColumns: 2,
  cardDensity: 'regular',
  ordersPosition: 'below',
  showMonthlyPrice: true,
  featuredSku: null,
  featuredLabel: null,
} as const

describe('CragPlanPicker 的 layout 排版', () => {
  it('无 layout 时网格与卡片类名保持改动前的硬编码值', () => {
    const html = render()
    expect(html).toContain('class="grid min-w-0 gap-2.5 lg:grid-cols-2"')
    expect(html).toContain('min-h-16')
    expect(html).toContain('p-4')
  })

  it('plan_columns 驱动宽屏列数，窄屏始终无 grid-cols 前缀', () => {
    expect(render({ ...base, planColumns: 1 })).toContain(
      'class="grid min-w-0 gap-2.5"'
    )
    expect(render({ ...base, planColumns: 2 })).toContain('lg:grid-cols-2')
    const three = render({ ...base, planColumns: 3 })
    expect(three).toContain('lg:grid-cols-2 xl:grid-cols-3')
    for (const columns of [1, 2, 3] as const)
      expect(render({ ...base, planColumns: columns })).not.toMatch(
        /class="grid min-w-0 gap-2\.5 grid-cols-/
      )
  })

  it('compact 收紧卡片间距与内边距', () => {
    const html = render({ ...base, cardDensity: 'compact' })
    expect(html).toContain('gap-2 lg:grid-cols-2')
    expect(html).toContain('min-h-14')
    expect(html).toContain('p-3')
    expect(html).toContain('data-density="compact"')
    expect(html).not.toContain('min-h-16')
  })

  it('推荐角标只落在 featured_sku 对应的卡片上', () => {
    const html = render({ ...base, featuredSku: 'quarter' })
    expect(html).toContain('data-featured="true"')
    expect(html.match(/data-featured="true"/g)).toHaveLength(1)
    expect(html).toContain('推荐')
  })

  it('featured_label 覆盖默认「推荐」文案', () => {
    expect(
      render({ ...base, featuredSku: 'quarter', featuredLabel: '最超值' })
    ).toContain('最超值')
  })

  it('featured_sku 指向不存在或已下架的套餐时忽略推荐，不报错', () => {
    for (const featuredSku of ['missing', 'hidden'])
      expect(render({ ...base, featuredSku })).not.toContain('data-featured')
  })

  it('show_monthly_price 控制折合月价显隐；月卡本来就没有月价', () => {
    const shown = render({ ...base, showMonthlyPrice: true })
    expect(shown).toContain('约 ¥199.67 / 月')
    expect(shown.match(/\/ 月/g)).toHaveLength(1)
    expect(render({ ...base, showMonthlyPrice: false })).not.toContain('/ 月')
  })

  it('无 layout 时不显示折合月价，与改动前一致', () => {
    expect(render()).not.toContain('/ 月')
  })
})
