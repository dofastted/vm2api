import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { catalogHash, createCragShopHandler, cragShopRoute } from '../../src/lib/admin/crag-shop.mjs'
import { createShopSupplier } from '../../src/lib/admin/crag-shop-supplier.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'

const PANEL = 'https://panel.example.test'
const BASE = '/api/panel/crag-shop'
const SHOP = 'https://www.vm2api.org'
const PLAN_V1 = { sku: 'quarter', term: '3m', amount_minor: 59900, slot_limit: 10, name: '季卡 v1' }
const PLAN_V2 = { sku: 'quarter', term: '3m', amount_minor: 49900, slot_limit: 12, name: '季卡 v2' }
const CATALOG_V1 = {
  revision: 1,
  plans: [PLAN_V1],
  payment_methods: ['alipay'],
  presentation: { title: '订阅画布 v1', layout: { plan_columns: 2 } },
}
const CATALOG_V2 = {
  revision: 2,
  plans: [PLAN_V2],
  payment_methods: ['alipay', 'wxpay'],
  presentation: { title: '订阅画布 v2', layout: { plan_columns: 3 } },
}

function makeRes() {
  const headers = new Map()
  let status = null
  let ended = false
  return {
    headers,
    get status() {
      return status
    },
    get ended() {
      return ended
    },
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value)
    },
    writeHead(code) {
      status = code
    },
    end() {
      ended = true
    },
  }
}

test('supplier.fetchPlans sends If-None-Match and short-circuits 304 without body parsing', async () => {
  const etag = '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"'
  const seen = []
  let mode = '200'
  const supplier = createShopSupplier(async (url, init) => {
    const headers = new Headers(init.headers)
    seen.push({ url, ifNoneMatch: headers.get('if-none-match'), cacheControl: headers.get('cache-control') })
    if (mode === '304') {
      return new Response(null, { status: 304, headers: { ETag: etag } })
    }
    return new Response(JSON.stringify(CATALOG_V1), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ETag: etag },
    })
  })

  const first = await supplier.fetchPlans()
  assert.equal(first.status, 'ok')
  assert.equal(first.etag, etag)
  assert.deepEqual(first.catalog, CATALOG_V1)

  mode = '304'
  const second = await supplier.fetchPlans({ ifNoneMatch: etag })
  assert.deepEqual(second, { status: 'not_modified', etag })
  assert.deepEqual(seen, [
    { url: `${SHOP}/shop/plans`, ifNoneMatch: null, cacheControl: 'no-store' },
    { url: `${SHOP}/shop/plans`, ifNoneMatch: etag, cacheControl: 'no-cache' },
  ])
})

