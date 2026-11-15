import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
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
import { applyMigrations, createDatabase } from '../../src/lib/db/database.mjs'
import { checkCragLicense } from '../../src/lib/vm/crag-license.mjs'
import { createCragSubscription } from '../../src/lib/vm/crag-subscription.mjs'
import { cragSubscriptionPublicDirectory } from '../../src/lib/vm/crag-subscription-paths.mjs'
import {
  issueHostEntitlement,
  issueSlotPermit,
  seedEncryptedPackage,
  signSubscriptionBytes,
} from '../fixtures/crag-license.mjs'

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
const MIGRATIONS = new URL('../../src/lib/db/migrations/', import.meta.url)
const MIGRATION = new URL('056_crag_shop_orders.sql', MIGRATIONS)
const COMMERCE_MIGRATION = new URL('057_crag_shop_commerce.sql', MIGRATIONS)
const ACTIVATION_MIGRATION = new URL('058_crag_shop_activation.sql', MIGRATIONS)
const PILOT_TOKEN_FILE_ENV = 'VM2API_CRAG_SHOP_PILOT_TOKEN_FILE'

test.beforeEach((t) => {
  const previous = process.env[PILOT_TOKEN_FILE_ENV]
  delete process.env[PILOT_TOKEN_FILE_ENV]
  t.after(() => {
    if (previous === undefined) delete process.env[PILOT_TOKEN_FILE_ENV]
    else process.env[PILOT_TOKEN_FILE_ENV] = previous
  })
})

