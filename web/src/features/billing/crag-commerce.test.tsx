import type { ButtonHTMLAttributes, InputHTMLAttributes } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { CragCommerce, type CommerceRules } from './crag-commerce'
import { normalizeLayout } from './crag-layout'

const state = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  effects: [] as Array<() => void | (() => void)>,
  buttons: [] as ButtonHTMLAttributes<HTMLButtonElement>[],
  inputs: [] as InputHTMLAttributes<HTMLInputElement>[],
}))

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = state.cursor++
    if (index >= state.values.length) state.values[index] = initial
    return [
      state.values[index],
      (next: unknown) => {
        state.values[index] =
          typeof next === 'function' ? next(state.values[index]) : next
      },
    ]
  },
  useEffect: (effect: () => void | (() => void)) => state.effects.push(effect),
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: vi.fn(),
}))
vi.mock('@/components/ui/button', () => ({
  Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) => {
    state.buttons.push(props)
    return <button disabled={props.disabled}>{props.children}</button>
  },
}))
vi.mock('@/components/ui/input', () => ({
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => {
    state.inputs.push(props)
    return <input {...props} />
  },
}))

const rules: CommerceRules = {
  unit_amount_minor: 100,
  max_amount_minor: 999900,
  max_slots: 10,
  max_months: 12,
}
const fixed = {
  sku: 'quarter',
  term: '3m',
  months: 3,
  slot_limit: 2,
  amount_minor: 600,
}
const onOrder = vi.fn()
const cleanups: Array<() => void> = []

function render(overrides: Partial<Parameters<typeof CragCommerce>[0]> = {}) {
  state.cursor = 0
  state.effects = []
  state.buttons = []
  state.inputs = []
  return renderToStaticMarkup(
    <CragCommerce
      rules={rules}
      plans={[fixed]}
      sku='custom'
      onSelect={vi.fn()}
      allowRenewal={false}
      enabled
      busy={false}
      initialQuoteKey={0}
      paymentMethods={['alipay', 'wxpay']}
      onOrder={onOrder}
      layout={normalizeLayout({})}
      {...overrides}
    />
  )
}

async function quote() {
  for (const effect of state.effects) {
    const cleanup = effect()
    if (cleanup) cleanups.push(cleanup)
  }
  await vi.advanceTimersByTimeAsync(300)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  state.values = []
  vi.mocked(api).mockReset()
  onOrder.mockReset()
  vi.mocked(api).mockResolvedValue({
    sku: 'custom',
    months: 1,
    slot_limit: 1,
    subtotal_minor: 900,
    discount_minor: 123,
    amount_minor: 777,
  })
})

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const lastButton = () => state.buttons[state.buttons.length - 1]

