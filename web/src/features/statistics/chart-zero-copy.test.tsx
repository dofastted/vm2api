import type { StatisticsData } from '@/types/panel-statistics'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { StatisticsChartCard } from './statistics-chart-card'

const chartState = vi.hoisted(() => ({
  current: null as null | Record<string, unknown>,
}))

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return { ...actual, useQuery: () => chartState.current }
})

function renderChart(data: StatisticsData) {
  chartState.current = {
    data,
    isLoading: false,
    isPlaceholderData: false,
    isError: false,
  }
  return renderToStaticMarkup(
    <StatisticsChartCard dimensions={['model']} tz='Asia/Shanghai' />
  )
}

function data(series: StatisticsData['series']): StatisticsData {
  return {
    range: 'today',
    resolution: 'hour',
    dimension: 'model',
    tz: 'Asia/Shanghai',
    since: '2026-11-21T00:00:00+08:00',
    until: '2026-11-22T00:00:00+08:00',
    series,
    metrics: {
      cost: [{ date: '2026-11-20T16:00:00.000Z', alpha: 0 }],
      requests: [{ date: '2026-11-20T16:00:00.000Z', alpha: 0 }],
      tokens: [{ date: '2026-11-20T16:00:00.000Z', alpha: 0 }],
    },
    seriesTotals: {
      alpha: { cost: 0, requests: 0, tokens: 0 },
    },
    totals: {
      requests: 0,
      errors: 0,
      cost: 0,
      actualCost: 0,
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      cacheHitRate: 0,
      avgDurationMs: null,
      avgTtftMs: null,
    },
    deltas: { requests: null, cost: null, tokens: null },
  }
}

describe('statistics chart zero wording', () => {
  it('keeps the empty message when the response has no series', () => {
    const html = renderChart(data([]))
    expect(html).toContain('暂无统计数据')
    expect(html).not.toContain('当前显示的系列')
  })

  it('explains an explicit zero on the default cost metric', () => {
    const html = renderChart(
      data([{ id: 'alpha', name: 'Alpha', dataKey: 'alpha' }])
    )
    expect(html).toContain('当前显示的系列在所选时段内此指标为 0')
    expect(html).not.toContain('暂无统计数据')
  })
})
