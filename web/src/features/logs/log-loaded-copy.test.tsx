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

function renderLogs(
  hasNextPage: boolean,
  pages: Array<{ logs: Array<Record<string, string>> }> = [
    { logs: [{ id: 'log-1', created_at: '2026-11-21T00:00:00Z' }] },
  ]
) {
  queryState.current = {
    data: { pages },
    error: null,
    isLoading: false,
    hasNextPage,
    isFetchingNextPage: false,
    fetchNextPage: () => {},
  }
  return renderToStaticMarkup(
    <VirtualizedLogsTable
      filters={{}}
      autoRefreshEnabled={false}
      onOpenDetail={() => {}}
    />
  )
}

describe('loaded log status wording', () => {
  it('asks to scroll when another page cursor remains', () => {
    const html = renderLogs(true)
    expect(html).toContain('已加载')
    expect(html).toContain('向下滚动以继续查找')
    expect(html).not.toContain('还有更多记录')
  })

  it('states that every record is loaded when the cursor ends', () => {
    const html = renderLogs(false)
    expect(html).toContain('已加载全部记录')
    expect(html).not.toContain('向下滚动以继续查找')
  })

  it('does not ask to scroll while an empty trailing page auto-scans', () => {
    const html = renderLogs(true, [
      { logs: [{ id: 'log-1', created_at: '2026-11-21T00:00:00Z' }] },
      { logs: [] },
    ])
    expect(html).toContain('正在自动查找下一页…')
    expect(html).not.toContain('向下滚动以继续查找')
    expect(html).not.toContain('已加载全部记录')
  })
})
