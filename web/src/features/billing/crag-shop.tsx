import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { VIEW_TITLES } from '@/config/nav'
import { api, isApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/page-header'

const root = '/api/panel/crag-shop'
const terms = { '1m': '月卡', '3m': '季卡', '1y': '年卡' }
const methods = { wxpay: '微信支付', alipay: '支付宝' }
type Method = keyof typeof methods
type Plan = {
  sku: string
  term: keyof typeof terms
  amount_minor: number
  slot_limit: number | 'unlimited'
}
type Order = {
  sku: string
  term: Plan['term'] | null
  amount_minor: Plan['amount_minor'] | null
  slot_limit: Plan['slot_limit'] | null
  order_id: string
  request_id?: string
  payment_method: Method
  status: 'reserved' | 'pending' | 'paid' | 'fulfilled'
}
type Checkout = Order & { url?: string; data?: Record<string, string> }
type OrderPage = { orders: Order[]; next_offset: number | null }
type Intent = { sku: string; payment_method: Method; request_id: string }
const money = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'CNY',
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
})

function planTerms(plan: Pick<Order, 'amount_minor' | 'slot_limit'>) {
  if (plan.amount_minor === null || plan.slot_limit === null)
    return '金额与应用锁待确认'
  return `${money.format(plan.amount_minor / 100)} · ${plan.slot_limit === 'unlimited' ? '应用锁不限' : `${plan.slot_limit} 把应用锁`}`
}

export function CragShopLink() {
  return (
    <Button variant='outline' size='sm' asChild>
      <Link to='/crag-subscription'>{VIEW_TITLES['crag-subscription']}</Link>
    </Button>
  )
}

export function CragSubscriptionPage() {
  return (
    <PageHeader
      title={VIEW_TITLES['crag-subscription']}
      description='每单一枚兑换码，仅限一台受支持的宿主机。购买前请确认内核支持宿主订阅；付款后在本人订单领取兑换码。'
    >
      <ShopOrders />
    </PageHeader>
  )
}

