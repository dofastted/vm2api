import { useState } from 'react'
import type { Vm, VmProxySnap } from '@/types/panel-vm'
import {
  Activity,
  Copy,
  Ellipsis,
  Globe,
  Lock,
  Pencil,
  Power,
  PowerOff,
  Trash2,
} from 'lucide-react'
import { fmtAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { StatusMark } from '@/components/status-mark'
import { ProxyBindPicker } from './proxy-bind-picker'
import { type ProxyHover, useProxyHovered } from './proxy-hover'
import { SeatCells, SeatCount } from './proxy-seats'
import {
  proxyBindLimit,
  proxyBindable,
  proxyBoundIds,
  proxyHealthKey,
  proxyHostText,
  proxyIsInvalid,
  proxyIsLocal,
} from './proxy-sort'
import {
  PROXY_HEALTH_SOLID,
  proxyFieldClass,
  proxyLatencyTone,
  proxySignalBars,
  proxyStatusTone,
} from './proxy-tone'
import { VM_DRAG_TYPE, VmChip } from './vm-chip'

export type ProxyRowActions = {
  onProbe: (id: string) => void
  onGeo: (id: string) => void
  onCopy: (id: string) => void
  onEdit: (id: string) => void
  onToggleEnabled: (proxy: VmProxySnap) => void
  onDelete: (id: string) => void
  onBind: (id: string, vmId: string) => void
  onUnbind: (id: string, vmId: string) => void
  onVmDragChange: (vmId: string) => void
}

/** 各类进行中的请求落在哪一行，用于行内转圈而不是整表禁用。 */
export type ProxyRowPending = {
  probe: string
  geo: string
  copy: string
  toggle: string
  /** 绑定 / 解绑会重载槽位，进行中时全表的绑定入口一起锁住，避免同一槽位并发换绑。 */
  binding: boolean
}

export function ProxyRow({
  proxy,
  vms,
  vmById,
  ownerOf,
  poolLimit,
  hover,
  dragVm,
  pending,
  actions,
}: {
  proxy: VmProxySnap
  vms: Vm[]
  vmById: Map<string, Vm>
  ownerOf: Map<string, VmProxySnap>
  poolLimit: number
  hover: ProxyHover
  /** 正在被拖动的槽位 id，空串表示没有拖动。 */
  dragVm: string
  pending: ProxyRowPending
  actions: ProxyRowActions
}) {
  const id = proxy.id || ''
  const lit = useProxyHovered(hover, id)
  const [over, setOver] = useState(false)
  const ids = proxyBoundIds(proxy)
  const limit = proxyBindLimit(proxy, poolLimit)
  const health = proxyHealthKey(proxy)
  const dead = proxyIsInvalid(proxy) && !proxy.blocked_reason
  const local = proxyIsLocal(proxy)
  const bindable = proxyBindable(proxy)
  const free = Math.max(0, limit - ids.length)
  const accepts =
    !!dragVm &&
    bindable &&
    free > 0 &&
    !ids.includes(dragVm) &&
    !pending.binding
  const alreadyHere = !!dragVm && ids.includes(dragVm)

  return (
    <li
      id={`proxy-row-${id}`}
      onMouseEnter={() => hover.set(id)}
      onMouseLeave={() => hover.set('')}
      onDragOver={(e) => {
        if (!accepts || !e.dataTransfer.types.includes(VM_DRAG_TYPE)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (!over) setOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOver(false)
        }
      }}
      onDrop={(e) => {
        setOver(false)
        const vmId = e.dataTransfer.getData(VM_DRAG_TYPE)
        if (!accepts || !vmId) return
        e.preventDefault()
        actions.onBind(id, vmId)
      }}
      className={cn(
        'relative flex flex-wrap items-start gap-x-5 gap-y-3 px-4 py-3.5 transition-[background-color,opacity,box-shadow] duration-200',
        dead && 'bg-red-1/60',
        lit && !dragVm && 'bg-accent/40',
        dragVm && !accepts && !alreadyHere && 'opacity-40',
        accepts &&
          'shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--primary)_35%,transparent)]',
        over && 'bg-primary/8 shadow-[inset_0_0_0_2px_var(--primary)]'
      )}
    >
      <span
        aria-hidden='true'
        className={cn(
          'absolute inset-y-3 left-0 w-[3px] rounded-e-full transition-opacity duration-200',
          lit || over ? 'opacity-100' : 'opacity-0'
        )}
        style={{
          backgroundColor: over ? 'var(--primary)' : PROXY_HEALTH_SOLID[health],
        }}
      />

      <div className='min-w-[210px] flex-[1.25] space-y-1'>
        <div className='flex items-center gap-1.5'>
          <span
            className={cn(
              'field-host truncate text-[13px] font-medium',
              local && 'font-sans'
            )}
            title={proxyHostText(proxy)}
          >
            {proxyHostText(proxy)}
          </span>
          {proxy.address_family === 6 ? (
            <span className='shrink-0 text-xs text-muted-foreground'>IPv6</span>
          ) : null}
          {proxy.has_auth ? (
            <Lock
              className='size-3 shrink-0 text-muted-foreground'
              aria-label='已配账密'
            />
          ) : null}
        </div>
        <div className='flex min-w-0 items-center gap-2'>
          <StatusMark tone={proxyStatusTone(proxy)} />
          <GeoLine proxy={proxy} />
        </div>
        {proxy.last_error && !proxy.blocked_reason ? (
          <p
            className={cn(
              'field-host truncate text-[11px]',
              dead
                ? 'text-[color:var(--status-bad)]'
                : 'text-[color:var(--status-warn)]'
            )}
            title={proxy.last_error}
          >
            {proxy.last_error}
            {Number(proxy.consecutive_failures) > 1
              ? ` · 连续 ${proxy.consecutive_failures} 次`
              : ''}
          </p>
        ) : null}
      </div>

      <div className='w-[84px] shrink-0 space-y-1'>
        <Latency proxy={proxy} />
        <p className='text-[11px] text-muted-foreground'>
          {fmtAgo(proxy.last_probe_at) || '未探测'}
        </p>
      </div>

      <div className='min-w-[230px] flex-[1.7] space-y-2'>
        <div
          role='meter'
          aria-label='已绑席位'
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={ids.length}
          aria-valuetext={`已绑 ${ids.length} / ${limit}`}
          className='flex items-center gap-3'
        >
          <SeatCount
            used={ids.length}
            limit={limit}
            className='w-[62px] shrink-0'
          />
          <SeatCells
            used={ids.length}
            limit={limit}
            color={PROXY_HEALTH_SOLID[health]}
            className='max-w-[180px] min-w-0 flex-1'
          />
        </div>
        <div className='flex flex-wrap items-center gap-1'>
          {ids.map((vmId) => (
            <VmChip
              key={vmId}
              vm={vmById.get(vmId)}
              vmId={vmId}
              tone={dead ? 'bad' : 'ok'}
              disabled={pending.binding}
              onUnbind={() => actions.onUnbind(id, vmId)}
              onDragChange={actions.onVmDragChange}
            />
          ))}
          {over ? (
            <span className='inline-flex h-6 items-center rounded-md border border-dashed border-primary px-2 text-xs text-primary'>
              松开绑定到这里
            </span>
          ) : !bindable ? (
            <span className='text-xs text-muted-foreground'>
              {health === 'off' ? '已禁用，不接新槽位' : '已失效，不接新槽位'}
            </span>
          ) : free > 0 ? (
            <ProxyBindPicker
              vms={vms}
              boundHere={ids}
              ownerOf={ownerOf}
              free={free}
              disabled={pending.binding}
              onBind={(vmId) => actions.onBind(id, vmId)}
            />
          ) : ids.length ? null : (
            <span className='text-xs text-muted-foreground'>无空位</span>
          )}
        </div>
      </div>

      <div className='ms-auto flex shrink-0 items-center gap-0.5'>
        <Button
          size='icon'
          variant='ghost'
          className='size-8'
          onClick={() => actions.onProbe(id)}
          loading={pending.probe === id}
          disabled={!!proxy.blocked_reason}
          aria-label='测通'
          title='测通：只测 SOCKS TCP，不打 Anthropic'
        >
          <Activity />
        </Button>
        <Button
          size='icon'
          variant='ghost'
          className='size-8'
          onClick={() => actions.onGeo(id)}
          loading={pending.geo === id}
          disabled={!!proxy.blocked_reason}
          aria-label='测地理'
          title='测地理：经这条代理查出口 IP 的国家 / 城市 / 时区'
        >
          <Globe />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size='icon'
              variant='ghost'
              className='size-8'
              aria-label='更多操作'
              loading={pending.copy === id || pending.toggle === id}
            >
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end' className='w-44'>
            {local ? null : (
              <>
                <DropdownMenuItem onSelect={() => actions.onCopy(id)}>
                  <Copy />
                  复制地址（含账密）
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => actions.onEdit(id)}>
                  <Pencil />
                  编辑
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuItem onSelect={() => actions.onToggleEnabled(proxy)}>
              {proxy.enabled === false ? <Power /> : <PowerOff />}
              {proxy.enabled === false ? '启用' : '禁用'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant='destructive'
              onSelect={() => actions.onDelete(id)}
            >
              <Trash2 />
              删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  )
}

function GeoLine({ proxy }: { proxy: VmProxySnap }) {
  const geo = proxy.geo
  if (!geo?.timezone && !geo?.country) {
    return (
      <p className='truncate text-[11px] text-muted-foreground'>
        {geo?.error ? '地理检测失败' : '地理未检测'}
      </p>
    )
  }
  const place = [geo.country_code || geo.country, geo.city]
    .filter(Boolean)
    .join(' · ')
  return (
    <p
      className='min-w-0 truncate text-[11px] text-muted-foreground'
      title={[geo.ip, geo.isp].filter(Boolean).join(' · ') || undefined}
    >
      {place ? <span className='text-foreground/80'>{place}</span> : null}
      {place && geo.timezone ? ' · ' : null}
      {geo.timezone}
    </p>
  )
}

const BAR_H = [5, 8, 11]

function Latency({ proxy }: { proxy: VmProxySnap }) {
  const tone = proxyLatencyTone(proxy)
  const bars = proxySignalBars(proxy)
  const color =
    tone === 'caution'
      ? 'var(--status-caution-solid)'
      : 'var(--status-ok-solid)'
  return (
    <div className='flex items-end gap-1.5'>
      <span aria-hidden='true' className='flex items-end gap-[2px] pb-px'>
        {BAR_H.map((h, i) => (
          <span
            key={h}
            className={cn(
              'w-[3px] rounded-[1px]',
              i < bars ? null : 'track-recessed'
            )}
            style={{
              height: h,
              backgroundColor: i < bars ? color : undefined,
            }}
          />
        ))}
      </span>
      <span
        className={cn(
          'field-metric text-[13px] leading-none',
          proxyFieldClass(tone)
        )}
      >
        {proxy.latency_ms != null ? `${proxy.latency_ms}ms` : '—'}
      </span>
    </div>
  )
}
