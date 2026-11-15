import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { runFleetUpdate, fleetStatus, isWorkerProcessUp, applyNativeTelemetry } from '../../src/lib/vm/fleet-update.mjs'

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

test('fleet collection bounds concurrency and visits every slot', { timeout: 2000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-fleet-concurrency-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const id of ['vm-01', 'vm-02', 'vm-03', 'vm-04']) writeSlot(root, id)
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let notifyStarted
  const started = new Promise((resolve) => {
    notifyStarted = resolve
  })
  const collected = []
  let active = 0
  let peak = 0
  const pending = runFleetUpdate(root, {
    action: 'collect',
    concurrency: 2,
    collectFn: async (_root, vm) => {
      collected.push(vm.id)
      active += 1
      peak = Math.max(peak, active)
      if (collected.length === 2) notifyStarted()
      await gate
      active -= 1
      return { ok: true, id: vm.id }
    },
  })
  try {
    await started
    assert.equal(active, 2)
    assert.equal(collected.length, 2, 'queued slots must wait for a free worker')
  } finally {
    release()
  }
  const report = await pending
  assert.equal(peak, 2)
  assert.equal(active, 0)
  assert.deepEqual(collected.sort(), ['vm-01', 'vm-02', 'vm-03', 'vm-04'])
  assert.equal(report.total, 4)
  assert.equal(report.ok_count, 4)
  assert.equal(report.failed_count, 0)
})

test('native telemetry publication uses the current stored VM kind and reports unsupported without writes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-fleet-current-kind-'))
  try {
    writeSlot(root, 'vm-01', { family: 'codex', seed_policy: { telemetry_disabled: true } })
    const file = path.join(root, 'vms', 'vm-01.json')
    const before = fs.readFileSync(file, 'utf8')
    const result = await applyNativeTelemetry({
      projectRoot: root,
      vm: { id: 'vm-01', family: 'claude', seed_policy: { telemetry_disabled: false } },
    })
    assert.equal(result.ok, false)
    assert.equal(result.supported, false)
    assert.equal(result.state, 'unsupported')
    assert.equal(result.code, 'telemetry_unsupported')
    assert.equal(result.wrote, false)
    assert.equal(result.published, false)
    assert.equal(result.applied, false)
    assert.equal(fs.readFileSync(file, 'utf8'), before)
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-01', 'cli-home')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('CRAG telemetry publishes settings, uses authenticated apply, and restores scheduling after restart', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-crag-telemetry-'))
  const id = 'vm-01'
  const slotDir = path.join(root, 'vms', id)
  const runDir = path.join(slotDir, 'run')
  const settingsPath = path.join(slotDir, 'cli-home', '.claude', 'settings.json')
  const vmPath = path.join(root, 'vms', `${id}.json`)
  const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
  writeSlot(root, id, { dataplane: 'crag', schedulable: true, seed_policy: { telemetry_disabled: false } })
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'internal.token'), 'fixture-internal-token')
  fs.writeFileSync(
    path.join(runDir, 'kernel.json'),
    JSON.stringify({ vm_id: id, dataplane: 'crag', runtime_variant: 'crag-v2' }),
  )
  const events = []
  let capability = true
  let active = 0
  let bootEnabled = false
  let nextError = null
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.headers['x-internal-token'] !== 'fixture-internal-token') {
      res.writeHead(401).end('{}')
      return
    }
    if (req.url === '/internal/health') {
      res.end(
        JSON.stringify({
          ok: true,
          runtime_variant: 'crag-v2',
          crag_telemetry_apply_v1: capability,
          active,
          waiting: 0,
          queued: 0,
        }),
      )
      return
    }
    if (req.url !== '/internal/v1/telemetry/apply' || req.method !== 'POST') {
      res.writeHead(404).end('{}')
      return
    }
    let value = ''
    for await (const chunk of req) value += chunk
    const { enabled } = JSON.parse(value)
    events.push(['apply', enabled])
    if (nextError || enabled !== bootEnabled) {
      res.writeHead(409).end(JSON.stringify({ error: { type: nextError || 'telemetry_restart_required' } }))
      return
    }
    res.end(
      JSON.stringify({ ok: true, applied: true, enabled, scope: 'native_claude_launch', upload_confirmed: false }),
    )
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(path.join(runDir, 'kernel.sock'), resolve))
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const vm = { id }
  let running = true
  const lifecycle = {
    watchdog: {
      hold: () => events.push(['hold']),
      release: () => events.push(['release']),
    },
    poolScheduler: { vmInflight: new Map(), healthCache: new Map() },
  }
  const ops = {
    retire: async () => ({ ok: true, running }),
    restart: async () => {
      assert.equal(read(vmPath).schedule_hold.reason, 'maintenance')
      assert.equal(read(vmPath).schedulable, false)
      events.push(['restart'])
      bootEnabled =
        read(path.join(path.dirname(settingsPath), 'kin-seed.json')).seed_policy.telemetry_disabled === false
      return { ok: true }
    },
  }
  const apply = () => applyNativeTelemetry({ projectRoot: root, vm, lifecycle, ops })
  const enabled = await apply()
  assert.equal(enabled.ok, true, enabled.error)
  assert.equal(enabled.applied, true)
  assert.equal(enabled.upload_confirmed, false)
  assert.equal(enabled.scope, 'native_claude_launch')
  assert.deepEqual(events.splice(0), [
    ['apply', true],
    ['hold'],
    ['apply', true],
    ['restart'],
    ['apply', true],
    ['release'],
  ])
  assert.equal(read(vmPath).schedulable, true)
  assert.equal(read(vmPath).schedule_hold, undefined)
  assert.equal(read(settingsPath).env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined)
  assert.equal((await apply()).applied, true)
  assert.deepEqual(events.splice(0), [['apply', true]])

  writeSlot(root, id, {
    dataplane: 'crag',
    status: 'paused',
    schedulable: false,
    schedule_off: true,
    seed_policy: { telemetry_disabled: true },
  })
  active = 1
  assert.equal((await apply()).code, 'telemetry_slot_busy')
  assert.equal(
    events.some(([event]) => event === 'restart'),
    false,
  )
  assert.equal(read(vmPath).schedule_off, true)
  assert.equal(read(vmPath).status, 'paused')
  assert.equal(read(vmPath).schedule_hold, undefined)
  events.length = 0
  active = 0
  const configPath = path.join(runDir, 'kernel.json')
  const originalConfig = fs.readFileSync(configPath)
  fs.writeFileSync(configPath, JSON.stringify({ vm_id: id, dataplane: 'wrap' }))
  assert.equal((await apply()).code, 'crag_telemetry_kernel_mismatch')
  assert.equal(
    events.some(([event]) => event === 'restart'),
    false,
  )
  fs.writeFileSync(configPath, originalConfig)
  assert.equal((await apply()).applied, true)
  assert.equal(bootEnabled, false)
  assert.equal(read(settingsPath).env.DISABLE_TELEMETRY, '1')
  assert.equal(read(vmPath).schedulable, false)
  assert.equal(read(vmPath).status, 'paused')
  events.length = 0

  nextError = 'telemetry_native_settings_blocked'
  assert.equal((await apply()).code, nextError)
  assert.deepEqual(events.splice(0), [['apply', false]])
  nextError = null
  capability = false
  assert.equal((await apply()).code, 'crag_telemetry_apply_unavailable')
  assert.deepEqual(events, [])
  running = false
  const stopped = await apply()
  assert.equal(stopped.state, 'stopped')
  assert.equal(stopped.published, true)
  assert.equal(stopped.applied, false)
  assert.deepEqual(events, [])
})
