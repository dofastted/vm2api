import { z } from 'zod'
import { api } from '@/lib/api'
import { randomUUID } from '@/lib/random-uuid'
import { apiBase, hasSession, sessionInstance, storedUser } from '@/lib/session'

const prefix = '/api/panel/purchase-sandbox'
const sku = z.enum(['month', 'quarter', 'year'])
const plan = z.object({ sku, amount_minor: z.number().int().nonnegative() })
const catalog = z.object({ enabled: z.boolean(), plans: z.array(plan) })
const order = plan.extend({
  id: z.uuid(),
  status: z.enum(['pending', 'paid']),
  created_at: z.number().int().nonnegative(),
})
const orders = z.object({ orders: z.array(order) })
const orderResult = z.object({ order })
const receiptResult = orderResult.extend({ receipt: z.string().min(1) })
const intent = z.object({ sku, request_id: z.uuidv4() })

export type PurchasePlan = z.infer<typeof plan>
export type PurchaseOrder = z.infer<typeof order>
export type PurchaseIntent = z.infer<typeof intent>
export const skuLabel = { month: '月卡', quarter: '季卡', year: '年卡' }
const cny = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'CNY',
})
export const sandboxPrice = (minor: number) => cny.format(minor / 100)

export function purchaseScope() {
  return hasSession()
    ? JSON.stringify([apiBase(), sessionInstance(), storedUser()])
    : ''
}

async function request<T>(
  scope: string,
  signal: AbortSignal,
  path: string,
  schema: z.ZodType<T>,
  body?: object
): Promise<T> {
  const checkScope = () => {
    if (signal.aborted || !scope || purchaseScope() !== scope) {
      throw new DOMException('会话已切换', 'AbortError')
    }
  }
  checkScope()
  const data = await api(`${prefix}${path}`, {
    signal,
    cache: 'no-store',
    ...(body && { method: 'POST', body: JSON.stringify(body) }),
  })
  checkScope()
  const parsed = schema.safeParse(data)
  if (!parsed.success) throw new Error('面板返回的数据不完整。')
  return parsed.data
}

export const getCatalog = (scope: string, signal: AbortSignal) =>
  request(scope, signal, '/plans', catalog)
export const getOrders = async (scope: string, signal: AbortSignal) =>
  (await request(scope, signal, '/orders', orders)).orders

export async function placeOrder(
  scope: string,
  signal: AbortSignal,
  input: PurchaseIntent
) {
  const data = await request(scope, signal, '/orders', orderResult, input)
  if (data.order.sku !== input.sku) throw new Error('返回的套餐与订单不符。')
  return data.order
}

export async function payOrder(scope: string, signal: AbortSignal, id: string) {
  const data = await request(
    scope,
    signal,
    `/orders/${encodeURIComponent(id)}/pay`,
    orderResult,
    {}
  )
  if (data.order.id !== id || data.order.status !== 'paid')
    throw new Error('尚未确认模拟付款。')
  return data.order
}

export async function claimReceipt(
  scope: string,
  signal: AbortSignal,
  id: string
) {
  const data = await request(
    scope,
    signal,
    `/orders/${encodeURIComponent(id)}/receipt`,
    receiptResult,
    {}
  )
  if (data.order.id !== id || data.order.status !== 'paid')
    throw new Error('未能确认此订单的收据。')
  return data.receipt
}

// Only the unresolved POST body is saved, never an order, receipt or credential.
// Re-listing cannot resolve it: the order list intentionally has no request_id.
const intentKey = (scope: string) => `kin_purchase_intent:${scope}`
export function pendingIntent(scope: string): PurchaseIntent | null {
  const raw = sessionStorage.getItem(intentKey(scope))
  return raw === null ? null : intent.parse(JSON.parse(raw))
}

export function beginIntent(scope: string, choice: PurchasePlan['sku']) {
  const pending = pendingIntent(scope)
  if (pending) return pending
  const input = { sku: choice, request_id: randomUUID() }
  sessionStorage.setItem(intentKey(scope), JSON.stringify(input))
  return input
}

export function finishIntent(scope: string) {
  sessionStorage.removeItem(intentKey(scope))
}
