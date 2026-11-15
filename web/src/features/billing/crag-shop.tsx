import { useEffect, useRef, useState } from 'react'
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { VIEW_TITLES } from '@/config/nav'
import type { StatusTone } from '@/types/status'
import { api, isApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/components/page-header'
import { StatusMark } from '@/components/status-mark'
import { meQueryOptions } from '@/features/auth/queries'
import {
  cragHostStatusQueryOptions,
  type CragHostStatus,
} from '@/features/vm/queries'
import {
  CragCommerce,
  quoteProblem,
  type CommerceRules,
  type CommerceSelection,
} from './crag-commerce'
import { CragPlanPicker } from './crag-plan-picker'

const root = '/api/panel/crag-shop'
const catalogIntervalMs = 25_000
const catalogTimeoutMs = 12_000
const terms = { '1m': '月卡', '3m': '季卡', '1y': '年卡' }
function termLabel(term: string | null, sku: string, months?: number) {
  if (months != null)
    return `${sku === 'renewal' ? '续费 · ' : ''}${months} 个月`
  const duration =
    term &&
    (/^[1-9][0-9]*m$/.test(term)
      ? `${term.slice(0, -1)} 个月`
      : terms[term as keyof typeof terms])
  if (sku === 'renewal') return duration ? `续费 · ${duration}` : '续费'
  return (term && terms[term as keyof typeof terms]) || duration || sku
}
const methods = { wxpay: '微信支付', alipay: '支付宝' }
type Method = keyof typeof methods
type CragPlan = {
  sku: string
  term: string
  amount_minor: number
  slot_limit: number | 'unlimited'
  remaining?: number
  renewable?: boolean
}
type Catalog = {
  plans: CragPlan[]
  payment_methods: Method[]
  commerce?: CommerceRules
}
type CatalogState =
  | { status: 'loading' }
  | { status: 'ready'; data: Catalog }
  | { status: 'error' }
type Order = {
  sku: string
  term: CragPlan['term'] | null
  months?: number
  amount_minor: CragPlan['amount_minor'] | null
  slot_limit: CragPlan['slot_limit'] | null
  order_id: string
  created_at: number
  request_id?: string
  payment_method: Method
  status: 'reserved' | 'pending' | 'paid' | 'fulfilled'
}
type Checkout = Order & { url?: string; data?: Record<string, string> }
type OrderPage = { orders: Order[]; next_offset: number | null }
type Intent = CommerceSelection & {
  payment_method: Method
  request_id: string
  expected_amount_minor?: number
}
const money = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'CNY',
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
})
const dateTime = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
})
const hostTones: Record<CragHostStatus['state'], StatusTone> = {
  unavailable: { key: 'unavailable', cls: 'bad', text: '状态不可用' },
  unredeemed: { key: 'unredeemed', cls: 'none', text: '尚未兑换' },
  active: { key: 'active', cls: 'ok', text: '订阅有效' },
  expired: { key: 'expired', cls: 'bad', text: '已到期' },
  sync_pending: { key: 'sync_pending', cls: 'caution', text: '等待同步' },
}
const orderSteps = [
  { label: '建单', done: '已建单' },
  { label: '付款', done: '已付款' },
  { label: '发码', done: '可领取兑换码' },
] as const
const completedSteps: Record<Order['status'], number> = {
  reserved: 0,
  pending: 1,
  paid: 2,
  fulfilled: 3,
}
const orderTones: Record<Order['status'], StatusTone> = {
  reserved: { key: 'reserved', cls: 'none', text: '待确认订单' },
  pending: { key: 'pending', cls: 'caution', text: '待支付' },
  paid: { key: 'paid', cls: 'caution', text: '已付款，发码中' },
  fulfilled: { key: 'fulfilled', cls: 'ok', text: '已发码' },
}

function SubscriptionTime({ seconds }: { seconds: number }) {
  const date = new Date(seconds * 1000)
  if (!Number.isFinite(date.getTime())) return <>—</>
  return <time dateTime={date.toISOString()}>{dateTime.format(date)}</time>
}

