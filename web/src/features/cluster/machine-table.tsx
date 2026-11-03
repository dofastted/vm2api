import { fmtUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { StatusMark } from '@/components/status-mark'
import {
  capacityTitle,
  gib,
  gibFloor,
  HOT_PCT,
  meterColor,
  tierSummary,
  type ClusterMachine,
  type Meter,
} from '@/features/cluster/model'

function MeterCell({
  pct,
  sub,
  title,
}: {
  pct: number
  sub: string
  title?: string
}) {
  const hot = pct >= HOT_PCT
  return (
    <div className='min-w-0' title={title}>
      <div className='flex items-center gap-2'>
        <span className='h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-muted'>
          <span
            className='block h-full rounded-full'
            style={{
              width: `${Math.min(100, pct)}%`,
              background: meterColor(pct),
            }}
          />
        </span>
        <span
          className='field-metric text-[13px] font-semibold'
          style={hot ? { color: meterColor(pct) } : undefined}
        >
          {Math.round(pct)}%
        </span>
      </div>
      <div className='field-metric mt-0.5 truncate text-[11px] text-muted-foreground'>
        {sub}
      </div>
    </div>
  )
}

function Dash({ sub }: { sub?: string }) {
  return (
    <div>
      <span className='field-metric text-[13px] text-muted-foreground'>—</span>
      {sub ? (
        <div className='mt-0.5 text-[11px] text-muted-foreground'>{sub}</div>
      ) : null}
    </div>
  )
}

function memSub(m: Meter): string {
  return `${gib(m.used)} / ${gib(m.total)}G`
}

function diskSub(m: Meter): string {
  return `${gib(m.used, 0)} / ${gib(m.total, 0)}G`
}

export function MachineChip({ role }: { role: ClusterMachine['role'] }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-[5px] border px-1.5 py-0.5 text-[10px] leading-none font-semibold tracking-[0.03em]',
        role === 'remote'
          ? 'border-primary/40 text-foreground'
          : 'border-border/70 text-muted-foreground'
      )}
    >
      {role === 'local' ? '本机' : '节点'}
    </span>
  )
}

const GRID =
  'grid-cols-[minmax(150px,1.35fr)_minmax(160px,1.35fr)_minmax(104px,1fr)_minmax(116px,1.15fr)_minmax(108px,1.05fr)_minmax(76px,.8fr)_minmax(76px,.9fr)_minmax(80px,.8fr)]'

/** 每台机器一行，本机和节点同一口径；点一行切到下面那台的页签。 */
export function MachineTable({
  machines,
  selectedId,
  onSelect,
}: {
  machines: ClusterMachine[]
  selectedId: string
  onSelect: (id: string) => void
}) {
  return (
    <div className='overflow-x-auto [contain:inline-size]'>
      <div className={cn('grid min-w-[980px] gap-x-3', GRID)} role='table'>
        <div
          className='col-span-full grid h-8 grid-cols-subgrid items-center border-b bg-muted/30 px-4 text-[11px] font-medium tracking-wide text-muted-foreground/80'
          role='row'
        >
          {[
            '机器',
            '连接',
            '负载',
            '内存',
            '磁盘',
            '槽位',
            '还能放',
            '今日',
          ].map((h, i) => (
            <div
              key={h}
              role='columnheader'
              className={i === 7 ? 'text-right' : undefined}
            >
              {h}
            </div>
          ))}
        </div>
        {machines.map((m) => {
          const sel = m.id === selectedId
          const fit = m.capacity?.fit
          return (
            <div
              key={m.id}
              role='row'
              tabIndex={0}
              aria-selected={sel}
              onClick={() => onSelect(m.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect(m.id)
                }
              }}
              className={cn(
                'relative col-span-full grid cursor-pointer grid-cols-subgrid items-center border-b border-border/40 px-4 py-2 last:border-b-0 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
                sel &&
                  'bg-accent/50 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary hover:bg-accent/60'
              )}
            >
              <div className='min-w-0'>
                <div className='flex min-w-0 items-center gap-1.5'>
                  <span
                    className='truncate text-[13px] font-semibold'
                    title={m.remote?.label || m.name}
                  >
                    {m.name}
                  </span>
                  <MachineChip role={m.role} />
                </div>
                <div className='field-host mt-0.5 truncate text-[11px] text-muted-foreground'>
                  {m.address}
                </div>
              </div>
              <div className='min-w-0'>
                <StatusMark tone={m.tone} />
                <div
                  className='field-metric mt-0.5 truncate text-[11px] text-muted-foreground'
                  title={m.linkSub}
                >
                  {m.linkSub}
                </div>
              </div>
              {m.cpu ? (
                <MeterCell
                  pct={m.cpu.pct}
                  sub={`${m.cpu.cores} 核 · load ${m.cpu.load[0].toFixed(2)}`}
                  title={`load ${m.cpu.load.map((n) => (n == null ? '—' : n.toFixed(2))).join(' / ')}（1 / 5 / 15 分钟）`}
                />
              ) : (
                <Dash />
              )}
              {m.mem ? (
                <MeterCell
                  pct={m.mem.pct}
                  sub={memSub(m.mem)}
                  title='实际用量（不含可回收缓存）'
                />
              ) : (
                <Dash />
              )}
              {m.disk ? (
                <MeterCell
                  pct={m.disk.pct}
                  sub={diskSub(m.disk)}
                  title={m.role === 'local' ? '数据目录所在磁盘' : '根分区'}
                />
              ) : (
                <Dash sub={m.cpu ? '没读到' : undefined} />
              )}
              <div>
                <span className='field-metric text-[13px] font-semibold'>
                  {m.slots.length}
                </span>
                <div className='mt-0.5 truncate text-[11px] text-muted-foreground'>
                  {tierSummary(m.slots)}
                </div>
              </div>
              {fit == null ? (
                <Dash />
              ) : (
                <div title={capacityTitle(m)}>
                  <span
                    className={cn(
                      'field-metric text-[13px] font-semibold',
                      fit === 0 && 'text-[color:var(--status-caution)]'
                    )}
                  >
                    {fit === 0 ? '满' : `${fit} 台`}
                  </span>
                  <div className='field-metric mt-0.5 text-[11px] text-muted-foreground'>
                    剩 {gibFloor(m.capacity?.free)}G
                  </div>
                </div>
              )}
              <div className='text-right'>
                <span
                  className={cn(
                    'field-metric text-[13px] font-semibold',
                    !m.todayUsd && 'text-muted-foreground'
                  )}
                >
                  {fmtUsd(m.todayUsd, 2)}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
