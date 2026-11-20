import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { StatisticsPage } from './index'

const overviewState = vi.hoisted(() => ({
  todayAvgDurationMs: null as number | null,
}))

const EMPTY_STATISTICS = {
  range: 'today',
  dimension: 'user',
  tz: 'UTC',
  buckets: [],
  series: [],
  totals: { cost: [], requests: [], tokens: [] },
  metrics: { cost: [], requests: [], tokens: [] },
}

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import('@tanstack/react-query')
  return {
    ...actual,
    useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
      if (queryKey[0] === 'panel' && queryKey[1] === 'me') {
        return { data: { role: 'admin' }, isLoading: false, error: null }
      }
      if (queryKey[0] === 'panel' && queryKey[1] === 'statistics') {
        return { data: EMPTY_STATISTICS, isLoading: false, error: null }
      }
      if (queryKey[0] === 'panel' && queryKey[1] === 'usage-logs-overview') {
        return {
          data: { todayAvgDurationMs: overviewState.todayAvgDurationMs },
          isLoading: false,
          error: null,
        }
      }
      return {
        data: { entries: [], active: [] },
        isLoading: false,
        error: null,
      }
    },
  }
})

describe('statistics VM labels', () => {
  it('names the VM leaderboard as virtual machines', () => {
    const html = renderToStaticMarkup(<StatisticsPage />)

    expect(html).toContain('虚拟机排行')
    expect(html).toContain('>虚拟机<')
    expect(html).not.toContain('供应商排行')
    expect(html).not.toContain('>供应商<')
  })
})

function responseCard(html: string) {
  const start = html.indexOf('平均响应时间')
  expect(start).toBeGreaterThanOrEqual(0)
  return html.slice(start, start + 500)
}

describe('statistics duration card', () => {
  it('shows a dash when today has no duration sample', () => {
    overviewState.todayAvgDurationMs = null
    const card = responseCard(renderToStaticMarkup(<StatisticsPage />))
    expect(card).toContain('>—</h3>')
    expect(card).not.toContain('0ms')
  })

  it('shows a measured zero duration', () => {
    overviewState.todayAvgDurationMs = 0
    const card = responseCard(renderToStaticMarkup(<StatisticsPage />))
    expect(card).toContain('>0ms<')
    expect(card).not.toContain('>—</h3>')
  })
})
