import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { StatisticsPage } from './index'

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: (options: { queryKey: readonly unknown[] }) => {
      if (options.queryKey[1] === 'usage-logs-overview') {
        return {
          isLoading: false,
          error: null,
          data: { todayCost: 12.5, yesterdayCost: 10 },
        }
      }
      return { isLoading: false, error: null, data: { role: 'admin' } }
    },
  }
})

vi.mock('@/components/page-header', () => ({
  PageHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/components/query-gate', () => ({
  QueryGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('./bento', () => ({
  BentoGrid: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('./metric-card', () => ({
  BentoMetricCard: ({ title, value }: { title: string; value: number }) => (
    <div>
      {title}:{value}
    </div>
  ),
}))
vi.mock('./leaderboard-card', () => ({ LeaderboardCard: () => null }))
vi.mock('./leaderboard-section', () => ({ LeaderboardSection: () => null }))
vi.mock('./live-sessions-panel', () => ({ LiveSessionsPanel: () => null }))
vi.mock('./statistics-chart-card', () => ({ StatisticsChartCard: () => null }))
vi.mock('./tenant-usage', () => ({ TenantUsage: () => null }))

describe('statistics today cost basis', () => {
  it('names the official-price field instead of the shared spend label', () => {
    const html = renderToStaticMarkup(<StatisticsPage />)
    expect(html).toContain('今日消费 · 官方价:12.5')
    expect(html).not.toContain('今日消费 · 官方价:0')
    expect(html).not.toContain('>今日消费<')
  })
})