function HostOverview({ host }: { host: UseQueryResult<CragHostStatus> }) {
  const [confirmUpgrade, setConfirmUpgrade] = useState(false)
  const [upgrading, setUpgrading] = useState(false)
  const [upgradeFailed, setUpgradeFailed] = useState(false)
  async function upgrade() {
    if (upgrading) return
    setUpgrading(true)
    setUpgradeFailed(false)
    try {
      await api('/api/panel/crag-subscription/upgrade', {
        method: 'POST',
        body: '{}',
      })
      setConfirmUpgrade(false)
    } catch {
      setUpgradeFailed(true)
    } finally {
      await host.refetch()
      setUpgrading(false)
    }
  }
  const status = host.isError ? undefined : host.data
  const tone = status
    ? hostTones[status.state]
    : host.isError
      ? { key: 'error', cls: 'bad', text: '读取失败' }
      : { key: 'loading', cls: 'none', text: '读取中' }
  return (
    <section
      aria-labelledby='crag-host-overview'
      className='space-y-3 rounded-lg border bg-card p-4'
    >
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex flex-wrap items-center gap-2'>
          <h2 id='crag-host-overview' className='font-semibold'>
            本机订阅
          </h2>
          <StatusMark tone={tone} variant='pill' />
        </div>
        <Button
          size='sm'
          variant='ghost'
          disabled={host.isFetching}
          onClick={() => void host.refetch()}
        >
          刷新本机订阅
        </Button>
      </div>
      {status?.sku ? (
        <p className='text-sm text-muted-foreground'>
          当前套餐：{status.sku === 'custom' ? '自定义' : status.sku}
          {status.months != null ? ` · 每期 ${status.months} 个月` : ''}
        </p>
      ) : null}
      <dl className='grid grid-cols-2 gap-x-3 gap-y-3 border-y py-3 text-sm sm:grid-cols-3'>
        <div>
          <dt className='text-xs text-muted-foreground'>到期时间</dt>
          <dd className='mt-1 font-medium tabular-nums'>
            {status?.expires_at == null ? (
              '—'
            ) : (
              <SubscriptionTime seconds={status.expires_at} />
            )}
          </dd>
        </div>
        <div>
          <dt className='text-xs text-muted-foreground'>应用锁总额度</dt>
          <dd className='mt-1 font-medium tabular-nums'>
            {status?.slot_limit === 'unlimited'
              ? '不限'
              : (status?.slot_limit ?? '—')}
          </dd>
        </div>
        <div>
          <dt className='text-xs text-muted-foreground'>已占用 / 可用槽位</dt>
          <dd className='mt-1 font-medium tabular-nums'>
            {status?.used_slots ?? '—'} /{' '}
            {status?.available_slots === null
              ? '不限'
              : (status?.available_slots ?? '—')}
          </dd>
        </div>
        <div>
          <dt className='text-xs text-muted-foreground'>本机已启用槽位</dt>
          <dd className='mt-1 font-medium tabular-nums'>
            {status?.enabled_slots ?? '—'}
          </dd>
        </div>
        <div>
          <dt className='text-xs text-muted-foreground'>本机兑换条件</dt>
          <dd className='mt-1 font-medium'>
            {!status || status.state === 'unavailable'
              ? '未知'
              : status.state === 'sync_pending'
                ? '等待同步'
                : status.ready
                  ? '已就绪'
                  : '未就绪'}
          </dd>
        </div>
      </dl>
      {status?.upgrade_available && !status.reclaim_supported ? (
        <Button
          size='sm'
          variant='outline'
          disabled={upgrading}
          onClick={() => setConfirmUpgrade(true)}
        >
          启用槽位回收
        </Button>
      ) : null}
      {status?.reclaim_supported ? (
        <p className='text-sm text-muted-foreground'>
          删除槽位并同步成功后，其应用锁可重新分配。停止槽位不释放额度。
        </p>
      ) : null}
      <ConfirmDialog
        open={confirmUpgrade}
        onOpenChange={(open) => {
          if (!upgrading) {
            setConfirmUpgrade(open)
            setUpgradeFailed(false)
          }
        }}
        title='启用本机槽位回收？'
        confirmText='启用回收'
        cancelBtnText='取消'
        desc={
          upgradeFailed
            ? '未确认升级。请刷新本机订阅后检查状态。'
            : '启用后，本机订阅仅支持具备槽位回收能力的新版内核；旧内核不会接受新版宿主权益。'
        }
        isLoading={upgrading}
        handleConfirm={() => void upgrade()}
      />
      <p className='text-sm text-muted-foreground'>
        {host.isError || status?.state === 'unavailable'
          ? '无法确认本机权益，请刷新后重试。'
          : status?.state === 'sync_pending'
            ? '请到槽位授权页继续同步，不要提交另一张兑换码。'
            : status && !status.ready
              ? '当前没有就绪的本机 CRAG 槽位。兑换需要已运行的本机 Linux Docker Claude 槽、支持订阅的可信 CRAG v2 包和只读权益挂载。'
              : '本机状态来自宿主权益，不随付款或领码变化。槽位仍需单独绑定应用锁。'}
      </p>
    </section>
  )
}

