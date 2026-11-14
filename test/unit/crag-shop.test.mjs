import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'
import {
  buyerOwner,
  createCragShopHandler,
  cragShopRoute,
  sameOriginPost,
  sessionBuyerOwner,
} from '../../src/lib/admin/crag-shop.mjs'
import { createShopSupplier } from '../../src/lib/admin/crag-shop-supplier.mjs'
import { deriveOrderReceipt, loadOrderReceiptKey } from '../../src/lib/admin/crag-shop-receipt.mjs'

const PANEL = 'https://panel.example.test'
const SHOP = 'https://crag.fkcodex.com'
const BASE = '/api/panel/crag-shop'
const INPUT = { sku: 'quarter', payment_method: 'alipay', request_id: 'same-client-key' }
const PLAN = { sku: 'quarter', term: '3m', amount_minor: 59900, slot_limit: 10 }
const CODE = `CRAGR1.${Buffer.alloc(32, 42).toString('base64url')}`
const ACTION = 'https://gateway.example.test/submit.php'
const PROOF = 'fixture-receipt'
const PERSON = { panelUser: 'alice', panelBuyerOwner: 'panel:alice-id' }
const OTHER = { panelUser: 'bob', panelBuyerOwner: 'panel:bob-id', panelRole: 'admin' }
const MIGRATION = new URL('../../src/lib/db/migrations/055_crag_shop_orders.sql', import.meta.url)

function order(id, status = 'pending') {
  return { ...PLAN, order_id: id, status, payment_method: 'alipay', created_at: 1_800_000_000, redemption_code: CODE }
}

function fields(id) {
  return {
    pid: '42',
    type: 'alipay',
    out_trade_no: id,
    notify_url: `${SHOP}/shop/epay/notify`,
    name: 'Quarter subscription',
    money: '599.00',
    device: 'pc',
    sign_type: 'MD5',
    return_url: `${SHOP}/shop/return`,
    sign: 'a'.repeat(32),
  }
}

test('shop ACL is limited to the buyer slice and session binding does not become a replacement user', () => {
  const admin = { username: 'configured', password: 'fixture-only' }
  const alice = { user: 'alice', buyer: { id: 'alice-id' } }
  const record = { enabled: true, id: 'alice-id' }
  assert.equal(sessionBuyerOwner(alice, record, admin), 'panel:alice-id')
  assert.equal(sessionBuyerOwner(alice, { ...record, enabled: false }, admin), null)
  assert.equal(sessionBuyerOwner(alice, { ...record, id: 'replacement-id' }, admin), null)
  assert.equal(sessionBuyerOwner({ user: 'alice' }, record, admin), null)
  assert.equal(
    sessionBuyerOwner({ user: admin.username, buyer: { configuredAdmin: true } }, null, admin),
    'configured-admin:configured',
  )
  assert.equal(sessionBuyerOwner({ user: 'master' }, null, admin), null)
  assert.equal(buyerOwner({ ...PERSON, apiKeyKind: 'master' }), null)
  assert.equal(buyerOwner({ ...PERSON, apiKeyKind: 'managed' }), null)
  assert.equal(buyerOwner({ panelUser: 'alice', panelUserId: 'alice-id' }), null)
  for (const role of ['user', 'super', 'admin']) {
    assert.equal(authorizePanelRoute('POST', `${BASE}/orders/123/claim`, role).ok, true)
  }
  assert.equal(authorizePanelRoute('POST', `${BASE}/refund`, 'user').ok, false)
  assert.equal(cragShopRoute('GET', `${BASE}/orders/123/claim`), null)
})

test('mutations reject cross-origin and forwarded-header authority', () => {
  const req = (headers) => ({ headers: { host: 'panel.example.test', ...headers } })
  assert.equal(sameOriginPost(req({ origin: PANEL, 'sec-fetch-site': 'same-origin' })), true)
  assert.equal(sameOriginPost(req({ origin: PANEL }), PANEL), false)
  assert.equal(
    sameOriginPost(req({ origin: PANEL, host: 'private.proxy', 'sec-fetch-site': 'same-origin' }), PANEL),
    true,
  )
  assert.equal(sameOriginPost({ ...req({ origin: PANEL }), socket: { encrypted: true } }, PANEL), true)
  assert.equal(sameOriginPost(req({ origin: 'http://panel.example.test' })), true)
  assert.equal(sameOriginPost(req({ origin: PANEL, 'sec-fetch-site': 'cross-site' }), PANEL), false)
  assert.equal(sameOriginPost(req({ origin: 'null', 'sec-fetch-site': 'same-origin' }), PANEL), false)
  assert.equal(
    sameOriginPost(
      req({
        origin: 'https://evil.example.test',
        'x-forwarded-host': 'evil.example.test',
        'x-forwarded-proto': 'https',
        'sec-fetch-site': 'same-origin',
      }),
    ),
    false,
  )
  assert.equal(sameOriginPost(req({})), false)
})

