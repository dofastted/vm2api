import { useEffect, useId, useState, type ReactNode } from 'react'
import { api, cragDeviceApi, isApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  monthlyFor,
  yuan,
  type CommerceRules,
  type CragPlan as Plan,
} from './crag-catalog'
import {
  commerceColumnClass,
  densityClass,
  featuredFallback,
  type ResolvedLayout,
} from './crag-layout'
import { CommercePlanContent, CommerceRulesSummary } from './crag-plan-content'

export type { CommerceRules } from './crag-catalog'

export type CommerceSelection = {
  sku: string
  slots?: number
  months?: number
  coupon?: string
}

export const paymentLabels = { wxpay: '微信支付', alipay: '支付宝' }
export type PaymentMethod = keyof typeof paymentLabels

export function CragPaymentButtons({
  channels,
  disabled,
  onPay,
}: {
  channels: readonly PaymentMethod[]
  disabled: boolean
  onPay: (channel: PaymentMethod) => void
}) {
  return (
    <div role='group' aria-label='付款方式' className='flex flex-wrap gap-2'>
      {channels.map((channel, index) => (
        <Button
          key={channel}
          type='button'
          className='min-h-11 min-w-24'
          variant={index === 0 ? 'default' : 'outline'}
          disabled={disabled}
          onClick={() => onPay(channel)}
        >
          {paymentLabels[channel]}
        </Button>
      ))}
    </div>
  )
}

type Quote = {
  sku: string
  months: number
  slot_limit: Plan['slot_limit']
  subtotal_minor: number
  discount_minor: number
  amount_minor: number
}

function count(value: string, min: number, max: number) {
  if (!/^\d+$/.test(value)) return null
  const quantity = Number(value)
  return Number.isSafeInteger(quantity) && quantity >= min && quantity <= max
    ? quantity
    : null
}

export function quoteProblem(error: unknown) {
  if (!isApiError(error)) return '暂时无法确认报价，请重试。'
  const code = error.code ?? ''
  if (code === 'shop_device_unavailable')
    return '无法读取本机宿主设备 ID，请让管理员检查宿主 ID 文件和 Docker 只读挂载，再操作原订单。'
  if (code === 'shop_host_identity_changed')
    return '当前宿主设备 ID 与原订阅不一致。请恢复原宿主 ID 配置，不要重复下单或付款。'
  if (code === 'shop_private_storage_unavailable')
    return '订单私有存储不可用。请让管理员检查数据目录和原收据密钥，再操作原订单。'
  if (code === 'shop_device_checkout_required')
    return '请允许浏览器 Cookie，刷新设备购买页后重试。'
  if (code.includes('coupon'))
    return '优惠码不可用、次数已用完，或优惠后金额低于 ¥0.01。'
  if (/stock|sold_out|inventory/.test(code)) return '此档首批名额已售罄。'
  if (/renew/.test(code))
    return '无法为本机当前套餐续费。请刷新订阅并核对套餐续费设置。'
  if (/limit|amount|price|cap/.test(code))
    return '应付金额超出允许范围，或报价已变动。请调整组合或重新报价。'
  return '暂时无法确认报价，请重试。'
}

