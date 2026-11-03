import { Link } from '@tanstack/react-router'
import type { Vm } from '@/types/panel-vm'
import { fmtUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { proxyHostLabel } from '@/lib/vm-status'
import { Button } from '@/components/ui/button'
import { StatusMark } from '@/components/status-mark'
import type { DetailRow } from '@/features/cluster/connection-rows'
import { MachineChip } from '@/features/cluster/machine-table'
import {
  capacityTitle,
  gib,
  gibFloor,
  memoryBytes,
  slotStatusTone,
  type ClusterMachine,
} from '@/features/cluster/model'
import type { SshPanelTab } from '@/features/cluster/ssh-panel'
import { ActiveVmBadge } from '@/features/vm/active-vm-badge'
import { TierBadge } from '@/features/vm/vm-rack-blade'

const DOT: Record<NonNullable<DetailRow['tone']>, string> = {
  ok: 'var(--status-ok)',
  caution: 'var(--status-caution)',
  bad: 'var(--status-bad)',
}

function MachineTabs({
  machines,
  selectedId,
  onSelect,
}: {
  machines: ClusterMachine[]
  selectedId: string
  onSelect: (id: string) => void
}) {
  return (
    <div
      role='tablist'
      className='flex gap-0.5 overflow-x-auto border-b px-2.5 pt-1.5'
    >
      {machines.map((m) => {
        const on = m.id === selectedId
        return (
          <button
            key={m.id}
            type='button'
            role='tab'
            aria-selected={on}
            onClick={() => onSelect(m.id)}
            className={cn(
              '-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 pt-2 pb-2.5 text-[13px] whitespace-nowrap',
              on
                ? 'border-primary font-semibold text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {m.name}
            <span className='field-metric rounded-full bg-muted px-1.5 text-[11px] font-semibold text-muted-foreground'>
              {m.slots.length}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function CapacityBar({ m }: { m: ClusterMachine }) {
  const c = m.capacity
  if (!c) return null
  const pct = (x: number) => `${Math.min(100, (x / c.total) * 100)}%`
  const fit = c.fit
  return (
    <div className='px-4 pb-3' title={capacityTitle(m)}>
      <div className='flex h-2 overflow-hidden rounded-full bg-muted'>
        <span
          className='h-full'
          style={{ width: pct(c.quota), background: 'var(--tier-pro-solid)' }}
        />
        {c.reserve != null ? (
          <span
            className='h-full opacity-55'
            style={{ width: pct(c.reserve), background: 'var(--status-none)' }}
          />
        ) : null}
      </div>
      <div className='mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-muted-foreground'>
        <span className='inline-flex items-center gap-1.5'>
          <i className='inline-block size-2 rounded-[2px] bg-[color:var(--tier-pro-solid)]' />
          槽用满 <b className='field-metric text-foreground'>{gib(c.quota)}G</b>
        </span>
        <span className='inline-flex items-center gap-1.5'>
          <i className='inline-block size-2 rounded-[2px] bg-[color:var(--status-none)] opacity-55' />
          系统{' '}
          <b className='field-metric text-foreground'>
            {c.reserve == null ? '—' : `${gib(c.reserve)}G`}
          </b>
        </span>
        <span className='inline-flex items-center gap-1.5'>
          <i className='inline-block size-2 rounded-[2px] bg-muted' />
          空余{' '}
          <b className='field-metric text-foreground'>
            {c.free == null ? '—' : `${gibFloor(c.free)}G`}
          </b>
        </span>
        <span>
          此刻实际已用{' '}
          <b className='field-metric text-foreground'>{gib(c.used)}G</b>
        </span>
        <span>
          共 <b className='field-metric text-foreground'>{gib(c.total)}G</b>
          {fit == null ? null : fit === 0 ? (
            <span className='text-[color:var(--status-caution)]'>
              {' '}
              · 放不下新的 2G 槽
            </span>
          ) : (
            <>
              {' '}
              · 还能放 <b className='field-metric text-foreground'>{fit}</b> 台
              2G 槽
            </>
          )}
        </span>
      </div>
    </div>
  )
}

const SLOT_GRID =
  'grid-cols-[minmax(150px,1.3fr)_minmax(52px,.5fr)_minmax(44px,.45fr)_minmax(130px,1.3fr)_minmax(130px,1.2fr)_minmax(130px,1.2fr)_minmax(40px,.4fr)_minmax(72px,.7fr)]'

function memText(vm: Vm): string {
  const b = memoryBytes(vm.machine?.memory)
  return b == null ? '—' : `${gib(b, b % 1024 ** 3 === 0 ? 0 : 1)}G`
}

function SlotTable({
  m,
  poolNameOf,
  canManage,
  onCreate,
}: {
  m: ClusterMachine
  poolNameOf: (vmId: string) => string | null
  canManage: boolean
  onCreate: () => void
}) {
  if (!m.slots.length) {
    const fit = m.capacity?.fit
    return (
      <div className='border-t px-4 pt-7 pb-8 text-center text-[13px] text-muted-foreground'>
        这台机器上还没有槽。
        {fit != null ? (
          <>
            按内存还能放约 <b className='field-metric text-foreground'>{fit}</b>{' '}
            台 2G 槽。
          </>
        ) : null}
        {canManage ? (
          <div className='mt-2.5'>
            <Button size='sm' variant='outline' onClick={onCreate}>
              在这台机器上新建槽
            </Button>
          </div>
        ) : null}
      </div>
    )
  }
  return (
    <div className='overflow-x-auto [contain:inline-size]'>
      <div className={cn('grid min-w-[900px] gap-x-3', SLOT_GRID)} role='table'>
        <div
          role='row'
          className='col-span-full grid h-[30px] grid-cols-subgrid items-center border-y bg-muted/30 px-4 text-[11px] font-medium tracking-wide text-muted-foreground/80'
        >
          {[
            '槽位',
            '套餐',
            '内存',
            '账号池',
            '出口',
            '状态',
            '在途',
            '今日',
          ].map((h, i) => (
            <div
              key={h}
              role='columnheader'
              className={i >= 6 ? 'text-right' : undefined}
            >
              {h}
            </div>
          ))}
        </div>
        {m.slots.map((vm) => {
          const proxy = vm.proxy?.label?.trim() || proxyHostLabel(vm.proxy)
          const pool = poolNameOf(vm.id)
          const inflight = Number(vm.inflight) || 0
          const today = Number(vm.today_cost) || 0
          return (
            <div
              key={vm.id}
              role='row'
              className='col-span-full grid h-[38px] grid-cols-subgrid items-center border-b border-border/40 px-4 text-[13px] last:border-b-0 hover:bg-muted/40'
            >
              <div className='flex min-w-0 items-center gap-1.5'>
                <Link
                  to='/vm/$id'
                  params={{ id: vm.id }}
                  className='truncate font-semibold hover:underline'
                  title={
                    vm.email
                      ? `${vm.name || vm.id} · ${vm.email}`
                      : vm.name || vm.id
                  }
                >
                  {vm.name || vm.id}
                </Link>
                <ActiveVmBadge vm={vm} />
              </div>
              <div>
                <TierBadge vm={vm} />
              </div>
              <div className='field-metric font-semibold'>{memText(vm)}</div>
              <div
                className={cn('truncate', !pool && 'text-muted-foreground')}
                title={pool || undefined}
              >
                {pool || '—'}
              </div>
              <div className='truncate text-muted-foreground' title={proxy}>
                {proxy}
              </div>
              <div className='min-w-0 truncate'>
                <StatusMark tone={slotStatusTone(vm)} />
              </div>
              <div
                className={cn(
                  'field-metric text-right',
                  !inflight && 'text-muted-foreground'
                )}
              >
                {inflight}
              </div>
              <div
                className={cn(
                  'field-metric text-right',
                  !today && 'text-muted-foreground'
                )}
              >
                {fmtUsd(today, 2)}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ConnectionDetails({
  rows,
  summary,
  checkedAt,
  error,
}: {
  rows: DetailRow[] | null
  summary: string
  checkedAt: string | null
  error?: string | null
}) {
  return (
    <details className='group border-t'>
      <summary className='flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden'>
        <span className='text-[10px] transition-transform group-open:rotate-90'>
          ▸
        </span>
        连接详情
        {summary ? (
          <span className='truncate text-muted-foreground/80'>· {summary}</span>
        ) : null}
        <span className='flex-1' />
        {checkedAt ? (
          <span className='shrink-0 text-muted-foreground/80'>{checkedAt}</span>
        ) : null}
      </summary>
      {error ? (
        <p className='px-4 pb-3 pl-9 text-xs text-[color:var(--status-bad)]'>
          {error}
        </p>
      ) : !rows ? (
        <p className='px-4 pb-3 pl-9 text-xs text-muted-foreground'>加载中…</p>
      ) : (
        <dl className='grid grid-cols-[92px_1fr] gap-x-3.5 gap-y-1.5 px-4 pb-3.5 pl-9 text-xs'>
          {rows.map((row) => (
            <div key={row.label} className='contents'>
              <dt className='text-muted-foreground'>{row.label}</dt>
              <dd className='min-w-0'>
                <span className='font-mono break-all'>
                  {row.tone ? (
                    <i
                      className='mr-1.5 inline-block size-[7px] rounded-full align-[1px]'
                      style={{ background: DOT[row.tone] }}
                    />
                  ) : null}
                  {row.value}
                </span>
                {row.hint ? (
                  <div className='text-[11px] text-muted-foreground'>
                    {row.hint}
                  </div>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </details>
  )
}

/** 选中那台机器的页：动作、内存余量、它上面的槽、连接详情。 */
export function MachineDetail({
  machines,
  selectedId,
  onSelect,
  poolNameOf,
  canManage,
  localDetails,
  localRefresh,
  onOpenNode,
  onRemove,
  onCreate,
}: {
  machines: ClusterMachine[]
  selectedId: string
  onSelect: (id: string) => void
  poolNameOf: (vmId: string) => string | null
  canManage: boolean
  /** 主控的连接详情；节点的同类信息在「连接设置」面板里，不在这里重复。 */
  localDetails: {
    rows: DetailRow[] | null
    summary: string
    checkedAt: string | null
    error?: string | null
  }
  localRefresh: { pending: boolean; run: () => void }
  onOpenNode: (nodeId: string, tab: SshPanelTab) => void
  onRemove: (m: ClusterMachine) => void
  onCreate: (m: ClusterMachine) => void
}) {
  const m = machines.find((x) => x.id === selectedId) || machines[0]
  if (!m) return null
  return (
    <>
      <MachineTabs machines={machines} selectedId={m.id} onSelect={onSelect} />
      <div className='flex flex-wrap items-center gap-x-2.5 gap-y-2 px-4 py-3'>
        <span className='text-[15px] font-bold'>{m.name}</span>
        <MachineChip role={m.role} />
        <span className='field-host text-xs text-muted-foreground'>
          {m.address}
        </span>
        <StatusMark tone={m.tone} />
        <div className='ms-auto flex items-center gap-1.5'>
          {m.role === 'local' ? (
            <Button
              size='sm'
              variant='ghost'
              className='h-7 px-2.5 text-xs'
              disabled={localRefresh.pending}
              onClick={localRefresh.run}
            >
              {localRefresh.pending ? '观测中…' : '重新观测'}
            </Button>
          ) : canManage && m.remote ? (
            <>
              <Button
                size='sm'
                variant='outline'
                className='h-7 px-2.5 text-xs'
                disabled={m.remote.link.state !== 'ready'}
                onClick={() => onOpenNode(m.id, 'terminal')}
              >
                终端
              </Button>
              {m.remote.platform !== 'darwin' ? (
                <Button
                  size='sm'
                  variant='outline'
                  className='h-7 px-2.5 text-xs'
                  onClick={() => onOpenNode(m.id, 'docker')}
                >
                  Docker
                </Button>
              ) : null}
              <Button
                size='sm'
                variant='outline'
                className='h-7 px-2.5 text-xs'
                onClick={() => onOpenNode(m.id, 'link')}
              >
                连接设置
              </Button>
              <span className='w-2' />
              <Button
                size='sm'
                variant='ghost'
                className='h-7 px-2.5 text-xs text-[color:var(--status-bad)] hover:bg-[color:var(--status-bad-bg)] hover:text-[color:var(--status-bad)]'
                disabled={m.slots.length > 0}
                title={
                  m.slots.length
                    ? `这台上还有 ${m.slots.length} 个槽，先删掉或挪走才能移除`
                    : '断开 SSH、删除本地凭证与 Docker 桥；远端容器保持运行'
                }
                onClick={() => onRemove(m)}
              >
                移除节点
              </Button>
            </>
          ) : null}
        </div>
      </div>
      <CapacityBar m={m} />
      <SlotTable
        m={m}
        poolNameOf={poolNameOf}
        canManage={canManage}
        onCreate={() => onCreate(m)}
      />
      {m.role === 'local' ? <ConnectionDetails {...localDetails} /> : null}
    </>
  )
}
