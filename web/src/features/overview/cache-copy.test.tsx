import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { OverviewPage } from './index'

const overviewState = vi.hoisted(() => ({
  current: null as null | Record<string, unknown>,
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}))

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return { ...actual, useQuery: () => overviewState.current }
})

function renderOverview(summary: Record<string, unknown>) {
  overviewState.current = {
    data: { summary, totals: {}, ops: {} },
    isLoading: false,
    error: null,
  }
  return renderToStaticMarkup(<OverviewPage />)
}

describe('overview cache wording', () => {
  it('names the measured cache hit rate and token order', () => {
    const html = renderOverview({
      cache_hit_rate: 0.25,
      tokens_in: 10,
      tokens_out: 20,
    })
    expect(html).toContain('请求 · 缓存命中率 25%')
    expect(html).toContain('输入 10 / 输出 20 Token')
  })

  it('keeps a dash when no cache rate can be calculated', () => {
    const html = renderOverview({ tokens_in: 0, tokens_out: 0 })
    expect(html).toContain('请求 · 缓存命中率 —')
  })
})
