import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import {
  buyerOwner,
  createCragShopHandler,
  createGeminiCragShopHandler,
  cragShopRoute,
  GEMINI_CATALOG_CACHE_KEY,
  GEMINI_SHOP_OWNER_PREFIX,
  geminiCragShopRoute,
  sameOriginPost,
  sessionBuyerOwner,
} from '../../src/lib/admin/crag-shop.mjs'
import { createShopSupplier } from '../../src/lib/admin/crag-shop-supplier.mjs'
import { deriveOrderReceipt, loadOrderReceiptKey } from '../../src/lib/admin/crag-shop-receipt.mjs'
import { applyMigrations, createDatabase } from '../../src/lib/db/database.mjs'
import { checkCragLicense, cragTargetIds } from '../../src/lib/vm/crag-license.mjs'
import { createCragSubscription } from '../../src/lib/vm/crag-subscription.mjs'
import { cragSubscriptionPublicDirectory } from '../../src/lib/vm/crag-subscription-paths.mjs'
import { materializeCragV2 } from '../../src/lib/vm/wrap-cli-runtime.mjs'
import {
  issueHostEntitlement,
  issueSlotPermit,
  seedEncryptedPackage,
  signSubscriptionBytes,
} from '../fixtures/crag-license.mjs'

const PANEL = 'https://panel.example.test'
const SHOP = 'https://www.vm2api.org'
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
const DISPATCH_MIGRATION = new URL('060_crag_shop_order_dispatch.sql', MIGRATIONS)
const CLOSED_MIGRATION = new URL('062_crag_shop_order_closed.sql', MIGRATIONS)
const DEVICE_HOST_MIGRATION = new URL('066_crag_shop_device_host.sql', MIGRATIONS)
const ACTIVATION_ERROR_MIGRATION = new URL('067_crag_shop_activation_error.sql', MIGRATIONS)
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

    applyMigrations(db)
    assert.deepEqual(applyMigrations(db), [])
    assert.deepEqual(
      db
        .prepare("SELECT name FROM schema_migrations WHERE version BETWEEN '055' AND '058' ORDER BY version")
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
    assert.equal(saved.dispatch_state, 'submitted')
    assert.equal(saved.redemption_sha256, null)
    assert.equal(saved.activation_error_code, null)
    assert.equal(saved.activation_error_recovery, null)
    assert.equal(saved.activation_request_id, null)
  }
})

function order(id, status = 'pending') {
  return { ...PLAN, order_id: id, status, payment_method: 'alipay', created_at: 1_800_000_000, redemption_code: CODE }
}

const LEGACY_SHOP = 'https://crag.fkcodex.com'

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
  // Recovery re-binds an order to the browser asking for it, which only makes sense on the
  // anonymous side. A panel buyer's orders are owned by the account, so exposing it there
  // would let one signed-in buyer pull another's order across accounts.
  assert.equal(cragShopRoute('POST', `${BASE}/orders/123/recover`), null)
  assert.equal(cragShopRoute('POST', `${BASE}/device/orders/123/recover`), 'recover')
  assert.equal(cragShopRoute('GET', `${BASE}/device/orders/123/recover`), null)
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
  reply = {
    ...order(id),
    url: ACTION,
    data: {
      ...fields(id),
      notify_url: `${LEGACY_SHOP}/shop/epay/notify`,
      return_url: `${LEGACY_SHOP}/shop/return`,
    },
  }
  assert.equal((await supplier.create(row, PROOF)).form.data.notify_url, `${LEGACY_SHOP}/shop/epay/notify`)
  reply = {
    ...order(id),
    url: ACTION,
    data: {
      ...fields(id),
      notify_url: `${LEGACY_SHOP}/shop/epay/notify`,
      return_url: `${SHOP}/shop/return`,
    },
  }
  await assert.rejects(supplier.create(row, PROOF), { code: 'shop_invalid_reply' })

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

  // The failure log is the only record a stalled checkout leaves behind, so what it
  // carries is load-bearing in both directions: enough to tell the faults apart, and
  // nothing that works as a credential. Checked here because this test already holds
  // all three secrets at once — the pilot token, the receipt, and an order id.
  const warnings = []
  const warn = console.warn
  console.warn = (line) => warnings.push(line)
  try {
    // A directory makes readPilotToken throw before any request goes out, which is
    // the shape of every fault that never reaches the supplier.
    process.env[PILOT_TOKEN_FILE_ENV] = root
    await assert.rejects(supplier.resume(row, PROOF, { allowPilot: true }), unavailable)
    // And one that does reach it: with a usable pilot token, a reply echoing that
    // token is refused inside the transport, so the log sees a real status.
    fs.writeFileSync(file, token, { mode: 0o600 })
    process.env[PILOT_TOKEN_FILE_ENV] = file
    plansReply = { ...catalog, plans: [{ ...PLAN, sku: token }] }
    await assert.rejects(supplier.plans({ allowPilot: true }), { code: 'shop_invalid_reply' })
  } finally {
    console.warn = warn
  }
  assert.deepEqual(
    warnings.map((line) => JSON.parse(line)),
    [
      {
        event: 'crag-shop-supplier',
        operation: 'resume',
        // Truncated: a whole order id in a log is a credential, since the Authority's
        // claim-by-order accepts one as grounds for moving a subscription.
        path: `/shop/orders/${id.slice(0, 8)}~/resume`,
        // Zero means no response arrived, which is what separates "the supplier
        // refused" from "we never reached it".
        status: 0,
        code: 'shop_unavailable',
        cause: 'Error',
      },
      {
        event: 'crag-shop-supplier',
        operation: 'plans',
        path: '/shop/plans',
        status: 200,
        code: 'shop_invalid_reply',
      },
    ],
  )
  const logged = warnings.join('\n')
  assert.ok(!logged.includes(id), 'a usable order id must not reach the log')
  for (const secret of [token, PROOF]) assert.ok(!logged.includes(secret), 'no credential may reach the log')
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
  const listed = (await call(PERSON, 'GET', '/orders')).data.orders[0]
  assert.equal(listed.status, 'reserved')
  // A create that never returned a checkout form leaves an orphaned reservation. The
  // buyer never received a payment link, so it is offered as cancelable even while the
  // supplier is unavailable. The replay below still needs this reservation, so only the
  // offer is asserted here; `fulfilled` refusing a cancel is asserted further down.
  assert.equal(listed.cancelable, true)
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
  assert.equal((await call(OTHER, 'POST', `/orders/${id}/cancel`)).http, 404)
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
  assert.equal((await call(PERSON, 'POST', `/orders/${id}/cancel`, {})).http, 409)
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

