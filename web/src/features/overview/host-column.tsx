import type { HostStats } from '@/types/panel-overview'
import { fmtBytes } from '@/lib/format'
import { cn } from '@/lib/utils'

function barColor(p: number): string {
  if (p >= 100) return 'var(--status-bad)'
  if (p >= 95) return 'var(--status-warn)'
  if (p >= 85) return 'var(--status-caution)'
  return 'var(--status-ok)'
}

function HostRow({
  label,
  value,
  valueText,
}: {
  label: string
  value: number
  valueText: string
}) {
  return (
    <div className='flex items-center gap-2.5 text-[11.5px] text-muted-foreground'>
      <span className='w-7 shrink-0'>{label}</span>
      <div className='h-1.5 flex-1 overflow-hidden rounded-full bg-muted'>
        <div
          className='h-full rounded-full transition-[width] duration-200'
          style={{
            width: `${Math.min(100, value)}%`,
            background: barColor(value),
          }}
        />
      </div>
      <b className='w-9 shrink-0 text-right font-medium text-foreground tabular-nums'>
        {valueText}
      </b>
    </div>
  )
}

function relMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  return `${Math.floor(hr / 24)}d`
}

/** 宿主资源列。对齐 index.html 的 `hostCol(host)`。 */
export function HostColumn({ host }: { host: HostStats | undefined }) {
  const h = host || {}
  const cpu = Number(h.cpu_pct || 0)
  const mem = Number(h.mem_pct || 0)
  const heap = h.heap_total ? ((h.heap_used || 0) / h.heap_total) * 100 : 0
  const title = `${h.cpu_count || 0} 核 · load ${h.load1 != null ? Number(h.load1).toFixed(2) : '—'} · ${fmtBytes(h.mem_used)}/${fmtBytes(h.mem_total)} · up ${relMs((h.proc_uptime || 0) * 1000)}`
  return (
    <div
      className='flex w-full shrink-0 flex-col gap-2 border-t pt-3 sm:w-[220px] sm:border-t-0 sm:border-l sm:pt-0 sm:pl-5'
      title={title}
    >
      <HostRow label='CPU' value={cpu} valueText={`${cpu.toFixed(0)}%`} />
      <HostRow label='内存' value={mem} valueText={`${mem.toFixed(0)}%`} />
      {h.memory_pressure && h.memory_pressure.level !== 'ok' ? (
        <div
          className={cn(
            'text-[11px] font-medium',
            h.memory_pressure.level === 'critical'
              ? 'text-[color:var(--status-bad)]'
              : 'text-[color:var(--status-warn)]'
          )}
          title={
            h.memory_pressure.level === 'critical'
              ? '可用内存告急：本机不再接新对话，已有对话照常'
              : '可用内存低于阈值：新对话优先派到其他机器，已有对话照常'
          }
        >
          {h.memory_pressure.level === 'critical' ? '内存告急' : '内存紧张'} ·
          可用 {(h.memory_pressure.ratio * 100).toFixed(0)}%
        </div>
      ) : null}
      <HostRow label='进程' value={heap} valueText={fmtBytes(h.rss)} />
    </div>
  )
}
