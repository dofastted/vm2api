import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { VirtualizedLogsTable } from './virtualized-logs-table'

const queryState = vi.hoisted(() => ({
  current: null as null | Record<string, unknown>,
}))

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return { ...actual, useInfiniteQuery: () => queryState.current }
})

function renderTable() {
  return renderToStaticMarkup(
    <VirtualizedLogsTable
      filters={{}}
      autoRefreshEnabled={false}
      onOpenDetail={() => {}}
    />
  )
}

describe('filtered log search status', () => {
  it('explains an empty page that still has more pages to scan', () => {
    queryState.current = {
      data: { pages: [{ logs: [] }] },
      error: null,
      isLoading: false,
      hasNextPage: true,
      isFetchingNextPage: false,
      fetchNextPage: () => {},
    }
    const html = renderTable()
    expect(html).toContain('role="status"')
    expect(html).toContain('正在查找符合条件的日志…')
    expect(html).not.toContain('本次查询未返回日志')
  })

  it('shows the empty result only after the scan ends', () => {
    queryState.current = {
      data: { pages: [{ logs: [] }] },
      error: null,
      isLoading: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: () => {},
    }
    const html = renderTable()
    expect(html).toContain('本次查询未返回日志')
    expect(html).not.toContain('正在查找符合条件的日志')
  })
})
