import { useEffect, useRef } from 'react'
import type { Vm, VmProxySnap } from '@/types/panel-vm'
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Search, X } from 'lucide-react'
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
  ProxyRow,
  type ProxyRowActions,
  type ProxyRowPending,
} from './proxy-row'
import {
  PROXY_HEALTH_LABEL,
  type ProxyFilter,
  type ProxySortKey,
  proxyInFilter,
  proxyViewId,
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
  sortKey,
  sortDir,
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
  sortKey: ProxySortKey
  sortDir: 'asc' | 'desc'
  onSortKey: (next: ProxySortKey) => void
  onSortDir: () => void
  hover: ProxyHover
  dragVm: string
  pending: ProxyRowPending
  actions: ProxyRowActions
}) {
  const searchRef = useRef<HTMLInputElement>(null)
  const healthFilter = !SEAT_FILTERS.some((f) => f.key === filter)

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
      className='min-w-0 overflow-hidden rounded-xl border bg-card'
    >
      <div className='flex flex-wrap items-center gap-2 border-b px-4 py-3'>
        <div className='relative min-w-[180px] flex-1'>
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
            placeholder='搜地址、名称、槽位、国家或时区'
            aria-label='搜索代理'
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
          <button
            type='button'
            onClick={() => onFilter('all')}
            className='inline-flex h-7 items-center gap-1 rounded-md bg-primary/10 px-2 text-xs font-medium text-primary transition-colors hover:bg-primary/15'
            aria-label={`清除筛选：${PROXY_HEALTH_LABEL[filter as keyof typeof PROXY_HEALTH_LABEL]}`}
          >
            {PROXY_HEALTH_LABEL[filter as keyof typeof PROXY_HEALTH_LABEL]}
            <X className='size-3' aria-hidden='true' />
          </button>
        ) : null}

        <div className='ms-auto flex items-center gap-1'>
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
        <ul className='divide-y divide-border/60'>
          {rows.map((p) => (
            <ProxyRow
              key={proxyViewId(p)}
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
      ) : (
        <div className='flex flex-col items-center gap-3 px-6 py-16 text-center'>
          <p className='text-sm text-muted-foreground'>
            {all.length
              ? '没有符合条件的代理。'
              : '还没有代理。在左侧粘贴 SOCKS5 行导入，或添加本地代理。'}
          </p>
          {all.length && (query || filter !== 'all') ? (
            <Button
              size='sm'
              variant='outline'
              onClick={() => {
                onQuery('')
                onFilter('all')
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
