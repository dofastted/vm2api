import { useEffect } from 'react'
import { Link } from '@tanstack/react-router'
import type { UsageLogRow } from '@/types/panel-usage-logs'
import {
  AlertCircle,
  ArrowRight,
  CheckCircle,
  Clock,
  DatabaseZap,
  DollarSign,
  Globe,
  InfoIcon,
  Monitor,
  Settings2,
  Zap,
} from 'lucide-react'
import {
  calculateOutputRate,
  formatCurrency,
  formatDuration,
  formatTokenAmount,
} from '@/lib/usage-format'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ThinkingEffortBadge } from '../log-cells'
import {
  actualCacheRate,
  cacheCostSplit,
  cacheWriteSplit,
  effectiveMultiplier,
  hasFastMode,
  isSuccessStatus,
  resolveModelAuditDisplay,
} from '../log-display'

function SectionTitle({
  icon: Icon,
  color,
  children,
}: {
  icon: typeof Zap
  color: string
  children: React.ReactNode
}) {
  return (
    <h4 className='flex items-center gap-2 text-sm font-semibold'>
      <Icon className={cn('h-4 w-4', color)} />
      {children}
    </h4>
  )
}

function MetricCard({
  icon: Icon,
  iconClass,
  bgClass,
  label,
  value,
}: {
  icon: typeof Zap
  iconClass: string
  bgClass: string
  label: string
  value: string
}) {
  return (
    <div className='flex items-center gap-3 rounded-lg border bg-card p-3'>
      <div
        className={cn(
          'flex h-9 w-9 items-center justify-center rounded-lg',
          bgClass
        )}
      >
        <Icon className={cn('h-4 w-4', iconClass)} />
      </div>
      <div>
        <div className='text-xs text-muted-foreground'>{label}</div>
        <div className='font-mono text-sm font-semibold'>{value}</div>
      </div>
    </div>
  )
}

function BillingRow({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex justify-between gap-3', className)}>
      <span className='text-muted-foreground'>{label}:</span>
      <span className='text-right font-mono'>{children}</span>
    </div>
  )
}

function Cost({ value }: { value: number | null | undefined }) {
  if (value == null || value <= 0) return null
  return (
    <span className='ml-3 text-muted-foreground'>
      {formatCurrency(value, 6)}
    </span>
  )
}