test('cancels an unsent reservation even while price verification is in flight, without reaching checkout', {
  timeout: 5000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-shop-cancel-'))
  const db = createDatabase({ dbPath: path.join(root, 'kin.db') })
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const began = Promise.withResolvers()
  const quote = Promise.withResolvers()
  const handler = createCragShopHandler({
    dataDir: root,
    publicBaseUrl: PANEL,
    getDb: () => db,
    json: (_, http, body) => ({ http, ...body }),
    readRawBody: (req) => req.raw,
    supplier: {
      quote: () => {
        began.resolve()
        return quote.promise
      },
      create: () => assert.fail('cancelled orders must not reach the supplier'),
      status: () => assert.fail('unsent orders must not query the supplier'),
    },
  })
  const call = (method, endpoint, body = {}, actor = PERSON) => {
    const url = new URL(`${PANEL}${BASE}${endpoint}`)
    return handler(
      {
        ...actor,
        method,
        raw: Buffer.from(JSON.stringify(body)),
        headers: {
          host: 'panel.example.test',
          origin: PANEL,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
      },
      {},
      url,
      cragShopRoute(method, url.pathname),
    )
  }
  const input = { ...INPUT, expected_amount_minor: PLAN.amount_minor }
  const creating = call('POST', '/orders', input)
  await began.promise
  const {
    data: {
      orders: [reserved],
    },
  } = await call('GET', '/orders')
  assert.equal(reserved.status, 'reserved')
  assert.equal(reserved.cancelable, true)
  const endpoint = `/orders/${reserved.order_id}`
  assert.deepEqual((await call('GET', endpoint)).data, reserved)
  assert.equal((await call('POST', `${endpoint}/cancel`, {}, OTHER)).http, 404)
  const cancelled = await call('POST', `${endpoint}/cancel`)
  assert.equal(cancelled.data.status, 'cancelled')
  assert.equal(cancelled.data.cancelable, undefined)
  assert.equal(cancelled.data.activation, undefined)
  quote.resolve(PLAN)
  assert.deepEqual(await creating, cancelled)
  assert.deepEqual(await call('POST', '/orders', input), cancelled)
  assert.deepEqual(await call('POST', `${endpoint}/cancel`), cancelled)
  assert.deepEqual(await call('GET', endpoint), cancelled)
  assert.equal((await call('POST', `${endpoint}/resume`)).error.code, 'shop_order_cancelled')
})

test('device checkout skips panel login, scopes orders to browser and host, and applies without exposing the code', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-device-shop-'))
  const db = createDatabase({ dbPath: path.join(root, 'kin.db') })
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const deviceId = 'a'.repeat(64)
  let host = deviceId
  let created = 0
  let applied = 0
  let confirmed = false
  let status = 'pending'
  const handler = createPanelHandler({
    cfg: { base_url: PANEL },
    requireAuth() {
      assert.fail('device checkout must not invoke panel auth')
    },
    handleCragShop: createCragShopHandler({
      getDb: () => db,
      dataDir: root,
      publicBaseUrl: PANEL,
      json: (_, http, body) => ({ http, ...body }),
      readRawBody: (req) => req.raw,
      subscription: {
        purchaseDeviceId() {
          if (host instanceof Error) throw host
          return host
        },
        async redeemDeviceOrder(expectedHost, code) {
          assert.equal(expectedHost, deviceId)
          assert.equal(code, CODE)
          applied++
          confirmed = true
        },
        isRedemptionApplied(expectedHost, digest) {
          assert.equal(expectedHost, deviceId)
          assert.equal(digest, createHash('sha256').update(CODE).digest('hex'))
          return confirmed
        },
      },
      supplier: {
        async plans(options) {
          assert.equal(options.allowPilot, false)
          return { plans: [PLAN], payment_methods: ['alipay'] }
        },
        async quote(_input, proof, options) {
          assert.equal(proof, undefined)
          assert.equal(options.allowPilot, false)
          return PLAN
        },
        async create(row, _receipt, _proof, _purchase, options) {
          assert.equal(options.allowPilot, false)
          created++
          return { order: order(row.order_id) }
        },
        async resume(row, _receipt, options) {
          assert.equal(options.allowPilot, false)
          return { order: order(row.order_id) }
        },
        async status(row) {
          return order(row.order_id, status)
        },
        async claim(row) {
          return { order_id: row.order_id, redemption_code: CODE }
        },
      },
    }),
  })
  let cookie
  async function call(method, endpoint, body, headers = {}, sendCookie = true) {
    const url = new URL(`${PANEL}${BASE}/device${endpoint}`)
    const req = {
      method,
      raw: Buffer.from(body === undefined ? '' : JSON.stringify(body)),
      headers: {
        host: 'panel.example.test',
        origin: PANEL,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        ...(sendCookie && cookie ? { cookie } : {}),
        ...headers,
      },
    }
    return handler(
      req,
      {
        setHeader(name, value) {
          if (name !== 'Set-Cookie') return
          assert.match(value, /; HttpOnly; SameSite=Strict/)
          cookie = value.split(';')[0]
        },
      },
      url,
    )
  }
  const input = { ...INPUT, expected_amount_minor: PLAN.amount_minor }
  assert.equal((await call('GET', '/plans')).http, 200)
  assert.equal((await call('POST', '/orders', { ...input, host_id: deviceId })).http, 400)
  assert.equal((await call('POST', '/orders', { ...input, sku: 'renewal' })).http, 403)
  assert.equal((await call('POST', '/orders', { ...input, activation_target: { vm_id: 'vm-ready' } })).http, 403)
  assert.equal((await call('POST', '/orders', input, { origin: 'https://elsewhere.example.test' })).http, 403)
  assert.equal((await call('POST', '/orders', input, {}, false)).http, 409)
  assert.equal((await call('POST', '/quote', { sku: PLAN.sku })).http, 200)
  host = undefined
  assert.equal((await call('POST', '/orders', input)).error.code, 'shop_device_unavailable')
  host = Object.assign(new Error('private details'), { code: 'crag_subscription_host_identity_changed' })
  const changed = await call('POST', '/orders', input)
  assert.equal(changed.error.code, 'shop_host_identity_changed')
  assert.equal(JSON.stringify(changed).includes('private details'), false)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM crag_shop_orders').get().count, 0)
  assert.equal(created, 0)
  host = deviceId
  const first = await call('POST', '/orders', input)
  assert.equal(first.http, 200)
  const id = first.data.order_id
  assert.equal((await call('POST', '/orders', input)).data.order_id, id)
  assert.equal(created, 1)
  assert.equal((await call('GET', '/orders')).data.orders.length, 1)
  assert.equal((await call('GET', '/orders', undefined, {}, false)).data.orders.length, 0)
  host = 'b'.repeat(64)
  assert.equal((await call('GET', `/orders/${id}`)).http, 404)
  assert.equal((await call('POST', `/orders/${id}/apply`, {})).http, 404)
  host = deviceId
  assert.equal((await call('POST', `/orders/${id}/apply`, {})).http, 409)
  status = 'fulfilled'
  assert.equal((await call('GET', `/orders/${id}`)).data.activation.state, 'ready_to_apply')
  // Exporting the voucher is now an explicit, deliberate action on the device side
  // too: withholding it left a device buyer with no way to move a subscription whose
  // order id the Authority never recorded, and the entitlement is theirs. It still
  // needs the checkout cookie that owns the order.
  const exported = await call('POST', `/orders/${id}/claim`, {})
  assert.equal(exported.data.redemption_code, CODE)
  // Without the checkout cookie there is nothing to prove ownership with, so this
  // reads exactly like a missing order rather than admitting the id exists. Unlike
  // 'recover', which mints an identity to re-bind to, exporting needs the cookie
  // that already owns the order.
  assert.equal((await call('POST', `/orders/${id}/claim`, {}, {}, false)).http, 404)
  const activation = await call('POST', `/orders/${id}/apply`, {})
  assert.equal(activation.data.activation.state, 'active')
  // Applying still never carries the code: only the explicit export above does.
  assert.equal(JSON.stringify(activation).includes(CODE), false)
  assert.equal((await call('POST', `/orders/${id}/apply`, {})).data.activation.state, 'active')
  assert.equal(applied, 1)
})

