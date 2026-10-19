import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { runFleetUpdate, fleetStatus, isWorkerProcessUp, restartLocalEgress } from '../../src/lib/vm/fleet-update.mjs'
import { startEgressProcess, inspectEgressProcess } from '../../src/lib/vm/egress.mjs'

function writeSlot(root, id, extra = {}) {
  const dir = path.join(root, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      name: id.replace('vm-', ''),
      status: 'running',
      runtime: { type: 'docker', worker: 'go' },
      fingerprint: { device_id: id, session_id: 's' },
      ...extra,
    }),
  )
}

test('fleet roll reloads then collects every target', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-fleet-'))
  writeSlot(root, 'vm-01')
  writeSlot(root, 'vm-02')
  writeSlot(root, 'vm-03', { runtime: { type: 'kvm' } })
  const reloads = []
  const collects = []
  const report = await runFleetUpdate(root, {
    action: 'roll',
    concurrency: 2,
    reloadFn: (vm) => {
      reloads.push(vm.id)
      return { ok: true, action: 'reloaded' }
    },
    collectFn: async (_root, vm) => {
      collects.push(vm.id)
      return { ok: true, id: vm.id }
    },
    healthFn: async () => ({ ok: true, status: 'ready' }),
    readyTimeoutMs: 50,
  })
  assert.equal(report.total, 3)
  assert.equal(report.ok_count, 3)
  assert.equal(report.failed_count, 0)
  assert.deepEqual(reloads.sort(), ['vm-01', 'vm-02', 'vm-03'])
  assert.deepEqual(collects.sort(), ['vm-01', 'vm-02', 'vm-03'])
  fs.rmSync(root, { recursive: true, force: true })
})

test('fleet reload awaits engine-aware runtime and passes routing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-fleet-rust-'))
  writeSlot(root, 'vm-13', { inference_engine: 'rust' })
  const routing = { inference: { engine: 'rust' } }
  const events = []
  const report = await runFleetUpdate(root, {
    action: 'roll',
    routing,
    reloadFn: async (vm, projectRoot, opts) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      events.push(['reload', vm.id, projectRoot, opts.routing])
      return { ok: true, action: 'reloaded', rust_ok: true }
    },
    collectFn: async () => {
      events.push(['collect'])
      return { ok: true, id: 'vm-13' }
    },
    healthFn: async () => ({ ok: true, status: 'ready' }),
    readyTimeoutMs: 50,
  })
  assert.equal(report.ok_count, 1)
  assert.deepEqual(events[0], ['reload', 'vm-13', root, routing])
  assert.deepEqual(events[1], ['collect'])
  fs.rmSync(root, { recursive: true, force: true })
})

test('degraded worker without OAuth still counts as up', () => {
  assert.equal(isWorkerProcessUp({ ok: false, status: 'degraded', vm_id: 'vm-02' }), true)
  assert.equal(isWorkerProcessUp({ code: 'worker_unavailable' }), false)
})

test('fleet telemetry uses injected telemetryFn with options object', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-fleet-tel-'))
  writeSlot(root, 'vm-01', { node_id: 'node-a' })
  const calls = []
  const report = await runFleetUpdate(root, {
    action: 'telemetry',
    telemetryFn: async (opts) => {
      calls.push(opts)
      return { ok: true, action: 'restarted' }
    },
  })
  assert.equal(report.ok_count, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].vm.id, 'vm-01')
  assert.equal(calls[0].projectRoot, root)
  assert.equal(calls[0].enabled, calls[0].telemetryEnabled)
  fs.rmSync(root, { recursive: true, force: true })
})

test('fleet collect skips reload', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-fleet-c-'))
  writeSlot(root, 'vm-01')
  let reloads = 0
  const report = await runFleetUpdate(root, {
    action: 'collect',
    reloadFn: () => {
      reloads += 1
      return { ok: true }
    },
    collectFn: async () => ({ ok: true, id: 'vm-01' }),
    healthFn: async () => ({ ok: true }),
  })
  assert.equal(reloads, 0)
  assert.equal(report.ok_count, 1)
  assert.equal(fleetStatus(root)[0].id, 'vm-01')
  fs.rmSync(root, { recursive: true, force: true })
})

