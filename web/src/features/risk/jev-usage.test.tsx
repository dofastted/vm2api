import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { JevUsagePanel } from './jev-usage'
import { usageMoney } from './jev-usage-format'

const counts = {
  requests: 1,
  successful: 0,
  input_tokens: 0,
  output_tokens: 0,
  unknown_usage_requests: 1,
  estimated_cost_nano_usd: 0,
  unknown_cost_requests: 1,
}
function markup(errors = 0, open = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  client.setQueryData(['panel', 'jev-usage'], {
    pages: [
      {
        started_at: '2026-10-25T00:00:00.000Z',
        day: '2026-10-25',
        keys: [
          {
            number: 1,
            masked_key: 'demo********1234',
            key_fingerprint: 'abcdef123456',
            retired: false,
            requests: 1,
            successful: 0,
            estimated_cost_nano_usd: 0,
            unknown_cost_requests: 1,
            status: 'insufficient_balance',
            last_request_at: '2026-10-25T01:00:00.000Z',
            last_http_status: 402,
          },
        ],
        total: counts,
        today: counts,
        storage_errors_since_start: errors,
        rows: [
          {
            id: 'test-row',
            created_at: '2026-10-25T01:00:00.000Z',
            request_id: 'request-1',
            model: 'jev-1.14.0',
            key_fingerprint: 'abcdef123456',
            http_status: 402,
            outcome: 'http_error',
            duration_ms: 9,
            input_tokens: null,
            output_tokens: null,
            estimated_cost_nano_usd: null,
          },
        ],
        has_more: false,
        next_cursor: null,
      },
    ],
    pageParams: [null],
  })
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <JevUsagePanel defaultOpen={open} />
      </QueryClientProvider>
    )
  } finally {
    client.clear()
  }
}
describe('JEV usage display', () => {
  it('never formats missing cost as zero', () => {
    expect(usageMoney(null)).toBe('未知')
    expect(usageMoney(42000)).toBe('$0.00004200')
  })
  it('distinguishes current accounting from historical balance', () => {
    const html = markup()
    expect(html).toContain('不是账户余额')
    expect(html).toContain('此前未保存的历史用量无法补回')
    expect(html).toContain('未知不等于免费')
  })
  it('uses the same masked key in both tables and shows unknown usage for unsuccessful calls', () => {
    const html = markup()
    expect(html).not.toContain('abcdef123456')
    expect(html.match(/demo\*{8}1234/g)).toHaveLength(2)
    expect(html).toContain('402')
    expect(html).toContain('demo********1234')
    expect(html).toContain('余额不足')
    expect(html).toContain('余额暂不可查询')
    expect(html).toContain('30 天保留策略')
    expect(html).toContain('未返回')
    expect(html).toContain('未知')
  })
  it('folds by default and keeps today and the estimate in the header', () => {
    const html = markup(0, false)
    expect(html).toContain('JEV 使用记录')
    expect(html).toContain('今日')
    expect(html).not.toContain('abcdef123456')
  })
  it('warns about storage failures instead of claiming complete totals', () => {
    expect(markup(2)).toContain('统计可能不完整')
  })
})
