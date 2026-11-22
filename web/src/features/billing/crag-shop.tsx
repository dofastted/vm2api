import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { VIEW_TITLES } from '@/config/nav'
import type { StatusTone } from '@/types/status'
import { IconTelegram } from '@/assets/brand-icons'
import { api, cragDeviceApi, isApiError } from '@/lib/api'
import { randomUUID } from '@/lib/random-uuid'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/components/page-header'
import { StatusMark } from '@/components/status-mark'
import { meQueryOptions } from '@/features/auth/queries'
import { geminiInventoryOptions } from '@/features/import/gemini-environments'
import {
  cragHostStatusLabels,
  cragHostStatusVariant,
  cragSlotsInUse,
} from '@/features/vm/crag-runtime-counts'
import {
  cragHostStatusQueryOptions,
  type CragHostStatus,
} from '@/features/vm/queries'
import {
  formatPlanDetails,
  monthlyPrice,
  planMonths,
  termLabel,
  type CommerceRules,
  type CragPlan,
  type Presentation,
} from './crag-catalog'
import {
  CragCommerce,
  CragPaymentButtons,
  paymentLabels as methods,
  quoteProblem,
  type CommerceSelection,
  type PaymentMethod as Method,
} from './crag-commerce'
import { normalizeLayout, ordersSideClass } from './crag-layout'
import { CragPlanPicker } from './crag-plan-picker'
import { GeminiRedeemDialog } from './gemini-redeem-dialog'

export { formatPlanDetails, termLabel } from './crag-catalog'
export type { CragPlan, Presentation } from './crag-catalog'

const shopRoot = '/api/panel/crag-shop'
const hostRoot = '/api/panel/crag-subscription'
const catalogIntervalMs = 25_000
const catalogTimeoutMs = 12_000
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
  status: 'reserved' | 'pending' | 'paid' | 'fulfilled' | 'cancelled'
  cancelable?: boolean
  activation?: {
    state:
      | 'manual'
      | 'awaiting_fulfillment'
      | 'activating'
      | 'active'
      | 'needs_attention'
      | 'ready_to_apply'
    vm_id?: string
  }
}
type Checkout = Order & { url?: string; data?: Record<string, string> }
type OrderPage = { orders: Order[]; next_offset: number | null }
type ApplicationFeedback = {
  state: 'applying' | 'checking' | 'error' | 'unconfirmed' | 'success'
  text: string
}
type Intent = CommerceSelection & {
  payment_method: Method
  request_id: string
  expected_amount_minor?: number
  activation_target?: { vm_id: string }
}
const dateTime = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
})
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
  cancelled: 0,
}
const orderTones: Record<Order['status'], StatusTone> = {
  reserved: { key: 'reserved', cls: 'none', text: '待确认订单' },
  pending: { key: 'pending', cls: 'caution', text: '待支付' },
  paid: { key: 'paid', cls: 'caution', text: '已付款，发码中' },
  fulfilled: { key: 'fulfilled', cls: 'ok', text: '已发码' },
  cancelled: { key: 'cancelled', cls: 'none', text: '已取消' },
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
  ready_to_apply: {
    key: 'ready_to_apply',
    cls: 'caution',
    text: '待应用到本机',
  },
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
      return '请输入有效的订阅使用券'
    case 'redeem_unavailable':
      return '此码不可用于本机订阅或已失效'
    case 'host_redeem_conflict':
      return '此码与当前宿主机或订阅不匹配'
    case 'crag_subscription_host_package_unready':
      return '请先在内核页拉取可信 CRAG 发行包'
    case 'crag_subscription_host_package_changed':
      return '未完成的兑换对应另一版 CRAG 发行包。请由管理员在本机订阅中确认使用当前发行包恢复原兑换。'
    case 'crag_subscription_recovery_unverified':
      return '尚无法确认原兑换结果。原记录已保留，请联系管理员核对原订单，不要重复购买或重置凭据。'
    case 'crag_subscription_invalid_redemption_receipt':
      return '本机保存的兑换确认记录未通过校验。请联系管理员核对原订单和订阅数据，不要删除记录或重新购买。'
    case 'payload_key_unknown':
      return '授权服务已不再提供原兑换记录的 CRAG 发行包密钥。原记录已保留，请核对原订单，不要重复兑换或重置凭据。'
    case 'issuer_mismatch':
      return '原兑换记录的 CRAG 签发者与授权服务不一致。请恢复匹配的可信发行包后再重试。'
    case 'auth_forbidden': {
      const details = isApiError(error) ? error.details : undefined
      const id = (details as { authority_request_id?: unknown } | undefined)
        ?.authority_request_id
      const validId =
        typeof id === 'string' &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
          id
        )
      return `授权服务拒绝了这台宿主机的兑换请求。请联系管理员核对，不要重置宿主凭据。${validId ? `请求 ID：${id}` : ''}`
    }
    case 'crag_subscription_sync_pending':
      return '上一笔兑换待同步。请点「继续同步」核对原码，不要提交新码。'
    case 'crag_subscription_busy':
      return '另一项宿主订阅操作正在处理，请稍后再试。'
    case 'crag_subscription_authority_unavailable':
      return '未收到授权服务的确认。若显示待同步，请点「继续同步」核对原码，不要重新购买。'
    case 'crag_subscription_host_identity_changed':
      return '本机身份与已保存的订阅不一致。请恢复原实例的身份配置，不要重置凭据。'
    case 'crag_subscription_invalid_entitlement':
      return '未能验证返回的订阅权益。请保留原码并继续同步，不要重新购买。'
    default:
      return '兑换尚未确认，请刷新或继续同步'
  }
}

