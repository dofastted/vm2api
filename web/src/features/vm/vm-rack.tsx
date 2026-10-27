import { useMemo } from 'react'
import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import { Plus, Server } from 'lucide-react'
import { fmtNum, fmtUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { FleetGroup } from '@/lib/vm-status'
import { useNow } from '@/hooks/use-now'
import { StatusMark } from '@/components/status-mark'
import { VmBlade, type RackSize } from '@/features/vm/vm-rack-blade'
import {
  buildRacks,
  rackTotals,
  type Rack,
  type VmZoneFilter,
} from '@/features/vm/vm-rack-model'
import { VmUnit } from '@/features/vm/vm-rack-unit'

/** 机架头的构成条按六档细分（吊销与无效分开着色），分区段落才合并。 */
const GROUP_SWATCH: { key: FleetGroup; label: string; color: string }[] = [
  { key: 'pool', label: '在池', color: 'var(--status-ok-solid)' },
  { key: 'restricted', label: '受限', color: 'var(--status-warn-solid)' },
  { key: 'off', label: '关闭调用', color: 'var(--status-none)' },
  {
    key: 'none',
    label: '未使用',
    color: 'color-mix(in oklch, var(--status-none) 55%, transparent)',
  },
  {
    key: 'unschedulable',
    label: '不可调度',
    color:
      'color-mix(in oklch, var(--status-bad-solid) 70%, var(--status-warn-solid))',
  },
  { key: 'bad', label: '无效凭证', color: 'var(--status-bad-solid)' },
  { key: 'revoke', label: '已吊销', color: 'var(--red-4)' },
]

const BLADE_MIN: Record<RackSize, string> = {
  s: '168px',
  m: '300px',
  l: '380px',
}

function RackHeader({
  rack,
  accounts,
}: {
  rack: Rack
  accounts?: UsageAccountRow[]
}) {
  const t = rackTotals(rack.vms, accounts)
  const groups = GROUP_SWATCH.filter((g) => t.groups[g.key] > 0)
  return (
    <header className='grid items-center gap-x-6 gap-y-2.5 border-b border-[color:var(--hairline)] px-4 py-3 md:grid-cols-[minmax(160px,auto)_minmax(200px,1fr)] xl:grid-cols-[minmax(180px,auto)_minmax(220px,1fr)_auto]'>
      <div className='grid gap-0.5'>
        <h2 className='m-0 flex items-center gap-2 text-sm font-[620] tracking-[-0.01em]'>
          <Server className='size-4 text-muted-foreground' aria-hidden='true' />
          {rack.label}
        </h2>
        <span className='ps-6 font-mono text-[11.5px] text-[color:var(--text-tertiary)]'>
          {rack.nodeId ? rack.nodeId : '控制面本机'}
        </span>
      </div>
      <div className='grid min-w-0 gap-1.5'>
        <div className='flex h-2 gap-0.5 overflow-hidden rounded-[3px]'>
          {groups.map((g) => (
            <i
              key={g.key}
              title={`${g.label} ${t.groups[g.key]}`}
              className='min-w-1'
              style={{
                flexGrow: t.groups[g.key],
                flexBasis: 0,
                backgroundColor: g.color,
              }}
            />
          ))}
        </div>
        <div className='flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-muted-foreground'>
          {groups.map((g) => (
            <span key={g.key} className='inline-flex items-center gap-1.5'>
              <span
                aria-hidden='true'
                className='size-[7px] rounded-[2px]'
                style={{ backgroundColor: g.color }}
              />
              {g.label}
              <b className='font-semibold text-foreground tabular-nums'>
                {t.groups[g.key]}
              </b>
            </span>
          ))}
        </div>
      </div>
      <dl className='m-0 flex gap-5 md:col-span-2 xl:col-span-1'>
        {t.seatsMax > 0 ? (
          <div className='grid min-w-16 gap-0.5'>
            <dt className='text-[11.5px] text-muted-foreground'>席位</dt>
            <dd className='m-0 text-[15px] font-[620] tracking-[-0.015em] tabular-nums'>
              {t.seatsUsed}/{t.seatsMax}
            </dd>
            <dd className='m-0 mt-0.5 h-1 overflow-hidden rounded-full bg-[color:var(--track)]'>
              <i
                className='block h-full rounded-full bg-[color:var(--status-ok-solid)]'
                style={{ width: `${(t.seatsUsed / t.seatsMax) * 100}%` }}
              />
            </dd>
          </div>
        ) : null}
        {t.ledger.map((r) => (
          <div key={r.key} className='grid min-w-16 gap-0.5'>
            <dt className='text-[11.5px] text-muted-foreground'>{r.label}</dt>
            <dd className='m-0 text-[15px] font-[620] tracking-[-0.015em] tabular-nums'>
              {fmtUsd(r.cost, r.cost >= 100 ? 0 : 2)}
            </dd>
            <dd className='m-0 font-mono text-[11px] text-[color:var(--text-tertiary)] tabular-nums'>
              {fmtNum(r.tokens)} tok
            </dd>
          </div>
        ))}
      </dl>
    </header>
  )
}

/**
 * 机架地图。服务器是一级结构，状态分区是二级结构；三档尺寸共用同一套分段。
 * 入参 `vms` 已经过搜索、平台筛选与排序；`filter` 是顶部分区条的选择，
 * 机架头只统计筛选后可见的槽位。
 */
export function VmRack({
  vms,
  accounts,
  filter,
  size,
  onCreate,
}: {
  vms: Vm[]
  accounts?: UsageAccountRow[]
  filter: VmZoneFilter
  size: RackSize
  onCreate?: () => void
}) {
  // 倒计时精度到分钟即可；整个机架共用一个时钟，不在每块刀片各起计时器。
  const now = useNow(60_000)
  const racks = useMemo(() => buildRacks(vms, filter), [vms, filter])
  return (
    <div className='grid gap-3.5'>
      {racks.map((rack) => (
        <section
          key={rack.nodeId ?? 'local'}
          aria-label={rack.label}
          className='rounded-xl border bg-card'
        >
          <RackHeader rack={rack} accounts={accounts} />
          {rack.zones.map(({ zone, vms: zoneVms }) => (
            <div
              key={zone.key}
              className='border-[color:var(--hairline)] [&+&]:border-t'
            >
              <div className='flex items-center gap-2 px-4 pt-2.5 text-[12.5px]'>
                <StatusMark
                  tone={{
                    cls: zone.tone,
                    key: zone.key,
                    label: zone.label,
                    text: zone.label,
                  }}
                  className='font-semibold'
                />
                <span className='font-mono text-xs font-semibold text-muted-foreground tabular-nums'>
                  {zoneVms.length}
                </span>
                <span className='hidden text-[11.5px] text-[color:var(--text-tertiary)] md:inline'>
                  {zone.hint}
                </span>
                <span
                  aria-hidden='true'
                  className='ms-1 h-px flex-1'
                  style={{
                    background: `linear-gradient(to right, color-mix(in oklch, ${zone.color} 45%, transparent), transparent 70%)`,
                  }}
                />
              </div>
              <div
                className='grid gap-2 p-2 sm:px-3 sm:pt-2.5 sm:pb-3'
                style={{
                  gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${BLADE_MIN[size]}), 1fr))`,
                }}
              >
                {zoneVms.map((vm) =>
                  size === 's' ? (
                    <VmUnit key={vm.id} vm={vm} accounts={accounts} now={now} />
                  ) : (
                    <VmBlade
                      key={vm.id}
                      vm={vm}
                      accounts={accounts}
                      size={size}
                      now={now}
                    />
                  )
                )}
              </div>
            </div>
          ))}
          {onCreate ? (
            <div className='flex justify-end px-4 pb-3'>
              <button
                type='button'
                onClick={onCreate}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-lg border border-dashed px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'
                )}
              >
                <Plus className='size-3.5' aria-hidden='true' />
                创建槽位
              </button>
            </div>
          ) : null}
        </section>
      ))}
    </div>
  )
}
