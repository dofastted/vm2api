import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LiveSessionsPanel } from './live-sessions-panel'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => () => {},
}))
vi.mock('@/lib/api', () => ({ api: vi.fn() }))

function renderPanel(data?: { total: number; sessions: unknown[] }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  if (data) {
    client.setQueryData(['panel', 'usage-logs-active-sessions', 5, 12], data)
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <LiveSessionsPanel />
    </QueryClientProvider>
  )
}

const session = {
  sessionId: 'session-abcdef',
  userName: 'alice',
  keyName: 'key',
  status: 'LIVE',
  lastSeenAt: '2026-11-21T05:00:00.000Z',
}

describe('live sessions log link', () => {
  it('shows a confirmed total beside the title and links to unfiltered logs', () => {
    const html = renderPanel({ total: 1, sessions: [session] })
    expect(html).toContain('>活跃 Session<')
    expect(html).toContain('近 5 分钟 · 共 1 个')
    expect(html).toContain('>查看请求日志<')
    expect(html).not.toContain('查看全部')
  })

  it('does not show zero before a successful response', () => {
    const html = renderPanel()
    expect(html).toContain('加载中...')
    expect(html).not.toContain('>0<')
    expect(html).not.toContain('查看请求日志')
  })

  it('states when the visible list is shorter than the five-minute total', () => {
    const html = renderPanel({ total: 14, sessions: [session] })
    expect(html).toContain('近 5 分钟 · 共 14 个 · 显示 1 个')
  })

  it('shows zero only for a successful empty snapshot', () => {
    const html = renderPanel({ total: 0, sessions: [] })
    expect(html).toContain('近 5 分钟 · 共 0 个')
    expect(html).not.toContain('· 显示')
    expect(html).toContain('暂无活跃 Session')
    expect(html).not.toContain('查看请求日志')
  })
})