function applicationError(
  error: unknown,
  unconfirmed = '未能确认本机订阅到账，请核对原订单，不要重复购买。'
) {
  const code = isApiError(error) ? error.code : ''
  let text: string
  if (code === 'shop_device_package_unready') {
    text =
      '本机缺少可用的 CRAG 发行包。请让管理员在内核页拉取后，重试应用原订单。'
  } else if (code === 'host_redeem_conflict') {
    text =
      '原订单的使用券与本机订阅不匹配。请联系管理员核对绑定的服务器，不要重新购买。'
  } else if (code === 'redeem_unavailable') {
    text =
      '授权服务未接受原订单的使用券。请联系管理员或供应方核对该订单，不要重新购买。'
  } else if (code === 'payload_key_unknown') {
    text =
      '授权服务已不再提供原兑换记录的 CRAG 发行包密钥。原记录已保留，请联系管理员核对原订单，不要重复购买或重置凭据。'
  } else if (code === 'issuer_mismatch') {
    text =
      '原兑换记录的 CRAG 签发者与授权服务不一致。请让管理员恢复匹配的可信发行包后，再重试应用原订单。'
  } else if (code === 'shop_redemption_changed') {
    text =
      '供应方为同一订单返回了不同的使用券，应用已停止。请联系管理员核对原订单，不要另行兑换或重新购买。'
  } else if (
    code.startsWith('crag_subscription_') ||
    code === 'auth_forbidden'
  ) {
    text = hostRedemptionError(error)
  } else if (
    /^shop_(device_(unavailable|checkout_required)|host_identity_changed|private_storage_unavailable)$/.test(
      code
    )
  ) {
    text = quoteProblem(error)
  } else if (isApiError(error) && error.status === 401) {
    text = '登录已过期，请重新登录后核对原订单。'
  } else {
    text = unconfirmed
  }
  const details = isApiError(error) ? error.details : undefined
  const requestId = (details as { authority_request_id?: unknown } | undefined)
    ?.authority_request_id
  if (
    code !== 'auth_forbidden' &&
    typeof requestId === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      requestId
    )
  )
    text += ` 请求 ID：${requestId}`
  return text
}

function quotaLabel(value: number | 'unlimited' | null | undefined) {
  return value === 'unlimited' ? '不限' : (value ?? '待核对')
}

