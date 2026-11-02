import { useCallback, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { VIEW_TITLES } from '@/config/nav'
import type { UsageLogRow } from '@/types/panel-usage-logs'
import { ArrowUpRight, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/page-header'
import { StatusMark } from '@/components/status-mark'
import {
  type DetailState,
  LogDetailDialog,
} from '@/features/logs/log-detail/log-detail-dialog'
import { AccountScopeSettings } from './account-scope'
import { Panel } from './blocks'
import { DistillSettings } from './distill-settings'
import { RiskFeed } from './feed'
import { GateRail, type StageState } from './gate-rail'
import { HardRegexSettings } from './hard-regex-settings'
import { HitTable } from './hits'
import { JevUsagePanel } from './jev-usage'
import {
  PASS_REASONS,
  STAGES,
  type StageId,
  type ViewKey,
  feedKindOf,
  share,
} from './model'
import { ModelSettings } from './model-settings'
import {
  distillQueryOptions,
  gateStatsQueryOptions,
  jevInterceptQueryOptions,
  refusalGuardsQueryOptions,
  riskFeedQueryOptions,
} from './queries'
import { RefusalSettings } from './refusal-settings'

const STATE_TONE = {
  on: { key: 'on', text: '开启', cls: 'ok' },
  off: { key: 'off', text: '关闭', cls: 'off' },
  unset: { key: 'unset', text: '开启但未配置地址', cls: 'caution' },
  loading: { key: 'loading', text: '读取中', cls: 'none' },
} as const

function FeedNote({ shown, more }: { shown: number; more: boolean }) {
  if (!shown) return null
  return (
    <p className='border-t px-4 py-2 text-xs text-muted-foreground'>
      {more ? `只列最近 ${shown} 条。` : `今天共 ${shown} 条。`}
      点一行打开请求详情，看正文判断是否误伤。
    </p>
  )
}

export function RiskAuditPage() {
  const qc = useQueryClient()
  const search = useSearch({ from: '/_authenticated/risk' })
  const navigate = useNavigate({ from: '/risk' })
  const view: ViewKey = search.view ?? 'all'

  const stats = useQuery(gateStatsQueryOptions())
  const feed = useQuery(riskFeedQueryOptions(stats.data?.since))
  const distill = useQuery(distillQueryOptions())
  const jev = useQuery(jevInterceptQueryOptions())
  const refusal = useQuery(refusalGuardsQueryOptions())

  const [dirty, setDirty] = useState(false)
  const [detail, setDetail] = useState<DetailState | null>(null)
  const [focusRule, setFocusRule] = useState<string | null>(null)
  const onDirtyChange = useCallback((next: boolean) => setDirty(next), [])

  const go = (next: ViewKey) => {
    if (next === view) return
    if (dirty && !window.confirm('这一关有未保存的修改，离开会丢掉。继续？'))
      return
    setDirty(false)
    setFocusRule(null)
    void navigate({
      search: { view: next === 'all' ? undefined : next },
      replace: true,
    })
  }

  const states: Record<StageId, StageState> = {
    distill: distill.data ? (distill.data.enabled ? 'on' : 'off') : 'loading',
    'hard-regex': jev.data
      ? jev.data.hard_regex_enabled
        ? 'on'
        : 'off'
      : 'loading',
    refusal: refusal.data ? (refusal.data.enabled ? 'on' : 'off') : 'loading',
    jev: jev.data
      ? jev.data.enabled
        ? jev.data.base_url.trim()
          ? 'on'
          : 'unset'
        : 'off'
      : 'loading',
  }

  const blocks = stats.data?.blocks || []
  const passes = stats.data?.passes || []
  const rows = feed.data?.rows || []
  const blockedRows = rows.filter((row) => feedKindOf(row) !== 'upstream')
  const upstreamRows = rows.filter((row) => feedKindOf(row) === 'upstream')
  const open = (row: UsageLogRow) => setDetail({ row })
  const stage = STAGES.find((s) => s.id === view)
  const feedProps = {
    loading: feed.isLoading || stats.isLoading,
    error: (feed.error || stats.error) as Error | null,
    onOpen: open,
  }

  return (
    <PageHeader
      title={VIEW_TITLES.risk}
      description='入站请求在出站前依次过四道关。拦下的请求不占凭证、不出站；放行的才 hop 上游。'
      extra={
        <Button
          variant='outline'
          size='sm'
          className='cursor-pointer'
          disabled={stats.isFetching || feed.isFetching}
          onClick={() => {
            void qc.invalidateQueries({
              queryKey: gateStatsQueryOptions().queryKey,
            })
            void qc.invalidateQueries({ queryKey: ['panel', 'risk-feed'] })
          }}
        >
          <RefreshCw
            className={cn(
              'size-3.5',
              (stats.isFetching || feed.isFetching) &&
                'animate-spin motion-reduce:animate-none'
            )}
            aria-hidden='true'
          />
          刷新
        </Button>
      }
    >
      <AccountScopeSettings />

      <div className='mt-4'>
        <GateRail stats={stats.data} states={states} view={view} onView={go} />
      </div>
      {stats.error ? (
        <p className='mt-2 text-sm text-destructive' role='alert'>
          今日计数读取失败：{(stats.error as Error).message}
        </p>
      ) : null}

      {view === 'all' || view === 'jev' ? (
        <div className='mt-6'>
          <JevUsagePanel defaultOpen />
        </div>
      ) : null}

      <div
        id='risk-panel'
        role='tabpanel'
        aria-labelledby={`risk-tab-${view}`}
        className='mt-6 space-y-6'
      >
        {stage ? (
          <div className='flex flex-wrap items-baseline gap-x-3 gap-y-1'>
            <h3 className='text-lg font-semibold tracking-tight'>
              {stage.name}
            </h3>
            <StatusMark tone={STATE_TONE[states[stage.id]]} />
            <p className='basis-full text-sm text-muted-foreground'>
              {stage.does}
            </p>
          </div>
        ) : null}

        {view === 'pass' ? (
          <div className='grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]'>
            <Panel
              title='放行原因'
              hint='「模型故障放行」是没被检查就出站的请求，越少越好。'
            >
              <PassReasons
                rows={passes}
                total={(stats.data?.passed ?? 0) || 0}
              />
            </Panel>
            <Panel
              title='上游拒答'
              hint='过了四道关、被上游拒答的请求，是这里漏拦的。拒答缓存开着时会记成指纹，同类正文下次在第三关拦下。'
            >
              <div className='max-h-[34rem] overflow-y-auto'>
                <RiskFeed
                  {...feedProps}
                  rows={upstreamRows}
                  empty='今天没有上游拒答。'
                  showKind={false}
                />
              </div>
              <FeedNote shown={upstreamRows.length} more={!!feed.data?.more} />
            </Panel>
          </div>
        ) : (
          <div className='grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]'>
            <Panel
              title='今日命中'
              hint='按触发的词和规则归并。远高于同行的那条，先怀疑误伤。'
            >
              <div className='max-h-[34rem] overflow-y-auto'>
                <HitTable
                  rows={
                    stage ? blocks.filter((r) => r.by === stage.id) : blocks
                  }
                  showSource={!stage}
                  empty={
                    stats.isLoading
                      ? '读取中'
                      : stage
                        ? '这一关今天没有拦下请求。'
                        : '今天没有拦下请求。'
                  }
                  action={(row) => {
                    if (!stage) {
                      return (
                        <Button
                          size='sm'
                          variant='ghost'
                          className='h-7 shrink-0 cursor-pointer px-2'
                          aria-label={`去${row.label}关`}
                          onClick={() => go(row.by as ViewKey)}
                        >
                          <ArrowUpRight className='size-3.5' />
                        </Button>
                      )
                    }
                    if (stage.id !== 'hard-regex' || !row.rule) return null
                    return (
                      <Button
                        size='sm'
                        variant='ghost'
                        className='h-7 shrink-0 cursor-pointer px-2 text-xs'
                        onClick={() => {
                          setFocusRule(row.rule)
                          document
                            .getElementById('risk-settings')
                            ?.scrollIntoView({ behavior: 'smooth' })
                        }}
                      >
                        定位规则
                      </Button>
                    )
                  }}
                />
              </div>
            </Panel>
            <Panel
              title={stage ? '最近拦截' : '拦截流水'}
              hint={stage ? undefined : '今天被四道关拦下的请求，按时间倒序。'}
            >
              <div className='max-h-[34rem] overflow-y-auto'>
                <RiskFeed
                  {...feedProps}
                  rows={
                    stage
                      ? blockedRows.filter((r) => feedKindOf(r) === stage.id)
                      : blockedRows
                  }
                  empty={
                    stage ? '这一关今天没有拦下请求。' : '今天没有拦下请求。'
                  }
                  showKind={!stage}
                />
              </div>
              <FeedNote
                shown={
                  stage
                    ? blockedRows.filter((r) => feedKindOf(r) === stage.id)
                        .length
                    : blockedRows.length
                }
                more={!!feed.data?.more}
              />
            </Panel>
          </div>
        )}

        {stage ? (
          <div id='risk-settings' className='scroll-mt-4'>
            <Panel
              title='设置'
              hint={
                stage.id === 'refusal'
                  ? '改动立即生效。'
                  : '改完在底部保存条里保存。'
              }
            >
              {stage.id === 'distill' ? (
                <DistillSettings onDirtyChange={onDirtyChange} />
              ) : stage.id === 'hard-regex' ? (
                <HardRegexSettings
                  focusRule={focusRule}
                  onDirtyChange={onDirtyChange}
                />
              ) : stage.id === 'refusal' ? (
                <RefusalSettings />
              ) : (
                <ModelSettings onDirtyChange={onDirtyChange} />
              )}
            </Panel>
          </div>
        ) : null}
      </div>

      <LogDetailDialog state={detail} onClose={() => setDetail(null)} />
    </PageHeader>
  )
}

function PassReasons({
  rows,
  total,
}: {
  rows: { by: string; count: number }[]
  total: number
}) {
  const counts: Record<string, number> = {}
  for (const row of rows) counts[row.by] = (counts[row.by] || 0) + row.count
  const keys = Object.keys(PASS_REASONS).filter(
    (by) => counts[by] || by === 'fail-open'
  )
  return (
    <ul className='divide-y'>
      {keys.map((by) => {
        const count = counts[by] || 0
        const risky = by === 'fail-open' && count > 0
        return (
          <li key={by} className='flex items-center gap-3 px-4 py-3'>
            <div className='min-w-0 flex-1'>
              <p
                className={cn(
                  'text-sm',
                  risky && 'font-medium text-[var(--status-caution)]'
                )}
              >
                {PASS_REASONS[by].label}
              </p>
              <p className='text-xs text-muted-foreground'>
                {PASS_REASONS[by].hint}
              </p>
            </div>
            <span className='text-sm font-medium tabular-nums'>
              {count.toLocaleString()}
            </span>
            <span className='w-14 text-right text-xs text-muted-foreground tabular-nums'>
              {share(count, total)}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