test('shop migration numbering preserves applied schemas and orders from either parent', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-shop-migrations-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  for (const legacy of [true, false]) {
    const migrationsDir = path.join(root, legacy ? 'local' : 'upstream')
    fs.mkdirSync(migrationsDir)
    for (const name of fs.readdirSync(MIGRATIONS)) {
      if (name >= '057_' || (legacy && name === '055_account_lifetime_usage.sql')) continue
      const dest = legacy && name === '056_crag_shop_orders.sql' ? '055_crag_shop_orders.sql' : name
      fs.copyFileSync(new URL(name, MIGRATIONS), path.join(migrationsDir, dest))
    }
    if (legacy) {
      fs.copyFileSync(COMMERCE_MIGRATION, path.join(migrationsDir, '056_crag_shop_commerce.sql'))
      fs.copyFileSync(ACTIVATION_MIGRATION, path.join(migrationsDir, '057_crag_shop_activation.sql'))
    }

    const db = new DatabaseSync(':memory:')
    t.after(() => db.close())
    applyMigrations(db, { migrationsDir })
    db.prepare(`INSERT INTO crag_shop_orders (order_id, owner, request_id, sku, payment_method, reserved_at)
      VALUES ('fixture-order', ?, 'fixture-request', 'quarter', 'alipay', 1)`).run(PERSON.panelBuyerOwner)
    if (legacy) {
      db.prepare(`UPDATE crag_shop_orders SET activation_vm_id = 'vm-ready', activation_fingerprint = ?,
        activation_phase = 'redeemed', activation_attempts = 2`).run('a'.repeat(64))
    }

    assert.deepEqual(
      applyMigrations(db),
      legacy ? ['055_account_lifetime_usage.sql'] : ['057_crag_shop_commerce.sql', '058_crag_shop_activation.sql'],
    )
    assert.deepEqual(applyMigrations(db), [])
    assert.deepEqual(
      db
        .prepare("SELECT name FROM schema_migrations WHERE version >= '055' ORDER BY version")
        .all()
        .map((r) => r.name),
      [
        '055_account_lifetime_usage.sql',
        '056_crag_shop_orders.sql',
        '057_crag_shop_commerce.sql',
        '058_crag_shop_activation.sql',
      ],
    )
    const saved = db.prepare("SELECT * FROM crag_shop_orders WHERE order_id = 'fixture-order'").get()
    assert.equal(saved.owner, PERSON.panelBuyerOwner)
    assert.equal(saved.activation_vm_id, legacy ? 'vm-ready' : null)
    assert.equal(saved.activation_phase, legacy ? 'redeemed' : 'waiting')
    assert.equal(saved.activation_attempts, legacy ? 2 : 0)
  }
})

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
  const kpay = 'https://api.kpay.cc/epay/submit.php'
  reply = { ...order(id), url: kpay, data: fields(id) }
  assert.deepEqual((await supplier.create(row, PROOF)).form, { url: kpay, data: fields(id) })
  for (const url of [
    'http://gateway.example.test/submit.php',
    `${ACTION}?a=1`,
    `${ACTION}#x`,
    'https://x@gateway.example.test/submit.php',
    'https://127.0.0.1/submit.php',
    'https://0x7f000001/submit.php',
    'https://localhost/submit.php',
    'https://gateway.example.test/a/../submit.php',
    'https://api.kpay.cc/epay%2Fredirect/submit.php',
    'https://api.kpay.cc//epay/submit.php',
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

test('pilot credential authorizes checkout operations but is never sent with receipt-only status and claim', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-shop-pilot-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'pilot.key')
  const token = Buffer.alloc(32, 27).toString('base64url')
  const id = randomUUID()
  const row = { order_id: id, sku: PLAN.sku, payment_method: 'alipay' }
  const catalog = { plans: [PLAN], payment_methods: ['alipay'] }
  const requests = []
  let plansReply = catalog
  const supplier = createShopSupplier(async (url, init) => {
    requests.push({ url, ...init, headers: new Headers(init.headers) })
    if (url === `${SHOP}/shop/plans`) return Response.json(plansReply)
    if (url === `${SHOP}/shop/quote`)
      return Response.json({ ...PLAN, months: 3, subtotal_minor: PLAN.amount_minor, discount_minor: 0 })
    return Response.json(order(id))
  })
  const checkRequests = (expected) => {
    assert.deepEqual(
      requests.splice(0).map(({ method, url, headers, redirect, body }) => {
        assert.equal(redirect, 'error')
        return [method, url, headers.get('X-Crag-Shop-Pilot'), headers.get('authorization'), body]
      }),
      expected,
    )
  }
  const planRequest = (pilot) => ['GET', `${SHOP}/shop/plans`, pilot, null, undefined]
  const createRequest = (pilot) => ['POST', `${SHOP}/shop/orders`, pilot, `Bearer ${PROOF}`, JSON.stringify(row)]
  const checkReceiptOnlyRequests = async () => {
    await supplier.status(row, PROOF)
    assert.deepEqual(await supplier.claim(row, PROOF), { order_id: id, redemption_code: CODE })
    checkRequests([
      ['GET', `${SHOP}/shop/orders/${id}`, null, `Bearer ${PROOF}`, undefined],
      ['POST', `${SHOP}/shop/orders/${id}/claim`, null, `Bearer ${PROOF}`, undefined],
    ])
  }

  assert.deepEqual(await supplier.plans(), catalog)
  await supplier.create(row, PROOF)
  checkRequests([planRequest(null), createRequest(null)])

  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 })
  process.env[PILOT_TOKEN_FILE_ENV] = file
  assert.deepEqual(await supplier.plans(), catalog)
  assert.deepEqual(await supplier.plans({ allowPilot: true }), catalog)
  await supplier.create(row, PROOF)
  checkRequests([planRequest(null), planRequest(token), createRequest(token)])
  await supplier.quote({ sku: row.sku })
  await supplier.resume(row, PROOF)
  checkRequests([
    ['POST', `${SHOP}/shop/quote`, token, null, JSON.stringify({ sku: row.sku })],
    ['POST', `${SHOP}/shop/orders/${id}/resume`, token, `Bearer ${PROOF}`, undefined],
  ])
  await checkReceiptOnlyRequests()

  plansReply = { ...catalog, plans: [{ ...PLAN, sku: token }] }
  await assert.rejects(supplier.plans({ allowPilot: true }), { code: 'shop_invalid_reply' })
  checkRequests([planRequest(token)])

  const unavailable = (error) => {
    assert.equal(error.code, 'shop_unavailable')
    assert.equal(error.status, 503)
    assert.equal(error.message, 'CRAG shop unavailable; try again later')
    assert.equal(error.cause, undefined)
    return true
  }
  const checkInvalidFile = async () => {
    plansReply = { ...catalog, payment_methods: [] }
    assert.deepEqual(await supplier.plans({ allowPilot: true }), plansReply)
    await assert.rejects(supplier.create(row, PROOF), unavailable)
    checkRequests([planRequest(null)])
  }
  fs.chmodSync(file, 0o644)
  await checkInvalidFile()
  fs.chmodSync(file, 0o600)
  for (const content of ['', `${token}=`, `${token.slice(0, -1)}B`, `${token}\n\n`, `${token}\nX-Bad: value`]) {
    fs.writeFileSync(file, content)
    await checkInvalidFile()
  }
  fs.writeFileSync(file, token)
  const symlink = path.join(root, 'pilot-link')
  fs.symlinkSync(file, symlink)
  process.env[PILOT_TOKEN_FILE_ENV] = symlink
  await checkInvalidFile()
  for (const invalidPath of [root, path.join(root, 'missing'), '']) {
    process.env[PILOT_TOKEN_FILE_ENV] = invalidPath
    await checkInvalidFile()
  }
  await checkReceiptOnlyRequests()
})

