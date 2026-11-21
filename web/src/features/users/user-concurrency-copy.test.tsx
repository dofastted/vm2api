import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: () => ({
      data: { items: [{ id: 'u1', role: 'user', concurrency: 0 }] },
      isLoading: false,
    }),
  }
})

describe('user concurrency wording', () => {
  it('names the configured limit rather than a live count', async () => {
    vi.stubGlobal('localStorage', { getItem: () => '', setItem: () => {} })
    try {
      const { UsersPage } = await import('./index')
      const html = renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          <UsersPage />
        </QueryClientProvider>
      )
      expect(html).toContain('用户并发上限')
      expect(html).toContain('不限')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
