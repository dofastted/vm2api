import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  formatTtlLabel,
  secondsToTtlParts,
  TTL_UNIT_LABELS,
  ttlPartsToSeconds,
  type TtlUnit,
} from './pool-rules'

export function TtlDurationInput({
  id,
  seconds,
  minSeconds,
  maxSeconds,
  preferredUnit,
  presets,
  disabled,
  onChange,
}: {
  id?: string
  seconds: number
  minSeconds: number
  maxSeconds: number
  preferredUnit?: TtlUnit
  presets?: number[]
  disabled?: boolean
  onChange: (nextSeconds: number) => void
}) {
  const initial = secondsToTtlParts(seconds, preferredUnit)
  const [unit, setUnit] = useState<TtlUnit>(initial.unit)
  const [numStr, setNumStr] = useState(String(initial.value))

  useEffect(() => {
    const parts = secondsToTtlParts(seconds, preferredUnit)
    setUnit(parts.unit)
    setNumStr(String(parts.value))
  }, [seconds, preferredUnit])

  const commit = (rawVal: string, nextUnit: TtlUnit) => {
    const parsed = Number(rawVal)
    if (!Number.isFinite(parsed) || parsed <= 0) return
    const nextSec = ttlPartsToSeconds(parsed, nextUnit)
    const clamped = Math.min(maxSeconds, Math.max(minSeconds, nextSec))
    onChange(clamped)
  }

  return (
    <div className='space-y-1.5'>
      <div className='flex items-center gap-2'>
        <Input
          id={id}
          type='number'
          min={1}
          step={1}
          disabled={disabled}
          value={numStr}
          className='w-28 font-mono tabular-nums'
          onChange={(e) => {
            setNumStr(e.target.value)
            commit(e.target.value, unit)
          }}
        />
        <Select
          value={unit}
          disabled={disabled}
          onValueChange={(next) => {
            const u = next as TtlUnit
            setUnit(u)
            commit(numStr, u)
          }}
        >
          <SelectTrigger className='w-24' aria-label='时间单位'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='minutes'>{TTL_UNIT_LABELS.minutes}</SelectItem>
            <SelectItem value='hours'>{TTL_UNIT_LABELS.hours}</SelectItem>
            <SelectItem value='days'>{TTL_UNIT_LABELS.days}</SelectItem>
          </SelectContent>
        </Select>
        <span className='text-xs text-muted-foreground tabular-nums'>
          = {seconds.toLocaleString()} 秒（{formatTtlLabel(seconds)}）
        </span>
      </div>
      {presets?.length ? (
        <div className='flex flex-wrap gap-1'>
          {presets.map((preset) => (
            <button
              key={preset}
              type='button'
              disabled={disabled}
              onClick={() => onChange(preset)}
              className={`cursor-pointer rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                seconds === preset
                  ? 'border-primary bg-primary/10 font-medium text-primary'
                  : 'border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground'
              }`}
            >
              {formatTtlLabel(preset)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
