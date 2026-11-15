import { useId } from 'react'

type PlanOption = {
  sku: string
  term: string
  price: string
  locks: string
}

type CragPlanPickerProps = {
  plans: readonly PlanOption[]
  selectedSku: string | undefined
  onSelect: (sku: string) => void
  disabled?: boolean
}

export function CragPlanPicker({
  plans,
  selectedSku,
  onSelect,
  disabled,
}: CragPlanPickerProps) {
  const groupName = useId()
  const termCounts = new Map<string, number>()
  for (const { term } of plans)
    termCounts.set(term, (termCounts.get(term) ?? 0) + 1)

  return (
    <fieldset disabled={disabled} className='m-0 min-w-0 border-0 p-0'>
      <legend className='sr-only'>选择套餐</legend>
      <div className='grid min-w-0 gap-2'>
        {plans.map((plan) => (
          <label
            key={plan.sku}
            className='grid min-h-14 min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 rounded-md border bg-card px-3 py-2.5 text-card-foreground has-checked:border-primary has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring has-enabled:cursor-pointer has-enabled:hover:bg-accent/50'
          >
            <input
              type='radio'
              name={groupName}
              value={plan.sku}
              checked={plan.sku === selectedSku}
              onChange={() => onSelect(plan.sku)}
              className='size-4 accent-primary enabled:cursor-pointer'
            />
            <span className='grid min-w-0 gap-1'>
              <span className='text-sm font-medium'>
                {plan.term}
                {(termCounts.get(plan.term) ?? 0) > 1 ? (
                  <span className='ms-2 text-xs wrap-anywhere text-muted-foreground'>
                    {plan.sku}
                  </span>
                ) : null}
              </span>
              <span className='text-sm text-muted-foreground'>
                {plan.locks}
              </span>
            </span>
            <span className='text-end text-base font-semibold whitespace-nowrap tabular-nums'>
              {plan.price}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}
