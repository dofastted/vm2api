import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { VIEW_TITLES } from '@/config/nav'
import type { StatusTone } from '@/types/status'
import { activateVmCragLicense, api, isApiError } from '@/lib/api'
import { isCodexVm } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/components/page-header'
import { StatusMark } from '@/components/status-mark'
import { meQueryOptions } from '@/features/auth/queries'
import { CragActivationForm } from '@/features/vm/crag-license-editor'
import { CragRuntimeCounts } from '@/features/vm/crag-runtime-counts'
import {
  cragHostStatusQueryOptions,
  vmCragLicenseQueryOptions,
  vmsListQueryOptions,
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
const hostRoot = '/api/panel/crag-subscription'
const catalogIntervalMs = 25_000
const catalogTimeoutMs = 12_000
const terms = { '1m': '月卡', '3m': '季卡', '1y': '年卡' }
export function termLabel(term: string | null, sku: string, months?: number) {
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
export type CragPlan = {
  sku: string
  term: string
  amount_minor: number
  slot_limit: number | 'unlimited'
  remaining?: number | null
  renewable?: boolean
  name?: string
  description?: string
  enabled?: boolean
  months?: number
}
export type Presentation = Partial<
  Record<
    | 'title'
    | 'description'
    | 'plans_title'
    | 'orders_title'
    | 'custom_title'
    | 'unavailable_text'
    | 'empty_plans_text'
    | 'empty_orders_text',
    string
  >
>
type Catalog = {
  plans: CragPlan[]
  payment_methods: Method[]
  commerce?: CommerceRules
  presentation?: Presentation
  revision?: number
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
  expected_amount_minor?: number
  payment_method: Method
  status: 'reserved' | 'pending' | 'paid' | 'fulfilled'
  activation?: {
    state:
      | 'manual'
      | 'awaiting_fulfillment'
      | 'activating'
      | 'active'
      | 'needs_attention'
    vm_id?: string
  }
}
type Checkout = Order & { url?: string; data?: Record<string, string> }
type OrderPage = { orders: Order[]; next_offset: number | null }
type Intent = CommerceSelection & {
  payment_method: Method
  request_id: string
  expected_amount_minor?: number
  activation_target?: { vm_id: string }
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
const activationTones: Record<
  NonNullable<Order['activation']>['state'],
  StatusTone
> = {
  manual: { key: 'manual', cls: 'none', text: '手动激活' },
  awaiting_fulfillment: {
    key: 'awaiting_fulfillment',
    cls: 'none',
    text: '等待交付后自动激活',
  },
  activating: { key: 'activating', cls: 'caution', text: '正在自动激活' },
  active: { key: 'active', cls: 'ok', text: '原订单已完成激活' },
  needs_attention: { key: 'needs_attention', cls: 'bad', text: '激活待处理' },
}

function automaticOrder(order: Order) {
  return (
    !!order.activation &&
    (order.activation.state !== 'manual' || !!order.activation.vm_id)
  )
}

function SubscriptionTime({ seconds }: { seconds: number }) {
  const date = new Date(seconds * 1000)
  if (!Number.isFinite(date.getTime())) return <>—</>
  return <time dateTime={date.toISOString()}>{dateTime.format(date)}</time>
}

function hostRedemptionError(error: unknown) {
  switch (isApiError(error) ? error.code : undefined) {
    case 'crag_subscription_invalid_request':
      return '请输入有效的宿主机兑换码'
    case 'redeem_unavailable':
      return '此码不可用于本机订阅或已失效'
    case 'host_redeem_conflict':
      return '此码与当前宿主机或订阅不匹配'
    case 'crag_subscription_host_package_unready':
      return '请先在内核页拉取可信 CRAG 发行包'
    default:
      return '兑换尚未确认，请刷新或继续同步'
  }
}

function HostOverview({ host }: { host: UseQueryResult<CragHostStatus> }) {
  const qc = useQueryClient()
  const [confirmUpgrade, setConfirmUpgrade] = useState(false)
  const [upgradeFailed, setUpgradeFailed] = useState(false)
  const [code, setCode] = useState('')
  const [notice, setNotice] = useState<{ text: string; error?: true }>()
  const [action, setAction] = useState<'redeem' | 'recover' | 'upgrade'>()
  const operating = useRef(false)
  const status = host.isError ? undefined : host.data
  const syncPending = host.data?.state === 'sync_pending'
  const upgrading = action === 'upgrade'

  async function updateHost(operation: 'redeem' | 'recover') {
    const redemptionCode = code.trim()
    if (operating.current) return
    if (operation === 'redeem' && (!redemptionCode || syncPending)) return
    if (operation === 'recover' && !syncPending) return
    operating.current = true
    setAction(operation)
    setNotice(undefined)
    const { queryKey } = cragHostStatusQueryOptions()
    try {
      const next = await api<CragHostStatus>(`${hostRoot}/${operation}`, {
        method: 'POST',
        body:
          operation === 'redeem'
            ? JSON.stringify({ redemption_code: redemptionCode })
            : '{}',
      })
      qc.setQueryData(queryKey, next)
      if (next.state === 'active' || next.state === 'expired') {
        setCode('')
        setNotice({ text: '宿主机额度已更新，未自动绑定 VM' })
      } else if (next.state !== 'sync_pending') {
        setNotice({ text: hostRedemptionError(undefined), error: true })
      }
    } catch (error) {
      setNotice({ text: hostRedemptionError(error), error: true })
    } finally {
      await qc.invalidateQueries({ queryKey })
      operating.current = false
      setAction(undefined)
    }
  }

  async function upgrade() {
    if (operating.current) return
    operating.current = true
    setAction('upgrade')
    setUpgradeFailed(false)
    try {
      await api(`${hostRoot}/upgrade`, {
        method: 'POST',
        body: '{}',
      })
      setConfirmUpgrade(false)
    } catch {
      setUpgradeFailed(true)
    } finally {
      await host.refetch()
      operating.current = false
      setAction(undefined)
    }
  }
  const probeFailed = status?.target_probe_failed && !status.ready
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
          disabled={host.isFetching || !!action}
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
          <dt className='text-xs text-muted-foreground'>
            已绑定 / 可绑定应用锁
          </dt>
          <dd className='mt-1 font-medium tabular-nums'>
            {status?.used_slots ?? '—'} /{' '}
            {status?.available_slots === null
              ? '不限'
              : (status?.available_slots ?? '—')}
          </dd>
        </div>
        <div>
          <dt className='text-xs text-muted-foreground'>本机槽位绑定条件</dt>
          <dd className='mt-1 font-medium'>
            {probeFailed
              ? '探测失败'
              : !status || status.state === 'unavailable'
                ? '未知'
                : status.state === 'sync_pending'
                  ? '等待同步'
                  : status.ready
                    ? '已就绪'
                    : '未就绪'}
          </dd>
        </div>
      </dl>
      <CragRuntimeCounts status={status} />
      <p className='text-xs text-muted-foreground'>
        运行名额只统计实际运行的 CRAG。停止不会解绑应用锁；支持 H2
        的宿主在退役删除并同步后才释放应用锁。
      </p>
      {status?.upgrade_available && !status.reclaim_supported ? (
        <Button
          size='sm'
          variant='outline'
          disabled={!!action}
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
      {probeFailed ? (
        <p role='status' className='text-sm text-muted-foreground'>
          未能确认本机槽位是否就绪。请点击「刷新本机订阅」重试探测。
        </p>
      ) : null}
      <p className='text-sm text-muted-foreground empty:sr-only'>
        {syncPending
          ? '如果继续同步后仍在等待，请核对原订单，或回到原 VM 槽位使用原码完成激活。'
          : host.isError || status?.state === 'unavailable'
            ? '无法确认本机权益，请刷新后重试。'
            : probeFailed
              ? ''
              : status && !status.ready
                ? '当前没有就绪的本机 CRAG 槽位，仍可兑换宿主机额度。绑定应用锁需要已预装可信 CRAG v2 包的本机 Linux Docker Claude 槽位。'
                : '付款或领码不会更新本机权益。可在此兑换宿主机额度，再到所需槽位的授权页绑定应用锁。'}
      </p>
      {syncPending ? (
        <Button
          type='button'
          size='sm'
          variant='outline'
          disabled={!!action}
          onClick={() => void updateHost('recover')}
        >
          {action === 'recover' ? '正在同步…' : '继续同步'}
        </Button>
      ) : (
        <form
          aria-label='兑换宿主机额度'
          className='max-w-xl space-y-2 border-t pt-3'
          onSubmit={(event) => {
            event.preventDefault()
            void updateHost('redeem')
          }}
        >
          <label className='grid gap-1 text-sm'>
            宿主机兑换码
            <Input
              type='password'
              autoComplete='off'
              value={code}
              disabled={!!action}
              aria-describedby='crag-host-redeem-help'
              onChange={(event) => {
                setCode(event.target.value)
                setNotice(undefined)
              }}
            />
          </label>
          <p
            id='crag-host-redeem-help'
            className='text-sm text-muted-foreground'
          >
            兑换后以新套餐额度为准；不绑定、不启动 VM。
          </p>
          <Button type='submit' size='sm' disabled={!code.trim() || !!action}>
            {action === 'redeem' ? '正在兑换…' : '兑换到本机'}
          </Button>
        </form>
      )}
      {notice ? (
        <p
          role={notice.error ? 'alert' : 'status'}
          className={notice.error ? 'text-sm text-destructive' : 'text-sm'}
        >
          {notice.text}
        </p>
      ) : null}
    </section>
  )
}

function OrderProgress({
  status,
  automatic,
}: {
  status: Order['status']
  automatic: boolean
}) {
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
            {index < done
              ? automatic && index === 2
                ? '已交付'
                : step.done
              : step.label}
          </span>
        </li>
      ))}
    </ol>
  )
}

