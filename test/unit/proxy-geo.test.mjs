import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizeGeoPayload, lookupProxyGeo } from '../../src/lib/vm/proxy-geo.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { syncVmTimezoneFromProxy } from '../../src/lib/vm/proxy-timezone.mjs'

function tmpDir(prefix = 'kin-geo-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function makePool(geoLookup) {
  const pool = new ProxyPool({ dataDir: tmpDir(), geoLookup })
  pool.stopScheduler()
  return pool
}

function seedProject(vm) {
  const root = tmpDir('kin-proj-')
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  return root
}

test('geo payload keeps named zones and reports provider-level failures', () => {
  const okPayload = normalizeGeoPayload({
    status: 'success',
    query: '203.0.113.9',
    country: 'Japan',
    countryCode: 'JP',
    regionName: 'Tokyo',
    city: 'Shinjuku',
    timezone: 'asia/tokyo',
    isp: 'Example ISP',
  })
  assert.equal(okPayload.ip, '203.0.113.9')
  assert.equal(okPayload.country_code, 'JP')
  // Intl-normalized: Linux TZ paths are case-sensitive.
  assert.equal(okPayload.timezone, 'Asia/Tokyo')

  assert.deepEqual(normalizeGeoPayload({ status: 'fail', message: 'private range' }), {
    error: 'private range',
  })
  assert.equal(normalizeGeoPayload({ query: '198.51.100.4', timezone: '+09:00' }).timezone, null)
  assert.equal(normalizeGeoPayload({}), null)
})

test('geo lookup surfaces transport and HTTP failures instead of throwing', async () => {
  const boom = await lookupProxyGeo('', {
    fetchImpl: async () => {
      throw new Error('socks refused')
    },
  })
  assert.equal(boom.ok, false)
  assert.match(boom.error, /^geo_transport_error:socks refused/)

  const http = await lookupProxyGeo('', { fetchImpl: async () => ({ ok: false, status: 429 }) })
  assert.deepEqual(http, { ok: false, error: 'geo_http_429' })
})

test('detectGeo caches per proxy and publishes location on the snapshot', async () => {
  let calls = 0
  const pool = makePool(async () => {
    calls += 1
    return { ok: true, geo: { ip: '203.0.113.9', country: 'Japan', country_code: 'JP', timezone: 'Asia/Tokyo' } }
  })
  const imported = pool.importLines('1.2.3.4:1080')
  const id = imported.items[0].id

  const first = await pool.detectGeo(id)
  assert.equal(first.ok, true)
  assert.equal(first.geo.timezone, 'Asia/Tokyo')
  assert.equal(pool.proxyTimezone(id), 'Asia/Tokyo')

  const cached = await pool.detectGeo(id)
  assert.equal(cached.cached, true)
  assert.equal(calls, 1, 'cached hit must not re-query the provider')

  await pool.detectGeo(id, { force: true })
  assert.equal(calls, 2)

  const snap = pool.snapshot().proxies.find((p) => p.id === id)
  assert.equal(snap.geo.country, 'Japan')
  assert.equal(snap.geo.timezone, 'Asia/Tokyo')
  assert.equal(snap.geo.error, null)
})

test('a failed lookup keeps the last known location and records the error', async () => {
  let ok = true
  const pool = makePool(async () =>
    ok
      ? { ok: true, geo: { ip: '203.0.113.9', country: 'Japan', timezone: 'Asia/Tokyo' } }
      : { ok: false, error: 'geo_http_500' },
  )
  const id = pool.importLines('1.2.3.4:1080').items[0].id
  await pool.detectGeo(id)
  ok = false
  const failed = await pool.detectGeo(id, { force: true })
  assert.equal(failed.ok, false)
  const snap = pool.snapshot().proxies.find((p) => p.id === id)
  assert.equal(snap.geo.timezone, 'Asia/Tokyo')
  assert.equal(snap.geo.error, 'geo_http_500')
  assert.equal(pool.proxyTimezone(id), 'Asia/Tokyo')
})

test('binding a proxy moves the slot onto the exit node timezone', async () => {
  const pool = makePool(async () => ({
    ok: true,
    geo: { ip: '203.0.113.9', country: 'Japan', timezone: 'Asia/Tokyo' },
  }))
  const id = pool.importLines('1.2.3.4:1080').items[0].id
  pool.bind(id, 'vm-01')
  const root = seedProject({
    id: 'vm-01',
    timezone: 'America/Los_Angeles',
    fingerprint: { timezone: 'America/Los_Angeles' },
    proxy: { id },
  })

  const synced = await syncVmTimezoneFromProxy(root, pool, 'vm-01')
  assert.deepEqual(synced, { ok: true, applied: true, timezone: 'Asia/Tokyo', reason: null })
  const vm = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-01.json'), 'utf8'))
  assert.equal(vm.timezone, 'Asia/Tokyo')
  assert.equal(vm.timezone_source, 'proxy_geo')
  assert.equal(vm.fingerprint.timezone, 'Asia/Tokyo')
})

test('a hand-pinned slot timezone survives a proxy bind unless forced', async () => {
  const pool = makePool(async () => ({ ok: true, geo: { timezone: 'Asia/Tokyo' } }))
  const id = pool.importLines('1.2.3.4:1080').items[0].id
  pool.bind(id, 'vm-02')
  const root = seedProject({
    id: 'vm-02',
    timezone: 'America/New_York',
    timezone_source: 'manual',
    proxy: { id },
  })

  const skipped = await syncVmTimezoneFromProxy(root, pool, 'vm-02')
  assert.equal(skipped.applied, false)
  assert.equal(skipped.reason, 'timezone_pinned')
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-02.json'), 'utf8')).timezone, 'America/New_York')

  const forced = await syncVmTimezoneFromProxy(root, pool, 'vm-02', { force: true })
  assert.equal(forced.applied, true)
  assert.equal(forced.timezone, 'Asia/Tokyo')
})

test('follow_proxy_timezone=false stops the bind-time default', async () => {
  const pool = makePool(async () => ({ ok: true, geo: { timezone: 'Asia/Tokyo' } }))
  pool.updateConfig({ follow_proxy_timezone: false })
  // updateConfig restarts the probe loop; left running it keeps the test
  // process alive forever.
  pool.stopScheduler()
  assert.equal(pool.followProxyTimezoneEnabled(), false)
  const id = pool.importLines('1.2.3.4:1080').items[0].id
  pool.bind(id, 'vm-03')
  const root = seedProject({ id: 'vm-03', timezone: 'America/New_York', proxy: { id } })

  const skipped = await syncVmTimezoneFromProxy(root, pool, 'vm-03')
  assert.equal(skipped.reason, 'follow_proxy_timezone_disabled')
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-03.json'), 'utf8')).timezone, 'America/New_York')
})

test('an unresolvable exit zone leaves the slot timezone alone', async () => {
  const pool = makePool(async () => ({ ok: true, geo: { ip: '203.0.113.9', country: 'Japan', timezone: null } }))
  const id = pool.importLines('1.2.3.4:1080').items[0].id
  pool.bind(id, 'vm-04')
  const root = seedProject({ id: 'vm-04', timezone: 'America/Denver', proxy: { id } })

  const skipped = await syncVmTimezoneFromProxy(root, pool, 'vm-04')
  assert.equal(skipped.reason, 'proxy_timezone_unknown')
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-04.json'), 'utf8')).timezone, 'America/Denver')
})
