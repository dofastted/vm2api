import { randomUUID } from 'node:crypto'
import { loadOrderReceiptKey, deriveOrderReceipt } from './crag-shop-receipt.mjs'
import {
  createShopSupplier,
  isOrderId,
  isPaymentMethod,
  isSku,
  object,
  ORDER_STATES,
  ShopError,
} from './crag-shop-supplier.mjs'

const ROOT = '/api/panel/crag-shop'
const ORDER_PATH = /^\/api\/panel\/crag-shop\/orders\/([^/]+)(\/claim)?$/
const MAX_BODY = 4096
const PAGE_SIZE = 100

export const isCragShopPath = (pathname) => pathname === ROOT || pathname.startsWith(`${ROOT}/`)

export function cragShopRoute(method, pathname) {
  if (method === 'GET' && pathname === `${ROOT}/plans`) return 'plans'
  if (pathname === `${ROOT}/orders`) return method === 'GET' ? 'list' : method === 'POST' ? 'create' : null
  const match = ORDER_PATH.exec(pathname)
  if (match) {
    if (match[2]) return method === 'POST' ? 'claim' : null
    return method === 'GET' ? 'status' : null
  }
  return null
}

export function buyerOwner(req) {
  return !req.apiKeyKind && req.panelBuyerOwner && req.panelUser ? req.panelBuyerOwner : null
}

export function sessionBuyerOwner(session, record, configuredAdmin) {
  if (record?.enabled && record.id && session.buyer?.id === record.id) return `panel:${record.id}`
  if (
    !record &&
    session.buyer?.configuredAdmin === true &&
    configuredAdmin.password &&
    session.user === configuredAdmin.username
  ) {
    return `configured-admin:${session.user}`
  }
  return null
}

export function sameOriginPost(req, publicBaseUrl) {
  const { origin, host, 'sec-fetch-site': site } = req.headers
  if (site !== undefined && site !== 'same-origin') return false
  if (origin === undefined) return site === 'same-origin'
  if (typeof origin !== 'string' || typeof host !== 'string' || /[^a-zA-Z0-9.:[\]-]/.test(host) || !host) return false
  try {
    const from = new URL(origin)
    if (from.origin !== origin || !['http:', 'https:'].includes(from.protocol)) return false
    const direct = new URL(`${req.socket?.encrypted ? 'https' : 'http'}://${host}`).origin
    if (origin === direct) return true
    // Browser-controlled Fetch Metadata confirms TLS termination; don't trust forwarding headers.
    const httpsHost = new URL(`https://${host}`).origin
    if (!req.socket?.encrypted && site === 'same-origin' && origin === httpsHost) return true
    // A configured origin may describe a reverse proxy that rewrites Host. In that case, also
    // require the browser's confirmation rather than accepting that origin across panel aliases.
    return site === 'same-origin' && !!publicBaseUrl && origin === new URL(publicBaseUrl).origin
  } catch {
    return false
  }
}

function failure(status, code, message) {
  return new ShopError(status, code, message)
}

const missingOrder = () => failure(404, 'shop_order_not_found', 'Order not found')
const badBody = () => failure(400, 'shop_invalid_request', 'Invalid CRAG shop request')

async function readInput(req, readRawBody, emptyAllowed) {
  let raw
  try {
    raw = await readRawBody(req, MAX_BODY)
  } catch (err) {
    if (err.status === 413) throw failure(413, 'shop_body_too_large', 'CRAG shop request too large')
    throw badBody()
  }
  if (emptyAllowed && raw.length === 0) return {}
  const type = req.headers['content-type']
  if (typeof type !== 'string' || !/^application\/json(?:\s*;|$)/i.test(type)) {
    throw failure(415, 'shop_json_required', 'Expected application/json')
  }
  let value
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  } catch {
    throw badBody()
  }
  if (!object(value)) throw badBody()
  return value
}

function createInput(body) {
  const { sku, payment_method, request_id } = body
  if (
    Object.keys(body).length !== 3 ||
    !isSku(sku) ||
    !isPaymentMethod(payment_method) ||
    typeof request_id !== 'string' ||
    request_id.length > 128 ||
    !/^[A-Za-z0-9]/.test(request_id) ||
    /[^A-Za-z0-9._:-]/.test(request_id)
  )
    throw badBody()
  return { sku, payment_method, request_id }
}

function view(row) {
  const { order_id, request_id, sku, payment_method, status, created_at, term, amount_minor, slot_limit, reserved_at } =
    row
  return {
    order_id,
    request_id,
    sku,
    payment_method,
    status,
    created_at: created_at ?? reserved_at,
    term,
    amount_minor,
    slot_limit,
  }
}

function findOrder(db, owner, orderId) {
  return db.prepare('SELECT * FROM crag_shop_orders WHERE owner = ? AND order_id = ?').get(owner, orderId)
}

function reserve(db, owner, input) {
  const find = db.prepare('SELECT * FROM crag_shop_orders WHERE owner = ? AND request_id = ?')
  let row = find.get(owner, input.request_id)
  if (!row) {
    // The installation-wide default is WAL/NORMAL. Flush the identity before any payable order can exist remotely.
    const { synchronous } = db.prepare('PRAGMA synchronous').get()
    if (synchronous < 2) db.exec('PRAGMA synchronous = FULL')
    try {
      db.prepare(`INSERT INTO crag_shop_orders(order_id, owner, request_id, sku, payment_method, reserved_at)
                  VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner, request_id) DO NOTHING`).run(
        randomUUID(),
        owner,
        input.request_id,
        input.sku,
        input.payment_method,
        Math.floor(Date.now() / 1000),
      )
    } finally {
      if (synchronous < 2) db.exec(`PRAGMA synchronous = ${Number(synchronous)}`)
    }
    row = find.get(owner, input.request_id)
  }
  if (row.sku !== input.sku || row.payment_method !== input.payment_method) {
    throw failure(409, 'shop_request_conflict', 'Request ID already used for different order input')
  }
  return row
}

