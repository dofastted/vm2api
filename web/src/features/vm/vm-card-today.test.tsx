import { type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { VmDetailCard } from './vm-detail-card'
import { VmRowDetail } from './vm-row-detail'

vi.mock('./vm-actions-context', () => ({ useVmActions: () => ({}) }))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}))
vi.mock('@/components/ui/dialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/dialog')>()),
  DialogContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

const vm = { id: 'vm-01', today_cost: 1.25, today_requests: 3 } as Vm

function render(node: ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>
  )
}

async function renderLoaded(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(['panel', 'vm', 'vm-01', 'health', '24h'], {
    range: '24h',
    slot_min: 30,
    start: '2026-11-21T00:00:00.000Z',
    buckets: [[1, 0]],
    top_errors: [],
  })
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>
  )
}

describe('VM card today cost wording', () => {
  it('names Shanghai-calendar spend as Beijing time', async () => {
    const card = render(<VmDetailCard vm={vm} onOpenChange={() => undefined} />)
    const row = await renderLoaded(
      <VmRowDetail
        vm={vm}
        now={0}
        onOpenDetail={() => undefined}
        id='vm-row-detail-vm-01'
      />
    )

    for (const html of [card, row]) {
      expect(html).toContain('今日 · 北京时间')
      expect(html).toContain('$1.25')
    }
    expect(card).toContain('7 天窗口请求')
    expect(card).toContain('7 天窗口 · 成功 / 失败')
    expect(card).not.toContain('7D 请求')
    expect(card).not.toContain('7D 窗口')
    expect(row).toContain('近 7 天')
    expect(row).toContain('7 天额度窗口')
    expect(row).toContain('7 天额度窗口 · 成功 / 失败')
    expect(row).toContain('每请求 · 7 天额度窗口')
    expect(row).not.toContain('>7D</button>')
    expect(row).not.toContain('7D 成功 / 失败')
    expect(row).not.toContain('每请求 · 7D')
    expect(row).toContain('有请求的时间段')
    expect(row).toContain('1 段 · 每段 30 分钟')
    expect(row).not.toContain('有请求时长')
  })
})
