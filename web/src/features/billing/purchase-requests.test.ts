import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSession, setApiBase, setSession } from '@/lib/session'
import {
  beginIntent,
  claimReceipt,
  finishIntent,
  getCatalog,
  getOrders,
  payOrder,
  pendingIntent,
  placeOrder,
  purchaseScope,
} from './purchase-requests'

const prefix = '/api/panel/purchase-sandbox'
const order = {
  id: '9bcb69b0-d3b0-4dc3-b676-9c3dfd7608f6',
  sku: 'month',
  amount_minor: 19900,
  status: 'pending',
  created_at: 1800000000,
}
const paid = { ...order, status: 'paid' }
const signal = new AbortController().signal
const response = (data: unknown) => Response.json({ ok: true, data })
function storage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', storage())
  vi.stubGlobal('sessionStorage', storage())
  vi.stubGlobal('location', { hostname: 'console.example' })
  vi.stubGlobal('document', { cookie: '' })
  setSession('bearer-a', 'first-user')
})
afterEach(() => vi.unstubAllGlobals())

describe('billing purchase sandbox requests', () => {
  it('reads disabled discovery without making any other request', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(response({ enabled: false, plans: [] }))
    vi.stubGlobal('fetch', fetch)
    expect(await getCatalog(purchaseScope(), signal)).toEqual({
      enabled: false,
      plans: [],
    })
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${prefix}/plans`])
  })

  it('keeps the exact request body after a lost create response and list reload', async () => {
    const scope = purchaseScope()
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('lost response'))
      .mockResolvedValueOnce(response({ orders: [order] }))
      .mockResolvedValueOnce(response({ order }))
    vi.stubGlobal('fetch', fetch)
    const input = beginIntent(scope, 'month')
    await expect(placeOrder(scope, signal, input)).rejects.toThrow(
      'lost response'
    )
    await getOrders(scope, signal)
    const retry = beginIntent(purchaseScope(), 'year')
    expect(retry).toEqual(input)
    expect(await placeOrder(scope, signal, retry)).toEqual(order)
    expect(fetch.mock.calls[0]?.[1].body).toBe(fetch.mock.calls[2]?.[1].body)
    expect(JSON.parse(fetch.mock.calls[2]?.[1].body)).toEqual({
      sku: 'month',
      request_id: input.request_id,
    })
    finishIntent(scope)
    expect(beginIntent(scope, 'year').request_id).not.toBe(input.request_id)
  })

  it('uses only order-specific panel POSTs and returns the same server receipt on repeat views', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ order: paid }))
    vi.stubGlobal('fetch', fetch)
    const scope = purchaseScope()
    expect(await payOrder(scope, signal, order.id)).toEqual(paid)
    for (let i = 0; i < 2; i++) {
      fetch.mockResolvedValueOnce(
        response({ order: paid, receipt: 'sandbox-example' })
      )
      expect(await claimReceipt(scope, signal, order.id)).toBe(
        'sandbox-example'
      )
    }
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${prefix}/orders/${order.id}/pay`,
      `${prefix}/orders/${order.id}/receipt`,
      `${prefix}/orders/${order.id}/receipt`,
    ])
    for (const [, options] of fetch.mock.calls) {
      expect(options).toMatchObject({
        method: 'POST',
        body: '{}',
        cache: 'no-store',
      })
    }
  })

  it('rejects a mismatched receipt and never treats a malformed create response as confirmation', async () => {
    const other = { ...paid, id: 'b43ab662-5cc2-4e66-b973-6525eab775a7' }
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(response({ order: other, receipt: 'other' }))
        .mockResolvedValueOnce(response({}))
    )
    const scope = purchaseScope()
    await expect(claimReceipt(scope, signal, order.id)).rejects.toThrow()
    const input = beginIntent(scope, 'month')
    await expect(placeOrder(scope, signal, input)).rejects.toThrow()
    expect(pendingIntent(scope)).toEqual(input)
  })

  it('never reuses the previous panel or login draft, even under the same username', () => {
    const original = purchaseScope()
    beginIntent(original, 'quarter')
    setApiBase('https://second.example')
    expect(pendingIntent(purchaseScope())).toBeNull()
    setApiBase('')
    clearSession()
    expect(purchaseScope()).toBe('')
    setSession('bearer-b', 'first-user')
    expect(purchaseScope()).not.toBe(original)
    expect(purchaseScope()).not.toContain('bearer-b')
    expect(pendingIntent(purchaseScope())).toBeNull()
  })

  it('drops a late receipt and refuses any further request from a stale scope', async () => {
    const fetch = vi.fn(async () => {
      setSession('bearer-b', 'second-user')
      return response({ order: paid, receipt: 'old receipt' })
    })
    vi.stubGlobal('fetch', fetch)
    const scope = purchaseScope()
    await expect(claimReceipt(scope, signal, order.id)).rejects.toMatchObject({
      name: 'AbortError',
    })
    await expect(payOrder(scope, signal, order.id)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
