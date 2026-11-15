import { useEffect, useRef, useState } from 'react'
import type { CommerceRules } from './crag-commerce'
import {
  formatPlanDetails,
  termLabel,
  type CragPlan,
  type Presentation,
} from './crag-shop'

// Read-only canvas for the CRAG Auth plan editor. It never calls the panel API:
// the embedding admin page pushes an unpublished draft via postMessage, and this
// page only reports which card the operator clicked.
export type PreviewDraft = {
  plans: CragPlan[]
  commerce?: CommerceRules | null
  presentation?: Presentation | null
}
type Inbound = {
  type: 'crag-preview:draft'
  draft: PreviewDraft
  selected?: string | null
  theme?: 'light' | 'dark'
}

const money = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'CNY',
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
})
const yuan = (minor: number) => money.format(minor / 100)

function validPlan(plan: unknown): plan is CragPlan {
  const p = plan as CragPlan
  return (
    !!p &&
    typeof p.sku === 'string' &&
    typeof p.term === 'string' &&
    Number.isSafeInteger(p.amount_minor) &&
    (p.slot_limit === 'unlimited' || Number.isSafeInteger(p.slot_limit))
  )
}

export function parseDraftMessage(data: unknown): Inbound | null {
  const m = data as Inbound
  if (!m || m.type !== 'crag-preview:draft' || !m.draft) return null
  if (!Array.isArray(m.draft.plans) || !m.draft.plans.every(validPlan))
    return null
  return m
}

function months(plan: CragPlan) {
  return (
    plan.months ?? (plan.term === '1y' ? 12 : Number(plan.term.slice(0, -1)))
  )
}

export function CragPreviewPage() {
  const [draft, setDraft] = useState<PreviewDraft>()
  const [selected, setSelected] = useState<string | null>(null)
  const parentOrigin = useRef<string | undefined>(undefined)

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== window.parent || window.parent === window) return
      const message = parseDraftMessage(event.data)
      if (!message) return
      parentOrigin.current = event.origin
      setDraft(message.draft)
      setSelected(message.selected ?? null)
      // Apply theme to this document only; never persist the vm2api theme cookie.
      if (message.theme) {
        document.documentElement.classList.remove('light', 'dark')
        document.documentElement.classList.add(message.theme)
      }
    }
    window.addEventListener('message', onMessage)
    // The handshake carries no data, so any embedding origin may receive it.
    if (window.parent !== window)
      window.parent.postMessage({ type: 'crag-preview:ready' }, '*')
    return () => window.removeEventListener('message', onMessage)
  }, [])

  function pick(sku: string) {
    setSelected(sku)
    if (parentOrigin.current)
      window.parent.postMessage(
        { type: 'crag-preview:select', sku },
        parentOrigin.current
      )
  }

  if (!draft)
    return (
      <main className='grid min-h-svh place-items-center p-6 text-sm text-muted-foreground'>
        等待后台推送草稿…
      </main>
    )

  return <PreviewCanvas draft={draft} selected={selected} onPick={pick} />
}