test('SQLite reservation survives restart; owners isolate retries, list, status and explicit claim', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-shop-'))
  const dbPath = path.join(root, 'kin.db')
  let db = createDatabase({ dbPath })
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
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
    if (url.endsWith('/resume')) {
      const id = url.split('/').at(-2)
      assert.equal(receipt, saved.get(id))
      return Response.json({ ...order(id, status), url: ACTION, data: fields(id) })
    }
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
  for (const actor of [{}, { apiKeyKind: 'master' }]) {
    assert.equal((await call(actor, 'GET', '/orders')).error.code, 'shop_login_required')
    assert.equal((await call(actor, 'POST', '/orders', INPUT)).error.code, 'shop_login_required')
    assert.equal((await call(actor, 'POST', '/plans', {})).error.code, 'shop_login_required')
  }
  assert.equal((await call(PERSON, 'POST', '/orders', INPUT, { origin: 'https://elsewhere.example.test' })).http, 403)
  assert.equal((await call(PERSON, 'POST', '/orders', INPUT, { 'content-type': 'text/plain' })).http, 415)
  assert.equal((await call(PERSON, 'POST', '/orders', { ...INPUT, owner: 'bob' })).http, 400)
  assert.equal(outcalls, 0)
  assert.deepEqual((await call({}, 'GET', '/plans')).data.plans, [PLAN])
  const failed = await call(PERSON, 'POST', '/orders', INPUT)
  assert.equal(failed.http, 503)
  const [[id, firstReceipt]] = saved
  assert.equal(JSON.stringify(failed).includes(firstReceipt), false)
  assert.equal((await call(PERSON, 'GET', '/orders')).data.orders[0].status, 'reserved')
  db.close()
  db = createDatabase({ dbPath })
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

test('pinned fulfillment survives lost redeem and H2 bind replies without reapplying or rebinding another slot', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-auto-activation-'))
  const dbPath = path.join(root, 'kin.db')
  let db = new DatabaseSync(dbPath)
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
  db.exec(fs.readFileSync(MIGRATION, 'utf8'))
  db.exec(fs.readFileSync(COMMERCE_MIGRATION, 'utf8'))
  const manualId = randomUUID()
  db.prepare(`INSERT INTO crag_shop_orders
    (order_id, owner, request_id, sku, payment_method, reserved_at, status, created_at, term, amount_minor, slot_limit)
    VALUES (?, ?, 'legacy-id', 'quarter', 'alipay', 1, 'fulfilled', 1, '3m', 59900, 10)`).run(
    manualId,
    OTHER.panelBuyerOwner,
  )
  db.exec(fs.readFileSync(ACTIVATION_MIGRATION, 'utf8'))
  // The legacy row normally already has a receipt key from its original checkout.
  const receiptKey = loadOrderReceiptKey(root, () => false)
  const publicDir = cragSubscriptionPublicDirectory(root)
  fs.mkdirSync(path.dirname(path.dirname(publicDir)), { recursive: true })
  const source = path.join(root, 'host-machine-id')
  fs.writeFileSync(source, randomBytes(16).toString('hex'), { mode: 0o600 })
  seedEncryptedPackage(root)
  const slots = ['vm-ready', 'vm-other', 'vm-stopped'].map((id) => ({
    id,
    dataplane: 'crag',
    crag_kernel_version: 'v2',
  }))
  for (const vm of slots) {
    const dir = path.join(root, 'vms', vm.id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'machine-id'), randomBytes(16).toString('hex'))
  }

  const merchant = new Map()
  const deliveryRequests = []
  const supplier = createShopSupplier(async (url, init) => {
    if (url === `${SHOP}/shop/orders`) {
      const { order_id: id, ...input } = JSON.parse(init.body)
      assert.deepEqual(input, { sku: PLAN.sku, payment_method: 'alipay' })
      const pin = db.prepare('SELECT activation_fingerprint FROM crag_shop_orders WHERE order_id = ?').get(id)
      assert.match(pin.activation_fingerprint, /^[a-f0-9]{64}$/)
      assert.equal(init.headers.authorization, `Bearer ${deriveOrderReceipt(receiptKey, id)}`)
      merchant.set(id, order(id))
      return Response.json({ ...merchant.get(id), url: ACTION, data: fields(id) })
    }
    const [, id, operation] = /\/shop\/orders\/([^/]+)(?:\/(claim|resume))?$/.exec(url)
    assert.equal(init.headers.authorization, `Bearer ${deriveOrderReceipt(receiptKey, id)}`)
    assert.equal(init.body, undefined)
    const remote = merchant.get(id)
    assert.ok(remote, 'the worker must never poll a legacy order')
    deliveryRequests.push({ id, operation, method: init.method })
    if (operation === 'claim') {
      assert.equal(remote.status, 'fulfilled')
      return Response.json({ order_id: id, redemption_code: CODE })
    }
    if (operation === 'resume' && remote.status === 'pending')
      return Response.json({ ...remote, url: ACTION, data: fields(id) })
    return Response.json(remote)
  })
  let bearer, rights, hostIdAtBind, machineCode, slotPermit
  let redeems = 0
  let bindAttempts = 0
  let admin = true
  const signedRights = (hostId, revision, roster) => {
    const { claims } = issueHostEntitlement(root, hostId, { revision, slot_limit: 1 })
    return {
      entitlement: signSubscriptionBytes(root, 'CRAGH2', JSON.stringify({ ...claims, version: 2, roster })),
      revision,
      slot_limit: 1,
      expires_at: claims.expires_at,
    }
  }
  const connect = () =>
    createCragSubscription({
      projectRoot: root,
      machineIdFile: source,
      listTargets: () => slots,
      assertReady: (vm) => vm !== slots[2],
      fetchImpl: async (url, init) => {
        const input = JSON.parse(init.body)
        bearer ??= init.headers.authorization
        assert.equal(init.headers.authorization, bearer)
        if (url.endsWith('/redeem')) {
          assert.equal(input.redemption_code, CODE)
          if (++redeems === 1) {
            rights = signedRights(input.host_id, 1, [])
            throw new Error('lost redeem reply after authority commit')
          }
        }
        if (url.endsWith('/bind')) {
          ++bindAttempts
          if (!machineCode) {
            hostIdAtBind = input.host_id
            machineCode = input.machine_code
            slotPermit = issueSlotPermit(root, machineCode, input.host_id, { seat: 1 }).code
            rights = signedRights(input.host_id, 2, [
              { seat: 1, permit_sha256: createHash('sha256').update(slotPermit).digest('hex') },
            ])
            throw new Error('lost bind reply after authority commit')
          }
          assert.equal(input.machine_code, machineCode)
          return Response.json({ ok: true, data: { ...rights, seat: 1, slot_permit: slotPermit } })
        }
        return Response.json({ ok: true, data: rights })
      },
    })
  let subscription = connect()
  const handler = () =>
    createCragShopHandler({
      getDb: () => db,
      dataDir: root,
      publicBaseUrl: PANEL,
      json: (_, http, body) => ({ http, ...body }),
      readRawBody: (req) => req.raw,
      isActivationAdmin: (owner) => admin && owner === OTHER.panelBuyerOwner,
      subscription,
      supplier,
    })
  let handle = handler()
  const call = (actor, method, endpoint, body) => {
    const url = new URL(`${PANEL}${BASE}${endpoint}`)
    return handle(
      {
        ...actor,
        method,
        headers: {
          host: 'panel.example.test',
          origin: PANEL,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
        raw: Buffer.from(body === undefined ? '' : JSON.stringify(body)),
      },
      {},
      url,
      cragShopRoute(method, url.pathname),
    )
  }
  const due = (id) => db.prepare('UPDATE crag_shop_orders SET activation_next_at = 1 WHERE order_id = ?').run(id)
  const restart = () => {
    db.close()
    db = new DatabaseSync(dbPath)
    subscription = connect()
    handle = handler()
  }
  assert.deepEqual(
    (await call(OTHER, 'GET', '/activation-targets')).data.targets,
    slots.slice(0, 2).map(({ id }) => ({ vm_id: id })),
  )
  assert.deepEqual((await call(PERSON, 'GET', '/activation-targets')).data.targets, [])
  const input = { ...INPUT, activation_target: { vm_id: slots[0].id } }
  assert.equal((await call(PERSON, 'POST', '/orders', input)).http, 403)
  assert.equal(
    (await call(OTHER, 'POST', '/orders', { ...input, activation_target: { vm_id: slots[2].id } })).error.code,
    'shop_activation_target_unavailable',
  )
  const created = (await call(OTHER, 'POST', '/orders', input)).data
  const id = created.order_id
  assert.deepEqual(created.activation, { vm_id: slots[0].id, state: 'awaiting_fulfillment' })
  assert.equal((await call(OTHER, 'POST', '/orders', INPUT)).error.code, 'shop_request_conflict')
  assert.equal((await call(PERSON, 'GET', `/orders/${id}`)).http, 404)
  assert.equal((await call(OTHER, 'POST', `/orders/${id}/claim`, {})).error.code, 'shop_activation_pinned')
  assert.deepEqual(
    (await call(OTHER, 'GET', '/orders')).data.orders.find(({ order_id }) => order_id === manualId).activation,
    { state: 'manual' },
  )

  await Promise.all([handle.pollActivation(), handle.pollActivation()])
  assert.deepEqual(deliveryRequests.splice(0), [{ id, operation: undefined, method: 'GET' }])
  merchant.get(id).status = 'paid'
  due(id)
  await handle.pollActivation()
  assert.deepEqual(deliveryRequests.splice(0), [{ id, operation: undefined, method: 'GET' }])
  assert.equal(redeems, 0)
  merchant.get(id).status = 'fulfilled'
  due(id)
  await handle.pollActivation()
  assert.deepEqual(deliveryRequests.splice(0), [
    { id, operation: undefined, method: 'GET' },
    { id, operation: 'claim', method: 'POST' },
  ])
  assert.equal((await subscription.status()).state, 'sync_pending')
  restart()
  await subscription.recover()
  assert.equal(redeems, 1, 'generic recovery cannot launch an order-bound redeem without checking its pin')
  due(id)
  await handle.pollActivation()
  assert.equal(redeems, 2)
  assert.equal(bindAttempts, 1)
  assert.equal(checkCragLicense(root, slots[0]).ok, false)
  restart()
  due(id)
  await handle.pollActivation()
  assert.equal(redeems, 2, 'bind recovery must not redeem again')
  assert.equal(bindAttempts, 2, 'the same seat permit is fetched again')
  assert.equal(checkCragLicense(root, slots[0]).ok, true)
  assert.equal(checkCragLicense(root, slots[1]).ok, false)
  const active = (await call(OTHER, 'GET', `/orders/${id}`)).data
  assert.deepEqual(active.activation, { vm_id: slots[0].id, state: 'active' })
  assert.equal(active.status, 'fulfilled')
  for (const secret of [CODE, bearer, slotPermit, machineCode, deriveOrderReceipt(receiptKey, id)]) {
    assert.equal(JSON.stringify(active).includes(secret), false)
  }
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM crag_shop_orders').all()).includes(CODE), false)
  deliveryRequests.length = 0
  await handle.pollActivation()
  assert.deepEqual(deliveryRequests, [])

  // Pre-upgrade pins do not prove which payload was installed at checkout.
  const legacyPinOrder = (await call(OTHER, 'POST', '/orders', { ...input, request_id: 'old-pin' })).data
  const oldId = legacyPinOrder.order_id
  const noPayloadFingerprint = createHash('sha256')
    .update(JSON.stringify([hostIdAtBind, machineCode, null]))
    .digest('hex')
  db.prepare('UPDATE crag_shop_orders SET activation_fingerprint = ? WHERE order_id = ?').run(
    noPayloadFingerprint,
    oldId,
  )
  assert.equal((await call(OTHER, 'POST', `/orders/${oldId}/resume`, {})).data.order_id, oldId)
  merchant.get(oldId).status = 'fulfilled'
  deliveryRequests.length = 0
  await handle.pollActivation()
  assert.deepEqual(deliveryRequests.splice(0), [{ id: oldId, operation: undefined, method: 'GET' }])
  const paused = (await call(OTHER, 'GET', `/orders/${oldId}`)).data
  assert.equal(paused.status, 'fulfilled')
  assert.equal(paused.activation.state, 'needs_attention')
  assert.equal(redeems, 2)
  assert.equal(bindAttempts, 2)

  const other = (
    await call(OTHER, 'POST', '/orders', { ...input, request_id: 'second', activation_target: { vm_id: slots[1].id } })
  ).data
  merchant.get(other.order_id).status = 'fulfilled'
  admin = false
  await handle.pollActivation()
  assert.equal((await call(OTHER, 'GET', `/orders/${other.order_id}`)).data.activation.state, 'needs_attention')
  assert.equal((await call(OTHER, 'POST', `/orders/${other.order_id}/retry-activation`, {})).http, 403)
  admin = true
  slots[1].owner_user_id = 'new-owner'
  assert.equal(
    (await call(OTHER, 'POST', `/orders/${other.order_id}/retry-activation`, {})).data.activation.state,
    'activating',
  )
  await handle.pollActivation()
  assert.equal((await call(OTHER, 'GET', `/orders/${other.order_id}`)).data.activation.state, 'needs_attention')
  assert.equal(deliveryRequests.filter(({ operation }) => operation === 'claim').length, 0)
  assert.equal(redeems, 2)
  assert.equal(bindAttempts, 2)
  const late = (await call(OTHER, 'POST', '/orders', { ...input, request_id: 'late' })).data
  merchant.get(late.order_id).status = 'fulfilled'
  db.prepare('UPDATE crag_shop_orders SET activation_deadline = 1 WHERE order_id = ?').run(late.order_id)
  deliveryRequests.length = 0
  await handle.pollActivation()
  assert.deepEqual(deliveryRequests, [], 'expired work must not contact the supplier')
  assert.equal((await call(OTHER, 'GET', `/orders/${late.order_id}`)).data.activation.state, 'needs_attention')
  assert.deepEqual(
    deliveryRequests,
    [{ id: late.order_id, operation: undefined, method: 'GET' }],
    'an owner may still explicitly refresh a paused order whose fulfillment is unknown',
  )
  assert.equal(redeems, 2)
  assert.equal(bindAttempts, 2)
  assert.equal(checkCragLicense(root, slots[0]).ok, true)
})
