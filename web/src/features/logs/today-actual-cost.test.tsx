import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LogsFullscreen } from './logs-fullscreen'

const state = { isError: false, data: undefined as unknown }
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return { ...actual, useQuery: () => state }
})
vi.mock('./virtualized-logs-table', () => ({
  VirtualizedLogsTable: () => null,
}))

function renderLogs() {
  return renderToStaticMarkup(
    <LogsFullscreen
      title='请求日志'
      filters={{}}
      onOpenDetail={() => undefined}
      onExit={() => undefined}
    />
  )
}

describe('request log today cost basis', () => {
  it('names actual billing instead of the shared spend label', () => {
    state.isError = false
    state.data = { todayActualCost: 7.25 }
    const html = renderLogs()
    expect(html).toContain('今日消费 · 实际计费')
    expect(html).toContain('$7.25')
    expect(html).not.toContain('>今日消费<')
  })

  it('keeps missing data distinct from a successful zero and a failed refresh', () => {
    state.isError = false
    state.data = undefined
    const missing = renderLogs()
    expect(missing).toContain('>—<')
    expect(missing).not.toContain('概览加载失败')

    state.isError = true
    const failed = renderLogs()
    expect(failed).toContain('概览加载失败')

    state.isError = false
    state.data = { activeSessions: 0, todayRequests: 0, todayActualCost: 0 }
    const zero = renderLogs()
    expect(zero).toContain('>$0.00<')
    expect(zero).not.toContain('概览加载失败')

    state.isError = true
    const refreshFailed = renderLogs()
    expect(refreshFailed).toContain('>$0.00<')
    expect(refreshFailed).not.toContain('概览加载失败')
  })
})