function OrderProgress({ status }: { status: Order['status'] }) {
  const done = completedSteps[status]
  return (
    <ol aria-label='订单交付进度' className='grid grid-cols-3 gap-2 text-xs'>
      {orderSteps.map((step, index) => (
        <li
          key={step.label}
          aria-current={index === done ? 'step' : undefined}
          className='min-w-0'
        >
          <span
            aria-hidden='true'
            className={`mb-1.5 block h-1 rounded-full ${index < done ? 'bg-primary' : index === done ? 'bg-primary/45' : 'bg-border'}`}
          />
          <span
            className={index <= done ? 'font-medium' : 'text-muted-foreground'}
          >
            {index < done ? step.done : step.label}
          </span>
        </li>
      ))}
    </ol>
  )
}

function formatPlanDetails(
  amountMinor: number,
  slotLimit: CragPlan['slot_limit']
) {
  return {
    price: money.format(amountMinor / 100),
    locks: slotLimit === 'unlimited' ? '应用锁不限' : `${slotLimit} 把应用锁`,
  }
}

function planTerms(plan: Pick<Order, 'amount_minor' | 'slot_limit'>) {
  if (plan.amount_minor === null || plan.slot_limit === null)
    return '金额与应用锁待确认'
  const { price, locks } = formatPlanDetails(plan.amount_minor, plan.slot_limit)
  return `${price} · ${locks}`
}

export function CragShopLink() {
  return (
    <Button variant='outline' size='sm' asChild>
      <Link to='/crag-subscription'>{VIEW_TITLES['crag-subscription']}</Link>
    </Button>
  )
}

function useHostStatus(enabled: boolean) {
  return useQuery({
    ...cragHostStatusQueryOptions(),
    enabled,
    refetchInterval: 10_000,
  })
}

export function CragSubscriptionPage() {
  const me = useQuery(meQueryOptions())
  const isAdmin = me.data?.role === 'admin' && !me.isError
  const host = useHostStatus(isAdmin)
  return (
    <PageHeader
      title={VIEW_TITLES['crag-subscription']}
      description='查看本人订单。付款后领取兑换码，联网兑换到目标宿主机。'
    >
      <div className='space-y-6'>
        {isAdmin ? <HostOverview host={host} /> : null}
        <ShopOrders
          isAdmin={isAdmin}
          host={host.isError ? undefined : host.data}
        />
      </div>
    </PageHeader>
  )
}

