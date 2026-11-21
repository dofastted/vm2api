import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { KeyStatsDialog } from './key-stats-dialog'

const state = { isLoading: false, isError: false, data: undefined as unknown }
vi.mock('./queries', () => ({
  keyStatsQueryOptions: () => ({
    queryKey: ['key-stats'],
    queryFn: async () => state.data,
  }),
}))
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return { ...actual, useQuery: () => state }
})
vi.mock('@/components/ui/dialog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/dialog')>()
  const Pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>
  return { ...actual, DialogContent: Pass }
})

describe('key stats error wording', () => {
  it('renders a failed first load separately from an empty result', () => {
    state.isLoading = false
    state.isError = true
    state.data = undefined
    const failed = renderToStaticMarkup(
      <KeyStatsDialog
        item={{ id: 'key', group_type: 'openai' } as never}
        vms={[]}
        onOpenChange={() => {}}
      />
    )
    expect(failed).toContain('密钥统计加载失败')
    expect(failed).not.toContain('暂无统计数据')

    state.isError = false
    state.data = { usage_stats: null }
    const empty = renderToStaticMarkup(
      <KeyStatsDialog
        item={{ id: 'key', group_type: 'openai' } as never}
        vms={[]}
        onOpenChange={() => {}}
      />
    )
    expect(empty).toContain('暂无统计数据')
    expect(empty).not.toContain('密钥统计加载失败')
  })
})
