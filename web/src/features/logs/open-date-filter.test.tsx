import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ActiveFiltersDisplay } from './filters/active-filters-display'
import { UsageLogsFilters } from './filters/usage-logs-filters'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))

const START = Date.parse('2026-11-21T09:15:30')
const END = Date.parse('2026-11-21T17:45:01')

function active(filters: { startTime?: number; endTime?: number }) {
  return renderToStaticMarkup(
    <ActiveFiltersDisplay
      isAdmin={false}
      filters={filters}
      options={undefined}
      onRemove={() => {}}
      onClearAll={() => {}}
    />
  )
}

describe('one-sided log date filters', () => {
  it('shows the local start boundary to the second', () => {
    const html = active({ startTime: START })
    expect(html).toContain('起始时间')
    expect(html).toContain('2026-11-21 09:15:30')
  })

  it('shows the inclusive local end boundary to the second', () => {
    const html = active({ endTime: END })
    expect(html).toContain('截止时间')
    expect(html).toContain('2026-11-21 17:45:00')
    expect(html).not.toContain('17:45:01')
  })

  it.each([
    [{ startTime: START }, '1'],
    [{ endTime: END }, '1'],
    [{}, undefined],
  ])('counts only the time section for %j', (filters, count) => {
    const html = renderToStaticMarkup(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <UsageLogsFilters
          isAdmin={false}
          filters={filters}
          onApply={() => {}}
          onReset={() => {}}
        />
      </QueryClientProvider>
    )
    const start = html.indexOf('时间范围</h3>')
    const section = html.slice(start, html.indexOf('</button>', start))
    const badge = section.match(/data-slot="badge"[^>]*>(\d+)<\/span>/)
    expect(badge?.[1]).toBe(count)
  })
})
