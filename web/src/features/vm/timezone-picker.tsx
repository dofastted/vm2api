import { useState } from 'react'
import { validTimezone, zoneNowLabel } from '@/lib/timezone'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  VM_TIMEZONE_CUSTOM,
  VM_TIMEZONES,
  isPresetTimezone,
} from '@/features/vm/create-options'

type TimezonePickerProps = {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  /** 下拉宽度，随宿主容器给（创建弹窗全宽、详情页固定宽）。 */
  className?: string
}

/**
 * 时区选择：预设下拉 + 「自定义…」输入任意 IANA 名称。
 *
 * 后端只要求 `Intl` 能解析，所以这里不再把选择限制在预设列表里；输入框旁边
 * 回显该时区的当前时刻，无效名称会直接看不到时间，比提交后 400 早一步。
 */
export function TimezonePicker({
  value,
  onChange,
  disabled,
  className,
}: TimezonePickerProps) {
  const preset = isPresetTimezone(value)
  const [custom, setCustom] = useState(!preset && !!value)
  const selectValue = preset ? value : custom ? VM_TIMEZONE_CUSTOM : ''
  const showCustom = custom && !preset
  const now = showCustom ? zoneNowLabel(value) : ''

  return (
    <div className='space-y-1'>
      <Select
        value={selectValue}
        disabled={disabled}
        onValueChange={(next) => {
          if (next === VM_TIMEZONE_CUSTOM) {
            setCustom(true)
            return
          }
          setCustom(false)
          onChange(next)
        }}
      >
        <SelectTrigger className={className} aria-label='时区'>
          <SelectValue placeholder='选择时区' />
        </SelectTrigger>
        <SelectContent>
          {VM_TIMEZONES.map(([id, label]) => (
            <SelectItem key={id} value={id}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {showCustom ? (
        <div className='flex items-center gap-2'>
          <Input
            autoFocus
            spellCheck={false}
            autoComplete='off'
            placeholder='Asia/Tokyo'
            aria-label='自定义时区'
            disabled={disabled}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          <span className='w-28 shrink-0 text-xs text-muted-foreground'>
            {now || (validTimezone(value) ? '' : '无效时区')}
          </span>
        </div>
      ) : null}
    </div>
  )
}
