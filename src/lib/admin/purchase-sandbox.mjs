import http from 'node:http'
import { isAbsolute } from 'node:path'
import { getPanelAdmin, hashKey } from '../core/security.mjs'

const prefix = '/api/panel/purchase-sandbox'
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const action = new RegExp(`^/orders/${uuid}/(?:pay|receipt)$`)
const uuidV4 = new RegExp(`^${uuid}$`)
const skus = new Set(['month', 'quarter', 'year'])
const jsonType = /^application\/json(?:\s*;\s*charset=utf-8)?$/i

export function isSandboxPath(path) {
  return path === prefix || path.startsWith(`${prefix}/`)
}

export function sandboxRoute(method, path) {
  if (!isSandboxPath(path)) return false
  const suffix = path.slice(prefix.length)
  if (method === 'GET') return suffix === '/plans' || suffix === '/orders'
  return method === 'POST' && (suffix === '/orders' || action.test(suffix))
}

// requireAuth sets these properties from the verified session and users DB, not HTTP headers.
function sessionOwner(req) {
  if (req.apiKeyKind || !['user', 'admin'].includes(req.panelRole)) return null
  if (typeof req.panelUser !== 'string' || !req.panelUser.trim()) return null
  if (req.panelUserId != null) {
    return typeof req.panelUserId === 'string' && req.panelUserId.trim() ? hashKey(`id:${req.panelUserId}`) : null
  }
  const admin = getPanelAdmin()
  return req.panelRole === 'admin' && admin.password && admin.username === req.panelUser
    ? hashKey(`admin:${req.panelUser}`)
    : null
}

function sameOrigin(req) {
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && !(req.method === 'GET' && site === 'none')) return false
  const origin = req.headers.origin
  if (origin === undefined) return req.method === 'GET' || site === 'same-origin'
  // Set PUBLIC_SCHEME=https behind a TLS terminator. Forwarded headers are not a trust anchor.
  const scheme = process.env.PUBLIC_SCHEME || (req.socket?.encrypted ? 'https' : 'http')
  if (!['http', 'https'].includes(scheme) || !req.headers.host) return false
  try {
    return origin === new URL(`${scheme}://${req.headers.host}`).origin
  } catch {
    return false
  }
}

function sandboxBody(suffix, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const keys = Object.keys(input)
  if (suffix !== '/orders') return keys.length === 0 ? '{}' : null
  const { sku, request_id } = input
  if (keys.length !== 2 || !Object.hasOwn(input, 'sku') || !Object.hasOwn(input, 'request_id')) return null
  if (!skus.has(sku) || typeof request_id !== 'string' || !uuidV4.test(request_id)) return null
  return JSON.stringify({ sku, request_id })
}

// A private service response is not a panel DTO. In particular, list/create/pay
// must never expose a receipt (or internal metadata) via an unfiltered spread.
function planView({ sku, amount_minor }) {
  if (!skus.has(sku) || !Number.isSafeInteger(amount_minor) || amount_minor < 0) throw new Error('invalid plan')
  return { sku, amount_minor }
}

function orderView({ id, sku, amount_minor, status, created_at }) {
  if (typeof id !== 'string' || !uuidV4.test(id) || !['pending', 'paid'].includes(status))
    throw new Error('invalid order')
  if (!Number.isSafeInteger(created_at) || created_at < 0) throw new Error('invalid timestamp')
  return { id, ...planView({ sku, amount_minor }), status, created_at }
}

function panelData(method, suffix, data) {
  if (suffix === '/plans') {
    if (data.enabled !== true) throw new Error('invalid catalog')
    return { enabled: true, plans: data.plans.map(planView) }
  }
  if (method === 'GET') return { orders: data.orders.map(orderView) }
  const order = orderView(data.order)
  if (suffix === '/orders') return { order }
  if (order.id !== suffix.split('/')[2]) throw new Error('unexpected order')
  if (suffix.endsWith('/pay')) return { order }
  if (order.status !== 'paid' || typeof data.receipt !== 'string' || !data.receipt) throw new Error('invalid receipt')
  return { receipt: data.receipt, order }
}

function requestSandbox(socketPath, suffix, method, owner, body) {
  return new Promise((resolve, reject) => {
    // No TCP fallback, redirect handling, client headers or credentials.
    const req = http.request(
      {
        agent: false,
        socketPath,
        path: `/sandbox${suffix}`,
        method,
        signal: AbortSignal.timeout(5000),
        headers: { 'x-sandbox-owner': owner, 'content-type': 'application/json' },
      },
      (res) => {
        const status = res.statusCode
        if (status < 200 || status >= 300) {
          resolve({ status })
          res.destroy()
          return
        }
        const chunks = []
        let size = 0
        res.on('error', reject)
        res.on('data', (chunk) => {
          size += chunk.length
          if (size > 2 ** 20) res.destroy(new Error('response too large'))
          else chunks.push(chunk)
        })
        res.on('end', () => {
          try {
            resolve({ status, data: panelData(method, suffix, JSON.parse(Buffer.concat(chunks))) })
          } catch (err) {
            reject(err)
          }
        })
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

export async function servePurchaseSandbox(req, res, path, { json, readRawBody }) {
  const fail = (code, message) => json(res, code, { ok: false, error: { message } })
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  const owner = sessionOwner(req)
  if (!owner) return fail(403, '请使用个人面板账号登录')
  // Compare the raw request target too: no queries, absolute URLs or normalized aliases.
  if (req.url !== path || !sandboxRoute(req.method, path)) return fail(404, '无此测试接口')
  if (!sameOrigin(req)) return fail(403, '拒绝跨站请求')
  if (req.headers['x-sandbox-owner'] !== undefined) return fail(400, '请求不能指定订单属主')
  const suffix = path.slice(prefix.length)
  if (req.method === 'GET' && (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) !== 0)) {
    return fail(400, '此操作不接受参数')
  }
  const socketPath = process.env.VM2API_PURCHASE_SANDBOX_SOCKET
  if (!socketPath) {
    if (suffix === '/plans') return json(res, 200, { ok: true, data: { enabled: false, plans: [] } })
    return fail(404, '购买沙箱未启用')
  }
  if (process.platform === 'win32' || !isAbsolute(socketPath)) return fail(503, '购买沙箱套接字配置无效')
  let body
  if (req.method === 'POST') {
    if (!jsonType.test(req.headers['content-type'] || '') || req.headers['content-encoding'])
      return fail(415, '需要 JSON 请求')
    try {
      body = sandboxBody(suffix, JSON.parse(await readRawBody(req, 2048)))
    } catch (err) {
      if (err?.status === 413) return fail(413, '请求过大')
    }
    if (!body) return fail(400, '无效的测试订单请求')
  }
  try {
    const result = await requestSandbox(socketPath, suffix, req.method, owner, body)
    if (result.data) return json(res, result.status, { ok: true, data: result.data })
    if (result.status === 404) return fail(404, '测试订单不存在')
    if (result.status === 409) return fail(409, '订单状态冲突，请刷新订单')
    if (result.status === 400) return fail(400, '无效的测试订单')
  } catch {
    /* Do not expose socket paths or private responses. */
  }
  return fail(503, '购买沙箱暂不可用，请稍后重试')
}
