import { Minus, Plus, RotateCcw, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'

/** 设置页分组卡：图标 + 标题 + 一句话说明，内容区自由排布。 */
export function PaneSection({
  icon: Icon,
  title,
  desc,
  aside,
  children,
  className,
}: {
  icon: LucideIcon
  title: string
  desc?: React.ReactNode
  aside?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <Card className={cn('gap-0 py-0', className)}>
      <div className='flex items-start gap-3 border-b px-4 py-3'>
        <span className='mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary'>
          <Icon className='size-4' aria-hidden />
        </span>
        <div className='min-w-0 flex-1'>
          <h3 className='text-sm leading-6 font-semibold'>{title}</h3>
          {desc ? (
            <p className='text-xs leading-5 text-muted-foreground'>{desc}</p>
          ) : null}
        </div>
        {aside ? <div className='shrink-0'>{aside}</div> : null}
      </div>
      <CardContent className='space-y-5 px-4 py-4'>{children}</CardContent>
    </Card>
  )
}

function FieldHead({
  id,
  label,
  desc,
  value,
  fallback,
  onReset,
}: {
  id?: string
  label: string
  desc?: React.ReactNode
  value: React.ReactNode
  fallback?: string
  onReset?: () => void
}) {
  return (
    <div className='flex items-start justify-between gap-3'>
      <div className='min-w-0 space-y-0.5'>
        <Label htmlFor={id}>{label}</Label>
        {desc ? (
          <p className='text-xs leading-5 text-muted-foreground'>{desc}</p>
        ) : null}
      </div>
      <div className='flex shrink-0 items-center gap-1'>
        {onReset ? (
          <Button
            type='button'
            size='sm'
            variant='ghost'
            className='h-6 cursor-pointer gap-1 px-1.5 text-[11px] text-muted-foreground'
            onClick={onReset}
            title={`恢复默认 ${fallback}`}
          >
            <RotateCcw className='size-3' aria-hidden />
            默认 {fallback}
          </Button>
        ) : null}
        <span className='rounded-md bg-muted px-2 py-0.5 text-sm font-semibold tabular-nums'>
          {value}
        </span>
      </div>
    </div>
  )
}

/** 滑块 + 当前值 + 常用档位；`fallback` 与当前值不同时给出一键恢复默认。 */
export function SliderSetting({
  id,
  label,
  desc,
  value,
  min,
  max,
  step = 1,
  format,
  fallback,
  presets,
  onChange,
  children,
  sliderClassName,
}: {
  id: string
  label: string
  desc?: React.ReactNode
  value: number
  min: number
  max: number
  step?: number
  format: (value: number) => string
  fallback?: number
  presets?: number[]
  onChange: (value: number) => void
  children?: React.ReactNode
  /** 让滑块轨道与下方 0–100% 的可视化轴对齐（例如 min=30 时偏移 30%）。 */
  sliderClassName?: string
}) {
  return (
    <div className='space-y-2'>
      <FieldHead
        id={id}
        label={label}
        desc={desc}
        value={format(value)}
        fallback={fallback == null ? undefined : format(fallback)}
        onReset={
          fallback != null && fallback !== value
            ? () => onChange(fallback)
            : undefined
        }
      />
      <Slider
        id={id}
        aria-label={label}
        className={sliderClassName}
        min={min}
        max={max}
        step={step}
        value={[Math.min(max, Math.max(min, value))]}
        onValueChange={([next]) => onChange(next)}
      />
      {presets?.length ? (
        <ChipGroup
          label={`${label}常用值`}
          value={value}
          options={presets.map((p) => [p, format(p)])}
          onChange={onChange}
        />
      ) : null}
      {children}
    </div>
  )
}

/** 一排可选的小档位；当前值高亮。 */
export function ChipGroup<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  value: T
  options: [T, string][]
  onChange: (value: T) => void
  disabled?: boolean
}) {
  return (
    <div
      role='radiogroup'
      aria-label={label}
      className='flex flex-wrap gap-1.5'
    >
      {options.map(([v, text]) => {
        const on = v === value
        return (
          <button
            key={String(v)}
            type='button'
            role='radio'
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(v)}
            className={cn(
              'h-7 min-w-9 cursor-pointer rounded-md border px-2 text-xs tabular-nums transition-colors duration-150 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
              on
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-background text-muted-foreground hover:border-primary/50 hover:text-foreground'
            )}
          >
            {text}
          </button>
        )
      })}
    </div>
  )
}

export function FamilyLimitSelect({
  label,
  value,
  min,
  emptyText,
  onChange,
  disabled,
}: {
  label: string
  value: number | null
  min: 0 | 1
  emptyText?: string
  onChange: (value: number | null) => void
  disabled?: boolean
}) {
  return (
    <select
      className='max-w-full rounded-md border bg-background px-2 py-1.5 text-sm'
      aria-label={label}
      value={value ?? ''}
      disabled={disabled}
      onChange={(event) =>
        onChange(event.target.value === '' ? null : Number(event.target.value))
      }
    >
      {emptyText && <option value=''>{emptyText}</option>}
      {Array.from({ length: 21 - min }, (_, i) => i + min).map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  )
}

/** 小整数用的步进器：- [n] +，范围外的输入按边界收回。 */
export function StepperSetting({
  id,
  label,
  desc,
  value,
  min,
  max,
  step = 1,
  unit,
  fallback,
  onChange,
}: {
  id: string
  label: string
  desc?: React.ReactNode
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  fallback?: number
  onChange: (value: number) => void
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n))
  return (
    <div className='flex flex-wrap items-center justify-between gap-x-4 gap-y-2'>
      <div className='min-w-40 flex-1 space-y-0.5'>
        <Label htmlFor={id}>{label}</Label>
        {desc ? (
          <p className='text-xs leading-5 text-muted-foreground'>{desc}</p>
        ) : null}
      </div>
      <div className='flex items-center gap-1.5'>
        {fallback != null && fallback !== value ? (
          <Button
            type='button'
            size='sm'
            variant='ghost'
            className='h-7 cursor-pointer gap-1 px-1.5 text-[11px] text-muted-foreground'
            onClick={() => onChange(fallback)}
            title={`恢复默认 ${fallback}`}
          >
            <RotateCcw className='size-3' aria-hidden />
            {fallback}
          </Button>
        ) : null}
        <div className='flex items-center rounded-md border bg-background'>
          <Button
            type='button'
            size='icon'
            variant='ghost'
            className='size-8 cursor-pointer rounded-r-none'
            disabled={value <= min}
            aria-label={`${label}减少`}
            onClick={() => onChange(clamp(value - step))}
          >
            <Minus className='size-3.5' />
          </Button>
          <Input
            id={id}
            type='number'
            inputMode='numeric'
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(event) => {
              const n = Number(event.target.value)
              if (Number.isFinite(n)) onChange(clamp(n))
            }}
            className='h-8 w-14 rounded-none border-0 border-x px-1 text-center tabular-nums shadow-none focus-visible:ring-0'
          />
          <Button
            type='button'
            size='icon'
            variant='ghost'
            className='size-8 cursor-pointer rounded-l-none'
            disabled={value >= max}
            aria-label={`${label}增加`}
            onClick={() => onChange(clamp(value + step))}
          >
            <Plus className='size-3.5' />
          </Button>
        </div>
        {unit ? (
          <span className='w-6 text-xs text-muted-foreground'>{unit}</span>
        ) : null}
      </div>
    </div>
  )
}
