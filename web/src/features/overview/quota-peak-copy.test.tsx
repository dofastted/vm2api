import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { OverviewPage } from './index'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}))

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: () => ({
      data: { summary: { peak_5h: 0.42 }, totals: {}, ops: {} },
      isLoading: false,
      error: null,
    }),
  }
})

describe('overview quota peak wording', () => {
  it('describes the maximum account quota usage', () => {
    const html = renderToStaticMarkup(<OverviewPage />)
    expect(html).toContain('5h 额度使用率')
    expect(html).toContain('取账号最高值')
    expect(html).not.toContain('5h 峰值')
  })
})
