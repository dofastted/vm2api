import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

const ROOT = 'https://crag.fkcodex.com'
const MAX_RESPONSE = 64 * 1024
const SHOP_TIMEOUT = 8000
const PILOT_TOKEN_LENGTH = 43 // Unpadded base64url for 32 bytes.

export const isPaymentMethod = (value) => value === 'wxpay' || value === 'alipay'
export const isSku = (value) =>
  typeof value === 'string' && /^[a-zA-Z0-9]/.test(value) && value.length <= 64 && !/[^a-zA-Z0-9_-]/.test(value)
export const isOrderId = (value) =>
  typeof value === 'string' &&
  value.length === 36 &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
export const ORDER_STATES = ['reserved', 'pending', 'paid', 'fulfilled']
export const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
export const isQuantity = (value) => Number.isInteger(value) && value >= 1 && value <= 2147483647
export const isAmount = (value) => Number.isSafeInteger(value) && value >= 1

export class ShopError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

const invalidReply = () => new ShopError(502, 'shop_invalid_reply', 'Invalid response from CRAG shop')

export function publicPlan(value) {
  if (!object(value)) throw invalidReply()
  const { sku, term, amount_minor, slot_limit } = value
  if (
    !isSku(sku) ||
    !['1m', '3m', '1y', 'custom', 'monthly'].includes(term) ||
    !isAmount(amount_minor) ||
    !(slot_limit === 'unlimited' || isQuantity(slot_limit))
  )
    throw invalidReply()
  const plan = { sku, term, amount_minor, slot_limit }
  if (value.remaining !== undefined) {
    if (value.remaining !== null && (!Number.isSafeInteger(value.remaining) || value.remaining < 0))
      throw invalidReply()
    plan.remaining = value.remaining
  }
  if (value.renewable !== undefined) {
    if (typeof value.renewable !== 'boolean') throw invalidReply()
    plan.renewable = value.renewable
  }
  return plan
}

function priceSnapshot(value, required = false) {
  const snapshot = {}
  for (const key of ['months', 'subtotal_minor', 'discount_minor']) {
    if (!required && value[key] === undefined) continue
    const valid = key === 'months' ? isQuantity(value[key]) : Number.isSafeInteger(value[key]) && value[key] >= 0
    if (!valid) throw invalidReply()
    snapshot[key] = value[key]
  }
  if (
    (snapshot.subtotal_minor !== undefined && snapshot.subtotal_minor < value.amount_minor) ||
    (snapshot.subtotal_minor !== undefined &&
      snapshot.discount_minor !== undefined &&
      snapshot.subtotal_minor - snapshot.discount_minor !== value.amount_minor)
  )
    throw invalidReply()
  return snapshot
}

function publicQuote(value, input) {
  const { renewable, ...plan } = publicPlan(value)
  const snapshot = priceSnapshot(value, true)
  if (
    plan.sku !== input.sku ||
    (input.slots !== undefined && plan.slot_limit !== input.slots) ||
    (input.months !== undefined && snapshot.months !== input.months)
  )
    throw invalidReply()
  return { ...plan, ...snapshot }
}

function publicOrder(value, row) {
  const plan = publicPlan(value)
  const snapshot = priceSnapshot(value)
  const purchase = row.purchase_json ? JSON.parse(row.purchase_json) : { sku: row.sku }
  const { order_id, status, created_at, payment_method } = value
  if (
    order_id !== row.order_id ||
    plan.sku !== row.sku ||
    payment_method !== row.payment_method ||
    !ORDER_STATES.slice(1).includes(status) ||
    !Number.isSafeInteger(created_at) ||
    created_at <= 0 ||
    (row.expected_amount_minor != null && plan.amount_minor !== row.expected_amount_minor) ||
    (purchase.slots !== undefined && plan.slot_limit !== purchase.slots) ||
    (purchase.months !== undefined && snapshot.months !== undefined && snapshot.months !== purchase.months)
  )
    throw invalidReply()
  return { ...plan, ...snapshot, order_id, status, created_at, payment_method }
}

const FORM_KEYS = [
  'pid',
  'type',
  'out_trade_no',
  'notify_url',
  'name',
  'money',
  'device',
  'sign_type',
  'return_url',
  'sign',
]
// The merchant's pinned TLS origin authorizes the gateway action. Do not normalize or infer an action.
function validGateway(value) {
  if (typeof value !== 'string' || value.length > 300) return false
  const match = /^https:\/\/([a-z0-9.-]+)(?::([1-9][0-9]{0,4}))?(?:\/[A-Za-z0-9_-]+)*\/submit\.php$/.exec(value)
  if (!match) return false
  const labels = match[1].split('.')
  if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false
  const tld = labels.at(-1)
  if (!/^[a-z]/.test(tld) || ['localhost', 'local', 'internal', 'lan', 'home', 'onion', 'invalid'].includes(tld))
    return false
  try {
    return new URL(value).href === value
  } catch {
    return false
  }
}

