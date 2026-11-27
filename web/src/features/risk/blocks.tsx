import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Label } from '@/components/ui/label'

export function Group({
  title,
  hint,
  action,
  children,
}: {
  title: string
  hint?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className='space-y-3'>
      <div className='flex items-end justify-between gap-3'>
        <div className='min-w-0 space-y-1'>
          <h3 className='text-sm font-medium'>{title}</h3>
          {hint ? (
            <p className='text-xs leading-5 text-muted-foreground'>{hint}</p>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

/** A bordered region of the audit page: list or editor under one heading. */
export function Panel({
  title,
  hint,
  action,
  children,
  className,
}: {
  title: string
  hint?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        'flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card',
        className
      )}
    >
      <header className='flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-[var(--hairline)] bg-muted/20 px-4 py-3'>
        <div className='min-w-0'>
          <h3 className='text-sm font-semibold tracking-[-0.01em]'>{title}</h3>
          {hint ? (
            <p className='mt-0.5 text-xs leading-5 text-muted-foreground'>
              {hint}
            </p>
          ) : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  )
}

export function EmptyNotice({
  icon: Icon,
  message,
  action,
}: {
  icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
  message: string
  action?: React.ReactNode
}) {
  return (
    <div className='flex flex-col items-center justify-center gap-2 px-4 py-8 text-center'>
      {Icon ? (
        <span className='flex size-8 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground'>
          <Icon className='size-4' aria-hidden />
        </span>
      ) : null}
      <p className='text-sm text-muted-foreground'>{message}</p>
      {action}
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <div
      className='grid rounded-lg bg-muted p-1'
      style={{
        gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`,
      }}
    >
      {options.map((option) => {
        const on = value === option.value
        return (
          <button
            key={option.value}
            type='button'
            aria-pressed={on}
            className={cn(
              'cursor-pointer rounded-md px-3 py-1.5 text-sm transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              on
                ? 'bg-background font-medium text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground'
            )}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** Label sits in a fixed column so the inputs and their buttons line up. */
export function FieldLine({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor?: string
  children: React.ReactNode
}) {
  return (
    <div className='grid gap-2 sm:grid-cols-[4.5rem_minmax(0,1fr)] sm:items-center sm:gap-4'>
      <Label htmlFor={htmlFor} className='text-muted-foreground'>
        {label}
      </Label>
      {children}
    </div>
  )
}

export function ToggleList({ children }: { children: React.ReactNode }) {
  return (
    <div className='grid grid-cols-1 overflow-hidden rounded-xl border md:grid-cols-2 [&>*]:border-b [&>*:last-child]:border-b-0 md:[&>*:last-child:nth-child(odd)]:col-span-2 md:[&>*:last-child:nth-child(odd)]:border-e-0 md:[&>*:nth-child(odd)]:border-e md:[&>*:nth-last-child(2):nth-child(odd)]:border-b-0'>
      {children}
    </div>
  )
}

export function ToggleItem({
  label,
  desc,
  children,
}: {
  label: string
  desc?: string
  children: React.ReactNode
}) {
  return (
    <div className='flex items-center justify-between gap-4 px-4 py-3'>
      <div className='min-w-0'>
        <p className='text-sm'>{label}</p>
        {desc ? (
          <p className='text-xs leading-5 text-muted-foreground'>{desc}</p>
        ) : null}
      </div>
      {children}
    </div>
  )
}

export function FoldStack({ children }: { children: React.ReactNode }) {
  return (
    <div className='divide-y overflow-hidden rounded-xl border'>{children}</div>
  )
}

/** Long rule editors stay closed until asked. The summary stays visible. */
export function Fold({
  title,
  meta,
  children,
  defaultOpen = false,
  flush = false,
}: {
  title: string
  meta?: string
  children: React.ReactNode
  defaultOpen?: boolean
  flush?: boolean
}) {
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className={flush ? '' : 'rounded-lg border'}
    >
      <CollapsibleTrigger className='flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left text-sm transition-colors duration-200 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-[state=open]:[&_svg]:rotate-180'>
        <span>{title}</span>
        <span className='flex items-center gap-2 text-xs text-muted-foreground'>
          {meta}
          <ChevronDown
            className='size-4 transition-transform duration-200'
            aria-hidden='true'
          />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className='border-t px-4 py-3'>
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}
