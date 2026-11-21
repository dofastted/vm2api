import type { ProviderChainItem, UsageLogRow } from '@/types/panel-usage-logs'
import { CheckCircle, InfoIcon, Link2, RefreshCw, XCircle } from 'lucide-react'
import { formatDuration } from '@/lib/usage-format'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  chainItemName,
  chainItemStatus,
  effectiveMultiplier,
  finalProviderName,
  isSuccessStatus,
  multiplierBadgeClass,
  selectionReasonLabel,
  terminalStateLabel,
  type ChainItemStatus,
} from './log-display'

const STATUS_STYLE: Record<
  ChainItemStatus,
  { icon: typeof CheckCircle; color: string; bg: string }
> = {
  success: {
    icon: CheckCircle,
    color: 'text-emerald-600',
    bg: 'bg-emerald-50 dark:bg-emerald-950/30',
  },
  failure: {
    icon: XCircle,
    color: 'text-rose-600',
    bg: 'bg-rose-50 dark:bg-rose-950/30',
  },
  pending: {
    icon: RefreshCw,
    color: 'text-slate-500',
    bg: 'bg-slate-50 dark:bg-slate-800/50',
  },
}

function UpstreamStatusBadge({ code }: { code: number }) {
  return (
    <Badge
      variant='outline'
      className={cn(
        'px-1 py-0 text-[10px]',
        isSuccessStatus(code)
          ? 'border-emerald-500 text-emerald-600'
          : 'border-rose-500 text-rose-600'
      )}
    >
      {code}
    </Badge>
  )
}

function attemptMeta(item: ProviderChainItem): string[] {
  const parts: string[] = []
  const reason = selectionReasonLabel(item.selectionReason)
  if (reason) parts.push(reason)
  if (item.latencyMs != null) parts.push(formatDuration(item.latencyMs))
  if (item.ttftMs != null) parts.push(`TTFT ${formatDuration(item.ttftMs)}`)
  return parts
}

