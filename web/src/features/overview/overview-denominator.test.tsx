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
      data: {
        vms: [
          { id: 'a', has_token: true },
          { id: 'b', has_token: false },
        ],
        summary: {},
        totals: {},
        ops: {},
      },
      isLoading: false,
      error: null,
    }),
  }
})

describe('overview denominator wording', () => {
  it('names the different denominators beside the two ratios', () => {
    const html = renderToStaticMarkup(<OverviewPage />)
    expect(html).toContain('分母：有凭证的账号')
    expect(html).toContain('分母：全部虚拟机')
  })
})
