import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LogsPage } from './index'

const state = { isLoading: false, isError: false, data: undefined as unknown }
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    getRouteApi: () => ({ useNavigate: () => () => {}, useSearch: () => ({}) }),
  }
})
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: (options: Parameters<typeof actual.useQuery>[0]) =>
      options.queryKey[1] === 'request-logs-stats'
        ? state
        : actual.useQuery(options),
  }
})

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
})

describe('log error collection missing wording', () => {
  it('shows a failed first stats load without exposing a confirmed empty collection', () => {
    state.isError = true
    state.data = undefined
    const failed = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <LogsPage />
      </QueryClientProvider>
    )
    expect(failed).toContain('错误统计加载失败')

    state.isError = false
    state.data = {
      window: { error_collection: { by_class: [], ingress_hits: [] } },
    }
    const empty = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <LogsPage />
      </QueryClientProvider>
    )
    expect(empty).not.toContain('错误统计加载失败')
    expect(empty).not.toContain('错误集合')
  })
})
