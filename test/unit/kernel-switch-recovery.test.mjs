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
import { bindPlacement, unbindPlacement } from '../../src/lib/cluster/placement.mjs'
import { unitCircuit } from '../../src/lib/pool/unit-circuit.mjs'
import { activateCragLicense, cragLicenseDirectory, projectCragUniversalVm } from '../../src/lib/vm/crag-license.mjs'
import { getVm } from '../../src/lib/vm/vm-registry.mjs'
import { kernelFaults, rustKernelBusy, rustKernelReachable } from '../../src/lib/transport/rust-kernel-client.mjs'
import { writeKernelConfig } from '../../src/lib/transport/rust-kernel-supervisor.mjs'
import { diagnoseSlotServices, powerOnSlot, recoverSlot } from '../../src/lib/vm/slot-recovery.mjs'
import { activateFixture, issueUniversalCode, seedEncryptedPackage } from '../fixtures/crag-license.mjs'

function fixture(t, extra = {}, { universalBeforeSlot = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-switch-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let universalCode
  if (universalBeforeSlot) {
    seedEncryptedPackage(root)
    universalCode = issueUniversalCode(root).code
    activateCragLicense(root, { id: 'vm-license-source' }, universalCode)
  }
  const vm = { id: 'vm-switch', status: 'running', dataplane: 'wrap', claude: { has_access: true }, ...extra }
  fs.mkdirSync(path.join(root, 'vms', vm.id), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  fs.mkdirSync(path.join(root, 'share', 'wrap-cli'), { recursive: true })
  for (const name of ['cli-node', 'cc-node', 'kin-kernel.bin'])
    fs.writeFileSync(path.join(root, 'share', 'wrap-cli', name), 'fixture-cli', { mode: 0o755 })
  t.after(() => unitCircuit.reset(vm.id))
  return { root, vm, universalCode }
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

for (const placement of ['local', 'cluster']) {
  for (const entry of ['slot', 'targets', 'default']) {
    test(`${placement} KVM ${entry} switches both kernels through guest restart and preserves scheduling`, async (t) => {
      const priorHold = { reason: 'proxy_cooldown', detail: { tag: 'proxy-owned' } }
      const parked = { reason: 'oauth_revoked' }
      const { root, vm, universalCode } = fixture(
        t,
        {
          dataplane: entry === 'default' ? undefined : 'wrap',
          ...(placement === 'cluster' ? { node_id: 'node-1' } : {}),
          runtime: { type: 'kvm', container: 'kin-kvm-switch' },
          machine: { mac: '02:00:00:00:00:01', disk_serial: 'kept-disk' },
          fingerprint: { guest_machine_id: 'a'.repeat(32), device_id: 'kept-device' },
          policy: { maxConcurrency: 8, concurrencyOverride: true },
          schedule_off: true,
          schedule_hold: priorHold,
          unschedulable: parked,
        },
        { universalBeforeSlot: true },
      )
      const registration = path.join(cragLicenseDirectory(root, vm), 'registration.code')
      assert.equal(fs.existsSync(registration), false)
      const routing = { inference: { dataplane: 'wrap' } }
      const events = []
      let grantPublished = false
      const operations = {
        routingConfig: routing,
        persistRoutingPatch: async (patch) => {
          assert.equal(grantPublished, true, 'grant publication must precede a new inherited default')
          Object.assign(routing.inference, patch.inference)
        },
        kernelWatchdog: {
          hold: async () => events.push('hold'),
          release: () => events.push('release'),
          reset: () => events.push('reset'),
        },
        kernelPolicyOps: {
          projectCragUniversalVm: async (project, selected) => {
            assert.equal(project, root)
            assert.equal(selected.id, vm.id)
            assert.equal(getVm(root, vm.id).dataplane, vm.dataplane)
            assert.equal(getVm(root, vm.id).schedule_hold.reason, 'maintenance')
            assert.equal(routing.inference.dataplane, 'wrap')
            if (placement === 'local') await projectCragUniversalVm(project, selected)
            else await new Promise(setImmediate)
            grantPublished = true
            events.push('project')
            return { ok: true }
          },
          writeKernelConfig: (project, selected, options) => {
            assert.equal(grantPublished, true, 'guest configuration must wait for grant publication')
            events.push('configure')
            return writeKernelConfig(project, selected, { ...options, publish: false })
          },
          startSlotReady: async () => assert.fail('KVM kernel switching must not recreate the Docker runner'),
          restartRustKernel: async (exec) => {
            assert.equal(exec.projectRoot, root)
            assert.equal(exec.vm.runtime.type, 'kvm')
            assert.equal(exec.vm.runtime.container, vm.runtime.container)
            assert.equal(exec.vm.node_id, vm.node_id)
            assert.equal(getVm(root, vm.id).schedule_hold.reason, 'maintenance')
            events.push('restart')
            return { ok: true }
          },
        },
      }
      for (const target of ['crag', 'wrap']) {
        const response =
          entry === 'slot'
            ? await request(root, 'PATCH', '', { dataplane: target }, operations)
            : await request(
                root,
                'POST',
                '',
                { dataplane: target, ...(entry === 'default' ? { all: true } : { ids: [vm.id] }) },
                operations,
                '/dataplane',
              )
        assert.equal(response.status, 200, JSON.stringify(response.body))
        if (entry !== 'slot') assert.equal(response.body.data.ok_count, 1)
        const saved = getVm(root, vm.id)
        assert.equal(saved.dataplane, entry === 'default' ? undefined : target)
        assert.equal(saved.status, 'running')
        assert.equal(saved.schedule_off, true)
        assert.deepEqual(saved.schedule_hold, priorHold)
        assert.deepEqual(saved.unschedulable, parked)
        assert.deepEqual(saved.policy, vm.policy)
        assert.deepEqual(saved.machine, vm.machine)
        assert.deepEqual(saved.fingerprint, vm.fingerprint)
        assert.deepEqual(saved.claude, vm.claude)
        assert.deepEqual(saved.runtime, vm.runtime)
        const config = JSON.parse(fs.readFileSync(path.join(root, 'vms', vm.id, 'run', 'kernel.json')))
        assert.equal(config.dataplane, target)
        assert.equal(config.runtime_kind, 'kvm')
        assert.equal(config.socket_path, '/run/kin-guest/kernel.sock')
        assert.equal(config.license_dir, target === 'crag' ? '/run/kin/crag-license' : undefined)
        if (placement === 'local') assert.equal(fs.readFileSync(registration, 'utf8').trim(), universalCode)
      }
      assert.deepEqual(events, [
        'hold',
        'project',
        'configure',
        'restart',
        'reset',
        'release',
        'hold',
        'configure',
        'restart',
        'reset',
        'release',
      ])
    })

    test(`${placement} KVM ${entry} projection failure leaves the old kernel and policy intact`, async (t) => {
      const priorHold = { reason: 'proxy_cooldown', detail: { tag: 'proxy-owned' } }
      const { root, vm } = fixture(
        t,
        {
          dataplane: entry === 'default' ? undefined : 'wrap',
          ...(placement === 'cluster' ? { node_id: 'node-1' } : {}),
          runtime: { type: 'kvm', container: 'kin-kvm-switch' },
          policy: { maxConcurrency: 8, concurrencyOverride: true },
          schedule_off: true,
          schedule_hold: priorHold,
        },
        { universalBeforeSlot: true },
      )
      const kernelFile = path.join(root, 'vms', vm.id, 'cli-home', '.kin', 'kin-kernel')
      const configFile = path.join(root, 'vms', vm.id, 'run', 'kernel.json')
      for (const file of [kernelFile, configFile]) {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, 'existing-kernel-state')
      }
      const routing = { inference: { dataplane: 'wrap' } }
      const events = []
      const operations = {
        routingConfig: routing,
        persistRoutingPatch: async () => assert.fail('failed projection must not change the global default'),
        kernelWatchdog: {
          hold: async () => events.push('hold'),
          release: () => events.push('release'),
          reset: () => assert.fail('failed projection must not reset kernel health'),
        },
        kernelPolicyOps: {
          projectCragUniversalVm: async () => {
            assert.equal(getVm(root, vm.id).schedule_hold.reason, 'maintenance')
            assert.equal(getVm(root, vm.id).dataplane, vm.dataplane)
            events.push('project')
            if (placement === 'local') throw new Error('license directory unavailable')
            return { ok: false, error: 'node unavailable' }
          },
          writeKernelConfig: () => assert.fail('failed projection must not publish kernel config'),
          restartRustKernel: async () => assert.fail('failed projection must not restart the guest'),
          startSlotReady: async () => assert.fail('failed projection must not recreate the runner'),
        },
      }
      const response =
        entry === 'slot'
          ? await request(root, 'PATCH', '', { dataplane: 'crag' }, operations)
          : await request(
              root,
              'POST',
              '',
              { dataplane: 'crag', ...(entry === 'default' ? { all: true } : { ids: [vm.id] }) },
              operations,
              '/dataplane',
            )
      assert.equal(response.status, 503, JSON.stringify(response.body))
      assert.equal(response.body.error.code, 'crag_license_projection_failed')
      const saved = getVm(root, vm.id)
      assert.equal(saved.dataplane, vm.dataplane)
      assert.equal(saved.crag_kernel_version, undefined)
      assert.equal(saved.status, vm.status)
      assert.equal(saved.schedule_off, true)
      assert.deepEqual(saved.schedule_hold, priorHold)
      assert.equal(saved.unschedulable, undefined)
      assert.deepEqual(saved.policy, vm.policy)
      assert.deepEqual(saved.runtime, vm.runtime)
      assert.deepEqual(saved.claude, vm.claude)
      assert.equal(routing.inference.dataplane, 'wrap')
      for (const file of [kernelFile, configFile]) assert.equal(fs.readFileSync(file, 'utf8'), 'existing-kernel-state')
      assert.equal(fs.existsSync(path.join(cragLicenseDirectory(root, vm), 'registration.code')), false)
      assert.deepEqual(events, ['hold', 'project', 'release'])
    })

    test(`unlicensed ${placement} KVM ${entry} cannot switch or change scheduling`, async (t) => {
      const { root, vm } = fixture(t, {
        dataplane: entry === 'default' ? undefined : 'wrap',
        ...(placement === 'cluster' ? { node_id: 'node-1' } : {}),
        runtime: { type: 'kvm' },
        schedule_off: true,
      })
      seedEncryptedPackage(root)
      const record = fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`))
      const operations = {
        routingConfig: { inference: { dataplane: 'wrap' } },
        persistRoutingPatch: async () => assert.fail('unlicensed switch must not change the global default'),
        kernelWatchdog: { hold: async () => assert.fail('unlicensed switch must not enter maintenance') },
        kernelPolicyOps: {
          restartRustKernel: async () => assert.fail('unlicensed switch must not restart the guest'),
          startSlotReady: async () => assert.fail('unlicensed switch must not recreate the runner'),
        },
      }
      const response =
        entry === 'slot'
          ? await request(root, 'PATCH', '', { dataplane: 'crag' }, operations)
          : await request(
              root,
              'POST',
              '',
              { dataplane: 'crag', ...(entry === 'default' ? { all: true } : { ids: [vm.id] }) },
              operations,
              '/dataplane',
            )
      assert.equal(response.status, 403, JSON.stringify(response.body))
      assert.match(response.body.error.code, /^license_/)
      assert.deepEqual(fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`)), record)
      assert.equal(fs.existsSync(path.join(root, 'vms', vm.id, 'run', 'kernel.json')), false)
    })
  }
}

