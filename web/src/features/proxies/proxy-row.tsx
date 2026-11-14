import { useState } from 'react'
import type { Vm, VmProxySnap } from '@/types/panel-vm'
import {
  Activity,
  ChevronDown,
  Copy,
  Ellipsis,
  Globe,
  Lock,
  Pencil,
  Power,
  PowerOff,
  Trash2,
  TriangleAlert,
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
import { proxySchemeText } from './proxy-scheme'
import { SeatCells } from './proxy-seats'
import {
  LOCAL_PROXY_HINT,
  localProxyExitText,
  localProxyFitsNode,
  localProxyProbeText,
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

/** 测通 / 测地理 / 启停 / 绑定只有管理员能调；不给对应回调就不显示入口。 */
export type ProxyRowActions = {
  onProbe?: (id: string) => void
  onGeo?: (id: string) => void
  onCopy: (id: string) => void
  onEdit: (id: string) => void
  onToggleEnabled?: (proxy: VmProxySnap) => void
  onDelete: (id: string) => void
  onBind?: (id: string, vmId: string) => void
  onUnbind?: (id: string, vmId: string) => void
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

/**
 * 表头与每一行共用的列模板。列表容器宽于 `@3xl` 才对齐成表格；更窄时行退回
 * 两行的卡片排布，表头隐藏、改用工具条里的排序下拉。
 */
export const PROXY_ROW_GRID =
  '@3xl/plist:grid @3xl/plist:grid-cols-[minmax(0,1.5fr)_minmax(0,0.9fr)_68px_72px_88px_minmax(0,1.3fr)_auto] @3xl/plist:items-center @3xl/plist:gap-x-3'

/** 行内最多铺几片槽位，再多折成「+N」，展开后看全。 */
const INLINE_CHIPS = 2

/**
 * 一条代理一行：只放找节点时要扫的东西（名称、地区、状态、延迟、席位、绑了谁），
 * 单行约 40px。地址细节、错误、地理全文、全部操作在点名称展开的详情里。
 */
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
  const { onBind, onUnbind, onProbe } = actions
  const lit = useProxyHovered(hover, id)
  const [over, setOver] = useState(false)
  const [open, setOpen] = useState(false)
  const ids = proxyBoundIds(proxy)
  const limit = proxyBindLimit(proxy, poolLimit)
  const health = proxyHealthKey(proxy)
  const dead = proxyIsInvalid(proxy) && !proxy.blocked_reason
  const local = proxyIsLocal(proxy)
  const bindable = proxyBindable(proxy)
  const free = Math.max(0, limit - ids.length)
  const error =
    proxy.last_error && !proxy.blocked_reason ? proxy.last_error : ''
  // 本地代理只接它所在 VPS 上的槽位。
  const accepts =
    !!onBind &&
    !!dragVm &&
    bindable &&
    free > 0 &&
    !ids.includes(dragVm) &&
    localProxyFitsNode(proxy, vmById.get(dragVm)?.node_id ?? null) &&
    !pending.binding
  const alreadyHere = !!dragVm && ids.includes(dragVm)
  const detailId = `proxy-detail-${id}`
  const name = local
    ? proxyHostText(proxy)
    : proxy.label || proxyHostText(proxy)
  const sub = local
    ? `${LOCAL_PROXY_HINT} · ${localProxyExitText(proxy)}`
    : proxy.label
      ? proxyHostText(proxy)
      : ''
  const hidden = Math.max(0, ids.length - INLINE_CHIPS)

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
        if (!accepts || !vmId || !onBind) return
        e.preventDefault()
        onBind(id, vmId)
      }}
      className={cn(
        'scroll-mt-24 transition-[background-color,opacity,box-shadow] duration-200',
        dead && 'bg-red-1/60',
        lit && !dragVm && 'bg-accent/40',
        open && !lit && 'bg-muted/25',
        dragVm && !accepts && !alreadyHere && 'opacity-40',
        accepts &&
          'shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--primary)_35%,transparent)]',
        over && 'bg-primary/8 shadow-[inset_0_0_0_2px_var(--primary)]'
      )}
    >
      <div
        className={cn(
          'flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-1.5',
          PROXY_ROW_GRID
        )}
      >
        <button
          type='button'
          aria-expanded={open}
          aria-controls={detailId}
          onClick={() => setOpen((v) => !v)}
          title={open ? '收起详情' : '展开详情'}
          className='group/name flex min-w-0 basis-full items-center gap-2 rounded-sm text-start focus-visible:outline-2 focus-visible:outline-ring @3xl/plist:basis-auto'
        >
          <ChevronDown
            aria-hidden='true'
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200 group-hover/name:text-foreground',
              !open && '-rotate-90'
            )}
          />
          <span
            className={cn(
              'min-w-0 shrink truncate text-[13px] font-medium group-hover/name:underline group-hover/name:underline-offset-2',
              !proxy.label && !local && 'field-host'
            )}
          >
            {name}
          </span>
          {sub ? (
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-[11px] text-muted-foreground',
                !local && 'field-host'
              )}
            >
              {sub}
            </span>
          ) : (
            <span className='flex-1' />
          )}
          {proxy.has_auth ? (
            <Lock
              className='size-3 shrink-0 text-muted-foreground'
              aria-label='已配账密'
            />
          ) : null}
          {error ? (
            <TriangleAlert
              className={cn(
                'size-3.5 shrink-0',
                dead
                  ? 'text-[color:var(--status-bad)]'
                  : 'text-[color:var(--status-warn)]'
              )}
              aria-label={`最近错误：${error}`}
            />
          ) : null}
        </button>

        <GeoText proxy={proxy} local={local} />

        <StatusMark tone={proxyStatusTone(proxy)} />

        <Latency proxy={proxy} local={local} />

        <div
          role='meter'
          aria-label='已绑席位'
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={ids.length}
          aria-valuetext={`已绑 ${ids.length} / ${limit}`}
          className='flex w-[88px] shrink-0 items-center gap-2 @3xl/plist:w-auto'
        >
          <span className='w-9 shrink-0 text-xs tabular-nums'>
            <span
              className={cn(
                'font-semibold',
                ids.length > limit
                  ? 'text-[color:var(--status-warn)]'
                  : !ids.length && 'text-muted-foreground'
              )}
            >
              {ids.length}
            </span>
            <span className='text-muted-foreground'>/{limit}</span>
          </span>
          <SeatCells
            used={ids.length}
            limit={limit}
            color={PROXY_HEALTH_SOLID[health]}
            className='min-w-0 flex-1'
          />
        </div>

        {/* 卡片排布时放不下就整体换到下一行，不在行内被裁掉。 */}
        <div className='flex min-w-[180px] flex-1 items-center gap-1 overflow-hidden @3xl/plist:min-w-0'>
          {ids.slice(0, INLINE_CHIPS).map((vmId) => (
            <VmChip
              key={vmId}
              compact
              vm={vmById.get(vmId)}
              vmId={vmId}
              tone={dead ? 'bad' : 'ok'}
              disabled={pending.binding || !onBind}
              onUnbind={onUnbind ? () => onUnbind(id, vmId) : undefined}
              onDragChange={actions.onVmDragChange}
            />
          ))}
          {hidden ? (
            <button
              type='button'
              onClick={() => setOpen(true)}
              aria-label={`还有 ${hidden} 台，展开查看`}
              className='inline-flex h-6 shrink-0 items-center rounded-md bg-muted px-1.5 text-xs text-muted-foreground tabular-nums transition-colors hover:text-foreground'
            >
              +{hidden}
            </button>
          ) : null}
          {over ? (
            <span className='inline-flex h-6 shrink-0 items-center rounded-md border border-dashed border-primary px-2 text-xs text-primary'>
              松开绑定
            </span>
          ) : onBind && bindable && free > 0 ? (
            <ProxyBindPicker
              compact
              vms={vms}
              boundHere={ids}
              ownerOf={ownerOf}
              free={free}
              disabled={pending.binding}
              onBind={(vmId) => onBind(id, vmId)}
            />
          ) : !ids.length ? (
            <span className='truncate text-xs text-muted-foreground'>
              {!bindable ? (health === 'off' ? '已禁用' : '已失效') : '无空位'}
            </span>
          ) : null}
        </div>

        <div className='ms-auto flex shrink-0 items-center @3xl/plist:ms-0'>
          {onProbe ? (
            <Button
              size='icon'
              variant='ghost'
              className='size-7'
              onClick={() => onProbe(id)}
              loading={pending.probe === id}
              disabled={!!proxy.blocked_reason}
              aria-label='测通'
              title='测通：只测 SOCKS TCP，不打 Anthropic'
            >
              <Activity />
            </Button>
          ) : null}
          <RowMenu
            proxy={proxy}
            local={local}
            pending={pending}
            actions={actions}
          />
        </div>
      </div>

      {open ? (
        <ProxyDetail
          id={detailId}
          proxy={proxy}
          vms={vms}
          vmById={vmById}
          ownerOf={ownerOf}
          ids={ids}
          free={free}
          bindable={bindable}
          dead={dead}
          local={local}
          error={error}
          pending={pending}
          actions={actions}
        />
      ) : null}
    </li>
  )
}

