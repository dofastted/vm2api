import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { VIEW_TITLES } from '@/config/nav'
import type { OpsWindow } from '@/types/panel-overview'
import type { Vm } from '@/types/panel-vm'
import {
  Activity,
  ChevronRight,
  Gauge,
  Server,
  ShieldCheck,
} from 'lucide-react'
import { fmtNum, pct } from '@/lib/format'
import { opsSince } from '@/lib/ops-window'
import {
  accountStatus,
  accountUsable,
  healthScore,
  vmBuckets,
  vmRunning,
} from '@/lib/vm-status'
import { cacheHitPct } from '@/lib/vm-usage'
import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/page-header'
import { QueryGate } from '@/components/query-gate'
import { logStatsQueryOptions } from '@/features/logs/queries'
import { BillingStrip } from '@/features/overview/billing-strip'
import { ErrorCollectionSummary } from '@/features/overview/error-collection-summary'
import {
  HealthBar,
  HealthDonut,
  HealthLegend,
} from '@/features/overview/health-gauge'
import { HostColumn } from '@/features/overview/host-column'
import { KpiCard } from '@/features/overview/kpi-card'
import { OverviewSkeleton } from '@/features/overview/overview-skeleton'
import { PoolQuota } from '@/features/overview/pool-quota'
import {
  dashboardQueryOptions,
  usageQueryOptions,
} from '@/features/overview/queries'
import { TrafficOps } from '@/features/overview/traffic-ops'
import { TrendChart } from '@/features/overview/trend-chart'

type AlertTone = 'caution' | 'warn' | 'bad'

function AlertChip({
  t,
  to,
  tone,
}: {
  t: string
  to: '/import' | '/usage' | '/cluster' | '/overview' | '/logs' | '/vm'
  tone: AlertTone
}) {
  return (
    <Link
      to={to}
      search={to === '/logs' ? { kind: 'error' } : undefined}
      className='inline-flex items-center gap-1 rounded-full border px-2.5 py-1.5 text-xs font-medium transition-opacity hover:opacity-80'
      style={{
        color: `var(--status-${tone})`,
        backgroundColor: `var(--status-${tone}-bg)`,
        borderColor: `var(--status-${tone})`,
      }}
    >
      {t}
      <ChevronRight className='size-3 opacity-70' aria-hidden />
    </Link>
  )
}