test('a device order outlives its checkout cookie and is recoverable by its order id alone', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-device-reclaim-'))
  const db = createDatabase({ dbPath: path.join(root, 'kin.db') })
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const deviceId = 'a'.repeat(64)
  const host = deviceId
  let status = 'pending'
  let confirmed = false
  let applied = 0
  const handler = createPanelHandler({
    cfg: { base_url: PANEL },
    requireAuth() {
      assert.fail('device checkout must not invoke panel auth')
    },
    handleCragShop: createCragShopHandler({
      getDb: () => db,
      dataDir: root,
      publicBaseUrl: PANEL,
      json: (_, http, body) => ({ http, ...body }),
      readRawBody: (req) => req.raw,
      subscription: {
        purchaseDeviceId: () => host,
        async redeemDeviceOrder() {
          applied++
          confirmed = true
        },
        isRedemptionApplied: () => confirmed,
      },
      supplier: {
        async plans() {
          return { plans: [PLAN], payment_methods: ['alipay'] }
        },
        async quote() {
          return PLAN
        },
        async create(row) {
          return { order: order(row.order_id) }
        },
        async resume(row) {
          return { order: order(row.order_id) }
        },
        async status(row) {
          return order(row.order_id, status)
        },
        async claim(row) {
          return { order_id: row.order_id, redemption_code: CODE }
        },
      },
    }),
  })
  let cookie
  async function call(method, endpoint, body, sendCookie = true) {
    const url = new URL(`${PANEL}${BASE}/device${endpoint}`)
    const req = {
      method,
      raw: Buffer.from(body === undefined ? '' : JSON.stringify(body)),
      headers: {
        host: 'panel.example.test',
        origin: PANEL,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        ...(sendCookie && cookie ? { cookie } : {}),
      },
    }
    return handler(
      req,
      {
        setHeader(name, value) {
          if (name === 'Set-Cookie') cookie = value.split(';')[0]
        },
      },
      url,
    )
  }
  const deviceHost = (orderId) =>
    db.prepare('SELECT device_host FROM crag_shop_orders WHERE order_id = ?').get(orderId).device_host

  await call('GET', '/plans')
  const id = (await call('POST', '/orders', { ...INPUT, expected_amount_minor: PLAN.amount_minor })).data.order_id
  assert.equal((await call('GET', '/orders')).data.orders.length, 1)
  // Recorded at purchase as provenance. It is this installation's own machine id, so it is
  // the same value for every device order in this database and cannot tell two buyers
  // apart — what distinguishes them is the cookie token, already inside `owner`.
  assert.equal(deviceHost(id), deviceId)

  // Losing the cookie is what orphaned a paid order. The listing goes empty and, because
  // applying also matches on owner, delivery became impossible rather than merely hidden.
  const lost = cookie
  cookie = undefined
  assert.equal((await call('POST', `/orders/${id}/recover`, {})).error.code, 'shop_device_checkout_required')
  await call('GET', '/plans')
  assert.notEqual(cookie, lost)
  assert.equal((await call('GET', '/orders')).data.orders.length, 0)

  // A row carrying some other host is still recoverable, and the column is refreshed to
  // this machine. Since `device_host` is one constant per installation, a mismatch never
  // means another buyer — it means this gateway's own identity changed, and that is the
  // moment every device order's owner digest stops matching at once, leaving recovery as
  // the only way back. Refusing it there turned a recoverable order into a permanently
  // undeliverable one, which is the failure this route exists to prevent.
  db.prepare('UPDATE crag_shop_orders SET device_host = ? WHERE order_id = ?').run('b'.repeat(64), id)

  assert.equal((await call('POST', `/orders/${id}/recover`, {})).data.order_id, id)
  assert.equal(deviceHost(id), deviceId)
  assert.equal((await call('GET', '/orders')).data.orders.length, 1)
  // Recovery has to restore delivery, not just visibility.
  status = 'fulfilled'
  assert.equal((await call('POST', `/orders/${id}/apply`, {})).data.activation.state, 'active')
  assert.equal(applied, 1)
  assert.equal(JSON.stringify(await call('GET', '/orders')).includes(CODE), false)

  // A panel buyer's order belongs to their account. An anonymous caller must not be able
  // to pull it out, and must not learn that the id exists either.
  const panelOrder = randomUUID()
  db.prepare(`INSERT INTO crag_shop_orders
    (order_id, owner, request_id, sku, payment_method, reserved_at, status, created_at, term, amount_minor, slot_limit)
    VALUES (?, 'panel:alice-id', 'account-order', 'quarter', 'alipay', 1, 'fulfilled', 1, '3m', 59900, 10)`).run(
    panelOrder,
  )
  const refused = await call('POST', `/orders/${panelOrder}/recover`, {})
  assert.equal(refused.http, 404)
  assert.equal(refused.error.code, (await call('POST', `/orders/${randomUUID()}/recover`, {})).error.code)
  assert.equal(
    db.prepare('SELECT owner FROM crag_shop_orders WHERE order_id = ?').get(panelOrder).owner,
    'panel:alice-id',
  )

  // Orders predating device_host carry NULL. They are recovered on the order id alone —
  // the only proof that still exists for them — and the host is recorded at that point.
  const legacyOrder = randomUUID()
  db.prepare(`INSERT INTO crag_shop_orders
    (order_id, owner, request_id, sku, payment_method, reserved_at, status, created_at, term, amount_minor, slot_limit)
    VALUES (?, 'device:forgotten-browser', 'legacy-order', 'quarter', 'alipay', 1, 'fulfilled', 1, '3m', 59900, 10)`).run(
    legacyOrder,
  )
  assert.equal(deviceHost(legacyOrder), null)
  assert.equal((await call('POST', `/orders/${legacyOrder}/recover`, {})).data.order_id, legacyOrder)
  assert.equal(deviceHost(legacyOrder), deviceId)
  assert.equal((await call('GET', '/orders')).data.orders.length, 2)
})

test('device order recovery projects only a matching durable redemption receipt, including after restart', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-device-recovery-'))
  const dbPath = path.join(root, 'kin.db')
  let db = createDatabase({ dbPath })
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const hostId = 'a'.repeat(64)
  const token = Buffer.alloc(32, 17).toString('base64url')
  const owner = `device:${createHash('sha256').update(`${hostId}:${token}`).digest('hex')}`
  loadOrderReceiptKey(root, () => false)
  const id = randomUUID()
  const otherId = randomUUID()
  const insert = db.prepare(`INSERT INTO crag_shop_orders
    (order_id, owner, request_id, sku, payment_method, reserved_at, status, created_at, term, amount_minor, slot_limit)
    VALUES (?, ?, ?, 'quarter', 'alipay', 1, 'fulfilled', 1800000000, '3m', 59900, 10)`)
  insert.run(id, owner, 'paid-original')
  insert.run(otherId, owner, 'different-order')
  const digest = createHash('sha256').update(CODE).digest('hex')
  let applied = 0
  let proof = false
  let claimed = 0
  let claimResponse
  let errorCode = 'crag_subscription_host_package_changed'
  let receiptError
  const requestId = randomUUID()
  const makeHandler = () =>
    createCragShopHandler({
      getDb: () => db,
      dataDir: root,
      publicBaseUrl: PANEL,
      json: (_, http, body) => ({ http, ...body }),
      readRawBody: (req) => req.raw,
      subscription: {
        purchaseDeviceId: () => hostId,
        isRedemptionApplied(expectedHost, actualDigest) {
          assert.equal(expectedHost, hostId)
          if (receiptError && actualDigest === digest) throw Object.assign(new Error('damaged'), { code: receiptError })
          return proof && actualDigest === digest
        },
        async redeemDeviceOrder(expectedHost, code) {
          assert.equal(expectedHost, hostId)
          assert.equal(code, CODE)
          assert.equal(
            db.prepare('SELECT redemption_sha256 FROM crag_shop_orders WHERE order_id = ?').get(id).redemption_sha256,
            digest,
          )
          applied++
          throw Object.assign(new Error(`private: ${CODE} /opt/private`), {
            code: errorCode,
            authorityRequestId: requestId,
          })
        },
      },
      supplier: {
        async claim(row) {
          claimed++
          if (claimResponse) return claimResponse(row)
          return { order_id: row.order_id, redemption_code: CODE }
        },
        async status(row) {
          return order(row.order_id, 'fulfilled')
        },
      },
    })
  let handler = makeHandler()
  const call = (method, suffix) => {
    const url = new URL(`${PANEL}${BASE}/device${suffix}`)
    return handler(
      {
        method,
        raw: Buffer.from('{}'),
        headers: {
          host: 'panel.example.test',
          origin: PANEL,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
          cookie: `kin_crag_device_checkout=${token}`,
        },
      },
      { setHeader() {} },
      url,
      cragShopRoute(method, url.pathname),
    )
  }
  const failed = await call('POST', `/orders/${id}/apply`)
  assert.equal(failed.http, 409)
  assert.equal(failed.error.code, errorCode)
  assert.equal(failed.error.details.authority_request_id, requestId)
  assert.equal(JSON.stringify(failed).includes(CODE), false)
  assert.equal(JSON.stringify(failed).includes('/opt/private'), false)
  assert.equal((await call('GET', `/orders/${id}`)).data.activation.state, 'ready_to_apply')
  errorCode = 'crag_subscription_authority_unavailable'
  const uncertain = await call('POST', `/orders/${id}/apply`)
  assert.equal(uncertain.http, 503)
  assert.equal(uncertain.error.code, errorCode)
  assert.equal(
    (await call('GET', '/orders')).data.orders.every((o) => o.activation.state === 'ready_to_apply'),
    true,
  )

  // The administrator finishes the same voucher via subscription recovery, then
  // the process exits before the shop gets a chance to project that confirmation.
  proof = true
  db.close()
  db = createDatabase({ dbPath })
  handler = makeHandler()
  assert.equal((await call('GET', `/orders/${id}`)).data.activation.state, 'active')
  assert.equal((await call('POST', `/orders/${id}/apply`)).data.activation.state, 'active')
  const orders = (await call('GET', '/orders')).data.orders
  assert.equal(orders.find((o) => o.order_id === id).activation.state, 'active')
  assert.equal(orders.find((o) => o.order_id === otherId).activation.state, 'ready_to_apply')
  assert.equal(applied, 2)
  assert.equal(claimed, 2)
  assert.equal(JSON.stringify(orders).includes(digest), false)
  assert.equal(JSON.stringify(orders).includes(CODE), false)
  // Listing also repairs a lost shop projection, without contacting the supplier.
  db.prepare("UPDATE crag_shop_orders SET activation_phase = 'waiting' WHERE order_id = ?").run(id)
  assert.equal((await call('GET', '/orders')).data.orders.find((o) => o.order_id === id).activation.state, 'active')

  // One order's unverifiable receipt must not hide the rest of the list. The listing
  // keeps that row's stored state, the order's own route still reports the reason,
  // and a repaired receipt converges again without another redemption.
  db.prepare("UPDATE crag_shop_orders SET activation_phase = 'waiting' WHERE order_id = ?").run(id)
  receiptError = 'crag_subscription_invalid_redemption_receipt'
  const tolerated = (await call('GET', '/orders')).data.orders
  assert.equal(tolerated.length, 2)
  assert.equal(tolerated.find((o) => o.order_id === id).activation.state, 'ready_to_apply')
  assert.equal(tolerated.find((o) => o.order_id === otherId).activation.state, 'ready_to_apply')
  const damaged = await call('GET', `/orders/${id}`)
  assert.equal(damaged.http, 409)
  assert.equal(damaged.error.code, 'crag_subscription_invalid_redemption_receipt')
  receiptError = undefined
  assert.equal((await call('GET', '/orders')).data.orders.find((o) => o.order_id === id).activation.state, 'active')

  // Two requests read the same unassociated row before either claim completes.
  // A changed supplier voucher must not bypass the atomic digest association.
  proof = false
  db.prepare(
    "UPDATE crag_shop_orders SET activation_phase = 'waiting', redemption_sha256 = NULL WHERE order_id = ?",
  ).run(id)
  const claims = []
  let bothEntered
  const entered = new Promise((resolve) => {
    bothEntered = resolve
  })
  claimResponse = (row) =>
    new Promise((resolve) => {
      claims.push((code) => resolve({ order_id: row.order_id, redemption_code: code }))
      if (claims.length === 2) bothEntered()
    })
  const first = call('POST', `/orders/${id}/apply`)
  const second = call('POST', `/orders/${id}/apply`)
  await entered
  claims[0](CODE)
  assert.equal((await first).error.code, errorCode)
  claims[1](`CRAGR1.${Buffer.alloc(32, 43).toString('base64url')}`)
  const conflicting = await second
  assert.equal(conflicting.http, 409)
  assert.equal(conflicting.error.code, 'shop_redemption_changed')
  assert.equal(applied, 3)
  assert.equal(
    db.prepare('SELECT redemption_sha256 FROM crag_shop_orders WHERE order_id = ?').get(id).redemption_sha256,
    digest,
  )

  // A package key the Authority no longer offers, and a mismatched issuer, are
  // actionable reasons of their own: never the generic "retry the same order".
  claimResponse = undefined
  for (const code of ['payload_key_unknown', 'issuer_mismatch']) {
    errorCode = code
    const rejected = await call('POST', `/orders/${id}/apply`)
    assert.equal(rejected.http, 409)
    assert.equal(rejected.error.code, code)
    assert.notEqual(rejected.error.code, 'shop_device_apply_failed')
    assert.equal(JSON.stringify(rejected).includes(CODE), false)
  }
  assert.equal(applied, 5)
})

