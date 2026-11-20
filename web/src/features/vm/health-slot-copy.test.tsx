import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { VmRowDetail } from './vm-row-detail'

const healthState = vi.hoisted(() => ({
  current: null as null | Record<string, unknown>,
}))

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return { ...actual, useQuery: () => healthState.current }
})

function renderDetail() {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <VmRowDetail
        vm={{ id: 'vm-7' } as Vm}
        now={Date.parse('2026-11-21T00:00:00Z')}
        onOpenDetail={() => {}}
        id='vm-7-detail'
      />
    </QueryClientProvider>
  )
}

describe('request health slot wording', () => {
  it('states active slot count and the seven-day slot width', () => {
    healthState.current = {
      data: {
        range: '24h',
        slot_min: 120,
        start: '2026-11-14T00:00:00Z',
        buckets: [[1, 0]],
        top_errors: [],
      },
      isPending: false,
      isError: false,
    }
    const html = renderDetail()
    expect(html).toContain('有请求的时间段')
    expect(html).toContain('1 段 · 每段 2 小时')
    expect(html).not.toContain('有请求时长')
  })
})
