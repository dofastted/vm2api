import type { UsageLogRow } from '@/types/panel-usage-logs'
import { ArrowRight, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ModelVendorIcon } from '@/components/model-vendor-icon'
import {
  copyText,
  livePhaseBadgeClass,
  livePhaseLabel,
  resolveModelAuditDisplay,
  statusBadgeClass,
  statusBadgeTooltip,
  thinkingEffortBadgeClass,
} from './log-display'

export function StatusBadge({
  statusCode,
  finalState = null,
  errorCode = null,
  inFlight = false,
  livePhase = null,
  attemptCount = null,
  className,
}: {
  statusCode: number | null
  finalState?: string | null
  errorCode?: string | null
  inFlight?: boolean
  livePhase?: string | null
  attemptCount?: number | null
  className?: string
}) {
  if (inFlight) {
    const phaseText = livePhaseLabel(livePhase)
    const liveBadge = (
      <Badge
        variant='outline'
        data-in-flight='true'
        data-live-phase={livePhase ?? undefined}
        className={cn(
          'inline-flex items-center gap-1 whitespace-nowrap',
          livePhaseBadgeClass(livePhase),
          className
        )}
      >
        <Loader2 className='h-3 w-3 shrink-0 animate-spin' />
        <span>{phaseText}</span>
      </Badge>
    )
    const liveTip =
      attemptCount != null && attemptCount > 1
        ? `请求进行中 · ${phaseText}（第 ${attemptCount} 次尝试）`
        : `请求进行中 · ${phaseText}`
    return (
      <Tooltip delayDuration={250}>
        <TooltipTrigger asChild>
          <span className='inline-flex'>{liveBadge}</span>
        </TooltipTrigger>
        <TooltipContent className='max-w-xs text-xs'>{liveTip}</TooltipContent>
      </Tooltip>
    )
  }
  const badge = (
    <Badge
      variant='outline'
      className={cn(statusBadgeClass(statusCode, finalState), className)}
    >
      {statusCode ?? '未知'}
    </Badge>
  )
  const title = statusBadgeTooltip(statusCode, finalState, errorCode)
  if (!title) return badge
  return (
    <Tooltip delayDuration={250}>
      <TooltipTrigger asChild>
        <span className='inline-flex'>{badge}</span>
      </TooltipTrigger>
      <TooltipContent className='max-w-xs text-xs'>{title}</TooltipContent>
    </Tooltip>
  )
}

export function ThinkingEffortBadge({ effort }: { effort: string }) {
  return (
    <Badge
      variant='outline'
      className={cn(
        'w-fit px-1 text-[10px] leading-tight whitespace-nowrap',
        thinkingEffortBadgeClass(effort)
      )}
    >
      {effort}
    </Badge>
  )
}

/**
 * 思考强度。出站 envelope 上的等级：调用方写了就用调用方的，
 * 否则是模型缺省（面板 default_effort，没有则目录缺省）。off 不显示。
 */
export function ThinkingEffortDisplay({ effort }: { effort: string | null }) {
  if (!effort) return <span className='text-muted-foreground'>-</span>
  return (
    <Tooltip delayDuration={250}>
      <TooltipTrigger asChild>
        <span
          className='relative z-20 inline-flex items-center gap-1 whitespace-nowrap'
          data-slot='thinking-effort'
        >
          <ThinkingEffortBadge effort={effort} />
        </span>
      </TooltipTrigger>
      <TooltipContent className='max-w-xs space-y-1'>
        <p className='text-xs'>
          实际发往槽位的思考强度。调用方带了 effort
          用调用方的；没带则显示模型缺省。不补（off）为空。
        </p>
      </TooltipContent>
    </Tooltip>
  )
}

export function ModelDisplayWithRedirect({
  row,
  onRedirectClick,
}: {
  row: UsageLogRow
  onRedirectClick: () => void
}) {
  const audit = resolveModelAuditDisplay(row)
  const model = audit.primaryBillingModel
  return (
    <div className='flex min-w-0 flex-col'>
      <div className='flex min-w-0 items-center gap-1.5'>
        {model ? <ModelVendorIcon modelId={model} /> : null}
        <span
          className='cursor-pointer truncate hover:underline'
          onClick={(event) => {
            event.stopPropagation()
            if (model) void copyText(model)
          }}
        >
          {model || '-'}
        </span>
        {audit.hasRedirect ? (
          <Badge
            variant='outline'
            className='shrink-0 cursor-pointer border-blue-300 px-1 text-xs text-blue-700 dark:border-blue-700 dark:text-blue-300'
            onClick={(event) => {
              event.stopPropagation()
              onRedirectClick()
            }}
          >
            <ArrowRight className='h-3 w-3' />
          </Badge>
        ) : null}
      </div>
      {audit.secondaryActualModel ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className='flex cursor-help items-center gap-1 truncate text-xs text-muted-foreground'>
              ↳ {audit.secondaryActualModel}
            </div>
          </TooltipTrigger>
          <TooltipContent className='max-w-xs'>
            上游实际返回的模型与请求的模型不一致。计费仍然基于请求模型。
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  )
}
