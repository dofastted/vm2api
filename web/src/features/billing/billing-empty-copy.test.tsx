import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { BillingPage } from './index'

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: () => ({
      data: {
        items: [],
        totals: {
          requests: 0,
          ok: 0,
          fail: 0,
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: 0,
        },
      },
      isLoading: false,
      error: null,
    }),
  }
})

vi.mock('@/features/vm/crag-license-editor', () => ({
  CragShopLink: () => null,
}))
vi.mock('@/hooks/use-vm-index', () => ({
  useVmIndex: () => ({ vms: new Map() }),
}))

const platformState = vi.hoisted(() => ({
  current: 'all' as 'all' | 'claude' | 'codex',
}))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: (initial: unknown) =>
      initial === 'all'
        ? [platformState.current, () => {}]
        : [initial, () => {}],
  }
})

describe('filtered billing empty wording', () => {
  it('keeps the global empty message without a platform filter', () => {
    platformState.current = 'all'
    const html = renderToStaticMarkup(<BillingPage />)
    expect(html).toContain('暂无计费数据')
    expect(html).not.toContain('当前筛选未显示计费明细')
  })

  it('does not claim the selected platform has no billing when its rows are absent', () => {
    platformState.current = 'claude'
    const html = renderToStaticMarkup(<BillingPage />)
    expect(html).toContain('当前筛选未显示计费明细')
    expect(html).not.toContain('当前平台暂无计费明细')
  })
})
