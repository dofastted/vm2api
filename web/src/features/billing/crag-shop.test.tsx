import type {
  ButtonHTMLAttributes,
  ComponentProps,
  ElementType,
  FormHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from 'react'
import type * as JsxDevRuntime from 'react/jsx-dev-runtime'
import type * as JsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api, cragDeviceApi } from '@/lib/api'
import type { CragHostStatus } from '@/features/vm/queries'
import type { CragCommerce } from './crag-commerce'
import { CragDevicePurchasePage, CragSubscriptionPage } from './crag-shop'

type ConfirmProps = ComponentProps<
  typeof import('@/components/confirm-dialog').ConfirmDialog
>

const state = vi.hoisted(() => ({
  values: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  cursor: 0,
  refCursor: 0,
  role: 'admin',
  user: 'alice',
  authenticated: true,
  targetResult: {} as Record<string, unknown>,
  hostStatus: undefined as CragHostStatus | undefined,
  hostRefetch: vi.fn(),
  upgradeConfirm: undefined as ConfirmProps | undefined,
  setQueryData: vi.fn(),
  invalidateQueries: vi.fn(),
  hostForm: undefined as FormHTMLAttributes<HTMLFormElement> | undefined,
  hostInput: undefined as InputHTMLAttributes<HTMLInputElement> | undefined,
  confirmCancel: undefined as (() => void) | undefined,
  queries: [] as Array<{
    queryKey: readonly unknown[]
    enabled?: boolean
    queryFn: (context: { signal: AbortSignal }) => Promise<unknown>
  }>,
  buttons: [] as ButtonHTMLAttributes<HTMLButtonElement>[],
  commerce: undefined as Parameters<typeof CragCommerce>[0] | undefined,
}))

// Capture the host form handlers without a browser DOM.
function captureHostControls<Rest extends unknown[], Result>(
  jsx: (type: ElementType, props: unknown, ...rest: Rest) => Result
) {
  return (type: ElementType, props: unknown, ...rest: Rest) => {
    if (type === 'form') {
      const form = props as FormHTMLAttributes<HTMLFormElement>
      if (form['aria-label'] === '兑换订阅使用券') state.hostForm = form
    } else if (type === 'input') {
      const input = props as InputHTMLAttributes<HTMLInputElement>
      if (input['aria-describedby'] === 'crag-host-redeem-help')
        state.hostInput = input
    }
    return jsx(type, props, ...rest)
  }
}

