import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Dashboard } from '@/types/panel-overview'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ClusterPage } from './index'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))
vi.mock('@/features/vm/create-vm-dialog', () => ({
  CreateVmDialog: () => null,
}))
vi.mock('@/features/cluster/join-dialog', () => ({ JoinVpsDialog: () => null }))
vi.mock('@/features/cluster/ssh-panel', () => ({ SshPanel: () => null }))
vi.mock('@/features/cluster/migrate-slot-dialog', () => ({
  MigrateSlotDialog: () => null,
}))

const dashboard = {
  billing: {
    today: { total_cost: 1.2 },
    total: { total_cost: 9.5 },
  },
  vms: [],
} as unknown as Dashboard

describe('cluster spend wording', () => {
  it('names today as Beijing time and the total as retained logs', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(['panel', 'dashboard'], dashboard)
    client.setQueryData(['panel', 'me'], { role: 'user' })
    client.setQueryData(['panel', 'cluster', 'nodes'], [])
    client.setQueryData(['panel', 'cluster', 'local'], null)
    client.setQueryData(['panel', 'vm-pools'], { pools: [] })

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ClusterPage />
      </QueryClientProvider>
    )

    expect(html).toContain('今日花费 · 北京时间')
    expect(html).toContain('保留日志合计')
    expect(html).toContain('break-words')
    expect(html).not.toContain('累计 $')
  })
})
