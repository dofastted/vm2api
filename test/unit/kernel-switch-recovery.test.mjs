import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import http from 'node:http'
import {
  dispatchCallInference,
  rememberRustHealth,
  clearRustHealthCache,
} from '../../src/lib/transport/kernel-router.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { unitCircuit } from '../../src/lib/pool/unit-circuit.mjs'
import { getVm } from '../../src/lib/vm/vm-registry.mjs'
import { kernelFaults, rustKernelBusy, rustKernelReachable } from '../../src/lib/transport/rust-kernel-client.mjs'
import { diagnoseSlotServices, powerOnSlot, recoverSlot } from '../../src/lib/vm/slot-recovery.mjs'
import { activateFixture, seedEncryptedPackage } from '../fixtures/crag-license.mjs'

function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-switch-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vm = { id: 'vm-switch', status: 'running', dataplane: 'wrap', claude: { has_access: true }, ...extra }
  fs.mkdirSync(path.join(root, 'vms', vm.id), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  fs.mkdirSync(path.join(root, 'share', 'wrap-cli'), { recursive: true })
  for (const name of ['cli-node', 'cc-node', 'kin-kernel.bin'])
    fs.writeFileSync(path.join(root, 'share', 'wrap-cli', name), 'fixture-cli', { mode: 0o755 })
  t.after(() => unitCircuit.reset(vm.id))
  return { root, vm }
}

async function request(root, method, suffix, body, extra = {}, endpoint = '/vms/vm-switch') {
  const response = {}
  const handle = createPanelHandler({
    cfg: { paths: { project: root }, vm: { id: null } },
    routingConfig: {},
    requireAuth(req) {
      req.apiKeyKind = 'master'
      req.panelRole = 'admin'
      return true
    },
    readBody: async () => body,
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
    proxyPool: { unbindVm() {} },
    ...extra,
  })
  await handle({ method }, {}, new URL(`http://localhost/api/panel${endpoint}${suffix}`))
  return response
}

test('switch holds admission and watchdog until the old request drains', async (t) => {
  const { root, vm } = fixture(t)
  const inflight = new Map([[vm.id, 1]])
  let releaseHold
  const pending = new Promise((resolve) => {
    releaseHold = resolve
  })
  const events = []
  const result = request(
    root,
    'PATCH',
    '',
    { dataplane: 'cc' },
    {
      poolScheduler: { vmInflight: inflight },
      kernelWatchdog: {
        hold() {
          events.push('hold')
          return pending
        },
        release() {
          events.push('release')
        },
        reset() {
          events.push('reset')
        },
      },
      kernelPolicyOps: {
        restartRustKernel: async () => {
          assert.equal(inflight.get(vm.id), 0, 'no accepted request may be killed by cutover')
          assert.equal(getVm(root, vm.id).schedule_hold.reason, 'maintenance')
          events.push('restart')
          return { ok: true }
        },
      },
    },
  )
  await new Promise(setImmediate)
  assert.equal(getVm(root, vm.id).dataplane, 'wrap', 'watchdog drain precedes metadata and file changes')
  releaseHold()
  await new Promise(setImmediate)
  assert.equal(getVm(root, vm.id).dataplane, 'wrap', 'accepted inference must drain before cutover')
  inflight.set(vm.id, 0)
  const response = await result
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.deepEqual(events, ['hold', 'restart', 'reset', 'release'])
  assert.equal(getVm(root, vm.id).schedule_hold, undefined)
})

