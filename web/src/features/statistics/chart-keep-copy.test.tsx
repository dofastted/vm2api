import type { StatisticsData } from '@/types/panel-statistics'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { StatisticsChartCard } from './statistics-chart-card'

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: () => ({
      data: chartData(),
      isLoading: false,
      isPlaceholderData: false,
      isError: false,
    }),
  }
})

function chartData(): StatisticsData {
  const totals = { cost: 1, requests: 1, tokens: 1 }
  return {
    range: 'today',
    resolution: 'hour',
    dimension: 'model',
    tz: 'Asia/Shanghai',
    since: '2026-11-21T00:00:00+08:00',
    until: '2026-11-22T00:00:00+08:00',
    series: [
      { id: 'alpha', name: 'Alpha', dataKey: 'alpha' },
      { id: 'beta', name: 'Beta', dataKey: 'beta' },
    ],
    metrics: {
      cost: [{ date: '2026-11-20T16:00:00.000Z', alpha: 1, beta: 1 }],
      requests: [{ date: '2026-11-20T16:00:00.000Z', alpha: 1, beta: 1 }],
      tokens: [{ date: '2026-11-20T16:00:00.000Z', alpha: 1, beta: 1 }],
    },
    seriesTotals: { alpha: totals, beta: totals },
    totals: {
      requests: 2,
      errors: 0,
      cost: 2,
      actualCost: 2,
      tokens: 2,
      inputTokens: 2,
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

describe('statistics legend action wording', () => {
  it('names the action that keeps one series', () => {
    const html = renderToStaticMarkup(
      <StatisticsChartCard dimensions={['model']} tz='Asia/Shanghai' />
    )
    expect(html).toContain('仅保留一项')
    expect(html).not.toContain('清空')
  })
})
