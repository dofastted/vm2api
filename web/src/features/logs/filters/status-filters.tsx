import { ERROR_CLASS_IDS, ERROR_CLASS_META } from '@/lib/log-mute'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { LogsFilterState } from '../search'

const ALL = '__all__'
const NOT_200 = '!200'

const COMMON_STATUS_CODES: [number, string][] = [
  [200, '200 (成功)'],
  [400, '400 (错误请求)'],
  [401, '401 (未授权)'],
  [429, '429 (限流)'],
  [500, '500 (服务器错误)'],
  [503, '503 (无可用账号)'],
  [529, '529 (过载)'],
]

export function StatusFilters({
  filters,
  statusCodes,
  onChange,
}: {
  filters: LogsFilterState
  statusCodes: number[]
  onChange: (filters: LogsFilterState) => void
}) {
  const common = COMMON_STATUS_CODES.map(([code]) => code)
  const dynamic = statusCodes.filter((code) => !common.includes(code))
  const statusValue = filters.excludeStatus200
    ? NOT_200
    : filters.statusCode != null
      ? String(filters.statusCode)
      : ALL

  return (
    <div className='grid gap-4 sm:grid-cols-2'>
      <div className='space-y-2'>
        <Label>状态码</Label>
        <Select
          value={statusValue}
          onValueChange={(value) =>
            onChange({
              ...filters,
              excludeStatus200: value === NOT_200 || undefined,
              statusCode:
                value === ALL || value === NOT_200
                  ? undefined
                  : Number.parseInt(value, 10),
            })
          }
        >
          <SelectTrigger className='w-full'>
            <SelectValue placeholder='全部状态码' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部状态码</SelectItem>
            <SelectItem value={NOT_200}>仅非 2xx（含无状态码）</SelectItem>
            {COMMON_STATUS_CODES.map(([code, label]) => (
              <SelectItem key={code} value={String(code)}>
                {label}
              </SelectItem>
            ))}
            {dynamic.map((code) => (
              <SelectItem key={code} value={String(code)}>
                {code}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className='space-y-2'>
        <Label>重试次数≥</Label>
        <Input
          type='number'
          min={0}
          inputMode='numeric'
          placeholder='输入次数（0 表示不限）'
          value={filters.minRetry ?? ''}
          onChange={(event) => {
            const n = Number.parseInt(event.target.value, 10)
            onChange({
              ...filters,
              minRetry: Number.isFinite(n) && n >= 0 ? n : undefined,
            })
          }}
        />
      </div>
      <div className='space-y-2'>
        <Label>错误类</Label>
        <Select
          value={filters.errorClass ?? ALL}
          onValueChange={(value) =>
            onChange({
              ...filters,
              errorClass: value === ALL ? undefined : value,
            })
          }
        >
          <SelectTrigger className='w-full'>
            <SelectValue placeholder='全部类' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部类</SelectItem>
            {ERROR_CLASS_IDS.map((id) => (
              <SelectItem key={id} value={id}>
                {ERROR_CLASS_META[id].label}（{id}）
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
