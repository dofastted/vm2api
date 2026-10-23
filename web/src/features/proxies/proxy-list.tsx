import { useEffect, useRef } from 'react'
import type { Vm, VmProxySnap } from '@/types/panel-vm'
import {
  ArrowDown,
  ArrowDownWideNarrow,
  ArrowUp,
  ArrowUpNarrowWide,
  Search,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { ProxyHover } from './proxy-hover'
import {
  PROXY_ROW_GRID,
  ProxyRow,
  type ProxyRowActions,
  type ProxyRowPending,
} from './proxy-row'
import {
  PROXY_HEALTH_LABEL,
  type ProxyFilter,
  type ProxySortKey,
  proxyInFilter,
} from './proxy-sort'

const SORT_LABEL: Record<ProxySortKey, string> = {
  status: '状态',
  latency: '延迟',
  seats: '已绑数',
  geo: '出口地区',
  host: '地址',
}

const SEAT_FILTERS: { key: ProxyFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'open', label: '有空位' },
  { key: 'full', label: '已满' },
]

/** 表头：可排序的列给按钮，其余只是标签。顺序与 `PROXY_ROW_GRID` 一一对应。 */
const COLUMNS: { label: string; sort?: ProxySortKey }[] = [
  { label: '节点', sort: 'host' },
  { label: '地区', sort: 'geo' },
  { label: '状态', sort: 'status' },
  { label: '延迟', sort: 'latency' },
  { label: '席位', sort: 'seats' },
  { label: '已绑槽位' },
  { label: '操作' },
]