function checkout(value, order, receipt) {
  if (value.url === undefined && value.data === undefined) return null
  if (order.status !== 'pending' || !validGateway(value.url) || !object(value.data)) throw invalidReply()
  const fields = value.data
  if (
    Object.keys(fields).length !== FORM_KEYS.length ||
    FORM_KEYS.some(
      (key) =>
        !Object.hasOwn(fields, key) ||
        typeof fields[key] !== 'string' ||
        fields[key].length < 1 ||
        fields[key].length > 256 ||
        /[\p{Cc}]/u.test(fields[key]) ||
        fields[key].includes(receipt) ||
        fields[key].includes('CRAGR1.'),
    ) ||
    value.url.includes(receipt)
  )
    throw invalidReply()
  const cents = BigInt(order.amount_minor)
  const money = `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`
  if (
    fields.out_trade_no !== order.order_id ||
    fields.type !== order.payment_method ||
    fields.money !== money ||
    fields.device !== 'pc' ||
    fields.sign_type !== 'MD5' ||
    !/^[0-9a-f]{32}$/.test(fields.sign) ||
    fields.notify_url !== `${ROOT}/shop/epay/notify` ||
    fields.return_url !== `${ROOT}/shop/return`
  )
    throw invalidReply()
  return { url: value.url, data: Object.fromEntries(FORM_KEYS.map((key) => [key, fields[key]])) }
}

async function readReply(res) {
  if (!res.body || !/^application\/json(?:\s*;|$)/i.test(res.headers.get('content-type') || '')) throw invalidReply()
  if (Number(res.headers.get('content-length')) > MAX_RESPONSE) throw invalidReply()
  const chunks = []
  let bytes = 0
  for await (const chunk of res.body) {
    bytes += chunk.byteLength
    if (bytes > MAX_RESPONSE) throw invalidReply()
    chunks.push(chunk)
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)))
  } catch {
    throw invalidReply()
  }
}

const commerceErrors = new Map([
  ['amount_out_of_range', [400, 'shop_amount_out_of_range', 'Payment amount out of range']],
  ['quote_changed', [409, 'shop_price_changed', 'Price changed; request a new quote']],
  ['out_of_stock', [409, 'shop_out_of_stock', 'Launch plan sold out']],
  ['coupon_unavailable', [409, 'shop_coupon_unavailable', 'Coupon unavailable']],
  ['renewal_unavailable', [409, 'shop_renewal_unavailable', 'Current plan cannot be renewed']],
])

function supplierError(status, operation) {
  if (status === 404 && ['create', 'quote'].includes(operation)) {
    return new ShopError(404, 'shop_item_unavailable', 'Plan or payment method unavailable')
  }
  if (status === 404 && operation !== 'plans') return new ShopError(404, 'shop_order_not_found', 'Order not found')
  if (status === 409 && operation === 'claim')
    return new ShopError(409, 'shop_claim_not_ready', 'Order is not ready to claim')
  if (status === 409 && operation === 'create')
    return new ShopError(409, 'shop_order_conflict', 'Order input conflicts')
  if ([400, 422].includes(status) && ['create', 'quote'].includes(operation))
    return new ShopError(400, 'shop_invalid_purchase', 'Purchase options are unavailable or invalid')
  if ([401, 403, 409].includes(status) && ['create', 'quote'].includes(operation))
    return new ShopError(409, 'shop_purchase_unavailable', 'Purchase is unavailable; request a new quote')
  if (status === 429) return new ShopError(429, 'shop_rate_limited', 'CRAG shop is busy; try again later')
  if (status === 503) return new ShopError(503, 'shop_unavailable', 'CRAG shop unavailable; try again later')
  return invalidReply()
}

async function readPilotToken(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const maxSize = PILOT_TOKEN_LENGTH + 2 // Allow a single trailing LF or CRLF.
    const stat = await handle.stat()
    const { mode, size, uid } = stat
    if (!stat.isFile() || (mode & 0o7777) !== 0o600 || uid !== process.geteuid() || size > maxSize) {
      throw new Error('Invalid CRAG shop pilot credential file')
    }

    // Bound the read even if the file grows after stat.
    const bytes = Buffer.alloc(maxSize + 1)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    const token = bytes.toString('latin1', 0, length).replace(/\r?\n$/, '')
    if (
      length !== size ||
      token.length !== PILOT_TOKEN_LENGTH ||
      /[^A-Za-z0-9_-]/.test(token) ||
      Buffer.from(token, 'base64url').toString('base64url') !== token
    ) {
      throw new Error('Invalid CRAG shop pilot credential file')
    }
    return token
  } finally {
    await handle.close()
  }
}