test('device order package recovery converges through subscription recovery and a read-only order refresh', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-device-integrated-'))
  const db = createDatabase({ dbPath: path.join(root, 'kin.db') })
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const source = path.join(root, 'host-machine-id')
  fs.writeFileSync(source, randomBytes(16).toString('hex'), { mode: 0o600 })
  fs.mkdirSync(path.dirname(path.dirname(cragSubscriptionPublicDirectory(root))), { recursive: true })
  seedEncryptedPackage(root)
  const token = Buffer.alloc(32, 19).toString('base64url')
  let rejectRedeem = true
  let redeemCalls = 0
  let rights
  const connect = () =>
    createCragSubscription({
      projectRoot: root,
      machineIdFile: source,
      listTargets: () => [],
      fetchImpl: async (url, { body }) => {
        const input = JSON.parse(body)
        if (url.endsWith('/redeem')) {
          redeemCalls++
          assert.equal(input.redemption_code, CODE)
          if (rejectRedeem) throw new Error('transport interrupted before commit')
          rights ??= issueHostEntitlement(root, input.host_id, { slot_limit: 1 })
        }
        if (!rights) return Response.json({ ok: false, error: { code: 'not_found' } }, { status: 404 })
        return Response.json({ ok: true, data: { entitlement: rights.code, ...rights.claims, used_slots: 0 } })
      },
    })
  let subscription = connect()
  const hostId = subscription.purchaseDeviceId()
  const owner = `device:${createHash('sha256').update(`${hostId}:${token}`).digest('hex')}`
  loadOrderReceiptKey(root, () => false)
  const id = randomUUID()
  db.prepare(`INSERT INTO crag_shop_orders
    (order_id, owner, request_id, sku, payment_method, reserved_at, status, created_at, term, amount_minor, slot_limit)
    VALUES (?, ?, 'integrated', 'quarter', 'alipay', 1, 'fulfilled', 1800000000, '3m', 59900, 10)`).run(id, owner)
  const handler = () =>
    createCragShopHandler({
      getDb: () => db,
      dataDir: root,
      publicBaseUrl: PANEL,
      json: (_, http, body) => ({ http, ...body }),
      readRawBody: (req) => req.raw,
      subscription,
      supplier: {
        claim: async (row) => ({ order_id: row.order_id, redemption_code: CODE }),
        status: async (row) => order(row.order_id, 'fulfilled'),
      },
    })
  const call = async (method, suffix) => {
    const url = new URL(`${PANEL}${BASE}/device/orders/${id}${suffix}`)
    return handler()(
      {
        method,
        raw: Buffer.from('{}'),
        headers: {
          host: 'panel.example.test',
          origin: PANEL,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
          cookie: `kin_crag_device_checkout=${token}`,
        },
      },
      { setHeader() {} },
      url,
      cragShopRoute(method, url.pathname),
    )
  }
  assert.equal((await call('POST', '/apply')).error.code, 'crag_subscription_authority_unavailable')
  seedEncryptedPackage(root, { payloadKey: randomBytes(32) })
  assert.equal((await call('POST', '/apply')).error.code, 'crag_subscription_host_package_changed')
  assert.equal(redeemCalls, 1)
  rejectRedeem = false
  await subscription.recover({ useCurrentPackage: true })
  // A fresh process has no in-memory knowledge of the completed recovery.
  subscription = connect()
  const refreshed = await call('GET', '')
  assert.equal(refreshed.http, 200)
  assert.equal(refreshed.data.activation.state, 'active')
  assert.equal((await call('POST', '/apply')).data.activation.state, 'active')
  assert.equal(redeemCalls, 2)
  assert.equal((await subscription.status()).slot_limit, 1)
  assert.equal(JSON.stringify(refreshed).includes(CODE), false)
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
  db.exec(fs.readFileSync(DISPATCH_MIGRATION, 'utf8'))
  db.exec(fs.readFileSync(CLOSED_MIGRATION, 'utf8'))
  db.exec(fs.readFileSync(DEVICE_HOST_MIGRATION, 'utf8'))
  db.exec(fs.readFileSync(ACTIVATION_ERROR_MIGRATION, 'utf8'))
  // The legacy row normally already has a receipt key from its original checkout.
  const receiptKey = loadOrderReceiptKey(root, () => false)
  const publicDir = cragSubscriptionPublicDirectory(root)
  fs.mkdirSync(path.dirname(path.dirname(publicDir)), { recursive: true })
  const source = path.join(root, 'host-machine-id')
  fs.writeFileSync(source, randomBytes(16).toString('hex'), { mode: 0o600 })
  seedEncryptedPackage(root)
  const slots = ['legacy-local_ready', 'vm-other', 'vm-stopped'].map((id) => ({
    id,
    dataplane: 'crag',
    crag_kernel_version: 'v2',
  }))
  for (const vm of slots) {
    const dir = path.join(root, 'vms', vm.id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'machine-id'), randomBytes(16).toString('hex'))
  }
  assert.equal(materializeCragV2(root, slots[0], { select: false }).ok, true)
  const { payloadKeyId: pinnedPayload, issuerId: pinnedIssuer } = cragTargetIds(root, slots[0])
  fs.mkdirSync(path.join(root, 'deploy'))
  fs.writeFileSync(
    path.join(root, 'deploy/payload.json'),
    JSON.stringify({
      crag_authorization: { payload_key_id: pinnedPayload, issuer_public_key_id: pinnedIssuer },
    }),
  )
  // Refreshing the download cache must not invalidate the installed target's unpaid order.
  const refreshCache = () => {
    seedEncryptedPackage(root, { payloadKey: randomBytes(32) })
    assert.notEqual(cragTargetIds(root).payloadKeyId, pinnedPayload)
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
          assert.equal(input.payload_key_id, pinnedPayload)
          assert.equal(input.issuer_public_key_id, pinnedIssuer)
          if (++redeems === 1) {
            rights = signedRights(input.host_id, 1, [])
            throw new Error('lost redeem reply after authority commit')
          }
        }
        if (url.endsWith('/bind')) {
          assert.equal(input.payload_key_id, pinnedPayload)
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
  for (const vm_id of ['active', '../legacy-local_ready', 'a'.repeat(132)]) {
    const rejected = await call(OTHER, 'POST', '/orders', { ...input, activation_target: { vm_id } })
    assert.equal(rejected.error.code, 'shop_invalid_request')
  }
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
  refreshCache()
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

test('an unpaid checkout link closes once its payment window passes, unless the supplier took the money', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-shop-expiry-'))
  const db = createDatabase({ dbPath: path.join(root, 'kin.db') })
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  let supplied = 'pending'
  let reads = 0
  const shop = createCragShopHandler({
    getDb: () => db,
    dataDir: root,
    publicBaseUrl: PANEL,
    json: (_, http, body) => ({ http, ...body }),
    readRawBody: (req) => req.raw,
    subscription: {},
    supplier: {
      async status(row) {
        reads++
        return order(row.order_id, supplied)
      },
    },
  })
  const now = Math.floor(Date.now() / 1000)
  // The receipt key is only created while no order exists yet: a table with orders but
  // no key means the key was lost, and minting a new one would strand their receipts.
  // These rows are inserted straight into the table, so seed the key before them.
  loadOrderReceiptKey(root, () => false)
  // A reserved row carries no commerce columns; migration 057 requires them to be NULL.
  const reserve = (id, age) =>
    db
      .prepare(`INSERT INTO crag_shop_orders
        (order_id, owner, request_id, sku, payment_method, reserved_at, status, dispatch_state)
        VALUES (?, ?, ?, 'quarter', 'alipay', ?, 'reserved', 'submitted')`)
      .run(id, PERSON.panelBuyerOwner, `req-${id}`, now - age)
  const pend = (id, age) =>
    db
      .prepare(`INSERT INTO crag_shop_orders
        (order_id, owner, request_id, sku, payment_method, reserved_at, status, dispatch_state,
         created_at, term, amount_minor, slot_limit)
        VALUES (?, ?, ?, 'quarter', 'alipay', ?, 'pending', 'submitted', 1800000000, '3m', 59900, 10)`)
      .run(id, PERSON.panelBuyerOwner, `req-${id}`, now - age)
  const stored = (id) => db.prepare('SELECT closed_at, status FROM crag_shop_orders WHERE order_id = ?').get(id)

  const fresh = randomUUID()
  pend(fresh, 5 * 60)
  await shop.pollOrderExpiry()
  assert.equal(stored(fresh).closed_at, null, 'a link inside its payment window is left alone')
  assert.equal(reads, 0, 'the supplier is not consulted for an order that cannot have expired yet')

  const stale = randomUUID()
  pend(stale, 31 * 60)
  await shop.pollOrderExpiry()
  assert.equal(reads, 1, 'a live payment link is re-read before it is closed')
  assert.equal(typeof stored(stale).closed_at, 'number')

  // A payment that landed late keeps the order: reflectOrder moves it to paid, which
  // also drops it out of the expiry scan.
  const paid = randomUUID()
  supplied = 'paid'
  pend(paid, 31 * 60)
  await shop.pollOrderExpiry()
  assert.equal(stored(paid).closed_at, null)
  assert.equal(stored(paid).status, 'paid')

  // No checkout form ever reached this buyer, so it closes without a supplier read.
  const orphan = randomUUID()
  reserve(orphan, 40 * 60)
  const before = reads
  await shop.pollOrderExpiry()
  assert.equal(typeof stored(orphan).closed_at, 'number')
  assert.equal(reads, before)
})