function ShopOrders({
  isAdmin,
  host,
}: {
  isAdmin: boolean
  host?: CragHostStatus
}) {
  const qc = useQueryClient()
  const [applied, setApplied] = useState<string[]>([])
  const [catalog, setCatalog] = useState<CatalogState>({ status: 'loading' })
  const refreshCatalog = useRef<(() => void) | null>(null)
  const [orders, setOrders] = useState<Order[]>()
  const [offset, setOffset] = useState(0)
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [staleOrders, setStaleOrders] = useState<string[]>([])
  const [ordersFailed, setOrdersFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [revision, refresh] = useState(0)
  const [planSku, setPlanSku] = useState<string>()
  const [method, setMethod] = useState<Method>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [problem, setProblem] = useState('')
  const [checkout, setCheckout] = useState<Checkout>()
  const checkoutButton = useRef<HTMLButtonElement>(null)
  const [claim, setClaim] = useState<{
    order_id: string
    redemption_code: string
  }>()
  const intent = useRef<Intent | null>(null)
  const operating = useRef(false)

  useEffect(() => {
    if (checkout && !busy) checkoutButton.current?.focus()
  }, [checkout, busy])

  useEffect(() => {
    let active: { controller: AbortController; timeout: number } | undefined

    function loadCatalog() {
      // Focus, interval and manual refresh share one bounded request.
      if (active) return
      const controller = new AbortController()
      const timeout = window.setTimeout(() => {
        active = undefined
        controller.abort()
        setCatalog({ status: 'error' })
      }, catalogTimeoutMs)
      const request = { controller, timeout }
      active = request

      void api<Catalog>(`${root}/plans`, {
        signal: controller.signal,
        cache: 'no-store',
      })
        .then((data) => {
          if (active !== request) return
          if (
            !Array.isArray(data?.plans) ||
            !Array.isArray(data?.payment_methods)
          ) {
            setCatalog({ status: 'error' })
            return
          }
          setCatalog({ status: 'ready', data })
          if (data.plans.length) {
            // Keep the buyer's choice across refreshes, even while payment is closed.
            setPlanSku(
              (sku) => sku ?? (data.commerce ? 'custom' : data.plans[0].sku)
            )
          }
          if (data.payment_methods.length) {
            setMethod((channel) => channel ?? data.payment_methods[0])
          }
        })
        .catch(() => {
          if (active === request) setCatalog({ status: 'error' })
        })
        .finally(() => {
          window.clearTimeout(timeout)
          if (active === request) active = undefined
        })
    }

    function onVisible() {
      if (document.visibilityState === 'visible') loadCatalog()
    }

    refreshCatalog.current = loadCatalog
    loadCatalog()
    const interval = window.setInterval(loadCatalog, catalogIntervalMs)
    window.addEventListener('focus', loadCatalog)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      refreshCatalog.current = null
      window.clearInterval(interval)
      window.removeEventListener('focus', loadCatalog)
      document.removeEventListener('visibilitychange', onVisible)
      if (active) {
        window.clearTimeout(active.timeout)
        active.controller.abort()
        active = undefined
      }
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    setLoading(true)
    void api<OrderPage>(`${root}/orders?offset=${offset}`, { signal })
      .then(async (page) => {
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
      })
      .then(
        (mine) => {
          if (signal.aborted) return
          setOrders(mine.orders)
          setNextOffset(mine.next_offset)
          setStaleOrders(mine.stale)
          setOrdersFailed(false)
          setLoading(false)
        },
        () => {
          if (signal.aborted) return
          setOrders(undefined)
          setNextOffset(null)
          setStaleOrders([])
          setOrdersFailed(true)
          setLoading(false)
        }
      )
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
          : isApiError(error) &&
              /coupon|stock|sold_out|inventory|renew|price|amount|cap/.test(
                error.code ?? ''
              )
            ? quoteProblem(error)
            : fallback
      )
    } finally {
      operating.current = false
      setBusy(false)
    }
  }

  function start(input: Intent, resumeId?: string) {
    void run(
      async () => {
        if (!resumeId) intent.current = input
        setCheckout(undefined)
        const order = await api<Checkout>(
          resumeId
            ? `${root}/orders/${encodeURIComponent(resumeId)}/resume`
            : `${root}/orders`,
          {
            method: 'POST',
            body: resumeId ? '{}' : JSON.stringify(input),
          }
        ).catch((error: unknown) => {
          refresh((n) => n + 1)
          refreshCatalog.current?.()
          throw error
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
      },
      input.expected_amount_minor == null
        ? '未能确认下单结果。请重试同一订单，或先刷新本人订单。'
        : '未能确认订单：价格、优惠或库存可能已变动。请重新核价；已创建的订单请在本人订单继续支付。'
    )
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

  const plans = catalog.status === 'ready' ? catalog.data.plans : []
  const commerce =
    catalog.status === 'ready' ? catalog.data.commerce : undefined
  const canRenew = !!(
    isAdmin &&
    host?.sku &&
    (host.state === 'active' || host.state === 'expired') &&
    (host.sku === 'custom'
      ? commerce?.custom_renewable === true
      : plans.some((plan) => plan.sku === host.sku && plan.renewable === true))
  )
  const commerceSku = planSku ?? 'custom'
  const channels =
    catalog.status === 'ready' ? catalog.data.payment_methods : []
  const selectedPlan = plans.find((plan) => plan.sku === planSku)
  const selectedMethod =
    method && channels.includes(method) ? method : undefined
  const canOrder = (plans.length > 0 || !!commerce) && channels.length > 0
  const catalogMessage =
    catalog.status === 'loading'
      ? '正在查询套餐…'
      : catalog.status === 'error'
        ? '暂时无法确认可售套餐，请刷新套餐重试。仍可查看本人订单。'
        : !plans.length && !commerce
          ? '暂无可购买的套餐，仍可查看本人订单。'
          : !channels.length
            ? '当前未开放收款。可以选择和比较套餐，暂不能创建订单。'
            : !commerce && (!selectedPlan || !selectedMethod)
              ? '套餐或付款方式已更新，请重新选择后再创建订单。'
              : ''
  return (
    <div className='grid min-w-0 gap-6'>
      {checkout ? (
        <section
          aria-label='订单收银台'
          className='flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 p-3 text-sm'
        >
          <span>
            {termLabel(checkout.term, checkout.sku, checkout.months)} ·{' '}
            {planTerms(checkout)}
          </span>
          <Button
            ref={checkoutButton}
            onClick={() => pay(checkout)}
            disabled={busy}
          >
            打开{methods[checkout.payment_method]}收银台
          </Button>
        </section>
      ) : null}
      <div className='grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]'>
        <section aria-label='本人订单' className='min-w-0 space-y-3'>
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
          {loading && !orders && !ordersFailed ? (
            <Skeleton className='h-12 w-full' />
          ) : null}
          {ordersFailed ? (
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
                <li
                  key={order.order_id}
                  className='space-y-3 px-4 py-4 text-sm'
                >
                  <div className='flex flex-wrap items-center justify-between gap-2'>
                    <div className='min-w-0'>
                      <div className='flex flex-wrap items-center gap-2'>
                        <p className='font-semibold'>
                          {termLabel(order.term, order.sku, order.months)} ·{' '}
                          {planTerms(order)}
                        </p>
                        <StatusMark
                          tone={orderTones[order.status]}
                          variant='pill'
                        />
                      </div>
                      <p className='mt-1 text-xs text-muted-foreground'>
                        {methods[order.payment_method]} · 下单{' '}
                        <SubscriptionTime seconds={order.created_at} />
                      </p>
                      <p className='mt-1 text-xs break-all text-muted-foreground'>
                        订单号 {order.order_id}
                      </p>
                    </div>
                    {order.status === 'fulfilled' && order.sku !== 'renewal' ? (
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
                    {order.status === 'pending' ||
                    order.status === 'reserved' ? (
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
                            start(
                              {
                                sku: order.sku,
                                payment_method: order.payment_method,
                                request_id: order.request_id,
                              },
                              (commerce && order.status !== 'reserved') ||
                                order.sku === 'custom' ||
                                order.sku === 'renewal'
                                ? order.order_id
                                : undefined
                            )
                        }}
                      >
                        继续支付
                      </Button>
                    ) : null}
                  </div>
                  <OrderProgress status={order.status} />
                  {claim?.order_id === order.order_id ? (
                    <div className='space-y-2'>
                      <p className='text-muted-foreground'>
                        请勿公开分享，下方是本订单的完整兑换码。
                      </p>
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
                  {order.status === 'paid' ? (
                    <p className='text-sm text-muted-foreground'>
                      请勿重复支付。发码完成后可在原订单领码。
                    </p>
                  ) : null}
                  {order.status === 'fulfilled' ? (
                    <div className='space-y-2 border-t pt-3 text-sm'>
                      {order.sku === 'renewal' ? (
                        isAdmin ? (
                          <div className='space-y-2'>
                            <p>
                              此续费仅适用于下单时的宿主机。付款后需将续费应用到该宿主机；原有槽位绑定不变。
                            </p>
                            <Button
                              size='sm'
                              disabled={
                                busy || applied.includes(order.order_id)
                              }
                              onClick={() =>
                                void run(async () => {
                                  const status = await api<CragHostStatus>(
                                    `${root}/orders/${encodeURIComponent(order.order_id)}/apply-renewal`,
                                    { method: 'POST', body: '{}' }
                                  )
                                  const { queryKey } =
                                    cragHostStatusQueryOptions()
                                  qc.setQueryData(queryKey, status)
                                  await qc.invalidateQueries({ queryKey })
                                  setApplied((prior) => [
                                    ...prior,
                                    order.order_id,
                                  ])
                                  setNotice('续费已应用到本机。')
                                }, '暂未确认续费，请刷新本机订阅后重试同一笔订单。')
                              }
                            >
                              {applied.includes(order.order_id)
                                ? '已应用续费'
                                : '应用续费到本机'}
                            </Button>
                          </div>
                        ) : (
                          <p>请由下单宿主机的管理员应用续费。</p>
                        )
                      ) : (
                        <>
                          <p className='font-medium'>怎样使用兑换码</p>
                          <ol className='list-decimal space-y-1 ps-5 text-muted-foreground'>
                            <li>
                              点击「领取兑换码」，复制以 <code>CRAGR1.</code>{' '}
                              开头的整串码。再次领取返回同一码。
                            </li>
                            <li>
                              {isAdmin
                                ? '在目标宿主机的面板中'
                                : '请将码私下交给目标宿主机管理员，在该机面板中'}
                              打开「虚拟机 → 目标槽位 → 运维 → 推理内核 → CRAG
                              授权 / 续期 →
                              宿主机订阅」。把码粘贴到「宿主机兑换码」，点击「兑换到本机」。
                            </li>
                            <li>
                              兑换后，点击「给本槽绑定应用锁」。其他要用订阅的槽也需分别绑定。
                            </li>
                          </ol>
                          <p className='text-xs text-muted-foreground'>
                            每码仅能在一台宿主机兑换，不可转移。它不是调用 API
                            的 Key，也不是旧授权注册码。
                          </p>
                          {isAdmin ? (
                            <Button
                              size='sm'
                              variant='link'
                              className='h-auto p-0'
                              asChild
                            >
                              <Link to='/vm'>打开虚拟机列表</Link>
                            </Button>
                          ) : null}
                        </>
                      )}
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
        <section aria-label='选择套餐' className='space-y-3'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <h2 className='font-medium'>订阅套餐</h2>
            <Button
              type='button'
              size='sm'
              variant='ghost'
              onClick={() => refreshCatalog.current?.()}
            >
              刷新套餐
            </Button>
          </div>
          <div
            role='status'
            className='text-sm text-muted-foreground empty:sr-only'
          >
            {catalogMessage}
          </div>
          {catalog.status === 'loading' ? (
            <Skeleton aria-hidden='true' className='h-24 w-full' />
          ) : null}
          {plans.length > 0 && !commerce ? (
            <CragPlanPicker
              plans={plans.map((plan) => ({
                sku: plan.sku,
                term: termLabel(plan.term, plan.sku),
                ...formatPlanDetails(plan.amount_minor, plan.slot_limit),
              }))}
              selectedSku={selectedPlan?.sku}
              onSelect={setPlanSku}
              disabled={busy}
            />
          ) : null}
          {canOrder ? (
            <div className='flex flex-wrap items-end gap-3'>
              <label className='grid gap-1 text-sm'>
                付款方式
                <select
                  className='h-9 rounded-md border bg-background px-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
                  value={selectedMethod ?? ''}
                  disabled={busy}
                  onChange={(event) => setMethod(event.target.value as Method)}
                >
                  <option value='' disabled>
                    请选择付款方式
                  </option>
                  {channels.map((channel) => (
                    <option key={channel} value={channel}>
                      {methods[channel]}
                    </option>
                  ))}
                </select>
              </label>
              {!commerce ? (
                <Button
                  type='button'
                  disabled={busy || !selectedPlan || !selectedMethod}
                  onClick={() => {
                    if (!selectedPlan || !selectedMethod) return
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
              ) : null}
            </div>
          ) : null}
          {commerce ? (
            <CragCommerce
              rules={commerce}
              plans={plans}
              sku={commerceSku}
              onSelect={setPlanSku}
              allowRenewal={canRenew}
              enabled={canOrder && !!selectedMethod}
              busy={busy}
              initialQuoteKey={revision}
              onOrder={(selection, price) => {
                if (!selectedMethod) return
                const last = intent.current
                const same =
                  last &&
                  last.sku === selection.sku &&
                  last.slots === selection.slots &&
                  last.months === selection.months &&
                  last.coupon === selection.coupon &&
                  last.payment_method === selectedMethod &&
                  last.expected_amount_minor === price
                start(
                  same
                    ? last
                    : {
                        ...selection,
                        payment_method: selectedMethod,
                        expected_amount_minor: price,
                        request_id: crypto.randomUUID(),
                      }
                )
              }}
            />
          ) : null}
          {plans.length > 0 && !canOrder && !commerce ? (
            <Button type='button' disabled>
              暂不可下单
            </Button>
          ) : null}
        </section>
      </div>
    </div>
  )
}
