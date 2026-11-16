import type { ReactNode } from 'react'
import {
  formatPlanDetails,
  type CommerceRules,
  type DraftPlan,
  type PlanOption,
} from './crag-catalog'

type ContentSlots = {
  name?: ReactNode
  description?: ReactNode
  price?: ReactNode
}

const tag =
  'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] leading-4 font-medium'

function Renewal({ renewable }: { renewable: boolean | undefined }) {
  if (renewable === undefined) return null
  return renewable ? (
    <span
      className={`${tag} bg-emerald-500/10 text-emerald-700 dark:text-emerald-300`}
    >
      可续费
    </span>
  ) : (
    <span
      className={`${tag} bg-background text-muted-foreground ring-1 ring-border ring-inset`}
    >
      不可续费
    </span>
  )
}

function Stock({
  remaining,
  soldOut,
  left,
  fallback,
}: {
  remaining: number | null | undefined
  soldOut: string
  left: (quantity: number) => string
  fallback?: string
}) {
  if (remaining === 0)
    return (
      <span className={`${tag} bg-destructive/10 text-destructive`}>
        {soldOut}
      </span>
    )
  if (remaining != null)
    return (
      <span
        className={`${tag} bg-amber-500/10 text-amber-700 dark:text-amber-300`}
      >
        {left(remaining)}
      </span>
    )
  return fallback ? (
    <span
      className={`${tag} bg-background text-muted-foreground ring-1 ring-border ring-inset`}
    >
      {fallback}
    </span>
  ) : null
}

export function PickerPlanContent({
  plan,
  duplicateTerm = false,
  slots = {},
}: {
  plan: PlanOption
  duplicateTerm?: boolean
  slots?: ContentSlots
}) {
  return (
    <>
      <span className='grid min-w-0 gap-1'>
        <span className='text-[15px] leading-snug font-semibold'>
          {slots.name ?? plan.name ?? plan.term}
          {duplicateTerm ? (
            <span className='ms-2 text-xs wrap-anywhere text-muted-foreground'>
              {plan.sku}
            </span>
          ) : null}
        </span>
        <span className='text-[13px] text-muted-foreground'>
          {plan.name ? `${plan.term} · ` : ''}
          {plan.locks}
        </span>
        {slots.description ??
          (plan.description ? (
            <span className='text-sm whitespace-pre-line text-muted-foreground'>
              {plan.description}
            </span>
          ) : null)}
        <span className='mt-1 flex flex-wrap gap-1.5 empty:hidden'>
          <Stock
            remaining={plan.remaining}
            soldOut='已售罄'
            left={(quantity) => `剩余 ${quantity} 份`}
          />
          <Renewal renewable={plan.renewable} />
        </span>
      </span>
      <span className='text-end text-lg font-bold tracking-tight whitespace-nowrap tabular-nums'>
        {slots.price ?? plan.price}
      </span>
    </>
  )
}

export function CommercePlanContent({
  plan,
  slots = {},
}: {
  plan: DraftPlan
  slots?: ContentSlots
}) {
  const months =
    plan.months ?? (plan.term === '1y' ? '12' : plan.term.replace(/m$/, ''))
  return (
    <>
      <span className='grid min-w-0 flex-1 gap-1'>
        <span className='block text-[15px] leading-snug font-semibold'>
          {slots.name != null ? (
            <span className='block'>{slots.name}</span>
          ) : plan.name ? (
            <span className='block'>{plan.name}</span>
          ) : null}
          {plan.slot_limit === 'unlimited'
            ? '不限槽位'
            : plan.slot_limit != null
              ? `${plan.slot_limit} 槽位`
              : '槽位待填写'}{' '}
          / {months} 个月
        </span>
        {slots.description ??
          (plan.description ? (
            <span className='block text-[13px] whitespace-pre-line text-muted-foreground'>
              {plan.description}
            </span>
          ) : null)}
        <span className='mt-1 flex flex-wrap gap-1.5'>
          <Stock
            remaining={plan.remaining}
            soldOut='首批售罄'
            left={(quantity) => `首批剩余 ${quantity} 份`}
            fallback='订阅套餐'
          />
          <Renewal renewable={plan.renewable} />
        </span>
      </span>
      <span className='shrink-0 text-lg font-bold tracking-tight tabular-nums'>
        {slots.price ??
          formatPlanDetails(plan.amount_minor, plan.slot_limit).price}
      </span>
    </>
  )
}

export function CommerceRulesSummary({ rules }: { rules: CommerceRules }) {
  return (
    <p className='rounded-lg bg-muted/60 px-3 py-2 text-[13px] text-muted-foreground'>
      标准价 {formatPlanDetails(rules.unit_amount_minor, null).price} / 槽位 /
      月，人民币结算。 优惠后单笔不超过{' '}
      {formatPlanDetails(rules.max_amount_minor, null).price}
      ，实付以供应方报价为准。
    </p>
  )
}
