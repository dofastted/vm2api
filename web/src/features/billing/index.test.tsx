import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { BillingPage } from './index'

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import('@tanstack/react-query')
  return {
    ...actual,
    useQuery: () => ({
      data: { items: [], totals: null },
      isLoading: false,
      error: null,
    }),
  }
})

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: string }) => (
    <a href={to}>{children}</a>
  ),
}))

vi.mock('@/hooks/use-vm-index', () => ({
  useVmIndex: () => ({ vms: [] }),
}))

describe('billing window wording', () => {
  it('states that billing uses the retained request-log window', () => {
    const html = renderToStaticMarkup(<BillingPage />)

    expect(html).toContain(
      '当前日志保留窗口内的请求、成功、失败和费用。保留时间在设置的日志保留页调整。'
    )
  })
})
