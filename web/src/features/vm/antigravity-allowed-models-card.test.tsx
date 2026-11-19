import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AllowedModelsCard } from './allowed-models-card'

describe('Antigravity slot model allowlist', () => {
  it('uses the actual slot catalog instead of Claude or GPT policy', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(['panel', 'me'], { role: 'admin' })
    client.setQueryData(['panel', 'vm', 'vm-ag', 'antigravity'], {
      model_catalog: {
        updated_at: '2026-10-22T00:00:00Z',
        models: [
          {
            id: 'gemini-example',
            display_name: 'Gemini from slot',
            levels: ['low', 'high'],
          },
          {
            id: 'claude-example',
            display_name: 'Claude from slot',
            levels: [],
          },
        ],
      },
    })
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <AllowedModelsCard
          vm={{
            id: 'vm-ag',
            platform: 'antigravity',
            allowed_models: ['gemini-example'],
          }}
        />
      </QueryClientProvider>
    )
    expect(html).toContain('Gemini from slot (low/high)')
    expect(html).toContain('Claude from slot')
    expect(html).toContain('同步账号模型')
    expect(
      client
        .getQueryCache()
        .getAll()
        .some((query) => query.queryKey.includes('model-policy'))
    ).toBe(false)
    client.clear()
  })

  it('shows tenant saved restrictions without allowing global policy edits', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(['panel', 'me'], { role: 'user' })
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <AllowedModelsCard
          vm={{
            id: 'vm-ag',
            platform: 'antigravity',
            allowed_models: ['gemini-example'],
          }}
        />
      </QueryClientProvider>
    )
    expect(html).toContain('gemini-example')
    expect(html).not.toContain('同步账号模型')
    expect(html).not.toContain('全选（继承）')
    client.clear()
  })
})
