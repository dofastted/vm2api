import type { StatisticsData } from '@/types/panel-statistics'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TenantUsage } from './tenant-usage'

const pastState = vi.hoisted(() => ({
  current: null as null | Record<string, unknown>,
}))

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: (options: { queryKey?: readonly unknown[] }) => {
      const key = options.queryKey ?? []
      if (key[2] === 'chart') return pastState.current
      return { data: undefined, isError: false, isLoading: true }
    },
  }
})

function chart(cost: number): StatisticsData {
  return {
    range: '7days',
    resolution: 'day',
    dimension: 'model',
    tz: 'Asia/Shanghai',
    since: '2026-11-15T00:00:00.000Z',
    until: '2026-11-22T00:00:00.000Z',
    series: [],
    metrics: { cost: [], requests: [], tokens: [] },
    seriesTotals: {},
    totals: {
      requests: 8,
      errors: 1,
      cost,
      actualCost: cost,
      tokens: 20,
      inputTokens: 7,
      outputTokens: 13,
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

function historyCard(html: string) {
  const history = html.split('区间用量')[1]
  expect(history).toEqual(expect.any(String))
  return history
}

function renderUsage() {
  return renderToStaticMarkup(<TenantUsage tz='Asia/Shanghai' />)
}

describe('tenant history placeholder isolation', () => {
  it('keeps the loading grid while a new range still holds the previous totals', () => {
    pastState.current = {
      data: chart(12.5),
      isError: false,
      isLoading: false,
      isPlaceholderData: true,
    }
    const history = historyCard(renderUsage())
    expect(history).toContain('data-slot="skeleton"')
    expect(history).not.toContain('$12.50')
  })

  it('shows the current totals while the same range refreshes', () => {
    pastState.current = {
      data: chart(4.25),
      isError: false,
      isLoading: false,
      isFetching: true,
      isPlaceholderData: false,
    }
    const history = historyCard(renderUsage())
    expect(history).toContain('$4.25')
    expect(history).not.toContain('data-slot="skeleton"')
  })
})
