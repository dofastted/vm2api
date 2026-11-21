import { type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { VmStatsDialog } from './vm-stats-dialog'
import { shanghaiDay } from './vm-stats-model'

vi.mock('@/components/ui/dialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/dialog')>()),
  DialogContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

const vm = { id: 'vm-01' } as Vm

async function render(requests: number, errors: number) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const usage = {
    days: 30,
    history: [
      {
        day: shanghaiDay(Date.now()),
        requests,
        errors,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        total_cost: 0,
        duration_ms_sum: 0,
        duration_n: 0,
      },
    ],
    models: [],
    endpoints: [],
  }
  await client.prefetchQuery({
    queryKey: ['panel', 'vm', vm.id, usage],
    queryFn: async () => ({ billing: { usage_stats: usage } }),
  })
  client.setQueryData(['panel', 'vm', vm.id], {
    billing: { usage_stats: usage },
  })
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <VmStatsDialog vm={vm} onOpenChange={() => undefined} />
    </QueryClientProvider>
  )
}

describe('VM stats empty success wording', () => {
  it('does not call zero requests a complete success', async () => {
    const empty = await render(0, 0)
    expect(empty).toContain('窗口内无请求')
    expect(empty).not.toContain('全部成功')

    const clean = await render(4, 0)
    expect(clean).toContain('全部成功')
    expect(clean).not.toContain('窗口内无请求')
  })
})
