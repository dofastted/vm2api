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
  ShieldAlert,
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

const JEV_QUESTION_LABELS: Record<string, string> = {
  usage_policy: '使用政策',
  nsfw: '色情',
  abuse: '破限与攻击',
  custom: '自定义',
  safety: '综合',
}

const RISK_BUCKET_LABELS: Record<string, string> = {
  policy: '上游政策拒答',
  policy_suspect: '疑似上游误拒（仅精确指纹）',
  third_party: '第三方客户端拒绝',
  protocol: '协议参数错误',
  auth_suspect: '高危账号 401/403 待复核',
}

function extractJevScores(details: UsageLogRow['errorDetails']) {
  if (!details) return []
  const items: { id: string; label: string; score: number }[] = []
  for (const [key, value] of Object.entries(details)) {
    if (!key.startsWith('jev_score_')) continue
    const num = Number(value)
    if (!Number.isFinite(num)) continue
    const id = key.slice('jev_score_'.length)
    items.push({ id, label: JEV_QUESTION_LABELS[id] || id, score: num })
  }
  return items
}

function RiskAuditCard({ row }: { row: UsageLogRow }) {
  const details = row.errorDetails || {}
  const jevScores = extractJevScores(details)
  const riskVia = [
    'jev',
    'hard-regex',
    'distill-detect',
    'refusal-guard',
  ].includes(row.via || '')
  const riskBucket =
    typeof details.risk_bucket === 'string' ? details.risk_bucket : null
  const gateMiss = details.gate_miss === true
  const hasRisk =
    riskVia ||
    !!row.jevState ||
    row.intercept?.kind === 'block' ||
    gateMiss ||
    !!riskBucket ||
    jevScores.length > 0
  if (!hasRisk) return null
  const disguised429 =
    row.statusCode === 429 && (row.via === 'jev' || row.via === 'refusal-guard')

  return (
    <div className='space-y-2'>
      <SectionTitle icon={ShieldAlert} color='text-[var(--status-warn)]'>
        风控与审核裁决
      </SectionTitle>
      <div className='space-y-3 rounded-lg border border-[var(--hairline)] bg-card p-3.5 text-xs'>
        <div className='flex flex-wrap items-center gap-1.5'>
          <span
            className={cn(
              'rounded-md px-2 py-0.5 font-mono text-[11px] font-medium',
              disguised429
                ? 'bg-[var(--status-warn-bg)] text-[var(--status-warn)]'
                : 'bg-muted text-foreground'
            )}
          >
            对外状态{' '}
            {disguised429
              ? '429（伪装负载）'
              : row.statusCode != null
                ? `HTTP ${row.statusCode}`
                : '—'}
          </span>
          {row.via ? (
            <Badge variant='outline' className='font-mono text-[11px]'>
              内部裁决 {row.via}
            </Badge>
          ) : null}
          {row.finalState ? (
            <Badge variant='outline' className='font-mono text-[11px]'>
              终态 {row.finalState}
            </Badge>
          ) : null}
          {gateMiss ? (
            <span className='rounded-md bg-[var(--status-bad-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--status-bad)]'>
              前置放行后上游拒答（漏放）
            </span>
          ) : null}
          {riskBucket ? (
            <span className='rounded-md bg-[var(--status-caution-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--status-caution)]'>
              {RISK_BUCKET_LABELS[riskBucket] || riskBucket}
            </span>
          ) : null}
        </div>
        {jevScores.length > 0 ? (
          <div className='space-y-2'>
            <p className='text-[11px] text-[var(--text-tertiary)]'>
              JEV 题目安全分（0–1，低于 0.50 拦截）
            </p>
            <div className='grid gap-2 sm:grid-cols-3'>
              {jevScores.map((item) => {
                const pct = Math.max(0, Math.min(100, item.score * 100))
                const tone =
                  item.score < 0.5
                    ? {
                        fg: 'text-[var(--status-bad)]',
                        bar: 'bg-[var(--status-bad-solid)]',
                      }
                    : item.score < 0.85
                      ? {
                          fg: 'text-[var(--status-caution)]',
                          bar: 'bg-[var(--status-caution-solid)]',
                        }
                      : {
                          fg: 'text-[var(--status-ok)]',
                          bar: 'bg-[var(--status-ok-solid)]',
                        }
                return (
                  <div
                    key={item.id}
                    className='space-y-1 rounded-md border border-[var(--hairline)] bg-muted/20 px-2.5 py-2'
                  >
                    <div className='flex items-baseline justify-between gap-2 font-mono text-[11px] tabular-nums'>
                      <span className='font-sans font-medium text-foreground'>
                        {item.label}: {item.score.toFixed(2)}
                      </span>
                      <span className={cn('font-semibold', tone.fg)}>
                        {Math.round(pct)}%
                      </span>
                    </div>
                    <div className='relative h-1.5 w-full overflow-hidden rounded-full bg-[var(--track)]'>
                      <div
                        className={cn('h-full rounded-full', tone.bar)}
                        style={{ width: `${Math.max(2, pct)}%` }}
                      />
                      <span
                        aria-hidden='true'
                        className='absolute inset-y-0 left-1/2 w-px bg-foreground/30'
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}
        {row.inboundDeviceId || row.clientSessionId ? (
          <div className='grid gap-1.5 border-t border-[var(--hairline)] pt-2.5 text-[11px] text-[var(--text-tertiary)] sm:grid-cols-2'>
            <div className='min-w-0 break-all'>
              入站设备：
              <code className='font-mono text-foreground'>
                {row.inboundDeviceId || '未提供'}
              </code>
            </div>
            <div className='min-w-0 break-all'>
              入站会话：
              <code className='font-mono text-foreground'>
                {row.clientSessionId || '未提供'}
              </code>
            </div>
          </div>
        ) : null}
      </div>
    </div>
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

      {row.errorMessage ||
      row.errorCode ||
      row.upstreamType ||
      (row.errorDetails && Object.keys(row.errorDetails).length > 0) ? (
        <div className='space-y-2'>
          <SectionTitle icon={AlertCircle} color='text-rose-600'>
            错误信息
          </SectionTitle>
          <div className='space-y-2 rounded-lg border bg-rose-50 p-3 dark:bg-rose-950/20'>
            {row.errorCode || row.upstreamType || row.errorOwner ? (
              <div className='flex flex-wrap gap-1'>
                {row.errorCode ? (
                  <Badge variant='outline' className='font-mono text-[10px]'>
                    {row.errorCode}
                  </Badge>
                ) : null}
                {row.upstreamType && row.upstreamType !== row.errorCode ? (
                  <Badge variant='outline' className='font-mono text-[10px]'>
                    {row.upstreamType}
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
            {row.errorDetails && Object.keys(row.errorDetails).length > 0 ? (
              <div className='flex flex-wrap gap-1.5 border-t border-rose-200/70 pt-2 dark:border-rose-800/60'>
                {Object.entries(row.errorDetails)
                  .filter(
                    ([key]) =>
                      !(
                        key === 'upstream_type' &&
                        (row.upstreamType === row.errorDetails?.upstream_type ||
                          row.errorCode === row.errorDetails?.upstream_type)
                      )
                  )
                  .map(([key, value]) => (
                    <Badge
                      key={key}
                      variant='outline'
                      className='font-mono text-[10px]'
                    >
                      {key}={String(value)}
                    </Badge>
                  ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      <RiskAuditCard row={row} />
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