for (const target of ['crag', 'wrap']) {
  test(`switch to ${target} verifies the recreated kernel and clears only repaired runtime gates`, async (t) => {
    const previous = target === 'crag' ? 'wrap' : 'crag'
    const priorHold = { reason: 'proxy_cooldown', detail: { tag: 'proxy-owned' } }
    const { root, vm } = fixture(t, { dataplane: previous, schedule_off: true, schedule_hold: priorHold })
    seedEncryptedPackage(root)
    activateFixture(root, vm)
    unitCircuit.recordFailure(vm.id)
    unitCircuit.recordFailure(vm.id)
    unitCircuit.recordFailure(vm.id)
    let booted = false
    const response = await request(
      root,
      'PATCH',
      '',
      { dataplane: target },
      {
        kernelPolicyOps: {
          startSlotReady: async (selected, project, options) => {
            assert.equal(selected.dataplane, target)
            assert.equal(project, root)
            assert.equal(options.recreate, true)
            assert.equal(getVm(root, vm.id).schedule_hold.reason, 'maintenance')
            booted = true
            return { ok: true, rust_ok: true, rust: { ok: true } }
          },
        },
      },
    )
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(booted, true)
    assert.equal(unitCircuit.view(vm.id).state, 'closed')
    assert.deepEqual(getVm(root, vm.id).schedule_hold, priorHold)
    assert.equal(getVm(root, vm.id).schedule_off, true)
  })
}

test('failed readiness blocks scheduling and retains the circuit for explicit recovery', async (t) => {
  const { root, vm } = fixture(t)
  seedEncryptedPackage(root)
  activateFixture(root, vm)
  for (let i = 0; i < 3; i++) unitCircuit.recordFailure(vm.id)
  const response = await request(
    root,
    'PATCH',
    '',
    { dataplane: 'crag' },
    {
      kernelPolicyOps: {
        startSlotReady: async () => ({ ok: true, rust_ok: false, rust: { ok: false, reason: 'health_timeout' } }),
      },
    },
  )
  assert.equal(response.status, 503)
  assert.equal(getVm(root, vm.id).unschedulable.reason, 'runtime_start_failed')
  assert.equal(unitCircuit.view(vm.id).state, 'open')
})

test('successful service recovery closes the request circuit, failed recovery does not', async (t) => {
  const { root, vm } = fixture(t)
  const fail = () => {
    for (let i = 0; i < 3; i++) unitCircuit.recordFailure(vm.id)
  }
  fail()
  const ops = {
    stopSlot: async () => ({ ok: true }),
    powerOn: async () => ({ ok: true, boot: { rust_ok: true } }),
    diagnose: async () => ({ ok: true, checks: [] }),
    settleMs: 0,
  }
  const recovered = await request(root, 'POST', '/recover', {}, { kernelRecoveryOps: ops })
  assert.equal(recovered.body.data.ok, true)
  assert.equal(unitCircuit.view(vm.id).state, 'closed')
  fail()
  const failed = await request(
    root,
    'POST',
    '/recover',
    {},
    {
      kernelRecoveryOps: { ...ops, diagnose: async () => ({ ok: false, checks: [] }) },
    },
  )
  assert.equal(failed.body.data.ok, false)
  assert.equal(unitCircuit.view(vm.id).state, 'open')
})

test('a saturated CRAG process pool is busy without a persistent CLI PID', () => {
  const health = {
    ok: true,
    status: 200,
    runtime_variant: 'crag-v2',
    healthy: true,
    ready: true,
    ready_slots: 0,
    closed_slots: 0,
    cli_pid: 0,
    active: 20,
    pids: [101, 102],
  }
  assert.equal(rustKernelBusy(health), true)
  assert.equal(rustKernelReachable(health), false)
  assert.equal(rustKernelBusy({ ...health, healthy: false }), false)
  assert.equal(rustKernelReachable({ ...health, ready_slots: 20, ready: false }), false)
})

