import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, isApiError } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { geminiInventoryOptions } from '@/features/import/gemini-environments'
import {
  cragHostMigrateErrors,
  cragSubscriptionErrors,
} from '@/features/vm/crag-subscription-errors'
import {
  cragHostOrdersQueryOptions,
  cragHostStatusQueryOptions,
  geminiCragOrdersQueryOptions,
  geminiCragSubscriptionQueryOptions,
  type CragCloudOrder,
  type CragCloudOrdersResponse,
  type CragHostStatus,
  type GeminiHostStatus,
} from '@/features/vm/queries'
import { yuan } from './crag-catalog'
import { paymentLabels, type PaymentMethod } from './crag-commerce'

const dateTime = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatSeconds(seconds?: number | null) {
  if (!seconds) return '—'
  const date = new Date(seconds * 1000)
  return Number.isFinite(date.getTime()) ? dateTime.format(date) : '—'
}

function validHostOrUuid(value: string) {
  const trimmed = value.trim().toLowerCase()
  if (/^[a-f0-9]{64}$/.test(trimmed)) return true
  const flat = trimmed.replace(/-/g, '')
  return /^[a-f0-9]{32}$/.test(flat) && !/^(0{32}|f{32})$/.test(flat)
}

function validMigrationProof(value: string) {
  const trimmed = value.trim()
  return trimmed.startsWith('CRAGR1.')
    ? trimmed.length > 7
    : /^[0-9a-zA-Z_-]{1,64}$/.test(trimmed)
}

function channelLabel(method: string) {
  if (method === 'alipay') return paymentLabels.alipay
  if (method === 'wxpay') return paymentLabels.wxpay
  return method || '—'
}

function orderEffectiveExpiry(order: CragCloudOrder) {
  return order.grant_expires_at ?? order.expires_at
}

function orderStatusBadge(order: CragCloudOrder) {
  const now = Math.floor(Date.now() / 1000)
  if (order.status === 'revoked')
    return { label: '已吊销', variant: 'destructive' as const }
  const expiry = orderEffectiveExpiry(order)
  if (order.active === false || (expiry > 0 && expiry <= now))
    return { label: '已到期', variant: 'secondary' as const }
  return { label: '生效中', variant: 'default' as const }
}

type LockedRenewalQuote = {
  sku: string
  months: number
  slot_limit: number | 'unlimited'
  subtotal_minor: number
  discount_minor: number
  amount_minor: number
  renew_order_id?: string
}

