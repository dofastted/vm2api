import type { RequestLogItem } from '@/types/panel-logs'
import type { Vm } from '@/types/panel-vm'
import { fmtNum, fmtTok } from '@/lib/format'
import { maskPresentedKey } from '@/lib/log-mute'
import { errorClassTone, statusTone } from '@/lib/log-tone'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { SlotIdentity } from '@/components/platform-chip'
import { StatusMark } from '@/components/status-mark'

/** 后端时间字段是 `ts`（ISO），不是 `created_at` —— 表里只显示 HH:MM:SS。 */
function fmtLogTime(value: unknown): string {
  if (!value) return '—'
  const t = new Date(String(value))
  return Number.isFinite(t.getTime())
    ? t.toTimeString().slice(0, 8)
    : String(value)
}

export function logRowId(row: RequestLogItem): string {
  return String(row.request_id || row.id || '')
}

export function LogsTableHeader({ showIngress }: { showIngress?: boolean }) {
  return (
    <div className='sticky top-0 z-10 border-b bg-muted/30'>
      <div className='flex h-8 items-center text-[11px] font-medium tracking-wide text-muted-foreground/80'>
        <div className='min-w-[56px] flex-[0.7] truncate pl-3'>时间</div>
        <div className='min-w-[100px] flex-[1.3] truncate px-1.5'>模型</div>
        <div className='min-w-[160px] flex-[1.4] truncate px-1.5'>账号</div>
        <div className='min-w-[70px] flex-[0.7] truncate px-1.5 text-right'>
          Tokens
        </div>
        <div className='min-w-[60px] flex-[0.6] truncate px-1.5 text-right'>
          缓存
        </div>
        <div className='min-w-[80px] flex-[0.8] truncate px-1.5 text-right'>
          性能
        </div>
        <div className='min-w-[90px] flex-[0.9] truncate px-1.5'>结束原因</div>
        {showIngress ? (
          <>
            <div className='min-w-[110px] flex-[1.1] truncate px-1.5'>
              入站 Key
            </div>
            <div className='min-w-[90px] flex-[0.9] truncate px-1.5'>IP</div>
          </>
        ) : null}
        <div className='min-w-[100px] flex-[1] truncate px-1.5'>状态</div>
        <div className='min-w-[56px] flex-[0.5] truncate pr-3'></div>
      </div>
    </div>
  )
}

export function LogRow({
  row,
  vm,
  onOpenDetail,
  showIngress,
  highlighted,
  className,
}: {
  row: RequestLogItem
  vm?: Vm
  onOpenDetail: (id: string) => void
  showIngress?: boolean
  highlighted?: boolean
  className?: string
}) {
  const rid = logRowId(row)
  const requested = row.requested_model || row.model
  const mismatch =
    row.requested_model &&
    row.upstream_model &&
    row.requested_model !== row.upstream_model
  const errTone = errorClassTone(row)
  const isError = !!errTone || row.status === 'error'
  const cacheTotal =
    (Number(row.cache_read_tokens) || 0) +
    (Number(row.cache_creation_tokens) || 0)
  return (
    <div
      className={cn(
        'flex h-13 items-center text-sm transition-colors hover:bg-accent/50',
        isError && 'bg-muted/30 dark:bg-muted/15',
        highlighted && 'animate-log-highlight-flash',
        className
      )}
    >
      <div className='min-w-[56px] flex-[0.7] truncate pl-3 font-mono text-xs'>
        {fmtLogTime(row.ts ?? row.created_at)}
      </div>
      <div className='min-w-[100px] flex-[1.3] truncate px-1.5 font-mono text-xs'>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className='cursor-help'>
              {String(requested || '—')}
              {mismatch ? ` → ${row.upstream_model}` : ''}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            请求 {String(row.requested_model || row.model || '—')}
            {row.upstream_model ? ` · 上游 ${row.upstream_model}` : ''}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className='min-w-[160px] flex-[1.4] truncate px-1.5 text-xs'>
        <SlotIdentity
          vm={vm}
          vmId={row.vm_id}
          model={row.requested_model || row.model}
          protocol={row.protocol == null ? undefined : String(row.protocol)}
        />
      </div>
      <div className='min-w-[70px] flex-[0.7] truncate px-1.5 text-right font-mono text-xs tabular-nums'>
        {fmtTok(row)}
      </div>
      <div className='min-w-[60px] flex-[0.6] truncate px-1.5 text-right font-mono text-xs text-muted-foreground tabular-nums'>
        {cacheTotal > 0 ? fmtNum(cacheTotal) : '—'}
      </div>
      <div className='min-w-[80px] flex-[0.8] truncate px-1.5 text-right font-mono text-xs tabular-nums'>
        {row.first_token_ms != null ? `${row.first_token_ms}ms` : '—'}
      </div>
      <div className='min-w-[90px] flex-[0.9] truncate px-1.5 font-mono text-xs text-muted-foreground'>
        {String(row.stop_reason || '—')}
      </div>
      {showIngress ? (
        <>
          {/* 明文不可回显：只渲染掩码结果，不设 title、不提供复制。 */}
          <div className='min-w-[110px] flex-[1.1] truncate px-1.5 font-mono text-xs'>
            {row.api_key_presented
              ? maskPresentedKey(row.api_key_presented)
              : '—'}
          </div>
          <div className='min-w-[90px] flex-[0.9] truncate px-1.5 font-mono text-xs text-muted-foreground'>
            {String(row.ip || '—')}
          </div>
        </>
      ) : null}
      <div className='flex min-w-[100px] flex-[1] flex-wrap items-center gap-1 truncate px-1.5'>
        <StatusMark tone={statusTone(row.status)} />
        {errTone ? <StatusMark tone={errTone} /> : null}
      </div>
      <div className='min-w-[56px] flex-[0.5] pr-3'>
        <Button size='sm' variant='ghost' onClick={() => onOpenDetail(rid)}>
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
}: {
  items: RequestLogItem[]
  vms?: Map<string, Vm>
  onOpenDetail: (id: string) => void
  /**
   * 入站 Key / IP 两列只在筛选 `error_class === 'auth'` 时出现 ——
   * 后端也只在入站鉴权失败时才写这两个字段，平时全是空列。
   */
  showIngress?: boolean
}) {
  return (
    <div className='overflow-x-auto'>
      <div className='min-w-[900px]'>
        <LogsTableHeader showIngress={showIngress} />
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
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