test('native macOS still rejects licensed CRAG switching through both legacy endpoints', async (t) => {
  const { root, vm } = fixture(t, { node_id: 'node-mac', node_platform: 'darwin' })
  bindPlacement({ projectRoot: root, manager: { nodePlatform: () => 'darwin' } })
  t.after(unbindPlacement)
  seedEncryptedPackage(root)
  activateCragLicense(root, vm, issueUniversalCode(root).code)
  const record = fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`))
  const operations = {
    kernelPolicyOps: {
      restartRustKernel: async () => assert.fail('native macOS must not start CRAG'),
      startSlotReady: async () => assert.fail('native macOS must not recreate a Docker runner'),
    },
  }
  const single = await request(root, 'PATCH', '', { dataplane: 'crag' }, operations)
  assert.equal(single.body.error.code, 'native_crag_unsupported')
  const global = await request(root, 'POST', '', { dataplane: 'crag', ids: [vm.id] }, operations, '/dataplane')
  assert.equal(global.status, 400)
  assert.equal(global.body.error.code, 'remote_unsupported')
  assert.deepEqual(fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`)), record)
})

for (const [label, placement, endpoint] of [
  ['local legacy KVM', { runtime_type: 'kvm' }, 'patch'],
  ['remote KVM', { node_id: 'node-kvm', runtime: { type: 'kvm' } }, 'selected'],
  ['inherited QEMU', { runtime: { type: 'qemu' } }, 'all'],
]) {
  test(`${label} switches CRAG in both directions without recreating the guest`, async (t) => {
    const priorHold = { reason: 'proxy_cooldown', detail: { tag: 'proxy-owned' } }
    const { root, vm } = fixture(t, {
      ...placement,
      ...(endpoint === 'all' ? { dataplane: undefined } : {}),
      schedule_off: true,
      schedule_hold: priorHold,
    })
    seedEncryptedPackage(root)
    activateCragLicense(root, vm, issueUniversalCode(root).code)
    const routing = { inference: { dataplane: 'wrap' } }
    const selections = []
    for (const target of ['crag', 'wrap']) {
      const response = await request(
        root,
        endpoint === 'patch' ? 'PATCH' : 'POST',
        '',
        {
          dataplane: target,
          ...(endpoint === 'selected' ? { ids: [vm.id] } : endpoint === 'all' ? { all: true } : {}),
        },
        {
          routingConfig: routing,
          persistRoutingPatch: async (patch) => Object.assign(routing.inference, patch.inference),
          kernelPolicyOps: {
            projectCragUniversalVm: async (project, selected) =>
              selected.node_id ? { ok: true } : projectCragUniversalVm(project, selected),
            writeKernelConfig: (project, selected, options) =>
              writeKernelConfig(project, selected, { ...options, publish: false }),
            startSlotReady: async () => assert.fail('kernel switching must preserve the KVM guest'),
            restartRustKernel: async () => {
              const selected = getVm(root, vm.id)
              assert.equal(selected.schedule_hold.reason, 'maintenance')
              const config = JSON.parse(fs.readFileSync(path.join(root, 'vms', vm.id, 'run/kernel.json')))
              assert.equal(config.dataplane, target)
              assert.equal(config.runtime_kind, 'kvm')
              assert.equal(config.socket_path, '/run/kin-guest/kernel.sock')
              if (target === 'crag') {
                assert.equal(config.runtime_variant, 'crag-v2')
                assert.match(config.claude_bin, /crag-v2\/claude-code-[^/]+\/claude$/)
                assert.equal(config.license_dir, '/run/kin/crag-license')
              } else {
                assert.equal(config.runtime_variant, undefined)
                assert.equal(config.license_dir, undefined)
              }
              selections.push(config.dataplane)
              return { ok: true }
            },
          },
        },
        endpoint === 'patch' ? '/vms/vm-switch' : '/dataplane',
      )
      assert.equal(response.status, 200, JSON.stringify(response.body))
      if (endpoint !== 'patch') assert.equal(response.body.data.ok_count, 1)
      const saved = getVm(root, vm.id)
      assert.equal(endpoint === 'all' ? routing.inference.dataplane : saved.dataplane, target)
      assert.equal(saved.status, 'running')
      assert.equal(saved.schedule_off, true)
      assert.deepEqual(saved.schedule_hold, priorHold)
    }
    assert.deepEqual(selections, ['crag', 'wrap'])
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
