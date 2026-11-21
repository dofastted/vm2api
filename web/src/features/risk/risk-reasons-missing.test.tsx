import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RiskStatus } from './status-panel'

const state = { isLoading: false, isError: false, data: undefined as unknown }
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: (options: { queryKey?: unknown[] }) =>
      options.queryKey?.[1] === 'protocol-entry'
        ? state
        : {
            data: { items: [], rows: [], more: false },
            isLoading: false,
            isError: false,
          },
  }
})

function renderStatus() {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <RiskStatus
        onOpen={() => {}}
        onOpenSource={() => {}}
        onLocateRule={() => {}}
      />
    </QueryClientProvider>
  )
}

describe('risk pass reason wording', () => {
  it('keeps loading and failure distinct from a confirmed empty reason list', () => {
    state.isLoading = true
    const loading = renderStatus()
    expect(loading).toContain('读取中')
    expect(loading).not.toContain('暂无放行原因。')

    state.isLoading = false
    state.isError = true
    const failed = renderStatus()
    expect(failed).toContain('放行原因读取失败')

    state.isError = false
    state.data = { reasons: [] }
    const empty = renderStatus()
    expect(empty).toContain('暂无放行原因。')
  })
})
