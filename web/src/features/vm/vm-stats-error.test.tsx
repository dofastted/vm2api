import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { VmStatsDialog } from './vm-stats-dialog'

const state = { isLoading: false, isError: false, data: undefined as unknown }
vi.mock('./queries', () => ({
  vmQueryOptions: () => ({ queryKey: ['vm'], queryFn: async () => state.data }),
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

function renderDialog() {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <VmStatsDialog
        vm={{ id: 'vm-a', name: 'VM A' } as never}
        onOpenChange={() => {}}
      />
    </QueryClientProvider>
  )
}

describe('VM stats error wording', () => {
  it('renders a failed first load separately from an empty result', () => {
    state.isLoading = false
    state.isError = true
    state.data = undefined
    const failed = renderDialog()
    expect(failed).toContain('VM 统计加载失败')
    expect(failed).not.toContain('暂无统计数据')

    state.isError = false
    state.data = { billing: { usage_stats: null } }
    const empty = renderDialog()
    expect(empty).toContain('暂无统计数据')
    expect(empty).not.toContain('VM 统计加载失败')
  })
})