test('supplier transport bounds, gateway pairing and response projection', async () => {
  const id = randomUUID()
  const row = { order_id: id, sku: PLAN.sku, payment_method: 'alipay' }
  let reply = { ...order(id), url: ACTION, data: fields(id) }
  let nextStatus = 200
  const supplier = createShopSupplier(async (url, init) => {
    assert.equal(url, `${SHOP}/shop/orders`)
    assert.equal(init.method, 'POST')
    assert.equal(init.redirect, 'error')
    assert.equal(init.cache, 'no-store')
    assert.equal(init.headers.authorization, `Bearer ${PROOF}`)
    assert.ok(init.signal)
    assert.deepEqual(JSON.parse(init.body), row)
    return Response.json(reply, { status: nextStatus })
  })
  const valid = await supplier.create(row, PROOF)
  assert.deepEqual(valid.form, { url: ACTION, data: fields(id) })
  assert.equal('redemption_code' in valid.order, false)
  for (const url of [
    'http://gateway.example.test/submit.php',
    `${ACTION}?a=1`,
    `${ACTION}#x`,
    'https://x@gateway.example.test/submit.php',
    'https://127.0.0.1/submit.php',
    'https://0x7f000001/submit.php',
    'https://localhost/submit.php',
    'https://gateway.example.test/a/../submit.php',
  ]) {
    reply = { ...order(id), url, data: fields(id) }
    await assert.rejects(supplier.create(row, PROOF), { code: 'shop_invalid_reply' })
  }
  for (const data of [
    { ...fields(id), money: '0.01' },
    { ...fields(id), out_trade_no: randomUUID() },
    { ...fields(id), name: PROOF },
    { ...fields(id), notify_url: ACTION },
    { ...fields(id), receipt: PROOF },
  ]) {
    reply = { ...order(id), url: ACTION, data }
    await assert.rejects(supplier.create(row, PROOF), { code: 'shop_invalid_reply' })
  }
  reply = { ...order(id), data: fields(id) }
  await assert.rejects(supplier.create(row, PROOF), { code: 'shop_invalid_reply' })
  reply = order(id)
  assert.equal((await supplier.create(row, PROOF)).form, null)
  reply = { ...order(id), untrusted: 'a'.repeat(65_536) }
  await assert.rejects(supplier.create(row, PROOF), { code: 'shop_invalid_reply' })
  nextStatus = 302
  reply = { receipt: PROOF }
  await assert.rejects(supplier.create(row, PROOF), { code: 'shop_invalid_reply' })
})

