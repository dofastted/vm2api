import type { Dashboard } from '@/types/panel-overview'
import type { Vm } from '@/types/panel-vm'
import {
  expiresAtToMs,
  fableCap,
  fableCardInfo,
  fmtReset,
  fmtResetClock,
  resetCountdown,
  statusColorForPct,
} from '@/lib/fable-status'
import { fmtUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'

export function Field({
  label,
  children,
  compact = false,
}: {
  label: string
  children: React.ReactNode
  compact?: boolean
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-[6.5rem_1fr] items-start gap-x-3 text-sm',
        compact ? 'py-1' : 'py-1.5'
      )}
    >
      <div className='text-muted-foreground'>{label}</div>
      <div className='min-w-0 break-all'>{children}</div>
    </div>
  )
}

/** 用量/剩余条。颜色只在异常档出现，健康填充走主色；`gate` 画出配额闸线。 */
export function Meter({
  label,
  value,
  hint,
  kind = 'used',
  gate,
}: {
  label: string
  value: number
  hint?: string
  kind?: 'used' | 'remain'
  /** 闸线百分比（0–100），到这里写成受限并切号。 */
  gate?: number
}) {
  const p = Math.max(0, Math.min(100, Number(value) || 0))
  const anomaly =
    kind === 'remain'
      ? p <= 15
        ? 'bad'
        : p <= 30
          ? 'caution'
          : null
      : p >= 100
        ? 'bad'
        : p >= 95
          ? 'warn'
          : p >= 85
            ? 'caution'
            : null
  const bar =
    anomaly === 'bad'
      ? 'bg-[color:var(--status-bad)]'
      : anomaly === 'warn'
        ? 'bg-[color:var(--status-warn)]'
        : anomaly === 'caution'
          ? 'bg-[color:var(--status-caution)]'
          : 'bg-primary'
  return (
    <div className='space-y-1'>
      <div className='flex items-baseline justify-between gap-2'>
        <span className='text-xs text-muted-foreground'>{label}</span>
        <span className='text-sm font-semibold tabular-nums'>
          {p.toFixed(0)}%
          {gate != null ? (
            <span className='ml-1 text-[11px] font-normal text-muted-foreground'>
              / 闸 {Math.round(gate)}%
            </span>
          ) : null}
        </span>
      </div>
      <div className='relative'>
        <Progress value={p} className='h-1.5' indicatorClassName={bar} />
        {gate != null ? (
          <span
            aria-hidden
            title={`闸线 ${Math.round(gate)}%`}
            className='absolute -top-0.5 h-2.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground/80'
            style={{ left: `${Math.max(0, Math.min(100, gate))}%` }}
          />
        ) : null}
      </div>
      {hint ? (
        <p className='text-[11px] leading-4 text-muted-foreground'>{hint}</p>
      ) : null}
    </div>
  )
}

export function quotaWindowHint(
  usedPct: number,
  resetAt: unknown,
  now: number
): string {
  const remain = Math.max(0, Math.min(100, 100 - (Number(usedPct) || 0)))
  const bits = [`剩余 ${remain.toFixed(0)}%`]
  const clock = fmtResetClock(resetAt)
  const cd = resetCountdown(resetAt, now)
  if (clock) bits.push(`重置 ${clock}`)
  if (cd) bits.push(cd)
  return bits.join(' · ')
}

/** 重置时刻：绝对时间 + 分钟精度倒计时。后端给的是秒级 epoch 串，
    `fmtExpiresAt` 解析不了会回显原始数字，这里走 `expiresAtToMs`。 */
export function ResetAt({ value, now }: { value: unknown; now: number }) {
  const at = expiresAtToMs(value)
  const cd = resetCountdown(value, now)
  if (!at) return <span>{value ? String(value) : '—'}</span>
  return (
    <span className='tabular-nums'>
      {new Date(at).toLocaleString()}
      {cd ? <span className='ml-1.5 text-muted-foreground'>· {cd}</span> : null}
    </span>
  )
}

export function UtilCard({
  label,
  value,
  hint,
}: {
  label: string
  value: number
  hint?: string
}) {
  const tone =
    value >= 100
      ? 'bg-destructive'
      : value >= 85
        ? 'bg-amber-500'
        : 'bg-primary'
  return (
    <Card>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm font-medium text-muted-foreground'>
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className='space-y-2'>
        <div className='text-2xl font-semibold tabular-nums'>
          {value.toFixed(0)}%
        </div>
        <Progress
          value={Math.min(100, value)}
          className='h-1.5'
          indicatorClassName={tone}
        />
        {hint ? <p className='text-xs text-muted-foreground'>{hint}</p> : null}
      </CardContent>
    </Card>
  )
}

export function MoneyCard({
  label,
  amount,
  hint,
}: {
  label: string
  amount: number
  hint?: string
}) {
  return (
    <Card>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm font-medium text-muted-foreground'>
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className='space-y-2'>
        <div className='text-2xl font-semibold text-[color:var(--status-ok)] tabular-nums'>
          {fmtUsd(amount, 2)}
        </div>
        <p className='text-xs text-muted-foreground'>{hint || '官方价'}</p>
      </CardContent>
    </Card>
  )
}

/** Fable 配额小卡片。`usedPct` 非空画进度条，为空画徽标。对齐 index.html 的 `vdFableStat`/`fableCard`。 */
export function FableCard({
  vm,
  dashRouting,
}: {
  vm: Vm
  dashRouting: Dashboard | undefined
}) {
  const info = fableCardInfo(vm, fableCap(dashRouting))
  return (
    <Card>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm font-medium text-muted-foreground'>
          Fable
        </CardTitle>
      </CardHeader>
      <CardContent className='space-y-2'>
        {info.usedPct != null ? (
          <>
            <div
              className='text-2xl font-semibold tabular-nums'
              style={{ color: statusColorForPct(info.usedPct) }}
            >
              {Math.max(0, 100 - info.usedPct).toFixed(0)}%
            </div>
            <Progress
              value={Math.min(100, info.usedPct)}
              className='h-1.5'
              indicatorClassName='bg-primary'
            />
          </>
        ) : (
          <div className='text-lg font-semibold'>{info.badgeText}</div>
        )}
        <p className='text-xs text-muted-foreground'>
          {info.usedPct != null
            ? `用 ${info.usedPct.toFixed(1)}%${info.reset ? ' · ' + fmtReset(info.reset) : ''}`
            : info.bits.join(' · ')}
        </p>
      </CardContent>
    </Card>
  )
}
