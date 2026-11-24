import test from 'node:test'
import assert from 'node:assert/strict'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'

/**
 * A freshly booted control plane restores kernels, dials cluster links, and
 * pushes slot binaries while the very first probe rounds run on the same wire.
 * A probe timeout in that storm is boot evidence, not proxy death: it must not
 * dead-mark the row and cascade-disable every bound slot (a single shared exit
 * can carry the whole GPT pool — one false dead flips it to no_codex_vm).
 */
const FAIL = { ok: false, scope: 'socks', error: 'egress_tls_timeout', latency_ms: null }
const OK = { ok: true, scope: 'socks', latency_ms: 20 }

function makePool(t, { onDisableVm, onEnableVm } = {}) {
  const pool = new ProxyPool({ db: openDatabase({ dbPath: ':memory:' }), onDisableVm, onEnableVm })
  pool.updateConfig({ enabled: false })
  t.after(() => {
    pool.stopScheduler()
    closeDatabase()
  })
  return pool
}

function addProxy(pool) {
  const {
    items: [proxy],
  } = pool.importLines('socks5h://203.0.113.10:1080')
  return pool.state.proxies.find((p) => p.id === proxy.id)
}

function fail(pool, p, times = 1) {
  for (let i = 0; i < times; i++) pool._applyProbeResult(p, FAIL)
}

test('boot-grace: failures right after boot surface as fail but never dead or cascade', (t) => {
  const disabled = []
  const pool = makePool(t, { onDisableVm: (vmId) => disabled.push(vmId) })
  const p = addProxy(pool)
  pool.bind(p.id, 'vm-02')

  fail(pool, p, 3)

  assert.equal(p.status, 'fail')
  assert.equal(p.last_error, FAIL.error)
  assert.equal(p.enabled, true)
  // Clamped at max_failures - 1: the streak stays visible without crossing.
  assert.equal(p.consecutive_failures, 1)
  assert.deepEqual(disabled, [])
})

test('boot-grace: a half-streak persisted by the previous process rides the same clamp', (t) => {
  const disabled = []
  const pool = makePool(t, { onDisableVm: (vmId) => disabled.push(vmId) })
  const p = addProxy(pool)
  pool.bind(p.id, 'vm-02')
  // Restored from disk: the pre-restart process already counted one failure.
  p.consecutive_failures = 1

  fail(pool, p, 1)

  assert.equal(p.status, 'fail')
  assert.equal(p.enabled, true)
  assert.equal(p.consecutive_failures, 1)
  assert.deepEqual(disabled, [])
})

test('boot-grace: a hard refusal right after boot keeps the dead + cascade verdict', (t) => {
  const disabled = []
  const pool = makePool(t, { onDisableVm: (vmId) => disabled.push(vmId) })
  const p = addProxy(pool)
  pool.bind(p.id, 'vm-02')
  const refused = { ok: false, scope: 'socks', error: 'connection_refused', latency_ms: null }

  pool._applyProbeResult(p, refused)
  pool._applyProbeResult(p, refused)

  assert.equal(p.status, 'dead')
  assert.equal(p.enabled, false)
  assert.deepEqual(disabled, ['vm-02'])
})

test('boot-grace covers every timeout shape the probes report', (t) => {
  const pool = makePool(t)
  for (const error of [
    'timeout',
    'egress_timeout：经代理连接检测目标超时',
    'egress_dns_timeout：经代理 DNS 探测超时',
  ]) {
    const p = addProxy(pool)
    pool._applyProbeResult(p, { ok: false, scope: 'socks', error, latency_ms: null })
    pool._applyProbeResult(p, { ok: false, scope: 'socks', error, latency_ms: null })
    assert.equal(p.status, 'fail', error)
    assert.equal(p.enabled, true, error)
    pool.state.proxies = []
  }
})

test('after the grace window the old verdict is intact: dead + cascade', (t) => {
  const disabled = []
  const pool = makePool(t, { onDisableVm: (vmId, reason) => disabled.push([vmId, reason]) })
  const p = addProxy(pool)
  pool.bind(p.id, 'vm-02')
  pool._bootAt = Date.now() - 11 * 60_000

  fail(pool, p, 2)

  assert.equal(p.status, 'dead')
  assert.equal(p.enabled, false)
  assert.deepEqual(disabled, [['vm-02', `proxy_probe_failed:${FAIL.error}`]])
})

test('boot_grace_min=0 restores the pre-grace behavior for operators who want it', (t) => {
  const disabled = []
  const pool = makePool(t, { onDisableVm: (vmId) => disabled.push(vmId) })
  const p = addProxy(pool)
  pool.bind(p.id, 'vm-02')
  pool.updateConfig({ boot_grace_min: 0 })

  fail(pool, p, 2)

  assert.equal(p.status, 'dead')
  assert.equal(p.enabled, false)
  assert.deepEqual(disabled, ['vm-02'])
})

test('boot-grace does not touch the success path: a recovered proxy resumes its slots', (t) => {
  const enabled = []
  const pool = makePool(t, { onEnableVm: (vmId) => enabled.push(vmId) })
  const p = addProxy(pool)
  pool.bind(p.id, 'vm-02')
  fail(pool, p, 1)

  pool._applyProbeResult(p, OK)

  assert.equal(p.status, 'ok')
  assert.equal(p.consecutive_failures, 0)
  assert.deepEqual(enabled, ['vm-02'])
})

test('updateConfig validates boot_grace_min bounds', (t) => {
  const pool = makePool(t)
  assert.equal(pool.updateConfig({ boot_grace_min: 15 }).ok, true)
  assert.equal(pool.state.config.boot_grace_min, 15)
  assert.equal(pool.updateConfig({ boot_grace_min: 0 }).ok, true)
  assert.equal(pool.updateConfig({ boot_grace_min: -1 }).ok, false)
  assert.equal(pool.updateConfig({ boot_grace_min: 121 }).ok, false)
})
