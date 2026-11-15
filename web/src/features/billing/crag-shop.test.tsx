import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import type { CragCommerce } from './crag-commerce'
import { CragSubscriptionPage } from './crag-shop'

const state = vi.hoisted(() => ({
  values: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  cursor: 0,
  refCursor: 0,
  role: 'admin',
  user: 'alice',
  authenticated: true,
  targetResult: {} as Record<string, unknown>,
  queries: [] as Array<{
    queryKey: readonly unknown[]
    enabled?: boolean
    queryFn: (context: { signal: AbortSignal }) => Promise<unknown>
  }>,
  buttons: [] as ButtonHTMLAttributes<HTMLButtonElement>[],
  commerce: undefined as Parameters<typeof CragCommerce>[0] | undefined,
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
  useRef: (initial: unknown) => {
    const index = state.refCursor++
    state.refs[index] ??= { current: initial }
    return state.refs[index]
  },
  useEffect: vi.fn(),
}))
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ setQueryData: vi.fn(), invalidateQueries: vi.fn() }),
  useQuery: (options: { queryKey: readonly unknown[] }) => {
    if (options.queryKey.includes('me'))
      return {
        data: state.authenticated
          ? { user: state.user, role: state.role }
          : undefined,
        isError: !state.authenticated,
      }
    if (options.queryKey.includes('activation-targets')) {
      state.queries.push(options as (typeof state.queries)[number])
      return { refetch: vi.fn(), ...state.targetResult }
    }
    return {
      data: undefined,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    }
  },
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
vi.mock('@/components/page-header', () => ({
  PageHeader: ({
    title,
    description,
    children,
    extra,
  }: {
    title: string
    description: string
    children: ReactNode
    extra?: ReactNode
  }) => (
    <main>
      <h1>{title}</h1>
      <p>{description}</p>
      {extra}
      {children}
    </main>
  ),
}))
vi.mock('@/components/confirm-dialog', () => ({ ConfirmDialog: () => null }))
vi.mock('@/components/ui/dialog', () => {
  const Children = ({ children }: { children: ReactNode }) => children
  return {
    Dialog: Children,
    DialogContent: Children,
    DialogDescription: Children,
    DialogHeader: Children,
    DialogTitle: Children,
  }
})
vi.mock('@/features/vm/crag-host-subscription', () => ({
  CragHostSubscription: ({ initialCode }: { initialCode: string }) => (
    <output aria-label='宿主机兑换码'>{initialCode}</output>
  ),
}))
vi.mock('@/components/ui/button', () => ({
  Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) => {
    state.buttons.push(props)
    return <button disabled={props.disabled}>{props.children}</button>
  },
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: vi.fn(),
}))
vi.mock('./crag-commerce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./crag-commerce')>()),
  CragCommerce: (props: Parameters<typeof CragCommerce>[0]) => {
    state.commerce = props
    return <div aria-label='报价组件' />
  },
}))

const plan = {
  sku: 'quarter',
  term: '3m',
  amount_minor: 600,
  slot_limit: 2,
  name: '发布套餐',
}
const catalog = { plans: [plan], payment_methods: ['alipay'] }
const rules = {
  unit_amount_minor: 100,
  max_amount_minor: 999900,
  max_slots: 10,
  max_months: 12,
  custom_enabled: false,
}
const order = {
  ...plan,
  order_id: 'order-1',
  request_id: 'request-1',
  created_at: 1700000000,
  payment_method: 'alipay',
  status: 'fulfilled',
}

function render() {
  state.cursor = 0
  state.refCursor = 0
  state.buttons = []
  state.queries = []
  state.commerce = undefined
  return renderToStaticMarkup(<CragSubscriptionPage />)
}

function click(label: string) {
  const button = state.buttons.find((button) => button.children === label)
  expect(button).toBeDefined()
  button?.onClick?.({} as never)
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  state.role = 'admin'
  state.user = 'alice'
  state.authenticated = true
  state.refs = []
  state.targetResult = {
    data: { targets: [{ vm_id: 'vm-a' }] },
    isError: false,
    isFetching: false,
  }
  state.values = [
    [],
    { status: 'ready', data: catalog },
    0,
    [],
    0,
    null,
    [],
    false,
    false,
    0,
    'quarter',
    'alipay',
    false,
    '',
    '',
    undefined,
    undefined,
    '',
  ]
  vi.mocked(api).mockReset()
  vi.mocked(api).mockResolvedValue({ ...order, status: 'paid' })
})

