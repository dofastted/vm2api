import type { VmProxySnap } from '@/types/panel-vm'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  HealthBar,
  HealthDonut,
  HealthLegend,
} from '@/features/overview/health-gauge'
import {
  proxyHealthBuckets,
  proxyHealthScoreOf,
} from '@/features/proxies/proxy-health-summary'

type ProxySummaryProps = {
  total: number
  totals: Record<string, unknown>
  slotsUsed: number
  slotsCap: number
  list: VmProxySnap[]
}

export function ProxySummary(props: ProxySummaryProps) {
  const { total, totals: tot, slotsUsed, slotsCap, list } = props
  const score = proxyHealthScoreOf(list)
  const buckets = proxyHealthBuckets(list)
  return (
    <div className='mb-4 space-y-3'>
      <Card className='shadow-none'>
        <CardContent className='flex flex-wrap items-center gap-6 pt-6'>
          <HealthDonut score={score} label='健康' />
          <div className='min-w-0 flex-1 space-y-2.5'>
            <HealthBar buckets={buckets} total={list.length} />
            <HealthLegend buckets={buckets} />
          </div>
        </CardContent>
      </Card>
      <div className='grid gap-3 sm:grid-cols-4'>
        <Card>
          <CardHeader className='pb-2'>
            <CardTitle className='text-sm'>总数</CardTitle>
          </CardHeader>
          <CardContent className='field-count'>{String(total)}</CardContent>
        </Card>
        <Card>
          <CardHeader className='pb-2'>
            <CardTitle className='text-sm'>健康</CardTitle>
          </CardHeader>
          <CardContent className='field-count text-ok-3'>
            {String(tot.ok ?? 0)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className='pb-2'>
            <CardTitle className='text-sm'>已绑 / 容量</CardTitle>
          </CardHeader>
          <CardContent className='field-count'>
            {String(slotsUsed)} / {String(slotsCap || '—')}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className='pb-2'>
            <CardTitle className='text-sm'>失效</CardTitle>
          </CardHeader>
          <CardContent className='field-count text-red-3'>
            {String(tot.dead ?? 0)}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
