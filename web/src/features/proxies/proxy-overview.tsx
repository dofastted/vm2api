import { useMemo } from 'react'
import type { Vm, VmProxySnap } from '@/types/panel-vm'
import { cn } from '@/lib/utils'
import {
  type ProxyHover,
  useProxyHoverId,
  useProxyHovered,
} from './proxy-hover'
import { ProxyPanel } from './proxy-panel'
import {
  PROXY_HEALTH_KEYS,
  PROXY_HEALTH_LABEL,
  type ProxyFilter,
  proxyBindLimit,
  proxyBindable,
  proxyBoundIds,
  proxyHealthKey,
  proxyHostText,
  proxyInFilter,
} from './proxy-sort'
import { PROXY_HEALTH_SOLID } from './proxy-tone'
import { VmChip } from './vm-chip'

/**
 * 席位图：一条代理一列，一列的格数就是它的绑定上限，已绑的格子按代理健康着色、
 * 自底向上填。整池「还剩多少位 · 哪些代理快满了 · 满的里面有没有坏的」一张图看完。
 *
 * 列和右侧列表行双向联动：悬停任一边，另一边跟着亮；点列直接滚到那一行。
 * 下方「待接代理」列出池外的槽位，可以直接拖到右侧代理行上绑定。
 */
export function ProxyOverview({
  proxies,
  vms,
  ownerOf,
  poolLimit,
  slotsUsed,
  slotsCap,
  filter,
  onFilter,
  hover,
  onLocate,
  onVmDragChange,
}: {
  /** 已排序的全集（不受筛选影响，保证图形稳定）。 */
  proxies: VmProxySnap[]
  vms: Vm[]
  ownerOf: Map<string, VmProxySnap>
  poolLimit: number
  slotsUsed: number
  slotsCap: number
  filter: ProxyFilter
  onFilter: (next: ProxyFilter) => void
  hover: ProxyHover
  onLocate: (id: string) => void
  onVmDragChange: (vmId: string) => void
}) {
  const counts = useMemo(() => {
    const out = Object.fromEntries(
      PROXY_HEALTH_KEYS.map((k) => [k, 0])
    ) as Record<(typeof PROXY_HEALTH_KEYS)[number], number>
    for (const p of proxies) out[proxyHealthKey(p)] += 1
    return out
  }, [proxies])
  const byId = useMemo(
    () => new Map(proxies.map((p) => [p.id || '', p])),
    [proxies]
  )
  const loose = vms.filter((v) => !ownerOf.has(v.id))
  const stranded = loose.filter((v) => v.has_token).length
  const freeSeats = proxies.reduce((n, p) => {
    if (!proxyBindable(p)) return n
    return (
      n + Math.max(0, proxyBindLimit(p, poolLimit) - proxyBoundIds(p).length)
    )
  }, 0)
  const colHeight = proxies.length <= 24 ? 64 : proxies.length <= 60 ? 44 : 28

  return (
    <ProxyPanel
      title='席位'
      meta={
        <span className='text-xs text-muted-foreground tabular-nums'>
          <span className='text-base font-[620] tracking-[-0.02em] text-foreground'>
            {slotsUsed}
          </span>{' '}
          / {slotsCap || '—'} 已绑
        </span>
      }
    >
      {proxies.length ? (
        <>
          <p className='sr-only'>
            共 {proxies.length} 条代理，已绑 {slotsUsed} 个席位，空余{' '}
            {freeSeats} 个。
          </p>
          <div
            className='grid gap-[3px]'
            style={{
              gridTemplateColumns: 'repeat(auto-fill, minmax(11px, 1fr))',
            }}
          >
            {proxies.map((p, i) => (
              <SeatColumn
                key={p.id}
                proxy={p}
                limit={proxyBindLimit(p, poolLimit)}
                height={colHeight}
                order={i}
                dim={filter !== 'all' && !proxyInFilter(p, filter, poolLimit)}
                hover={hover}
                onLocate={onLocate}
              />
            ))}
          </div>
          <SeatReadout hover={hover} byId={byId} poolLimit={poolLimit} />
          <div className='-mx-1 mt-1 flex flex-wrap gap-0.5'>
            {PROXY_HEALTH_KEYS.map((k) => (
              <button
                key={k}
                type='button'
                aria-pressed={filter === k}
                onClick={() => onFilter(filter === k ? 'all' : k)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-accent/60',
                  filter === k
                    ? 'bg-accent/70 font-medium text-foreground'
                    : 'text-muted-foreground',
                  !counts[k] && filter !== k && 'opacity-45'
                )}
              >
                <span
                  aria-hidden='true'
                  className='size-2 shrink-0 rounded-[2px]'
                  style={{ backgroundColor: PROXY_HEALTH_SOLID[k] }}
                />
                {PROXY_HEALTH_LABEL[k]}
                <span className='font-medium tabular-nums'>{counts[k]}</span>
              </button>
            ))}
          </div>
          <dl className='mt-3 grid grid-cols-3 gap-px overflow-hidden rounded-lg border bg-border/60 text-center'>
            <Figure label='空余席位' value={freeSeats} />
            <Figure label='代理' value={proxies.length} />
            <Figure
              label='池外槽位'
              value={loose.length}
              tone={stranded ? 'bad' : undefined}
            />
          </dl>
        </>
      ) : (
        <p className='text-xs text-muted-foreground'>
          池里还没有代理。导入后每条代理在这里占一列，格子数即它的绑定上限。
        </p>
      )}

      {loose.length ? (
        <div className='mt-4'>
          <div className='mb-1.5 flex items-baseline justify-between gap-2'>
            <h4 className='text-xs font-medium'>待接代理</h4>
            {stranded ? (
              <span className='text-[11px] text-[color:var(--status-bad)]'>
                {stranded} 台有凭证，出站被拒
              </span>
            ) : null}
          </div>
          <div className='flex max-h-28 flex-wrap gap-1 overflow-y-auto'>
            {loose.map((v) => (
              <VmChip
                key={v.id}
                vm={v}
                tone={v.has_token ? 'bad' : 'none'}
                onDragChange={onVmDragChange}
              />
            ))}
          </div>
          {proxies.length ? (
            <p className='mt-1.5 text-[11px] text-muted-foreground'>
              拖到右侧代理行上即可绑定；已绑的槽位也能拖去换绑。
            </p>
          ) : null}
        </div>
      ) : vms.length ? (
        <p className='mt-3 text-[11px] text-muted-foreground'>
          {vms.length} 台槽位都已接代理。
        </p>
      ) : null}
    </ProxyPanel>
  )
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: 'bad'
}) {
  return (
    <div className='bg-card px-2 py-2'>
      <dt className='text-[11px] text-muted-foreground'>{label}</dt>
      <dd
        className={cn(
          'mt-0.5 text-lg leading-none font-[620] tracking-[-0.02em] tabular-nums',
          tone === 'bad' && 'text-[color:var(--status-bad)]'
        )}
      >
        {value}
      </dd>
    </div>
  )
}

