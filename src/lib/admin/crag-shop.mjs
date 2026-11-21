import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { panelCookieSecure } from '../core/security.mjs'
import { isCragOrderVmId } from '../vm/crag-subscription.mjs'
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
const DEVICE_ROOT = `${ROOT}/device`
const ORDER_PATH =
  /^\/api\/panel\/crag-shop(?:\/device)?\/orders\/([^/]+)(\/(?:claim|resume|cancel|apply|apply-renewal|retry-activation))?$/
const DEVICE_COOKIE = 'kin_crag_device_checkout'
const MAX_BODY = 4096
const PAGE_SIZE = 100
const ACTIVATION_WINDOW = 24 * 60 * 60
const ACTIVATION_LEASE = 120
// Supplier order states before money arrives. ORDER_STATES is ordered, so everything
// up to 'paid' is still unpaid; the supplier protocol has no expired or cancelled state.
const UNPAID_STATES = ORDER_STATES.slice(0, ORDER_STATES.indexOf('paid'))
// How long a checkout link is worth waiting for. The supplier never reports an order as
// expired, so an unpaid order older than this is closed locally — but only after the
// supplier confirms it is still unpaid, so a late payment is never dropped.
const PAYMENT_WINDOW = 30 * 60
const nowSeconds = () => Math.floor(Date.now() / 1000)

export const isCragShopPath = (pathname) => pathname === ROOT || pathname.startsWith(`${ROOT}/`)
export const isCragDeviceShopPath = (pathname) => pathname.startsWith(`${DEVICE_ROOT}/`)