test('migration 067 enforces sanitized activation failure columns and pollActivation stops on terminal auth_forbidden without leaking secrets', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-shop-auth-forbidden-'))
  const db = createDatabase({ dbPath: path.join(root, 'kin.db') })
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  loadOrderReceiptKey(root, () => false)

  // Verify SQLite CHECK constraints directly on migration 067 columns.
  const checkOrderId = randomUUID()
  db.prepare(`INSERT INTO crag_shop_orders
    (order_id, owner, request_id, sku, payment_method, reserved_at, status, dispatch_state,
     created_at, term, amount_minor, slot_limit, activation_vm_id, activation_fingerprint)
    VALUES (?, ?, 'check-row', 'quarter', 'alipay', 1, 'fulfilled', 'submitted',
            1800000000, '3m', 59900, 10, 'vm-check', ?)`).run(checkOrderId, OTHER.panelBuyerOwner, 'f'.repeat(64))

  for (const badCode of ['', 'a', '9bad', 'Auth_forbidden', CODE, 'auth-forbidden', 'bad\ncode', 'a'.repeat(65)]) {
    assert.throws(() =>
      db.prepare('UPDATE crag_shop_orders SET activation_error_code = ? WHERE order_id = ?').run(badCode, checkOrderId),
    )
  }
  for (const badRecovery of ['', 'unavailable', 'unknown', CODE]) {
    assert.throws(() =>
      db
        .prepare('UPDATE crag_shop_orders SET activation_error_recovery = ? WHERE order_id = ?')
        .run(badRecovery, checkOrderId),
    )
  }
  for (const badRequestId of [
    '',
    'not-a-uuid',
    CODE,
    '6945109e-80be-1d23-9793-68ba195765ce',
    '6945109e-80be-4d23-0793-68ba195765ce',
    '6945109e-80be-4d23-9793-68ba195765ce\n',
  ]) {
    assert.throws(() =>
      db
        .prepare('UPDATE crag_shop_orders SET activation_request_id = ? WHERE order_id = ?')
        .run(badRequestId, checkOrderId),
    )
  }
  const upperUuid = '6945109E-80BE-4D23-9793-68BA195765CE'
  db.prepare(`UPDATE crag_shop_orders
    SET activation_error_code = 'auth_forbidden',
        activation_error_recovery = 'not_activated',
        activation_request_id = ?
    WHERE order_id = ?`).run(upperUuid, checkOrderId)
  db.prepare('DELETE FROM crag_shop_orders WHERE order_id = ?').run(checkOrderId)

  const fingerprint = 'c'.repeat(64)
  const bearerSecret = 'secret_bearer_token_43_chars_long_abcdef123'
  let activateBehavior = () => {
    throw new Error('unexpected activateOrder call')
  }
  let activateCalls = 0
  let claimCalls = 0
  let statusCalls = 0
  const remoteStatus = new Map()

  const makeShop = (activationEnabled = true) =>
    createCragShopHandler({
      getDb: () => db,
      dataDir: root,
      publicBaseUrl: PANEL,
      json: (_, http, body) => ({ http, ...body }),
      readRawBody: (req) => req.raw,
      isActivationAdmin: (owner) => owner === OTHER.panelBuyerOwner,
      activationEnabled,
      subscription: {
        pinOrderTarget: async (vmId) => {
          assert.equal(vmId, 'vm-slot')
          return fingerprint
        },
        activateOrder: async (opts) => {
          activateCalls++
          return activateBehavior(opts)
        },
      },
      supplier: {
        create: async (row) => ({
          order: order(row.order_id, remoteStatus.get(row.order_id) ?? 'fulfilled'),
        }),
        status: async (row) => {
          statusCalls++
          return order(row.order_id, remoteStatus.get(row.order_id) ?? 'fulfilled')
        },
        claim: async (row) => {
          claimCalls++
          return { order_id: row.order_id, redemption_code: CODE }
        },
      },
    })

  let shop = makeShop(true)
  const call = (method, endpoint, body, handler = shop) => {
    const url = new URL(`${PANEL}${BASE}${endpoint}`)
    return handler(
      {
        ...OTHER,
        method,
        raw: Buffer.from(body === undefined ? '' : JSON.stringify(body)),
        headers: {
          host: 'panel.example.test',
          origin: PANEL,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
      },
      {},
      url,
      cragShopRoute(method, url.pathname),
    )
  }

  const created = (
    await call('POST', '/orders', {
      ...INPUT,
      request_id: 'issue-1600-order',
      activation_target: { vm_id: 'vm-slot' },
    })
  ).data
  const id = created.order_id
  const due = (orderId = id) =>
    db.prepare('UPDATE crag_shop_orders SET activation_next_at = 1 WHERE order_id = ?').run(orderId)

  // 1. Transient auth_forbidden (recovery === 'unavailable') still reschedules and never stores 'unavailable'.
  const transientReqId = randomUUID()
  activateBehavior = async ({ claim }) => {
    await claim()
    throw Object.assign(new Error(`raw vendor error ${CODE} ${bearerSecret} /opt/private/credential`), {
      code: 'auth_forbidden',
      status: 403,
      recovery: 'unavailable',
      authorityRequestId: transientReqId,
    })
  }
  due()
  await shop.pollActivation()
  assert.equal(activateCalls, 1)
  assert.equal(claimCalls, 1)
  const afterTransientRow = db.prepare('SELECT * FROM crag_shop_orders WHERE order_id = ?').get(id)
  assert.equal(typeof afterTransientRow.activation_next_at, 'number')
  assert.equal(afterTransientRow.activation_error_code, 'auth_forbidden')
  assert.equal(afterTransientRow.activation_error_recovery, null)
  assert.equal(afterTransientRow.activation_request_id, transientReqId)
  const transientView = (await call('GET', `/orders/${id}`)).data
  assert.deepEqual(transientView.activation, {
    vm_id: 'vm-slot',
    state: 'activating',
    error_code: 'auth_forbidden',
    authority_request_id: transientReqId,
  })

  // 2. Paused auto-activation (!activationEnabled) never falsely reports 'activating' on a fulfilled order,
  //    and refreshes an unpaid order to fulfilled -> needs_attention.
  const pausedShop = makeShop(false)
  const pausedFulfilled = (await call('GET', `/orders/${id}`, undefined, pausedShop)).data
  assert.equal(pausedFulfilled.activation.state, 'needs_attention')
  assert.equal(pausedFulfilled.activation.error_code, 'auth_forbidden')
  assert.equal(
    (await call('GET', '/orders', undefined, pausedShop)).data.orders.find((o) => o.order_id === id).activation.state,
    'needs_attention',
  )
  assert.equal(
    (await call('POST', `/orders/${id}/retry-activation`, {}, pausedShop)).error.code,
    'shop_activation_disabled',
  )

  const pendingWhilePausedId = randomUUID()
  remoteStatus.set(pendingWhilePausedId, 'pending')
  db.prepare(`INSERT INTO crag_shop_orders
    (order_id, owner, request_id, sku, payment_method, reserved_at, status, dispatch_state,
     created_at, term, amount_minor, slot_limit, activation_vm_id, activation_fingerprint,
     activation_next_at, activation_deadline)
    VALUES (?, ?, 'paused-pending', 'quarter', 'alipay', 1, 'pending', 'submitted',
            1800000000, '3m', 59900, 10, 'vm-slot', ?, 1800000300, 1800086400)`).run(
    pendingWhilePausedId,
    OTHER.panelBuyerOwner,
    fingerprint,
  )
  assert.equal(
    (await call('GET', `/orders/${pendingWhilePausedId}`, undefined, pausedShop)).data.activation.state,
    'awaiting_fulfillment',
  )
  remoteStatus.set(pendingWhilePausedId, 'fulfilled')
  const refreshedWhilePaused = (await call('GET', `/orders/${pendingWhilePausedId}`, undefined, pausedShop)).data
  assert.equal(refreshedWhilePaused.status, 'fulfilled')
  assert.equal(refreshedWhilePaused.activation.state, 'needs_attention')

  // 3. Terminal auth_forbidden ('not_activated' and 'host_id_collision') and other terminal codes stop polling immediately.
  for (const [code, recovery] of [
    ['auth_forbidden', 'not_activated'],
    ['auth_forbidden', 'host_id_collision'],
    ['host_subscription_inactive', undefined],
    ['not_found', undefined],
    ['request_conflict', undefined],
    ['invalid_request', undefined],
  ]) {
    const reqId = randomUUID()
    activateBehavior = async ({ claim }) => {
      await claim()
      throw Object.assign(new Error(`supplier leak: ${CODE} Bearer ${bearerSecret} /var/lib/kin/private`), {
        code,
        status: 403,
        ...(recovery && { recovery }),
        authorityRequestId: reqId,
      })
    }
    due()
    const beforeCalls = activateCalls
    await shop.pollActivation()
    assert.equal(activateCalls, beforeCalls + 1)
    // A second poll must be a complete no-op because activation_next_at was cleared.
    await shop.pollActivation()
    assert.equal(activateCalls, beforeCalls + 1, `${code} (${recovery ?? 'no-recovery'}) must stop polling`)
    assert.equal((await call('POST', `/orders/${id}/claim`, {})).error.code, 'shop_activation_pinned')

    const viewed = (await call('GET', `/orders/${id}`)).data
    assert.deepEqual(viewed.activation, {
      vm_id: 'vm-slot',
      state: 'needs_attention',
      error_code: code,
      ...(recovery && { recovery }),
      authority_request_id: reqId,
    })

    // Retry-activation clears all stored error metadata immediately.
    const retried = (await call('POST', `/orders/${id}/retry-activation`, {})).data
    assert.deepEqual(retried.activation, { vm_id: 'vm-slot', state: 'activating' })
    const clearedRow = db.prepare('SELECT * FROM crag_shop_orders WHERE order_id = ?').get(id)
    assert.equal(clearedRow.activation_error_code, null)
    assert.equal(clearedRow.activation_error_recovery, null)
    assert.equal(clearedRow.activation_request_id, null)
  }

  // 4. Security check: untrusted/secret values in error fields are never persisted or returned.
  for (const untrustedError of [
    Object.assign(new Error(`leak ${CODE} ${bearerSecret} /etc/machine-id`), {
      code: bearerSecret,
      recovery: CODE,
      authorityRequestId: `${randomUUID()} ${CODE}`,
    }),
    Object.assign(new Error(`leak ${CODE}`), {
      code: CODE,
      recovery: '/opt/private/credential',
      authorityRequestId: bearerSecret,
    }),
  ]) {
    activateBehavior = async () => {
      throw untrustedError
    }
    due()
    await shop.pollActivation()
    const rawRow = JSON.stringify(db.prepare('SELECT * FROM crag_shop_orders WHERE order_id = ?').get(id))
    const rawView = JSON.stringify(await call('GET', `/orders/${id}`))
    const rawList = JSON.stringify(await call('GET', '/orders'))
    for (const secret of [CODE, bearerSecret, '/etc/machine-id', '/opt/private', 'leak']) {
      assert.equal(rawRow.includes(secret), false)
      assert.equal(rawView.includes(secret), false)
      assert.equal(rawList.includes(secret), false)
    }
  }

  // 5. Transitioning to 'active' clears any prior activation_error_* fields.
  const preActiveReqId = randomUUID()
  db.prepare(`UPDATE crag_shop_orders
    SET activation_error_code = 'crag_subscription_authority_unavailable',
        activation_error_recovery = 'failed',
        activation_request_id = ?,
        activation_next_at = 1
    WHERE order_id = ?`).run(preActiveReqId, id)
  activateBehavior = async ({ onRedeemed }) => {
    onRedeemed()
  }
  await shop.pollActivation()
  const activeOrder = (await call('GET', `/orders/${id}`)).data
  assert.deepEqual(activeOrder.activation, { vm_id: 'vm-slot', state: 'active' })
  const activeRow = db.prepare('SELECT * FROM crag_shop_orders WHERE order_id = ?').get(id)
  assert.equal(activeRow.activation_error_code, null)
  assert.equal(activeRow.activation_error_recovery, null)
  assert.equal(activeRow.activation_request_id, null)
  assert.ok(statusCalls >= 1)
})

