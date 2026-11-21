import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { UsageLogsFilters } from './filters/usage-logs-filters'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))

function renderFilters(model?: string) {
  return renderToStaticMarkup(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <UsageLogsFilters
        isAdmin={false}
        filters={model ? { model } : {}}
        onApply={() => {}}
        onReset={() => {}}
      />
    </QueryClientProvider>
  )
}

describe('log draft action wording', () => {
  it('explains apply and immediate clear beside the actions', () => {
    const html = renderFilters()
    expect(html).toContain('单项修改需应用；清空全部立即生效')
    expect(html).toContain('>应用筛选<')
    expect(html).toContain('>重置<')
  })

  it('calls draft chips filter conditions rather than active filters', () => {
    const html = renderFilters('claude')
    expect(html).toContain('筛选条件:')
    expect(html).toContain('claude')
    expect(html).not.toContain('已激活筛选')
  })
})
