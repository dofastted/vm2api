import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { BillingPage } from './index'

vi.mock('@/features/vm/crag-license-editor', () => ({
  CragShopLink: () => null,
}))

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: () => ({
      data: {
        items: [],
        totals: { requests: 3, ok: 2, fail: 1, cost_usd: 4 },
      },
      isLoading: false,
      error: null,
    }),
  }
})

describe('billing scope wording', () => {
  it('states which summary follows the filter and which cards stay global', () => {
    const html = renderToStaticMarkup(<BillingPage />)
    expect(html).toContain('当前筛选汇总')
    expect(html).toContain('平台费用对比（不受平台筛选影响）')
  })
})