export function ProxyList({
  all,
  rows,
  vms,
  vmById,
  ownerOf,
  poolLimit,
  query,
  onQuery,
  filter,
  onFilter,
  regionText,
  onClearRegion,
  sortKey,
  sortDir,
  onSort,
  onSortKey,
  onSortDir,
  hover,
  dragVm,
  pending,
  actions,
}: {
  /** 已排序全集，用于筛选计数。 */
  all: VmProxySnap[]
  /** 筛选 + 搜索后的可见行。 */
  rows: VmProxySnap[]
  vms: Vm[]
  vmById: Map<string, Vm>
  ownerOf: Map<string, VmProxySnap>
  poolLimit: number
  query: string
  onQuery: (next: string) => void
  filter: ProxyFilter
  onFilter: (next: ProxyFilter) => void
  /** 当前地区筛选的显示名；空串表示不限地区。 */
  regionText: string
  onClearRegion: () => void
  sortKey: ProxySortKey
  sortDir: 'asc' | 'desc'
  /** 点表头：同一列翻转方向，换列落到该列的自然方向。 */
  onSort: (key: ProxySortKey) => void
  onSortKey: (next: ProxySortKey) => void
  onSortDir: () => void
  hover: ProxyHover
  dragVm: string
  pending: ProxyRowPending
  actions: ProxyRowActions
}) {
  const searchRef = useRef<HTMLInputElement>(null)
  const healthFilter = !SEAT_FILTERS.some((f) => f.key === filter)
  const narrowed = !!query || filter !== 'all' || !!regionText

  // `/` 聚焦搜索，和日志页、命令面板的习惯一致；输入框里按 `/` 不拦截。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target as HTMLElement | null
      if (el?.closest('input, textarea, select, [contenteditable="true"]')) {
        return
      }
      e.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <section
      aria-label='代理列表'
      className='@container/plist min-w-0 rounded-xl border bg-card'
    >
      <div className='flex flex-wrap items-center gap-2 border-b px-4 py-3'>
        <div className='relative min-w-[200px] flex-1'>
          <Search
            aria-hidden='true'
            className='pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground'
          />
          <Input
            ref={searchRef}
            type='search'
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.preventDefault()
                onQuery('')
              }
            }}
            placeholder='筛选可用节点：地址、名称、槽位、国家或时区'
            aria-label='筛选可用节点'
            className='h-8 ps-8 pe-8 text-sm'
          />
          <kbd className='pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded border bg-muted px-1 font-mono text-[10px] text-muted-foreground sm:block'>
            /
          </kbd>
        </div>

        <div
          role='group'
          aria-label='按席位筛选'
          className='flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5'
        >
          {SEAT_FILTERS.map((f) => {
            const n =
              f.key === 'all'
                ? all.length
                : all.filter((p) => proxyInFilter(p, f.key, poolLimit)).length
            const on = filter === f.key
            return (
              <button
                key={f.key}
                type='button'
                aria-pressed={on}
                onClick={() => onFilter(f.key)}
                className={cn(
                  'inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs transition-colors',
                  on
                    ? 'bg-background font-medium text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {f.label}
                <span className='tabular-nums opacity-70'>{n}</span>
              </button>
            )
          })}
        </div>

        {healthFilter ? (
          <ClearChip
            label={
              PROXY_HEALTH_LABEL[filter as keyof typeof PROXY_HEALTH_LABEL]
            }
            onClear={() => onFilter('all')}
          />
        ) : null}
        {regionText ? (
          <ClearChip label={regionText} onClear={onClearRegion} />
        ) : null}

        {/* 宽屏用表头排序；表头隐藏时才需要这组下拉。 */}
        <div className='ms-auto flex items-center gap-1 @3xl/plist:hidden'>
          <Select
            value={sortKey}
            onValueChange={(v) => onSortKey(v as ProxySortKey)}
          >
            <SelectTrigger
              className='h-8 w-[112px] text-xs'
              aria-label='排序字段'
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align='end'>
              {(Object.keys(SORT_LABEL) as ProxySortKey[]).map((k) => (
                <SelectItem key={k} value={k}>
                  按{SORT_LABEL[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size='icon'
            variant='outline'
            className='size-8'
            onClick={onSortDir}
            aria-label={
              sortDir === 'asc'
                ? '当前升序，切换为降序'
                : '当前降序，切换为升序'
            }
            title={sortDir === 'asc' ? '升序' : '降序'}
          >
            {sortDir === 'asc' ? (
              <ArrowUpNarrowWide />
            ) : (
              <ArrowDownWideNarrow />
            )}
          </Button>
        </div>
      </div>

      {rows.length ? (
        <>
          <div
            className={cn(
              'hidden border-b bg-muted/30 px-4 py-1 text-[11px] font-medium text-muted-foreground',
              PROXY_ROW_GRID
            )}
          >
            {COLUMNS.map((c) =>
              c.sort ? (
                <SortHeader
                  key={c.label}
                  label={c.label}
                  active={sortKey === c.sort}
                  dir={sortDir}
                  // 行首有展开箭头，表头文字对齐到名称上。
                  className={c.sort === 'host' ? 'ms-[18px]' : undefined}
                  onClick={() => onSort(c.sort as ProxySortKey)}
                />
              ) : (
                <span
                  key={c.label}
                  className={cn(c.label === '操作' && 'sr-only')}
                >
                  {c.label}
                </span>
              )
            )}
          </div>
          <ul className='divide-y divide-border/60'>
            {rows.map((p) => (
              <ProxyRow
                key={p.id}
                proxy={p}
                vms={vms}
                vmById={vmById}
                ownerOf={ownerOf}
                poolLimit={poolLimit}
                hover={hover}
                dragVm={dragVm}
                pending={pending}
                actions={actions}
              />
            ))}
          </ul>
        </>
      ) : (
        <div className='flex flex-col items-center gap-3 px-6 py-16 text-center'>
          <p className='text-sm text-muted-foreground'>
            {all.length
              ? query
                ? '没有匹配的可用节点（已满、禁用或失效的不参与筛选）。'
                : '没有符合条件的代理。'
              : '还没有代理。点右上角「添加代理」粘贴代理地址导入，或添加本地代理。'}
          </p>
          {all.length && narrowed ? (
            <Button
              size='sm'
              variant='outline'
              onClick={() => {
                onQuery('')
                onFilter('all')
                onClearRegion()
              }}
            >
              清除筛选
            </Button>
          ) : null}
        </div>
      )}

      <p className='border-t px-4 py-2 text-[11px] text-muted-foreground'>
        {rows.length === all.length
          ? `${all.length} 条`
          : `显示 ${rows.length} / ${all.length} 条`}
        。账密不在列表里回显，「复制」按需取回并直接写入剪贴板。
      </p>
    </section>
  )
}

function ClearChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <button
      type='button'
      onClick={onClear}
      className='inline-flex h-7 items-center gap-1 rounded-md bg-primary/10 px-2 text-xs font-medium text-primary transition-colors hover:bg-primary/15'
      aria-label={`清除筛选：${label}`}
    >
      {label}
      <X className='size-3' aria-hidden='true' />
    </button>
  )
}

function SortHeader({
  label,
  active,
  dir,
  className,
  onClick,
}: {
  label: string
  active: boolean
  dir: 'asc' | 'desc'
  className?: string
  onClick: () => void
}) {
  const Arrow = dir === 'asc' ? ArrowUp : ArrowDown
  return (
    <button
      type='button'
      onClick={onClick}
      aria-label={
        active
          ? `按${label}排序，当前${dir === 'asc' ? '升序' : '降序'}，点击翻转`
          : `按${label}排序`
      }
      className={cn(
        'group -mx-1 inline-flex h-6 w-fit items-center gap-1 rounded px-1 text-start transition-colors hover:text-foreground',
        active && 'text-foreground',
        className
      )}
    >
      {label}
      <Arrow
        aria-hidden='true'
        className={cn(
          'size-3 transition-opacity',
          active ? 'opacity-100' : 'opacity-0 group-hover:opacity-50'
        )}
      />
    </button>
  )
}
