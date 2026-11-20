import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { installKernelTargets, resumePendingKernelInstalls } from '../../src/lib/vm/kernel-install.mjs'
import { getVm, patchVmRecord } from '../../src/lib/vm/vm-registry.mjs'
import {
  activateCragLicense,
  activateCragSubscriptionBinding,
  cragLicenseDirectory,
  prepareCragSubscriptionBinding,
  readCragSubscriptionReleaseCandidate,
} from '../../src/lib/vm/crag-license.mjs'
import { materializeSlotDataplane } from '../../src/lib/vm/wrap-cli-runtime.mjs'
import { cragSubscriptionPublicDirectory } from '../../src/lib/vm/crag-subscription-paths.mjs'
import { createCragSubscription } from '../../src/lib/vm/crag-subscription.mjs'
import {
  issueHostEntitlement,
  issueSlotPermit,
  issueUniversalCode,
  seedEncryptedPackage,
  signSubscriptionBytes,
} from '../fixtures/crag-license.mjs'

const linuxTest = process.platform === 'linux' ? test : test.skip

function fixture(t, { inherited = false, vm: overrides = {}, h2 = true, binding = 'subscription' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-seat-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vm = {
    id: 'vm-release',
    status: 'running',
    dataplane: inherited ? undefined : 'crag',
    crag_kernel_version: 'v2',
    runtime: { type: 'kvm' },
    fingerprint: { guest_machine_id: 'a'.repeat(32) },
    claude: { has_access: true },
    ...overrides,
  }
  const slot = path.join(root, 'vms', vm.id)
  fs.mkdirSync(slot, { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  fs.writeFileSync(path.join(slot, 'machine-id'), vm.fingerprint.guest_machine_id)
  const sample = path.join(root, 'share', 'wrap-cli')
  fs.mkdirSync(sample, { recursive: true })
  const elf = Buffer.alloc(128)
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  elf.writeUInt16LE(3, 16)
  elf.writeUInt16LE(62, 18)
  elf.writeUInt32LE(1, 20)
  for (const name of ['cli-node', 'cc-node', 'kin-kernel.bin'])
    fs.writeFileSync(path.join(sample, name), elf, { mode: 0o755 })
  seedEncryptedPackage(root)
  const machineIdFile = path.join(root, 'host-machine-id')
  fs.writeFileSync(machineIdFile, 'e'.repeat(32), { mode: 0o600 })
  const hostId = crypto
    .createHash('sha256')
    .update(`crag-host-v1:${'e'.repeat(32)}`)
    .digest('hex')
  const publicDir = cragSubscriptionPublicDirectory(root)
  fs.mkdirSync(publicDir, { recursive: true, mode: 0o755 })
  fs.writeFileSync(path.join(publicDir, 'host_id'), hostId, { mode: 0o644 })
  const host = issueHostEntitlement(root, hostId)
  fs.writeFileSync(path.join(publicDir, 'entitlement.code'), host.code, { mode: 0o644 })
  const permit = issueSlotPermit(root, prepareCragSubscriptionBinding(root, vm), hostId, { seat: 1 })
  const roster = [{ seat: 1, permit_sha256: crypto.createHash('sha256').update(permit.code).digest('hex') }]
  const entitlement = h2
    ? signSubscriptionBytes(root, 'CRAGH2', JSON.stringify({ ...host.claims, version: 2, roster }))
    : host.code
  fs.writeFileSync(path.join(publicDir, 'entitlement.code'), entitlement, { mode: 0o644 })
  activateCragSubscriptionBinding(root, vm, permit.code)
  if (binding !== 'subscription') {
    fs.unlinkSync(path.join(cragLicenseDirectory(root, vm), 'registration.code'))
    if (binding === 'universal') activateCragLicense(root, vm, issueUniversalCode(root).code)
  }
  return { root, vm, hostId, machineIdFile }
}

function operations(root) {
  const events = []
  const ops = {
    async stopSlot(vm) {
      events.push('stop')
      return { ok: true, runtime: { ...vm.runtime, stopped: true } }
    },
    async suspendVmRuntimeRestart() {
      return { ok: true }
    },
    async startSlotReady() {
      events.push('start')
      return { ok: true, rust_ok: true, runtime: { type: 'kvm', stopped: false } }
    },
    async restartRustKernel() {
      events.push('guest-restart')
      return { ok: true }
    },
  }
  const subscription = {
    async releaseStoppedBinding(vm, { stop } = {}) {
      if (stop) {
        const halted = await stop()
        if (!halted?.ok) throw Object.assign(new Error('stop not confirmed'), { code: halted?.code || 'stop_failed' })
      }
      assert.equal(getVm(root, vm.id).status, 'stopped', 'the slot record must retain the actual stop before release')
      assert.ok(events.includes('stop'), 'the old CRAG instance must be stopped before releasing its seat')
      events.push('release')
      const hostId = fs.readFileSync(path.join(cragSubscriptionPublicDirectory(root), 'host_id'), 'utf8')
      assert.ok(readCragSubscriptionReleaseCandidate(root, vm, hostId))
      return { released: true, stopped: true, reclaim_supported: true }
    },
  }
  return { ops, subscription, events }
}

function panel(root, { ops, subscription, routing = {}, ...extra } = {}) {
  const response = {}
  let body
  const handler = createPanelHandler({
    cfg: { paths: { project: root }, vm: { id: null } },
    routingConfig: routing,
    async persistRoutingPatch(patch) {
      routing.inference = { ...routing.inference, ...patch.inference }
    },
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
    cragSubscription: subscription,
    kernelPolicyOps: ops,
    kernelInstallOps: ops,
    ...extra,
  })
  return async (method, endpoint, value) => {
    body = value
    await handler({ method }, {}, new URL(`http://localhost/api/panel${endpoint}`))
    return { ...response }
  }
}

test('master CRAG update uses the existing install job without booting a stopped slot', async (t) => {
  const { root, vm } = fixture(t, { vm: { status: 'stopped' } })
  const payload_tag = 'payload-2026.11.20-crag-3.1.8'
  const runDir = path.join(root, 'run')
  fs.mkdirSync(runDir)
  const request = panel(root, {
    ops: {
      describeKernelCatalog: () => [{ id: 'crag', ready: true, payload_tag }],
      checkCragLicense: () => ({ ok: true }),
      stopSlot: () => ({ ok: true }),
      suspendVmRuntimeRestart: () => ({ ok: true }),
      materializeResolvedKernel: () => ({ ok: true }),
      initializeSlotSeedFiles: () => {},
      writeKernelConfig: () => ({ configPath: '/tmp/kernel.json', runDir: path.join(root, 'run') }),
      startSlotReady: () => assert.fail('脚本更新不能启动已停止的槽'),
    },
  })
  const targets = [{ id: vm.id, kernel: 'crag', payload_tag }]
  const queued = await request('POST', '/kernels/crag-update', { targets, background: true })
  assert.equal(queued.status, 202)
  await new Promise((resolve) => setImmediate(resolve))
  const job = await request('GET', `/kernels/install?job_id=${queued.body.data.job_id}`)
  assert.equal(job.status, 200)
  assert.equal(job.body.data.state, 'completed')
  assert.equal(job.body.data.report.ok, true, JSON.stringify(job.body.data.report))
  assert.equal(job.body.data.report.items[0].payload_tag, payload_tag)
  assert.equal(getVm(root, vm.id).status, 'stopped')
})

for (const entry of ['slot', 'targets', 'default']) {
  linuxTest(`explicit ${entry} CRAG to cli-node switch releases its H2 binding before restarting`, async (t) => {
    const { root, vm } = fixture(t, { inherited: entry === 'default' })
    const { ops, subscription, events } = operations(root)
    const routing = { inference: { dataplane: 'crag' } }
    const body =
      entry === 'slot'
        ? { dataplane: 'wrap' }
        : { dataplane: 'wrap', ...(entry === 'default' ? { all: true } : { ids: [vm.id] }) }
    const request = panel(root, { ops, subscription, routing })
    const endpoint = entry === 'slot' ? `/vms/${vm.id}` : '/dataplane'
    const response = await request(entry === 'slot' ? 'PATCH' : 'POST', endpoint, body)
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.deepEqual(events, ['stop', 'release', 'start'])
  })
}

linuxTest('cli-node installation releases an existing H2 binding after stop and before start', async (t) => {
  const { root, vm } = fixture(t)
  const { ops, subscription, events } = operations(root)
  const result = await installKernelTargets({
    projectRoot: root,
    targets: [{ id: vm.id, kernel: 'cli-node' }],
    ops,
    cragSubscription: subscription,
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(events, ['stop', 'release', 'start'])
})

linuxTest('a stopped slot releases its binding without starting', async (t) => {
  const { root, vm } = fixture(t, { vm: { status: 'stopped' } })
  const life = operations(root)
  const request = panel(root, life)
  const response = await request('PATCH', `/vms/${vm.id}`, { dataplane: 'wrap' })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.deepEqual(life.events, ['stop', 'release'])
  assert.equal(getVm(root, vm.id).status, 'stopped')
})

linuxTest('an already selected cli-node slot still releases a leftover subscription', async (t) => {
  const { root, vm } = fixture(t, {
    vm: { dataplane: 'wrap', kernel_installation: { kernel: 'cli-node', version: 'v2' } },
  })
  const life = operations(root)
  const response = await panel(root, life)('PATCH', `/vms/${vm.id}`, { dataplane: 'wrap' })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.deepEqual(life.events, ['stop', 'release', 'start'])
})

for (const all of [false, true]) {
  linuxTest(`restart:false ${all ? 'global' : 'explicit'} selection retains the running subscription`, async (t) => {
    const { root, vm } = fixture(t, { inherited: all })
    const life = operations(root)
    life.subscription.releaseStoppedBinding = () => assert.fail('configuration-only changes cannot release a live seat')
    const response = await panel(root, { ...life, routing: { inference: { dataplane: 'crag' } } })(
      'POST',
      '/dataplane',
      { dataplane: 'wrap', restart: false, ...(all ? { all } : { ids: [vm.id] }) },
    )
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.deepEqual(life.events, [])
    assert.equal(getVm(root, vm.id).status, 'running')
  })
}

for (const binding of ['none', 'universal']) {
  linuxTest(`${binding} license keeps the ordinary KVM guest restart path`, async (t) => {
    const { root, vm, hostId } = fixture(t, { binding })
    const life = operations(root)
    let checked = false
    life.subscription.releaseStoppedBinding = async (selected) => {
      assert.equal(readCragSubscriptionReleaseCandidate(root, selected, hostId), null)
      checked = true
      return { released: false, stopped: false, reclaim_supported: true }
    }
    const response = await panel(root, life)('PATCH', `/vms/${vm.id}`, { dataplane: 'wrap' })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(checked, true)
    assert.deepEqual(life.events, ['guest-restart'])
  })
}

linuxTest('a failed stop never releases the seat or restarts the replacement', async (t) => {
  const { root, vm } = fixture(t)
  const life = operations(root)
  life.ops.stopSlot = async () => {
    life.events.push('stop')
    return { ok: false, code: 'node_command_unconfirmed' }
  }
  const response = await panel(root, life)('PATCH', `/vms/${vm.id}`, { dataplane: 'wrap' })
  assert.equal(response.status, 503, JSON.stringify(response.body))
  assert.equal(response.body.error.code, 'node_command_unconfirmed')
  assert.deepEqual(life.events, ['stop'])
  assert.equal(getVm(root, vm.id).dataplane, 'wrap')
  assert.equal(getVm(root, vm.id).unschedulable.reason, 'runtime_start_failed')
})

for (const entry of ['slot', 'install']) {
  linuxTest(`${entry} Authority failure preserves STOPPED and the non-CRAG selection`, async (t) => {
    const { root, vm } = fixture(t)
    const life = operations(root)
    const release = life.subscription.releaseStoppedBinding
    life.subscription.releaseStoppedBinding = async (...args) => {
      await release(...args)
      throw Object.assign(new Error('authority offline'), { code: 'crag_subscription_authority_unavailable' })
    }
    if (entry === 'slot') {
      const response = await panel(root, life)('PATCH', `/vms/${vm.id}`, { dataplane: 'wrap' })
      assert.equal(response.status, 503, JSON.stringify(response.body))
      assert.equal(response.body.error.code, 'crag_subscription_authority_unavailable')
    } else {
      const result = await installKernelTargets({
        projectRoot: root,
        targets: [{ id: vm.id, kernel: 'cli-node' }],
        ops: life.ops,
        releaseStoppedBinding: life.subscription.releaseStoppedBinding,
      })
      assert.equal(result.ok, false)
      assert.equal(result.items[0].code, 'crag_subscription_authority_unavailable')
      assert.equal(result.items[0].stopped, true)
    }
    const saved = getVm(root, vm.id)
    assert.equal(saved.status, 'stopped')
    assert.equal(saved.runtime.stopped, true)
    assert.equal(saved.dataplane, 'wrap')
    assert.deepEqual(life.events, ['stop', 'release'])
  })
}

for (const entry of ['slot', 'install']) {
  linuxTest(`${entry} releases using the installed key before replacing the preinstalled CRAG package`, async (t) => {
    const { root, vm } = fixture(t)
    assert.equal(materializeSlotDataplane(root, vm, 'crag').ok, true)
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-release-next-key-'))
    t.after(() => fs.rmSync(other, { recursive: true, force: true }))
    const newer = seedEncryptedPackage(other)
    const base = path.join(root, 'share', 'crag', 'kernels', 'v2')
    const relative = `packages/amd64-${crypto.randomUUID()}`
    fs.cpSync(newer, path.join(base, relative), { recursive: true })
    fs.writeFileSync(path.join(base, 'current-amd64.json'), JSON.stringify({ package: relative }))
    const life = operations(root)
    if (entry === 'slot') {
      const response = await panel(root, life)('PATCH', `/vms/${vm.id}`, { dataplane: 'wrap' })
      assert.equal(response.status, 200, JSON.stringify(response.body))
    } else {
      const result = await installKernelTargets({
        projectRoot: root,
        targets: [{ id: vm.id, kernel: 'cli-node' }],
        ops: life.ops,
        releaseStoppedBinding: life.subscription.releaseStoppedBinding,
      })
      assert.equal(result.ok, true, JSON.stringify(result))
    }
    assert.deepEqual(life.events, ['stop', 'release', 'start'])
  })
}

for (const entry of ['slot', 'install']) {
  linuxTest(`${entry} package replacement failure cannot roll back a revoked CRAG selection`, async (t) => {
    const { root, vm } = fixture(t)
    const life = operations(root)
    const release = life.subscription.releaseStoppedBinding
    life.subscription.releaseStoppedBinding = async (...args) => {
      const result = await release(...args)
      fs.unlinkSync(path.join(root, 'share', 'wrap-cli', 'cli-node'))
      return result
    }
    if (entry === 'slot') {
      const response = await panel(root, life)('PATCH', `/vms/${vm.id}`, { dataplane: 'wrap' })
      assert.equal(response.status, 503, JSON.stringify(response.body))
    } else {
      const result = await installKernelTargets({
        projectRoot: root,
        targets: [{ id: vm.id, kernel: 'cli-node' }],
        ops: life.ops,
        releaseStoppedBinding: life.subscription.releaseStoppedBinding,
      })
      assert.equal(result.ok, false)
      assert.equal(result.items[0].stopped, true)
      assert.notEqual(result.items[0].rolled_back, true)
    }
    assert.equal(getVm(root, vm.id).status, 'stopped')
    assert.equal(getVm(root, vm.id).dataplane, 'wrap')
    assert.deepEqual(life.events, ['stop', 'release'])
  })
}

for (const entry of ['slot', 'job', 'batch', 'install']) {
  linuxTest(`H1 ${entry} result exposes deferred reclaim without claiming the seat was released`, async (t) => {
    const { root, vm } = fixture(t, { h2: false })
    const life = operations(root)
    life.subscription.releaseStoppedBinding = async () => ({
      released: false,
      stopped: false,
      reclaim_supported: false,
      reclaim_pending: true,
    })
    const request = panel(root, life)
    let response
    if (entry === 'slot') response = await request('PATCH', `/vms/${vm.id}`, { dataplane: 'wrap' })
    if (entry === 'batch') response = await request('POST', '/vms/slot-policy', { ids: [vm.id], dataplane: 'wrap' })
    if (entry === 'install')
      response = await request('POST', '/kernels/install', { targets: [{ id: vm.id, kernel: 'cli-node' }] })
    if (entry === 'job') {
      response = await request('POST', `/vms/${vm.id}/kernel-switch`, { dataplane: 'wrap' })
      assert.equal(response.status, 202)
      for (let attempt = 0; attempt < 100; attempt++) {
        await new Promise(setImmediate)
        response = await request('GET', `/vms/${vm.id}/kernel-switch`)
        if (response.body.data.status !== 'running') break
      }
      assert.equal(response.body.data.status, 'succeeded', JSON.stringify(response.body))
    }
    assert.equal(response.status, 200, JSON.stringify(response.body))
    const data = response.body.data
    assert.equal(entry === 'install' || entry === 'batch' ? data.items[0].reclaim_pending : data.reclaim_pending, true)
    assert.deepEqual(life.events, entry === 'install' ? ['stop', 'start'] : ['guest-restart'])
  })
}

for (const { all, status } of [
  { all: false, status: 'running' },
  { all: true, status: 'running' },
  { all: false, status: 'stopped' },
  { all: true, status: 'stopped' },
]) {
  linuxTest(
    `retrying a failed ${all ? 'global' : 'single'} switch from ${status} repairs configuration without reviving the slot`,
    async (t) => {
      const { root, vm } = fixture(t, { inherited: all, vm: { status } })
      const life = operations(root)
      let writes = 0
      life.ops.writeKernelConfig = () => {
        writes++
        if (writes === 1) throw new Error('fixture config write failed')
      }
      const request = panel(root, { ...life, routing: { inference: { dataplane: 'crag' } } })
      const apply = () =>
        all
          ? request('POST', '/dataplane', { dataplane: 'wrap', all: true })
          : request('PATCH', `/vms/${vm.id}`, { dataplane: 'wrap' })
      const failed = await apply()
      assert.equal(failed.status, 503, JSON.stringify(failed.body))
      assert.equal(getVm(root, vm.id).status, 'stopped')
      const retried = await apply()
      assert.equal(retried.status, 200, JSON.stringify(retried.body))
      assert.equal(writes, 2)
      assert.equal(getVm(root, vm.id).status, 'stopped')
      assert.deepEqual(life.events, ['stop', 'release', 'stop', 'release'])
    },
  )
}

for (const all of [false, true]) {
  linuxTest(
    `${all ? 'global' : 'single'} switch retains the watchdog hold when STOPPED persistence fails`,
    async (t) => {
      const { root, vm } = fixture(t, { inherited: all })
      const life = operations(root)
      const held = new Set()
      const watchdog = {
        hold: (id) => held.add(id),
        release: (id) => held.delete(id),
      }
      const file = path.join(root, 'vms', `${vm.id}.json`)
      const rename = fs.renameSync
      let rejectStoppedWrite = true
      fs.renameSync = (from, to) => {
        if (to === file && rejectStoppedWrite && JSON.parse(fs.readFileSync(from, 'utf8')).status === 'stopped') {
          rejectStoppedWrite = false
          throw Object.assign(new Error('fixture stopped-state write denied'), { code: 'EACCES' })
        }
        return rename(from, to)
      }
      const request = panel(root, { ...life, kernelWatchdog: watchdog, routing: { inference: { dataplane: 'crag' } } })
      const apply = () =>
        all
          ? request('POST', '/dataplane', { dataplane: 'wrap', all: true })
          : request('PATCH', `/vms/${vm.id}`, { dataplane: 'wrap' })
      try {
        const failed = await apply()
        assert.equal(failed.status, 503, JSON.stringify(failed.body))
        assert.equal(all ? failed.body.data.items[0].code : failed.body.error.code, 'kernel_stop_persist_failed')
        assert.deepEqual(life.events, ['stop'])
        assert.equal(held.has(vm.id), true)
      } finally {
        fs.renameSync = rename
      }
      const retried = await apply()
      assert.equal(retried.status, 200, JSON.stringify(retried.body))
      assert.equal(getVm(root, vm.id).status, 'running')
      assert.equal(held.has(vm.id), false)
      assert.deepEqual(life.events, ['stop', 'stop', 'release', 'start'])
    },
  )
}

linuxTest('install API can release a seat without granting subscription authorization privileges', async (t) => {
  const { root, vm } = fixture(t)
  const life = operations(root)
  // Deploy (fix/crag-master-bind): the master key may bind a seat, so the CRAG
  // install reaches authorizeInstall; the fixture refuses it there.
  let authorized = 0
  life.subscription.authorizeInstall = () => {
    authorized += 1
    throw Object.assign(new Error('fixture refuses the binding'), { code: 'license_required' })
  }
  const response = await panel(root, life)('POST', '/kernels/install', { targets: [{ id: vm.id, kernel: 'cli-node' }] })
  assert.equal(response.body.data.ok, true, JSON.stringify(response.body))
  assert.deepEqual(life.events, ['stop', 'release', 'start'])
  fs.unlinkSync(path.join(cragLicenseDirectory(root, vm), 'registration.code'))
  life.ops.describeKernelCatalog = () => [{ id: 'crag', ready: true, release_tag: 'v1.0.0' }]
  const unauthorized = await panel(root, life)('POST', '/kernels/install', {
    targets: [{ id: vm.id, kernel: 'crag', expected_tag: 'v1.0.0' }],
  })
  assert.equal(unauthorized.body.data.ok, false)
  assert.equal(unauthorized.body.data.items[0].code, 'license_required')
  assert.equal(authorized, 1)
  assert.deepEqual(life.events, ['stop', 'release', 'start'])
})

linuxTest('interrupted installation recovery preserves the independent release dependency', async (t) => {
  const { root, vm } = fixture(t)
  patchVmRecord(root, vm.id, (record) => {
    record.kernel_operation = {
      id: 'fixture-interrupted',
      phase: 'pending',
      kernel: 'cli-node',
      recovery_attempts: 0,
    }
  })
  const life = operations(root)
  const result = await resumePendingKernelInstalls({
    projectRoot: root,
    ops: life.ops,
    releaseStoppedBinding: life.subscription.releaseStoppedBinding,
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(life.events, ['stop', 'release', 'start'])
})

for (const retry of [false, true]) {
  linuxTest(
    `real signed subscription ${retry ? 'retries the stopped release' : 'releases before starting cli-node'}`,
    async (t) => {
      const { root, vm, hostId, machineIdFile } = fixture(t)
      const life = operations(root)
      const publicDir = cragSubscriptionPublicDirectory(root)
      const privateDir = path.join(path.dirname(publicDir), 'private')
      fs.mkdirSync(privateDir, { mode: 0o700 })
      fs.writeFileSync(path.join(privateDir, 'credential'), crypto.randomBytes(32).toString('base64url'), {
        mode: 0o600,
      })
      const originalDigest = readCragSubscriptionReleaseCandidate(root, vm, hostId)
      const oldCode = fs.readFileSync(path.join(publicDir, 'entitlement.code'), 'utf8')
      const claims = JSON.parse(Buffer.from(oldCode.split('.')[1], 'base64url'))
      const nextClaims = { ...claims, revision: claims.revision + 1, roster: [] }
      const nextCode = signSubscriptionBytes(root, 'CRAGH2', JSON.stringify(nextClaims))
      let unavailable = retry
      let releaseCalls = 0
      const service = createCragSubscription({
        projectRoot: root,
        machineIdFile,
        listTargets: () => [getVm(root, vm.id)],
        getTarget: (id) => getVm(root, id),
        assertReady: () => true,
        isSlotEnabled: () => true,
        blockKvmBinding: async () => true,
        publishKvmBinding: async () => false,
        runtimeInventory: {
          async confirmReclaimableStop(target) {
            assert.equal(target.id, vm.id)
            assert.equal(getVm(root, vm.id).status, 'stopped')
            assert.equal(getVm(root, vm.id).runtime.stopped, true)
            assert.ok(life.events.includes('stop'))
            return true
          },
        },
        fetchImpl: async (url, { body }) => {
          assert.ok(url.endsWith('/release'))
          const request = JSON.parse(body)
          assert.equal(request.vm_id, vm.id)
          assert.equal(request.permit_sha256, originalDigest)
          assert.equal(getVm(root, vm.id).status, 'stopped')
          assert.equal(fs.existsSync(path.join(publicDir, 'sync-pending')), true)
          releaseCalls++
          life.events.push('authority-release')
          if (unavailable) throw new Error('fixture authority unavailable')
          return Response.json({
            ok: true,
            data: { entitlement: nextCode, ...nextClaims, used_slots: 0, available_slots: 2 },
          })
        },
      })
      const start = life.ops.startSlotReady
      life.ops.startSlotReady = async (...args) => {
        assert.equal(readCragSubscriptionReleaseCandidate(root, vm, hostId), null)
        return start(...args)
      }
      const request = panel(root, { ...life, subscription: service })
      if (retry) {
        const failed = await request('PATCH', `/vms/${vm.id}`, { dataplane: 'wrap' })
        assert.equal(failed.status, 503, JSON.stringify(failed.body))
        assert.equal(failed.body.error.code, 'crag_subscription_authority_unavailable')
        assert.equal(getVm(root, vm.id).status, 'stopped')
        assert.equal(getVm(root, vm.id).dataplane, 'wrap')
        assert.equal(readCragSubscriptionReleaseCandidate(root, vm, hostId), originalDigest)
        unavailable = false
      }
      const response = await request('PATCH', `/vms/${vm.id}`, { dataplane: 'wrap' })
      assert.equal(response.status, 200, JSON.stringify(response.body))
      assert.equal(releaseCalls, retry ? 2 : 1)
      assert.equal(readCragSubscriptionReleaseCandidate(root, vm, hostId), null)
      assert.equal(fs.existsSync(path.join(publicDir, 'sync-pending')), false)
      assert.equal(fs.existsSync(path.join(privateDir, 'roster.json')), false)
      assert.equal(getVm(root, vm.id).status, retry ? 'stopped' : 'running')
      assert.deepEqual(
        life.events,
        retry ? ['stop', 'authority-release', 'stop', 'authority-release'] : ['stop', 'authority-release', 'start'],
      )
      assert.equal((await service.status()).available_seats, 2)
    },
  )
}
