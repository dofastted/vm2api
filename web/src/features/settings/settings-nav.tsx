import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import {
  SETTINGS_NAV_GROUPS,
  SETTINGS_NAV_ITEMS,
  SETTINGS_TAB_LABELS,
  type SettingsTabId,
} from '@/features/settings/navigation'

/**
 * 设置页子导航。桌面（md+）是分组竖排 + 滑动指示条；
 * 窄屏收成一条横向滚动的 pill 列，激活项自动滚入视野。
 *
 * 指示条不用第三方动画库：量出激活项相对容器的 offsetTop，
 * transform 过渡到位（motion-safe 下 200ms ease-out-expo）。
 */
export function SettingsNav({ active }: { active: SettingsTabId }) {
  const listRef = useRef<HTMLDivElement>(null)
  const activeDesktopRef = useRef<HTMLAnchorElement>(null)
  const activeMobileRef = useRef<HTMLAnchorElement>(null)
  const [indicator, setIndicator] = useState<{
    y: number
    h: number
  } | null>(null)

  useLayoutEffect(() => {
    const list = listRef.current
    const item = activeDesktopRef.current
    if (!list || !item) return
    const listBox = list.getBoundingClientRect()
    const itemBox = item.getBoundingClientRect()
    setIndicator({ y: itemBox.top - listBox.top, h: itemBox.height })
  }, [active])

  useEffect(() => {
    activeMobileRef.current?.scrollIntoView({
      inline: 'center',
      block: 'nearest',
      behavior: 'smooth',
    })
  }, [active])

  return (
    <>
      {/* 桌面：分组竖排 */}
      <nav
        aria-label='设置分区'
        className='hidden @2xl/content:sticky @2xl/content:top-20 @2xl/content:block @2xl/content:self-start'
      >
        <div ref={listRef} className='relative space-y-4'>
          {indicator ? (
            <span
              aria-hidden
              className='absolute -left-px w-0.5 rounded-full bg-primary motion-safe:transition-transform motion-safe:duration-200 motion-safe:[transition-timing-function:var(--ease-out-expo)]'
              style={{
                height: indicator.h - 12,
                transform: `translateY(${indicator.y + 6}px)`,
              }}
            />
          ) : null}
          {SETTINGS_NAV_GROUPS.map((group) => (
            <div key={group.label}>
              <div className='px-3 pb-1 text-xs font-medium text-(--text-tertiary)'>
                {group.label}
              </div>
              <div className='space-y-0.5'>
                {group.items.map(({ id, icon: Icon }) => {
                  const isActive = id === active
                  return (
                    <Link
                      key={id}
                      ref={isActive ? activeDesktopRef : undefined}
                      to='/settings/$tab'
                      params={{ tab: id }}
                      aria-current={isActive ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm transition-colors duration-150',
                        isActive
                          ? 'bg-accent font-medium text-accent-foreground'
                          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                      )}
                    >
                      <Icon className='size-4 shrink-0' aria-hidden />
                      {SETTINGS_TAB_LABELS[id]}
                    </Link>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </nav>

      {/* 窄屏：横向滚动 pill 列 */}
      <nav
        aria-label='设置分区'
        className='-mx-4 no-scrollbar flex gap-1 overflow-x-auto px-4 @2xl/content:hidden'
      >
        {SETTINGS_NAV_ITEMS.map(({ id, icon: Icon }) => {
          const isActive = id === active
          return (
            <Link
              key={id}
              ref={isActive ? activeMobileRef : undefined}
              to='/settings/$tab'
              params={{ tab: id }}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm whitespace-nowrap transition-colors duration-150',
                isActive
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon className='size-4' aria-hidden />
              {SETTINGS_TAB_LABELS[id]}
            </Link>
          )
        })}
      </nav>
    </>
  )
}
