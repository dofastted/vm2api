import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { ProxyPool, MAX_VMS_PER_PROXY, clampBindLimit } from '../../src/lib/vm/proxy-pool.mjs'

function tmpDir(prefix = 'kin-px-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function makePool() {
  const pool = new ProxyPool({ dataDir: tmpDir() })
  pool.stopScheduler()
  return pool
}

test('clampBindLimit defaults to 5 and stays in 1..32', () => {
  assert.equal(clampBindLimit(undefined), MAX_VMS_PER_PROXY)
  assert.equal(clampBindLimit(5), 5)
  assert.equal(clampBindLimit(1), 1)
  assert.equal(clampBindLimit(32), 32)
  assert.equal(clampBindLimit(0), 1)
  assert.equal(clampBindLimit(99), 32)
  assert.equal(clampBindLimit('x'), MAX_VMS_PER_PROXY)
})

test('bind_limit defaults to 5 and is configurable', () => {
  const pool = makePool()
  pool.importLines('10.0.0.1:1080')
  const id = pool.snapshot().proxies[0].id
  assert.equal(pool.bindLimit(), 5)
  assert.equal(pool.snapshot().config.bind_limit, 5)
  for (let i = 1; i <= 5; i++) {
    const r = pool.bind(id, `vm-0${i}`)
    assert.equal(r.ok, true, `bind vm-0${i}`)
  }
  const full = pool.bind(id, 'vm-06')
  assert.equal(full.ok, false)
  assert.equal(full.error, 'proxy_bind_limit')
  assert.equal(full.max, 5)

  const cfg = pool.updateConfig({ bind_limit: 2 })
  pool.stopScheduler()
  assert.equal(cfg.ok, true)
  assert.equal(pool.bindLimit(), 2)
  assert.equal(pool.snapshot().proxies[0].bind_limit, 2)
  assert.equal(pool.snapshot().totals.bind_limit, 2)
  // existing binds stay; new binds still rejected at the new cap
  assert.equal(pool.snapshot().proxies[0].bound_count, 5)
  assert.equal(pool.bind(id, 'vm-07').ok, false)

  pool.unbind(id)
  assert.equal(pool.bind(id, 'vm-01').ok, true)
  assert.equal(pool.bind(id, 'vm-02').ok, true)
  assert.equal(pool.bind(id, 'vm-03').ok, false)
  assert.equal(pool.bind(id, 'vm-03').max, 2)
})

test('remove deletes a proxy and updateConfig rejects bad bind_limit', () => {
  const pool = makePool()
  pool.importLines('10.0.0.2:1080')
  const id = pool.snapshot().proxies[0].id
  const removed = pool.remove(id)
  assert.equal(removed.ok, true)
  assert.equal(pool.snapshot().proxies.length, 0)
  assert.equal(pool.updateConfig({ bind_limit: 0 }).ok, false)
  assert.equal(pool.updateConfig({ bind_limit: 33 }).ok, false)
  pool.stopScheduler()
})

