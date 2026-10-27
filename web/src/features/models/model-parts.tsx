import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function Panel({
  title,
  icon,
  compact,
  children,
}: {
  title: string
  icon: ReactNode
  compact?: boolean
  children: ReactNode
}) {
  return (
    <div className='rounded-xl border border-border/70 bg-background/70 p-3'>
      <div className='mb-3 flex items-center gap-2 text-sm font-semibold'>
        <span className='text-muted-foreground'>{icon}</span>
        {title}
      </div>
      <div className={cn('space-y-3', compact && 'space-y-2')}>{children}</div>
    </div>
  )
}

export function EditorRow({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className='grid gap-1.5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:items-center'>
      <span className='text-xs font-medium text-muted-foreground'>{label}</span>
      <div className='flex min-w-0 flex-wrap items-center gap-2'>
        {children}
      </div>
    </div>
  )
}

export function Metric({
  label,
  value,
  strong,
}: {
  label: string
  value: string
  strong?: boolean
}) {
  return (
    <div className='rounded-lg bg-muted/45 px-2.5 py-2'>
      <div className='text-[11px] text-muted-foreground'>{label}</div>
      <div
        className={cn('field-count mt-0.5 truncate', strong && 'font-semibold')}
      >
        {value}
      </div>
    </div>
  )
}

export function Fact({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className='flex items-start justify-between gap-3 text-xs'>
      <span className='text-muted-foreground'>{label}</span>
      <span className={cn('text-right', mono && 'font-mono')}>{value}</span>
    </div>
  )
}