export function PreviewCanvas({
  draft,
  selected,
  onPick,
}: {
  draft: PreviewDraft
  selected: string | null
  onPick: (sku: string) => void
}) {
  const p = draft.presentation ?? {}
  const commerce = draft.commerce ?? undefined
  const plans = draft.plans.filter((plan) => plan.enabled !== false)
  const customEnabled = !!commerce && commerce.custom_enabled !== false
  const empty = !plans.length && !customEnabled

  return (
    <main className='min-h-svh bg-background px-4 py-6 text-foreground'>
      <div className='mb-4'>
        <h2 className='text-2xl font-bold tracking-tight'>
          {p.title ?? '订阅 CRAG'}
        </h2>
        <p className='mt-1 text-sm text-muted-foreground'>
          {p.description ??
            '查看订阅套餐和本人历史订单。付款、交付与激活状态分别确认。'}
        </p>
      </div>
      <div className='grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]'>
        <section className='min-w-0 space-y-3'>
          <h2 className='font-medium'>{p.plans_title ?? '订阅套餐'}</h2>
          {empty ? (
            <p className='text-sm text-muted-foreground'>
              {p.empty_plans_text ?? '暂无可购买的套餐，仍可查看历史订单。'}
            </p>
          ) : null}
          {commerce ? (
            <p className='text-sm text-muted-foreground'>
              标准价 {yuan(commerce.unit_amount_minor)} / 槽位 /
              月，人民币结算。 优惠后单笔不超过{' '}
              {yuan(commerce.max_amount_minor)}
              ，实付以供应方报价为准。
            </p>
          ) : null}
          <div className='grid gap-2'>
            {customEnabled ? (
              <PreviewCard
                active={selected === 'custom'}
                onPick={() => onPick('custom')}
                title={p.custom_title ?? '自定义槽位和时长'}
                meta={`${commerce.min_slots ?? 1}–${commerce.max_slots} 槽位 · ${commerce.min_months ?? 1}–${commerce.max_months} 个月`}
                price={`${yuan(commerce.unit_amount_minor)} 起`}
              />
            ) : null}
            {plans.map((plan) => {
              const { price, locks } = formatPlanDetails(
                plan.amount_minor,
                plan.slot_limit
              )
              const stock =
                plan.remaining === 0
                  ? '已售罄'
                  : plan.remaining != null
                    ? `剩余 ${plan.remaining} 份`
                    : ''
              const renew =
                plan.renewable === true
                  ? '可续费'
                  : plan.renewable === false
                    ? '不可续费'
                    : ''
              return (
                <PreviewCard
                  key={plan.sku}
                  active={selected === plan.sku}
                  soldOut={plan.remaining === 0}
                  onPick={() => onPick(plan.sku)}
                  title={
                    plan.name || termLabel(plan.term, plan.sku, plan.months)
                  }
                  meta={
                    commerce
                      ? `${plan.slot_limit === 'unlimited' ? '不限槽位' : `${plan.slot_limit} 槽位`} / ${months(plan)} 个月`
                      : `${plan.name ? termLabel(plan.term, plan.sku, plan.months) + ' · ' : ''}${locks}`
                  }
                  description={plan.description}
                  foot={[stock, renew].filter(Boolean).join(' · ')}
                  price={price}
                />
              )
            })}
          </div>
        </section>
        <section className='min-w-0 space-y-3'>
          <h2 className='font-medium'>{p.orders_title ?? '历史订单'}</h2>
          <p className='text-sm text-muted-foreground'>
            {p.empty_orders_text ??
              '还没有订阅订单。下单后可以在这里查看支付和激活状态。'}
          </p>
          {p.unavailable_text ? (
            <p className='rounded-md border border-dashed p-3 text-sm text-muted-foreground'>
              停售时显示：{p.unavailable_text}
            </p>
          ) : null}
        </section>
      </div>
    </main>
  )
}

function PreviewCard({
  active,
  soldOut,
  onPick,
  title,
  meta,
  description,
  foot,
  price,
}: {
  active: boolean
  soldOut?: boolean
  onPick: () => void
  title: string
  meta: string
  description?: string
  foot?: string
  price: string
}) {
  return (
    <button
      type='button'
      data-active={active || undefined}
      onClick={onPick}
      className={`grid min-h-14 w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-md border bg-card px-3 py-2.5 text-start text-card-foreground transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${active ? 'border-primary ring-2 ring-primary/30' : ''} ${soldOut ? 'opacity-60' : ''}`}
    >
      <span className='grid min-w-0 gap-1'>
        <span className='text-sm font-medium'>{title}</span>
        <span className='text-sm text-muted-foreground'>{meta}</span>
        {description ? (
          <span className='text-sm whitespace-pre-line text-muted-foreground'>
            {description}
          </span>
        ) : null}
        {foot ? (
          <span className='text-xs text-muted-foreground'>{foot}</span>
        ) : null}
      </span>
      <span className='text-end text-base font-semibold whitespace-nowrap tabular-nums'>
        {price}
      </span>
    </button>
  )
}