/** 「概览」：hub SummaryTab 的各区块，按 vm2api 实有字段取舍。 */
export function SummaryTab({
  row,
  scrollToRedirect,
}: {
  row: UsageLogRow
  scrollToRedirect: boolean
}) {
  const audit = resolveModelAuditDisplay(row)
  const success = isSuccessStatus(row.statusCode)
  const rate = calculateOutputRate(row.outputTokens, row.generationMs)
  const totalTokens = row.totalTokens
  const breakdown = row.costBreakdown
  const tokenSplit = cacheWriteSplit({
    total: row.cacheCreationInputTokens,
    fiveM: row.cacheCreation5mInputTokens,
    oneH: row.cacheCreation1hInputTokens,
    ttl: row.cacheTtlApplied,
  })
  const costSplit = cacheCostSplit(
    breakdown?.cacheCreation ?? null,
    tokenSplit,
    row.cacheTtlApplied
  )
  const multiplier = effectiveMultiplier(
    breakdown?.groupMultiplier ?? row.groupCostMultiplier
  )
  const cacheRate = actualCacheRate(row)
  const totalCost = row.actualCostUsd ?? row.costUsd

  useEffect(() => {
    if (!scrollToRedirect) return
    const id = setTimeout(() => {
      document
        .getElementById('model-redirect-section')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 100)
    return () => clearTimeout(id)
  }, [scrollToRedirect])

  return (
    <div className='space-y-6'>
      <div
        className={cn(
          'flex items-center gap-4 rounded-lg border p-4',
          success
            ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/20'
            : 'border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/20'
        )}
      >
        <div
          className={cn(
            'flex h-12 w-12 items-center justify-center rounded-full',
            success
              ? 'bg-emerald-100 dark:bg-emerald-900/30'
              : 'bg-rose-100 dark:bg-rose-900/30'
          )}
        >
          {success ? (
            <CheckCircle className='h-6 w-6 text-emerald-600' />
          ) : (
            <AlertCircle className='h-6 w-6 text-rose-600' />
          )}
        </div>
        <div>
          <div className='flex items-center gap-2'>
            <span className='text-lg font-semibold'>
              {row.statusCode ?? '未知'}
            </span>
            {row.statusCode != null ? (
              <Badge
                variant={success ? 'default' : 'destructive'}
                className='text-xs'
              >
                {success ? 'OK' : 'Error'}
              </Badge>
            ) : null}
            {row.errorLabel ? (
              <Badge variant='outline' className='text-xs'>
                {row.errorLabel}
              </Badge>
            ) : null}
          </div>
          <p className='text-sm text-muted-foreground'>
            {success
              ? '请求成功完成'
              : '请求失败，以下是详细的错误信息和虚拟机决策链'}
          </p>
        </div>
      </div>

      {row.costUsd != null ||
      totalTokens > 0 ||
      row.durationMs != null ||
      rate != null ? (
        <div className='space-y-2'>
          <h4 className='text-sm font-semibold text-muted-foreground'>
            关键指标
          </h4>
          <div className='grid grid-cols-2 gap-3'>
            {totalCost != null ? (
              <MetricCard
                icon={DollarSign}
                iconClass='text-emerald-600'
                bgClass='bg-emerald-100 dark:bg-emerald-900/30'
                label='总费用'
                value={formatCurrency(totalCost, 6)}
              />
            ) : null}
            {totalTokens > 0 ? (
              <MetricCard
                icon={Zap}
                iconClass='text-blue-600'
                bgClass='bg-blue-100 dark:bg-blue-900/30'
                label='总令牌数'
                value={formatTokenAmount(totalTokens)}
              />
            ) : null}
            {row.durationMs != null ? (
              <MetricCard
                icon={Clock}
                iconClass='text-purple-600'
                bgClass='bg-purple-100 dark:bg-purple-900/30'
                label='耗时'
                value={formatDuration(row.durationMs)}
              />
            ) : null}
            {rate != null ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <MetricCard
                      icon={Zap}
                      iconClass='text-amber-600'
                      bgClass='bg-amber-100 dark:bg-amber-900/30'
                      label='输出速率'
                      value={`${rate.toFixed(1)} tok/s`}
                    />
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  输出 tokens / 上游输出窗口（含不可见推理）
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </div>
      ) : null}

      {cacheRate != null &&
      row.cacheReadInputTokens + (row.cacheCreationInputTokens ?? 0) > 0 ? (
        <div className='space-y-2'>
          <SectionTitle icon={DatabaseZap} color='text-cyan-600'>
            缓存表现
          </SectionTitle>
          <div className='grid grid-cols-1 gap-3 sm:grid-cols-3'>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className='cursor-help rounded-lg border bg-card p-3'>
                  <div className='text-xs text-muted-foreground'>
                    实际缓存率
                  </div>
                  <div className='font-mono text-sm font-semibold'>
                    {(cacheRate * 100).toFixed(1)}%
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent>
                缓存读取 / 输入侧总量（输入 + 缓存读 + 缓存写）
              </TooltipContent>
            </Tooltip>
            <div className='rounded-lg border bg-card p-3'>
              <div className='text-xs text-muted-foreground'>缓存读取</div>
              <div className='font-mono text-sm font-semibold'>
                {formatTokenAmount(row.cacheReadInputTokens)}
              </div>
            </div>
            <div className='rounded-lg border bg-card p-3'>
              <div className='text-xs text-muted-foreground'>缓存写入</div>
              <div className='font-mono text-sm font-semibold'>
                {formatTokenAmount(row.cacheCreationInputTokens)}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {row.sessionId ||
      row.clientSessionId ||
      row.inboundDeviceId ||
      row.reasoningEffort ||
      row.requestId ? (
        <div className='space-y-2'>
          <h4 className='text-sm font-semibold'>会话信息</h4>
          <div className='divide-y rounded-lg border bg-card'>
            {row.sessionId ? (
              <div className='flex items-center gap-2 p-4'>
                <span className='shrink-0 text-xs text-muted-foreground'>
                  出站 Session
                </span>
                <Link
                  to='/logs'
                  search={{ sessionId: row.sessionId }}
                  className='min-w-0 truncate font-mono text-xs underline-offset-2 hover:underline'
                >
                  {row.sessionId}
                </Link>
              </div>
            ) : null}
            {row.clientSessionId && row.clientSessionId !== row.sessionId ? (
              <div className='flex items-center gap-2 p-4'>
                <span className='shrink-0 text-xs text-muted-foreground'>
                  客户端 Session
                </span>
                <Link
                  to='/logs'
                  search={{ sessionId: row.clientSessionId }}
                  className='min-w-0 truncate font-mono text-xs text-muted-foreground underline-offset-2 hover:underline'
                >
                  {row.clientSessionId}
                </Link>
              </div>
            ) : null}
            {row.inboundDeviceId ? (
              <div className='flex items-center gap-2 p-4'>
                <span className='shrink-0 text-xs text-muted-foreground'>
                  Device ID
                </span>
                <span className='min-w-0 truncate font-mono text-xs'>
                  {row.inboundDeviceId}
                </span>
              </div>
            ) : null}
            {row.requestId ? (
              <div className='flex items-center gap-2 p-4'>
                <span className='shrink-0 text-xs text-muted-foreground'>
                  Request ID
                </span>
                <span className='min-w-0 truncate font-mono text-xs'>
                  {row.requestId}
                </span>
              </div>
            ) : null}
            {row.reasoningEffort ? (
              <div className='flex items-center gap-2 p-4'>
                <span className='shrink-0 text-xs text-muted-foreground'>
                  思考强度
                </span>
                <ThinkingEffortBadge effort={row.reasoningEffort} />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {row.userAgent || row.endpoint || row.clientIp ? (
        <div className='space-y-2'>
          <SectionTitle icon={Monitor} color='text-blue-600'>
            客户端信息
          </SectionTitle>
          <div className='divide-y rounded-lg border bg-card'>
            {row.clientIp ? (
              <div className='flex items-center justify-between gap-3 p-3'>
                <span className='text-xs text-muted-foreground'>IP</span>
                <code className='font-mono text-xs'>{row.clientIp}</code>
              </div>
            ) : null}
            {row.userAgent ? (
              <div className='space-y-1 p-3'>
                <span className='text-xs text-muted-foreground'>
                  User-Agent
                </span>
                <code className='block font-mono text-xs break-all'>
                  {row.userAgent}
                </code>
              </div>
            ) : null}
            {row.endpoint ? (
              <div className='flex items-center justify-between gap-3 p-3'>
                <span className='flex items-center gap-1 text-xs text-muted-foreground'>
                  <Globe className='h-3 w-3' />
                  Endpoint
                </span>
                <code className='font-mono text-xs'>
                  {row.method ? `${row.method} ` : ''}
                  {row.endpoint}
                </code>
              </div>
            ) : null}
            {row.protocol ? (
              <div className='flex items-center justify-between gap-3 p-3'>
                <span className='text-xs text-muted-foreground'>协议</span>
                <code className='font-mono text-xs'>{row.protocol}</code>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {row.costUsd != null ? (
        <div className='space-y-2'>
          <SectionTitle icon={DollarSign} color='text-emerald-600'>
            计费信息
          </SectionTitle>
          <div className='space-y-3 rounded-lg border bg-card p-4'>
            <div className='space-y-2 text-sm'>
              <BillingRow label='输入'>
                {formatTokenAmount(row.inputTokens)} tokens
                <Cost value={breakdown?.input} />
              </BillingRow>
              <BillingRow label='输出'>
                {formatTokenAmount(row.outputTokens)} tokens
                <Cost value={breakdown?.output} />
              </BillingRow>
              {tokenSplit.fiveM > 0 ? (
                <BillingRow label='缓存写入 (5m)'>
                  {formatTokenAmount(tokenSplit.fiveM)} tokens{' '}
                  <span className='text-orange-600'>(1.25x)</span>
                  <Cost value={costSplit.fiveM} />
                </BillingRow>
              ) : null}
              {tokenSplit.oneH > 0 ? (
                <BillingRow label='缓存写入 (1h)'>
                  {formatTokenAmount(tokenSplit.oneH)} tokens{' '}
                  <span className='text-orange-600'>(2x)</span>
                  <Cost value={costSplit.oneH} />
                </BillingRow>
              ) : null}
              {row.cacheReadInputTokens > 0 ? (
                <BillingRow label='缓存读取'>
                  {formatTokenAmount(row.cacheReadInputTokens)} tokens{' '}
                  <span className='text-emerald-600'>(0.1x)</span>
                  <Cost value={breakdown?.cacheRead} />
                </BillingRow>
              ) : null}
              {row.cacheTtlApplied ? (
                <BillingRow label='缓存 TTL'>
                  <Badge variant='outline' className='text-xs'>
                    {row.cacheTtlApplied}
                  </Badge>
                </BillingRow>
              ) : null}
              {row.context1mApplied ? (
                <BillingRow label='1M 上下文'>
                  <Badge
                    variant='outline'
                    className='border-purple-200 bg-purple-50 text-xs text-purple-700 dark:border-purple-800 dark:bg-purple-950/30 dark:text-purple-300'
                  >
                    1M Context
                  </Badge>{' '}
                  <span className='text-xs text-muted-foreground'>
                    (1M 上下文窗口已启用)
                  </span>
                </BillingRow>
              ) : null}
              {hasFastMode(row) ? (
                <BillingRow label='fast'>
                  <Badge
                    variant='outline'
                    className='border-orange-200 bg-orange-50 text-xs text-orange-700 dark:border-orange-800 dark:bg-orange-950/30 dark:text-orange-300'
                  >
                    优先服务等级（fast 模式）
                  </Badge>
                </BillingRow>
              ) : null}
              {breakdown?.pricingModel ? (
                <BillingRow label='计价模型'>
                  {breakdown.pricingModel === 'unpriced'
                    ? '无价表'
                    : breakdown.pricingModel}
                </BillingRow>
              ) : null}
              {breakdown?.baseTotal != null ? (
                <BillingRow label='基础合计' className='border-t pt-2'>
                  <span className='font-medium'>
                    {formatCurrency(breakdown.baseTotal, 6)}
                  </span>
                </BillingRow>
              ) : null}
              {multiplier != null ? (
                <BillingRow label='分组倍率'>
                  {multiplier.toFixed(2)}x
                </BillingRow>
              ) : null}
            </div>
            <div className='flex items-center justify-between border-t pt-3'>
              <span className='font-medium'>总费用</span>
              <span className='font-mono text-lg font-semibold text-emerald-600'>
                {formatCurrency(totalCost, 6)}
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {row.specialSettings.length ? (
        <div className='space-y-2'>
          <SectionTitle icon={Settings2} color='text-purple-600'>
            特殊设置
          </SectionTitle>
          <div className='flex flex-wrap gap-2 rounded-lg border bg-card p-4'>
            {row.specialSettings.map((setting) => (
              <Badge
                key={setting.key}
                variant='outline'
                className='text-xs'
                title={setting.value ?? undefined}
              >
                {setting.label}
                {setting.value && setting.key !== 'mismatch'
                  ? `: ${setting.value}`
                  : ''}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      <div className='space-y-2'>
        <h4 className='flex items-center gap-2 text-sm font-semibold'>
          <Settings2 className='h-4 w-4 text-slate-600' />
          模型
          {audit.hasActualMismatch ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <InfoIcon className='h-3.5 w-3.5 text-muted-foreground' />
              </TooltipTrigger>
              <TooltipContent className='max-w-xs'>
                上游实际返回的模型与请求的模型不一致。计费仍然基于请求模型。
              </TooltipContent>
            </Tooltip>
          ) : null}
        </h4>
        <div className='space-y-2 rounded-lg border bg-card p-3'>
          {audit.hasActualMismatch ? (
            <>
              <div className='flex items-center gap-2'>
                <span className='min-w-[6rem] text-xs text-muted-foreground'>
                  请求模型
                </span>
                <code className='rounded bg-slate-100 px-1.5 py-0.5 text-xs dark:bg-slate-800'>
                  {audit.effectiveRequestModel}
                </code>
              </div>
              <div className='flex items-center gap-2'>
                <span className='min-w-[6rem] text-xs text-muted-foreground'>
                  实际响应模型
                </span>
                <code className='rounded bg-slate-100 px-1.5 py-0.5 text-xs dark:bg-slate-800'>
                  {audit.secondaryActualModel}
                </code>
              </div>
            </>
          ) : (
            <code className='rounded bg-slate-100 px-1.5 py-0.5 text-xs dark:bg-slate-800'>
              {audit.effectiveRequestModel ?? '-'}
            </code>
          )}
        </div>
      </div>

      {audit.hasRedirect ? (
        <div id='model-redirect-section' className='space-y-2'>
          <SectionTitle icon={ArrowRight} color='text-blue-600'>
            模型重定向
          </SectionTitle>
          <div className='rounded-lg border bg-blue-50 p-3 dark:bg-blue-950/20'>
            <div className='flex flex-wrap items-center gap-2'>
              <code className='rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-800 dark:bg-blue-900/50 dark:text-blue-200'>
                {row.originalModel}
              </code>
              <ArrowRight className='h-3.5 w-3.5 text-blue-500' />
              <code className='rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-800 ring-1 ring-emerald-300 dark:bg-emerald-900/50 dark:text-emerald-200 dark:ring-emerald-700'>
                {row.model}
              </code>
            </div>
            <p className='mt-2 text-xs text-muted-foreground'>计费: 实际</p>
          </div>
        </div>
      ) : null}

      {row.errorMessage || row.errorCode ? (
        <div className='space-y-2'>
          <SectionTitle icon={AlertCircle} color='text-rose-600'>
            错误信息
          </SectionTitle>
          <div className='space-y-1 rounded-lg border bg-rose-50 p-3 dark:bg-rose-950/20'>
            {row.errorCode || row.errorOwner ? (
              <div className='flex flex-wrap gap-1'>
                {row.errorCode ? (
                  <Badge variant='outline' className='font-mono text-[10px]'>
                    {row.errorCode}
                  </Badge>
                ) : null}
                {row.errorOwner ? (
                  <Badge variant='outline' className='text-[10px]'>
                    归属 {row.errorOwner}
                  </Badge>
                ) : null}
              </div>
            ) : null}
            {row.errorMessage ? (
              <p className='font-mono text-xs break-words whitespace-pre-wrap text-rose-800 dark:text-rose-200'>
                {row.errorMessage}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
      {row.jevState ? (
        <div className='space-y-2'>
          <SectionTitle icon={AlertCircle} color='text-amber-600'>
            决策模型送审正文
          </SectionTitle>
          <p className='text-xs text-muted-foreground'>
            这是当时 POST 给模型的
            state，含历史用户句。模型只返回题目分数，没有指出其中哪一句。
          </p>
          <pre className='max-h-64 overflow-auto rounded-lg border bg-card p-3 font-mono text-xs break-words whitespace-pre-wrap'>
            {row.jevState}
          </pre>
        </div>
      ) : null}

      {row.stopReason || row.via || row.finalState ? (
        <div className='space-y-2'>
          <h4 className='text-sm font-semibold'>执行信息</h4>
          <div className='space-y-2 rounded-lg border bg-card p-4 text-sm'>
            {row.stopReason ? (
              <BillingRow label='结束原因'>{row.stopReason}</BillingRow>
            ) : null}
            {row.finalState ? (
              <BillingRow label='终态'>{row.finalState}</BillingRow>
            ) : null}
            {row.via ? (
              <BillingRow label='实际链路'>{row.via}</BillingRow>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