function ShopOrders() {
  const [catalog, setCatalog] = useState<{
    plans: Plan[]
    payment_methods: Method[]
  }>()
  const [orders, setOrders] = useState<Order[]>()
  const [offset, setOffset] = useState(0)
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [staleOrders, setStaleOrders] = useState<string[]>([])
  const [failed, setFailed] = useState({ catalog: false, orders: false })
  const [loading, setLoading] = useState(true)
  const [revision, refresh] = useState(0)
  const [planSku, setPlanSku] = useState('')
  const [method, setMethod] = useState<Method>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [problem, setProblem] = useState('')
  const [checkout, setCheckout] = useState<Checkout>()
  const [claim, setClaim] = useState<{
    order_id: string
    redemption_code: string
  }>()
  const intent = useRef<Intent | null>(null)
  const operating = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    setLoading(true)
    void Promise.allSettled([
      api<{ plans: Plan[]; payment_methods: Method[] }>(`${root}/plans`, {
        signal,
      }),
      api<OrderPage>(`${root}/orders?offset=${offset}`, { signal }).then(
        async (page) => {
          const visible = page.orders.slice()
          const stale: string[] = []
          const pending = visible
            .map((order, index) => ({ order, index }))
            .filter(({ order }) => order.status !== 'fulfilled')
          for (let i = 0; i < pending.length && !signal.aborted; i += 4) {
            await Promise.all(
              pending.slice(i, i + 4).map(async ({ order, index }) => {
                try {
                  visible[index] = await api<Order>(
                    `${root}/orders/${encodeURIComponent(order.order_id)}`,
                    { signal }
                  )
                } catch {
                  stale.push(order.order_id)
                }
              })
            )
          }
          return { ...page, orders: visible, stale }
        }
      ),
    ]).then(([plans, mine]) => {
      if (signal.aborted) return
      setCatalog(plans.status === 'fulfilled' ? plans.value : undefined)
      setOrders(mine.status === 'fulfilled' ? mine.value.orders : undefined)
      setNextOffset(mine.status === 'fulfilled' ? mine.value.next_offset : null)
      setStaleOrders(mine.status === 'fulfilled' ? mine.value.stale : [])
      setFailed({
        catalog: plans.status === 'rejected',
        orders: mine.status === 'rejected',
      })
      setLoading(false)
    })
    return () => controller.abort()
  }, [offset, revision])

  async function run(action: () => Promise<void>, fallback: string) {
    if (operating.current) return
    operating.current = true
    setBusy(true)
    setProblem('')
    setNotice('')
    try {
      await action()
    } catch (error) {
      setProblem(
        isApiError(error) && error.status === 401
          ? '登录已过期，请重新登录后打开本人订单。'
          : fallback
      )
    } finally {
      operating.current = false
      setBusy(false)
    }
  }

  function start(input: Intent) {
    void run(async () => {
      intent.current = input
      setCheckout(undefined)
      const order = await api<Checkout>(`${root}/orders`, {
        method: 'POST',
        body: JSON.stringify(input),
      })
      if (order.status === 'pending' && order.url && order.data)
        setCheckout(order)
      else if (order.status === 'paid')
        setNotice('已付款，发码中，请勿重复支付。')
      else if (order.status === 'fulfilled')
        setNotice('兑换码已就绪，请在原订单领取。')
      else setNotice('当前无法打开收银台，请稍后从原订单重试。')
      intent.current = null
      refresh((n) => n + 1)
      setOffset(0)
    }, '未能确认下单结果。请重试同一订单，或先刷新本人订单。')
  }

  function pay(order: Checkout) {
    if (!order.url || !order.data) return
    const url = new URL(order.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      setProblem('收银台地址未通过校验，未发送付款请求。')
      return
    }
    const form = document.createElement('form')
    form.hidden = true
    form.action = url.href
    form.method = 'POST'
    form.target = '_blank'
    form.rel = 'noopener noreferrer'
    for (const [key, value] of Object.entries(order.data)) {
      const field = document.createElement('input')
      field.type = 'hidden'
      field.name = key
      field.value = value
      form.append(field)
    }
    document.body.append(form)
    try {
      HTMLFormElement.prototype.submit.call(form)
    } finally {
      form.remove()
    }
    setCheckout(undefined)
    setNotice(
      '已请求在新窗口打开收银台。支付后刷新本人订单；收银台回跳不代表到账。'
    )
  }

  const plans = catalog?.plans ?? []
  const channels = catalog?.payment_methods ?? []
  const selectedPlan = plans.find((p) => p.sku === planSku) ?? plans[0]
  const selectedMethod =
    method && channels.includes(method) ? method : channels[0]
  return (
    <div className='min-w-0 space-y-5'>
      <section aria-label='选择套餐' className='space-y-3'>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <h2 className='font-medium'>可用套餐</h2>
          {failed.catalog || (catalog && !selectedPlan) ? (
            <Button
              size='sm'
              variant='ghost'
              disabled={loading || busy}
              onClick={() => refresh((n) => n + 1)}
            >
              刷新套餐
            </Button>
          ) : null}
        </div>
        {loading && !catalog && !failed.catalog ? (
          <Skeleton className='h-24 w-full' />
        ) : null}
        {failed.catalog ? (
          <p className='text-sm text-muted-foreground'>
            暂时无法查询可售套餐，仍可查看已有订单。
          </p>
        ) : null}
        {catalog && (!selectedPlan || !selectedMethod) ? (
          <p className='text-sm text-muted-foreground'>
            暂未开放下单，已有兑换码仍可从本人订单领取。
          </p>
        ) : null}
        {selectedPlan && selectedMethod ? (
          <>
            <fieldset
              className='divide-y rounded-md border'
              disabled={busy || loading}
            >
              <legend className='sr-only'>套餐</legend>
              {plans.map((p) => (
                <label
                  key={p.sku}
                  className='flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm'
                >
                  <input
                    type='radio'
                    name='crag-plan'
                    className='accent-primary'
                    checked={p.sku === selectedPlan.sku}
                    onChange={() => setPlanSku(p.sku)}
                  />
                  <span className='font-medium'>
                    {terms[p.term]}
                    {plans.filter((plan) => plan.term === p.term).length > 1
                      ? ` · ${p.sku}`
                      : ''}
                  </span>
                  <span className='ml-auto tabular-nums'>{planTerms(p)}</span>
                </label>
              ))}
            </fieldset>
            <div className='flex flex-wrap items-end gap-3'>
              <label className='grid gap-1 text-sm'>
                付款方式
                <select
                  className='h-9 rounded-md border bg-background px-2'
                  value={selectedMethod}
                  disabled={busy || loading}
                  onChange={(e) => setMethod(e.target.value as Method)}
                >
                  {channels.map((channel) => (
                    <option key={channel} value={channel}>
                      {methods[channel]}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                disabled={busy || loading}
                onClick={() => {
                  const last = intent.current
                  start(
                    last?.sku === selectedPlan.sku &&
                      last.payment_method === selectedMethod
                      ? last
                      : {
                          sku: selectedPlan.sku,
                          payment_method: selectedMethod,
                          request_id: crypto.randomUUID(),
                        }
                  )
                }}
              >
                创建订单
              </Button>
            </div>
          </>
        ) : null}
        {checkout ? (
          <div className='flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm'>
            <span>
              {checkout.term ? terms[checkout.term] : checkout.sku} ·{' '}
              {planTerms(checkout)}
            </span>
            <Button onClick={() => pay(checkout)} disabled={busy}>
              打开{methods[checkout.payment_method]}收银台
            </Button>
          </div>
        ) : null}
      </section>
      <section aria-label='本人订单' className='space-y-3 border-t pt-4'>
        <div className='flex items-center justify-between gap-2'>
          <h2 className='font-medium'>本人订单</h2>
          <Button
            size='sm'
            variant='ghost'
            disabled={loading || busy}
            onClick={() => {
              setCheckout(undefined)
              refresh((n) => n + 1)
            }}
          >
            刷新订单
          </Button>
        </div>
        {problem ? (
          <p role='alert' className='text-sm text-destructive'>
            {problem}
          </p>
        ) : null}
        {notice ? (
          <p role='status' className='text-sm text-muted-foreground'>
            {notice}
          </p>
        ) : null}
        {loading && !orders && !failed.orders ? (
          <Skeleton className='h-12 w-full' />
        ) : null}
        {failed.orders ? (
          <p className='text-sm text-muted-foreground'>
            暂时无法读取本人订单，请刷新重试。
          </p>
        ) : null}
        {staleOrders.length ? (
          <p className='text-sm text-muted-foreground'>
            部分订单暂未同步，显示上次确认的状态。付款后请先刷新，不要重复支付。
          </p>
        ) : null}
        {orders?.length === 0 ? (
          <p className='text-sm text-muted-foreground'>
            还没有订阅订单。下单后可以在这里查看支付状态和领码。
          </p>
        ) : null}
        {orders?.length ? (
          <ul className='divide-y rounded-md border'>
            {orders.map((order) => (
              <li key={order.order_id} className='space-y-2 px-3 py-3 text-sm'>
                <div className='flex flex-wrap items-center justify-between gap-2'>
                  <div className='min-w-0'>
                    <p className='font-medium'>
                      {order.term ? terms[order.term] : order.sku} ·{' '}
                      {planTerms(order)}
                    </p>
                    <p className='mt-1 text-xs break-all text-muted-foreground'>
                      {order.order_id}
                    </p>
                  </div>
                  {order.status === 'fulfilled' ? (
                    <Button
                      variant='outline'
                      size='sm'
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          setClaim(undefined)
                          const code = await api<{
                            order_id: string
                            redemption_code: string
                          }>(
                            `${root}/orders/${encodeURIComponent(order.order_id)}/claim`,
                            { method: 'POST', body: '{}' }
                          )
                          if (code.order_id !== order.order_id)
                            throw new Error('order mismatch')
                          setClaim(code)
                        }, '暂时无法领取，请刷新订单后重试。')
                      }
                    >
                      领取兑换码
                    </Button>
                  ) : null}
                  {order.status === 'pending' || order.status === 'reserved' ? (
                    <Button
                      variant='outline'
                      size='sm'
                      disabled={
                        busy ||
                        loading ||
                        !order.request_id ||
                        staleOrders.includes(order.order_id)
                      }
                      onClick={() => {
                        if (order.request_id)
                          start({
                            sku: order.sku,
                            payment_method: order.payment_method,
                            request_id: order.request_id,
                          })
                      }}
                    >
                      继续支付
                    </Button>
                  ) : null}
                </div>
                <p className='text-muted-foreground'>
                  {
                    {
                      reserved: '等待确认订单',
                      pending: '待支付',
                      paid: '已付款，发码中，请勿重复支付。',
                      fulfilled: '兑换码已就绪',
                    }[order.status]
                  }
                </p>
                {claim?.order_id === order.order_id ? (
                  <div className='space-y-2'>
                    <p>将兑换码交给本机管理员联网兑换，不要公开分享。</p>
                    <code className='block rounded bg-muted px-2 py-1 break-all'>
                      {claim.redemption_code}
                    </code>
                    <Button
                      variant='outline'
                      size='sm'
                      onClick={() =>
                        void run(async () => {
                          await navigator.clipboard.writeText(
                            claim.redemption_code
                          )
                          setNotice('已复制兑换码。')
                        }, '无法访问剪贴板，请手动选中兑换码复制。')
                      }
                    >
                      复制兑换码
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {offset > 0 || typeof nextOffset === 'number' ? (
          <div className='flex justify-end gap-2'>
            <Button
              size='sm'
              variant='outline'
              disabled={loading || busy || offset === 0}
              onClick={() => setOffset(0)}
            >
              回到最新订单
            </Button>
            <Button
              size='sm'
              variant='outline'
              disabled={loading || busy || typeof nextOffset !== 'number'}
              onClick={() => {
                if (typeof nextOffset === 'number') setOffset(nextOffset)
              }}
            >
              查看更早订单
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  )
}
