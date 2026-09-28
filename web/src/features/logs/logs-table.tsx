import type { RequestLogItem } from '@/types/panel-logs'
import type { Vm } from '@/types/panel-vm'
import { fmtNum, fmtUsd } from '@/lib/format'
import { maskPresentedKey } from '@/lib/log-mute'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ModelVendorIcon } from '@/components/model-vendor-icon'
import { SlotIdentity } from '@/components/platform-chip'
import { columnVisible, type HideableLogColumn } from './column-visibility'
import {
  UNASSIGNED_EXECUTION,
  rowCost,
  showModelRedirect,
  statusBadge,
} from './log-badges'
import {
  CacheBadge,
  RateMultiplierBadge,
  RedirectBadge,
  StatusBadges,
} from './log-row-badges'

/** 后端时间字段是 `ts`（ISO），不是 `created_at` —— 表里只显示 HH:MM:SS。 */
function fmtLogTime(value: unknown): string {
  if (!value) return '—'
  const t = new Date(String(value))
  return Number.isFinite(t.getTime())
    ? t.toTimeString().slice(0, 8)
    : String(value)
}

function fmtDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms)}ms`
}

function fmtPerf(row: RequestLogItem): string {
  const ttft = Number(row.first_token_ms)
  const dur = Number(row.duration_ms)
  const hasTtft = Number.isFinite(ttft)
  const hasDur = Number.isFinite(dur)
  if (!hasTtft && !hasDur) return '—'
  if (hasTtft && hasDur) return `${fmtDuration(ttft)} / ${fmtDuration(dur)}`
  return fmtDuration(hasTtft ? ttft : dur)
}

export function logRowId(row: RequestLogItem): string {
  return String(row.request_id || row.id || '')
}

function HeadCell({
  children,
  className,
}: {
  children: string
  className?: string
}) {
  return (
    <div className={cn('truncate px-1.5', className)} title={children}>
      {children}
    </div>
  )
}

export function LogsTableHeader({
  showIngress,
  hidden,
}: {
  showIngress?: boolean
  hidden?: readonly HideableLogColumn[]
}) {
  const show = (id: HideableLogColumn) => columnVisible(hidden, id)
  return (
    <div className='sticky top-0 z-10 border-b bg-muted/30'>
      <div className='flex h-8 items-center text-[11px] font-medium tracking-wide text-muted-foreground/80'>
        <HeadCell className='min-w-[56px] flex-[0.6] pl-3'>时间</HeadCell>
        <HeadCell className='min-w-[100px] flex-[1.3]'>模型</HeadCell>
        {show('account') ? (
          <HeadCell className='min-w-[160px] flex-[1.4]'>账号</HeadCell>
        ) : null}
        {show('tokens') ? (
          <HeadCell className='min-w-[70px] flex-[0.7] text-right'>
            Tokens
          </HeadCell>
        ) : null}
        {show('cache') ? (
          <HeadCell className='min-w-[70px] flex-[0.8] text-right'>
            缓存
          </HeadCell>
        ) : null}
        {show('cost') ? (
          <HeadCell className='min-w-[56px] flex-[0.6] text-right'>
            费用
          </HeadCell>
        ) : null}
        {show('perf') ? (
          <HeadCell className='min-w-[80px] flex-[0.8] text-right'>
            性能
          </HeadCell>
        ) : null}
        {show('stop') ? (
          <HeadCell className='min-w-[72px] flex-[0.7]'>结束原因</HeadCell>
        ) : null}
        {showIngress ? (
          <>
            <HeadCell className='min-w-[110px] flex-[1.1]'>入站 Key</HeadCell>
            <HeadCell className='min-w-[90px] flex-[0.8]'>IP</HeadCell>
          </>
        ) : null}
        <HeadCell className='min-w-[100px] flex-[1]'>状态</HeadCell>
        <div className='min-w-[48px] flex-[0.4] pr-3' />
      </div>
    </div>
  )
}

export function LogRow({
  row,
  vm,
  onOpenDetail,
  showIngress,
  hidden,
  highlighted,
  className,
}: {
  row: RequestLogItem
  vm?: Vm
  onOpenDetail: (id: string) => void
  showIngress?: boolean
  hidden?: readonly HideableLogColumn[]
  highlighted?: boolean
  className?: string
}) {
  const rid = logRowId(row)
  const show = (id: HideableLogColumn) => columnVisible(hidden, id)
  const requested = row.requested_model || row.model
  const mismatch = showModelRedirect(row)
  const cacheWrite = Number(row.cache_creation_tokens) || 0
  const cacheRead = Number(row.cache_read_tokens) || 0
  const cost = rowCost(row)
  const failed =
    statusBadge(row.status).tone === 'bad' || Boolean(row.error_class)
  const open = () => {
    if (rid) onOpenDetail(rid)
  }

  return (
    <div
      role='button'
      tabIndex={0}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          open()
        }
      }}
      className={cn(
        'flex h-13 cursor-pointer items-center text-sm transition-colors hover:bg-accent/50',
        failed && 'bg-muted/30 dark:bg-muted/15',
        highlighted && 'animate-log-highlight-flash',
        className
      )}
    >
      <div className='min-w-[56px] flex-[0.6] truncate pl-3 font-mono text-xs'>
        {fmtLogTime(row.ts ?? row.created_at)}
      </div>
      <div className='flex min-w-[100px] flex-[1.3] items-center gap-1.5 px-1.5 font-mono text-xs'>
        <ModelVendorIcon modelId={String(requested || row.model || '')} />
        <Tooltip>
          <TooltipTrigger asChild>
            <span className='truncate'>
              {String(requested || '—')}
              {mismatch && row.upstream_model ? ` → ${row.upstream_model}` : ''}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            请求 {String(row.requested_model || row.model || '—')}
            {row.upstream_model ? ` · 上游 ${row.upstream_model}` : ''}
          </TooltipContent>
        </Tooltip>
        <RedirectBadge row={row} />
      </div>
      {show('account') ? (
        <div className='min-w-[160px] flex-[1.4] truncate px-1.5 text-xs'>
          <SlotIdentity
            vm={vm}
            vmId={row.vm_id}
            model={row.requested_model || row.model}
            protocol={row.protocol == null ? undefined : String(row.protocol)}
            emptyLabel={UNASSIGNED_EXECUTION}
          />
        </div>
      ) : null}
      {show('tokens') ? (
        <div className='min-w-[70px] flex-[0.7] px-1.5 text-right font-mono text-xs leading-tight tabular-nums'>
          <div>{fmtNum(row.input_tokens || 0)}</div>
          <div className='text-muted-foreground'>
            {fmtNum(row.output_tokens || 0)}
          </div>
        </div>
      ) : null}
      {show('cache') ? (
        <div className='flex min-w-[70px] flex-[0.8] items-center justify-end gap-1 px-1.5 text-right font-mono text-xs leading-tight text-muted-foreground tabular-nums'>
          <div>
            <div>{cacheWrite > 0 ? fmtNum(cacheWrite) : '—'}</div>
            <div>{cacheRead > 0 ? fmtNum(cacheRead) : '—'}</div>
          </div>
          <CacheBadge write={cacheWrite} read={cacheRead} />
        </div>
      ) : null}
      {show('cost') ? (
        <div className='flex min-w-[56px] flex-[0.6] items-center justify-end gap-1 px-1.5 font-mono text-xs tabular-nums'>
          <span>{cost == null ? '—' : fmtUsd(cost)}</span>
          <RateMultiplierBadge row={row} />
        </div>
      ) : null}
      {show('perf') ? (
        <div className='min-w-[80px] flex-[0.8] truncate px-1.5 text-right font-mono text-xs tabular-nums'>
          {fmtPerf(row)}
        </div>
      ) : null}
      {show('stop') ? (
        <div className='min-w-[72px] flex-[0.7] truncate px-1.5 font-mono text-xs text-muted-foreground'>
          {String(row.stop_reason || '—')}
        </div>
      ) : null}
      {showIngress ? (
        <>
          {/* 明文不可回显：只渲染掩码结果，不设 title、不提供复制。 */}
          <div className='min-w-[110px] flex-[1.1] truncate px-1.5 font-mono text-xs'>
            {row.api_key_presented
              ? maskPresentedKey(row.api_key_presented)
              : '—'}
          </div>
          <div className='min-w-[90px] flex-[0.8] truncate px-1.5 font-mono text-xs text-muted-foreground'>
            {String(row.ip || '—')}
          </div>
        </>
      ) : null}
      <div className='flex min-w-[100px] flex-[1] flex-wrap items-center gap-1 px-1.5'>
        <StatusBadges row={row} />
      </div>
      <div className='min-w-[48px] flex-[0.4] pr-3'>
        <Button
          size='sm'
          variant='ghost'
          onClick={(event) => {
            event.stopPropagation()
            open()
          }}
        >
          详情
        </Button>
      </div>
    </div>
  )
}

export function LogsTable({
  items,
  vms,
  onOpenDetail,
  showIngress,
  hidden,
}: {
  items: RequestLogItem[]
  vms?: Map<string, Vm>
  onOpenDetail: (id: string) => void
  /**
   * 入站 Key / IP 两列只在筛选 `error_class === 'auth'` 时出现 ——
   * 后端也只在入站鉴权失败时才写这两个字段，平时全是空列。
   */
  showIngress?: boolean
  hidden?: readonly HideableLogColumn[]
}) {
  return (
    <div className='overflow-x-auto'>
      <div className='min-w-[960px]'>
        <LogsTableHeader showIngress={showIngress} hidden={hidden} />
        <div className='divide-y divide-border/40'>
          {items.length === 0 ? (
            <div className='flex h-24 items-center justify-center text-sm text-muted-foreground'>
              没有匹配的请求
            </div>
          ) : (
            items.map((row) => (
              <LogRow
                key={logRowId(row)}
                row={row}
                vm={row.vm_id ? vms?.get(String(row.vm_id)) : undefined}
                onOpenDetail={onOpenDetail}
                showIngress={showIngress}
                hidden={hidden}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
