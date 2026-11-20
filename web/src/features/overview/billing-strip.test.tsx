import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { BillingStrip } from './billing-strip'

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import('@tanstack/react-query')
  return {
    ...actual,
    useQuery: () => ({ data: { items: [] }, isLoading: false, error: null }),
  }
})

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: string }) => (
    <a href={to}>{children}</a>
  ),
}))

describe('overview billing wording', () => {
  it('names the cumulative total as the retained log window', () => {
    const html = renderToStaticMarkup(
      <BillingStrip
        billing={{
          today: { total_cost: 1 },
          total: { total_cost: 2 },
          accounts: [],
        }}
      />
    )

    expect(html).toContain('当前日志保留窗口内')
    expect(html).not.toContain('日志窗口内全部请求')
  })
})
