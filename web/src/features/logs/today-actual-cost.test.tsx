import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LogsFullscreen } from './logs-fullscreen'

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: () => ({ data: { todayActualCost: 7.25 } }),
  }
})
vi.mock('./virtualized-logs-table', () => ({
  VirtualizedLogsTable: () => null,
}))

describe('request log today cost basis', () => {
  it('names actual billing instead of the shared spend label', () => {
    const html = renderToStaticMarkup(
      <LogsFullscreen
        title='请求日志'
        filters={{}}
        onOpenDetail={() => undefined}
        onExit={() => undefined}
      />
    )
    expect(html).toContain('今日消费 · 实际计费')
    expect(html).toContain('$7.25')
    expect(html).not.toContain('>今日消费<')
  })
})
