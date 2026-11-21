import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { VirtualizedLogsTable } from './virtualized-logs-table'

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useInfiniteQuery: () => ({
      data: { pages: [{ logs: [] }] },
      isLoading: false,
      error: null,
      hasNextPage: false,
    }),
  }
})

describe('filtered log empty wording', () => {
  it('uses applied filters rather than an unsubmitted draft', () => {
    const filtered = renderToStaticMarkup(
      <VirtualizedLogsTable
        filters={{ status: 'error' } as never}
        draft={{}}
        onOpenDetail={() => {}}
      />
    )
    expect(filtered).toContain('没有符合当前筛选条件的日志')
    const unfiltered = renderToStaticMarkup(
      <VirtualizedLogsTable
        filters={{}}
        draft={{ status: 'error' } as never}
        onOpenDetail={() => {}}
      />
    )
    expect(unfiltered).toContain('暂无数据')
    expect(unfiltered).not.toContain('没有符合当前筛选条件的日志')
    const mutedOnly = renderToStaticMarkup(
      <VirtualizedLogsTable
        filters={{ excludeErrorClass: 'auth' } as never}
        onOpenDetail={() => {}}
      />
    )
    expect(mutedOnly).toContain('暂无数据')
  })
})