describe('CragCommerce', () => {
  it('renders custom dimensions in their own group without editing fixed plans', () => {
    const html = render({ sku: fixed.sku })
    const customGroup = html.split('</fieldset>')[1]
    expect(customGroup).toContain('自定义槽位和时长')
    expect(customGroup).not.toContain('槽位数')
    expect(customGroup).not.toContain('月数')
    const custom = render()
    expect(custom).toContain('槽位数')
    expect(custom).toContain('月数')
    expect(state.inputs.slice(0, 2).every((input) => !input.disabled)).toBe(
      true
    )
  })

  it('initializes published minima and quotes only within the UI ranges', async () => {
    const bounded = {
      ...rules,
      min_slots: 2,
      min_months: 3,
      max_slots: 4,
      max_months: 6,
    }
    render({ rules: bounded })
    expect(state.inputs.slice(0, 2).map((input) => input.value)).toEqual([
      '2',
      '3',
    ])
    await quote()
    expect(JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body))).toEqual({
      sku: 'custom',
      slots: 2,
      months: 3,
    })
    for (const [slots, months] of [
      ['1', '3'],
      ['2', '2'],
      ['5', '3'],
      ['2', '7'],
      ['2.5', '3'],
    ]) {
      state.values[0] = slots
      state.values[1] = months
      vi.mocked(api).mockClear()
      expect(render({ rules: bounded })).toContain('槽位数须为')
      await quote()
      expect(api).not.toHaveBeenCalled()
      expect(lastButton()?.disabled).toBe(true)
    }
    state.values[0] = '4'
    state.values[1] = '6'
    render({ rules: bounded })
    await quote()
    expect(JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body))).toEqual({
      sku: 'custom',
      slots: 4,
      months: 6,
    })
  })

  it('uses legacy defaults and the server quote rather than the displayed estimate', async () => {
    const html = render()
    expect(state.inputs.slice(0, 2).map((input) => input.value)).toEqual([
      '1',
      '1',
    ])
    expect(html).not.toContain('$6')
    await quote()
    render()
    expect(lastButton()?.disabled).toBe(false)
    lastButton()?.onClick?.({} as never)
    expect(onOrder).toHaveBeenCalledWith(
      { sku: 'custom', slots: 1, months: 1 },
      777,
      'wxpay'
    )
  })

  it('hides disabled custom selection and prevents a stale custom quote or order', async () => {
    render()
    await quote()
    vi.mocked(api).mockClear()
    const html = render({ rules: { ...rules, custom_enabled: false } })
    expect(html).not.toContain('自定义槽位和时长')
    expect(html).not.toContain('槽位数')
    expect(html).toContain('此购买选项当前不可用')
    await quote()
    expect(api).not.toHaveBeenCalled()
    expect(lastButton()?.disabled).toBe(true)
    lastButton()?.onClick?.({} as never)
    expect(onOrder).not.toHaveBeenCalled()
  })

  it('quotes fixed plans and renewal independently of the custom flag', async () => {
    for (const sku of ['quarter', 'renewal']) {
      vi.mocked(api).mockClear()
      render({
        rules: { ...rules, custom_enabled: false },
        sku,
        allowRenewal: true,
      })
      await quote()
      expect(JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body))).toEqual(
        { sku }
      )
    }
  })

  it('invalidates quoted prices after catalog refresh, changed metadata, or a disabled plan', async () => {
    vi.mocked(api).mockResolvedValue({
      sku: 'quarter',
      months: 3,
      slot_limit: 2,
      subtotal_minor: 600,
      discount_minor: 0,
      amount_minor: 600,
    })
    render({ sku: 'quarter', catalogKey: 'published-1' })
    await quote()
    render({ sku: 'quarter', catalogKey: 'published-1' })
    expect(lastButton()?.disabled).toBe(false)
    for (const overrides of [
      { catalogKey: 'published-2' },
      { initialQuoteKey: 1 },
      { plans: [{ ...fixed, months: 6 }] },
      { plans: [{ ...fixed, enabled: false }] },
      { plans: [{ ...fixed, remaining: 0 }] },
    ]) {
      render({ sku: 'quarter', catalogKey: 'published-1', ...overrides })
      expect(lastButton()?.disabled).toBe(true)
      lastButton()?.onClick?.({} as never)
    }
    expect(onOrder).not.toHaveBeenCalled()
  })

  it('renders fixed metadata as text in supplier order, including sold-out plans', () => {
    const html = render({
      plans: [
        {
          ...fixed,
          name: '季度优先',
          description: '<b>说明</b>',
          renewable: false,
          remaining: 0,
        },
        { ...fixed, sku: 'hidden', name: '不展示', enabled: false },
        {
          ...fixed,
          sku: 'other',
          name: '后一套餐',
          renewable: true,
          remaining: null,
        },
      ],
    })
    expect(html.indexOf('季度优先')).toBeLessThan(html.indexOf('后一套餐'))
    expect(html).toContain('&lt;b&gt;说明&lt;/b&gt;')
    expect(html).toContain('3 个月')
    expect(html).toContain('首批售罄')
    expect(html).not.toContain('不展示')
  })
})