export function CragCloudOrdersPanel({
  product = 'crag-v2',
  host,
  hostIdOverride,
  channels,
  busy,
  onRenewOrder,
  onHostChanged,
}: {
  product?: 'crag-v2' | 'craggemini'
  host?: CragHostStatus
  hostIdOverride?: string | null
  channels: readonly PaymentMethod[]
  busy: boolean
  onRenewOrder: (
    orderId: string,
    amountMinor: number,
    method: PaymentMethod
  ) => void
  onHostChanged: () => void
}) {
  const isGemini = product === 'craggemini'
  const qc = useQueryClient()
  const ordersQuery = useQuery({
    queryKey: isGemini
      ? geminiCragOrdersQueryOptions().queryKey
      : cragHostOrdersQueryOptions().queryKey,
    queryFn: ({ signal }) =>
      api<CragCloudOrdersResponse>(
        isGemini
          ? '/api/panel/gemini/crag-subscription/orders?limit=50&offset=0'
          : '/api/panel/crag-subscription/orders?limit=50&offset=0',
        { signal }
      ),
    retry: false,
  })
  const [copiedId, setCopiedId] = useState<string>()
  const [migrateOpen, setMigrateOpen] = useState(false)
  const [fromHostId, setFromHostId] = useState('')
  const [migrateProof, setMigrateProof] = useState('')
  const [migrating, setMigrating] = useState(false)
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>()
  const [renewTarget, setRenewTarget] = useState<CragCloudOrder>()
  const [renewQuote, setRenewQuote] = useState<LockedRenewalQuote>()
  const [renewLoading, setRenewLoading] = useState(false)
  const [renewError, setRenewError] = useState('')

  const hostId = ordersQuery.data?.host_id || hostIdOverride || host?.host_id
  const unitLabel = isGemini ? '席位' : '槽位'
  const orders = ordersQuery.data?.orders ?? []
  const vouchers = ordersQuery.data?.vouchers ?? []
  const activeVouchers = vouchers.filter(
    (v) => v.active === true || v.status === 'active'
  ).length
  const trimmedFrom = fromHostId.trim()
  const trimmedProof = migrateProof.trim()
  const canMigrate =
    validHostOrUuid(trimmedFrom) &&
    trimmedFrom.toLowerCase() !== hostId &&
    validMigrationProof(trimmedProof)

  async function copyText(id: string, value: string) {
    try {
      await navigator.clipboard?.writeText(value)
      setCopiedId(id)
    } catch {
      // Fallback: values remain select-all.
    }
  }

  async function submitMigration() {
    if (!canMigrate || migrating) return
    setMigrating(true)
    setNotice(undefined)
    try {
      const result = await api<{
        from_host_id: string
        to_host_id: string
        migrated_vouchers: number
        migrated_orders: number
        status?: CragHostStatus | GeminiHostStatus
      }>(
        isGemini
          ? '/api/panel/gemini/crag-subscription/migrate'
          : '/api/panel/crag-subscription/migrate',
        {
          method: 'POST',
          body: JSON.stringify({
            from_host_id: trimmedFrom,
            proof: trimmedProof,
          }),
        }
      )
      setMigrateOpen(false)
      setFromHostId('')
      setMigrateProof('')
      if (isGemini) {
        if (result.status) {
          qc.setQueryData(
            geminiCragSubscriptionQueryOptions().queryKey,
            result.status as GeminiHostStatus
          )
        }
        await qc.invalidateQueries({
          queryKey: geminiInventoryOptions().queryKey,
        })
      } else {
        if (result.status) {
          qc.setQueryData(
            cragHostStatusQueryOptions().queryKey,
            result.status as CragHostStatus
          )
        }
        await Promise.all([
          qc.invalidateQueries({
            queryKey: cragHostStatusQueryOptions().queryKey,
          }),
          qc.invalidateQueries({
            queryKey: cragHostOrdersQueryOptions().queryKey,
          }),
        ])
      }
      onHostChanged()
      setNotice({
        text: `已迁移 ${result.migrated_vouchers} 张兑换券与 ${result.migrated_orders} 笔历史订单到当前宿主机，原宿主机已自动解绑。`,
      })
    } catch (error) {
      setNotice({
        text:
          (isApiError(error) &&
            (cragHostMigrateErrors[error.code] ||
              cragSubscriptionErrors[error.code] ||
              error.message)) ||
          '迁移失败，请核对原宿主机 ID 后重试。',
        error: true,
      })
    } finally {
      setMigrating(false)
    }
  }

  async function openLockedRenewal(order: CragCloudOrder) {
    setRenewTarget(order)
    setRenewQuote(undefined)
    setRenewError('')
    setRenewLoading(true)
    try {
      const quote = await api<LockedRenewalQuote>(
        isGemini
          ? '/api/panel/gemini/crag-shop/quote'
          : '/api/panel/crag-shop/quote',
        {
          method: 'POST',
          body: JSON.stringify({
            sku: 'renewal',
            renew_order_id: order.order_id,
          }),
          cache: 'no-store',
        }
      )
      setRenewQuote(quote)
    } catch (error) {
      setRenewError(
        isApiError(error) && error.code === 'shop_renewal_unavailable'
          ? '该订单当前无法锁定原价续费，请刷新历史订单核对状态。'
          : '获取原价续费报价失败，请稍后重试。'
      )
    } finally {
      setRenewLoading(false)
    }
  }

  return (
    <section
      aria-labelledby='crag-cloud-ledger-heading'
      className='space-y-4 rounded-xl border bg-card p-4'
    >
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div>
          <h2 id='crag-cloud-ledger-heading' className='font-semibold'>
            {isGemini
              ? 'CRAGGemini 宿主机身份与云端历史订单'
              : '宿主机身份与云端历史订单'}
          </h2>
          <p className='text-xs text-muted-foreground'>
            以宿主机 ID
            为唯一认证身份；购买付款后自动追加额度，历史订单永久云端留痕并支持一键原价续费。
          </p>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <Button
            type='button'
            size='sm'
            variant='outline'
            disabled={busy || migrating}
            onClick={() => {
              setFromHostId('')
              setMigrateProof('')
              setMigrateOpen(true)
            }}
          >
            迁移宿主机 ID
          </Button>
          <Button
            type='button'
            size='sm'
            variant='ghost'
            disabled={ordersQuery.isFetching || migrating}
            onClick={() => void ordersQuery.refetch()}
          >
            刷新云端记录
          </Button>
        </div>
      </div>

      {hostId ? (
        <div className='flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border bg-muted/30 px-3 py-2 text-xs'>
          <span className='font-medium text-muted-foreground'>
            当前宿主机 ID
          </span>
          <code className='min-w-0 font-mono break-all select-all'>
            {hostId}
          </code>
          <Button
            type='button'
            size='sm'
            variant='ghost'
            className='h-7 px-2 text-xs'
            onClick={() => void copyText('host_id', hostId)}
          >
            {copiedId === 'host_id' ? '已复制' : '复制'}
          </Button>
          {vouchers.length > 0 ? (
            <span className='text-muted-foreground'>
              · 已绑定兑换券 {activeVouchers} 张有效 / 共 {vouchers.length} 张
            </span>
          ) : null}
        </div>
      ) : null}

      {notice ? (
        <p
          role={notice.error ? 'alert' : 'status'}
          className={notice.error ? 'text-sm text-destructive' : 'text-sm'}
        >
          {notice.text}
        </p>
      ) : null}

      {ordersQuery.isError ? (
        <p className='text-sm text-muted-foreground'>
          暂时无法读取云端历史订单，请点击「刷新云端记录」重试。
        </p>
      ) : orders.length === 0 ? (
        <p className='text-sm text-muted-foreground'>
          当前宿主机暂无云端订阅订单记录。购买付款完成后将自动记录金额、槽位与有效期；若从旧服务器换机，可点右上角「迁移宿主机
          ID」一键迁入。
        </p>
      ) : (
        <ul className='divide-y rounded-lg border'>
          {orders.map((order) => {
            const badge = orderStatusBadge(order)
            const slotText =
              order.slot_limit === 'unlimited'
                ? `不限${unitLabel}`
                : `${order.slot_limit} ${unitLabel}`
            const canRenewThis =
              order.status !== 'revoked' &&
              order.amount_minor > 0 &&
              channels.length > 0
            return (
              <li key={order.order_id} className='space-y-2 px-3 py-3 text-sm'>
                <div className='flex flex-wrap items-start justify-between gap-2'>
                  <div className='min-w-0 space-y-1'>
                    <div className='flex flex-wrap items-center gap-2'>
                      <Badge
                        variant={
                          order.order_kind === 'renewal'
                            ? 'secondary'
                            : 'outline'
                        }
                      >
                        {order.order_kind === 'renewal' ? '原价续费' : '新购'}
                      </Badge>
                      <span className='font-semibold tabular-nums'>
                        {yuan(order.amount_minor)}
                      </span>
                      <span className='text-muted-foreground'>
                        · {slotText} · {order.months} 个月
                      </span>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </div>
                    <p className='text-xs text-muted-foreground'>
                      套餐 {order.sku} · {channelLabel(order.payment_method)} ·
                      付款 {formatSeconds(order.paid_at)} · 有效期至{' '}
                      {formatSeconds(orderEffectiveExpiry(order))}
                    </p>
                    <div className='flex flex-wrap items-center gap-2 text-xs text-muted-foreground'>
                      <span className='font-mono break-all select-all'>
                        订单号 {order.order_id}
                      </span>
                      <Button
                        type='button'
                        size='sm'
                        variant='ghost'
                        className='h-6 px-1.5 text-xs'
                        onClick={() =>
                          void copyText(order.order_id, order.order_id)
                        }
                      >
                        {copiedId === order.order_id ? '已复制' : '复制'}
                      </Button>
                      {order.renewed_from_order_id ? (
                        <span className='font-mono'>
                          续费来源 {order.renewed_from_order_id.slice(0, 8)}…
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {canRenewThis ? (
                    <Button
                      type='button'
                      size='sm'
                      variant='outline'
                      disabled={busy || migrating}
                      onClick={() => void openLockedRenewal(order)}
                    >
                      一键原价续费 ({yuan(order.amount_minor)})
                    </Button>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <ConfirmDialog
        open={migrateOpen}
        onOpenChange={(open) => {
          if (!open && !migrating) setMigrateOpen(false)
        }}
        isLoading={migrating}
        disabled={!canMigrate}
        title='迁移宿主机 ID'
        confirmText='一键迁移到本机'
        cancelBtnText='取消'
        handleConfirm={() => void submitMigration()}
        desc={
          <div className='space-y-2 text-sm'>
            <p>
              粘贴<strong>原宿主机 ID（64 位十六进制）或设备 UUID</strong>
              ，并填写原宿主机下任一<strong>历史订单号或原兑换码</strong>
              作为归属验证，即可将全部有效兑换券、剩余有效期及云端历史订单整机迁移到当前宿主机。
            </p>
            <p className='text-muted-foreground'>
              迁移后原宿主机自动解绑，本机立即接管权益，无冷却期限制。
            </p>
          </div>
        }
      >
        <div className='space-y-2'>
          <Input
            value={fromHostId}
            onChange={(event) => setFromHostId(event.target.value)}
            placeholder='原宿主机 ID（64 位十六进制）或设备 UUID'
            autoComplete='off'
            spellCheck={false}
            aria-label='原宿主机 ID'
          />
          <Input
            value={migrateProof}
            onChange={(event) => setMigrateProof(event.target.value)}
            placeholder='归属验证：原宿主机任一订单号或 CRAGR1 兑换码'
            autoComplete='off'
            spellCheck={false}
            aria-label='归属验证凭证'
          />
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={!!renewTarget}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setRenewTarget(undefined)
            setRenewQuote(undefined)
            setRenewError('')
          }
        }}
        isLoading={busy || renewLoading}
        disabled
        title='一键原价续费'
        confirmText='请在下方选择付款方式'
        cancelBtnText='关闭'
        handleConfirm={() => {}}
        desc={
          renewTarget ? (
            <div className='space-y-2 text-sm'>
              <p>
                按原订单购买时的实付价格锁定续费，不受后续套餐涨价或下架影响；仅顺延该订单有效期，不额外增加槽位。
              </p>
              <dl className='grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border bg-muted/30 p-2.5 text-xs tabular-nums'>
                <dt className='text-muted-foreground'>原订单号</dt>
                <dd className='font-mono break-all'>{renewTarget.order_id}</dd>
                <dt className='text-muted-foreground'>锁定价格</dt>
                <dd className='font-semibold'>
                  {renewQuote
                    ? yuan(renewQuote.amount_minor)
                    : yuan(renewTarget.amount_minor)}
                </dd>
                <dt className='text-muted-foreground'>延长时长</dt>
                <dd>{renewQuote?.months ?? renewTarget.months} 个月</dd>
                <dt className='text-muted-foreground'>当前到期</dt>
                <dd>{formatSeconds(orderEffectiveExpiry(renewTarget))}</dd>
              </dl>
              {renewLoading ? (
                <p className='text-xs text-muted-foreground'>
                  正在向授权服务确认原价锁单…
                </p>
              ) : renewError ? (
                <p role='alert' className='text-xs text-destructive'>
                  {renewError}
                </p>
              ) : renewQuote ? (
                <div className='flex flex-wrap gap-2 pt-1'>
                  {channels.map((channel, index) => (
                    <Button
                      key={channel}
                      type='button'
                      size='sm'
                      variant={index === 0 ? 'default' : 'outline'}
                      disabled={busy}
                      onClick={() => {
                        const targetId = renewTarget.order_id
                        const lockedPrice = renewQuote.amount_minor
                        setRenewTarget(undefined)
                        setRenewQuote(undefined)
                        onRenewOrder(targetId, lockedPrice, channel)
                      }}
                    >
                      {paymentLabels[channel]} · {yuan(renewQuote.amount_minor)}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            ''
          )
        }
      />
    </section>
  )
}
