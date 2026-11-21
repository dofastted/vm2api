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
        vms: [{ id: 'a', status: '' }],
        summary: {},
        totals: {},
        ops: {},
      },
      isLoading: false,
      error: null,
    }),
  }
})

describe('overview running wording', () => {
  it('describes the status-derived running count', () => {
    const html = renderToStaticMarkup(<OverviewPage />)
    expect(html).toContain('判定为运行的虚拟机')
    expect(html).not.toContain('>在线<')
  })
})
