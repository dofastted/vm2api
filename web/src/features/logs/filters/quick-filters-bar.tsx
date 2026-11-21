import {
  AlertCircle,
  Bug,
  Calendar,
  CalendarDays,
  RefreshCw,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { LogsFilterState } from '../search'
import { detectQuickTimePreset, getQuickTimeRange } from './time-range'

type Preset = {
  id: string
  label: string
  icon: LucideIcon
  active: boolean
  toggle: () => LogsFilterState
}

/**
 * hub 的四个快捷预设 + vm2api 的「Debug 采样」（只看 debug 模式落库的行）。
 * 激活态完全由筛选值推导，日期选择器改了也能保持同步；只改草稿，需「应用筛选」。
 */
export function QuickFiltersBar({
  filters,
  onChange,
}: {
  filters: LogsFilterState
  onChange: (filters: LogsFilterState) => void
}) {
  const timePreset = detectQuickTimePreset(filters.startTime, filters.endTime)
  const clearTime = { ...filters, startTime: undefined, endTime: undefined }
  const timeGroup: Preset[] = (['today', 'this-week'] as const).map((id) => ({
    id,
    label: id === 'today' ? '今天' : '本周',
    icon: id === 'today' ? Calendar : CalendarDays,
    active: timePreset === id,
    toggle: () =>
      timePreset === id ? clearTime : { ...filters, ...getQuickTimeRange(id) },
  }))
  const statusGroup: Preset[] = [
    {
      id: 'errors-only',
      label: '仅非 2xx',
      icon: AlertCircle,
      active: !!filters.excludeStatus200,
      toggle: () =>
        filters.excludeStatus200
          ? { ...filters, excludeStatus200: undefined }
          : { ...filters, excludeStatus200: true, statusCode: undefined },
    },
    {
      id: 'show-retries',
      label: '有重试',
      icon: RefreshCw,
      active: (filters.minRetry ?? 0) > 0,
      toggle: () => ({
        ...filters,
        minRetry: (filters.minRetry ?? 0) > 0 ? undefined : 1,
      }),
    },
  ]
  const modeGroup: Preset[] = [
    {
      id: 'debug',
      label: 'Debug 采样',
      icon: Bug,
      active: !!filters.debugOnly,
      toggle: () => ({
        ...filters,
        debugOnly: filters.debugOnly ? undefined : true,
      }),
    },
  ]

  return (
    <div className='mb-3 flex [scrollbar-width:none] flex-wrap items-center gap-2 overflow-x-auto pb-1'>
      {[timeGroup, statusGroup, modeGroup].map((group, index) => (
        <div key={index} className='contents'>
          {index > 0 ? (
            <div className='hidden h-5 w-px shrink-0 bg-border sm:block' />
          ) : null}
          {group.map((preset) => {
            const Icon = preset.icon
            return (
              <Button
                key={preset.id}
                type='button'
                size='sm'
                className='shrink-0'
                variant={preset.active ? 'default' : 'outline'}
                aria-pressed={preset.active}
                onClick={() => onChange(preset.toggle())}
              >
                <Icon className='mr-1.5 h-4 w-4' />
                {preset.label}
              </Button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
