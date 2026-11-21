import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { StatisticsPage } from './index'

const state = { isError: false, data: undefined as unknown }
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: (options: { queryKey?: unknown[] }) =>
      options.queryKey?.[0] === 'panel' &&
      options.queryKey?.[1] === 'usage-logs-overview'
        ? state
        : { data: { metrics: { cost: [] } }, isLoading: false, isError: false },
  }
})

function card(html: string, title: string) {
  const start = html.indexOf(`>${title}<`)
  if (start < 0) throw new Error(`${title} missing`)
  return html.slice(start, start + 1200)
}

describe('statistics overview missing wording', () => {
  it('keeps missing overview metrics distinct from successful zeros', () => {
    state.data = undefined
    const missing = renderToStaticMarkup(<StatisticsPage />)
    const session = card(missing, '活跃 Session')
    expect(session).toContain('>—<')
    expect(session).not.toContain('>RPM<')

    state.data = { activeSessions: 0, rpm: 0, todayRequests: 0, todayCost: 0 }
    const zero = renderToStaticMarkup(<StatisticsPage />)
    expect(card(zero, '活跃 Session')).toContain('>0<')
    expect(card(zero, '活跃 Session')).toContain('>RPM<')
    expect(card(zero, '今日请求')).toContain('>0<')
    expect(card(zero, '今日消费 · 官方价')).toContain('$0.00')
  })
})
