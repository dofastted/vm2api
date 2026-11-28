import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { handleSlidingTabKeyDown } from './prompt-presentation'

export type SlidingTabItem<T extends string> = {
  value: T
  label: string
  description?: string
  icon?: ReactNode
  badge?: ReactNode
}

type Rect = { x: number; y: number; w: number; h: number }

/**
 * 测量激活项并滑动高亮层的 Tab 控件（完整支持 WAI-ARIA roving tabIndex 与方向键导航）。
 * 仅对合成层属性（transform/opacity）过渡，首次测量与容器 ResizeObserver 缩放时立即贴合无拖影；
 * SSR/无布局测试下自动回退静态高亮。
 */
export function SlidingTabs<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  variant = 'segmented',
  className,
}: {
  items: readonly SlidingTabItem<T>[]
  value: T
  onChange: (value: T) => void
  ariaLabel: string
  variant?: 'segmented' | 'cards'
  className?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const prevValueRef = useRef<T>(value)
  const hasMeasuredRef = useRef(false)
  const lastRectRef = useRef<Rect | null>(null)
  const [rect, setRect] = useState<Rect | null>(null)
  const [animateThumb, setAnimateThumb] = useState(false)

  useLayoutEffect(() => {
    const container = containerRef.current
    const activeEl = itemRefs.current[value]
    if (!container || !activeEl) return

    const valueChanged = prevValueRef.current !== value
    prevValueRef.current = value

    const measure = (shouldAnimate: boolean, fromResize: boolean) => {
      const w = activeEl.offsetWidth
      const h = activeEl.offsetHeight
      if (w <= 0 || h <= 0) {
        lastRectRef.current = null
        hasMeasuredRef.current = false
        setRect(null)
        setAnimateThumb(false)
        return
      }
      const next: Rect = {
        x: activeEl.offsetLeft,
        y: activeEl.offsetTop,
        w,
        h,
      }
      const prev = lastRectRef.current
      // ResizeObserver fires immediately on observe(); ignore no-op callbacks so tab-switch slides aren't cancelled.
      if (
        fromResize &&
        prev &&
        prev.x === next.x &&
        prev.y === next.y &&
        prev.w === next.w &&
        prev.h === next.h
      ) {
        return
      }
      setAnimateThumb(shouldAnimate && hasMeasuredRef.current)
      hasMeasuredRef.current = true
      lastRectRef.current = next
      setRect(next)
    }

    measure(valueChanged, false)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measure(false, true))
    observer.observe(container)
    observer.observe(activeEl)
    return () => observer.disconnect()
  }, [value, items.length])

  const hasThumb = rect !== null

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number
  ) => {
    handleSlidingTabKeyDown(event, index, items, onChange, (target) =>
      itemRefs.current[target]?.focus()
    )
  }

  if (variant === 'segmented') {
    return (
      <div
        ref={containerRef}
        role='tablist'
        aria-label={ariaLabel}
        className={cn(
          'relative inline-grid auto-cols-fr grid-flow-col items-center gap-1 rounded-xl border border-border/70 bg-muted/70 p-1',
          className
        )}
      >
        {hasThumb ? (
          <span
            aria-hidden
            data-animate={animateThumb ? 'true' : 'false'}
            className='prompt-sliding-thumb pointer-events-none absolute top-0 left-0 rounded-lg bg-card shadow-xs ring-1 ring-border/70 dark:bg-background/95'
            style={{
              width: rect.w,
              height: rect.h,
              transform: `translate3d(${rect.x}px, ${rect.y}px, 0)`,
            }}
          />
        ) : null}
        {items.map((item, index) => {
          const selected = item.value === value
          return (
            <button
              key={item.value}
              ref={(el) => {
                itemRefs.current[item.value] = el
              }}
              type='button'
              role='tab'
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(item.value)}
              onKeyDown={(e) => handleKeyDown(e, index)}
              className={cn(
                'relative z-10 inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-medium whitespace-nowrap transition-colors duration-150 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                selected
                  ? cn(
                      'text-foreground',
                      !hasThumb &&
                        'bg-card shadow-xs ring-1 ring-border/70 dark:bg-background/95'
                    )
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {item.icon}
              <span>{item.label}</span>
              {item.badge}
            </button>
          )
        })}
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      role='tablist'
      aria-label={ariaLabel}
      className={cn(
        'relative grid gap-2 rounded-2xl border border-border/70 bg-muted/45 p-1.5',
        className
      )}
    >
      {hasThumb ? (
        <span
          aria-hidden
          data-animate={animateThumb ? 'true' : 'false'}
          className='prompt-sliding-thumb pointer-events-none absolute top-0 left-0 rounded-xl bg-card shadow-xs ring-1 ring-primary/35 dark:bg-card'
          style={{
            width: rect.w,
            height: rect.h,
            transform: `translate3d(${rect.x}px, ${rect.y}px, 0)`,
          }}
        />
      ) : null}
      {items.map((item, index) => {
        const selected = item.value === value
        return (
          <button
            key={item.value}
            ref={(el) => {
              itemRefs.current[item.value] = el
            }}
            type='button'
            role='tab'
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.value)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={cn(
              'relative z-10 flex cursor-pointer flex-col items-start gap-1 rounded-xl px-3.5 py-2.5 text-left transition-colors duration-150 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
              selected
                ? cn(
                    'text-foreground',
                    !hasThumb && 'bg-card shadow-xs ring-1 ring-primary/35'
                  )
                : 'text-muted-foreground hover:bg-card/55 hover:text-foreground'
            )}
          >
            <span className='flex w-full items-center gap-2'>
              {item.icon}
              <span className='text-sm font-medium whitespace-nowrap text-foreground'>
                {item.label}
              </span>
              {item.badge ? (
                <span className='ml-auto'>{item.badge}</span>
              ) : null}
            </span>
            {item.description ? (
              <span className='line-clamp-1 w-full text-xs text-muted-foreground'>
                {item.description}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
