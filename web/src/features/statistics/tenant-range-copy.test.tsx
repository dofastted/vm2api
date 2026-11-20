import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TenantUsage } from './tenant-usage'

describe('tenant statistics range wording', () => {
  it('names inclusive ranges without implying today is excluded', () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <TenantUsage tz='Asia/Shanghai' />
      </QueryClientProvider>
    )
    expect(html).toContain('区间用量')
    expect(html).toContain('近 7 天（含今天）')
    expect(html).toContain('近 30 天（含今天）')
    expect(html).not.toContain('历史用量')
  })
})