test('SQLite reservation survives restart; owners isolate retries, list, status and explicit claim', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-shop-'))
  const dbPath = path.join(root, 'kin.db')
  let db = new DatabaseSync(dbPath)
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
  db.exec(fs.readFileSync(MIGRATION, 'utf8'))
  const saved = new Map()
  let lostReply = true
  let status = 'pending'
  let outcalls = 0
  let catalogReads = 0
  const fetchMock = async (url, init) => {
    ++outcalls
    if (url === `${SHOP}/shop/plans`) {
      ++catalogReads
      assert.equal(init.headers.authorization, undefined)
      return Response.json({ plans: [{ ...PLAN, secret: CODE }], payment_methods: ['alipay'] })
    }
    const receipt = init.headers.authorization.slice('Bearer '.length)
    if (url === `${SHOP}/shop/orders`) {
      const { order_id: id, ...input } = JSON.parse(init.body)
      assert.deepEqual(input, { sku: PLAN.sku, payment_method: 'alipay' })
      const row = db.prepare('SELECT * FROM crag_shop_orders WHERE order_id = ?').get(id)
      assert.equal(row.request_id, INPUT.request_id)
      assert.equal(
        receipt,
        deriveOrderReceipt(
          loadOrderReceiptKey(root, () => true),
          id,
        ),
      )
      if (saved.has(id)) assert.equal(receipt, saved.get(id))
      saved.set(id, receipt)
      if (lostReply) {
        lostReply = false
        throw Error(receipt)
      }
      return Response.json({ ...order(id, status), url: ACTION, data: fields(id), receipt })
    }
    const [, id, claim] = /\/shop\/orders\/([^/]+)(\/claim)?$/.exec(url)
    assert.equal(receipt, saved.get(id))
    if (!claim) return Response.json({ ...order(id, status), url: ACTION, data: fields(id), receipt })
    assert.equal(init.method, 'POST')
    assert.equal(init.body, undefined)
    if (status !== 'fulfilled') return Response.json({ receipt, redemption_code: CODE }, { status: 409 })
    return Response.json({ order_id: id, redemption_code: CODE, receipt })
  }
  const handler = () =>
    createCragShopHandler({
      dataDir: root,
      publicBaseUrl: PANEL,
      getDb: () => db,
      json: (_, http, body) => ({ http, ...body }),
      readRawBody: (req) => req.raw,
      supplier: createShopSupplier(fetchMock),
    })
  let handle = handler()
  const call = (actor, method, endpoint, body, extra = {}) => {
    const url = new URL(`${PANEL}${BASE}${endpoint}`)
    const req = {
      ...actor,
      method,
      raw: Buffer.from(body === undefined ? '' : JSON.stringify(body)),
      headers: {
        host: 'panel.example.test',
        origin: PANEL,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        ...extra,
      },
    }
    return handle(req, {}, url, cragShopRoute(method, url.pathname))
  }
  assert.equal((await call({ apiKeyKind: 'master' }, 'GET', '/plans')).http, 403)
  assert.equal((await call(PERSON, 'POST', '/orders', INPUT, { origin: 'https://elsewhere.example.test' })).http, 403)
  assert.equal((await call(PERSON, 'POST', '/orders', INPUT, { 'content-type': 'text/plain' })).http, 415)
  assert.equal((await call(PERSON, 'POST', '/orders', { ...INPUT, owner: 'bob' })).http, 400)
  assert.equal(outcalls, 0)
  assert.deepEqual((await call(PERSON, 'GET', '/plans')).data.plans, [PLAN])
  const failed = await call(PERSON, 'POST', '/orders', INPUT)
  assert.equal(failed.http, 503)
  const [[id, firstReceipt]] = saved
  assert.equal(JSON.stringify(failed).includes(firstReceipt), false)
  assert.equal((await call(PERSON, 'GET', '/orders')).data.orders[0].status, 'reserved')
  db.close()
  db = new DatabaseSync(dbPath)
  handle = handler()
  const replay = await call(PERSON, 'POST', '/orders', INPUT)
  assert.equal(replay.data.order_id, id)
  assert.equal(replay.data.request_id, INPUT.request_id)
  assert.equal(replay.data.url, ACTION)
  assert.equal(saved.get(id), firstReceipt)
  assert.equal(catalogReads, 1)
  assert.equal((await call(PERSON, 'POST', '/orders', { ...INPUT, payment_method: 'wxpay' })).http, 409)
  assert.equal((await call(OTHER, 'GET', '/orders')).data.orders.length, 0)
  const beforeForeign = outcalls
  assert.deepEqual(await call(OTHER, 'GET', `/orders/${id}`), await call(OTHER, 'GET', `/orders/${randomUUID()}`))
  assert.equal((await call(OTHER, 'POST', `/orders/${id}/claim`)).http, 404)
  assert.equal(outcalls, beforeForeign)
  const bob = await call(OTHER, 'POST', '/orders', INPUT)
  assert.notEqual(bob.data.order_id, id)
  for (const bypass of [
    replay,
    await call(PERSON, 'GET', '/orders'),
    await call(PERSON, 'GET', `/orders/${id}`),
    await call(PERSON, 'POST', `/orders/${id}/claim`),
  ]) {
    assert.equal(JSON.stringify(bypass).includes(CODE), false)
    assert.equal(JSON.stringify(bypass).includes(firstReceipt), false)
  }
  status = 'fulfilled'
  assert.equal((await call(PERSON, 'GET', `/orders/${id}`)).data.status, 'fulfilled')
  assert.deepEqual((await call(PERSON, 'POST', `/orders/${id}/claim`)).data, { order_id: id, redemption_code: CODE })
  status = 'pending'
  assert.equal((await call(PERSON, 'GET', `/orders/${id}`)).data.status, 'fulfilled')
  assert.equal((await call(PERSON, 'POST', '/orders', INPUT)).data.url, undefined)
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM crag_shop_orders').all()).includes(CODE), false)
  const keyPath = path.join(root, 'crag-shop-private', 'receipt.key')
  assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.dirname(keyPath)).mode & 0o777, 0o700)
  const key = fs.readFileSync(keyPath)
  assert.equal(key.length, 32)
  assert.equal(firstReceipt, createHmac('sha256', key).update(`order-receipt:${id}`).digest('base64url'))
  fs.unlinkSync(keyPath)
  assert.equal((await call(PERSON, 'GET', `/orders/${id}`)).error.code, 'shop_private_storage_unavailable')
  assert.equal(fs.existsSync(keyPath), false)
  const alternate = path.join(root, 'test-only-key')
  fs.writeFileSync(alternate, key, { mode: 0o600 })
  fs.symlinkSync(alternate, keyPath)
  assert.equal((await call(PERSON, 'GET', `/orders/${id}`)).error.code, 'shop_private_storage_unavailable')
  fs.unlinkSync(keyPath)
  fs.writeFileSync(keyPath, key, { mode: 0o600 })
  fs.chmodSync(keyPath, 0o644)
  assert.equal((await call(PERSON, 'GET', `/orders/${id}`)).error.code, 'shop_private_storage_unavailable')
})
