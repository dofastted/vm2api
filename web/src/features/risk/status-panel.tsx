import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { UsageLogRow } from '@/types/panel-usage-logs'
import {
  CircleAlert,
  LogIn,
  RefreshCw,
  ShieldCheck,
  ShieldX,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Panel } from './blocks'
import { RiskFeed } from './feed'
import { HitTable } from './hits'
import { PASS_REASONS, PREFLIGHT_RULES, feedKindOf, share } from './model'
import {
  type GateStats,
  gateStatsQueryOptions,
  refusalGuardsQueryOptions,
  riskFeedQueryOptions,
  upstream400QueryOptions,
} from './queries'
import { RefusalRecords } from './refusal-settings'

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
  const stats = useQuery(gateStatsQueryOptions())
  const feed = useQuery(riskFeedQueryOptions(stats.data?.since))
  const upstream400 = useQuery(upstream400QueryOptions(stats.data?.since))
  const [stage, setStage] = useState('all')
  const rows = feed.data?.rows ?? []
  const blocks = (stats.data?.blocks ?? []).filter(
    (row) => stage === 'all' || row.by === stage
  )
  const blockedRows = rows.filter((row) => {
    const kind = feedKindOf(row)
    return kind !== 'upstream' && (stage === 'all' || kind === stage)
  })
  const upstreamRows = rows.filter(
    (row) => feedKindOf(row) === 'upstream' && row.upstreamStatus !== 400
  )
  const refreshing =
    stats.isFetching || feed.isFetching || upstream400.isFetching
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
          <h3 className='text-sm font-semibold'>拦截记录</h3>
          <Select value={stage} onValueChange={setStage}>
            <SelectTrigger
              aria-label='筛选拦截来源'
              className='w-36 cursor-pointer'
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='all'>全部来源</SelectItem>
              {PREFLIGHT_RULES.map(({ id, name }) => (
                <SelectItem key={id} value={id}>
                  {name}
                </SelectItem>
              ))}
              <SelectItem value='jev'>Jev</SelectItem>
            </SelectContent>
          </Select>
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
        title='上游 HTTP 400'
        hint='仅列实际上游返回的 400；参数错误不计违规。'
        rows={upstream400.data?.logs ?? []}
        loading={stats.isLoading || upstream400.isLoading}
        error={stats.error || upstream400.error}
        empty='今天没有上游 HTTP 400。'
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
          <PassReasons stats={stats.data} />
        </Panel>
      </div>

      <AuditFeed
        {...feedProps}
        title='其他上游拒答'
        hint='通过审核后由上游拒答；符合回填条件时写入前置缓存。'
        rows={upstreamRows}
        empty='今天没有其他上游拒答。'
        more={!!feed.data?.more}
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
  const metrics = [
    { label: '入站', value: stats?.total, icon: LogIn },
    {
      label: '拦截',
      value: stats?.blocked,
      icon: ShieldX,
      hint: stats && `占入站 ${share(stats.blocked, stats.total)}`,
    },
    {
      label: '放行',
      value: stats?.passed,
      icon: ShieldCheck,
      hint: stats && `占入站 ${share(stats.passed, stats.total)}`,
    },
    {
      label: '故障放行',
      value: stats && failOpen,
      icon: CircleAlert,
      caution: failOpen > 0,
    },
  ]
  return (
    <dl className='grid grid-cols-2 gap-px bg-border sm:grid-cols-4'>
      {metrics.map(({ label, value, icon: Icon, hint, caution }) => (
        <div key={label} className='min-w-0 space-y-1 bg-card px-4 py-3'>
          <dt className='flex items-center gap-1.5 text-xs text-muted-foreground'>
            <Icon
              className={cn(
                'size-3.5 shrink-0',
                caution && 'text-[var(--status-caution)]'
              )}
              aria-hidden='true'
            />
            {label}
          </dt>
          <dd
            className={cn(
              'text-xl font-semibold break-all tabular-nums',
              caution && 'text-[var(--status-caution)]'
            )}
          >
            {value?.toLocaleString() ?? '—'}
            {hint && (
              <span className='block text-xs font-normal text-muted-foreground'>
                {hint}
              </span>
            )}
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

function PassReasons({ stats }: { stats: GateStats | undefined }) {
  const counts = new Map<string, number>()
  for (const row of stats?.passes ?? [])
    counts.set(row.by, (counts.get(row.by) ?? 0) + row.count)
  const reasons = Object.entries(PASS_REASONS).filter(([reason]) =>
    counts.has(reason)
  )
  if (!reasons.length)
    return (
      <p className='px-4 py-6 text-sm text-muted-foreground'>暂无放行原因。</p>
    )
  return (
    <ul className='divide-y'>
      {reasons.map(([reason, { label, hint }]) => {
        const count = counts.get(reason) ?? 0
        return (
          <li key={reason} className='flex items-center gap-3 px-4 py-3'>
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
              {share(count, stats?.passed ?? 0)}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