export function createShopSupplier(fetchImpl = globalThis.fetch) {
  async function send(operation, path, { method = 'GET', receipt, body } = {}) {
    const headers = { accept: 'application/json', 'cache-control': 'no-store' }
    if (receipt) headers.authorization = `Bearer ${receipt}`
    if (body) headers['content-type'] = 'application/json'
    let response
    try {
      let pilotToken
      const pilotFile = process.env.VM2API_CRAG_SHOP_PILOT_TOKEN_FILE
      if (
        pilotFile !== undefined &&
        ((operation === 'plans' && method === 'GET' && path === '/shop/plans') ||
          (operation === 'create' && method === 'POST' && path === '/shop/orders'))
      ) {
        pilotToken = await readPilotToken(pilotFile)
        headers['X-Crag-Shop-Pilot'] = pilotToken
      }
      response = await fetchImpl(`${ROOT}${path}`, {
        method,
        headers,
        body: body && JSON.stringify(body),
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(SHOP_TIMEOUT),
      })
      if (!response.ok) {
        if (['create', 'quote'].includes(operation) && [400, 409].includes(response.status)) {
          const reply = await readReply(response).catch(() => null)
          const known = commerceErrors.get(reply?.error)
          if (known?.[0] === response.status) throw new ShopError(...known)
        }
        throw supplierError(response.status, operation)
      }
      const value = await readReply(response)
      // Never surface an accidentally reflected pilot token in buyer data or payment forms.
      for (const secret of [pilotToken, body?.renewal_proof]) {
        if (secret && JSON.stringify(value).includes(JSON.stringify(secret).slice(1, -1))) throw invalidReply()
      }
      return value
    } catch (err) {
      if (err instanceof ShopError) throw err
      throw new ShopError(503, 'shop_unavailable', 'CRAG shop unavailable; try again later')
    } finally {
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {})
    }
  }

  return {
    async plans() {
      const value = await send('plans', '/shop/plans')
      if (
        !object(value) ||
        !Array.isArray(value.plans) ||
        !Array.isArray(value.payment_methods) ||
        !value.payment_methods.every(isPaymentMethod)
      )
        throw invalidReply()
      const plans = value.plans.map(publicPlan)
      if (new Set(plans.map(({ sku }) => sku)).size !== plans.length) throw invalidReply()
      const result = { plans, payment_methods: [...new Set(value.payment_methods)] }
      if (value.commerce !== undefined) {
        const commerce = value.commerce
        if (
          !object(commerce) ||
          !isAmount(commerce.unit_amount_minor) ||
          !isAmount(commerce.max_amount_minor) ||
          commerce.unit_amount_minor > commerce.max_amount_minor ||
          !isQuantity(commerce.max_months) ||
          !isQuantity(commerce.max_slots) ||
          (commerce.custom_renewable !== undefined && typeof commerce.custom_renewable !== 'boolean')
        )
          throw invalidReply()
        result.commerce = Object.fromEntries(
          ['unit_amount_minor', 'max_amount_minor', 'max_months', 'max_slots', 'custom_renewable']
            .filter((key) => commerce[key] !== undefined)
            .map((key) => [key, commerce[key]]),
        )
      }
      return result
    },
    async quote(input, renewalProof) {
      const value = await send('quote', '/shop/quote', {
        method: 'POST',
        body: { ...input, ...(renewalProof ? { renewal_proof: renewalProof } : {}) },
      })
      return publicQuote(value, input)
    },
    async create(row, receipt, renewalProof, purchase = { sku: row.sku }) {
      const { order_id, payment_method } = row
      const value = await send('create', '/shop/orders', {
        method: 'POST',
        receipt,
        body: {
          order_id,
          ...purchase,
          payment_method,
          ...(row.expected_amount_minor != null ? { expected_amount_minor: row.expected_amount_minor } : {}),
          ...(renewalProof ? { renewal_proof: renewalProof } : {}),
        },
      })
      const order = publicOrder(value, row)
      return { order, form: checkout(value, order, receipt) }
    },
    async resume(row, receipt) {
      const value = await send('resume', `/shop/orders/${row.order_id}/resume`, { method: 'POST', receipt })
      const order = publicOrder(value, row)
      return { order, form: checkout(value, order, receipt) }
    },
    async status(row, receipt) {
      const value = await send('status', `/shop/orders/${row.order_id}`, { receipt })
      return publicOrder(value, row)
    },
    async claim(row, receipt) {
      const value = await send('claim', `/shop/orders/${row.order_id}/claim`, { method: 'POST', receipt })
      const code = value?.redemption_code
      if (
        value?.order_id !== row.order_id ||
        typeof code !== 'string' ||
        code.length !== 50 ||
        !/^CRAGR1\.[A-Za-z0-9_-]{43}$/.test(code) ||
        Buffer.from(code.slice(7), 'base64url').toString('base64url') !== code.slice(7)
      )
        throw invalidReply()
      return { order_id: row.order_id, redemption_code: code }
    },
  }
}
