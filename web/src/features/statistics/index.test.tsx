import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { StatisticsPage } from './index'

const overviewState = vi.hoisted(() => ({
  todayAvgDurationMs: null as number | null,
  yesterdayAvgDurationMs: null as number | null,
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
          data: {
            todayAvgDurationMs: overviewState.todayAvgDurationMs,
            yesterdayAvgDurationMs: overviewState.yesterdayAvgDurationMs,
          },
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
    overviewState.yesterdayAvgDurationMs = null
    const card = responseCard(renderToStaticMarkup(<StatisticsPage />))
    expect(card).toContain('>—</h3>')
    expect(card).not.toContain('0ms')
  })

  it('shows a measured zero duration', () => {
    overviewState.todayAvgDurationMs = 0
    overviewState.yesterdayAvgDurationMs = null
    const card = responseCard(renderToStaticMarkup(<StatisticsPage />))
    expect(card).toContain('>0ms<')
    expect(card).not.toContain('>—</h3>')
  })

  it('keeps a real decrease pointed down', () => {
    overviewState.todayAvgDurationMs = 80
    overviewState.yesterdayAvgDurationMs = 100
    const html = renderToStaticMarkup(<StatisticsPage />)
    const start = html.indexOf('平均响应时间')
    const card = html.slice(start, start + 1200)
    expect(card).toContain('>−20%<')
    expect(card).toContain('较昨日同期')
    expect(card).toContain('lucide-arrow-down')
    expect(card).toContain('text-emerald-500')
    expect(card).not.toContain('>+20%<')
    expect(card).not.toContain('lucide-arrow-up')
  })
})
