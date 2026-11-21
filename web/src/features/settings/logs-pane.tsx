import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingRow } from '@/components/setting-row'

type LogsPaneProps = {
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}

export function LogsPane({ value: logging, onChange }: LogsPaneProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>日志保留</CardTitle>
      </CardHeader>
      <CardContent className='divide-y'>
        <SettingRow label='记录模式'>
          <Select
            value={String(logging.mode || 'normal')}
            onValueChange={(mode) => onChange({ ...logging, mode })}
          >
            <SelectTrigger className='w-40'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='off'>关闭</SelectItem>
              <SelectItem value='normal'>普通</SelectItem>
              <SelectItem value='debug'>Debug</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow label='保留天数'>
          <Input
            className='w-24'
            type='number'
            min={1}
            max={90}
            value={Number(logging.retain_days ?? 7)}
            onChange={(event) =>
              onChange({
                ...logging,
                retain_days: Number(event.target.value),
              })
            }
          />
        </SettingRow>
        <SettingRow
          label='Debug 保留天数'
          desc='request_log_debug 行。不超过上面的保留天数。'
        >
          <Input
            className='w-24'
            type='number'
            min={1}
            max={90}
            value={Number(logging.debug_retain_days ?? 3)}
            onChange={(event) =>
              onChange({
                ...logging,
                debug_retain_days: Number(event.target.value),
              })
            }
          />
        </SettingRow>
        <SettingRow
          label='存储上限 MB'
          desc='0 表示不按体积清理。超出删最旧 debug 行。'
        >
          <Input
            className='w-24'
            type='number'
            min={0}
            value={Number(logging.max_mb ?? 2048)}
            onChange={(event) =>
              onChange({
                ...logging,
                max_mb: Number(event.target.value),
              })
            }
          />
        </SettingRow>
      </CardContent>
    </Card>
  )
}