describe('CRAG buyer presentation and activation wire', () => {
  it('keeps activation above the catalogue when checkout is closed', () => {
    state.values[1] = { status: 'error' }
    const html = render()
    expect(html).toContain('href="#crag-purchase-activation"')
    expect(html).toContain('href="#crag-order-history"')
    expect(html.indexOf('自动激活（新订单）')).toBeLessThan(
      html.indexOf('<section aria-label="订阅套餐"')
    )
    expect(html).toContain('自动激活到 vm-a')
    click('手动激活')
    expect(render()).toContain('手动激活 CRAG 订阅')
    expect(api).not.toHaveBeenCalled()
  })

  it('passes a claimed code to manual activation without redeeming it automatically', () => {
    const code = `CRAGR1.${'a'.repeat(43)}`
    state.values[3] = [order]
    state.values[16] = { order_id: order.order_id, redemption_code: code }
    render()
    click('使用此码激活')
    expect(render()).toContain(`<output aria-label="宿主机兑换码">${code}`)
    expect(api).not.toHaveBeenCalled()
    state.role = 'user'
    const buyer = render()
    expect(buyer).toContain('href="#crag-order-history"')
    expect(buyer).not.toContain('手动激活 CRAG 订阅')
    expect(buyer).not.toContain('使用此码激活')
    expect(buyer).not.toContain('自动激活（新订单）')
  })

  it('puts the wider plans section first in actual DOM, with payment feedback above both panes', () => {
    state.values[13] = '付款反馈'
    state.values[14] = '订单错误'
    const html = render()
    const plans = html.indexOf('<section aria-label="订阅套餐"')
    const orders = html.indexOf('<section aria-label="历史订单"')
    expect(plans).toBeGreaterThan(0)
    expect(orders).toBeGreaterThan(plans)
    expect(html.indexOf('付款反馈')).toBeLessThan(plans)
    expect(html.indexOf('订单错误')).toBeLessThan(plans)
    expect(html).toContain('xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]')
    expect(html).not.toContain('order-first')
    expect(html).toMatch(/<option value="" selected="">手动激活/)
  })

  it('renders presentation as plain text without rewriting historical snapshots', () => {
    state.values[1] = {
      status: 'ready',
      data: {
        ...catalog,
        plans: [{ ...plan, amount_minor: 999999 }],
        presentation: {
          title: '<b>标题</b>',
          description: '<script>说明</script>',
          plans_title: '已发布套餐',
          orders_title: '购买历史',
        },
      },
    }
    state.values[3] = [order]
    const html = render()
    expect(html).toContain('&lt;b&gt;标题&lt;/b&gt;')
    expect(html).toContain('&lt;script&gt;说明&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html.indexOf('<section aria-label="已发布套餐"')).toBeLessThan(
      html.indexOf('<section aria-label="购买历史"')
    )
    const history = html.slice(html.indexOf('<section aria-label="购买历史"'))
    expect(history).toContain('¥6')
    expect(history).not.toContain('9,999')
    expect(history).toContain('领取兑换码')
    expect(history).toContain('给本槽绑定应用锁')
  })

  it('uses commerce for fixed plans when custom is disabled and keeps renewal metadata independent', () => {
    state.values[1] = {
      status: 'ready',
      data: {
        ...catalog,
        commerce: rules,
        revision: 4,
        presentation: { custom_title: '自选套餐' },
      },
    }
    render()
    expect(state.commerce?.rules.custom_enabled).toBe(false)
    expect(state.commerce?.sku).toBe('quarter')
    expect(state.commerce?.customTitle).toBe('自选套餐')
    expect(state.commerce?.catalogKey).toContain('"revision":4')
    state.commerce?.onOrder({ sku: 'quarter' }, 555)
    const body = JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body))
    expect(body.expected_amount_minor).toBe(555)
    expect(body.activation_target).toBeUndefined()
  })

  it('fetches targets only as admin through the scoped wrapper query', async () => {
    render()
    expect(state.queries[0].enabled).toBe(true)
    expect(state.queries[0].queryKey).toContain('alice')
    const controller = new AbortController()
    await state.queries[0].queryFn({ signal: controller.signal })
    expect(api).toHaveBeenCalledWith(
      '/api/panel/crag-shop/activation-targets',
      { signal: controller.signal, cache: 'no-store' }
    )
    state.role = 'user'
    expect(render()).not.toContain('自动激活到 vm-a')
    expect(state.queries[0].enabled).toBe(false)
    state.authenticated = false
    expect(render()).toBe('')
    expect(state.queries).toHaveLength(0)
  })

  it('distinguishes loading, failure and no targets without removing the manual option', () => {
    for (const [targetResult, text] of [
      [{ isFetching: true }, '正在查询自动激活目标'],
      [{ isError: true }, '读取自动激活目标失败'],
      [{ data: { targets: [] } }, '当前没有可用的自动激活目标'],
    ] as const) {
      state.targetResult = targetResult
      const html = render()
      expect(html).toContain(text)
      expect(html).toContain('手动激活（领码后自行兑换与绑定）')
      expect(
        state.buttons.find((button) => button.children === '创建订单')?.disabled
      ).toBe(false)
    }
  })

  it('never silently converts an explicit stale target to manual', () => {
    state.values[17] = 'vm-a'
    state.targetResult = {
      data: { targets: [] },
      isError: false,
      isFetching: false,
    }
    const html = render()
    expect(html).toContain('所选目标暂不可用：vm-a')
    expect(html).toMatch(/<option value="vm-a" disabled="" selected="">/)
    click('创建订单')
    expect(api).not.toHaveBeenCalled()
  })

  it('adds only explicitly selected targets to new intents and matches them when retrying', async () => {
    state.values[17] = 'vm-a'
    vi.mocked(api).mockRejectedValue(new Error('unconfirmed'))
    render()
    click('创建订单')
    await settle()
    const first = JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body))
    expect(first.activation_target).toEqual({ vm_id: 'vm-a' })
    state.targetResult = {
      data: { targets: [] },
      isError: false,
      isFetching: false,
    }
    render()
    click('创建订单')
    await settle()
    expect(JSON.parse(String(vi.mocked(api).mock.calls[1][1]?.body))).toEqual(
      first
    )
    state.values[17] = ''
    render()
    click('创建订单')
    await settle()
    const manual = JSON.parse(String(vi.mocked(api).mock.calls[2][1]?.body))
    expect(manual.activation_target).toBeUndefined()
    expect(manual.request_id).not.toBe(first.request_id)
  })

  it('keeps targets out of renewals and resume bodies, including reserved automatic orders', async () => {
    state.values[17] = 'vm-a'
    state.values[1] = { status: 'ready', data: { ...catalog, commerce: rules } }
    render()
    state.commerce?.onOrder({ sku: 'renewal' }, 600)
    expect(
      JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body))
        .activation_target
    ).toBeUndefined()
    await settle()
    vi.mocked(api).mockClear()
    state.values[3] = [
      {
        ...order,
        expected_amount_minor: 600,
        status: 'reserved',
        activation: { state: 'awaiting_fulfillment', vm_id: 'vm-a' },
      },
    ]
    render()
    click('继续支付')
    expect(api).toHaveBeenCalledWith(
      '/api/panel/crag-shop/orders/order-1/resume',
      { method: 'POST', body: '{}' }
    )
  })

  it('shows activation separately and never offers manual recovery for targeted orders', () => {
    for (const [activation, label] of [
      ['awaiting_fulfillment', '等待交付后自动激活'],
      ['activating', '正在自动激活'],
      ['active', '原订单已完成激活'],
      ['needs_attention', '激活待处理'],
    ]) {
      state.values[3] = [
        { ...order, activation: { state: activation, vm_id: 'vm-a' } },
      ]
      const html = render()
      const history = html.slice(html.indexOf('<section aria-label="历史订单"'))
      expect(history).toContain('已发码')
      expect(history).toContain(label)
      expect(history).toContain('目标槽位：vm-a')
      expect(history).not.toContain('领取兑换码')
      expect(history).not.toContain('怎样使用兑换码')
      expect(history).not.toContain('给本槽绑定应用锁')
      expect(api).not.toHaveBeenCalled()
    }
  })

  it('allows an admin to requeue only the original paused activation', async () => {
    const pinned = {
      ...order,
      activation: { state: 'needs_attention', vm_id: 'vm-a' },
    }
    state.values[3] = [pinned]
    state.role = 'user'
    expect(render()).not.toContain('重试自动激活')
    state.role = 'admin'
    vi.mocked(api).mockResolvedValue({
      ...pinned,
      activation: { ...pinned.activation, state: 'activating' },
    })
    render()
    click('重试自动激活')
    await settle()
    expect(api).toHaveBeenCalledExactlyOnceWith(
      '/api/panel/crag-shop/orders/order-1/retry-activation',
      { method: 'POST', body: '{}' }
    )
    expect(render()).toContain('正在自动激活')
    expect(
      state.buttons.some((button) => button.children === '重试自动激活')
    ).toBe(false)
  })
})
