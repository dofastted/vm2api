import type { ReactNode } from 'react'
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export type Choice<T extends string> = {
  value: T
  title: ReactNode
  detail?: ReactNode
  /** 右上角的附注（数量、标签）；选中标记会占同一位置，所以只放短内容。 */
  aside?: ReactNode
  disabled?: boolean
}

/**
 * 互斥选项的可读版：每个选项带一句结果说明。选中态走冷蓝选择轴
 * （--select-*），青绿只留给提交动作。键盘与读屏走 Radix RadioGroup。
 */
export function ChoiceTiles<T extends string>({
  value,
  onChange,
  choices,
  label,
  className,
  layout = 'grid',
}: {
  value: T
  onChange: (next: T) => void
  choices: Choice<T>[]
  label: string
  className?: string
  /** grid：并排卡片；list：整行，适合条目信息较多的选择（如现有空槽）。 */
  layout?: 'grid' | 'list'
}) {
  return (
    <RadioGroupPrimitive.Root
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        const hit = choices.find((c) => c.value === next)
        if (hit && !hit.disabled) onChange(hit.value)
      }}
      className={cn(
        layout === 'grid'
          ? 'grid gap-2 sm:grid-cols-2'
          : 'flex flex-col gap-1.5',
        className
      )}
    >
      {choices.map((c) => (
        <RadioGroupPrimitive.Item
          key={c.value}
          value={c.value}
          disabled={c.disabled}
          className={cn(
            'group relative flex min-w-0 flex-col items-start gap-1 rounded-lg border bg-card px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow] duration-150 outline-none',
            'hover:border-select-border/60 focus-visible:ring-[3px] focus-visible:ring-select-border/40',
            'data-[state=checked]:border-select-border data-[state=checked]:bg-select-surface',
            'disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:border-border'
          )}
        >
          <span className='flex w-full min-w-0 items-center gap-2 pe-5'>
            <span className='min-w-0 truncate text-sm font-medium group-data-[state=checked]:text-select-fg'>
              {c.title}
            </span>
            {c.aside ? (
              <span className='ms-auto shrink-0 text-xs text-muted-foreground tabular-nums'>
                {c.aside}
              </span>
            ) : null}
          </span>
          {c.detail ? (
            <span className='text-xs leading-relaxed text-muted-foreground'>
              {c.detail}
            </span>
          ) : null}
          <RadioGroupPrimitive.Indicator className='absolute top-2.5 right-2.5 inline-flex size-4 items-center justify-center rounded-full bg-select-solid text-select-solid-fg'>
            <Check className='size-3' strokeWidth={3} aria-hidden='true' />
          </RadioGroupPrimitive.Indicator>
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  )
}

/** 紧凑的分段选择（一排短值，如内存档位）。与 ChoiceTiles 同一套选中语言。 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T
  onChange: (next: T) => void
  options: { value: T; label: ReactNode }[]
  label: string
  className?: string
}) {
  return (
    <RadioGroupPrimitive.Root
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        const hit = options.find((o) => o.value === next)
        if (hit) onChange(hit.value)
      }}
      className={cn(
        'inline-flex max-w-full flex-wrap rounded-lg border bg-muted/40 p-0.5',
        className
      )}
    >
      {options.map((o) => (
        <RadioGroupPrimitive.Item
          key={o.value}
          value={o.value}
          className={cn(
            'h-7 min-w-11 rounded-md px-2 text-sm text-muted-foreground tabular-nums transition-colors duration-150 outline-none sm:px-2.5',
            'hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-select-border/40',
            'data-[state=checked]:bg-select-surface data-[state=checked]:font-medium data-[state=checked]:text-select-fg data-[state=checked]:shadow-[inset_0_0_0_1px_var(--select-border)]'
          )}
        >
          {o.label}
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  )
}