vi.mock('react/jsx-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof JsxRuntime>()
  return {
    ...actual,
    jsx: captureHostControls(actual.jsx),
    jsxs: captureHostControls(actual.jsxs),
  }
})
vi.mock('react/jsx-dev-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof JsxDevRuntime>()
  return { ...actual, jsxDEV: captureHostControls(actual.jsxDEV) }
})

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
  useQueryClient: () => ({
    setQueryData: state.setQueryData,
    invalidateQueries: state.invalidateQueries,
  }),
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
    if (options.queryKey[0] === 'crag-host-subscription')
      return { data: state.hostStatus, refetch: state.hostRefetch }
    if (options.queryKey[1] === 'vms') {
      return {
        data: {
          items: [
            { id: 'vm-a', name: '测试槽' },
            { id: 'vm-b', name: '手动目标槽' },
            { id: 'vm-mac', node_platform: 'darwin' },
          ],
        },
      }
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
vi.mock('@/components/confirm-dialog', () => ({
  ConfirmDialog: (props: ConfirmProps) => {
    if (props.title === '启用本机槽位回收？') state.upgradeConfirm = props
    if (props.open && props.confirmText === '取消并释放')
      state.confirmCancel = props.handleConfirm
    return null
  },
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
  cragDeviceApi: vi.fn(),
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

function render(device = false) {
  state.cursor = 0
  state.refCursor = 0
  state.buttons = []
  state.queries = []
  state.commerce = undefined
  state.hostForm = undefined
  state.hostInput = undefined
  state.upgradeConfirm = undefined
  state.confirmCancel = undefined
  return renderToStaticMarkup(
    device ? <CragDevicePurchasePage /> : <CragSubscriptionPage />
  )
}

function click(label: string) {
  const button = state.buttons.find((button) => button.children === label)
  expect(button).toBeDefined()
  button?.onClick?.({} as never)
}

function fillHostCode(value: string) {
  expect(state.hostInput).toBeDefined()
  state.hostInput?.onChange?.({ target: { value } } as never)
  return render()
}

function submitHostCode() {
  expect(state.hostForm).toBeDefined()
  state.hostForm?.onSubmit?.({ preventDefault: vi.fn() } as never)
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  state.role = 'admin'
  state.user = 'alice'
  state.authenticated = true
  state.refs = []
  state.hostStatus = undefined
  state.hostRefetch.mockReset()
  state.hostRefetch.mockResolvedValue(undefined)
  state.setQueryData.mockReset()
  state.setQueryData.mockImplementation((_key, data: CragHostStatus) => {
    state.hostStatus = data
  })
  state.invalidateQueries.mockReset()
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
    false,
    '',
    '',
    undefined,
    undefined,
  ]
  vi.mocked(api).mockReset()
  vi.mocked(api).mockResolvedValue({ ...order, status: 'paid' })
})

describe('CRAG buyer presentation and activation wire', () => {
  it('keeps the subscription voucher form when the catalogue is down', () => {
    state.values[1] = { status: 'error' }
    const html = render()
    expect(html).toContain('自动激活到 vm-a')
    expect(html).toContain('订阅使用券')
    expect(html).toContain('兑换到本机')
    expect(html).not.toContain('手动激活')
    expect(html).not.toContain('CRAG 激活码')
    expect(api).not.toHaveBeenCalled()
  })

  it('scrolls to the order history within the subscription route', () => {
    const section = { focus: vi.fn(), scrollIntoView: vi.fn() }
    const getElementById = vi.fn(() => section)
    vi.stubGlobal('document', { getElementById })
    try {
      expect(render()).toContain('id="crag-order-history"')
      click('查看订单')
      expect(getElementById).toHaveBeenCalledExactlyOnceWith(
        'crag-order-history'
      )
      expect(section.focus).toHaveBeenCalledExactlyOnceWith({
        preventScroll: true,
      })
      expect(section.scrollIntoView).toHaveBeenCalledExactlyOnceWith({
        block: 'start',
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('shows device orders and applies the paid entitlement without a panel login or a voucher', async () => {
    state.authenticated = false
    state.values[3] = [{ ...order, activation: { state: 'ready_to_apply' } }]
    vi.mocked(cragDeviceApi).mockResolvedValue({
      ...order,
      activation: { state: 'active' },
    })
    const page = render(true)
    expect(page).toContain('免登录购买')
    expect(page).toContain('查看订单')
    expect(page).not.toContain('领取兑换码')
    expect(page).not.toContain('手动激活')
    click('应用到本机')
    await settle()
    expect(cragDeviceApi).toHaveBeenCalledExactlyOnceWith(
      '/orders/order-1/apply',
      { method: 'POST', body: '{}' }
    )
    expect(api).not.toHaveBeenCalled()
    expect(render(true)).toContain('订阅额度已加入本机')
  })

  it('shows the slot probe failure without hiding the signed entitlement', () => {
    for (const [status, label] of [
      ['active', '订阅有效'],
      ['expired', '已到期'],
    ] as const) {
      state.hostStatus = {
        state: status,
        ready: false,
        target_probe_failed: true,
      }
      const html = render()
      expect(html).toContain(label)
      expect(html).toContain('探测失败')
      expect(html).toContain('刷新本机订阅」重试探测')
      expect(html).not.toContain('当前没有可绑定的 CRAG 槽位')
    }
  })

  it('shows only the shared remaining capacity, not separate per-license counts', () => {
    state.hostStatus = {
      state: 'active',
      ready: false,
      available_seats: 1,
      activated_slots: [
        { vm_id: 'vm-licensed', scope: 'device', expires_at: 1_900_000_000 },
      ],
    }
    const html = render()
    expect(html).toMatch(/剩余可用槽位<\/dt><dd[^>]*>1<\/dd>/)
    expect(html).toContain('原始状态数据（JSON）')
    expect(html).toContain('vm-licensed')
    expect(html).not.toContain('已绑定 / 可绑定应用锁')
  })

  it('redeems a trimmed host code without a ready slot or checkout target', async () => {
    state.hostStatus = { state: 'unredeemed', ready: false }
    state.targetResult = { data: { targets: [] } }
    const active: CragHostStatus = {
      state: 'active',
      ready: false,
      slot_limit: 2,
      used_slots: 0,
      available_slots: 2,
      available_seats: 2,
    }
    vi.mocked(api).mockResolvedValueOnce(active)

    const html = render()
    expect(html).toContain('当前没有可绑定的 CRAG 槽位')
    expect(html).toContain('订阅使用券')
    expect(html).toContain(
      '每张码从兑换时独立计时，未到期额度相加；不绑定、不启动 VM。'
    )
    expect(state.hostInput?.type).toBe('password')
    fillHostCode('   ')
    expect(
      state.buttons.find((button) => button.children === '兑换到本机')?.disabled
    ).toBe(true)
    submitHostCode()
    expect(api).not.toHaveBeenCalled()

    const code = `CRAGR1.${'a'.repeat(43)}`
    fillHostCode(` ${code} `)
    expect(
      state.buttons.find((button) => button.children === '兑换到本机')?.disabled
    ).toBe(false)
    submitHostCode()
    submitHostCode()
    expect(api).toHaveBeenCalledExactlyOnceWith(
      '/api/panel/crag-subscription/redeem',
      { method: 'POST', body: JSON.stringify({ redemption_code: code }) }
    )
    expect(render()).toContain('正在兑换…')
    expect(state.hostInput?.disabled).toBe(true)

    await settle()
    const updated = render()
    expect(updated).toContain('订阅有效')
    expect(updated).toContain('宿主机额度已更新，未自动绑定 VM')
    expect(updated).toMatch(/剩余可用槽位<\/dt><dd[^>]*>2<\/dd>/)
    expect(updated).not.toContain(code)
    expect(state.hostInput?.value).toBe('')
    expect(state.setQueryData).toHaveBeenCalledExactlyOnceWith(
      ['crag-host-subscription'],
      active
    )
    expect(state.invalidateQueries).toHaveBeenCalledExactlyOnceWith({
      queryKey: ['crag-host-subscription'],
    })
  })

  it('keeps deleted H1 bindings pending until an explicit upgrade refresh confirms capacity', async () => {
    state.hostStatus = {
      state: 'active',
      ready: true,
      reclaim_supported: false,
      upgrade_available: true,
      available_seats: 0,
      reclaim_pending_count: 1,
    }
    state.hostRefetch.mockImplementationOnce(async () => {
      state.hostStatus = {
        ...state.hostStatus!,
        reclaim_supported: true,
        upgrade_available: false,
        available_seats: 1,
        reclaim_pending_count: 0,
      }
    })
    const pending = render()
    expect(pending).toMatch(/剩余可绑定槽位：(?:<!-- -->)?0/)
    expect(pending).toMatch(/待回收绑定：(?:<!-- -->)?1/)
    expect(pending).toContain('旧订阅的已删除绑定待启用槽位回收')
    expect(pending).not.toContain('继续同步')
    expect(api).not.toHaveBeenCalled()
    click('启用槽位回收')
    render()
    expect(state.upgradeConfirm?.open).toBe(true)
    state.upgradeConfirm?.handleConfirm?.()
    await settle()
    expect(api).toHaveBeenCalledExactlyOnceWith(
      '/api/panel/crag-subscription/upgrade',
      { method: 'POST', body: '{}' }
    )
    expect(state.hostRefetch).toHaveBeenCalledTimes(1)
    const updated = render()
    expect(updated).toMatch(/剩余可绑定槽位：(?:<!-- -->)?1/)
    expect(updated).not.toContain('待回收绑定')
    expect(updated).not.toContain('旧订阅的已删除绑定')
  })

  it('can recover confirmed deletion records on an active H2 subscription without redeeming again', async () => {
    state.hostStatus = {
      state: 'active',
      ready: true,
      reclaim_supported: true,
      available_seats: 0,
      reclaim_pending_count: 1,
    }
    vi.mocked(api).mockResolvedValueOnce({
      ...state.hostStatus,
      available_seats: 1,
      reclaim_pending_count: 0,
    })
    expect(render()).toContain('继续同步')
    expect(state.hostInput).toBeDefined()
    click('继续同步')
    await settle()
    expect(api).toHaveBeenCalledExactlyOnceWith(
      '/api/panel/crag-subscription/recover',
      { method: 'POST', body: '{}' }
    )
    const updated = render()
    expect(updated).toMatch(/剩余可绑定槽位：(?:<!-- -->)?1/)
    expect(updated).not.toContain('待回收绑定')
    expect(updated).not.toContain('继续同步')
    expect(updated).toContain('订阅状态已同步')
    expect(state.invalidateQueries).toHaveBeenCalledExactlyOnceWith({
      queryKey: ['crag-host-subscription'],
    })
  })

  it('does not describe a successful H1 sync as reclaiming deleted bindings', async () => {
    state.hostStatus = {
      state: 'sync_pending',
      ready: true,
      reclaim_supported: false,
      reclaim_pending_count: 1,
    }
    vi.mocked(api).mockResolvedValueOnce({
      ...state.hostStatus,
      state: 'active',
      available_seats: 0,
    })
    render()
    click('继续同步')
    await settle()
    const updated = render()
    expect(updated).toContain('仍有绑定待回收确认')
    expect(updated).toMatch(/剩余可绑定槽位：(?:<!-- -->)?0/)
    expect(updated).toMatch(/待回收绑定：(?:<!-- -->)?1/)
    expect(updated).not.toContain('订阅状态已同步')
  })

  it.each([
    ['crag_subscription_invalid_request', '请输入有效的订阅使用券'],
    ['redeem_unavailable', '此码不可用于本机订阅或已失效'],
    ['host_redeem_conflict', '此码与当前宿主机或订阅不匹配'],
    [
      'crag_subscription_host_package_unready',
      '请先在内核页拉取可信 CRAG 发行包',
    ],
    ['unknown', '兑换尚未确认，请刷新或继续同步'],
  ])(
    'keeps the code for retry and reports a safe error for %s',
    async (error, message) => {
      vi.mocked(api).mockRejectedValueOnce(
        new ApiError('private response', 409, error)
      )
      render()
      const code = `CRAGR1.${'b'.repeat(43)}`
      fillHostCode(code)
      submitHostCode()
      await settle()
      const html = render()
      expect(html).toMatch(/role="alert"[^>]*>/)
      expect(html).toContain(`${message}</p>`)
      expect(html).not.toContain('private response')
      expect(state.hostInput?.value).toBe(code)
      expect(state.hostInput?.disabled).toBe(false)
      expect(state.setQueryData).not.toHaveBeenCalled()
      expect(state.invalidateQueries).toHaveBeenCalledExactlyOnceWith({
        queryKey: ['crag-host-subscription'],
      })
    }
  )

  it('lets only admins recover a pending host sync without resubmitting a code', async () => {
    const pending = { state: 'sync_pending', ready: false } as const
    state.hostStatus = pending
    state.role = 'user'
    const buyer = render()
    expect(buyer).not.toContain('订阅使用券')
    expect(buyer).not.toContain('兑换到本机')
    expect(buyer).not.toContain('继续同步')
    expect(api).not.toHaveBeenCalled()

    state.role = 'admin'
    vi.mocked(api).mockResolvedValueOnce(pending)
    expect(render()).not.toContain('兑换到本机')
    click('继续同步')
    await settle()
    const waiting = render()
    expect(api).toHaveBeenCalledExactlyOnceWith(
      '/api/panel/crag-subscription/recover',
      { method: 'POST', body: '{}' }
    )
    expect(waiting).toContain('请核对原订单。订阅使用券只在本页兑换')
    expect(waiting).not.toContain('宿主机额度已更新')

    const active = { state: 'active', ready: false, slot_limit: 3 }
    vi.mocked(api).mockResolvedValueOnce(active)
    click('继续同步')
    await settle()
    const recovered = render()
    expect(recovered).toContain('订阅状态已同步')
    expect(recovered).not.toContain('继续同步')
    expect(recovered).toContain('兑换到本机')
    expect(state.setQueryData).toHaveBeenLastCalledWith(
      ['crag-host-subscription'],
      active
    )
    expect(state.invalidateQueries).toHaveBeenCalledTimes(2)
  })

  it('shows the slot probe failure without hiding the signed entitlement', () => {
    for (const [status, label] of [
      ['active', '订阅有效'],
      ['expired', '已到期'],
    ] as const) {
      state.hostStatus = {
        state: status,
        ready: false,
        target_probe_failed: true,
      }
      const html = render()
      expect(html).toContain(label)
      expect(html).toContain('探测失败')
      expect(html).toContain('刷新本机订阅」重试探测')
      expect(html).not.toContain('当前没有可绑定的 CRAG 槽位')
    }
  })

  it('puts the wider plans section first in actual DOM, with payment feedback above both panes', () => {
    state.values[12] = '付款反馈'
    state.values[13] = '订单错误'
    const html = render()
    const plans = html.indexOf('<section aria-label="订阅套餐"')
    const orders = html.indexOf('<section aria-label="历史订单"')
    expect(plans).toBeGreaterThan(0)
    expect(orders).toBeGreaterThan(plans)
    expect(html.indexOf('付款反馈')).toBeLessThan(plans)
    expect(html.indexOf('订单错误')).toBeLessThan(plans)
    // 缺省排版的订单区在下方（不再因管理员身份旁置）；旁置由
    // orders_position="side" 驱动，见「CRAG 买家页消费 presentation.layout」。
    expect(html).not.toContain('xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]')
    expect(html).not.toContain('order-first')
    expect(html).toMatch(/<option value="" selected="">仅领取兑换码/)
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
    expect(history).toContain('订阅使用券')
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
    state.commerce?.onOrder({ sku: 'quarter' }, 555, 'alipay')
    const body = JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body))
    expect(body.expected_amount_minor).toBe(555)
    expect(body.activation_target).toBeUndefined()
  })

  it.each([
    ['支付宝', 'alipay'],
    ['微信支付', 'wxpay'],
  ])(
    'posts the form to %s directly from the payment button',
    async (label, channel) => {
      state.values[1] = {
        status: 'ready',
        data: { ...catalog, payment_methods: ['alipay', 'wxpay'] },
      }
      const submit = vi.fn()
      const form = {
        append: vi.fn(),
        remove: vi.fn(),
        action: '',
        method: '',
        target: '',
      }
      const append = vi.fn()
      vi.stubGlobal('document', {
        body: { append },
        createElement: (tag: string) => (tag === 'form' ? form : {}),
      })
      vi.stubGlobal('HTMLFormElement', { prototype: { submit } })
      vi.mocked(api).mockResolvedValue({
        ...order,
        status: 'pending',
        payment_method: channel,
        url: 'https://pay.example.test/submit.php',
        data: { type: channel, out_trade_no: order.order_id },
      })
      render()
      click(label)
      await settle()
      expect(
        JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body)).payment_method
      ).toBe(channel)
      expect(form).toMatchObject({
        action: 'https://pay.example.test/submit.php',
        method: 'POST',
        target: '_self',
      })
      expect(form.append).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'type', value: channel })
      )
      expect(append).toHaveBeenCalledWith(form)
      expect(submit).toHaveBeenCalledTimes(1)
      expect(form.remove).toHaveBeenCalledTimes(1)
      expect(render()).not.toContain('订单收银台')
    }
  )

  it('cancels only an eligible reservation after confirmation and retains its history', async () => {
    state.values[3] = [
      { ...order, status: 'reserved', cancelable: true },
      { ...order, order_id: 'pending', status: 'pending' },
    ]
    render()
    expect(
      state.buttons.filter((button) => button.children === '取消预留订单')
    ).toHaveLength(1)
    click('取消预留订单')
    expect(api).not.toHaveBeenCalled()
    vi.mocked(api).mockResolvedValue({ ...order, status: 'cancelled' })
    render()
    state.confirmCancel?.()
    await settle()
    expect(api).toHaveBeenCalledExactlyOnceWith(
      '/api/panel/crag-shop/orders/order-1/cancel',
      { method: 'POST', body: '{}' }
    )
    const html = render()
    expect(html).toContain('已取消')
    expect(html).toContain('订单号 order-1')
    expect(html).not.toContain('取消预留订单')
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

  it('keeps code-only checkout available without automatic targets', () => {
    for (const targetResult of [
      { isFetching: true },
      { isError: true },
      { data: { targets: [] } },
    ]) {
      state.targetResult = targetResult
      render()
      expect(
        state.buttons.find((button) => button.children === '支付宝')?.disabled
      ).toBe(false)
    }
  })

  it('never silently converts an explicit stale target to manual', () => {
    state.values[16] = 'vm-a'
    state.targetResult = {
      data: { targets: [] },
      isError: false,
      isFetching: false,
    }
    const html = render()
    expect(html).toContain('所选目标暂不可用：vm-a')
    expect(html).toMatch(/<option value="vm-a" disabled="" selected="">/)
    click('支付宝')
    expect(api).not.toHaveBeenCalled()
  })

  it('creates an order when crypto.randomUUID is unavailable on HTTP', async () => {
    vi.stubGlobal('crypto', {
      getRandomValues: globalThis.crypto.getRandomValues.bind(
        globalThis.crypto
      ),
    })
    render()
    click('支付宝')
    await settle()
    expect(api).toHaveBeenCalledWith(
      '/api/panel/crag-shop/orders',
      expect.objectContaining({ method: 'POST' })
    )
    const body = JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body))
    expect(body.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
  })

  it.each([
    ['shop_device_unavailable', '无法读取本机宿主设备 ID'],
    ['shop_host_identity_changed', '当前宿主设备 ID 与原订阅不一致'],
    ['shop_private_storage_unavailable', '订单私有存储不可用'],
    ['shop_invalid_reply', '未能确认下单结果。请先查看历史订单'],
  ])(
    'explains checkout failure %s without assuming a changed price',
    async (code, message) => {
      vi.mocked(api).mockRejectedValue(
        new ApiError('opaque failure', 503, code)
      )
      render()
      click('支付宝')
      await settle()
      const html = render()
      expect(html).toContain(message)
      expect(html).not.toContain('opaque failure')
    }
  )

  it('adds only explicitly selected targets to new intents and matches them when retrying', async () => {
    state.values[16] = 'vm-a'
    vi.mocked(api).mockRejectedValue(new Error('unconfirmed'))
    render()
    click('支付宝')
    await settle()
    const first = JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body))
    expect(first.activation_target).toEqual({ vm_id: 'vm-a' })
    state.targetResult = {
      data: { targets: [] },
      isError: false,
      isFetching: false,
    }
    render()
    click('支付宝')
    await settle()
    expect(JSON.parse(String(vi.mocked(api).mock.calls[1][1]?.body))).toEqual(
      first
    )
    state.values[16] = ''
    render()
    click('支付宝')
    await settle()
    const manual = JSON.parse(String(vi.mocked(api).mock.calls[2][1]?.body))
    expect(manual.activation_target).toBeUndefined()
    expect(manual.request_id).not.toBe(first.request_id)
  })

  it('keeps targets out of renewals and resume bodies, including reserved automatic orders', async () => {
    state.values[16] = 'vm-a'
    state.values[1] = { status: 'ready', data: { ...catalog, commerce: rules } }
    render()
    state.commerce?.onOrder({ sku: 'renewal' }, 600, 'alipay')
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
      expect(history).not.toContain('自动给目标槽绑定应用锁')
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

const sideClass = 'xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]'

function withLayout(layout?: Record<string, unknown>) {
  state.values[1] = {
    status: 'ready',
    data: {
      ...catalog,
      ...(layout ? { presentation: { layout } } : {}),
    },
  }
  return render()
}

describe('CRAG 买家页消费 presentation.layout', () => {
  it('无 layout 时按缺省排版处理，订单区在下方且不再看管理员身份', () => {
    for (const role of ['admin', 'user']) {
      state.role = role
      expect(withLayout()).not.toContain(sideClass)
    }
  })

  it('orders_position="side" 对普通买家同样生效', () => {
    state.role = 'user'
    expect(withLayout({ orders_position: 'side' })).toContain(sideClass)
  })

  it('orders_position="below" 覆盖管理员的旁置视图', () => {
    state.role = 'admin'
    expect(withLayout({ orders_position: 'below' })).not.toContain(sideClass)
  })

  it('声明 layout 但不设 orders_position 时按缺省 below 处理', () => {
    state.role = 'admin'
    expect(withLayout({ plan_columns: 3 })).not.toContain(sideClass)
  })

  it('plan_columns 驱动套餐网格列数', () => {
    expect(withLayout({ plan_columns: 3 })).toContain(
      'lg:grid-cols-2 xl:grid-cols-3'
    )
    expect(withLayout({ plan_columns: 1 })).not.toContain('lg:grid-cols-2')
    expect(withLayout()).toContain('lg:grid-cols-2')
  })

  it('card_density 与 featured_sku 透传到套餐卡', () => {
    const html = withLayout({
      card_density: 'compact',
      featured_sku: 'quarter',
      featured_label: '最超值',
    })
    expect(html).toContain('data-density="compact"')
    expect(html).toContain('data-featured="true"')
    expect(html).toContain('最超值')
  })

  it('缺省排版就显示季卡折合月价，show_monthly_price=false 才关闭', () => {
    expect(withLayout()).toContain('约 ¥2 / 月')
    expect(withLayout({ show_monthly_price: true })).toContain('约 ¥2 / 月')
    expect(withLayout({ show_monthly_price: false })).not.toContain('/ 月')
  })

  it('非法 layout 降级为缺省排版而不是让页面崩掉', () => {
    for (const layout of [
      { plan_columns: 9 },
      { orders_position: 'float' },
      { featured_sku: 'missing' },
    ]) {
      state.role = 'user'
      const html = withLayout(layout)
      expect(html).toContain('发布套餐')
      expect(html).not.toContain(sideClass)
      expect(html).not.toContain('data-featured')
    }
  })

  it('layout 透传给报价组件，固定套餐区与选择器排版一致', () => {
    state.values[1] = {
      status: 'ready',
      data: {
        ...catalog,
        commerce: rules,
        presentation: { layout: { plan_columns: 3, card_density: 'compact' } },
      },
    }
    render()
    expect(state.commerce?.layout).toMatchObject({
      planColumns: 3,
      cardDensity: 'compact',
    })
  })

  it('没有 layout 时报价组件收到缺省排版，而不是另一种状态', () => {
    state.values[1] = {
      status: 'ready',
      data: { ...catalog, commerce: rules },
    }
    render()
    expect(state.commerce?.layout).toEqual({
      planColumns: 2,
      cardDensity: 'regular',
      ordersPosition: 'below',
      showMonthlyPrice: true,
      featuredSku: null,
      featuredLabel: null,
    })
  })
})