test('CRAG diagnosis distinguishes a busy process pool from not-ready and invalid-license states', async (t) => {
  const { root, vm } = fixture(t, { dataplane: 'crag', proxy: { id: 'px-local' } })
  const health = {
    ok: true,
    status: 200,
    runtime_variant: 'crag-v2',
    healthy: true,
    ready: true,
    ready_slots: 0,
    closed_slots: 0,
    cli_pid: 0,
    active: 20,
  }
  const kernel = async (value) =>
    (
      await diagnoseSlotServices(vm, {
        projectRoot: root,
        probes: {
          container: async () => ({ exists: true, running: true }),
          localEgress: () => ({ ok: true }),
          rustHealth: async () => value,
        },
      })
    ).checks.find((c) => c.id === 'kernel')
  assert.equal((await kernel(health)).code, 'kernel_busy')
  assert.equal((await kernel({ ...health, ready: false })).code, 'kernel_not_ready')
  assert.equal((await kernel({ ...health, license_valid: false })).code, 'license_invalid')
  assert.equal((await kernel({ ...health, ready_slots: 20, active: 0 })).status, 'ok')
})

test('container-only boot failure cannot reopen a parked slot', async (t) => {
  const park = { reason: 'runtime_start_failed', detail: { code: 'previous' } }
  const { root, vm } = fixture(t, { proxy: { id: 'px-local' }, unschedulable: park })
  const booted = await powerOnSlot({
    projectRoot: root,
    id: vm.id,
    proxyPool: { ensureBoundToVm: () => vm.proxy },
    fillTimezone: async () => {},
    by: 'recover_ok',
    ops: { startSlotReady: async () => ({ ok: true, rust_ok: false, rust: { ok: false, reason: 'health_timeout' } }) },
  })
  assert.equal(booted.ok, false)
  assert.deepEqual(getVm(root, vm.id).unschedulable, park)
})

test('failed service boot keeps watchdog fault and original schedule park', async (t) => {
  const park = { reason: 'oauth_revoked' }
  const { root, vm } = fixture(t, { unschedulable: park })
  let reset = false
  const recovered = await recoverSlot({
    projectRoot: root,
    id: vm.id,
    proxyPool: {},
    watchdog: {
      reset() {
        reset = true
      },
    },
    ops: {
      stopSlot: async () => ({ ok: true }),
      powerOn: async () => ({ ok: false, code: 'kernel_start_failed' }),
      diagnose: async () => ({ ok: false, checks: [] }),
      settleMs: 0,
    },
  })
  assert.equal(recovered.report.ok, false)
  assert.equal(reset, false)
  assert.deepEqual(getVm(root, vm.id).unschedulable, park)
})

test('unlicensed CRAG recovery is rejected before stopping the current kernel', async (t) => {
  const { root, vm } = fixture(t, { dataplane: 'crag' })
  let stopped = false
  const recovered = await recoverSlot({
    projectRoot: root,
    id: vm.id,
    ops: {
      stopSlot: async () => {
        stopped = true
        return { ok: true }
      },
    },
  })
  assert.equal(recovered.status, 403)
  assert.equal(stopped, false)
  assert.equal(getVm(root, vm.id).schedule_hold, undefined)
})

for (const all of [false, true]) {
  test(`legacy dataplane ${all ? 'inherited default' : 'explicit slot'} uses guarded native cutover`, async (t) => {
    const { root, vm } = fixture(t, all ? { dataplane: undefined } : {})
    seedEncryptedPackage(root)
    activateFixture(root, vm)
    const routing = { inference: { dataplane: 'wrap' } }
    let booted = false
    const response = await request(
      root,
      'POST',
      '',
      { dataplane: 'crag', ...(all ? { all: true } : { ids: [vm.id] }) },
      {
        routingConfig: routing,
        persistRoutingPatch: async (patch) => {
          Object.assign(routing.inference, patch.inference)
        },
        kernelPolicyOps: {
          startSlotReady: async (selected, _root, options) => {
            assert.equal(options.recreate, true)
            assert.equal(getVm(root, vm.id).schedule_hold.reason, 'maintenance')
            assert.equal(all ? routing.inference.dataplane : selected.dataplane, 'crag')
            booted = true
            return { ok: true, rust_ok: true }
          },
        },
      },
      '/dataplane',
    )
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(booted, true)
    assert.equal(response.body.data.ok_count, 1)
    assert.equal(getVm(root, vm.id).schedule_hold, undefined)
    assert.equal(getVm(root, vm.id).dataplane, all ? undefined : 'crag')
  })
}