function SeatColumn({
  proxy,
  limit,
  height,
  order,
  dim,
  hover,
  onLocate,
}: {
  proxy: VmProxySnap
  limit: number
  height: number
  order: number
  dim: boolean
  hover: ProxyHover
  onLocate: (id: string) => void
}) {
  const id = proxy.id || ''
  const lit = useProxyHovered(hover, id)
  const used = proxyBoundIds(proxy).length
  const color = PROXY_HEALTH_SOLID[proxyHealthKey(proxy)]
  const delay = { animationDelay: `${Math.min(order, 40) * 14}ms` }
  // 上限很高时单格会细到看不清，改成连续填充；数字仍在读数行里。
  const discrete = limit <= 10
  return (
    <button
      type='button'
      tabIndex={-1}
      aria-hidden='true'
      onMouseEnter={() => hover.set(id)}
      onMouseLeave={() => hover.set('')}
      onClick={() => onLocate(id)}
      className={cn(
        'flex flex-col-reverse gap-[2px] rounded-[3px] p-px outline-offset-1 transition-opacity duration-200',
        lit && 'outline-2 outline-primary',
        dim && !lit && 'opacity-25'
      )}
      style={{ height }}
    >
      {discrete ? (
        Array.from({ length: limit }).map((_, i) => (
          <span
            key={i}
            className={cn(
              'w-full flex-1 rounded-[2px]',
              i < used ? 'animate-seat-rise' : 'track-recessed'
            )}
            style={i < used ? { backgroundColor: color, ...delay } : undefined}
          />
        ))
      ) : (
        <span className='relative w-full flex-1 overflow-hidden rounded-[2px] track-recessed'>
          <span
            className='animate-seat-rise absolute inset-x-0 bottom-0 rounded-[2px]'
            style={{
              height: `${Math.min(100, (used / limit) * 100)}%`,
              backgroundColor: color,
              ...delay,
            }}
          />
        </span>
      )}
    </button>
  )
}

/** 悬停读数：一行文字代替几百个 tooltip。 */
function SeatReadout({
  hover,
  byId,
  poolLimit,
}: {
  hover: ProxyHover
  byId: Map<string, VmProxySnap>
  poolLimit: number
}) {
  const id = useProxyHoverId(hover)
  const p = id ? byId.get(id) : undefined
  return (
    <div className='mt-2 flex h-5 items-center gap-2 text-[11px] text-muted-foreground'>
      {p ? (
        <>
          <span
            aria-hidden='true'
            className='size-2 shrink-0 rounded-[2px]'
            style={{ backgroundColor: PROXY_HEALTH_SOLID[proxyHealthKey(p)] }}
          />
          <span className='field-host truncate text-foreground'>
            {proxyHostText(p)}
          </span>
          <span className='shrink-0 tabular-nums'>
            {proxyBoundIds(p).length}/{proxyBindLimit(p, poolLimit)}
          </span>
          <span className='shrink-0'>
            {PROXY_HEALTH_LABEL[proxyHealthKey(p)]}
          </span>
          {p.latency_ms != null ? (
            <span className='shrink-0 tabular-nums'>{p.latency_ms}ms</span>
          ) : null}
        </>
      ) : (
        <span>悬停查看，点击定位到列表</span>
      )}
    </div>
  )
}
