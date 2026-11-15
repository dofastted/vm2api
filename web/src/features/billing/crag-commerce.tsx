import { useEffect, useId, useState } from 'react'
import { api, isApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export type CommerceRules = {
  unit_amount_minor: number
  max_amount_minor: number
  max_months: number
  max_slots: number
  custom_renewable?: boolean
}

type Plan = {
  sku: string
  term: string
  slot_limit: number | 'unlimited'
  amount_minor: number
  remaining?: number
  renewable?: boolean
}

export type CommerceSelection = {
  sku: string
  slots?: number
  months?: number
  coupon?: string
}

type Quote = {
  sku: string
  months: number
  slot_limit: Plan['slot_limit']
  subtotal_minor: number
  discount_minor: number
  amount_minor: number
}

const currency = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'CNY',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})
const yuan = (minor: number) => currency.format(minor / 100)

function count(value: string, max: number) {
  if (!/^\d+$/.test(value)) return null
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 1 && n <= max ? n : null
}

export function quoteProblem(error: unknown) {
  if (!isApiError(error)) return '暂时无法确认报价，请重试。'
  const code = error.code ?? ''
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
  onOrder,
}: {
  rules: CommerceRules
  plans: Plan[]
  sku: string
  onSelect: (sku: string) => void
  allowRenewal: boolean
  enabled: boolean
  busy: boolean
  initialQuoteKey: number
  onOrder: (selection: CommerceSelection, price: number) => void
}) {
  const id = useId()
  const [slots, setSlots] = useState('1')
  const [months, setMonths] = useState('1')
  const [coupon, setCoupon] = useState('')
  const [appliedCoupon, setAppliedCoupon] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [result, setResult] = useState<{
    key: string
    quote?: Quote
    error?: string
  }>()
  const slotsCount = count(slots, rules.max_slots)
  const monthsCount = count(months, rules.max_months)
  const plan = plans.find((p) => p.sku === sku)
  const authorizedRenewal = sku === 'renewal' && allowRenewal
  const available =
    authorizedRenewal ||
    (sku === 'custom'
      ? slotsCount !== null && monthsCount !== null
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
    plan?.amount_minor,
    plan?.remaining,
    rules.unit_amount_minor,
    rules.max_amount_minor,
  ])
  const current = result?.key === key && !needsApply ? result : undefined
  const canQuote = enabled && available && !needsApply
  const estimate =
    sku === 'custom' && slotsCount && monthsCount
      ? slotsCount * monthsCount * rules.unit_amount_minor
      : plan?.amount_minor

  useEffect(() => {
    if (!canQuote) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void api<Quote>('/api/panel/crag-shop/quote', {
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
  }, [body, canQuote, key, rules.max_amount_minor, sku])

  const selectionUnavailable = !available && sku !== 'custom'

  return (
    <div className='space-y-4'>
      <p className='text-sm text-muted-foreground'>
        标准价 {yuan(rules.unit_amount_minor)} / 槽位 / 月（$6
        参考，人民币结算）。优惠后单笔不超过 {yuan(rules.max_amount_minor)}。
      </p>
      <fieldset className='grid gap-2' disabled={busy}>
        <legend className='mb-2 text-sm font-medium'>购买方式</legend>
        <label className='flex cursor-pointer items-center gap-2 rounded-md border p-3 text-sm has-checked:border-primary'>
          <input
            type='radio'
            name={id}
            className='accent-primary'
            checked={sku === 'custom'}
            onChange={() => onSelect('custom')}
          />{' '}
          自定义槽位和时长
        </label>
        {plans.map((p) => (
          <label
            key={p.sku}
            className='flex items-center gap-2 rounded-md border p-3 text-sm has-checked:border-primary has-enabled:cursor-pointer'
          >
            <input
              type='radio'
              name={id}
              className='accent-primary'
              checked={sku === p.sku}
              disabled={p.remaining === 0}
              onChange={() => onSelect(p.sku)}
            />
            <span className='min-w-0 flex-1'>
              <span className='block font-medium'>
                {p.slot_limit === 'unlimited'
                  ? '不限槽位'
                  : `${p.slot_limit} 槽位`}{' '}
                / {p.term === '1y' ? '12' : p.term.replace(/m$/, '')} 个月
              </span>
              <span className='block text-xs text-muted-foreground'>
                {p.remaining === 0
                  ? '首批售罄'
                  : p.remaining != null
                    ? `首批剩余 ${p.remaining} 份`
                    : '订阅套餐'}
                {p.renewable === true
                  ? ' · 可续费'
                  : p.renewable === false
                    ? ' · 不可续费'
                    : ''}
              </span>
            </span>
            <span className='shrink-0 font-semibold tabular-nums'>
              {yuan(p.amount_minor)}
            </span>
          </label>
        ))}
        {allowRenewal ? (
          <label className='flex cursor-pointer items-center gap-2 rounded-md border p-3 text-sm has-checked:border-primary'>
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
      {sku === 'custom' ? (
        <div className='grid grid-cols-2 gap-3'>
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
          {!available ? (
            <p className='col-span-2 text-sm text-destructive'>
              槽位与月份必须为正整数，分别最多 {rules.max_slots} 和{' '}
              {rules.max_months}。
            </p>
          ) : null}
        </div>
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
      <Button
        type='button'
        disabled={!canQuote || !current?.quote || busy}
        onClick={() => {
          if (!current?.quote) return
          const selection: CommerceSelection = {
            sku,
            ...(sku === 'custom' && slotsCount !== null && monthsCount !== null
              ? { slots: slotsCount, months: monthsCount }
              : {}),
            ...(appliedCoupon ? { coupon: appliedCoupon } : {}),
          }
          onOrder(selection, current.quote.amount_minor)
        }}
      >
        {sku === 'renewal' ? '创建续费订单' : '创建订单'}
      </Button>
    </div>
  )
}