export function CragCommerce({
  rules,
  plans,
  sku,
  onSelect,
  allowRenewal,
  enabled,
  busy,
  initialQuoteKey,
  catalogKey,
  customTitle,
  device = false,
  paymentMethods,
  deliveryOptions,
  onOrder,
  layout,
}: {
  rules: CommerceRules
  plans: Plan[]
  sku: string
  onSelect: (sku: string) => void
  allowRenewal: boolean
  enabled: boolean
  busy: boolean
  initialQuoteKey: number
  catalogKey?: string
  customTitle?: string
  device?: boolean
  paymentMethods: readonly PaymentMethod[]
  deliveryOptions?: ReactNode
  onOrder: (
    selection: CommerceSelection,
    price: number,
    method: PaymentMethod
  ) => void
  /** 目录声明的排版，已由 normalizeLayout 解析，缺省即缺省排版。 */
  layout: ResolvedLayout
}) {
  const id = useId()
  const [slots, setSlots] = useState(String(rules.min_slots ?? 1))
  const [months, setMonths] = useState(String(rules.min_months ?? 1))
  const [coupon, setCoupon] = useState('')
  const [appliedCoupon, setAppliedCoupon] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [result, setResult] = useState<{
    key: string
    quote?: Quote
    error?: string
  }>()
  const customEnabled = rules.custom_enabled !== false
  const slotsCount = count(slots, rules.min_slots ?? 1, rules.max_slots)
  const monthsCount = count(months, rules.min_months ?? 1, rules.max_months)
  const plan = plans.find((plan) => plan.sku === sku && plan.enabled !== false)
  const authorizedRenewal = sku === 'renewal' && allowRenewal
  const available =
    authorizedRenewal ||
    (sku === 'custom'
      ? customEnabled && slotsCount !== null && monthsCount !== null
      : !!plan && plan.remaining !== 0)
  const needsApply = coupon.trim() !== appliedCoupon
  const body = JSON.stringify({
    sku,
    ...(sku === 'custom' ? { slots: slotsCount, months: monthsCount } : {}),
    ...(appliedCoupon ? { coupon: appliedCoupon } : {}),
  })
  const key = JSON.stringify([
    body,
    refresh,
    initialQuoteKey,
    catalogKey,
    plan,
    rules,
  ])
  const current =
    result?.key === key && !needsApply && available ? result : undefined
  const canQuote = enabled && available && !needsApply
  const estimate =
    sku === 'custom' && customEnabled && slotsCount && monthsCount
      ? slotsCount * monthsCount * rules.unit_amount_minor
      : plan?.amount_minor

  useEffect(() => {
    if (!canQuote) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      const quoteRequest = device ? cragDeviceApi<Quote> : api<Quote>
      void quoteRequest(device ? '/quote' : '/api/panel/crag-shop/quote', {
        method: 'POST',
        body,
        signal: controller.signal,
        cache: 'no-store',
      }).then(
        (quote) => {
          if (controller.signal.aborted) return
          if (
            quote.sku !== sku ||
            !Number.isSafeInteger(quote.amount_minor) ||
            quote.amount_minor < 1 ||
            quote.amount_minor > rules.max_amount_minor ||
            !Number.isSafeInteger(quote.subtotal_minor) ||
            !Number.isSafeInteger(quote.discount_minor) ||
            quote.discount_minor < 0 ||
            quote.subtotal_minor - quote.discount_minor !== quote.amount_minor
          ) {
            setResult({ key, error: '报价不完整，请重试。' })
            return
          }
          setResult({ key, quote })
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setResult({ key, error: quoteProblem(error) })
        }
      )
    }, 300)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [body, canQuote, device, key, rules.max_amount_minor, sku])

  const selectionUnavailable =
    !available && (sku !== 'custom' || !customEnabled)

  const density = layout.cardDensity
  const space = densityClass[density]
  const visiblePlans = plans.filter((plan) => plan.enabled !== false)
  const featuredSku =
    layout.featuredSku &&
    visiblePlans.some((plan) => plan.sku === layout.featuredSku)
      ? layout.featuredSku
      : null

  return (
    <div className='space-y-4'>
      {plans.length > 0 || allowRenewal ? (
        <fieldset
          className={`grid ${space.grid} ${commerceColumnClass[layout.planColumns]}`}
          disabled={busy}
        >
          <legend className='mb-2 text-sm font-medium'>
            固定套餐{allowRenewal ? '与续费' : ''}
          </legend>
          {visiblePlans.map((plan) => (
            <label
              key={plan.sku}
              data-density={density}
              data-featured={plan.sku === featuredSku || undefined}
              className={`flex items-center gap-3 rounded-xl border bg-card ${space.card} text-sm text-card-foreground shadow-xs transition-colors has-checked:border-primary has-checked:bg-primary/5 has-checked:ring-2 has-checked:ring-primary/20 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring has-enabled:cursor-pointer has-enabled:hover:border-primary/50 has-disabled:opacity-60`}
            >
              <input
                type='radio'
                name={id}
                className='accent-primary'
                checked={sku === plan.sku}
                disabled={plan.remaining === 0}
                onChange={() => onSelect(plan.sku)}
              />
              <CommercePlanContent
                plan={plan}
                density={density}
                featured={
                  plan.sku === featuredSku
                    ? (layout.featuredLabel ?? featuredFallback)
                    : undefined
                }
                monthly={monthlyFor(
                  layout,
                  plan.amount_minor,
                  plan.term,
                  plan.months
                )}
              />
            </label>
          ))}
          {allowRenewal ? (
            <label className='flex cursor-pointer items-center gap-3 rounded-xl border bg-card p-4 text-sm font-medium shadow-xs transition-colors hover:border-primary/50 has-checked:border-primary has-checked:bg-primary/5 has-checked:ring-2 has-checked:ring-primary/20'>
              <input
                type='radio'
                name={id}
                className='accent-primary'
                checked={sku === 'renewal'}
                onChange={() => onSelect('renewal')}
              />{' '}
              续费本机当前套餐
            </label>
          ) : null}
        </fieldset>
      ) : null}
      {customEnabled ? (
        <fieldset
          className='space-y-2 rounded-xl border bg-card px-4 py-3 has-checked:border-primary'
          disabled={busy}
        >
          <legend className='px-1 text-sm font-medium'>
            {customTitle ?? '自定义槽位和时长'}
          </legend>
          <label className='flex cursor-pointer items-center gap-2 text-sm'>
            <input
              type='radio'
              name={id}
              className='accent-primary'
              checked={sku === 'custom'}
              onChange={() => onSelect('custom')}
            />
            选择自定义套餐
          </label>
          {sku === 'custom' ? (
            <>
              <CommerceRulesSummary rules={rules} />
              <div className='grid max-w-xl gap-3 sm:grid-cols-2'>
                <label className='grid gap-1.5 text-sm'>
                  槽位数
                  <Input
                    value={slots}
                    inputMode='numeric'
                    maxLength={8}
                    onChange={(e) => setSlots(e.target.value)}
                  />
                </label>
                <label className='grid gap-1.5 text-sm'>
                  月数
                  <Input
                    value={months}
                    inputMode='numeric'
                    maxLength={3}
                    onChange={(e) => setMonths(e.target.value)}
                  />
                </label>
              </div>
              {sku === 'custom' && !available ? (
                <p className='text-sm text-destructive'>
                  槽位数须为 {rules.min_slots ?? 1}–{rules.max_slots} 的整数，
                  月份须为 {rules.min_months ?? 1}–{rules.max_months} 的整数。
                </p>
              ) : null}
            </>
          ) : null}
        </fieldset>
      ) : null}
      {sku === 'renewal' ? (
        <p className='text-sm text-muted-foreground'>
          续费保留本机当前槽位额度，从现有到期日或今天（已到期时）延长；按当前售价，不占首批库存。
        </p>
      ) : null}
      {enabled ? (
        <div className='space-y-2'>
          <label htmlFor={`${id}-coupon`} className='text-sm font-medium'>
            优惠码（选填）
          </label>
          <div className='flex gap-2'>
            <Input
              id={`${id}-coupon`}
              className='min-w-0'
              value={coupon}
              autoComplete='off'
              spellCheck={false}
              maxLength={64}
              onChange={(e) => setCoupon(e.target.value)}
            />
            <Button
              type='button'
              variant='outline'
              disabled={!needsApply || busy}
              onClick={() => setAppliedCoupon(coupon.trim())}
            >
              应用
            </Button>
          </div>
        </div>
      ) : null}
      <div className='space-y-2 border-t pt-3' aria-live='polite'>
        <dl className='grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm tabular-nums'>
          <dt className='text-muted-foreground'>
            {current?.quote ? '优惠前' : '参考小计'}
          </dt>
          <dd>
            {current?.quote
              ? yuan(current.quote.subtotal_minor)
              : estimate != null
                ? yuan(estimate)
                : '—'}
          </dd>
          {current?.quote && current.quote.discount_minor > 0 ? (
            <>
              <dt className='text-muted-foreground'>优惠</dt>
              <dd>−{yuan(current.quote.discount_minor)}</dd>
            </>
          ) : null}
          <dt className='font-medium'>应付金额</dt>
          <dd className='font-semibold'>
            {current?.quote ? yuan(current.quote.amount_minor) : '—'}
          </dd>
        </dl>
        {current?.error ? (
          <div className='flex flex-wrap items-center gap-2'>
            <p className='text-sm text-destructive'>{current.error}</p>
            <Button
              size='sm'
              variant='outline'
              onClick={() => setRefresh((n) => n + 1)}
            >
              重新报价
            </Button>
          </div>
        ) : canQuote && !current ? (
          <p className='text-sm text-muted-foreground'>正在向供应方核价…</p>
        ) : needsApply ? (
          <p className='text-sm text-muted-foreground'>
            点击「应用」核对优惠码。
          </p>
        ) : null}
        {selectionUnavailable ? (
          <p className='text-sm text-muted-foreground'>
            此购买选项当前不可用，请重新选择。
          </p>
        ) : null}
      </div>
      {sku !== 'renewal' ? deliveryOptions : null}
      <CragPaymentButtons
        channels={paymentMethods}
        disabled={!canQuote || !current?.quote || busy}
        onPay={(method) => {
          if (!canQuote || busy || !current?.quote) return
          const selection: CommerceSelection = {
            sku,
            ...(sku === 'custom' && slotsCount !== null && monthsCount !== null
              ? { slots: slotsCount, months: monthsCount }
              : {}),
            ...(appliedCoupon ? { coupon: appliedCoupon } : {}),
          }
          onOrder(selection, current.quote.amount_minor, method)
        }}
      />
    </div>
  )
}