test('recovery clears only the old watchdog fault after all repaired services pass diagnosis', async (t) => {
  const { root, vm } = fixture(t, { dataplane: 'crag', proxy: { id: 'px-local' } })
  seedEncryptedPackage(root)
  activateFixture(root, vm)
  t.after(() => kernelFaults.delete(vm.id))
  let egressHealthy = false
  const watchdog = { reset: () => ({ faulted: kernelFaults.delete(vm.id) }) }
  const ops = {
    stopSlot: async () => ({ ok: true }),
    powerOn: async () => ({ ok: true, boot: { rust_ok: true } }),
    settleMs: 0,
    diagnose: (current) =>
      diagnoseSlotServices(current, {
        projectRoot: root,
        watchdog,
        probes: {
          localEgress: () => ({ ok: egressHealthy }),
          container: async () => ({ exists: true, running: true }),
          rustHealth: async () => ({ ok: true, runtime_variant: 'crag-v2', ready: true, ready_slots: 20, cli_pid: 0 }),
        },
      }),
  }
  kernelFaults.set(vm.id, 'spent before recovery')
  const broken = await recoverSlot({ projectRoot: root, id: vm.id, watchdog, ops })
  assert.equal(broken.report.ok, false)
  assert.equal(kernelFaults.get(vm.id), 'spent before recovery')
  egressHealthy = true
  const repaired = await recoverSlot({ projectRoot: root, id: vm.id, watchdog, ops })
  assert.equal(repaired.report.ok, true, JSON.stringify(repaired))
  assert.equal(kernelFaults.has(vm.id), false)
  assert.equal(repaired.report.diagnosis.checks.find((c) => c.id === 'watchdog').status, 'ok')
})

test('the first request after CRAG cutover uses the new kernel capabilities, not the old health cache', async (t) => {
  const { root, vm } = fixture(t, { dataplane: 'crag' })
  t.after(() => clearRustHealthCache(vm.id))
  rememberRustHealth(
    { vmId: vm.id },
    {
      ok: true,
      health: {
        ok: true,
        runtime_variant: 'crag-v2',
        ready_slots: 20,
        capabilities: ['prompt_append'],
      },
    },
  )
  const switched = await request(
    root,
    'PATCH',
    '',
    { dataplane: 'wrap' },
    {
      kernelPolicyOps: { startSlotReady: async () => ({ ok: true, rust_ok: true }) },
    },
  )
  assert.equal(switched.status, 200)
  const run = path.join(root, 'vms', vm.id, 'run')
  const socket = path.join(run, 'kernel.sock')
  let posted
  const server = http.createServer(async (req, res) => {
    if (req.url === '/internal/health') {
      res.end(JSON.stringify({ ok: true, engine: 'rust', runtime_variant: 'cli-node', ready_slots: 20 }))
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    posted = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    res.writeHead(200, { 'content-type': 'application/json', 'x-terminal-state': 'verified' })
    res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }))
  })
  await new Promise((resolve) => server.listen(socket, resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const previous = process.env.KIN_KERNEL_BIN
  process.env.KIN_KERNEL_BIN = '/bin/true'
  t.after(() => {
    if (previous == null) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = previous
  })
  const result = await dispatchCallInference({
    exec: {
      vmId: vm.id,
      projectRoot: root,
      vm: getVm(root, vm.id),
      homeDir: path.join(root, 'vms', vm.id, 'cli-home'),
    },
    routing: { inference: { engine: 'rust' } },
    cliHop: true,
    timeoutMs: 3000,
    body: {
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'hello' }],
      crag_prompt: { mode: 'append', text: 'caller instruction' },
    },
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(posted.body.crag_prompt, undefined, 'a cli-node kernel must not receive cached CRAG-only fields')
})