test('crag-shop persists catalog canvas in DB, skips pull on matching hash, and survives restart/timeouts', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-canvas-cache-'))
  const dbPath = path.join(root, 'kin.db')
  let db = createDatabase({ dbPath })
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  let now = 1_700_000_000_000
  let current = CATALOG_V1
  let mode = 'ok'
  let upstreamCalls = 0
  const seenIfNoneMatch = []

  const fetchMock = async (url, init) => {
    assert.equal(url, `${SHOP}/shop/plans`)
    upstreamCalls++
    const headers = new Headers(init.headers)
    const inm = headers.get('if-none-match')
    seenIfNoneMatch.push(inm)
    if (mode === 'timeout') {
      throw new DOMException('timed out', 'TimeoutError')
    }
    const etag = `"${catalogHash(current)}"`
    if (inm && inm === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } })
    }
    return new Response(JSON.stringify(current), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ETag: etag },
    })
  }

  const makeHandler = () =>
    createCragShopHandler({
      getDb: () => db,
      dataDir: root,
      publicBaseUrl: PANEL,
      json: (res, http, body) => ({ http, headers: res.headers, ...body }),
      readRawBody: (req) => req.raw,
      supplier: createShopSupplier(fetchMock),
      catalogCacheTtlMs: 60_000,
      nowMs: () => now,
    })

  let handle = makeHandler()
  const call = async (endpoint, { actor = {}, extraHeaders = {}, device = false } = {}) => {
    const prefix = device ? `${BASE}/device` : BASE
    const url = new URL(`${PANEL}${prefix}${endpoint}`)
    const res = makeRes()
    const req = {
      ...actor,
      method: 'GET',
      raw: Buffer.alloc(0),
      headers: {
        host: 'panel.example.test',
        origin: PANEL,
        'sec-fetch-site': 'same-origin',
        ...extraHeaders,
      },
    }
    const out = await handle(req, res, url, cragShopRoute('GET', url.pathname))
    return { out, res }
  }

  // 1. Cold start fetches once, returns catalog + catalog_hash + ETag, and saves to DB.
  const first = await call('/plans')
  const hash1 = catalogHash(CATALOG_V1)
  assert.equal(first.out.http, 200)
  assert.equal(first.out.data.catalog_hash, hash1)
  assert.deepEqual(first.out.data.plans, [PLAN_V1])
  assert.equal(first.res.headers.get('etag'), `"${hash1}"`)
  assert.equal(upstreamCalls, 1)

  // 2. Within TTL, repeat requests do NOT pull upstream at all.
  now += 5_000
  const cached = await call('/plans')
  assert.equal(cached.out.http, 200)
  assert.equal(cached.out.data.catalog_hash, hash1)
  assert.equal(upstreamCalls, 1)

  // 3. Matching ?hash= returns lightweight unchanged marker without sending full plans.
  const unchanged = await call(`/plans?hash=${hash1}`)
  assert.equal(unchanged.out.http, 200)
  assert.deepEqual(unchanged.out.data, { unchanged: true, catalog_hash: hash1 })
  assert.equal(upstreamCalls, 1)

  // 4. Matching HTTP If-None-Match returns 304 Not Modified with empty body.
  const notModified = await call('/plans', { extraHeaders: { 'if-none-match': `"${hash1}"` } })
  assert.equal(notModified.res.status, 304)
  assert.equal(notModified.res.ended, true)
  assert.equal(notModified.res.headers.get('etag'), `"${hash1}"`)
  assert.equal(upstreamCalls, 1)

  // 5. After TTL expires, SWR returns cached immediately and revalidates in background via If-None-Match -> 304.
  now += 65_000
  const swr = await call('/plans')
  assert.equal(swr.out.http, 200)
  assert.equal(swr.out.data.catalog_hash, hash1)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(upstreamCalls, 2)
  assert.equal(seenIfNoneMatch.at(-1), `"${hash1}"`)

  // 6. Restart simulation: reopen DB & handler while upstream is timing out -> still serves persisted cache immediately!
  db.close()
  db = createDatabase({ dbPath })
  mode = 'timeout'
  handle = makeHandler()
  const afterRestart = await call('/plans')
  assert.equal(afterRestart.out.http, 200)
  assert.equal(afterRestart.out.data.catalog_hash, hash1)
  assert.equal(afterRestart.out.data.presentation.title, '订阅画布 v1')
  await new Promise((resolve) => setTimeout(resolve, 20))

  // 7. Manual force refresh (?refresh=1) while upstream times out falls back to saved cache (stale: true) instead of 503.
  const forcedFallback = await call('/plans?refresh=1')
  assert.equal(forcedFallback.out.http, 200)
  assert.equal(forcedFallback.out.data.catalog_hash, hash1)
  assert.equal(forcedFallback.out.data.stale, true)

  // 8. When upstream recovers with a new catalog revision/hash, ?refresh=1 pulls the new canvas and updates persisted cache.
  mode = 'ok'
  current = CATALOG_V2
  const hash2 = catalogHash(CATALOG_V2)
  assert.notEqual(hash2, hash1)
  const updated = await call(`/plans?refresh=1&hash=${hash1}`)
  assert.equal(updated.out.http, 200)
  assert.equal(updated.out.data.catalog_hash, hash2)
  assert.equal(updated.out.data.presentation.title, '订阅画布 v2')
  assert.equal(updated.out.data.stale, undefined)
  assert.equal(seenIfNoneMatch.at(-1), `"${hash1}"`)

  // 9. Device /plans still mints checkout cookie even when served from cache / 304.
  const deviceRes = await call('/plans', { device: true, extraHeaders: { 'if-none-match': `"${hash2}"` } })
  assert.equal(deviceRes.res.status, 304)
  assert.match(String(deviceRes.res.headers.get('set-cookie') || ''), /^kin_crag_device_checkout=/)
})

test('concurrent cold-start /plans calls coalesce into one singleflight upstream fetch', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-canvas-singleflight-'))
  const db = createDatabase({ dbPath: path.join(root, 'kin.db') })
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  let upstreamCalls = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const handle = createCragShopHandler({
    getDb: () => db,
    dataDir: root,
    publicBaseUrl: PANEL,
    json: (_, http, body) => ({ http, ...body }),
    readRawBody: (req) => req.raw,
    supplier: createShopSupplier(async () => {
      upstreamCalls++
      await gate
      return Response.json(CATALOG_V1)
    }),
  })

  const req = () => ({
    method: 'GET',
    raw: Buffer.alloc(0),
    headers: { host: 'panel.example.test' },
  })
  const url = new URL(`${PANEL}${BASE}/plans`)
  const pending = [
    handle(req(), makeRes(), url, 'plans'),
    handle(req(), makeRes(), url, 'plans'),
    handle(req(), makeRes(), url, 'plans'),
  ]
  release()
  const results = await Promise.all(pending)
  assert.equal(upstreamCalls, 1)
  for (const r of results) {
    assert.equal(r.http, 200)
    assert.equal(r.data.catalog_hash, catalogHash(CATALOG_V1))
  }
})