export function formatPlanDetails(
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
  if (!me.data || me.isError) return null
  return (
    <ShopOrders
      key={`${me.data.user}:${me.data.role}`}
      owner={me.data.user}
      isAdmin={isAdmin}
      host={host.isError ? undefined : host.data}
      overview={isAdmin ? <HostOverview host={host} /> : null}
    />
  )
}

function ManualCragActivation({
  initialCode,
  onClose,
}: {
  initialCode: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const vms = useQuery(vmsListQueryOptions())
  const targets = (vms.data?.items ?? []).filter(
    (vm) => !isCodexVm(vm) && vm.node_platform !== 'darwin'
  )
  const [code, setCode] = useState(initialCode)
  const [targetId, setTargetId] = useState('')
  const [active, setActive] = useState(false)
  const activation = useMutation({
    mutationFn: () => activateVmCragLicense(targetId, code.trim()),
    onSuccess: async (data) => {
      qc.setQueryData(vmCragLicenseQueryOptions(targetId).queryKey, data)
      setCode('')
      setActive(data.license.valid)
      await qc.invalidateQueries({
        queryKey: cragHostStatusQueryOptions().queryKey,
      })
    },
  })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !activation.isPending) onClose()
      }}
    >
      <DialogContent className='max-h-[90dvh] overflow-y-auto'>
        <DialogHeader>
          <DialogTitle>手动激活 CRAG</DialogTitle>
          <DialogDescription>
            选择目标槽位，粘贴激活码。激活不会安装或启动内核。
          </DialogDescription>
        </DialogHeader>
        <label className='grid gap-1 text-sm'>
          目标槽位
          <select
            className='h-9 w-full rounded-md border bg-background px-2 focus-visible:ring-ring focus-visible:outline-2 focus-visible:outline-offset-2'
            value={targetId}
            disabled={activation.isPending}
            onChange={(event) => {
              setTargetId(event.target.value)
              setActive(false)
              activation.reset()
            }}
          >
            <option value=''>请选择槽位</option>
            {targets.map((vm) => (
              <option key={vm.id} value={vm.id}>
                {vm.name ? `${vm.name} (${vm.id})` : vm.id}
              </option>
            ))}
          </select>
        </label>
        {vms.isError ? (
          <p role='alert' className='text-sm text-destructive'>
            无法读取槽位，请关闭后重试。
          </p>
        ) : null}
        <CragActivationForm
          code={code}
          disabled={vms.isError || !targets.some((vm) => vm.id === targetId)}
          activating={activation.isPending}
          error={activation.error}
          onChange={(value) => {
            setCode(value)
            setActive(false)
            activation.reset()
          }}
          onActivate={() => activation.mutate()}
        />
        {active ? (
          <p role='status' className='text-sm'>
            槽位 {targetId} 已激活。
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function ShopOrders({
  isAdmin,
  host,
  owner,
  overview,
}: {
  isAdmin: boolean
  host?: CragHostStatus
  owner: string
  overview: ReactNode
}) {
  const qc = useQueryClient()
  const [applied, setApplied] = useState<string[]>([])
  const [catalog, setCatalog] = useState<CatalogState>({ status: 'loading' })
  const [catalogRevision, setCatalogRevision] = useState(0)
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
  const [targetVmId, setTargetVmId] = useState('')
  const [manualCode, setManualCode] = useState<string>()
  const targets = useQuery({
    queryKey: ['panel', 'crag-shop', 'activation-targets', owner],
    queryFn: ({ signal }) =>
      api<{ targets: { vm_id: string }[] }>(`${root}/activation-targets`, {
        signal,
        cache: 'no-store',
      }),
    enabled: isAdmin,
    retry: false,
    refetchInterval: catalogIntervalMs,
  })
  const eligibleTargets =
    isAdmin && !targets.isError ? (targets.data?.targets ?? []) : []
  const targetAvailable =
    !targetVmId ||
    (isAdmin &&
      !targets.isFetching &&
      !targets.isError &&
      eligibleTargets.some((target) => target.vm_id === targetVmId))

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
          setCatalogRevision((current) => current + 1)
          const visiblePlans = data.plans.filter(
            (plan) => plan.enabled !== false
          )
          if (visiblePlans.length || data.commerce) {
            // Keep the buyer's choice across refreshes, even while payment is closed.
            setPlanSku(
              (sku) =>
                sku ??
                visiblePlans.find((plan) => plan.remaining !== 0)?.sku ??
                (data.commerce && data.commerce.custom_enabled !== false
                  ? 'custom'
                  : visiblePlans[0]?.sku)
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
          .filter(
            ({ order }) =>
              order.status !== 'fulfilled' ||
              (automaticOrder(order) && order.activation?.state !== 'active')
          )
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
          ? '登录已过期，请重新登录后查看历史订单。'
          : isApiError(error) &&
              error.code === 'shop_activation_target_unavailable'
            ? '所选槽位暂不可用。请先核对历史订单，再刷新激活目标或选择手动激活。'
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
          if (
            isApiError(error) &&
            error.code === 'shop_activation_target_unavailable'
          )
            void targets.refetch()
          refreshCatalog.current?.()
          throw error
        })
        if (order.status === 'pending' && order.url && order.data)
          setCheckout(order)
        else if (order.status === 'paid')
          setNotice('已付款，等待交付，请勿重复支付。')
        else if (order.status === 'fulfilled')
          setNotice(
            automaticOrder(order)
              ? '订单已交付，请查看原订单的激活状态。'
              : '兑换码已就绪，请在原订单领取。'
          )
        else setNotice('当前无法打开收银台，请稍后从原订单重试。')
        if (intent.current?.request_id === input.request_id)
          intent.current = null
        refresh((n) => n + 1)
        setOffset(0)
      },
      input.expected_amount_minor == null
        ? '未能确认下单结果。请重试同一订单，或先刷新历史订单。'
        : '未能确认订单：价格、优惠或库存可能已变动。请重新核价；已创建的订单请在历史订单继续支付。'
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
      '已请求在新窗口打开收银台。支付后刷新历史订单；收银台回跳不代表到账。'
    )
  }

  const allPlans = catalog.status === 'ready' ? catalog.data.plans : []
  const plans = allPlans.filter((plan) => plan.enabled !== false)
  const presentation =
    catalog.status === 'ready' ? catalog.data.presentation : undefined
  const commerce =
    catalog.status === 'ready' ? catalog.data.commerce : undefined
  const canRenew = !!(
    isAdmin &&
    host?.sku &&
    (host.state === 'active' || host.state === 'expired') &&
    (host.sku === 'custom'
      ? commerce?.custom_renewable === true
      : allPlans.some(
          (plan) => plan.sku === host.sku && plan.renewable === true
        ))
  )
  const commerceSku =
    planSku ?? (commerce?.custom_enabled !== false ? 'custom' : '')
  const channels =
    catalog.status === 'ready' ? catalog.data.payment_methods : []
  const selectedPlan = plans.find((plan) => plan.sku === planSku)
  const selectedMethod =
    method && channels.includes(method) ? method : undefined
  const hasPurchaseOptions =
    plans.length > 0 ||
    (!!commerce && (commerce.custom_enabled !== false || canRenew))
  const canOrder = hasPurchaseOptions && channels.length > 0
  const catalogMessage =
    catalog.status === 'loading'
      ? '正在查询套餐…'
      : catalog.status === 'error'
        ? '暂时无法确认可售套餐，请刷新套餐重试。仍可查看历史订单。'
        : !hasPurchaseOptions
          ? (presentation?.empty_plans_text ??
            '暂无可购买的套餐，仍可查看历史订单。')
          : !channels.length
            ? (presentation?.unavailable_text ??
              '当前未开放收款。可以选择和比较套餐，暂不能创建订单。')
            : !selectedMethod || (!commerce && !selectedPlan)
              ? '套餐或付款方式已更新，请重新选择后再创建订单。'
              : ''
  function createOrder(selection: CommerceSelection, price?: number) {
    if (!selectedMethod || !canOrder || busy) return
    const activation_target =
      selection.sku !== 'renewal' && targetVmId
        ? { vm_id: targetVmId }
        : undefined
    const last = intent.current
    // Keep a retry on the exact original request even if the target has since gone offline.
    const same =
      last &&
      last.sku === selection.sku &&
      last.slots === selection.slots &&
      last.months === selection.months &&
      last.coupon === selection.coupon &&
      last.payment_method === selectedMethod &&
      last.expected_amount_minor === price &&
      last.activation_target?.vm_id === activation_target?.vm_id
    if (!same && activation_target && !targetAvailable) {
      setProblem(
        '所选自动激活目标暂不可用。请先核对历史订单，再刷新激活目标或选择手动激活。'
      )
      return
    }
    start(
      same
        ? last
        : {
            ...selection,
            payment_method: selectedMethod,
            request_id: crypto.randomUUID(),
            ...(price !== undefined ? { expected_amount_minor: price } : {}),
            ...(activation_target ? { activation_target } : {}),
          }
    )
  }

  function continueOrder(order: Order) {
    if (!order.request_id) return
    const original = intent.current
    if (
      order.status === 'reserved' &&
      original?.request_id === order.request_id
    ) {
      start(original)
      return
    }
    const vmId = order.activation?.vm_id
    const fixedLegacy =
      order.expected_amount_minor == null &&
      order.sku !== 'custom' &&
      order.sku !== 'renewal'
    start(
      {
        sku: order.sku,
        payment_method: order.payment_method,
        request_id: order.request_id,
        ...(vmId ? { activation_target: { vm_id: vmId } } : {}),
      },
      order.status === 'reserved' &&
        fixedLegacy &&
        (!automaticOrder(order) || !!vmId)
        ? undefined
        : order.order_id
    )
  }
  return (
    <PageHeader
      title={presentation?.title ?? VIEW_TITLES['crag-subscription']}
      description={
        presentation?.description ??
        '查看订阅套餐和本人历史订单。付款、交付与激活状态分别确认。'
      }
      extra={
        <Button size='sm' variant='outline' asChild>
          <a href='#crag-purchase-activation'>购买后激活</a>
        </Button>
      }
    >
      <div className='grid min-w-0 gap-6'>
        <section
          id='crag-purchase-activation'
          aria-labelledby='crag-purchase-activation-title'
          className='scroll-mt-20 space-y-3 rounded-lg border bg-card p-4'
        >
          <h2 id='crag-purchase-activation-title' className='font-semibold'>
            购买后激活
          </h2>
          <div className='flex flex-wrap items-center gap-2'>
            {isAdmin ? (
              <Button size='sm' onClick={() => setManualCode('')}>
                手动激活
              </Button>
            ) : null}
            <Button size='sm' variant='outline' asChild>
              <a href='#crag-order-history'>查看订单与激活状态</a>
            </Button>
          </div>
          <p className='text-sm text-muted-foreground'>
            {isAdmin
              ? '已有兑换码可直接手动激活；未领码请在已发码的原订单中领取。'
              : '请在已发码的原订单中领取兑换码，交给目标宿主机的管理员激活。'}
          </p>
          {isAdmin ? (
            <div className='max-w-xl space-y-2 border-t pt-3'>
              <label className='grid gap-1 text-sm'>
                自动激活（新订单）
                <select
                  className='h-9 w-full min-w-0 rounded-md border bg-background px-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
                  value={targetVmId}
                  disabled={busy}
                  onChange={(event) => setTargetVmId(event.target.value)}
                >
                  <option value=''>手动激活（领码后自行兑换与绑定）</option>
                  {targetVmId &&
                  !eligibleTargets.some(
                    (target) => target.vm_id === targetVmId
                  ) ? (
                    <option value={targetVmId} disabled>
                      所选目标暂不可用：{targetVmId}
                    </option>
                  ) : null}
                  {eligibleTargets.map((target) => (
                    <option key={target.vm_id} value={target.vm_id}>
                      自动激活到 {target.vm_id}
                    </option>
                  ))}
                </select>
              </label>
              <p className='text-sm text-muted-foreground'>
                选择目标槽位后再下单；订单确认交付后，服务端自动兑换并绑定，无需保持页面打开。不影响历史订单和续费。
              </p>
              <p
                role='status'
                className='text-sm text-muted-foreground empty:sr-only'
              >
                {targets.isError
                  ? '读取自动激活目标失败；请刷新目标或选择手动激活。'
                  : targets.isFetching
                    ? '正在查询自动激活目标；手动激活始终可选。'
                    : !eligibleTargets.length
                      ? '当前没有可用的自动激活目标，可选择手动激活。'
                      : ''}
              </p>
              {!targetAvailable ? (
                <p role='alert' className='text-sm text-destructive'>
                  所选目标尚未确认可用。请先核对历史订单，再刷新激活目标或明确改选手动激活。
                </p>
              ) : null}
              <Button
                type='button'
                variant='ghost'
                size='sm'
                disabled={targets.isFetching || busy}
                onClick={() => void targets.refetch()}
              >
                刷新激活目标
              </Button>
            </div>
          ) : null}
        </section>
        {isAdmin && manualCode !== undefined ? (
          <ManualCragActivation
            initialCode={manualCode}
            onClose={() => setManualCode(undefined)}
          />
        ) : null}
        {overview}
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
          <section
            aria-label={presentation?.plans_title ?? '订阅套餐'}
            className='min-w-0 space-y-3'
          >
            <div className='flex flex-wrap items-center justify-between gap-2'>
              <h2 className='font-medium'>
                {presentation?.plans_title ?? '订阅套餐'}
              </h2>
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
                  term: termLabel(plan.term, plan.sku, plan.months),
                  name: plan.name,
                  description: plan.description,
                  remaining: plan.remaining,
                  renewable: plan.renewable,
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
                    onChange={(event) =>
                      setMethod(event.target.value as Method)
                    }
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
                    disabled={
                      busy ||
                      !selectedPlan ||
                      selectedPlan.remaining === 0 ||
                      !selectedMethod
                    }
                    onClick={() => {
                      if (!selectedPlan || selectedPlan.remaining === 0) return
                      createOrder({ sku: selectedPlan.sku })
                    }}
                  >
                    创建订单
                  </Button>
                ) : null}
              </div>
            ) : null}
            {commerce && hasPurchaseOptions ? (
              <CragCommerce
                rules={commerce}
                plans={plans}
                sku={commerceSku}
                onSelect={setPlanSku}
                allowRenewal={canRenew}
                enabled={canOrder && !!selectedMethod}
                busy={busy}
                initialQuoteKey={revision + catalogRevision}
                catalogKey={
                  catalog.status === 'ready'
                    ? JSON.stringify(catalog.data)
                    : undefined
                }
                customTitle={presentation?.custom_title}
                onOrder={createOrder}
              />
            ) : null}
            {plans.length > 0 && !canOrder && !commerce ? (
              <Button type='button' disabled>
                暂不可下单
              </Button>
            ) : null}
          </section>
          <section
            aria-label={presentation?.orders_title ?? '历史订单'}
            id='crag-order-history'
            className='min-w-0 scroll-mt-20 space-y-3'
          >
            <div className='flex items-center justify-between gap-2'>
              <h2 className='font-medium'>
                {presentation?.orders_title ?? '历史订单'}
              </h2>
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
            {loading && !orders && !ordersFailed ? (
              <Skeleton className='h-12 w-full' />
            ) : null}
            {ordersFailed ? (
              <p className='text-sm text-muted-foreground'>
                暂时无法读取历史订单，请刷新重试。
              </p>
            ) : null}
            {staleOrders.length ? (
              <p className='text-sm text-muted-foreground'>
                部分订单暂未同步，显示上次确认的状态。付款后请先刷新，不要重复支付。
              </p>
            ) : null}
            {orders?.length === 0 ? (
              <p className='text-sm text-muted-foreground'>
                {presentation?.empty_orders_text ??
                  '还没有订阅订单。下单后可以在这里查看支付和激活状态。'}
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
                      {order.status === 'fulfilled' &&
                      order.sku !== 'renewal' &&
                      !automaticOrder(order) ? (
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
                          onClick={() => continueOrder(order)}
                        >
                          继续支付
                        </Button>
                      ) : null}
                    </div>
                    <OrderProgress
                      status={order.status}
                      automatic={automaticOrder(order)}
                    />
                    {order.activation ? (
                      <div className='space-y-1' aria-label='订单激活状态'>
                        <div className='flex flex-wrap items-center gap-2'>
                          <span>激活状态</span>
                          <StatusMark
                            tone={activationTones[order.activation.state]}
                            variant='pill'
                          />
                          {order.activation.vm_id ? (
                            <span>目标槽位：{order.activation.vm_id}</span>
                          ) : null}
                        </div>
                        {order.activation.state === 'needs_attention' ? (
                          <div className='space-y-2'>
                            <p className='text-muted-foreground'>
                              {isAdmin
                                ? '自动激活已暂停。确认原目标可用后，可重试原订单；无需重新购买或兑换。'
                                : '自动激活尚未完成，请联系管理员核查原订单；不要重复购买或另行兑换。'}
                            </p>
                            {isAdmin ? (
                              <Button
                                type='button'
                                variant='outline'
                                size='sm'
                                disabled={busy || loading}
                                onClick={() =>
                                  void run(async () => {
                                    const updated = await api<Order>(
                                      `${root}/orders/${encodeURIComponent(order.order_id)}/retry-activation`,
                                      { method: 'POST', body: '{}' }
                                    )
                                    if (updated.order_id !== order.order_id)
                                      throw new Error('order mismatch')
                                    setOrders((prior) =>
                                      prior?.map((item) =>
                                        item.order_id === updated.order_id
                                          ? updated
                                          : item
                                      )
                                    )
                                    refresh((n) => n + 1)
                                    setNotice(
                                      '已刷新原订单的激活状态，请在历史订单查看。'
                                    )
                                  }, '无法重试自动激活，请刷新历史订单后重试。')
                                }
                              >
                                重试自动激活
                              </Button>
                            ) : null}
                          </div>
                        ) : order.activation.state === 'active' ? (
                          <p className='text-muted-foreground'>
                            这里只记录原订单的激活结果。当前使用权限以本机权益和目标槽位的授权状态为准。
                          </p>
                        ) : automaticOrder(order) ? (
                          <p className='text-muted-foreground'>
                            由服务端在交付后处理，无需保持页面打开。支付成功不等于激活完成。
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    {claim?.order_id === order.order_id &&
                    !automaticOrder(order) ? (
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
                        {isAdmin ? (
                          <Button
                            size='sm'
                            onClick={() => setManualCode(claim.redemption_code)}
                          >
                            使用此码激活
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                    {order.status === 'paid' ? (
                      <p className='text-sm text-muted-foreground'>
                        {automaticOrder(order)
                          ? '请勿重复支付。交付后由服务端向所选目标自动激活。'
                          : '请勿重复支付。发码完成后可在原订单领码。'}
                      </p>
                    ) : null}
                    {order.status === 'fulfilled' && !automaticOrder(order) ? (
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
                                  ? '点击「使用此码激活」，核对宿主机与目标槽位后兑换。也可以在订阅页顶部手动输入兑换码。'
                                  : '请将码私下交给目标宿主机管理员，在该机面板的「订阅 CRAG → 购买后激活」中手动兑换。'}
                              </li>
                              <li>
                                激活后会自动给目标槽绑定应用锁。其他槽可在各自的授权页使用已有订阅绑定。
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
        </div>
      </div>
    </PageHeader>
  )
}