function RowMenu({
  proxy,
  local,
  pending,
  actions,
}: {
  proxy: VmProxySnap
  local: boolean
  pending: ProxyRowPending
  actions: ProxyRowActions
}) {
  const id = proxy.id || ''
  const { onGeo, onToggleEnabled } = actions
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size='icon'
          variant='ghost'
          className='size-7'
          aria-label='更多操作'
          loading={
            pending.geo === id || pending.copy === id || pending.toggle === id
          }
        >
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end' className='w-44'>
        {onGeo ? (
          <DropdownMenuItem
            disabled={!!proxy.blocked_reason}
            onSelect={() => onGeo(id)}
          >
            <Globe />
            测地理
          </DropdownMenuItem>
        ) : null}
        {local ? null : (
          <>
            <DropdownMenuItem onSelect={() => actions.onCopy(id)}>
              <Copy />
              复制地址（含账密）
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => actions.onEdit(id)}>
              <Pencil />
              编辑 / 改名
            </DropdownMenuItem>
          </>
        )}
        {onToggleEnabled ? (
          <DropdownMenuItem onSelect={() => onToggleEnabled(proxy)}>
            {proxy.enabled === false ? <Power /> : <PowerOff />}
            {proxy.enabled === false ? '启用' : '禁用'}
          </DropdownMenuItem>
        ) : null}
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
  )
}

