import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PurchaseSandboxSession } from './purchase-sandbox'

const scope = 'test-session'
const key = ['panel', 'purchase-sandbox', scope]
const plan = { sku: 'month', amount_minor: 19900 }
const row = {
  ...plan,
  id: '9bcb69b0-d3b0-4dc3-b676-9c3dfd7608f6',
  created_at: 1800000000,
}
function markup(enabled: boolean, statuses?: ('pending' | 'paid')[]) {
  const client = new QueryClient()
  client.setQueryData([...key, 'plans'], {
    enabled,
    plans: enabled ? [plan] : [],
  })
  if (statuses)
    client.setQueryData(
      [...key, 'orders'],
      statuses.map((status) => ({ ...row, status }))
    )
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <PurchaseSandboxSession scope={scope} />
      </QueryClientProvider>
    )
  } finally {
    client.clear()
  }
}

describe('billing sandbox display', () => {
  it('adds nothing to ordinary billing when disabled, even with cached orders', () => {
    expect(markup(false, ['paid'])).toBe('')
  })
  it('distinguishes a loading list from an empty list', () => {
    expect(markup(true)).toContain('正在读取订单')
    expect(markup(true, [])).toContain('暂无测试订单')
  })
  it('explains the limits and exposes only the next action for the server status', () => {
    const pending = markup(true, ['pending'])
    expect(pending).toContain('不会实际扣款')
    expect(pending).toContain('不会签发运行时许可证')
    expect(pending).toContain('待模拟付款')
    expect(pending).not.toContain('领取 / 查看收据')
    const paid = markup(true, ['paid'])
    expect(paid).toContain('已模拟付款')
    expect(paid).toContain('领取 / 查看收据')
    expect(paid).not.toContain('测试收据（非许可证）')
  })
})
