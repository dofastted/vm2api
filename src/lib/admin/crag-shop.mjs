import { createHmac, randomUUID } from 'node:crypto'
import { loadOrderReceiptKey, deriveOrderReceipt } from './crag-shop-receipt.mjs'
import {
  createShopSupplier,
  isOrderId,
  isPaymentMethod,
  isSku,
  isQuantity,
  isAmount,
  object,
  ORDER_STATES,
  ShopError,
} from './crag-shop-supplier.mjs'

const ROOT = '/api/panel/crag-shop'
const ORDER_PATH = /^\/api\/panel\/crag-shop\/orders\/([^/]+)(\/(?:claim|resume|apply-renewal|retry-activation))?$/
const MAX_BODY = 4096
const PAGE_SIZE = 100
const ACTIVATION_WINDOW = 24 * 60 * 60
const ACTIVATION_LEASE = 120
const nowSeconds = () => Math.floor(Date.now() / 1000)
const validVmId = (id) => typeof id === 'string' && /^vm-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)

export const isCragShopPath = (pathname) => pathname === ROOT || pathname.startsWith(`${ROOT}/`)

export function cragShopRoute(method, pathname) {
  if (method === 'GET' && pathname === `${ROOT}/plans`) return 'plans'
  if (method === 'GET' && pathname === `${ROOT}/activation-targets`) return 'activation-targets'
  if (method === 'POST' && pathname === `${ROOT}/quote`) return 'quote'
  if (pathname === `${ROOT}/orders`) return method === 'GET' ? 'list' : method === 'POST' ? 'create' : null
  const match = ORDER_PATH.exec(pathname)
  if (match) {
    if (match[2]) return method === 'POST' ? match[2].slice(1) : null
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

function purchaseInput(body, order = false) {
  const allowed = ['sku', 'slots', 'months', 'coupon']
  if (order) allowed.push('payment_method', 'request_id', 'expected_amount_minor', 'activation_target')
  if (Object.keys(body).some((key) => !allowed.includes(key)) || !isSku(body.sku)) throw badBody()
  const purchase = { sku: body.sku }
  for (const key of ['slots', 'months']) {
    if (!Object.hasOwn(body, key)) continue
    if (!isQuantity(body[key])) throw badBody()
    purchase[key] = body[key]
  }
  if (Object.hasOwn(body, 'coupon')) {
    if (typeof body.coupon !== 'string' || body.coupon.length > 64 || /[^\x20-\x7e]/.test(body.coupon)) throw badBody()
    const coupon = body.coupon.trim()
    if (coupon) purchase.coupon = coupon
  }
  return purchase
}

function createInput(body) {
  const purchase = purchaseInput(body, true)
  const { sku, payment_method, request_id } = body
  if (
    !isPaymentMethod(payment_method) ||
    typeof request_id !== 'string' ||
    request_id.length > 128 ||
    !/^[A-Za-z0-9]/.test(request_id) ||
    /[^A-Za-z0-9._:-]/.test(request_id)
  )
    throw badBody()
  const expected = body.expected_amount_minor
  if (
    Object.hasOwn(body, 'expected_amount_minor')
      ? !isAmount(expected)
      : ['custom', 'renewal'].includes(sku) ||
        Object.keys(body).some((key) => ['slots', 'months', 'coupon'].includes(key))
  )
    throw badBody()
  const target = body.activation_target
  if (
    Object.hasOwn(body, 'activation_target') &&
    (!object(target) || Object.keys(target).length !== 1 || !validVmId(target.vm_id) || sku === 'renewal')
  )
    throw badBody()
  return {
    sku,
    payment_method,
    request_id,
    purchase,
    expected_amount_minor: expected ?? null,
    vm_id: target?.vm_id ?? null,
  }
}

function view(row) {
  const { order_id, request_id, sku, payment_method, status, created_at, term, amount_minor, slot_limit, reserved_at } =
    row
  const result = {
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
  for (const key of ['expected_amount_minor', 'months', 'subtotal_minor', 'discount_minor', 'remaining']) {
    if (row[key] != null) result[key] = row[key]
  }
  if (row.renewable != null) result.renewable = !!row.renewable
  const vm_id = row.activation_vm_id
  result.activation = !vm_id
    ? { state: 'manual' }
    : {
        vm_id,
        state:
          row.activation_phase === 'active'
            ? 'active'
            : row.activation_next_at == null
              ? 'needs_attention'
              : status === 'fulfilled'
                ? 'activating'
                : 'awaiting_fulfillment',
      }
  return result
}

function findOrder(db, owner, orderId) {
  return db.prepare('SELECT * FROM crag_shop_orders WHERE owner = ? AND order_id = ?').get(owner, orderId)
}

function durable(db, work) {
  // The installation-wide default is WAL/NORMAL. Flush before external effects.
  const { synchronous } = db.prepare('PRAGMA synchronous').get()
  if (synchronous < 2) db.exec('PRAGMA synchronous = FULL')
  try {
    return work()
  } finally {
    if (synchronous < 2) db.exec(`PRAGMA synchronous = ${Number(synchronous)}`)
  }
}

async function reserve(db, owner, input, pinTarget) {
  const find = db.prepare('SELECT * FROM crag_shop_orders WHERE owner = ? AND request_id = ?')
  let row = find.get(owner, input.request_id)
  let existing = true
  if (!row) {
    const fingerprint = input.vm_id ? await pinTarget(input.vm_id) : null
    const now = nowSeconds()
    const inserted = durable(db, () =>
      db
        .prepare(`INSERT INTO crag_shop_orders
                  (order_id, owner, request_id, sku, payment_method, reserved_at, purchase_json, expected_amount_minor,
                   activation_vm_id, activation_fingerprint, activation_next_at, activation_deadline)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner, request_id) DO NOTHING`)
        .run(
          randomUUID(),
          owner,
          input.request_id,
          input.sku,
          input.payment_method,
          now,
          input.purchase_json,
          input.expected_amount_minor,
          input.vm_id,
          fingerprint,
          fingerprint ? now : null,
          fingerprint ? now + ACTIVATION_WINDOW : null,
        ),
    )
    existing = inserted.changes === 0
    row = find.get(owner, input.request_id)
  }
  if (
    row.sku !== input.sku ||
    row.payment_method !== input.payment_method ||
    (row.purchase_json ?? JSON.stringify({ sku: row.sku })) !== input.purchase_json ||
    row.expected_amount_minor !== input.expected_amount_minor ||
    (row.activation_vm_id ?? null) !== input.vm_id
  ) {
    throw failure(409, 'shop_request_conflict', 'Request ID already used for different order input')
  }
  return { row, existing }
}

function reflectOrder(db, owner, order) {
  // Set the snapshot once and don't regress status if two supplier responses arrive out of order.
  const { order_id, created_at, term, amount_minor, slot_limit, status } = order
  const optional = ['months', 'subtotal_minor', 'discount_minor']
  const previous = findOrder(db, owner, order_id)
  if (
    !previous ||
    (previous.expected_amount_minor != null && previous.expected_amount_minor !== amount_minor) ||
    optional.some((key) => previous[key] != null && order[key] !== undefined && previous[key] !== order[key])
  )
    throw failure(502, 'shop_invalid_reply', 'Invalid response from CRAG shop')
  const dbLimit = typeof slot_limit === 'number' ? BigInt(slot_limit) : slot_limit
  db.prepare(`UPDATE crag_shop_orders SET
                status = CASE WHEN CASE status WHEN 'pending' THEN 1 WHEN 'paid' THEN 2 WHEN 'fulfilled' THEN 3 ELSE 0 END < ?
                  THEN ? ELSE status END,
                created_at = ?, term = ?, amount_minor = ?, slot_limit = ?,
                months = COALESCE(months, ?), subtotal_minor = COALESCE(subtotal_minor, ?),
                discount_minor = COALESCE(discount_minor, ?), remaining = COALESCE(remaining, ?),
                renewable = COALESCE(renewable, ?)
              WHERE owner = ? AND order_id = ? AND (
                status = 'reserved' OR (
                  created_at = ? AND term = ? AND amount_minor = ? AND slot_limit = ?
                )
              ) AND (months IS NULL OR ? IS NULL OR months = ?)
                AND (subtotal_minor IS NULL OR ? IS NULL OR subtotal_minor = ?)
                AND (discount_minor IS NULL OR ? IS NULL OR discount_minor = ?)`).run(
    ORDER_STATES.indexOf(status),
    status,
    created_at,
    term,
    amount_minor,
    dbLimit,
    order.months ?? null,
    order.subtotal_minor ?? null,
    order.discount_minor ?? null,
    order.remaining ?? null,
    order.renewable === undefined ? null : Number(order.renewable),
    owner,
    order_id,
    created_at,
    term,
    amount_minor,
    dbLimit,
    ...optional.flatMap((key) => [order[key] ?? null, order[key] ?? null]),
  )
  const row = findOrder(db, owner, order_id)
  if (
    !row ||
    row.created_at !== created_at ||
    row.term !== term ||
    row.amount_minor !== amount_minor ||
    row.slot_limit !== slot_limit ||
    optional.some((key) => order[key] !== undefined && row[key] !== order[key])
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
  subscription,
  isCurrentAdmin = (req) => req.panelRole === 'admin',
  isActivationAdmin = () => false,
  activationEnabled = true,
  supplier = createShopSupplier(),
}) {
  function receiptKey(db) {
    try {
      return loadOrderReceiptKey(dataDir, () => !!db.prepare('SELECT 1 FROM crag_shop_orders LIMIT 1').get())
    } catch {
      throw failure(503, 'shop_private_storage_unavailable', 'CRAG shop private storage is unavailable')
    }
  }

  function requireAdmin(req) {
    if (!buyerOwner(req) || !isCurrentAdmin(req))
      throw failure(403, 'shop_admin_required', 'Sign in as a panel administrator to renew the host subscription')
  }

  async function renewalProof(req, sku) {
    if (sku !== 'renewal') return undefined
    requireAdmin(req)
    try {
      const proof = await subscription.renewalProof()
      if (typeof proof !== 'string' || !proof.length || proof.length > 16384 || /[\p{Cc}]/u.test(proof)) throw badBody()
      return proof
    } catch {
      throw failure(409, 'shop_renewal_unavailable', 'The host subscription is not available for renewal')
    }
  }

  const unavailableTarget = () =>
    failure(409, 'shop_activation_target_unavailable', 'The selected CRAG activation target is unavailable')

  function requireActivationAdmin(owner) {
    if (!isActivationAdmin(owner))
      throw failure(403, 'shop_admin_required', 'Sign in as a panel administrator to manage order activation')
  }

  async function pinTarget(owner, vmId) {
    requireActivationAdmin(owner)
    if (!activationEnabled) throw unavailableTarget()
    try {
      const fingerprint = await subscription.pinOrderTarget(vmId)
      requireActivationAdmin(owner)
      if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw unavailableTarget()
      return fingerprint
    } catch (error) {
      if (error instanceof ShopError) throw error
      throw unavailableTarget()
    }
  }

  let processing = false
  async function pollActivation() {
    if (!activationEnabled || processing) return
    processing = true
    try {
      const db = getDb()
      const now = nowSeconds()
      // At most one in-flight order per process; a crashed lease expires on restart.
      const row = db
        .prepare(`SELECT * FROM crag_shop_orders
        WHERE activation_vm_id IS NOT NULL AND activation_next_at IS NOT NULL AND activation_next_at <= ?
        ORDER BY activation_next_at, order_id LIMIT 1`)
        .get(now)
      if (!row) return

      const lease = now + ACTIVATION_LEASE
      const lock = db
        .prepare(`UPDATE crag_shop_orders SET activation_next_at = ?, activation_attempts = activation_attempts + 1
        WHERE order_id = ? AND activation_next_at = ?`)
        .run(lease, row.order_id, row.activation_next_at)
      if (!lock.changes) return
      const dbForLease = () => {
        const currentDb = getDb()
        if (
          currentDb !== db ||
          nowSeconds() >= lease ||
          findOrder(db, row.owner, row.order_id)?.activation_next_at !== lease
        )
          throw failure(409, 'shop_activation_superseded', 'Order activation was deferred')
        return currentDb
      }
      const authorize = () => {
        dbForLease()
        requireActivationAdmin(row.owner)
      }
      const finish = (next) =>
        db
          .prepare(`UPDATE crag_shop_orders SET activation_next_at = ?
        WHERE order_id = ? AND activation_next_at = ?`)
          .run(next, row.order_id, lease)
      const delay = Math.min(300, 5 * 2 ** Math.min(row.activation_attempts, 6))
      const reschedule = () =>
        finish(nowSeconds() >= row.activation_deadline ? null : Math.min(nowSeconds() + delay, row.activation_deadline))

      if (now >= row.activation_deadline) return finish(null)
      try {
        if (row.status !== 'fulfilled') {
          const receipt = deriveOrderReceipt(receiptKey(db), row.order_id)
          const order = await supplier.status(row, receipt)
          if (reflectOrder(dbForLease(), row.owner, order).status !== 'fulfilled') return reschedule()
        }
        authorize()
        const target = { vm_id: row.activation_vm_id, fingerprint: row.activation_fingerprint }
        const redeemed = row.activation_phase === 'redeemed'
        const claim = async () => {
          const receipt = deriveOrderReceipt(receiptKey(dbForLease()), row.order_id)
          const result = await supplier.claim(row, receipt)
          if (result.order_id !== row.order_id) throw missingOrder()
          return result.redemption_code
        }
        await subscription.activateOrder({
          orderId: row.order_id,
          target,
          authorize,
          claim,
          redeemed,
          onRedeemed: () => {
            const currentDb = dbForLease()
            durable(currentDb, () =>
              currentDb
                .prepare(`UPDATE crag_shop_orders SET activation_phase = 'redeemed' WHERE order_id = ?`)
                .run(row.order_id),
            )
          },
        })
        const currentDb = dbForLease()
        durable(currentDb, () =>
          currentDb
            .prepare(`UPDATE crag_shop_orders
          SET activation_phase = 'active', activation_next_at = NULL WHERE order_id = ?`)
            .run(row.order_id),
        )
      } catch (error) {
        if (getDb() !== db) return
        if (
          [
            'shop_admin_required',
            'crag_subscription_target_changed',
            'issuer_mismatch',
            'host_redeem_conflict',
            'redeem_unavailable',
            'host_binding_conflict',
            'slot_limit_reached',
            'payload_key_unknown',
            'payload_key_conflict',
          ].includes(error?.code)
        )
          finish(null)
        else reschedule()
      }
    } finally {
      processing = false
    }
  }

  async function handleCragShop(req, res, url, route) {
    try {
      res.setHeader?.('Cache-Control', 'no-store')
      const owner = buyerOwner(req)
      const ok = (data) => json(res, 200, { ok: true, data })
      if (route === 'plans' && req.method === 'GET') return ok(await supplier.plans({ allowPilot: !!owner }))
      if (!owner) throw failure(403, 'shop_login_required', 'Sign in to the panel to access CRAG shop')
      if (!route) throw missingOrder()
      if (req.method === 'POST' && !sameOriginPost(req, publicBaseUrl)) {
        throw failure(403, 'shop_origin_denied', 'CRAG shop requires a same-origin request')
      }
      if (route === 'activation-targets') {
        const targets =
          activationEnabled && isActivationAdmin(owner) && subscription?.listOrderTargets
            ? await subscription.listOrderTargets()
            : []
        return ok({ targets: (isActivationAdmin(owner) ? targets : []).filter(validVmId).map((vm_id) => ({ vm_id })) })
      }
      if (route === 'quote') {
        const input = purchaseInput(await readInput(req, readRawBody, false))
        return ok(await supplier.quote(input, await renewalProof(req, input.sku)))
      }
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
        if (input.sku === 'renewal') requireAdmin(req)
        if (input.vm_id) requireActivationAdmin(owner)
        const key = receiptKey(db)
        const { coupon, ...selection } = input.purchase
        const purchase_json = JSON.stringify({
          ...selection,
          ...(coupon && {
            coupon_digest: createHmac('sha256', key).update('CRAG-SHOP-COUPON\0').update(coupon).digest('hex'),
          }),
        })
        const { row, existing } = await reserve(db, owner, { ...input, purchase_json }, (id) => pinTarget(owner, id))
        const receipt = deriveOrderReceipt(key, row.order_id)
        const result = (reply) => {
          const current = reflectOrder(db, owner, reply.order)
          return ok({ ...view(current), ...(current.status === 'pending' && reply.form ? reply.form : {}) })
        }
        if (existing) {
          try {
            return result(await supplier.resume(row, receipt))
          } catch (err) {
            if (
              !(err instanceof ShopError) ||
              err.code !== 'shop_order_not_found' ||
              findOrder(db, owner, row.order_id)?.status !== 'reserved'
            )
              throw err
          }
        }
        const proof = await renewalProof(req, row.sku)
        if (row.expected_amount_minor != null) {
          const quote = await supplier.quote(input.purchase, proof)
          if (quote.amount_minor !== row.expected_amount_minor)
            throw failure(409, 'shop_price_changed', 'Price changed; request a new quote and use a new request ID')
        }
        if (row.activation_vm_id && (await pinTarget(owner, row.activation_vm_id)) !== row.activation_fingerprint)
          throw unavailableTarget()
        const { order, form } = await supplier.create(row, receipt, proof, input.purchase)
        const current = reflectOrder(db, owner, order)
        return ok({ ...view(current), ...(current.status === 'pending' && form ? form : {}) })
      }
      const orderId = ORDER_PATH.exec(url.pathname)?.[1]
      if (!orderId || !isOrderId(orderId)) throw missingOrder()
      const row = findOrder(db, owner, orderId)
      if (!row) throw missingOrder()
      if (['claim', 'resume', 'apply-renewal', 'retry-activation'].includes(route)) {
        const input = await readInput(req, readRawBody, true)
        if (Object.keys(input).length !== 0) throw badBody()
      }
      if (route === 'retry-activation') {
        requireActivationAdmin(owner)
        if (!row.activation_vm_id) throw failure(409, 'shop_activation_not_pinned', 'This order uses manual activation')
        if (!activationEnabled) throw failure(503, 'shop_activation_disabled', 'Automatic CRAG activation is disabled')
        const now = nowSeconds()
        db.prepare(`UPDATE crag_shop_orders SET activation_next_at = ?, activation_deadline = ?, activation_attempts = 0
          WHERE owner = ? AND order_id = ? AND activation_next_at IS NULL AND activation_phase <> 'active'`).run(
          now,
          now + ACTIVATION_WINDOW,
          owner,
          row.order_id,
        )
        return ok(view(findOrder(db, owner, row.order_id)))
      }
      if (route === 'claim' && row.activation_vm_id)
        throw failure(409, 'shop_activation_pinned', 'This order uses automatic activation')
      if (route === 'claim' && row.sku === 'renewal')
        throw failure(403, 'shop_renewal_apply_required', 'Apply this renewal from the administrator panel')
      if (route === 'apply-renewal') {
        requireAdmin(req)
        if (row.sku !== 'renewal') throw failure(409, 'shop_not_renewal', 'Order is not a host subscription renewal')
      }
      // A queued order advances in the background. A paused unpaid order still supports manual refresh.
      if (
        route === 'status' &&
        row.activation_vm_id &&
        ((activationEnabled && row.activation_next_at != null) || row.status === 'fulfilled')
      )
        return ok(view(row))
      const receipt = deriveOrderReceipt(receiptKey(db), row.order_id)
      if (route === 'resume') {
        const { order, form } = await supplier.resume(row, receipt)
        const current = reflectOrder(db, owner, order)
        return ok({ ...view(current), ...(current.status === 'pending' && form ? form : {}) })
      }
      if (route === 'claim' || route === 'apply-renewal') {
        if (row.status === 'reserved') reflectOrder(db, owner, await supplier.status(row, receipt))
        const result = await supplier.claim(row, receipt)
        let hostStatus
        if (route === 'apply-renewal') {
          try {
            hostStatus = await subscription.redeemRenewal(result.redemption_code)
          } catch {
            throw failure(
              503,
              'shop_renewal_failed',
              'Could not apply the renewal; refresh subscription status before retrying',
            )
          }
        }
        // The supplier's successful claim is only possible after fulfillment.
        db.prepare(`UPDATE crag_shop_orders SET status = 'fulfilled' WHERE owner = ? AND order_id = ?`).run(
          owner,
          row.order_id,
        )
        return ok(route === 'apply-renewal' ? hostStatus : result)
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

  return Object.assign(handleCragShop, { pollActivation })
}