function HostSummary({
  status,
  plans,
}: {
  status?: CragHostStatus
  plans: CragPlan[]
}) {
  const runtime = status?.runtime
  const sku = status?.sku
  const planName = sku
    ? sku === 'custom'
      ? '自定义'
      : (plans.find((plan) => plan.sku === sku)?.name ?? sku)
    : status?.state === 'unredeemed'
      ? '未订阅'
      : status
        ? '未返回套餐'
        : '待核对'
  // 用户侧只看两个数字：使用中的槽位 与 充值可用槽位。满了就继续充。
  //
  // 「使用中」只取真值 —— 真正运行中的 CRAG 内核数，与准入强制同源
  // （crag-runtime-inventory.mjs 的同一个 hostRunning 既喂该字段又喂
  // host_over_limit）。切换到 CRAG 内核不受额度限制，只有真正要调度才需要槽位凭证。
  //
  // 刻意砍掉的：CRAG 运行数、当前 VM 总数、待回收绑定 —— 三个看起来都像
  // 「在用多少」的计数，对用户没有行动价值；过期绑定本就不在运行数里，
  // 不需要用户去回收一个数字。也不再渲染 CragRuntimeCounts（与本网格同源）。
  const fields: Array<[string, ReactNode]> = [
    [
      '订阅状态',
      <Badge variant={status ? cragHostStatusVariant[status.state] : 'outline'}>
        {status ? cragHostStatusLabels[status.state] : '状态待核对'}
      </Badge>,
    ],
    ['订阅套餐', planName],
    ['使用中的槽位', cragSlotsInUse(status) ?? '待核对'],
    ['充值可用槽位', quotaLabel(status?.slot_limit)],
    [
      '到期',
      status?.expires_at == null ? (
        '—'
      ) : (
        <SubscriptionTime seconds={status.expires_at} />
      ),
    ],
  ]
  return (
    <section
      aria-label='CRAG 订阅与运行概况'
      className='overflow-hidden rounded-xl border bg-card'
    >
      <dl className='grid grid-cols-2 gap-px bg-border sm:grid-cols-3 lg:grid-cols-5'>
        {fields.map(([label, value]) => (
          <div key={label} className='min-w-0 bg-card px-4 py-3'>
            <dt className='text-xs text-muted-foreground'>{label}</dt>
            <dd className='mt-1 font-semibold wrap-anywhere tabular-nums'>
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {runtime?.host_over_limit === true ? (
        <p role='alert' className='border-t px-4 py-2 text-sm text-destructive'>
          宿主订阅超额，仅超额槽暂停调度
        </p>
      ) : null}
      <div className='flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t px-4 py-2 text-sm'>
        <p className='min-w-0 text-muted-foreground'>
          本机与集群的 Docker、KVM 槽共享同一份订阅额度
        </p>
        <Button size='sm' variant='link' className='px-0' asChild>
          <Link to='/wrap'>前往内核页切换 VM 内核</Link>
        </Button>
      </div>
    </section>
  )
}

function HostOverview({
  host,
  onUpdated,
}: {
  host: UseQueryResult<CragHostStatus>
  onUpdated: () => void
}) {
  const qc = useQueryClient()
  const [confirmUpgrade, setConfirmUpgrade] = useState(false)
  const [upgradeFailed, setUpgradeFailed] = useState(false)
  const [code, setCode] = useState('')
  const [notice, setNotice] = useState<{ text: string; error?: true }>()
  const [action, setAction] = useState<'redeem' | 'recover' | 'upgrade'>()
  const [packageChanged, setPackageChanged] = useState(false)
  const [confirmRecovery, setConfirmRecovery] = useState(false)
  const operating = useRef(false)
  const status = host.isError ? undefined : host.data
  const syncPending = host.data?.state === 'sync_pending'
  const reclaimPending = (status?.reclaim_pending_count ?? 0) > 0
  const canRecover =
    syncPending || (status?.reclaim_supported && reclaimPending)
  const upgrading = action === 'upgrade'

  async function updateHost(
    operation: 'redeem' | 'recover',
    useCurrentPackage = false
  ) {
    const redemptionCode = code.trim()
    if (operating.current) return
    if (operation === 'redeem' && redemptionCode.startsWith('CGG1-')) {
      operating.current = true
      setAction('redeem')
      setNotice(undefined)
      try {
        const result = await api<{ kernel_version: string }>(
          '/api/panel/gemini/payload/redeem',
          {
            method: 'POST',
            body: JSON.stringify({ redemption_code: redemptionCode }),
          }
        )
        setCode('')
        setNotice({
          text: `CRAGGemini ${result.kernel_version} 已激活。Google 账号仍需单独授权。`,
        })
        await qc.invalidateQueries({
          queryKey: geminiInventoryOptions().queryKey,
        })
      } catch (error) {
        setNotice({
          text:
            isApiError(error) && error.code?.startsWith('gemini_')
              ? error.message
              : '无法确认 CRAGGemini 兑换结果，请重试。',
          error: true,
        })
      } finally {
        operating.current = false
        setAction(undefined)
      }
      return
    }
    if (operation === 'redeem' && (!redemptionCode || syncPending)) return
    if (operation === 'recover' && !canRecover) return
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
            : useCurrentPackage
              ? JSON.stringify({ use_current_package: true })
              : '{}',
      })
      qc.setQueryData(queryKey, next)
      if (next.state === 'active' || next.state === 'expired') {
        setPackageChanged(false)
        setConfirmRecovery(false)
        onUpdated()
        setCode('')
        setNotice({
          text:
            operation === 'redeem'
              ? '充值可用槽位已更新，未自动把 VM 切到 CRAG'
              : (next.reclaim_pending_count ?? 0) > 0
                ? '仍有绑定待回收确认'
                : '订阅状态已同步',
        })
      } else if (next.state !== 'sync_pending') {
        setNotice({
          text: '授权结果尚未安装，请刷新本机订阅并核对状态。',
          error: true,
        })
      }
    } catch (error) {
      setPackageChanged(
        isApiError(error) &&
          error.code === 'crag_subscription_host_package_changed'
      )
      setConfirmRecovery(false)
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
      {status ? (
        <>
          <dl className='grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm tabular-nums [&_dd]:wrap-anywhere [&_dt]:text-muted-foreground'>
            <dt>套餐编号 / 每期时长</dt>
            <dd>
              {status.sku ?? '—'} /{' '}
              {status.months != null ? `${status.months} 个月` : '—'}
            </dd>
            <dt>下次额度到期</dt>
            <dd>
              {status.expires_at == null ? (
                '—'
              ) : (
                <SubscriptionTime seconds={status.expires_at} />
              )}
            </dd>
            <dt>订阅总额度 / 已占用</dt>
            <dd>
              {quotaLabel(status.slot_limit)} / {quotaLabel(status.used_slots)}
            </dd>
            <dt>适用 VM / 已启用</dt>
            <dd>
              {quotaLabel(status.total_slots)} /{' '}
              {quotaLabel(status.enabled_slots)}
            </dd>
            <dt>订阅槽运行 / 还可运行</dt>
            <dd>
              {quotaLabel(status.runtime?.host_running_vms)} /{' '}
              {quotaLabel(status.runtime?.host_runtime_available)}
            </dd>
            <dt>权益修订号</dt>
            <dd>{status.revision ?? '—'}</dd>
          </dl>
          <details className='rounded-md border px-3 text-sm'>
            <summary className='cursor-pointer py-2 font-medium'>
              原始状态数据（JSON）
            </summary>
            <p className='text-xs text-muted-foreground'>
              仅显示面板状态响应，不含签名权益、兑换码或密钥。可能包含 VM ID。
            </p>
            <pre className='my-3 max-h-72 overflow-auto rounded bg-muted p-3 text-xs wrap-anywhere whitespace-pre-wrap'>
              {JSON.stringify(status, null, 2)}
            </pre>
          </details>
        </>
      ) : null}
      {reclaimPending && !status?.reclaim_supported ? (
        <p className='text-sm text-muted-foreground'>
          旧订阅的已删除绑定待启用槽位回收。
        </p>
      ) : null}
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
          删除槽位或切回 cli-node 后，经回收确认释放绑定额度。仅停止不立即回收。
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
          槽位探测失败。请点击「刷新本机订阅」重试探测。
        </p>
      ) : null}
      <p className='text-sm text-muted-foreground empty:sr-only'>
        {syncPending
          ? '继续同步会核对原码；新码请等原兑换确认后再提交。'
          : host.isError || status?.state === 'unavailable'
            ? '无法确认本机权益，请刷新后重试。'
            : probeFailed
              ? ''
              : status && !status.ready
                ? '切换 VM 内核到 CRAG 不受额度限制；只有真正调度运行时才占用槽位。本机与集群的 VM 共享同一份槽位。'
                : '充值只增加可用槽位，不会自动把 VM 切到 CRAG。切换内核随时可做，到内核页为目标 VM 操作即可。'}
      </p>
      {canRecover ? (
        <Button
          type='button'
          size='sm'
          variant='outline'
          disabled={!!action}
          onClick={() => void updateHost('recover')}
        >
          {action === 'recover' ? '正在同步…' : '继续同步'}
        </Button>
      ) : null}
      {syncPending && packageChanged ? (
        <Button
          type='button'
          size='sm'
          variant='outline'
          disabled={!!action}
          onClick={() => setConfirmRecovery(true)}
        >
          使用当前发行包恢复原兑换
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirmRecovery}
        onOpenChange={(open) => {
          if (!action) setConfirmRecovery(open)
        }}
        title='使用当前发行包恢复原兑换？'
        desc='将核对原兑换和当前发行包，再继续同一张使用券的兑换。无法安全恢复时会保留原记录并显示具体原因，无需重新购买。'
        confirmText='确认恢复原兑换'
        cancelBtnText='取消'
        isLoading={action === 'recover'}
        handleConfirm={() => void updateHost('recover', true)}
      />
      {!syncPending ? (
        <form
          aria-label='兑换订阅使用券'
          className='max-w-xl space-y-2 border-t pt-3'
          onSubmit={(event) => {
            event.preventDefault()
            void updateHost('redeem')
          }}
        >
          <label className='grid gap-1 text-sm'>
            订阅使用券
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
            每张码从兑换时独立计时，未到期额度相加；不绑定、不启动 VM。 Claude
            订阅码增加本机槽位；以 CGG1- 开头的码兑换 CRAGGemini，不占用 Claude
            槽位。
          </p>
          <Button type='submit' size='sm' disabled={!code.trim() || !!action}>
            {action === 'redeem' ? '正在兑换…' : '兑换到本机'}
          </Button>
        </form>
      ) : null}
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

function planTerms(plan: Pick<Order, 'amount_minor' | 'slot_limit'>) {
  if (plan.amount_minor === null || plan.slot_limit === null)
    return '金额与额度待确认'
  const { price, quota } = formatPlanDetails(plan.amount_minor, plan.slot_limit)
  return `${price} · ${quota}`
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
      overview={
        isAdmin
          ? (onUpdated) => <HostOverview host={host} onUpdated={onUpdated} />
          : null
      }
    />
  )
}

export function CragDevicePurchasePage() {
  return (
    <main className='mx-auto max-w-7xl px-4 py-6 sm:px-6'>
      <ShopOrders device owner='' isAdmin={false} overview={null} />
    </main>
  )
}

function ShopOrders({
  device = false,
  isAdmin,
  host,
  owner,
  overview,
}: {
  device?: boolean
  isAdmin: boolean
  host?: CragHostStatus
  owner: string
  overview: ((onUpdated: () => void) => ReactNode) | null
}) {
  const qc = useQueryClient()
  const request = device ? cragDeviceApi : api
  const root = device ? '' : shopRoot
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
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [problem, setProblem] = useState('')
  const [cancelTarget, setCancelTarget] = useState<Order>()
  const [claim, setClaim] = useState<{
    order_id: string
    redemption_code: string
  }>()
  const intent = useRef<Intent | null>(null)
  const operating = useRef(false)
  const [targetVmId, setTargetVmId] = useState('')
  const [applications, setApplications] = useState<
    Record<string, ApplicationFeedback>
  >({})
  const [ordersProblem, setOrdersProblem] = useState('')
  // A cancelled or expired checkout is history, not work. It stays reachable, but the
  // order the buyer came for should not have to be found among closed ones.
  const activeOrders = orders?.filter((order) => order.status !== 'cancelled')
  const closedOrders = orders?.filter((order) => order.status === 'cancelled')
  const targets = useQuery({
    queryKey: ['panel', 'crag-shop', 'activation-targets', owner],
    queryFn: ({ signal }) =>
      api<{ targets: { vm_id: string }[] }>(`${shopRoot}/activation-targets`, {
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
    function afterCheckout(event: PageTransitionEvent) {
      if (event.persisted) refresh((value) => value + 1)
    }
    window.addEventListener('pageshow', afterCheckout)
    return () => window.removeEventListener('pageshow', afterCheckout)
  }, [])

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
      const catalogRequest = { controller, timeout }
      active = catalogRequest

      void request<Catalog>(`${root}/plans`, {
        signal: controller.signal,
        cache: 'no-store',
      })
        .then((data) => {
          if (active !== catalogRequest) return
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
        })
        .catch(() => {
          if (active === catalogRequest) setCatalog({ status: 'error' })
        })
        .finally(() => {
          window.clearTimeout(timeout)
          if (active === catalogRequest) active = undefined
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
  }, [request, root])

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    setLoading(true)
    void request<OrderPage>(`${root}/orders?offset=${offset}`, { signal })
      .then(async (page) => {
        const visible = page.orders.slice()
        const stale: string[] = []
        const pending = visible
          .map((order, index) => ({ order, index }))
          .filter(
            ({ order }) =>
              order.status !== 'cancelled' &&
              (order.status !== 'fulfilled' ||
                (automaticOrder(order) && order.activation?.state !== 'active'))
          )
        for (let i = 0; i < pending.length && !signal.aborted; i += 4) {
          await Promise.all(
            pending.slice(i, i + 4).map(async ({ order, index }) => {
              try {
                visible[index] = await request<Order>(
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
          setOrdersProblem('')
          setLoading(false)
        },
        (error: unknown) => {
          if (signal.aborted) return
          setOrders(undefined)
          setNextOffset(null)
          setStaleOrders([])
          setOrdersFailed(true)
          setOrdersProblem(
            applicationError(
              error,
              '暂时无法读取历史订单，请刷新重试；到账结果以原订单确认为准。'
            )
          )
          setLoading(false)
        }
      )
    return () => controller.abort()
  }, [offset, request, revision, root])

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
        isApiError(error) &&
          (error.code === 'shop_order_paid' ||
            error.code === 'shop_order_cannot_cancel')
          ? error.code === 'shop_order_paid'
            ? '此订单已完成支付，不能取消。请刷新查看交付状态。'
            : '订单状态已变化，无法取消。请刷新订单核对状态。'
          : isApiError(error) && error.code === 'shop_device_package_unready'
            ? '本机缺少可用的 CRAG 发行包。请让管理员从内核页拉取后，重试应用原订单。'
            : isApiError(error) &&
                /^shop_(device_(unavailable|checkout_required)|host_identity_changed|private_storage_unavailable)$/.test(
                  error.code
                )
              ? quoteProblem(error)
              : isApiError(error) && error.status === 401
                ? '登录已过期，请重新登录后查看历史订单。'
                : isApiError(error) &&
                    error.code === 'shop_activation_target_unavailable'
                  ? '所选槽位暂不可用。请先核对历史订单，再刷新激活目标或选择仅领取兑换码。'
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

  async function applyDeviceOrder(order: Order, checkOnly = false) {
    if (operating.current) return
    operating.current = true
    setBusy(true)
    const feedback = (value: ApplicationFeedback) =>
      setApplications((prior) => ({ ...prior, [order.order_id]: value }))
    const requestOrder = async (apply: boolean) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15_000)
      try {
        const updated = await request<Order>(
          `${root}/orders/${encodeURIComponent(order.order_id)}${apply ? '/apply' : ''}`,
          {
            ...(apply ? { method: 'POST', body: '{}' } : {}),
            signal: controller.signal,
          }
        )
        if (updated.order_id !== order.order_id)
          throw new Error('order mismatch')
        setOrders((prior) =>
          prior?.map((item) =>
            item.order_id === updated.order_id ? updated : item
          )
        )
        return updated
      } finally {
        clearTimeout(timeout)
      }
    }
    const confirm = async (updated: Order) => {
      if (updated.activation?.state !== 'active') return false
      feedback({
        state: 'success',
        text: '订阅额度已加入此服务器。请在内核页选择槽位并启用 CRAG。',
      })
      await qc.invalidateQueries({
        queryKey: cragHostStatusQueryOptions().queryKey,
      })
      return true
    }
    feedback({
      state: checkOnly ? 'checking' : 'applying',
      text: checkOnly
        ? '正在核对原订单的到账结果…'
        : '正在将订阅额度充入此服务器…',
    })
    try {
      const updated = await requestOrder(!checkOnly)
      if (!(await confirm(updated)))
        feedback({
          state: 'unconfirmed',
          text: '原订单尚未确认到账。请继续核对原订单，或重试同一订单的应用；不要重复购买。',
        })
    } catch (error) {
      const uncertain =
        !isApiError(error) || error.status === 0 || error.status >= 500
      if (!checkOnly && uncertain) {
        feedback({ state: 'checking', text: '应用结果待确认，正在核对原订单…' })
        try {
          if (await confirm(await requestOrder(false))) return
        } catch {
          // A failed status request cannot establish whether redemption succeeded.
        }
      }
      feedback({
        state: uncertain || checkOnly ? 'unconfirmed' : 'error',
        text: applicationError(error),
      })
    } finally {
      operating.current = false
      setBusy(false)
    }
  }

  function start(input: Intent, resumeId?: string) {
    void run(
      async () => {
        if (!resumeId) intent.current = input
        const order = await request<Checkout>(
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
        if (order.status === 'pending' && order.url && order.data) {
          if (
            order.payment_method !== input.payment_method ||
            (resumeId && order.order_id !== resumeId)
          )
            throw new Error('checkout order mismatch')
          pay(order.url, order.data)
        } else if (order.status === 'cancelled')
          setNotice('该订单已取消，请选择套餐重新下单。')
        else if (order.status === 'paid')
          setNotice('已付款，等待交付，请勿重复支付。')
        else if (order.status === 'fulfilled')
          setNotice(
            device
              ? '订单已交付，请在历史订单中应用到本机。'
              : automaticOrder(order)
                ? '订单已交付，请查看原订单的激活状态。'
                : '兑换码已就绪，请在原订单领取。'
          )
        else setNotice('当前无法打开收银台，请稍后从原订单重试。')
        if (intent.current?.request_id === input.request_id)
          intent.current = null
        refresh((n) => n + 1)
        setOffset(0)
      },
      resumeId
        ? '未能恢复原订单的付款信息。请先刷新历史订单，不要重复付款。'
        : '未能确认下单结果。请先查看历史订单，或重试同一订单，不要重复付款。'
    )
  }

  function pay(action: string, data: Record<string, string>) {
    const url = new URL(action)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      throw new Error('invalid checkout URL')
    const form = document.createElement('form')
    form.hidden = true
    form.action = url.href
    form.method = 'POST'
    form.target = '_self'
    form.rel = 'noreferrer'
    for (const [key, value] of Object.entries(data)) {
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
    setNotice('正在前往收银台。支付后返回此页刷新历史订单。')
  }

  const allPlans = catalog.status === 'ready' ? catalog.data.plans : []
  const plans = allPlans.filter((plan) => plan.enabled !== false)
  const presentation =
    catalog.status === 'ready' ? catalog.data.presentation : undefined
  // 纯函数，不包 useMemo：预览页的测试 mock 对 hook 调用顺序敏感，两边保持同一写法。
  const layout = normalizeLayout(presentation?.layout)
  // 目录没有 layout 时等同于全默认排版（crag-auth 在布局等于默认时直接不写该键），
  // 所以订单区位置一律由 orders_position 决定，不再看 isAdmin。
  const ordersSide = layout.ordersPosition === 'side'
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
            : !commerce && !selectedPlan
              ? '套餐已更新，请重新选择。'
              : ''
  function createOrder(
    selection: CommerceSelection,
    paymentMethod: Method,
    price?: number
  ) {
    if (!canOrder || !channels.includes(paymentMethod) || busy) return
    const activation_target =
      isAdmin && selection.sku !== 'renewal' && targetVmId
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
      last.payment_method === paymentMethod &&
      last.expected_amount_minor === price &&
      last.activation_target?.vm_id === activation_target?.vm_id
    if (!same && activation_target && !targetAvailable) {
      setProblem(
        '所选自动激活目标暂不可用。请先核对历史订单，再刷新激活目标或选择仅领取兑换码。'
      )
      return
    }
    start(
      same
        ? last
        : {
            ...selection,
            payment_method: paymentMethod,
            request_id: randomUUID(),
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

  function cancelOrder(order: Order) {
    void run(async () => {
      const updated = await request<Order>(
        `${root}/orders/${encodeURIComponent(order.order_id)}/cancel`,
        {
          method: 'POST',
          body: '{}',
        }
      ).finally(() => {
        setCancelTarget(undefined)
        refresh((value) => value + 1)
      })
      if (updated.order_id !== order.order_id || updated.status !== 'cancelled')
        throw new Error('order cancellation mismatch')
      if (intent.current?.request_id === updated.request_id)
        intent.current = null
      setOrders((prior) =>
        prior?.map((item) =>
          item.order_id === updated.order_id ? updated : item
        )
      )
      setNotice('已关闭该订单。')
    }, '未能确认取消，请刷新历史订单。')
  }

  function showSection(id: string) {
    const section = document.getElementById(id)
    section?.focus({ preventScroll: true })
    section?.scrollIntoView({ block: 'start' })
  }

  const deliveryOptions = isAdmin ? (
    <details className='rounded-md border px-3 text-sm'>
      <summary className='cursor-pointer py-2 font-medium'>
        自动激活（新订单）
        <span className='ms-2 font-normal text-muted-foreground'>
          {targetVmId || '未启用，仅领取兑换码'}
        </span>
      </summary>
      <div className='flex flex-wrap items-end gap-2 pb-3'>
        <label className='grid min-w-0 flex-1 gap-1'>
          交付目标
          <select
            className='min-h-11 min-w-0 rounded-md border bg-background px-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
            value={targetVmId}
            disabled={busy}
            onChange={(event) => setTargetVmId(event.target.value)}
          >
            <option value=''>仅领取兑换码（不自动激活）</option>
            {targetVmId &&
            !eligibleTargets.some((target) => target.vm_id === targetVmId) ? (
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
        <Button
          type='button'
          variant='ghost'
          size='sm'
          disabled={targets.isFetching || busy}
          onClick={() => void targets.refetch()}
        >
          刷新激活目标
        </Button>
        <p role='status' className='basis-full text-muted-foreground'>
          {targets.isError
            ? '未能读取目标，可刷新或改为仅领码。'
            : targets.isFetching
              ? '正在查询目标…'
              : !eligibleTargets.length
                ? '暂无可用目标，可先领码。'
                : '交付后自动兑换并绑定，不更改 VM 的内核选择。'}
        </p>
      </div>
    </details>
  ) : null

  return (
    <PageHeader
      title={presentation?.title ?? VIEW_TITLES['crag-subscription']}
      description={
        device
          ? '免登录购买，权益仅应用到此面板所在宿主机。请用同一浏览器查看订单，付款前后不要清除 Cookie。'
          : (presentation?.description ??
            '查看订阅套餐和本人历史订单。付款、交付与激活状态分别确认。')
      }
      extra={
        <div className='flex flex-wrap items-center gap-2'>
          <a
            href='https://t.me/vm2api'
            target='_blank'
            rel='noreferrer'
            title='Telegram 群 @vm2api'
            className='inline-flex h-8 items-center gap-1.5 rounded-md border border-[#229ED9]/40 bg-[#229ED9]/10 px-2.5 text-sm font-medium text-[#229ED9] outline-hidden transition-colors hover:bg-[#229ED9]/18 focus-visible:ring-2 focus-visible:ring-ring'
          >
            <IconTelegram aria-hidden className='size-4 shrink-0' />
            TG 群
          </a>
          <Button
            size='sm'
            variant='outline'
            onClick={() => showSection('crag-order-history')}
          >
            查看订单
          </Button>
          <Button size='sm' variant='outline' asChild>
            {device ? (
              <Link to='/login'>登录控制台</Link>
            ) : (
              <Link to='/crag-purchase'>免登录购买到本机</Link>
            )}
          </Button>
          {isAdmin && !device ? (
            <GeminiRedeemDialog
              onRedeemed={() => {
                void qc.invalidateQueries({
                  queryKey: geminiInventoryOptions().queryKey,
                })
              }}
            />
          ) : null}
        </div>
      }
    >
      <div className='grid min-w-0 gap-6'>
        {isAdmin ? <HostSummary status={host} plans={allPlans} /> : null}
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
        <ConfirmDialog
          open={!!cancelTarget}
          onOpenChange={(open) => {
            if (!open && !busy) setCancelTarget(undefined)
          }}
          title='取消这笔订单？'
          desc='未支付的订单会在核对商城状态后关闭。已支付的订单不会被取消。此操作不退款，也不会关闭已打开的收银台。'
          confirmText='取消订单'
          cancelBtnText='返回'
          destructive
          isLoading={busy}
          handleConfirm={() => {
            if (cancelTarget) cancelOrder(cancelTarget)
          }}
        />
        <div className='grid min-w-0 gap-6'>
          <section
            aria-label={presentation?.plans_title ?? '订阅套餐'}
            className='min-w-0 space-y-5 rounded-xl border bg-card p-4 sm:p-5'
          >
            <header className='flex flex-wrap items-start justify-between gap-2'>
              <div className='space-y-1'>
                <h2 className='text-lg font-semibold'>
                  {presentation?.plans_title ?? '购买订阅'}
                </h2>
                <p className='text-sm text-muted-foreground'>
                  选择套餐后，点击付款方式直接进入对应收银台。
                </p>
              </div>
              <Button
                type='button'
                size='sm'
                variant='ghost'
                onClick={() => refreshCatalog.current?.()}
              >
                刷新套餐
              </Button>
            </header>
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
                  monthly: monthlyPrice(
                    plan.amount_minor,
                    planMonths(plan.term, plan.months)
                  ),
                  ...formatPlanDetails(plan.amount_minor, plan.slot_limit),
                }))}
                selectedSku={selectedPlan?.sku}
                onSelect={setPlanSku}
                disabled={busy}
                layout={layout}
              />
            ) : null}
            {!commerce ? deliveryOptions : null}
            {canOrder && !commerce ? (
              <CragPaymentButtons
                channels={channels}
                disabled={busy || !selectedPlan || selectedPlan.remaining === 0}
                onPay={(channel) => {
                  if (!selectedPlan || selectedPlan.remaining === 0) return
                  createOrder({ sku: selectedPlan.sku }, channel)
                }}
              />
            ) : null}
            {commerce && hasPurchaseOptions ? (
              <CragCommerce
                rules={commerce}
                plans={plans}
                sku={commerceSku}
                onSelect={setPlanSku}
                allowRenewal={canRenew}
                enabled={canOrder}
                busy={busy}
                initialQuoteKey={revision + catalogRevision}
                catalogKey={
                  catalog.status === 'ready'
                    ? JSON.stringify(catalog.data)
                    : undefined
                }
                customTitle={presentation?.custom_title}
                device={device}
                paymentMethods={channels}
                deliveryOptions={deliveryOptions}
                layout={layout}
                onOrder={(selection, price, channel) =>
                  createOrder(selection, channel, price)
                }
              />
            ) : null}
            {plans.length > 0 && !canOrder && !commerce ? (
              <Button type='button' disabled>
                暂不可下单
              </Button>
            ) : null}
          </section>
          <div
            className={`grid min-w-0 items-start gap-6 ${ordersSide ? ordersSideClass : ''}`}
          >
            <section
              aria-label={presentation?.orders_title ?? '历史订单'}
              id='crag-order-history'
              tabIndex={-1}
              className='min-w-0 scroll-mt-20 space-y-3 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring'
            >
              <div className='flex items-center justify-between gap-2'>
                <h2 className='font-medium'>
                  {presentation?.orders_title ?? '历史订单'}
                </h2>
                <Button
                  size='sm'
                  variant='ghost'
                  disabled={loading || busy}
                  onClick={() => refresh((n) => n + 1)}
                >
                  刷新订单
                </Button>
              </div>
              {loading && !orders && !ordersFailed ? (
                <Skeleton className='h-12 w-full' />
              ) : null}
              {ordersFailed ? (
                <p role='alert' className='text-sm text-destructive'>
                  {ordersProblem || '暂时无法读取历史订单，请刷新重试。'}
                </p>
              ) : null}
              {staleOrders.length ? (
                <p className='text-sm text-muted-foreground'>
                  部分订单暂未同步，显示上次确认的状态。付款后请先刷新，不要重复支付。
                </p>
              ) : null}
              {activeOrders?.length === 0 ? (
                <p className='text-sm text-muted-foreground'>
                  {closedOrders?.length
                    ? '没有进行中的订单。已关闭的订单在下方。'
                    : (presentation?.empty_orders_text ??
                      '还没有订阅订单。下单后可以在这里查看支付和激活状态。')}
                </p>
              ) : null}
              {activeOrders?.length ? (
                <ul className='divide-y rounded-md border'>
                  {activeOrders.map((order) => (
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
                        {order.cancelable ? (
                          <Button
                            variant='outline'
                            size='sm'
                            disabled={busy || loading}
                            onClick={() => setCancelTarget(order)}
                          >
                            取消订单
                          </Button>
                        ) : null}
                        {order.status === 'fulfilled' &&
                        !device &&
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
                        {device &&
                        order.activation?.state === 'ready_to_apply' ? (
                          <Button
                            size='sm'
                            disabled={busy || loading}
                            onClick={() => void applyDeviceOrder(order)}
                          >
                            {applications[order.order_id]?.state === 'applying'
                              ? '正在应用…'
                              : applications[order.order_id]?.state ===
                                  'checking'
                                ? '正在核对…'
                                : '应用到本机'}
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
                      {device &&
                      applications[order.order_id] &&
                      (order.activation?.state !== 'active' ||
                        applications[order.order_id].state === 'success') ? (
                        <div className='space-y-2' aria-label='本订单应用结果'>
                          <p
                            role={
                              applications[order.order_id].state === 'error'
                                ? 'alert'
                                : 'status'
                            }
                            className={
                              applications[order.order_id].state === 'error'
                                ? 'break-words text-destructive'
                                : 'break-words text-muted-foreground'
                            }
                          >
                            {applications[order.order_id].text}
                          </p>
                          {['error', 'unconfirmed'].includes(
                            applications[order.order_id].state
                          ) ? (
                            <div className='flex flex-wrap gap-2'>
                              <Button
                                size='sm'
                                variant='outline'
                                disabled={busy || loading}
                                onClick={() =>
                                  void applyDeviceOrder(order, true)
                                }
                              >
                                核对原订单
                              </Button>
                              <Button size='sm' variant='outline' asChild>
                                <Link to='/crag-subscription'>
                                  管理员核对本机订阅
                                </Link>
                              </Button>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                      {order.status !== 'cancelled' ? (
                        <OrderProgress
                          status={order.status}
                          automatic={device || automaticOrder(order)}
                        />
                      ) : null}
                      {order.activation ? (
                        <div className='space-y-1' aria-label='订单激活状态'>
                          <div className='flex flex-wrap items-center gap-2'>
                            <span>{device ? '到账状态' : '激活状态'}</span>
                            <StatusMark
                              tone={
                                device && order.activation.state === 'active'
                                  ? {
                                      key: 'active',
                                      cls: 'ok',
                                      text: '额度已到账',
                                    }
                                  : device &&
                                      order.activation.state ===
                                        'awaiting_fulfillment'
                                    ? {
                                        key: 'awaiting_fulfillment',
                                        cls: 'caution',
                                        text: '等待交付',
                                      }
                                    : activationTones[order.activation.state]
                              }
                              variant='pill'
                            />
                            {order.activation.vm_id ? (
                              <span>目标槽位：{order.activation.vm_id}</span>
                            ) : null}
                          </div>
                          {device &&
                          order.activation.state === 'ready_to_apply' ? (
                            <p className='text-muted-foreground'>
                              本机指运行此面板的服务器。应用后额度充入此服务器，再由管理员选择槽位并启用
                              CRAG。
                            </p>
                          ) : order.activation.state === 'needs_attention' ? (
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
                            <div className='space-y-2'>
                              <p className='text-muted-foreground'>
                                {device
                                  ? '订阅额度已加入本机。请由管理员在内核页选择槽位并启用 CRAG。'
                                  : '这里只记录原订单的激活结果。当前使用权限以本机权益和目标槽位的授权状态为准。'}
                              </p>
                              {device ? (
                                <Button size='sm' variant='outline' asChild>
                                  <Link to='/wrap'>前往内核页启用槽位</Link>
                                </Button>
                              ) : null}
                            </div>
                          ) : !device && automaticOrder(order) ? (
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
                                setNotice('已复制订阅使用券。')
                              }, '无法访问剪贴板，请手动选中订阅使用券复制。')
                            }
                          >
                            复制订阅使用券
                          </Button>
                        </div>
                      ) : null}
                      {order.status === 'paid' ? (
                        <p className='text-sm text-muted-foreground'>
                          {device
                            ? '请勿重复支付。交付后可将额度应用到本机。'
                            : automaticOrder(order)
                              ? '请勿重复支付。交付后由服务端向所选目标自动激活。'
                              : '请勿重复支付。发码完成后可在原订单领码。'}
                        </p>
                      ) : null}
                      {order.status === 'fulfilled' &&
                      !device &&
                      !automaticOrder(order) ? (
                        <div className='space-y-2 border-t pt-3 text-sm'>
                          {order.sku === 'renewal' ? (
                            isAdmin ? (
                              <div className='space-y-2'>
                                <p>
                                  此续费仅适用于下单时的宿主机。应用后新增独立计时的额度，原有槽位绑定不变。
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
                              <p className='font-medium'>怎样使用订阅使用券</p>
                              <ol className='list-decimal space-y-1 ps-5 text-muted-foreground'>
                                <li>
                                  点击「领取兑换码」，复制以{' '}
                                  <code>CRAGR1.</code>{' '}
                                  开头的整串码。再次领取返回同一码。
                                </li>
                                <li>
                                  {isAdmin
                                    ? '在本页「订阅使用券」输入框兑换到本机。兑换只增加宿主机额度，不绑定、不启动 VM。'
                                    : '请将券私下交给目标宿主机的管理员，在该机面板的订阅页用「订阅使用券」兑换。'}
                                </li>
                                <li>
                                  兑换后到内核页，为目标 VM 管理 CRAG
                                  授权并切换内核。
                                </li>
                              </ol>
                              <p className='text-xs text-muted-foreground'>
                                每码仅能在一台宿主机兑换，不可转移。它不是调用
                                API 的 Key，也不是旧授权注册码。
                              </p>
                              {isAdmin ? (
                                <Button
                                  size='sm'
                                  variant='link'
                                  className='h-auto p-0'
                                  asChild
                                >
                                  <Link to='/wrap'>打开内核页</Link>
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
              {closedOrders?.length ? (
                <details className='rounded-md border px-3 text-sm'>
                  <summary className='cursor-pointer py-2 text-muted-foreground'>
                    显示 {closedOrders.length} 笔已关闭订单
                  </summary>
                  <ul className='divide-y border-t text-muted-foreground'>
                    {closedOrders.map((order) => (
                      <li
                        key={order.order_id}
                        className='flex flex-wrap items-center gap-x-2 gap-y-1 py-2 text-xs'
                      >
                        <span className='font-medium'>
                          {termLabel(order.term, order.sku, order.months)}
                        </span>
                        <span>· {methods[order.payment_method]}</span>
                        <span>
                          · 下单 <SubscriptionTime seconds={order.created_at} />
                        </span>
                        <StatusMark
                          tone={orderTones[order.status]}
                          variant='pill'
                        />
                        <span className='w-full truncate'>
                          订单号 {order.order_id}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
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
            {overview?.(() => refresh((n) => n + 1))}
          </div>
        </div>
      </div>
    </PageHeader>
  )
}
