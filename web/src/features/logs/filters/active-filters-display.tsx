import { format } from 'date-fns'
import type { UsageLogFilterOptions } from '@/types/panel-usage-logs'
import { X } from 'lucide-react'
import { ERROR_CLASS_META } from '@/lib/log-mute'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { LogsFilterState } from '../search'
import { inclusiveEndFromExclusive } from './time-range'

type ChipKey = keyof LogsFilterState | 'time' | 'status'

function nameOf(list: { id: string; name: string }[] | undefined, id: string) {
  return list?.find((item) => item.id === id)?.name ?? id
}

export function ActiveFiltersDisplay({
  isAdmin,
  filters,
  options,
  onRemove,
  onClearAll,
}: {
  isAdmin: boolean
  filters: LogsFilterState
  options: UsageLogFilterOptions | undefined
  onRemove: (filters: LogsFilterState) => void
  onClearAll: () => void
}) {
  const chips: { key: ChipKey; label: string; value: string }[] = []
  if (isAdmin && filters.userId)
    chips.push({
      key: 'userId',
      label: '用户',
      value: nameOf(options?.users, filters.userId),
    })
  if (filters.keyId)
    chips.push({
      key: 'keyId',
      label: 'API 密钥',
      value: nameOf(options?.keys, filters.keyId),
    })
  if (isAdmin && filters.vmId)
    chips.push({
      key: 'vmId',
      label: '虚拟机',
      value: nameOf(options?.vms, filters.vmId),
    })
  if (filters.sessionId)
    chips.push({
      key: 'sessionId',
      label: 'Session ID',
      value:
        filters.sessionId.length > 12
          ? `${filters.sessionId.slice(0, 12)}...`
          : filters.sessionId,
    })
  if (filters.startTime != null && filters.endTime != null) {
    const start = format(new Date(filters.startTime), 'MM/dd')
    const end = format(
      new Date(inclusiveEndFromExclusive(filters.endTime)),
      'MM/dd'
    )
    chips.push({
      key: 'time',
      label: '日期范围',
      value: start === end ? start : `${start} - ${end}`,
    })
  } else if (filters.startTime != null) {
    chips.push({
      key: 'time',
      label: '起始时间',
      value: format(new Date(filters.startTime), 'yyyy-MM-dd HH:mm:ss'),
    })
  } else if (filters.endTime != null) {
    chips.push({
      key: 'time',
      label: '截止时间',
      value: format(
        new Date(inclusiveEndFromExclusive(filters.endTime)),
        'yyyy-MM-dd HH:mm:ss'
      ),
    })
  }
  if (filters.model)
    chips.push({ key: 'model', label: '模型', value: filters.model })
  if (filters.mismatch)
    chips.push({
      key: 'mismatch',
      label: '计费/实际模型不一致',
      value: '已开启',
    })
  if (filters.endpoint)
    chips.push({ key: 'endpoint', label: '端点', value: filters.endpoint })
  if (filters.protocol)
    chips.push({ key: 'protocol', label: '协议', value: filters.protocol })
  if (filters.excludeStatus200)
    chips.push({ key: 'status', label: '状态码', value: '仅非 2xx' })
  else if (filters.statusCode != null)
    chips.push({
      key: 'status',
      label: '状态码',
      value: String(filters.statusCode),
    })
  if ((filters.minRetry ?? 0) > 0)
    chips.push({
      key: 'minRetry',
      label: '重试次数≥',
      value: `>=${filters.minRetry}`,
    })
  if (filters.errorClass)
    chips.push({
      key: 'errorClass',
      label: '错误类',
      value: ERROR_CLASS_META[filters.errorClass]?.label ?? filters.errorClass,
    })
  if (filters.debugOnly)
    chips.push({ key: 'debugOnly', label: 'Debug 采样', value: '已开启' })

  if (!chips.length) return null

  function remove(key: ChipKey) {
    const next = { ...filters }
    if (key === 'time') {
      next.startTime = undefined
      next.endTime = undefined
    } else if (key === 'status') {
      next.statusCode = undefined
      next.excludeStatus200 = undefined
    } else {
      next[key] = undefined
    }
    onRemove(next)
  }

  return (
    <div className='-mb-1 flex [scrollbar-width:none] flex-wrap items-center gap-2 overflow-x-auto pb-1'>
      <span className='shrink-0 text-xs font-medium text-muted-foreground'>
        筛选条件:
      </span>
      {chips.map((chip) => (
        <Badge
          key={chip.key}
          variant='secondary'
          className='h-auto shrink-0 gap-1 py-1 pr-1.5 pl-2'
        >
          <span className='text-xs'>{chip.label}: </span>
          <span className='font-semibold'>{chip.value}</span>
          <button
            type='button'
            aria-label='移除筛选'
            onClick={() => remove(chip.key)}
            className='ml-1 cursor-pointer rounded-full outline-none hover:bg-muted-foreground/20 focus:ring-2 focus:ring-ring/50'
          >
            <X className='h-3 w-3' />
          </button>
        </Badge>
      ))}
      {chips.length > 2 ? (
        <Button
          type='button'
          variant='ghost'
          size='sm'
          className='h-auto shrink-0 px-2 py-1 text-xs'
          onClick={onClearAll}
        >
          清除全部
        </Button>
      ) : null}
    </div>
  )
}