test('direct-credit purchase injects host_id, auto-syncs host rights on fulfillment, and supports locked-price order renewal without renewalProof', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-shop-direct-'))
  const db = createDatabase({ dbPath: path.join(root, 'kin.db') })
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const hostId = 'd'.repeat(64)
  const sentQuotes = []
  const sentCreates = []
  let statusSyncs = 0
  let renewalProofCalls = 0
  let supplierStatus = 'pending'

  const handler = createCragShopHandler({
    dataDir: root,
    publicBaseUrl: PANEL,
    getDb: () => db,
    json: (_, http, body) => ({ http, ...body }),
    readRawBody: (req) => req.raw,
    isCurrentAdmin: () => true,
    subscription: {
      purchaseDeviceId: () => hostId,
      async status() {
        statusSyncs++
        return { state: 'active', host_id: hostId, slot_limit: 2 }
      },
      async renewalProof() {
        renewalProofCalls++
        throw new Error('should not require legacy renewalProof for renew_order_id')
      },
    },
    supplier: {
      async quote(input, proof) {
        sentQuotes.push({ input, proof })
        if (input.sku === 'renewal') {
          return {
            sku: 'renewal',
            term: '1m',
            months: 1,
            slot_limit: 2,
            subtotal_minor: 2900,
            discount_minor: 0,
            amount_minor: 2900,
            renew_order_id: input.renew_order_id,
          }
        }
        return { ...PLAN, months: 1, subtotal_minor: PLAN.amount_minor, discount_minor: 0 }
      },
      async create(row, _receipt, proof, purchase) {
        sentCreates.push({ order_id: row.order_id, proof, purchase })
        const amount = purchase.sku === 'renewal' ? 2900 : PLAN.amount_minor
        return {
          order: {
            ...order(row.order_id, supplierStatus),
            sku: row.sku,
            amount_minor: amount,
            host_id: purchase.host_id,
            direct_credit: true,
            ...(purchase.renew_order_id ? { renew_order_id: purchase.renew_order_id } : {}),
          },
        }
      },
      async status(row) {
        const amount = row.sku === 'renewal' ? 2900 : PLAN.amount_minor
        return {
          ...order(row.order_id, supplierStatus),
          sku: row.sku,
          amount_minor: amount,
          host_id: hostId,
          direct_credit: true,
        }
      },
      async claim() {
        throw new Error('supplier.claim must never be called for fulfilled direct_credit orders')
      },
    },
  })

  const call = (method, endpoint, body) => {
    const url = new URL(`${PANEL}${BASE}${endpoint}`)
    return handler(
      {
        ...PERSON,
        method,
        raw: Buffer.from(body === undefined ? '' : JSON.stringify(body)),
        headers: {
          host: 'panel.example.test',
          origin: PANEL,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
      },
      {},
      url,
      cragShopRoute(method, url.pathname),
    )
  }

  // 1. Standard panel purchase injects host_id automatically for direct credit.
  const buy = await call('POST', '/orders', {
    ...INPUT,
    request_id: 'direct-buy-1',
    expected_amount_minor: PLAN.amount_minor,
  })
  assert.equal(buy.http, 200)
  assert.equal(sentCreates[0].purchase.host_id, hostId)
  assert.equal(buy.data.activation.state, 'manual')

  // When payment completes and supplier returns direct_credit: true + fulfilled,
  // status poll syncs host rights and marks order active automatically!
  supplierStatus = 'fulfilled'
  const buyFulfilled = await call('GET', `/orders/${buy.data.order_id}`)
  assert.equal(buyFulfilled.http, 200)
  assert.equal(buyFulfilled.data.status, 'fulfilled')
  assert.equal(buyFulfilled.data.activation.state, 'active')
  assert.equal(statusSyncs, 1)

  // 2. Locked-price renewal quotes & creates with host_id + renew_order_id and NO legacy renewalProof.
  const quote = await call('POST', '/quote', {
    sku: 'renewal',
    renew_order_id: buy.data.order_id,
  })
  assert.equal(quote.http, 200)
  assert.equal(quote.data.amount_minor, 2900)
  assert.equal(quote.data.renew_order_id, buy.data.order_id)
  assert.equal(sentQuotes.at(-1).input.host_id, hostId)
  assert.equal(sentQuotes.at(-1).proof, undefined)

  const renew = await call('POST', '/orders', {
    sku: 'renewal',
    renew_order_id: buy.data.order_id,
    payment_method: 'alipay',
    request_id: 'direct-renew-1',
    expected_amount_minor: 2900,
  })
  assert.equal(renew.http, 200)
  assert.equal(sentCreates[1].purchase.host_id, hostId)
  assert.equal(sentCreates[1].purchase.renew_order_id, buy.data.order_id)
  assert.equal(sentCreates[1].proof, undefined)
  assert.equal(renew.data.activation.state, 'active')
  assert.equal(renewalProofCalls, 0)
  assert.equal(statusSyncs, 2)

  // 3. Fulfilled direct-credit order: /apply-renewal syncs rights without calling supplier.claim(),
  //    and /claim returns clean 409 shop_direct_credit_no_voucher instead of hitting supplier.claim().
  const applyRenew = await call('POST', `/orders/${renew.data.order_id}/apply-renewal`, {})
  assert.equal(applyRenew.http, 200)
  assert.equal(applyRenew.data.state, 'active')

  const claimDirect = await call('POST', `/orders/${buy.data.order_id}/claim`, {})
  assert.equal(claimDirect.http, 409)
  assert.equal(claimDirect.error.code, 'shop_direct_credit_no_voucher')
})

