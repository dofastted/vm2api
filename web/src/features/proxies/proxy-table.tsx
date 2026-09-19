import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { Vm, VmProxySnap } from '@/types/panel-vm'
import { Lock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { EmptyState } from '@/components/empty-state'
import { StatusMark } from '@/components/status-mark'
import {
  type ProxySortKey,
  proxyBindLimit,
  proxyBoundIds,
  proxyIsInvalid,
  proxyStatusLabel,
} from '@/features/proxies/proxy-sort'
import {
  proxyFieldClass,
  proxyLatencyTone,
} from '@/features/proxies/proxy-tone'

type ProxyTableProps = {
  rows: VmProxySnap[]
  vms: Vm[]
  bindLimit: number
  busy: boolean
  sortKey: ProxySortKey
  sortDir: 'asc' | 'desc'
  copyingId: string
  onToggleSort: (key: ProxySortKey) => void
  onProbe: (id: string) => void
  onGeo: (id: string) => void
  onDelete: (id: string) => void
  onEdit: (id: string) => void
  onCopy: (id: string) => void
  onToggleEnabled: (item: VmProxySnap) => void
  onBind: (id: string, vmId: string) => void
  onUnbind: (id: string, vmId: string) => void
}

export function ProxyTable(props: ProxyTableProps) {
  const {
    rows,
    vms,
    bindLimit,
    busy,
    sortKey,
    sortDir,
    copyingId,
    onToggleSort,
    onProbe,
    onGeo,
    onDelete,
    onEdit,
    onCopy,
    onToggleEnabled,
    onBind,
    onUnbind,
  } = props

  return (
    <>
      {rows.length === 0 ? (
        <EmptyState reason='还没有代理。粘贴 SOCKS5 行再点导入。' />
      ) : (
        <div className='overflow-x-auto rounded-lg border border-border/60'>
          <div className='min-w-[1060px]'>
            <div className='flex h-8 items-center border-b bg-muted/30 text-[11px] font-medium tracking-wide text-muted-foreground/80'>
              <SortHead
                label='代理'
                col='host'
                current={sortKey}
                dir={sortDir}
                onToggle={onToggleSort}
                className='min-w-[140px] flex-[1.2] pl-3'
              />
              <SortHead
                label='状态'
                col='status'
                current={sortKey}
                dir={sortDir}
                onToggle={onToggleSort}
                className='min-w-[120px] flex-[1] px-1.5'
              />
              <SortHead
                label='出口地区'
                col='geo'
                current={sortKey}
                dir={sortDir}
                onToggle={onToggleSort}
                className='min-w-[160px] flex-[1.2] px-1.5'
              />
              <SortHead
                label='绑定'
                col='vm'
                current={sortKey}
                dir={sortDir}
                onToggle={onToggleSort}
                className='min-w-[220px] flex-[1.8] px-1.5'
              />
              <div className='min-w-[200px] flex-[1.1] truncate pr-3 text-right'>
                操作
              </div>
            </div>
            {rows.map((p) => (
              <ProxyRow
                key={p.id}
                item={p}
                vms={vms}
                takenVmIds={
                  new Set(
                    rows
                      .filter((o) => o.id !== p.id)
                      .flatMap((o) => proxyBoundIds(o))
                  )
                }
                bindLimit={bindLimit}
                busy={busy}
                onProbe={() => p.id && onProbe(p.id)}
                onGeo={() => p.id && onGeo(p.id)}
                onDelete={() => p.id && onDelete(p.id)}
                onEdit={() => p.id && onEdit(p.id)}
                onCopy={() => p.id && onCopy(p.id)}
                copying={copyingId === p.id}
                onToggleEnabled={() => onToggleEnabled(p)}
                onBind={(vmId) => p.id && onBind(p.id, vmId)}
                onUnbind={(vmId) => p.id && onUnbind(p.id, vmId)}
              />
            ))}
          </div>
        </div>
      )}
      <p className='mt-2 text-xs text-muted-foreground'>
        槽位数 {vms.length}
        。账密不在列表里回显，「复制」按需取回并直接写入剪贴板。
      </p>
    </>
  )
}

function SortHead({
  label,
  col,
  current,
  dir,
  onToggle,
  className,
}: {
  label: string
  col: ProxySortKey
  current: ProxySortKey
  dir: 'asc' | 'desc'
  onToggle: (col: ProxySortKey) => void
  className?: string
}) {
  const on = current === col
  return (
    <button
      type='button'
      className={cn('truncate text-left', on && 'text-foreground', className)}
      aria-sort={on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={() => onToggle(col)}
    >
      {label}
      {on ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </button>
  )
}

function ProxyRow({
  item,
  vms,
  takenVmIds,
  bindLimit,
  busy,
  onProbe,
  onGeo,
  onDelete,
  onEdit,
  onCopy,
  copying,
  onToggleEnabled,
  onBind,
  onUnbind,
}: {
  item: VmProxySnap
  vms: Vm[]
  /** 已绑在**别的**代理上的槽位，用于给下拉项打「已有代理」标记。 */
  takenVmIds: Set<string>
  bindLimit: number
  busy: boolean
  onProbe: () => void
  onGeo: () => void
  onDelete: () => void
  onEdit: () => void
  onCopy: () => void
  copying: boolean
  onToggleEnabled: () => void
  onBind: (vmId: string) => void
  onUnbind: (vmId: string) => void
}) {
  const [pick, setPick] = useState('')
  const dead = proxyIsInvalid(item)
  const ids = proxyBoundIds(item)
  const limit = proxyBindLimit(item, bindLimit)
  const latTone = proxyLatencyTone(item)
  const lat = item.latency_ms != null ? `${item.latency_ms}ms` : '—'
  const off = item.enabled === false
  // 候选排除已绑在本条上的，对齐 index.html `vmBindOptions(keepIds)`。
  const candidates = vms.filter((v) => !ids.includes(v.id))
  return (
    <div
      className={cn(
        'flex items-center border-b border-border/40 text-sm',
        // 失效行染红而非 legacy 的淡出：代理页是排障的地方，失效代理是待办
        // 事项，不该被弱化到背景里。这是对 index.html 的有意偏离。
        dead && 'bg-red-1'
      )}
    >
      <div className='field-host min-w-[140px] flex-[1.2] truncate pl-3 text-xs'>
        {item.kind === 'local' || item.scheme === 'local'
          ? '本地出口'
          : `${item.host}:${item.port}`}
        {item.has_auth ? (
          <Lock
            className='ml-1 inline size-3 align-[-1px] text-muted-foreground'
            aria-label='已配账密'
          />
        ) : null}
      </div>
      <div className='flex min-w-[120px] flex-[1] items-center gap-2 px-1.5'>
        <StatusMark
          tone={{
            key: item.status || '',
            text: proxyStatusLabel(item),
            cls: item.status === 'ok' ? 'ok' : dead ? 'bad' : 'caution',
          }}
        />
        <span className={cn('field-metric text-xs', proxyFieldClass(latTone))}>
          {lat}
        </span>
      </div>
      <div className='flex min-w-[160px] flex-[1.2] flex-col justify-center px-1.5 text-xs'>
        {item.geo?.timezone || item.geo?.country ? (
          <>
            <span className='truncate'>
              {[item.geo.country_code || item.geo.country, item.geo.city]
                .filter(Boolean)
                .join(' · ')}
            </span>
            <span className='truncate text-[11px] text-muted-foreground'>
              {item.geo.timezone || '时区未知'}
            </span>
          </>
        ) : (
          <span className='text-muted-foreground'>
            {item.geo?.error ? '检测失败' : '未检测'}
          </span>
        )}
      </div>
      <div className='flex min-w-[220px] flex-[1.8] flex-wrap items-center gap-1 px-1.5 text-xs'>
        <span className='field-count text-muted-foreground'>
          {ids.length}/{limit}
        </span>
        {ids.map((id) => (
          <span
            key={id}
            className='inline-flex items-center gap-0.5 rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5'
          >
            <Link
              to='/vm/$id'
              params={{ id }}
              className='underline-offset-2 hover:underline'
            >
              {vms.find((v) => v.id === id)?.name || id}
            </Link>
            <button
              type='button'
              aria-label={`解绑 ${id}`}
              title='解绑'
              className='text-muted-foreground hover:text-destructive disabled:opacity-50'
              disabled={busy}
              onClick={() => onUnbind(id)}
            >
              ×
            </button>
          </span>
        ))}
        {ids.length >= limit ? (
          <span className='text-muted-foreground'>已满 {limit}</span>
        ) : candidates.length ? (
          <span className='inline-flex items-center gap-1'>
            <Select value={pick} onValueChange={setPick}>
              <SelectTrigger className='h-7 w-[128px]' aria-label='绑定虚拟机'>
                <SelectValue placeholder='选槽位' />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.name || v.id}
                    {takenVmIds.has(v.id) ? ' · 已有代理' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size='sm'
              variant='outline'
              className='h-7 px-2'
              disabled={busy || !pick}
              onClick={() => {
                onBind(pick)
                setPick('')
              }}
            >
              绑定
            </Button>
          </span>
        ) : (
          <span className='text-muted-foreground'>无可绑槽位</span>
        )}
      </div>
      <div className='flex min-w-[200px] flex-[1.1] items-center justify-end gap-0.5 pr-3'>
        <Button
          size='sm'
          variant='ghost'
          className='px-2'
          disabled={busy || copying}
          onClick={onCopy}
          title='复制含账密的 SOCKS5 地址到剪贴板'
        >
          复制
        </Button>
        <Button
          size='sm'
          variant='ghost'
          className='px-2'
          disabled={busy}
          onClick={onEdit}
        >
          编辑
        </Button>
        <Button
          size='sm'
          variant='ghost'
          className='px-2'
          disabled={busy}
          onClick={onProbe}
        >
          测
        </Button>
        <Button
          size='sm'
          variant='ghost'
          className='px-2'
          disabled={busy}
          onClick={onGeo}
          title='经这条代理查出口 IP 的国家 / 城市 / 时区'
        >
          地理
        </Button>
        <Button
          size='sm'
          variant='ghost'
          className='px-2'
          disabled={busy}
          onClick={onToggleEnabled}
        >
          {off ? '启用' : '禁用'}
        </Button>
        <Button
          size='sm'
          variant='ghost'
          className='px-2 text-destructive'
          disabled={busy}
          onClick={onDelete}
        >
          删
        </Button>
      </div>
    </div>
  )
}
