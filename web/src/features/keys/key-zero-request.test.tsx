import { type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { shanghaiDay } from '../vm/vm-stats-model'
import { KeyStatsDialog } from './key-stats-dialog'
import { keyStatsQueryOptions } from './queries'

vi.mock('@/components/ui/dialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/dialog')>()),
  DialogContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

async function render(requests: number, errors: number) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const usage = {
    days: 30,
    since: null,
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
    vms: [],
  }
  await client.prefetchQuery({
    ...keyStatsQueryOptions('key-1'),
    queryFn: async () => ({ usage_stats: usage }),
  })
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <KeyStatsDialog
        item={{ id: 'key-1', name: 'Key' } as never}
        vms={[]}
        onOpenChange={() => undefined}
      />
    </QueryClientProvider>
  )
}

describe('key zero request wording', () => {
  it('renders the production key dialog states', async () => {
    expect(await render(0, 0)).toContain('此期间无请求')
    expect(await render(3, 0)).toContain('全部成功')
    expect(await render(3, 1)).toContain('含 1 次失败')
  })
})
