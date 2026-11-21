import { type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { VmStatsDialog } from './vm-stats-dialog'

vi.mock('@/lib/api', () => ({
  api: vi.fn(async () => ({
    billing: {
      usage_stats: { days: 30, history: [], models: [], endpoints: [] },
    },
  })),
}))
vi.mock('@/components/ui/dialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/dialog')>()),
  DialogContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

const vm = {
  id: 'vm-01',
  window_7d_requests: 8,
  window_7d_success: 7,
  window_7d_errors: 1,
} as Vm

describe('VM stats window wording', () => {
  it('names quota outcomes separately from the Shanghai usage trend', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    await client.prefetchQuery({
      queryKey: ['panel', 'vm', vm.id],
      queryFn: async () => ({
        billing: {
          usage_stats: { days: 30, history: [], models: [], endpoints: [] },
        },
      }),
    })
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <VmStatsDialog vm={vm} onOpenChange={() => undefined} />
      </QueryClientProvider>
    )

    expect(html).toContain('7 天额度窗口请求')
    expect(html).toContain('按上海自然日')
    expect(html).not.toContain('7D 请求')
  })
})
