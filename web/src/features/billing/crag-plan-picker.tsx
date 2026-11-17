import { useId } from 'react'
import type { PlanOption } from './crag-catalog'
import {
  densityClass,
  featuredFallback,
  join,
  pickerColumnClass,
  type ResolvedLayout,
} from './crag-layout'
import { PickerPlanContent } from './crag-plan-content'

type CragPlanPickerProps = {
  plans: readonly PlanOption[]
  selectedSku: string | undefined
  onSelect: (sku: string) => void
  disabled?: boolean
  /** 目录声明的排版，已由 normalizeLayout 解析，缺省即缺省排版。 */
  layout: ResolvedLayout
}

export function CragPlanPicker({
  plans,
  selectedSku,
  onSelect,
  disabled,
  layout,
}: CragPlanPickerProps) {
  const groupName = useId()
  const termCounts = new Map<string, number>()
  for (const { term } of plans)
    termCounts.set(term, (termCounts.get(term) ?? 0) + 1)

  const density = layout.cardDensity
  const space = densityClass[density]
  const visible = plans.filter((plan) => plan.enabled !== false)
  const featuredSku =
    layout.featuredSku &&
    visible.some((plan) => plan.sku === layout.featuredSku)
      ? layout.featuredSku
      : null

  return (
    <fieldset disabled={disabled} className='m-0 min-w-0 border-0 p-0'>
      <legend className='sr-only'>选择套餐</legend>
      <div
        className={join(
          'grid min-w-0',
          space.grid,
          pickerColumnClass[layout.planColumns]
        )}
      >
        {visible.map((plan) => (
          <label
            key={plan.sku}
            data-density={density}
            data-featured={plan.sku === featuredSku || undefined}
            className={join(
              'grid',
              space.minHeight,
              'min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 rounded-xl border bg-card',
              space.card,
              'text-card-foreground shadow-xs transition-colors has-checked:border-primary has-checked:bg-primary/5 has-checked:ring-2 has-checked:ring-primary/20 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring has-enabled:cursor-pointer has-enabled:hover:border-primary/50 has-disabled:opacity-60'
            )}
          >
            <input
              type='radio'
              name={groupName}
              value={plan.sku}
              checked={plan.sku === selectedSku}
              disabled={plan.remaining === 0}
              onChange={() => onSelect(plan.sku)}
              className='size-4 accent-primary enabled:cursor-pointer'
            />
            <PickerPlanContent
              plan={plan}
              duplicateTerm={(termCounts.get(plan.term) ?? 0) > 1}
              density={density}
              featured={
                plan.sku === featuredSku
                  ? (layout.featuredLabel ?? featuredFallback)
                  : undefined
              }
              monthly={layout.showMonthlyPrice ? plan.monthly : null}
            />
          </label>
        ))}
      </div>
    </fieldset>
  )
}