test('fleet refresh replaces an egress process whose binary was deleted', {
  skip: process.platform !== 'linux',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-fleet-egress-'))
  const oldBin = path.join(root, 'kin-egress-old')
  const newBin = path.join(root, 'kin-egress')
  const source = process.env.KIN_EGRESS_BIN || path.resolve(import.meta.dirname, '../../bin/kin-egress')
  fs.copyFileSync(source, oldBin)
  fs.copyFileSync(source, newBin)
  fs.chmodSync(oldBin, 0o755)
  fs.chmodSync(newBin, 0o755)
  const proxy = { id: 'px-fleet', scheme: 'socks5', host: '192.0.2.1', port: 1080, url: 'socks5://192.0.2.1:1080' }
  writeSlot(root, 'vm-01', { proxy })
  const probe = net.createServer()
  const port = await new Promise((resolve) => probe.listen(0, '127.0.0.1', () => resolve(probe.address().port)))
  await new Promise((resolve) => probe.close(resolve))
  const previous = process.env.KIN_EGRESS_BIN
  process.env.KIN_EGRESS_BIN = newBin
  const orphan = await startEgressProcess({
    projectRoot: root,
    proxyId: proxy.id,
    proxyUrl: 'socks5h://192.0.2.1:1080',
    listenHost: '127.0.0.1',
    tcpPort: port,
    dnsPort: 0,
    bin: oldBin,
  })
  assert.equal(orphan.ok, true, orphan.error)
  fs.unlinkSync(oldBin)
  fs.writeFileSync(path.join(root, 'data/run/egress/px-fleet/egress.pid'), '999999999\n')
  const egressOpts = {
    runDocker: (args) =>
      args[0] === 'network' && args[1] === 'inspect' ? { ok: true, stdout: '127.0.0.0/8|127.0.0.1' } : { ok: true },
    runIptables: () => ({ ok: true }),
    listenHost: '127.0.0.1',
    ports: { tcp: port, dns: 0 },
    bin: newBin,
  }
  try {
    const report = await runFleetUpdate(root, {
      action: 'telemetry',
      telemetryFn: async ({ projectRoot, vm }) => restartLocalEgress(projectRoot, vm, egressOpts),
      healthFn: async () => ({ ok: true }),
    })
    assert.equal(report.failed_count, 0, JSON.stringify(report.items))
    const current = inspectEgressProcess(root, proxy.id)
    assert.equal(current.ok, true, JSON.stringify(current))
    assert.notEqual(current.pid, orphan.pid)
    assert.equal(fs.readlinkSync(`/proc/${current.pid}/exe`), newBin)
    assert.equal(fs.existsSync(`/proc/${orphan.pid}`), false)
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(root, 'data/run/egress/px-fleet/egress.json'), 'utf8')).listen_tcp,
      `127.0.0.1:${port}`,
    )
    process.kill(current.pid, 'SIGTERM')
  } finally {
    if (previous === undefined) delete process.env.KIN_EGRESS_BIN
    else process.env.KIN_EGRESS_BIN = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('concurrent fleet telemetry on two slots sharing one proxy restarts egress once', {
  skip: process.platform !== 'linux',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-fleet-shared-'))
  const bin = process.env.KIN_EGRESS_BIN || path.resolve(import.meta.dirname, '../../bin/kin-egress')
  const proxy = { id: 'px-shared', scheme: 'socks5', host: '192.0.2.1', port: 1080, url: 'socks5://192.0.2.1:1080' }
  writeSlot(root, 'vm-01', { proxy })
  writeSlot(root, 'vm-02', { proxy })
  const probe = net.createServer()
  const port = await new Promise((resolve) => probe.listen(0, '127.0.0.1', () => resolve(probe.address().port)))
  await new Promise((resolve) => probe.close(resolve))
  const egressOpts = {
    runDocker: (args) =>
      args[0] === 'network' && args[1] === 'inspect' ? { ok: true, stdout: '127.0.0.0/8|127.0.0.1' } : { ok: true },
    runIptables: () => ({ ok: true }),
    listenHost: '127.0.0.1',
    ports: { tcp: port, dns: 0 },
    bin,
  }
  let restartCalls = 0
  try {
    const report = await runFleetUpdate(root, {
      action: 'telemetry',
      concurrency: 4,
      telemetryFn: async ({ projectRoot, vm }) => {
        restartCalls += 1
        return restartLocalEgress(projectRoot, vm, egressOpts)
      },
      healthFn: async () => ({ ok: true }),
    })
    assert.equal(restartCalls, 2)
    assert.equal(report.failed_count, 0, JSON.stringify(report.items))
    const current = inspectEgressProcess(root, proxy.id)
    assert.equal(current.ok, true, JSON.stringify(current))
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(root, 'data/run/egress/px-shared/egress.json'), 'utf8')).listen_tcp,
      `127.0.0.1:${port}`,
    )
    process.kill(current.pid, 'SIGTERM')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