async function listenSocks() {
  const server = net.createServer((socket) => {
    socket.on('data', () => {
      socket.write(Buffer.from([0x05, 0x00]))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  return { server, host: addr.address, port: addr.port }
}

test('probeOne marks egress_down after SOCKS greeting if helper is dead', async () => {
  const socks = await listenSocks()
  const pool = new ProxyPool({
    dataDir: tmpDir(),
    egressCheck: () => ({ ok: false, reason: 'not_running' }),
  })
  pool.stopScheduler()
  try {
    pool.importLines(`${socks.host}:${socks.port}`)
    const result = await pool.probeOne(pool.state.proxies[0])
    assert.equal(result.ok, false)
    assert.equal(result.error, 'not_running')
  } finally {
    pool.stopScheduler()
    socks.server.close()
  }
})

test('probeOne repairs egress then passes', async () => {
  const socks = await listenSocks()
  let healthy = false
  const pool = new ProxyPool({
    dataDir: tmpDir(),
    egressCheck: () => ({ ok: healthy }),
    repairEgress: () => {
      healthy = true
    },
  })
  pool.stopScheduler()
  try {
    pool.importLines(`${socks.host}:${socks.port}`)
    const result = await pool.probeOne(pool.state.proxies[0])
    assert.equal(result.ok, true)
    assert.equal(healthy, true)
  } finally {
    pool.stopScheduler()
    socks.server.close()
  }
})

test('startScheduler immediately repairs enabled egress', async () => {
  const socks = await listenSocks()
  let healthy = false
  let repairs = 0
  const pool = new ProxyPool({
    dataDir: tmpDir(),
    egressCheck: () => ({ ok: healthy, reason: healthy ? null : 'not_running' }),
    repairEgress: () => {
      repairs += 1
      healthy = true
    },
  })
  try {
    pool.importLines(`${socks.host}:${socks.port}`)
    pool.startScheduler()
    const deadline = Date.now() + 1000
    while (!healthy && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(healthy, true)
    assert.equal(repairs, 1)
  } finally {
    pool.stopScheduler()
    socks.server.close()
  }
})

test('egress_down does not mark a live SOCKS proxy dead', async () => {
  const socks = await listenSocks()
  const pool = new ProxyPool({
    dataDir: tmpDir(),
    egressCheck: () => ({ ok: false, reason: 'not_running' }),
  })
  pool.stopScheduler()
  try {
    pool.importLines(`${socks.host}:${socks.port}`)
    const id = pool.snapshot().proxies[0].id
    await pool.probeById(id)
    await pool.probeById(id)
    const p = pool.snapshot().proxies[0]
    assert.equal(p.enabled, true)
    assert.equal(p.status, 'ok')
    assert.match(String(p.last_error), /egress_down/)
  } finally {
    pool.stopScheduler()
    socks.server.close()
  }
})

test('TCP connect then close is not a SOCKS death', async () => {
  const server = net.createServer((socket) => socket.destroy())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const pool = new ProxyPool({ dataDir: tmpDir() })
  pool.stopScheduler()
  try {
    pool.importLines(`${addr.address}:${addr.port}`)
    const result = await pool._probeSocks(pool.state.proxies[0])
    assert.equal(result.ok, true)
  } finally {
    pool.stopScheduler()
    server.close()
  }
})

test('probeAll resurrects a probe-killed proxy', async () => {
  const socks = await listenSocks()
  const pool = new ProxyPool({ dataDir: tmpDir() })
  pool.stopScheduler()
  try {
    pool.importLines(`${socks.host}:${socks.port}`)
    const p = pool.state.proxies[0]
    p.enabled = false
    p.status = 'dead'
    p.last_error = 'connection_closed'
    p.consecutive_failures = 2
    const report = await pool.probeAll()
    assert.equal(report.ok, true)
    assert.equal(pool.state.proxies[0].enabled, true)
    assert.equal(pool.state.proxies[0].status, 'ok')
  } finally {
    pool.stopScheduler()
    socks.server.close()
  }
})

test('ensureLocal adds a single local egress row', () => {
  const pool = makePool()
  const first = pool.ensureLocal()
  const second = pool.ensureLocal()
  assert.equal(first.ok, true)
  assert.equal(first.created, true)
  assert.equal(first.proxy.kind, 'local')
  assert.equal(first.proxy.id, 'px-local')
  assert.equal(second.created, false)
  assert.equal(pool.snapshot().proxies.filter((p) => p.kind === 'local').length, 1)
  const bound = pool.bind('px-local', 'vm-01')
  assert.equal(bound.ok, true)
  const auth = pool.getProxyForVm('vm-01')
  assert.equal(auth.scheme, 'local')
  assert.equal(auth.url, '')
})

test('local egress probe stays direct when kin-egress is down', async () => {
  const disabled = []
  const pool = new ProxyPool({
    dataDir: tmpDir(),
    egressCheck: () => ({ ok: false, reason: 'local_network_missing' }),
    onDisableVm: (vmId) => disabled.push(vmId),
  })
  pool.stopScheduler()
  pool.ensureLocal()
  pool.bind('px-local', 'vm-01')
  const row = pool.state.proxies.find((p) => p.id === 'px-local')
  const result = await pool.probeOne(row)
  assert.equal(result.ok, true)
  assert.equal(result.scope, 'local')
  assert.equal(result.mode, 'direct')
  pool._applyProbeResult(row, result)
  assert.equal(row.status, 'ok')
  assert.equal(row.enabled, true)
  assert.equal(disabled.length, 0)
})
