import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AntigravityModelSync } from './antigravity-model-sync'
import { vmSchedulableProps } from './schedulable-switch'

describe('Antigravity model synchronization', () => {
  it('shows only authorized Antigravity slots in the global settings picker', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(['panel', 'vms'], {
      items: [
        {
          id: 'vm-ready',
          platform: 'antigravity',
          antigravity: { authenticated: true },
        },
        {
          id: 'vm-empty',
          platform: 'antigravity',
          antigravity: { authenticated: false },
        },
        { id: 'vm-gpt', platform: 'openai', has_token: true },
      ],
    })
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <AntigravityModelSync />
      </QueryClientProvider>
    )
    expect(html).toContain('vm-ready')
    expect(html).not.toContain('vm-empty')
    expect(html).not.toContain('vm-gpt')
    expect(html).toContain('同步账号模型')
    client.clear()
  })

  it('does not permanently disable Antigravity API scheduling', () => {
    expect(
      vmSchedulableProps({
        id: 'vm-ag',
        platform: 'antigravity',
        schedulable: true,
      })
    ).not.toHaveProperty('unsupported', true)
  })
})