function reflectOrder(db, owner, order) {
  // Set the snapshot once and don't regress status if two supplier responses arrive out of order.
  const { order_id, created_at, term, amount_minor, slot_limit, status } = order
  const dbLimit = typeof slot_limit === 'number' ? BigInt(slot_limit) : slot_limit
  db.prepare(`UPDATE crag_shop_orders SET status = ?, created_at = ?, term = ?, amount_minor = ?, slot_limit = ?
              WHERE owner = ? AND order_id = ? AND (
                status = 'reserved' OR (
                  created_at = ? AND term = ? AND amount_minor = ? AND slot_limit = ?
                  AND CASE status WHEN 'pending' THEN 1 WHEN 'paid' THEN 2 WHEN 'fulfilled' THEN 3 ELSE 0 END < ?
                )
              )`).run(
    status,
    created_at,
    term,
    amount_minor,
    dbLimit,
    owner,
    order_id,
    created_at,
    term,
    amount_minor,
    dbLimit,
    ORDER_STATES.indexOf(status),
  )
  const row = findOrder(db, owner, order_id)
  if (
    !row ||
    row.created_at !== created_at ||
    row.term !== term ||
    row.amount_minor !== amount_minor ||
    row.slot_limit !== slot_limit
  ) {
    throw failure(502, 'shop_invalid_reply', 'Invalid response from CRAG shop')
  }
  return row
}

export function createCragShopHandler({
  getDb,
  dataDir,
  publicBaseUrl,
  json,
  readRawBody,
  supplier = createShopSupplier(),
}) {
  function receiptKey(db) {
    try {
      return loadOrderReceiptKey(dataDir, () => !!db.prepare('SELECT 1 FROM crag_shop_orders LIMIT 1').get())
    } catch {
      throw failure(503, 'shop_private_storage_unavailable', 'CRAG shop private storage is unavailable')
    }
  }

  return async function handleCragShop(req, res, url, route) {
    try {
      const owner = buyerOwner(req)
      if (!owner) throw failure(403, 'shop_login_required', 'Sign in to the panel to access CRAG shop')
      if (!route) throw missingOrder()
      if (req.method === 'POST' && !sameOriginPost(req, publicBaseUrl)) {
        throw failure(403, 'shop_origin_denied', 'CRAG shop requires a same-origin request')
      }
      const ok = (data) => json(res, 200, { ok: true, data })
      if (route === 'plans') return ok(await supplier.plans())
      const db = getDb()
      if (route === 'list') {
        const offset = url.searchParams.get('offset') ?? '0'
        if (!offset || offset.length > 9 || /\D/.test(offset)) throw badBody()
        const rows = db
          .prepare(`SELECT * FROM crag_shop_orders WHERE owner = ?
                                 ORDER BY reserved_at DESC, order_id DESC LIMIT ? OFFSET ?`)
          .all(owner, PAGE_SIZE + 1, Number(offset))
        const next_offset = rows.length > PAGE_SIZE ? Number(offset) + PAGE_SIZE : null
        return ok({ orders: rows.slice(0, PAGE_SIZE).map(view), next_offset })
      }
      if (route === 'create') {
        const input = createInput(await readInput(req, readRawBody, false))
        const key = receiptKey(db)
        const row = reserve(db, owner, input)
        const { order, form } = await supplier.create(row, deriveOrderReceipt(key, row.order_id))
        const current = reflectOrder(db, owner, order)
        return ok({ ...view(current), ...(current.status === 'pending' && form ? form : {}) })
      }
      const orderId = ORDER_PATH.exec(url.pathname)?.[1]
      if (!orderId || !isOrderId(orderId)) throw missingOrder()
      const row = findOrder(db, owner, orderId)
      if (!row) throw missingOrder()
      if (route === 'claim') {
        const input = await readInput(req, readRawBody, true)
        if (Object.keys(input).length !== 0) throw badBody()
      }
      const receipt = deriveOrderReceipt(receiptKey(db), row.order_id)
      if (route === 'claim') {
        if (row.status === 'reserved') reflectOrder(db, owner, await supplier.status(row, receipt))
        const result = await supplier.claim(row, receipt)
        // The supplier's successful claim is only possible after fulfillment.
        db.prepare(`UPDATE crag_shop_orders SET status = 'fulfilled' WHERE owner = ? AND order_id = ?`).run(
          owner,
          row.order_id,
        )
        return ok(result)
      }
      try {
        const order = await supplier.status(row, receipt)
        return ok(view(reflectOrder(db, owner, order)))
      } catch (err) {
        if (err instanceof ShopError && err.code === 'shop_order_not_found' && row.status === 'reserved') {
          return ok(view(findOrder(db, owner, row.order_id) ?? row))
        }
        throw err
      }
    } catch (err) {
      const error =
        err instanceof ShopError ? err : failure(503, 'shop_unavailable', 'CRAG shop unavailable; try again later')
      return json(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    }
  }
}
