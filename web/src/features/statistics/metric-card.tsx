import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowRight, ArrowUp, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

type Accent = 'primary' | 'emerald' | 'blue' | 'amber' | 'purple' | 'rose'

function MetricComparisonBadge({
  value,
  label,
  isPercentage = true,
  invertSentiment = false,
}: MetricComparison & { invertSentiment?: boolean }) {
  const Icon = value > 0 ? ArrowUp : value < 0 ? ArrowDown : ArrowRight
  const favorable = invertSentiment ? value < 0 : value > 0
  const unfavorable = invertSentiment ? value > 0 : value < 0
  return (
    <div className='flex items-center gap-1.5'>
      <div
        className={cn(
          'flex items-center gap-0.5 text-xs font-medium',
          favorable && 'text-emerald-500 dark:text-emerald-400',
          unfavorable && 'text-rose-500 dark:text-rose-400',
          value === 0 && 'text-muted-foreground'
        )}
      >
        <Icon className='h-3 w-3' />
        <span>
          {value > 0 ? '+' : value < 0 ? '−' : ''}
          {Math.abs(value)}
          {isPercentage && '%'}
        </span>
      </div>
      <span className='text-[10px] text-muted-foreground'>{label}</span>
    </div>
  )
}

const ACCENTS: Record<Accent, { glow: string; iconBg: string; text: string }> =
  {
    primary: {
      glow: 'bg-primary/10',
      iconBg: 'bg-primary/10 dark:bg-primary/15',
      text: 'text-primary',
    },
    emerald: {
      glow: 'bg-emerald-500/10',
      iconBg: 'bg-emerald-500/10 dark:bg-emerald-500/15',
      text: 'text-emerald-500',
    },
    blue: {
      glow: 'bg-blue-500/10',
      iconBg: 'bg-blue-500/10 dark:bg-blue-500/15',
      text: 'text-blue-500',
    },
    amber: {
      glow: 'bg-amber-500/10',
      iconBg: 'bg-amber-500/10 dark:bg-amber-500/15',
      text: 'text-amber-500',
    },
    purple: {
      glow: 'bg-purple-500/10',
      iconBg: 'bg-purple-500/10 dark:bg-purple-500/15',
      text: 'text-purple-500',
    },
    rose: {
      glow: 'bg-rose-500/10',
      iconBg: 'bg-rose-500/10 dark:bg-rose-500/15',
      text: 'text-rose-500',
    },
  }

export type MetricComparison = {
  value: number
  label: string
  isPercentage?: boolean
}

const ANIMATION_MS = 400

/** 数值变化时按 ease-out-cubic 在 400ms 内滚动到新值（hub BentoMetricCard）。 */
function useAnimatedNumber(value: number) {
  const [display, setDisplay] = useState(value)
  const [animating, setAnimating] = useState(false)
  const fromRef = useRef(value)

  useEffect(() => {
    const start = fromRef.current
    if (start === value) return
    let frame = 0
    const startedAt = performance.now()
    setAnimating(true)
    const step = (now: number) => {
      const progress = Math.min((now - startedAt) / ANIMATION_MS, 1)
      const eased = 1 - (1 - progress) ** 3
      const current = start + (value - start) * eased
      fromRef.current = current
      setDisplay(current)
      if (progress < 1) {
        frame = requestAnimationFrame(step)
      } else {
        setAnimating(false)
      }
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [value])

  return { display, animating }
}

function AnimatedMetric({
  value,
  formatter,
}: {
  value: number
  formatter: (value: number) => string
}) {
  const { display, animating } = useAnimatedNumber(value)
  return (
    <span
      className={cn(
        'transition-opacity duration-200',
        animating && 'opacity-80'
      )}
    >
      {formatter(display)}
    </span>
  )
}

export function BentoMetricCard({
  title,
  value,
  formatter,
  icon: Icon,
  comparisons,
  invertSentiment = false,
  accentColor = 'primary',
  className,
}: {
  title: string
  value: number | null
  formatter: (value: number) => string
  icon: LucideIcon
  comparisons?: MetricComparison[]
  invertSentiment?: boolean
  accentColor?: Accent
  className?: string
}) {
  const colors = ACCENTS[accentColor]

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-2xl p-5 md:p-6',
        'bg-card/60 dark:bg-[rgba(20,20,23,0.5)]',
        'backdrop-blur-lg',
        'border border-border/50 dark:border-white/[0.08]',
        'shadow-sm',
        'before:pointer-events-none before:absolute before:inset-0 before:z-[1] before:bg-gradient-to-b before:from-white/[0.02] before:to-transparent',
        'transition-all duration-300 ease-out',
        'hover:border-primary/20 hover:shadow-md',
        'hover:-translate-y-0.5',
        'flex h-full min-h-[140px] flex-col justify-between',
        'group',
        className
      )}
    >
      <div
        className={cn(
          'pointer-events-none absolute -top-[30%] -right-[15%] z-0 h-[150px] w-[150px] rounded-full blur-[50px]',
          colors.glow,
          'opacity-50 transition-opacity duration-500 group-hover:opacity-70'
        )}
      />

      <div className='relative z-10'>
        <div className='flex items-start justify-between gap-2'>
          <div className='flex min-w-0 items-center gap-3'>
            <div
              className={cn(
                'flex-shrink-0 rounded-lg p-2',
                colors.iconBg,
                'transition-all duration-300 group-hover:scale-105'
              )}
            >
              <Icon className={cn('h-4 w-4', colors.text)} />
            </div>
            <p className='truncate text-sm font-medium text-muted-foreground transition-colors group-hover:text-foreground/80'>
              {title}
            </p>
          </div>
        </div>

        <div className='mt-3'>
          <h3 className='text-2xl font-bold tracking-tight text-foreground tabular-nums md:text-3xl'>
            {value == null ? (
              '—'
            ) : (
              <AnimatedMetric value={value} formatter={formatter} />
            )}
          </h3>
        </div>
      </div>

      {comparisons && comparisons.length > 0 ? (
        <div className='relative z-10 mt-auto flex flex-wrap gap-x-4 gap-y-1 pt-3'>
          {comparisons.map((comparison) => (
            <MetricComparisonBadge
              key={comparison.label}
              {...comparison}
              invertSentiment={invertSentiment}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
