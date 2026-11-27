import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { UsageLogRow } from '@/types/panel-usage-logs'
import {
  AlertTriangle,
  CircleAlert,
  LogIn,
  RefreshCw,
  ShieldCheck,
  ShieldX,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { EmptyNotice, Panel } from './blocks'
import { RiskFeed } from './feed'
import { HitTable } from './hits'
import {
  PASS_REASONS,
  PREFLIGHT_RULES,
  feedKindOf,
  share,
  stageViaFilter,
} from './model'
import {
  type GateStats,
  gateStatsQueryOptions,
  refusalGuardsQueryOptions,
  riskFeedQueryOptions,
  upstream400QueryOptions,
} from './queries'
import { RefusalRecords } from './refusal-settings'

const STAGE_TABS = [
  { id: 'all', label: '全部' },
  ...PREFLIGHT_RULES.map(({ id, name }) => ({ id, label: name })),
  { id: 'jev', label: 'Jev' },
] as const

export function RiskStatus({
  onOpen,
  onOpenSource,
  onLocateRule,
}: {
  onOpen: (row: UsageLogRow) => void
  onOpenSource: (row: UsageLogRow) => void
  onLocateRule: (source: string) => void
}) {
  const client = useQueryClient()
  const [stage, setStage] = useState('all')
  const stats = useQuery(gateStatsQueryOptions())
  const feed = useQuery(
    riskFeedQueryOptions(stats.data?.since, stageViaFilter(stage))
  )
  const upstreamFeed = useQuery(riskFeedQueryOptions(stats.data?.since))
  const upstream400 = useQuery(upstream400QueryOptions(stats.data?.since))
  const rows = feed.data?.rows ?? []
  const allBlocks = stats.data?.blocks ?? []
  const stageCounts = new Map<string, number>()
  for (const row of allBlocks) {
    stageCounts.set(row.by, (stageCounts.get(row.by) ?? 0) + row.count)
  }
  const blocks = allBlocks.filter((row) => stage === 'all' || row.by === stage)
  const blockedRows = rows.filter((row) => {
    const kind = feedKindOf(row)
    return kind !== 'upstream' && (stage === 'all' || kind === stage)
  })
  const upstreamRows = (upstreamFeed.data?.rows ?? []).filter(
    (row) =>
      feedKindOf(row) === 'upstream' &&
      !(
        row.upstreamStatus != null &&
        [400, 401, 403, 422].includes(row.upstreamStatus)
      )
  )
  const refreshing =
    stats.isFetching ||
    feed.isFetching ||
    upstreamFeed.isFetching ||
    upstream400.isFetching
  const feedProps = {
    loading: stats.isLoading || feed.isLoading,
    error: stats.error || feed.error,
    onOpen,
  }

  return (
    <>
      <Panel
        title='今日概览'
        hint='北京时间 · 故障放行计入放行数。'
        action={
          <Button
            variant='outline'
            size='sm'
            className='cursor-pointer'
            disabled={refreshing}
            onClick={() => {
              void client.invalidateQueries({
                queryKey: gateStatsQueryOptions().queryKey,
              })
              void client.invalidateQueries({
                queryKey: ['panel', 'risk-feed'],
              })
              void client.invalidateQueries({
                queryKey: ['panel', 'risk-upstream-400'],
              })
              void client.invalidateQueries({
                queryKey: refusalGuardsQueryOptions().queryKey,
              })
            }}
          >
            <RefreshCw
              aria-hidden='true'
              className={cn(
                'size-3.5',
                refreshing && 'animate-spin motion-reduce:animate-none'
              )}
            />
            刷新状态
          </Button>
        }
      >
        {stats.error && (
          <p className='px-4 py-3 text-sm text-destructive' role='alert'>
            今日统计读取失败：{stats.error.message}
          </p>
        )}
        <StatusMetrics stats={stats.data} />
      </Panel>

      <section aria-label='拦截记录' className='space-y-3'>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <h3 className='text-sm font-semibold tracking-[-0.01em]'>拦截记录</h3>
          <div
            role='tablist'
            aria-label='筛选拦截来源'
            className='flex flex-wrap items-center gap-1 rounded-lg border bg-card p-1'
          >
            {STAGE_TABS.map(({ id, label }) => {
              const active = stage === id
              const count =
                id === 'all' ? stats.data?.blocked : (stageCounts.get(id) ?? 0)
              return (
                <button
                  key={id}
                  type='button'
                  role='tab'
                  aria-selected={active}
                  onClick={() => setStage(id)}
                  className={cn(
                    'inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                    active
                      ? 'border-select-border bg-select-surface font-medium text-foreground'
                      : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  )}
                >
                  <span>{label}</span>
                  {count != null && count > 0 ? (
                    <span className='font-mono text-[11px] tabular-nums opacity-70'>
                      {count}
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
        </div>
        <div className='grid min-w-0 gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]'>
          <Panel title='今日命中' hint='按触发规则和关键词归并。'>
            <div className='max-h-[34rem] overflow-y-auto'>
              <HitTable
                rows={blocks}
                empty={
                  stats.isLoading
                    ? '读取中…'
                    : stats.isError
                      ? '暂无统计数据。'
                      : '没有匹配的命中记录。'
                }
                showSource
                action={(row) =>
                  row.by === 'hard-regex' && row.rule ? (
                    <Button
                      size='sm'
                      variant='ghost'
                      className='h-7 shrink-0 cursor-pointer px-2 text-xs'
                      onClick={() => onLocateRule(row.rule)}
                    >
                      定位规则
                    </Button>
                  ) : null
                }
              />
            </div>
          </Panel>
          <AuditFeed
            {...feedProps}
            title='拦截流水'
            hint='前置和 Jev 拦下的请求，按时间倒序。'
            rows={blockedRows}
            empty='没有匹配的拦截流水。'
            more={!!feed.data?.more}
          />
        </div>
      </section>

      <Panel
        title='封禁与拒答记录'
        hint='查看触发会话、封禁原因和原请求；也可解除封禁或删除指纹。'
      >
        <RefusalRecords onOpen={onOpenSource} />
      </Panel>

      <AuditFeed
        title='上游 4xx 错误与风控复核'
        hint='涵盖上游 400 / 401 / 403 / 422；参数错误记为 protocol 不计违规，高危 401/403 附带 JEV 送审正文与分数。'
        rows={upstream400.data?.logs ?? []}
        loading={stats.isLoading || upstream400.isLoading}
        error={stats.error || upstream400.error}
        empty='今天没有上游 4xx 风控/错误记录。'
        more={!!upstream400.data?.hasMore}
        onOpen={onOpen}
      />

      <div className='grid min-w-0 gap-4 lg:grid-cols-2'>
        <Panel title='降级放行' hint='按实际发起的上游请求计数，不含调度失败。'>
          {stats.data?.routes?.length ? (
            <ul className='divide-y'>
              {stats.data.routes.map((route) => (
                <li
                  key={`${route.kind}:${route.target}`}
                  className='flex items-baseline justify-between gap-3 px-4 py-2 text-sm'
                >
                  <span className='min-w-0 break-all'>
                    {route.kind === 'pool'
                      ? '账号池'
                      : route.kind === 'endpoint'
                        ? 'API 渠道'
                        : '模型'}
                    {' · '}
                    <code className='text-xs'>{route.target}</code>
                  </span>
                  <span className='shrink-0 tabular-nums'>
                    {route.count.toLocaleString()} 次
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className='px-4 py-6 text-sm text-muted-foreground'>
              {stats.isLoading
                ? '读取中…'
                : stats.isError
                  ? '暂无统计数据。'
                  : '今天暂无降级出站。'}
            </p>
          )}
        </Panel>
        <Panel title='放行原因'>
          <PassReasons
            stats={stats.data}
            loading={stats.isLoading}
            error={stats.isError}
          />
        </Panel>
      </div>

      <AuditFeed
        loading={stats.isLoading || upstreamFeed.isLoading}
        error={stats.error || upstreamFeed.error}
        onOpen={onOpen}
        title='其他上游拒答'
        hint='通过审核后由上游拒答；符合回填条件时写入前置缓存。'
        rows={upstreamRows}
        empty='今天没有其他上游拒答。'
        more={!!upstreamFeed.data?.more}
      />
    </>
  )
}

function StatusMetrics({ stats }: { stats: GateStats | undefined }) {
  const failOpen =
    stats?.passes?.reduce(
      (count, row) => (row.by === 'fail-open' ? count + row.count : count),
      0
    ) ?? 0
  const upstreamRefusals = stats?.upstreamRefusals ?? 0
  const riskTotal = (stats?.blocked ?? 0) + upstreamRefusals
  const catchPct =
    riskTotal > 0 ? Math.round(((stats?.blocked ?? 0) / riskTotal) * 100) : null
  const metrics = [
    {
      label: '入站',
      value: stats?.total,
      icon: LogIn,
      tone: 'neutral' as const,
    },
    {
      label: '前置拦截',
      value: stats?.blocked,
      icon: ShieldX,
      tone:
        (stats?.blocked ?? 0) > 0 ? ('warn' as const) : ('neutral' as const),
      hint: stats && `占入站 ${share(stats.blocked, stats.total)}`,
    },
    {
      label: '安全放行',
      value: stats?.passed,
      icon: ShieldCheck,
      tone: 'ok' as const,
      hint: stats && `占入站 ${share(stats.passed, stats.total)}`,
    },
    {
      label: '上游漏放',
      value: stats && upstreamRefusals,
      icon: AlertTriangle,
      tone: upstreamRefusals > 0 ? ('bad' as const) : ('neutral' as const),
      hint:
        stats &&
        (riskTotal > 0
          ? `前置拦截率 ${share(stats.blocked, riskTotal)}`
          : '暂无风险命中'),
      barPct: catchPct,
    },
    {
      label: '故障放行',
      value: stats && failOpen,
      icon: CircleAlert,
      tone: failOpen > 0 ? ('caution' as const) : ('neutral' as const),
      hint: stats && (failOpen > 0 ? '需关注模型可用性' : '审核服务正常'),
    },
  ]
  const toneClass = {
    neutral: '',
    ok: 'text-[var(--status-ok)]',
    warn: 'text-[var(--status-warn)]',
    caution: 'text-[var(--status-caution)]',
    bad: 'text-[var(--status-bad)]',
  }
  return (
    <dl className='grid grid-cols-2 gap-px bg-[var(--hairline)] sm:grid-cols-5'>
      {metrics.map(({ label, value, icon: Icon, hint, tone, barPct }) => (
        <div key={label} className='min-w-0 space-y-1.5 bg-card px-4 py-3.5'>
          <dt className='flex items-center gap-1.5 text-xs text-muted-foreground'>
            <Icon
              className={cn('size-3.5 shrink-0', toneClass[tone])}
              aria-hidden='true'
            />
            {label}
          </dt>
          <dd className='space-y-1.5'>
            <span
              className={cn(
                'block text-2xl font-semibold tracking-[-0.02em] break-all tabular-nums',
                toneClass[tone]
              )}
            >
              {value?.toLocaleString() ?? '—'}
            </span>
            {hint ? (
              <span className='block text-xs font-normal text-muted-foreground tabular-nums'>
                {hint}
              </span>
            ) : null}
            {barPct != null ? (
              <div
                className='h-1.5 w-full overflow-hidden rounded-full bg-[var(--track)]'
                aria-label={`前置拦截率 ${barPct}%`}
              >
                <div
                  className='h-full rounded-full bg-[var(--status-ok-solid)] transition-[width] duration-300'
                  style={{ width: `${barPct}%` }}
                />
              </div>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function AuditFeed({
  title,
  hint,
  more,
  ...props
}: Omit<React.ComponentProps<typeof RiskFeed>, 'showKind'> & {
  title: string
  hint: string
  more: boolean
}) {
  return (
    <Panel title={title} hint={hint}>
      <div className='max-h-[34rem] overflow-y-auto'>
        <RiskFeed {...props} showKind />
      </div>
      {props.rows.length > 0 && !props.error && !props.loading && (
        <p className='border-t px-4 py-2 text-xs text-muted-foreground'>
          {more
            ? `已显示 ${props.rows.length} 条，更多可在日志页查询。`
            : `今天共 ${props.rows.length} 条。`}
          点一行查看原请求详情。
        </p>
      )}
    </Panel>
  )
}

function PassReasons({
  stats,
  loading,
  error,
}: {
  stats: GateStats | undefined
  loading: boolean
  error: boolean
}) {
  const counts = new Map<string, number>()
  for (const row of stats?.passes ?? [])
    counts.set(row.by, (counts.get(row.by) ?? 0) + row.count)
  const reasons = Object.entries(PASS_REASONS).filter(([reason]) =>
    counts.has(reason)
  )
  if (!reasons.length)
    return (
      <EmptyNotice
        message={
          loading
            ? '读取中'
            : error && !stats
              ? '放行原因读取失败'
              : '暂无放行原因。'
        }
      />
    )
  const passedTotal = stats?.passed ?? 0
  return (
    <ul className='divide-y divide-[var(--hairline)]'>
      {reasons.map(([reason, { label, hint }]) => {
        const count = counts.get(reason) ?? 0
        const pct =
          passedTotal > 0 ? Math.min(100, (count / passedTotal) * 100) : 0
        return (
          <li key={reason} className='space-y-1.5 px-4 py-3'>
            <div className='flex items-center gap-3'>
              <div className='min-w-0 flex-1'>
                <p
                  className={cn(
                    'text-sm',
                    reason === 'fail-open' &&
                      'font-medium text-[var(--status-caution)]'
                  )}
                >
                  {label}
                </p>
                <p className='text-xs text-muted-foreground'>{hint}</p>
              </div>
              <span className='text-sm font-medium tabular-nums'>
                {count.toLocaleString()}
              </span>
              <span className='w-14 text-right text-xs text-muted-foreground tabular-nums'>
                {share(count, passedTotal)}
              </span>
            </div>
            <div className='h-1 w-full overflow-hidden rounded-full bg-[var(--track)]'>
              <div
                className={cn(
                  'h-full rounded-full',
                  reason === 'fail-open'
                    ? 'bg-[var(--status-caution-solid)]'
                    : reason === 'jev'
                      ? 'bg-[var(--status-ok-solid)]'
                      : 'bg-select-solid/70'
                )}
                style={{ width: `${Math.max(count > 0 ? 2 : 0, pct)}%` }}
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}