test('Gemini shop supplier prefix, ACL, order/cache/expiry isolation, and direct-credit sync({ sync: true })', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-gemini-shop-'))
  const db = createDatabase({ dbPath: path.join(root, 'kin.db') })
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  // 1. Supplier pathPrefix validation & callback URL pairing
  assert.throws(() => createShopSupplier(globalThis.fetch, { pathPrefix: 'gemini' }))
  assert.throws(() => createShopSupplier(globalThis.fetch, { pathPrefix: '/gemini/nested' }))

  const geminiOrderId = randomUUID()
  const geminiRow = { order_id: geminiOrderId, sku: 'gemini-monthly', payment_method: 'alipay' }
  const geminiPlan = {
    sku: 'gemini-monthly',
    term: '1m',
    amount_minor: 9900,
    slot_limit: 10,
    product: 'craggemini',
    stackable: true,
  }
  const geminiFields = {
    ...fields(geminiOrderId),
    money: '99.00',
    notify_url: `${SHOP}/gemini/shop/epay/notify`,
    return_url: `${SHOP}/gemini/shop/return`,
  }
  let supplierFields = geminiFields
  const seenUrls = []
  const geminiSupplier = createShopSupplier(
    async (url) => {
      seenUrls.push(url)
      if (url.endsWith('/gemini/shop/plans')) {
        return Response.json({ plans: [geminiPlan], payment_methods: ['alipay'] })
      }
      if (url.endsWith('/gemini/shop/orders')) {
        return Response.json({
          ...geminiPlan,
          order_id: geminiOrderId,
          status: 'pending',
          payment_method: 'alipay',
          created_at: 1_800_000_000,
          url: ACTION,
          data: supplierFields,
        })
      }
      throw new Error(`unexpected supplier url: ${url}`)
    },
    { pathPrefix: '/gemini' },
  )
  const plans = await geminiSupplier.plans()
  assert.equal(plans.plans[0].product, 'craggemini')
  assert.equal(plans.plans[0].stackable, true)
  const created = await geminiSupplier.create(geminiRow, PROOF)
  assert.equal(created.form.data.notify_url, `${SHOP}/gemini/shop/epay/notify`)
  assert.deepEqual(seenUrls, [`${SHOP}/gemini/shop/plans`, `${SHOP}/gemini/shop/orders`])

  // Non-prefixed Claude callbacks must be rejected by the Gemini supplier.
  supplierFields = { ...geminiFields, notify_url: `${SHOP}/shop/epay/notify`, return_url: `${SHOP}/shop/return` }
  await assert.rejects(() => geminiSupplier.create(geminiRow, PROOF), { code: 'shop_invalid_reply' })

  // 2. Route & ACL checks for /api/panel/gemini/crag-shop/*
  const GEMINI_BASE = '/api/panel/gemini/crag-shop'
  assert.equal(geminiCragShopRoute('GET', `${GEMINI_BASE}/plans`), 'plans')
  assert.equal(geminiCragShopRoute('POST', `${GEMINI_BASE}/quote`), 'quote')
  assert.equal(geminiCragShopRoute('POST', `${GEMINI_BASE}/orders`), 'create')
  assert.equal(geminiCragShopRoute('POST', `${GEMINI_BASE}/orders/${geminiOrderId}/claim`), 'claim')
  assert.equal(geminiCragShopRoute('POST', `${GEMINI_BASE}/orders/${geminiOrderId}/apply-renewal`), 'apply-renewal')
  assert.equal(geminiCragShopRoute('GET', `${GEMINI_BASE}/activation-targets`), null)
  assert.equal(geminiCragShopRoute('POST', `${GEMINI_BASE}/device/orders`), null)
  for (const role of ['user', 'super', 'admin']) {
    assert.equal(authorizePanelRoute('POST', `${GEMINI_BASE}/orders`, role).ok, true)
  }
  assert.equal(authorizePanelRoute('POST', `${GEMINI_BASE}/orders/${geminiOrderId}/apply-renewal`, 'user').ok, false)
  assert.equal(authorizePanelRoute('POST', `${GEMINI_BASE}/orders/${geminiOrderId}/apply-renewal`, 'admin').ok, true)

  // 3. Handler isolation: ownerPrefix, catalogCacheKey, sync({ sync: true }), pollOrderExpiry
  const geminiHostId = 'e'.repeat(64)
  const syncArgs = []
  let geminiRemoteStatus = 'pending'
  let claudeExpiryPolls = 0
  let geminiExpiryPolls = 0

  const claudeHandler = createCragShopHandler({
    dataDir: root,
    publicBaseUrl: PANEL,
    getDb: () => db,
    json: (_, http, body) => ({ http, ...body }),
    readRawBody: (req) => req.raw,
    isCurrentAdmin: () => true,
    supplier: {
      async plans() {
        return { plans: [PLAN], payment_methods: ['alipay'] }
      },
      async status() {
        claudeExpiryPolls++
        throw new Error('Claude expiry poll must not query Gemini orders')
      },
    },
  })

  const geminiHandler = createGeminiCragShopHandler({
    dataDir: root,
    publicBaseUrl: PANEL,
    getDb: () => db,
    json: (_, http, body) => ({ http, ...body }),
    readRawBody: (req) => req.raw,
    isCurrentAdmin: () => true,
    subscription: {
      purchaseDeviceId: () => geminiHostId,
      async status(opts) {
        syncArgs.push(opts)
        return { active: true, host_id: geminiHostId, slot_limit: 10 }
      },
    },
    supplier: {
      async plans() {
        return { plans: [geminiPlan], payment_methods: ['alipay'] }
      },
      async quote() {
        return { ...geminiPlan, months: 1, subtotal_minor: 9900, discount_minor: 0 }
      },
      async create(row, _receipt, _proof, purchase) {
        assert.equal(purchase.host_id, geminiHostId)
        return {
          order: {
            ...geminiPlan,
            order_id: row.order_id,
            status: geminiRemoteStatus,
            payment_method: row.payment_method,
            created_at: 1_800_000_000,
            host_id: geminiHostId,
            direct_credit: true,
          },
        }
      },
      async status(row) {
        geminiExpiryPolls++
        return {
          ...geminiPlan,
          order_id: row.order_id,
          status: geminiRemoteStatus,
          payment_method: row.payment_method,
          created_at: 1_800_000_000,
          host_id: geminiHostId,
          direct_credit: true,
        }
      },
    },
  })

  const callGemini = (method, endpoint, body) => {
    const url = new URL(`${PANEL}${GEMINI_BASE}${endpoint}`)
    return geminiHandler(
      {
        ...PERSON,
        method,
        raw: Buffer.from(body === undefined ? '' : JSON.stringify(body)),
        headers: {
          host: 'panel.example.test',
          origin: PANEL,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
      },
      {},
      url,
      geminiCragShopRoute(method, url.pathname),
    )
  }

  // Catalog caches are stored under separate keys.
  assert.equal((await callGemini('GET', '/plans')).http, 200)
  const claudePlansUrl = new URL(`${PANEL}${BASE}/plans`)
  assert.equal((await claudeHandler({ ...PERSON, method: 'GET', headers: {} }, {}, claudePlansUrl, 'plans')).http, 200)
  assert.ok(db.prepare('SELECT value FROM settings WHERE key = ?').get('crag_shop_catalog_cache_v1'))
  assert.ok(db.prepare('SELECT value FROM settings WHERE key = ?').get(GEMINI_CATALOG_CACHE_KEY))

  // activation_target is rejected on Gemini orders.
  const badTarget = await callGemini('POST', '/orders', {
    sku: 'gemini-monthly',
    payment_method: 'alipay',
    request_id: 'gemini-bad-target',
    expected_amount_minor: 9900,
    activation_target: { vm_id: 'vm-1' },
  })
  assert.equal(badTarget.http, 400)
  assert.equal(badTarget.error.code, 'shop_invalid_request')

  // Create Gemini order -> stored with craggemini: owner prefix, invisible to Claude order list.
  const buy = await callGemini('POST', '/orders', {
    sku: 'gemini-monthly',
    payment_method: 'alipay',
    request_id: 'gemini-buy-1',
    expected_amount_minor: 9900,
  })
  assert.equal(buy.http, 200)
  const rowInDb = db.prepare('SELECT owner FROM crag_shop_orders WHERE order_id = ?').get(buy.data.order_id)
  assert.equal(rowInDb.owner, `${GEMINI_SHOP_OWNER_PREFIX}${PERSON.panelBuyerOwner}`)

  const claudeListUrl = new URL(`${PANEL}${BASE}/orders`)
  const claudeList = await claudeHandler({ ...PERSON, method: 'GET', headers: {} }, {}, claudeListUrl, 'list')
  assert.equal(claudeList.data.orders.length, 0)

  // Age the Gemini order past PAYMENT_WINDOW: Claude pollOrderExpiry must ignore it!
  db.prepare('UPDATE crag_shop_orders SET reserved_at = 1 WHERE order_id = ?').run(buy.data.order_id)
  await claudeHandler.pollOrderExpiry()
  assert.equal(claudeExpiryPolls, 0)
  assert.equal(
    db.prepare('SELECT closed_at FROM crag_shop_orders WHERE order_id = ?').get(buy.data.order_id).closed_at,
    null,
  )

  // Now fulfill on supplier: Gemini status poll triggers subscription.status({ sync: true })!
  geminiRemoteStatus = 'fulfilled'
  const synced = await callGemini('GET', `/orders/${buy.data.order_id}`)
  assert.equal(synced.http, 200)
  assert.equal(synced.data.status, 'fulfilled')
  assert.equal(synced.data.activation.state, 'active')
  assert.deepEqual(syncArgs, [{ sync: true }])

  // Gemini expiry poll checks only Gemini orders (and leaves fulfilled ones open).
  const expireOrder = await callGemini('POST', '/orders', {
    sku: 'gemini-monthly',
    payment_method: 'alipay',
    request_id: 'gemini-expire-1',
    expected_amount_minor: 9900,
  })
  assert.equal(expireOrder.http, 200)
  geminiRemoteStatus = 'pending'
  db.prepare("UPDATE crag_shop_orders SET status = 'pending', reserved_at = 1 WHERE order_id = ?").run(
    expireOrder.data.order_id,
  )
  const beforeGeminiPolls = geminiExpiryPolls
  await geminiHandler.pollOrderExpiry()
  assert.equal(geminiExpiryPolls, beforeGeminiPolls + 1)
  assert.ok(
    db.prepare('SELECT closed_at FROM crag_shop_orders WHERE order_id = ?').get(expireOrder.data.order_id).closed_at,
  )
})
