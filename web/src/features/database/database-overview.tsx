import type { DatabaseRuntimeMetrics } from '@/types/panel-database'
import { StatusMark } from '@/components/status-mark'
import { PanelCard, StatCell } from '@/features/overview/panel-card'
import {
  formatMetricBytes,
  formatMetricNumber,
  formatMetricTime,
} from './metrics'

function latency(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  if (value < 10) return `${value.toFixed(2)}ms`
  return `${Math.round(value)}ms`
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className='min-w-0'>
      <dt className='text-[11px] text-muted-foreground'>{label}</dt>
      <dd className='mt-0.5 truncate text-sm font-medium tabular-nums'>
        {value}
      </dd>
    </div>
  )
}

export function DatabaseOverview({
  metrics,
  sampledAt,
}: {
  metrics: DatabaseRuntimeMetrics
  sampledAt: string | null
}) {
  return (
    <PanelCard
      title='数据库运行态'
      meta={sampledAt ? `采样于 ${formatMetricTime(sampledAt)}` : '当前快照'}
      action={
        <StatusMark
          variant='pill'
          tone={
            metrics.ok
              ? { key: 'ok', cls: 'ok', text: '探针正常' }
              : { key: 'bad', cls: 'bad', text: '探针失败' }
          }
        />
      }
    >
      <div className='grid grid-cols-2 gap-px bg-border/60 sm:grid-cols-3 xl:grid-cols-6'>
        <StatCell
          label='探针耗时'
          value={latency(metrics.probe_latency_ms)}
          hint='固定 SELECT 1'
        />
        <StatCell
          label='数据库大小'
          value={formatMetricBytes(metrics.size_bytes)}
          hint='PostgreSQL 数据库'
        />
        <StatCell
          label='连接总数'
          value={formatMetricNumber(metrics.pool_total)}
          hint='当前应用连接池'
        />
        <StatCell
          label='空闲连接'
          value={formatMetricNumber(metrics.pool_idle)}
          hint='可复用连接'
        />
        <StatCell
          label='等待连接'
          value={formatMetricNumber(metrics.pool_waiting)}
          hint='等待连接的请求'
        />
        <StatCell
          label='Migration'
          value={metrics.latest_migration || '—'}
          hint={`${formatMetricNumber(metrics.migration_count)} 次 · ${formatMetricTime(metrics.latest_migration_at)}`}
        />
      </div>

      <dl className='grid grid-cols-2 gap-x-5 gap-y-3 border-t px-4 py-3 sm:grid-cols-3 xl:grid-cols-6'>
        <Detail label='引擎' value={metrics.engine.toUpperCase()} />
      </dl>

      <p className='border-t px-4 py-2.5 text-[11px] leading-relaxed text-muted-foreground'>
        连接池指标属于当前控制面进程。数据库大小和健康探针通过只读查询获取。
      </p>
    </PanelCard>
  )
}