/** 展开详情：行里省掉的全部信息与绑定管理。不重复行内已有的状态 / 延迟 / 席位读数。 */
function ProxyDetail({
  id,
  proxy,
  vms,
  vmById,
  ownerOf,
  ids,
  free,
  bindable,
  dead,
  local,
  error,
  pending,
  actions,
}: {
  id: string
  proxy: VmProxySnap
  vms: Vm[]
  vmById: Map<string, Vm>
  ownerOf: Map<string, VmProxySnap>
  ids: string[]
  free: number
  bindable: boolean
  dead: boolean
  local: boolean
  error: string
  pending: ProxyRowPending
  actions: ProxyRowActions
}) {
  const pxId = proxy.id || ''
  const { onBind, onUnbind, onGeo, onToggleEnabled } = actions
  const geo = proxy.geo
  // 本地代理一台 VPS 一条：绑定入口只列这台机器上的槽位。
  const pickable = local
    ? vms.filter((vm) => localProxyFitsNode(proxy, vm.node_id ?? null))
    : vms
  const chip = (vmId: string) => (
    <VmChip
      key={vmId}
      vm={vmById.get(vmId)}
      vmId={vmId}
      tone={dead ? 'bad' : 'ok'}
      disabled={pending.binding || !onBind}
      onUnbind={onUnbind ? () => onUnbind(pxId, vmId) : undefined}
      onDragChange={actions.onVmDragChange}
    />
  )
  return (
    <div
      id={id}
      className='mx-4 mb-2.5 space-y-3 rounded-lg border bg-background/60 px-4 py-3 text-xs'
    >
      <dl className='grid gap-x-6 gap-y-2.5 sm:grid-cols-[auto_minmax(0,1fr)]'>
        <DetailField label='地址'>
          <span className='field-host'>{proxyHostText(proxy)}</span>
          {local ? (
            <span className='text-muted-foreground'>
              {' '}
              · {LOCAL_PROXY_HINT}，{localProxyExitText(proxy)}
              ，绑定额度按这台 VPS 单独计
            </span>
          ) : null}
          <span className='text-muted-foreground'>
            {local ? '' : ` · ${proxySchemeText(proxy.scheme)}`}
            {proxy.has_auth ? ' · 有账密' : ' · 无账密'}
            {proxy.address_family === 6 ? ' · IPv6' : ''}
          </span>
        </DetailField>
        <DetailField label='出口'>
          {geo?.country || geo?.timezone ? (
            <span>
              {[geo.country || geo.country_code, geo.city, geo.timezone]
                .filter(Boolean)
                .join(' · ')}
              <span className='text-muted-foreground'>
                {[geo.isp, geo.ip].filter(Boolean).length
                  ? ` · ${[geo.isp, geo.ip].filter(Boolean).join(' · ')}`
                  : ''}
                {local ? ` · ${localProxyProbeText(proxy)}` : ''}
              </span>
            </span>
          ) : (
            <span className='text-muted-foreground'>
              {geo?.error ? `地理检测失败：${geo.error}` : '地理未检测'}
            </span>
          )}
        </DetailField>
        <DetailField label='探测'>
          <span className='text-muted-foreground'>
            {proxy.last_probe_at
              ? `${fmtAgo(proxy.last_probe_at)}探测`
              : '还没探测过'}
          </span>
          {error ? (
            <span
              className={cn(
                'field-host block break-all',
                dead
                  ? 'text-[color:var(--status-bad)]'
                  : 'text-[color:var(--status-warn)]'
              )}
            >
              {error}
              {Number(proxy.consecutive_failures) > 1
                ? ` · 连续 ${proxy.consecutive_failures} 次`
                : ''}
            </span>
          ) : null}
        </DetailField>
        <DetailField label='已绑槽位'>
          <div className='space-y-1.5'>
            <div className='flex flex-wrap items-center gap-1'>
              {ids.map(chip)}
              {!ids.length ? (
                <span className='text-muted-foreground'>还没有绑定槽位</span>
              ) : null}
            </div>
            {!onBind ? null : bindable && free > 0 ? (
              <ProxyBindPicker
                vms={pickable}
                boundHere={ids}
                ownerOf={ownerOf}
                free={free}
                disabled={pending.binding}
                onBind={(vmId) => onBind(pxId, vmId)}
              />
            ) : (
              <p className='text-muted-foreground'>
                {!bindable
                  ? proxyHealthKey(proxy) === 'off'
                    ? '已禁用，不接新槽位'
                    : '已失效，不接新槽位'
                  : '已满，不接新槽位；把槽位拖到别的代理行可以换绑'}
              </p>
            )}
          </div>
        </DetailField>
      </dl>
      <div className='flex flex-wrap gap-1.5'>
        {onGeo ? (
          <Button
            size='sm'
            variant='outline'
            className='h-7 text-xs'
            onClick={() => onGeo(pxId)}
            loading={pending.geo === pxId}
            disabled={!!proxy.blocked_reason}
          >
            <Globe aria-hidden='true' />
            测地理
          </Button>
        ) : null}
        {local ? null : (
          <>
            <Button
              size='sm'
              variant='outline'
              className='h-7 text-xs'
              onClick={() => actions.onCopy(pxId)}
              loading={pending.copy === pxId}
            >
              <Copy aria-hidden='true' />
              复制地址
            </Button>
            <Button
              size='sm'
              variant='outline'
              className='h-7 text-xs'
              onClick={() => actions.onEdit(pxId)}
            >
              <Pencil aria-hidden='true' />
              编辑 / 改名
            </Button>
          </>
        )}
        {onToggleEnabled ? (
          <Button
            size='sm'
            variant='outline'
            className='h-7 text-xs'
            onClick={() => onToggleEnabled(proxy)}
            loading={pending.toggle === pxId}
          >
            {proxy.enabled === false ? (
              <Power aria-hidden='true' />
            ) : (
              <PowerOff aria-hidden='true' />
            )}
            {proxy.enabled === false ? '启用' : '禁用'}
          </Button>
        ) : null}
        <Button
          size='sm'
          variant='ghost'
          className='ms-auto h-7 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive'
          onClick={() => actions.onDelete(pxId)}
        >
          <Trash2 aria-hidden='true' />
          删除
        </Button>
      </div>
    </div>
  )
}