export function cragShopRoute(method, pathname) {
  const device = isCragDeviceShopPath(pathname)
  const root = device ? DEVICE_ROOT : ROOT
  if (method === 'GET' && pathname === `${root}/plans`) return 'plans'
  if (!device && method === 'GET' && pathname === `${root}/activation-targets`) return 'activation-targets'
  if (method === 'POST' && pathname === `${root}/quote`) return 'quote'
  if (pathname === `${root}/orders`) return method === 'GET' ? 'list' : method === 'POST' ? 'create' : null
  const match = ORDER_PATH.exec(pathname)
  if (match) {
    if (match[2]) {
      const action = match[2].slice(1)
      if (method !== 'POST') return null
      if (action === 'resume' || action === 'cancel' || (device ? action === 'apply' : action !== 'apply'))
        return action
      return null
    }
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
  const { origin, host, 'sec-fetch-site': site } = req?.headers || {}
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
const unavailableDevice = () =>
  failure(503, 'shop_device_unavailable', 'Cannot verify the host device for CRAG checkout')
const unavailableStorage = () =>
  failure(503, 'shop_private_storage_unavailable', 'CRAG shop private storage is unavailable')

// Only public, actionable subscription failures may cross the anonymous device
// checkout boundary. Never expose the vendor response, voucher, or local paths.
const deviceApplyErrors = new Map([
  [
    'crag_subscription_invalid_redemption_receipt',
    [409, 'The local redemption confirmation could not be verified. Ask the administrator to reconcile this order.'],
  ],
  [
    'crag_subscription_host_package_changed',
    [409, 'The CRAG package changed during redemption. Ask the administrator to recover the original redemption.'],
  ],
  [
    'crag_subscription_recovery_unverified',
    [409, 'The original redemption result is not confirmed. Ask the administrator to reconcile it.'],
  ],
  [
    'crag_subscription_sync_pending',
    [409, 'A host redemption is pending. Continue the original redemption from host subscriptions.'],
  ],
  [
    'crag_subscription_busy',
    [409, 'Another host subscription operation is in progress. Check this order again shortly.'],
  ],
  [
    'crag_subscription_authority_unavailable',
    [503, 'The authorization service did not confirm the result. Check this order before retrying.'],
  ],
  [
    'auth_forbidden',
    [502, 'The authorization service rejected this host credential. Ask the administrator to check the request ID.'],
  ],
  [
    'host_redeem_conflict',
    [409, 'This voucher does not match the host subscription. Ask the administrator to check this order.'],
  ],
  ['redeem_unavailable', [409, 'The original voucher could not be redeemed. Check this order with the supplier.']],
  [
    'payload_key_unknown',
    [
      409,
      'The authorization service no longer offers the CRAG package key this redemption recorded. Ask the administrator to reconcile this order.',
    ],
  ],
  [
    'issuer_mismatch',
    [
      409,
      'The CRAG issuer this redemption recorded does not match the authorization service. Ask the administrator to reconcile this order.',
    ],
  ],
])
const authorityRequestId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i

function deviceApplyFailure(error) {
  const publicError = deviceApplyErrors.get(error?.code)
  if (!publicError) return null
  const result = failure(publicError[0], error.code, publicError[1])
  if (authorityRequestId.test(error.authorityRequestId ?? '')) result.authorityRequestId = error.authorityRequestId
  return result
}

function hostCheckoutError(error) {
  switch (error?.code) {
    case 'crag_subscription_host_identity_unavailable':
      return unavailableDevice()
    case 'crag_subscription_host_identity_changed':
      return failure(409, 'shop_host_identity_changed', 'The host device no longer matches the subscription')
    case 'crag_subscription_storage_unavailable':
      return unavailableStorage()
    default:
      return null
  }
}

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
    (!object(target) || Object.keys(target).length !== 1 || !isCragOrderVmId(target.vm_id) || sku === 'renewal')
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

// An order closed on this side. closed_at carries the decision for everything the 060
// CHECK forbids marking in dispatch_state (anything past 'reserved'); the dispatch_state
// arm keeps orders cancelled before that column existed reading as closed.
const isClosed = (row) => row?.closed_at != null || row?.dispatch_state === 'cancelled'

function view(row) {
  const { order_id, request_id, sku, payment_method, status, created_at, term, amount_minor, slot_limit, reserved_at } =
    row
  const result = {
    order_id,
    request_id,
    sku,
    payment_method,
    status: isClosed(row) ? 'cancelled' : status,
    created_at: created_at ?? reserved_at,
    term,
    amount_minor,
    slot_limit,
  }
  if (isClosed(row)) return result
  // An unsent order is cancelable outright. A submitted one is offered only while the
  // locally known state is unpaid; the cancel route re-checks with the supplier before
  // it writes, because the local status can lag behind a payment.
  if (row.dispatch_state === 'unsent' || (row.dispatch_state === 'submitted' && UNPAID_STATES.includes(status)))
    result.cancelable = true
  for (const key of ['expected_amount_minor', 'months', 'subtotal_minor', 'discount_minor', 'remaining']) {
    if (row[key] != null) result[key] = row[key]
  }
  if (row.renewable != null) result.renewable = !!row.renewable
  const vm_id = row.activation_vm_id
  result.activation = row.owner.startsWith('device:')
    ? {
        state:
          row.activation_phase === 'active'
            ? 'active'
            : status === 'fulfilled'
              ? 'ready_to_apply'
              : 'awaiting_fulfillment',
      }
    : !vm_id
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
                   activation_vm_id, activation_fingerprint, activation_next_at, activation_deadline, dispatch_state)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unsent') ON CONFLICT(owner, request_id) DO NOTHING`)
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
  allowDeviceRequest = () => true,
  activationEnabled = true,
  supplier = createShopSupplier(),
}) {
  function deviceIdentity() {
    let hostId
    try {
      hostId = subscription?.purchaseDeviceId()
    } catch (error) {
      throw hostCheckoutError(error) ?? unavailableDevice()
    }
    if (typeof hostId !== 'string' || !/^[a-f0-9]{64}$/.test(hostId)) throw unavailableDevice()
    return hostId
  }

  function receiptKey(db) {
    try {
      return loadOrderReceiptKey(dataDir, () => !!db.prepare('SELECT 1 FROM crag_shop_orders LIMIT 1').get())
    } catch {
      throw unavailableStorage()
    }
  }

  function reconcileDeviceOrder(db, row, hostId, { tolerant = false } = {}) {
    if (
      !row.owner.startsWith('device:') ||
      row.status !== 'fulfilled' ||
      row.activation_phase === 'active' ||
      !row.redemption_sha256 ||
      isClosed(row)
    )
      return row
    try {
      if (!subscription.isRedemptionApplied(hostId, row.redemption_sha256)) return row
    } catch (error) {
      // One order's unverifiable receipt must not hide every other order. A listing
      // keeps the stored state; the order's own routes still report the exact reason.
      if (tolerant) return row
      throw hostCheckoutError(error) ?? deviceApplyFailure(error) ?? error
    }
    durable(db, () =>
      db
        .prepare(`UPDATE crag_shop_orders SET activation_phase = 'active'
      WHERE owner = ? AND order_id = ? AND redemption_sha256 = ? AND status = 'fulfilled'
        AND closed_at IS NULL`)
        .run(row.owner, row.order_id, row.redemption_sha256),
    )
    return findOrder(db, row.owner, row.order_id)
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
    } catch (error) {
      throw (
        hostCheckoutError(error) ??
        failure(409, 'shop_renewal_unavailable', 'The host subscription is not available for renewal')
      )
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
      throw hostCheckoutError(error) ?? unavailableTarget()
    }
  }

  let expiring = false
  // Close checkout links nobody paid. Independent of the activation poll: an order
  // outliving its payment window is part of the order lifecycle, not of activation,
  // so it must keep working with activation turned off. One order per tick keeps the
  // supplier re-reads spread out.
  async function pollOrderExpiry() {
    if (expiring) return
    expiring = true
    try {
      const db = getDb()
      const row = db
        .prepare(`SELECT * FROM crag_shop_orders
        WHERE dispatch_state = 'submitted' AND status IN ('reserved', 'pending')
          AND closed_at IS NULL
          AND reserved_at IS NOT NULL AND reserved_at <= ?
        ORDER BY reserved_at, order_id LIMIT 1`)
        .get(nowSeconds() - PAYMENT_WINDOW)
      if (!row) return
      // A reserved order never returned a checkout form, so no payment link ever
      // reached the buyer. Anything else has one, so ask the supplier before closing:
      // a paid order is left alone, and an unreachable supplier is retried next tick
      // rather than closed on a guess.
      if (row.status !== 'reserved') {
        // Derive the receipt outside the catch below: it reads local private storage,
        // and a failure there is not the supplier being unreachable. Letting it throw
        // surfaces the real fault in the poll log instead of looking like a deferral.
        const receipt = deriveOrderReceipt(receiptKey(db), row.order_id)
        let current = row
        try {
          current = reflectOrder(db, row.owner, await supplier.status(row, receipt))
        } catch (error) {
          if (!(error instanceof ShopError) || error.code !== 'shop_order_not_found') return
        }
        if (!UNPAID_STATES.includes(current.status)) return
      }
      durable(db, () =>
        db
          .prepare(`UPDATE crag_shop_orders SET closed_at = ?, activation_next_at = NULL
          WHERE order_id = ? AND closed_at IS NULL AND dispatch_state = 'submitted'`)
          .run(nowSeconds(), row.order_id),
      )
    } finally {
      expiring = false
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
        WHERE dispatch_state = 'submitted' AND activation_vm_id IS NOT NULL
          AND closed_at IS NULL
          AND activation_next_at IS NOT NULL AND activation_next_at <= ?
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
      const device = isCragDeviceShopPath(url.pathname)
      let owner = buyerOwner(req)
      const ok = (data) => json(res, 200, { ok: true, data })
      if (!device && route === 'plans') return ok(await supplier.plans({ allowPilot: !!owner }))
      if (!device && !owner) throw failure(403, 'shop_login_required', 'Sign in to the panel to access CRAG shop')
      if (!route) throw missingOrder()
      const originRequired = req.method === 'POST' || (device && (req.headers.origin || req.headers['sec-fetch-site']))
      if (originRequired && !sameOriginPost(req, publicBaseUrl)) {
        throw failure(403, 'shop_origin_denied', 'CRAG shop requires a same-origin request')
      }
      const supplierOptions = { allowPilot: !device }
      let hostId
      const deviceOptionDenied = () =>
        failure(403, 'shop_admin_required', 'Device checkout only supports new host subscriptions')
      if (device) {
        if (!allowDeviceRequest()) throw failure(429, 'shop_rate_limited', 'Too many CRAG checkout requests')
        const token = new RegExp(`(?:^|;\\s*)${DEVICE_COOKIE}=([A-Za-z0-9_-]{43})(?:;|$)`).exec(req.headers.cookie)?.[1]
        if (route === 'plans') {
          if (!token) {
            const secure = panelCookieSecure(req) ? '; Secure' : ''
            res.setHeader(
              'Set-Cookie',
              `${DEVICE_COOKIE}=${randomBytes(32).toString('base64url')}; Path=${DEVICE_ROOT}; Max-Age=31536000; HttpOnly; SameSite=Strict${secure}`,
            )
          }
          return ok(await supplier.plans(supplierOptions))
        }
        if (!token) {
          if (route === 'list') return ok({ orders: [], next_offset: null })
          if (route === 'quote' || route === 'create')
            throw failure(409, 'shop_device_checkout_required', 'Open the device checkout before creating an order')
          throw missingOrder()
        }
        hostId = deviceIdentity()
        owner = `device:${createHash('sha256').update(`${hostId}:${token}`).digest('hex')}`
      }
      if (route === 'activation-targets') {
        const targets =
          activationEnabled && isActivationAdmin(owner) && subscription?.listOrderTargets
            ? await subscription.listOrderTargets()
            : []
        return ok({
          targets: (isActivationAdmin(owner) ? targets : []).filter(isCragOrderVmId).map((vm_id) => ({ vm_id })),
        })
      }
      if (route === 'quote') {
        const input = purchaseInput(await readInput(req, readRawBody, false))
        if (device && input.sku === 'renewal') throw deviceOptionDenied()
        return ok(await supplier.quote(input, await renewalProof(req, input.sku), supplierOptions))
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
        return ok({
          orders: rows
            .slice(0, PAGE_SIZE)
            .map((row) => view(device ? reconcileDeviceOrder(db, row, hostId, { tolerant: true }) : row)),
          next_offset,
        })
      }
      if (route === 'create') {
        const input = createInput(await readInput(req, readRawBody, false))
        if (device && (input.sku === 'renewal' || input.vm_id)) throw deviceOptionDenied()
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
        if (isClosed(row)) return ok(view(row))
        const receipt = deriveOrderReceipt(key, row.order_id)
        const result = (reply) => {
          const current = reflectOrder(db, owner, reply.order)
          return ok({ ...view(current), ...(current.status === 'pending' && reply.form ? reply.form : {}) })
        }
        if (existing && row.dispatch_state !== 'unsent') {
          try {
            return result(await supplier.resume(row, receipt, supplierOptions))
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
          const quote = await supplier.quote(input.purchase, proof, supplierOptions)
          if (quote.amount_minor !== row.expected_amount_minor)
            throw failure(409, 'shop_price_changed', 'Price changed; request a new quote and use a new request ID')
        }
        if (row.activation_vm_id && (await pinTarget(owner, row.activation_vm_id)) !== row.activation_fingerprint)
          throw unavailableTarget()
        const dispatch = durable(db, () =>
          db
            .prepare(`UPDATE crag_shop_orders SET dispatch_state = 'submitted'
            WHERE owner = ? AND order_id = ? AND closed_at IS NULL AND dispatch_state <> 'cancelled'`)
            .run(owner, row.order_id),
        )
        if (!dispatch.changes) return ok(view(findOrder(db, owner, row.order_id)))
        const { order, form } = await supplier.create(row, receipt, proof, input.purchase, supplierOptions)
        const current = reflectOrder(db, owner, order)
        return ok({ ...view(current), ...(current.status === 'pending' && form ? form : {}) })
      }
      const orderId = ORDER_PATH.exec(url.pathname)?.[1]
      if (!orderId || !isOrderId(orderId)) throw missingOrder()
      let row = findOrder(db, owner, orderId)
      if (!row) throw missingOrder()
      if (device) row = reconcileDeviceOrder(db, row, hostId)
      if (['claim', 'resume', 'cancel', 'apply', 'apply-renewal', 'retry-activation'].includes(route)) {
        const input = await readInput(req, readRawBody, true)
        if (Object.keys(input).length !== 0) throw badBody()
      }
      if (route === 'cancel') {
        // The supplier protocol has no cancel endpoint and no expired state, so a
        // submitted order stays 'pending' there forever and has to be closed locally.
        if (row.dispatch_state === 'submitted') {
          if (!UNPAID_STATES.includes(row.status))
            throw failure(409, 'shop_order_paid', 'This order was already paid and cannot be cancelled')
          // 'reserved' means create never returned a checkout form, so the buyer never
          // received a payment link and cannot have paid: close it without asking the
          // supplier, which is what makes an order orphaned by a failed create
          // cancelable even while the supplier is down. A 'pending' order does have a
          // live payment link, so re-read it first — the local status can lag a payment
          // and cancelling a paid order would keep the money while dropping the
          // entitlement. An order the supplier no longer knows (404) is cancelable.
          if (row.status !== 'reserved') {
            let current = row
            try {
              const receipt = deriveOrderReceipt(receiptKey(db), row.order_id)
              current = reflectOrder(db, owner, await supplier.status(row, receipt))
            } catch (error) {
              if (!(error instanceof ShopError) || error.code !== 'shop_order_not_found') throw error
            }
            if (!UNPAID_STATES.includes(current.status))
              throw failure(409, 'shop_order_paid', 'This order was already paid and cannot be cancelled')
          }
        }
        durable(db, () =>
          db
            .prepare(`UPDATE crag_shop_orders SET closed_at = ?, activation_next_at = NULL
            WHERE owner = ? AND order_id = ? AND closed_at IS NULL
              AND dispatch_state IN ('unsent', 'submitted')`)
            .run(nowSeconds(), owner, row.order_id),
        )
        const current = findOrder(db, owner, orderId)
        if (!isClosed(current)) throw failure(409, 'shop_order_cannot_cancel', 'This order can no longer be cancelled')
        return ok(view(current))
      }
      if (isClosed(row)) {
        if (route === 'status') return ok(view(row))
        throw failure(409, 'shop_order_cancelled', 'This order was cancelled')
      }
      if (row.dispatch_state === 'unsent' && route === 'status') return ok(view(row))
      if (route === 'apply') {
        if (row.activation_phase === 'active') return ok(view(row))
        const receipt = deriveOrderReceipt(receiptKey(db), row.order_id)
        const current = row.status === 'fulfilled' ? row : reflectOrder(db, owner, await supplier.status(row, receipt))
        if (current.status !== 'fulfilled')
          throw failure(409, 'shop_claim_not_ready', 'The CRAG shop order has not been fulfilled')
        const { redemption_code } = await supplier.claim(row, receipt)
        const digest = createHash('sha256').update(redemption_code).digest('hex')
        if (row.redemption_sha256 && row.redemption_sha256 !== digest)
          throw failure(
            409,
            'shop_redemption_changed',
            'The supplier returned a different voucher for this order. Ask the administrator to reconcile it.',
          )
        const associated = durable(db, () =>
          db
            .prepare(`UPDATE crag_shop_orders SET redemption_sha256 = ?
          WHERE owner = ? AND order_id = ? AND (redemption_sha256 IS NULL OR redemption_sha256 = ?)`)
            .run(digest, owner, row.order_id, digest),
        )
        if (associated.changes !== 1)
          throw failure(
            409,
            'shop_redemption_changed',
            'The voucher association changed while applying this order. Check the original order before retrying.',
          )
        try {
          await subscription.redeemDeviceOrder(hostId, redemption_code)
        } catch (error) {
          if (error?.code === 'crag_subscription_host_package_unready')
            throw failure(
              409,
              'shop_device_package_unready',
              'No trusted host CRAG package available to apply the order',
            )
          throw (
            hostCheckoutError(error) ??
            deviceApplyFailure(error) ??
            failure(409, 'shop_device_apply_failed', 'Could not apply this order to the host; retry the same order')
          )
        }
        durable(db, () =>
          db
            .prepare(
              "UPDATE crag_shop_orders SET activation_phase = 'active' WHERE owner = ? AND order_id = ? AND redemption_sha256 = ?",
            )
            .run(owner, row.order_id, digest),
        )
        return ok(view(findOrder(db, owner, row.order_id)))
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
      if (device && route === 'status' && row.activation_phase === 'active') return ok(view(row))
      // A queued order advances in the background. A paused unpaid order still supports manual refresh.
      if (
        route === 'status' &&
        row.activation_vm_id &&
        ((activationEnabled && row.activation_next_at != null) || row.status === 'fulfilled')
      )
        return ok(view(row))
      const receipt = deriveOrderReceipt(receiptKey(db), row.order_id)
      if (route === 'resume') {
        const { order, form } = await supplier.resume(row, receipt, supplierOptions)
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
          } catch (error) {
            throw (
              hostCheckoutError(error) ??
              failure(
                503,
                'shop_renewal_failed',
                'Could not apply the renewal; refresh subscription status before retrying',
              )
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
      return json(res, error.status, {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.authorityRequestId && { details: { authority_request_id: error.authorityRequestId } }),
        },
      })
    }
  }

  return Object.assign(handleCragShop, { pollActivation, pollOrderExpiry })
}
