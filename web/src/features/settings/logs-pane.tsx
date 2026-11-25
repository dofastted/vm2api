import { useEffect, useState } from 'react'
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
import { settleInt, typingInt } from './int-input'
import {
  LOGGING_MAX_MB_MAX,
  LOGGING_MAX_MB_MIN,
  LOGGING_RETAIN_DAYS_MAX,
  LOGGING_RETAIN_DAYS_MIN,
  validateLoggingDraft,
} from './routing-draft'

const DEFAULT_RETAIN_DAYS = 7
const DEFAULT_DEBUG_RETAIN_DAYS = 3
const DEFAULT_MAX_MB = 2048

type LogsPaneProps = {
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}

function BoundedLogIntInput({
  ariaLabel,
  value,
  fallback,
  min,
  max,
  invalid,
  clampOnBlur = false,
  onChange,
}: {
  ariaLabel: string
  value: unknown
  fallback: number
  min: number
  max: number
  invalid: boolean
  clampOnBlur?: boolean
  onChange: (next: number | '') => void
}) {
  const display =
    value === '' ? '' : String(value === undefined ? fallback : value)
  const [text, setText] = useState(display)
  useEffect(() => {
    setText(display)
  }, [display])
  return (
    <Input
      aria-label={ariaLabel}
      aria-invalid={invalid}
      className='w-28 tabular-nums'
      type='number'
      inputMode='numeric'
      min={min}
      max={max}
      value={text}
      onChange={(event) => {
        const raw = event.target.value
        setText(raw)
        if (!raw.trim()) {
          onChange('')
          return
        }
        const parsed = typingInt(raw)
        if (parsed !== null) onChange(parsed)
      }}
      onBlur={() => {
        if (!text.trim()) {
          setText(String(fallback))
          onChange(fallback)
          return
        }
        if (clampOnBlur) {
          const settled = settleInt(text, min, max, fallback)
          setText(String(settled))
          onChange(settled)
        }
      }}
    />
  )
}

export function LogsPane({ value: logging, onChange }: LogsPaneProps) {
  const validation = validateLoggingDraft(logging)
  return (
    <Card>
      <CardHeader>
        <CardTitle>日志保留</CardTitle>
      </CardHeader>
      <CardContent className='divide-y'>
        <SettingRow
          label='记录模式'
          desc='常规模式仅写 usage_logs 请求摘要与计费明细，不写 Debug 载荷；Debug 模式额外保存脱敏后的请求与响应载荷。'
        >
          <Select
            value={String(logging.mode || 'normal')}
            onValueChange={(mode) => onChange({ ...logging, mode })}
          >
            <SelectTrigger className='w-40'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='off'>关闭</SelectItem>
              <SelectItem value='normal'>常规</SelectItem>
              <SelectItem value='debug'>Debug</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <div className='space-y-1 py-3'>
          <SettingRow
            label='保留天数'
            desc='usage_logs 请求明细保留天数（1–90 天，后台每 10 分钟定时清理）。超期明细删除前会将累计费用与 token 归档到账号累计用量，不影响终身统计。'
          >
            <BoundedLogIntInput
              ariaLabel='保留天数'
              value={logging.retain_days}
              fallback={DEFAULT_RETAIN_DAYS}
              min={LOGGING_RETAIN_DAYS_MIN}
              max={LOGGING_RETAIN_DAYS_MAX}
              invalid={!!validation.retainDaysError}
              onChange={(retain_days) => onChange({ ...logging, retain_days })}
            />
          </SettingRow>
          {validation.retainDaysError ? (
            <p role='alert' className='text-xs text-destructive'>
              {validation.retainDaysError}
            </p>
          ) : null}
        </div>
        <div className='space-y-1 py-3'>
          <SettingRow
            label='Debug 保留天数'
            desc='request_log_debug 调试载荷保留天数（1–90 天，且不能大于上面的保留天数）；后台每 10 分钟定时清理。'
          >
            <BoundedLogIntInput
              ariaLabel='Debug 保留天数'
              value={logging.debug_retain_days}
              fallback={DEFAULT_DEBUG_RETAIN_DAYS}
              min={LOGGING_RETAIN_DAYS_MIN}
              max={LOGGING_RETAIN_DAYS_MAX}
              invalid={!!validation.debugRetainDaysError}
              onChange={(debug_retain_days) =>
                onChange({ ...logging, debug_retain_days })
              }
            />
          </SettingRow>
          {validation.debugRetainDaysError ? (
            <p role='alert' className='text-xs text-destructive'>
              {validation.debugRetainDaysError}
            </p>
          ) : null}
        </div>
        <div className='space-y-1 py-3'>
          <SettingRow
            label='Debug 载荷上限 (MiB)'
            desc='仅限制 request_log_debug 调试载荷总大小（0–102400 MiB，0 表示不按体积裁剪；默认常规模式下不裁剪 usage_logs 明细或数据库总大小）。超出时由后台每 10 分钟定时清理任务删除最旧 Debug 记录。'
          >
            <BoundedLogIntInput
              ariaLabel='Debug 载荷上限 (MiB)'
              value={logging.max_mb}
              fallback={DEFAULT_MAX_MB}
              min={LOGGING_MAX_MB_MIN}
              max={LOGGING_MAX_MB_MAX}
              invalid={!!validation.maxMbError}
              clampOnBlur
              onChange={(max_mb) => onChange({ ...logging, max_mb })}
            />
          </SettingRow>
          {validation.maxMbError ? (
            <p role='alert' className='text-xs text-destructive'>
              {validation.maxMbError}
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