export function OverviewPage() {
  const dash = useQuery(dashboardQueryOptions())
  const usage = useQuery(usageQueryOptions())
  const since = opsSince('1h')
  const stats = useQuery(logStatsQueryOptions(since))
  // 趋势图要 24 个小时桶；1h 窗口只覆盖 1–2 桶，画不成趋势。
  const since24 = opsSince('24h')
  const stats24 = useQuery(logStatsQueryOptions(since24))
  const d = dash.data || {}
  const vms: Vm[] = d.vms || []
  const summary = (d.summary || {}) as Record<string, unknown>
  const totals = (usage.data?.totals || {}) as Record<string, unknown>
  const gstat = (d.gateway_stats || {}) as Record<string, unknown>
  const running = vms.filter(vmRunning).length
  const withToken = vms.filter((v) => v.has_token).length
  const available = vms.filter((v) => v.has_token && accountUsable(v)).length
  // 口径对齐 index.html:3364-3365 —— 按后端 availability 的 `key` 归并，
  // 不能比对 `.cls`：cls 是归一化后的三色调（ok/caution/warn/bad/off/none），
  // 会把 index.html 明确区分的 cool/quota/sessions 三个 key 混在一起统计，
  // 导致这两条告警在 availability 走后端 key 路径时被漏计。
  const warned = vms.filter((v) =>
    ['caution', 'cool'].includes(accountStatus(v).key)
  ).length
  const limited = vms.filter((v) =>
    ['warn', 'quota', 'sessions'].includes(accountStatus(v).key)
  ).length
  const noToken = vms.filter((v) => !v.has_token).length
  const tokensIn = Number(totals.tokens_in ?? summary.tokens_in ?? 0)
  const tokensOut = Number(totals.tokens_out ?? summary.tokens_out ?? 0)
  const reqs = Number(totals.requests ?? summary.requests ?? 0)
  const peak5 = pct(summary.peak_5h ?? totals.peak_5h)
  const errs = Number(gstat.errors || 0)
  const buckets = vmBuckets(vms)
  const score = healthScore(vms)
  const cacheHitRate = summary.cache_hit_rate as number | null | undefined
  const cachePct =
    cacheHitRate != null
      ? cacheHitRate * 100
      : cacheHitPct(
          tokensIn,
          summary.cache_read_tokens as number | undefined,
          summary.cache_creation_tokens as number | undefined
        )

  // `currentOps()` 等价逻辑：优先 request-logs/stats 的 window，回落 dashboard.ops。
  const statsWindow = stats.data?.window
  const ops: OpsWindow | undefined =
    statsWindow && (statsWindow.error || statsWindow.requests != null)
      ? statsWindow
      : d.ops

  const serverMuted = stats.data?.muted_error_classes

  const fableCool = vms.filter(
    (v) => v.fable_cooldown_until && Number(v.fable_cooldown_until) > Date.now()
  ).length
  const alerts: {
    t: string
    to: '/import' | '/usage' | '/cluster' | '/overview' | '/logs' | '/vm'
    tone: AlertTone
  }[] = []
  if (available === 0 && withToken)
    alerts.push({ t: '无可用账号', to: '/import', tone: 'bad' })
  if (warned > 0)
    alerts.push({ t: `${warned} 警告`, to: '/usage', tone: 'caution' })
  if (limited > 0)
    alerts.push({ t: `${limited} 限制`, to: '/usage', tone: 'warn' })
  if (noToken > 0 && withToken === 0)
    alerts.push({ t: '无凭证', to: '/import', tone: 'bad' })
  if (fableCool > 0)
    alerts.push({
      t: `Fable 冷却 ${fableCool}`,
      to: '/vm',
      tone: 'caution',
    })
  if (errs > 0) alerts.push({ t: `错误 ${errs}`, to: '/logs', tone: 'bad' })

  return (
    <PageHeader title={VIEW_TITLES.overview}>
      <QueryGate
        loading={dash.isLoading}
        error={dash.error || (d.error ? new Error(d.error) : null)}
        skeleton={<OverviewSkeleton />}
      >
        <div className='space-y-3'>
          <Card className='shadow-none'>
            <CardContent className='flex flex-wrap items-center gap-6 pt-6'>
              <HealthDonut score={score} label='健康' />
              <div className='min-w-0 flex-1 space-y-2.5'>
                <HealthBar buckets={buckets} total={vms.length} />
                <HealthLegend buckets={buckets} />
                <div className='flex flex-wrap items-center gap-2'>
                  <span className='inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1.5 text-[11.5px] text-muted-foreground'>
                    <span
                      className='block size-1.5 rounded-full'
                      style={{
                        background: summary.active_vm
                          ? 'var(--status-ok)'
                          : 'var(--status-none)',
                      }}
                    />
                    活跃{' '}
                    <span className='font-medium text-foreground'>
                      {String(summary.active_vm || '未指定')}
                    </span>
                  </span>
                  {alerts.map((a) => (
                    <AlertChip key={a.t} t={a.t} to={a.to} tone={a.tone} />
                  ))}
                </div>
              </div>
              <HostColumn host={d.host} />
            </CardContent>
          </Card>

          <PoolQuota vms={vms} />

          <div className='grid gap-3 xl:grid-cols-3'>
            <TrendChart
              className='xl:col-span-2'
              buckets={stats24.data?.buckets || []}
              loading={stats24.isLoading}
              error={stats24.error ? String(stats24.error) : undefined}
            />
            <div className='grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-1'>
              <KpiCard
                icon={ShieldCheck}
                label='可用账号'
                value={
                  <>
                    {available}
                    <small className='ml-1 text-[13px] font-medium text-muted-foreground'>
                      / {withToken}
                    </small>
                  </>
                }
                ringPct={
                  withToken ? (available / Math.max(withToken, 1)) * 100 : 0
                }
                tone='good'
              />
              <KpiCard
                icon={Server}
                label='在线'
                value={
                  <>
                    {running}
                    <small className='ml-1 text-[13px] font-medium text-muted-foreground'>
                      / {vms.length}
                    </small>
                  </>
                }
                ringPct={vms.length ? (running / vms.length) * 100 : 0}
                tone='good'
              />
              <KpiCard
                icon={Gauge}
                label='5h 峰值'
                value={
                  <>
                    {peak5.toFixed(0)}
                    <small className='ml-1 text-[13px] font-medium text-muted-foreground'>
                      %
                    </small>
                  </>
                }
                ringPct={peak5}
              />
              <KpiCard
                icon={Activity}
                label={`请求 · 缓存 ${cachePct == null ? '—' : `${cachePct.toFixed(0)}%`}`}
                value={fmtNum(reqs)}
                hint={`Tokens ${fmtNum(tokensIn)}/${fmtNum(tokensOut)}`}
                ringPct={cachePct}
                tone='good'
              />
            </div>
          </div>

          <BillingStrip
            billing={d.billing}
            vms={vms}
            fallbackToday={Number(summary.today_cost ?? totals.today_cost ?? 0)}
            fallbackTotal={Number(summary.total_cost ?? totals.total_cost ?? 0)}
          />

          <TrafficOps ops={ops} showModels />

          <ErrorCollectionSummary
            collection={ops?.error_collection}
            serverMuted={serverMuted}
          />
        </div>
      </QueryGate>
    </PageHeader>
  )
}