function DetailField({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <>
      <dt className='pt-px text-muted-foreground'>{label}</dt>
      <dd className='min-w-0'>{children}</dd>
    </>
  )
}

/** 地区：国家代码 · 城市，一行。时区、ISP 在悬停提示和展开详情里。 */
function GeoText({
  proxy,
  local = false,
}: {
  proxy: VmProxySnap
  local?: boolean
}) {
  const geo = proxy.geo
  const country = geo?.country_code || geo?.country
  const title =
    [
      geo?.timezone,
      geo?.isp,
      geo?.ip,
      local ? localProxyProbeText(proxy) : null,
    ]
      .filter(Boolean)
      .join(' · ') || undefined
  return (
    <p className='min-w-0 truncate text-xs' title={title}>
      {country ? (
        <>
          <span className='font-medium tracking-[0.02em]'>{country}</span>
          {geo?.city ? (
            <span className='text-muted-foreground'> · {geo.city}</span>
          ) : null}
        </>
      ) : (
        <span className='text-muted-foreground'>
          {geo?.error ? '检测失败' : '未测地理'}
        </span>
      )}
    </p>
  )
}

const BAR_H = [5, 8, 11]

function Latency({ proxy, local }: { proxy: VmProxySnap; local: boolean }) {
  const tone = proxyLatencyTone(proxy)
  const bars = proxySignalBars(proxy)
  const color =
    tone === 'caution'
      ? 'var(--status-caution-solid)'
      : 'var(--status-ok-solid)'
  const ago = fmtAgo(proxy.last_probe_at)
  return (
    <div
      className='flex shrink-0 items-end gap-1.5'
      title={`${ago ? `${ago}探测` : '未探测'}${local ? ` · ${localProxyProbeText(proxy)}` : ''}`}
    >
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
          'field-metric text-xs leading-none',
          proxyFieldClass(tone)
        )}
      >
        {proxy.latency_ms != null ? `${proxy.latency_ms}ms` : '—'}
      </span>
    </div>
  )
}