/** 单次请求：tooltip 而非 popover（hub Branch B）。粘性命中对应 hub 的会话复用图标。 */
function SingleAttempt({
  name,
  item,
}: {
  name: string
  item: ProviderChainItem | undefined
}) {
  const sticky = item?.selectionReason === 'sticky'
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <span className='flex min-w-0 cursor-help items-center gap-1'>
          <span className='min-w-0 truncate'>{name}</span>
          {sticky ? (
            <Link2 className='h-3 w-3 shrink-0 text-violet-500' />
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent side='bottom' align='start' className='max-w-[320px]'>
        <div className='space-y-2'>
          <div className='text-xs font-medium'>{name}</div>
          {item?.upstreamStatus ? (
            <div className='flex items-center gap-1'>
              <UpstreamStatusBadge code={item.upstreamStatus} />
            </div>
          ) : null}
          {item ? (
            <div className='grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]'>
              {item.providerName ? (
                <span className='col-span-2'>
                  <span className='opacity-70'>账号 </span>
                  {item.providerName}
                </span>
              ) : null}
              {selectionReasonLabel(item.selectionReason) ? (
                <span>
                  <span className='opacity-70'>选择方式 </span>
                  {selectionReasonLabel(item.selectionReason)}
                </span>
              ) : null}
              {item.latencyMs != null ? (
                <span>
                  <span className='opacity-70'>耗时 </span>
                  {formatDuration(item.latencyMs)}
                </span>
              ) : null}
              {item.queueWaitMs != null ? (
                <span>
                  <span className='opacity-70'>排队 </span>
                  {formatDuration(item.queueWaitMs)}
                </span>
              ) : null}
              {item.waitMs ? (
                <span>
                  <span className='opacity-70'>调度总耗时 </span>
                  {formatDuration(item.waitMs)}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * 供应商单元格 + 决策链 popover（hub `ProviderChainPopover` 的串行重试分支）。
 * vm2api 的每条 request_attempts 都是一次真实上游请求，按 attemptNumber 排序。
 */
export function ProviderChainPopover({
  row,
  onChainItemClick,
}: {
  row: UsageLogRow
  onChainItemClick: (index: number) => void
}) {
  const chain = row.providerChain
  const name = finalProviderName(row)
  if (chain.length <= 1) return <SingleAttempt name={name} item={chain[0]} />

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant='ghost'
          className='h-auto w-full min-w-0 p-0 font-normal hover:bg-transparent'
          aria-label={`${name} - ${chain.length}次`}
        >
          <span className='flex w-full min-w-0 items-center gap-1'>
            <span className='min-w-0 truncate'>{name}</span>
            <Badge variant='secondary' className='shrink-0 px-1 text-[10px]'>
              {chain.length}次
            </Badge>
            <InfoIcon className='h-3 w-3 shrink-0 text-muted-foreground' />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className='w-[360px] max-w-[calc(100vw-2rem)] p-0'
        align='start'
      >
        <div className='border-b p-3'>
          <div className='flex items-center justify-between'>
            <h4 className='flex items-center gap-1.5 text-sm font-semibold'>
              虚拟机决策链
            </h4>
            <Badge variant='outline' className='text-[10px]'>
              {chain.length} 次
            </Badge>
          </div>
        </div>
        <div className='max-h-[300px] space-y-0 overflow-y-auto p-3'>
          {chain.map((item, index) => {
            const style = STATUS_STYLE[chainItemStatus(item)]
            const Icon = style.icon
            const isLast = index === chain.length - 1
            const terminal = terminalStateLabel(item.terminalState)
            return (
              <div
                key={`${item.attemptNumber}-${index}`}
                role='button'
                tabIndex={0}
                className='relative -m-1 flex cursor-pointer gap-2 rounded-md p-1 transition-colors hover:bg-muted/50'
                onClick={() => onChainItemClick(index)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onChainItemClick(index)
                  }
                }}
              >
                <div className='flex flex-col items-center'>
                  <div
                    className={cn(
                      'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border',
                      style.bg
                    )}
                  >
                    <Icon className={cn('h-3 w-3', style.color)} />
                  </div>
                  {!isLast ? (
                    <div className='min-h-[8px] w-0.5 flex-1 bg-border' />
                  ) : null}
                </div>
                <div className={cn('min-w-0 flex-1 pb-3', isLast && 'pb-0')}>
                  <div className='flex items-center gap-2'>
                    <span className='truncate text-xs font-medium'>
                      {chainItemName(item)}
                    </span>
                    {item.upstreamStatus ? (
                      <UpstreamStatusBadge code={item.upstreamStatus} />
                    ) : terminal ? (
                      <span className='text-[10px] text-muted-foreground'>
                        {terminal}
                      </span>
                    ) : null}
                  </div>
                  {attemptMeta(item).length ? (
                    <p className='mt-0.5 line-clamp-1 text-[10px] text-muted-foreground'>
                      {attemptMeta(item).join(' · ')}
                    </p>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
        <div className='border-t bg-muted/30 p-2'>
          <p className='text-center text-[10px] text-muted-foreground'>
            点击步骤查看详情
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** 供应商列：被拦截 chip → 决策链 + 分组倍率 chip。 */
export function ProviderCell({
  row,
  onChainItemClick,
}: {
  row: UsageLogRow
  onChainItemClick: (index: number) => void
}) {
  if (row.blockedBy) {
    return (
      <span
        className='inline-flex items-center gap-1 rounded-md bg-orange-100 px-2 py-1 text-xs font-medium text-orange-700 dark:bg-orange-950 dark:text-orange-300'
        title={row.blockedReason ?? row.blockedBy}
      >
        <span className='h-1.5 w-1.5 rounded-full bg-orange-600 dark:bg-orange-400' />
        被拦截
      </span>
    )
  }
  const multiplier = effectiveMultiplier(row.groupCostMultiplier)
  return (
    <div className='flex min-w-0 flex-col items-start gap-0.5'>
      <div className='flex w-full min-w-0 items-center gap-1 overflow-hidden'>
        <div className='min-w-0 flex-1 overflow-hidden'>
          <ProviderChainPopover row={row} onChainItemClick={onChainItemClick} />
        </div>
        {multiplier != null ? (
          <Badge
            variant='outline'
            className={cn(
              'shrink-0 px-1 py-0 text-[10px]',
              multiplierBadgeClass(multiplier)
            )}
            title='分组倍率'
          >
            x{multiplier.toFixed(2)}
          </Badge>
        ) : null}
      </div>
    </div>
  )
}
