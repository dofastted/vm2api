import type { StatisticsData } from '@/types/panel-statistics'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { StatisticsChartCard } from './statistics-chart-card'

const queryState = vi.hoisted(() => ({
  current: null as null | Record<string, unknown>,
}))

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return { ...actual, useQuery: () => queryState.current }
})
vi.mock('recharts', () => ({
  Area: () => null,
  AreaChart: ({ children }: { children?: unknown }) => (
    <div>{children as never}</div>
  ),
  CartesianGrid: () => null,
  ResponsiveContainer: ({ children }: { children?: unknown }) => (
    <div data-chart='ready'>{children as never}</div>
  ),
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}))

function snapshot(name: string): StatisticsData {
  return {
    range: 'today',
    resolution: 'hour',
    dimension: 'model',
    tz: 'Asia/Shanghai',
    since: '2026-11-21T00:00:00.000Z',
    until: '2026-11-22T00:00:00.000Z',
    series: [
      { id: 'model-a', name, dataKey: 'model-a' },
      { id: 'model-b', name: `${name}-对照`, dataKey: 'model-b' },
    ],
    metrics: {
      cost: [{ date: '2026-11-21T00:00:00.000Z', 'model-a': 2, 'model-b': 1 }],
      requests: [
        { date: '2026-11-21T00:00:00.000Z', 'model-a': 1, 'model-b': 1 },
      ],
      tokens: [
        { date: '2026-11-21T00:00:00.000Z', 'model-a': 10, 'model-b': 4 },
      ],
    },
    seriesTotals: {
      'model-a': { cost: 2, requests: 1, tokens: 10 },
      'model-b': { cost: 1, requests: 1, tokens: 4 },
    },
    totals: {
      requests: 1,
      errors: 0,
      cost: 2,
      actualCost: 2,
      tokens: 10,
      inputTokens: 4,
      outputTokens: 6,
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

function renderChart() {
  return renderToStaticMarkup(
    <StatisticsChartCard dimensions={['model']} tz='Asia/Shanghai' />
  )
}

describe('statistics chart placeholder isolation', () => {
  it('hides previous-key data while the selected query is still a placeholder', () => {
    queryState.current = {
      data: snapshot('旧七日模型'),
      error: null,
      isLoading: false,
      isFetching: true,
      isPlaceholderData: true,
    }
    const html = renderChart()
    expect(html).toContain('data-slot="skeleton"')
    expect(html).toContain('>—</span>')
    expect(html).not.toContain('暂无统计数据')
    expect(html).not.toContain('>旧七日模型<')
    expect(html).not.toContain('data-chart="ready"')
  })

  it('keeps the current chart while the same key refreshes', () => {
    queryState.current = {
      data: snapshot('当前模型'),
      error: null,
      isLoading: false,
      isFetching: true,
      isPlaceholderData: false,
    }
    const html = renderChart()
    expect(html).toContain('>当前模型<')
    expect(html).toContain('data-chart="ready"')
    expect(html).not.toContain('data-slot="skeleton"')
  })
})
