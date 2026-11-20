import { type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { VmListPage } from './list-page'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}))
vi.mock('@/features/vm/create-vm-dialog', () => ({
  CreateVmDialog: () => null,
}))
vi.mock('@/features/vm/use-pool-seat-stream', () => ({
  usePoolSeatStream: () => undefined,
}))
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectTrigger: ({ children }: { children?: ReactNode }) => (
    <button type='button'>{children}</button>
  ),
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({ children }: { children?: ReactNode }) => (
    <div role='option'>{children}</div>
  ),
}))

describe('VM today sort wording', () => {
  it('names the Shanghai-calendar sort as Beijing time', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(['panel', 'me'], { role: 'user' })
    client.setQueryData(['panel', 'vms'], [])
    client.setQueryData(['panel', 'usage'], { accounts: [] })

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <VmListPage />
      </QueryClientProvider>
    )

    expect(html).toContain('今日花费 · 北京时间')
    expect(html).not.toContain('>今日花费<')
    expect(html).toContain('7 天窗口费用')
    expect(html).not.toContain('7D 费用')
  })
})
