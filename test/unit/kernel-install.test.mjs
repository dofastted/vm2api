import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  installKernelTargets,
  releaseKernelInstallSafetyHold,
  resumePendingKernelInstalls,
  cancelKernelInstall,
  listActiveKernelInstalls,
} from '../../src/lib/vm/kernel-install.mjs'
import { kvmKernelSelector, selectChangedPayloadFiles } from '../../src/lib/cluster/remote-slot-files.mjs'
import { describeKernelCatalog, pullKernelRelease } from '../../src/lib/admin/kernel-catalog.mjs'
import { getVm, patchVmRecord, summarizeVm } from '../../src/lib/vm/vm-registry.mjs'
import { withVmLock } from '../../src/lib/vm/vm-file.mjs'
import { initializeSlotSeedFiles } from '../../src/lib/vm/slot-seed.mjs'
import { slotHost } from '../../src/lib/vm/slot-host.mjs'
import { configureCragRuntimeAdmission } from '../../src/lib/vm/slot-runtime-admission.mjs'
import {
  activateCragLicense,
  activateCragSubscriptionBinding,
  cragLicenseDirectory,
  getCragLicense,
  prepareCragSubscriptionBinding,
} from '../../src/lib/vm/crag-license.mjs'
import { cragSubscriptionPublicDirectory } from '../../src/lib/vm/crag-subscription-paths.mjs'
import { cragV2PackageRoot, materializeResolvedKernel } from '../../src/lib/vm/wrap-cli-runtime.mjs'
import { writeKernelConfig } from '../../src/lib/transport/rust-kernel-supervisor.mjs'
import {
  activateFixture,
  fixtureAuthority,
  issueFixtureCode,
  issueHostEntitlement,
  issueSlotPermit,
  issueUniversalCode,
  seedEncryptedPackage,
} from '../fixtures/crag-license.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { unitCircuit } from '../../src/lib/pool/unit-circuit.mjs'

const savedEnv = Object.fromEntries(
  ['KIN_SLOT_RUN_ROOT', 'KIN_CRAG_V2_ROOT', 'KIN_WRAP_CLI_ROOT', 'KIN_KERNEL_BIN', 'KIN_NATIVE_CLI_ROOT'].map((key) => [
    key,
    process.env[key],
  ]),
)
before(() => {
  for (const key of Object.keys(savedEnv)) delete process.env[key]
})
after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
})

function elf(payload) {
  const bytes = Buffer.alloc(96 + Buffer.byteLength(payload))
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  bytes.writeUInt16LE(3, 16)
  bytes.writeUInt16LE(62, 18)
  bytes.writeUInt32LE(1, 20)
  bytes.write(payload, 96)
  return bytes
}
function fixture(t, patch = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-install-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const run = path.join(root, 'linux-private-run', 'vm-13')
  const vm = {
    id: 'vm-13',
    status: 'running',
    dataplane: 'wrap',
    timezone: 'UTC',
    runtime: { type: 'docker', worker_run_dir: run },
    fingerprint: { hostname: 'existing-computer' },
    seed_policy: { telemetry: false },
    claude: { account_uuid: 'existing-account', has_access: true },
    ...patch,
  }
  fs.mkdirSync(path.join(root, 'vms', vm.id, 'cli-home', '.kin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  const home = path.join(root, 'vms', vm.id, 'cli-home')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude', 'credentials.json'), 'protected-credential')
  fs.writeFileSync(path.join(home, '.kin', 'kin-kernel.bin'), 'previous-kernel')
  fs.writeFileSync(path.join(home, 'workspace.txt'), 'protected-workspace')
  const cli = path.join(root, 'share', 'wrap-cli')
  fs.mkdirSync(cli, { recursive: true })
  fs.writeFileSync(path.join(cli, 'cli-node'), elf('free-cli'), { mode: 0o755 })
  fs.writeFileSync(path.join(cli, 'kin-kernel.bin'), elf('free-kernel'), { mode: 0o755 })
  seedEncryptedPackage(root)
  return { root, vm, home, run }
}
const target = (kernel = 'crag') => [{ id: 'vm-13', kernel }]

for (const kernel of ['crag', 'cli-node']) {
  for (const existing of [false, true]) {
    test(`${kernel} installation initializes settings before restart (${existing ? 'existing' : 'missing'} settings)`, async (t) => {
      const { root, vm, home } = fixture(t)
      if (kernel === 'crag') activateFixture(root, vm)
      const file = path.join(home, '.claude', 'settings.json')
      if (existing) {
        fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Read'] }, env: { CUSTOM: 'keep' } }))
      }
      const life = lifecycle(root, {
        startSlotReady() {
          const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
          assert.equal(settings.autoUpdates, false)
          assert.equal(settings.env.TZ, 'UTC')
          if (existing) {
            assert.deepEqual(settings.permissions, { allow: ['Read'] })
            assert.equal(settings.env.CUSTOM, 'keep')
          }
          assert.equal(fs.statSync(file).mode & 0o777, 0o600)
          assert.equal(fs.readFileSync(path.join(home, '.claude', 'credentials.json'), 'utf8'), 'protected-credential')
          return { ok: true, rust_ok: true }
        },
      })
      const result = await installKernelTargets({ projectRoot: root, targets: target(kernel), ops: life.ops })
      assert.equal(result.ok, true, JSON.stringify(result))
    })
  }
  test(`${kernel} cluster installation publishes VM settings before restart`, async (t) => {
    const { root, home, run } = fixture(t, { node_id: 'node-settings' })
    let published = false
    const life = lifecycle(root, {
      checkCragLicense: () => ({ ok: true }),
      deployBakedKernel: () => ({ ok: true }),
      writeKernelConfig: () => ({ configPath: path.join(run, 'kernel.json'), runDir: run }),
      initializeSlotSeedFiles(project, candidate) {
        return initializeSlotSeedFiles(project, candidate, {
          async seedFiles() {
            return { files: { 'settings.json': JSON.stringify({ env: { CUSTOM: 'from-node' } }) } }
          },
          async syncSeed() {
            const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'))
            assert.equal(settings.env.CUSTOM, 'from-node')
            assert.equal(settings.env.TZ, 'UTC')
            published = true
            return { published: true }
          },
        })
      },
      startSlotReady() {
        assert.equal(published, true)
        return { ok: true, rust_ok: true }
      },
    })
    const result = await installKernelTargets({ projectRoot: root, targets: target(kernel), ops: life.ops })
    assert.equal(result.ok, true, JSON.stringify(result))
  })
}

function lifecycle(root, extra = {}) {
  let stopCount = 0
  return {
    ops: {
      initializeSlotSeedFiles(project, candidate) {
        return initializeSlotSeedFiles(project, candidate, slotHost({ ...candidate, node_id: null }))
      },
      stopSlot(vm) {
        stopCount++
        assert.equal(getVm(root, vm.id).status, 'running')
        return { ok: true, runtime: { ...vm.runtime, stopped: true } }
      },
      suspendVmRuntimeRestart(vm) {
        assert.equal(getVm(root, vm.id).status, 'stopped')
        return { ok: true }
      },
      startSlotReady(vm) {
        assert.equal(getVm(root, vm.id).status, 'stopped')
        assert.equal(getVm(root, vm.id).schedule_hold.reason, 'maintenance')
        return { ok: true, rust_ok: true, runtime: { ...vm.runtime, pid: 123, stopped: false } }
      },
      ...extra,
    },
    stops: () => stopCount,
  }
}

test('versioned reinstall refuses stale caches before stopping and prevents competing cache publication', async (t) => {
  const { root, vm } = fixture(t)
  const template = path.join(root, 'share/wrap-cli')
  const metadata = path.join(template, 'RELEASE.json')
  fs.writeFileSync(metadata, JSON.stringify({ version: '1.2.3', tag: 'v1.2.3' }))
  const life = lifecycle(root, {
    async startSlotReady() {
      const competing = await pullKernelRelease(
        root,
        { kernel: 'cli-node' },
        {
          fetchImpl: async () =>
            Response.json({
              tag_name: 'v1.2.4',
              assets: ['kin-kernel', 'cli-node'].map((name, index) => ({
                name,
                url: `https://api.github.com/repos/dofastted/vm2api/releases/assets/${index + 1}`,
              })),
            }),
        },
      )
      assert.equal(competing.code, 'kernel_pull_busy')
      return { ok: true }
    },
  })
  const install = (expected_tag) =>
    installKernelTargets({
      projectRoot: root,
      targets: [{ id: vm.id, kernel: 'cli-node', expected_tag }],
      ops: life.ops,
    })
  const stale = await install('v1.2.2')
  assert.equal(stale.items[0].code, 'kernel_release_changed')
  assert.equal(life.stops(), 0)
  assert.equal(getVm(root, vm.id).status, 'running')
  const success = await install('v1.2.3')
  assert.equal(success.ok, true, JSON.stringify(success))
  assert.equal(getVm(root, vm.id).kernel_installation.version, '1.2.3')
})

test('native switch stops before real replacement, writes candidate config and commits only after success', async (t) => {
  const { root, vm, home, run } = fixture(t)
  const factory = cragV2PackageRoot(root)
  const base = path.dirname(factory)
  const snapshot = 'packages/amd64-00000000-0000-4000-8000-000000000000'
  fs.cpSync(factory, path.join(base, snapshot), { recursive: true })
  fs.writeFileSync(
    path.join(base, 'current-amd64.json'),
    JSON.stringify({ package: snapshot, release: { tag: 'v3.0.4', version: '3.0.4' } }),
  )
  activateFixture(root, vm)
  const licenseDir = cragLicenseDirectory(root, vm)
  const identity = fs.readFileSync(path.join(licenseDir, 'device.json'))
  const grant = fs.readFileSync(path.join(licenseDir, 'registration.code'))
  const life = lifecycle(root, {
    writeKernelConfig(project, candidate, options) {
      assert.equal(getVm(root, vm.id).dataplane, 'wrap', 'selection must not be committed before config')
      assert.equal(fs.readFileSync(path.join(home, '.kin', 'kin-kernel.bin'), 'utf8'), 'previous-kernel')
      assert.ok(fs.existsSync(path.join(home, '.kin', 'crag-v2', 'crag-v2.payload.enc')))
      return writeKernelConfig(project, candidate, options)
    },
  })
  let held = false
  const result = await installKernelTargets({
    projectRoot: root,
    targets: [{ ...target()[0], expected_tag: 'v3.0.4' }],
    ops: life.ops,
    watchdog: {
      hold() {
        held = true
      },
      release() {
        held = false
      },
      reset() {
        assert.equal(getVm(root, vm.id).status, 'running')
      },
    },
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(life.stops(), 1)
  assert.equal(held, false)
  const persisted = getVm(root, vm.id)
  assert.equal(persisted.dataplane, 'crag')
  assert.equal(persisted.crag_kernel_version, 'v2')
  assert.equal(persisted.kernel_installation.version, '3.0.4')
  assert.equal(persisted.status, 'running')
  assert.equal(persisted.runtime.stopped, false)
  assert.equal(persisted.runtime.worker_run_dir, run)
  assert.equal(persisted.schedule_off, undefined)
  assert.equal(persisted.schedule_hold, undefined)
  assert.equal(persisted.schedulable, true)
  assert.equal(result.items[0].restarted, true)
  assert.equal(persisted.kernel_operation, undefined)
  assert.deepEqual(persisted.fingerprint, vm.fingerprint)
  assert.deepEqual(persisted.seed_policy, vm.seed_policy)
  assert.deepEqual(persisted.claude, vm.claude)
  const config = JSON.parse(fs.readFileSync(path.join(run, 'kernel.json')))
  assert.equal(config.crag_kernel_version, 'v2')
  assert.equal(config.runtime_variant, 'crag-v2')
  assert.equal(config.asset_dir, '/run/kin/crag-native-assets')
  assert.equal(config.work_dir, '/run/kin/work')
  assert.equal(config.license_dir, '/run/kin/crag-license')
  for (const name of ['crag-native-assets', 'work']) assert.equal(fs.statSync(path.join(run, name)).mode & 0o777, 0o700)
  assert.deepEqual(fs.readFileSync(path.join(licenseDir, 'device.json')), identity)
  assert.deepEqual(fs.readFileSync(path.join(licenseDir, 'registration.code')), grant)
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'credentials.json'), 'utf8'), 'protected-credential')
  assert.equal(fs.readFileSync(path.join(home, 'workspace.txt'), 'utf8'), 'protected-workspace')
  assert.equal(fs.existsSync(path.join(root, 'vms', vm.id, 'run')), false)
  assert.equal(
    persisted.kernel_installation.version,
    describeKernelCatalog(root).find((item) => item.id === 'crag').version,
  )
  assert.deepEqual(summarizeVm(persisted, root).kernel_installation, persisted.kernel_installation)
})

test('free switch removes native selection without admitting paid license or requiring cc-node', async (t) => {
  const { root, vm, home, run } = fixture(t, {
    dataplane: 'crag',
    crag_kernel_version: 'v2',
    schedule_off: true,
    schedule_off_reason: 'disabled',
  })
  const life = lifecycle(root, {
    checkCragLicense() {
      assert.fail('CLI is free')
    },
  })
  const result = await installKernelTargets({ projectRoot: root, targets: target('cli-node'), ops: life.ops })
  assert.equal(result.ok, true, JSON.stringify(result))
  const saved = getVm(root, vm.id)
  assert.equal(saved.dataplane, 'wrap')
  assert.equal(Object.hasOwn(saved, 'crag_kernel_version'), false)
  assert.equal(saved.status, 'running')
  assert.equal(saved.schedule_off_reason, 'disabled', 'original operator scheduling-off intent survives')
  assert.ok(fs.readFileSync(path.join(home, '.kin', 'kin-kernel.bin')).equals(elf('free-kernel')))
  assert.ok(fs.readFileSync(path.join(home, '.kin', 'cli-node')).equals(elf('free-cli')))
  assert.equal(fs.existsSync(cragLicenseDirectory(root, vm)), false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(run, 'kernel.json'))).dataplane, 'wrap')
})

test('restart intent is durable before stop and success restores scheduling after readiness', async (t) => {
  const { root, vm } = fixture(t)
  const life = lifecycle(root, {
    stopSlot() {
      const record = getVm(root, vm.id)
      assert.equal(record.kernel_operation.phase, 'pending')
      assert.equal(record.kernel_operation.kernel, 'cli-node')
      assert.equal(record.schedulable, false)
      assert.equal(record.schedule_hold.detail.tag, record.kernel_operation.id)
      return { ok: true }
    },
  })
  const result = await installKernelTargets({ projectRoot: root, targets: target('cli-node'), ops: life.ops })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.items[0].restarted, true)
  assert.equal(result.items[0].schedulable, true)
  assert.equal(getVm(root, vm.id).runtime.pid, 123)
})

for (const health of [{ ok: false }, { ok: true, rust_ok: false }, { ok: true, rust: { ok: false } }]) {
  test(`failed restart/readiness never restores scheduling: ${JSON.stringify(health)}`, async (t) => {
    const { root, vm } = fixture(t)
    const life = lifecycle(root, { startSlotReady: () => health })
    const result = await installKernelTargets({ projectRoot: root, targets: target('cli-node'), ops: life.ops })
    assert.equal(result.ok, false)
    const saved = getVm(root, vm.id)
    assert.equal(saved.schedulable, false)
    assert.equal(saved.kernel_operation.phase, 'failed')
    const replay = await resumePendingKernelInstalls({ projectRoot: root, ops: life.ops })
    assert.equal(replay.total, 0, 'known failures require operator action')
  })
}

for (const [label, health, recovered] of [
  ['healthy idle pool', { internalTokenAuthenticated: true, ready_slots: 1, cli_pid: 0 }, true],
  ['unauthenticated', { internalTokenAuthenticated: false, ready_slots: 1, cli_pid: 0 }, false],
  ['not ready', { internalTokenAuthenticated: true, ready_slots: 0, cli_pid: 0 }, false],
  ['license invalid', { internalTokenAuthenticated: true, ready_slots: 1, license_valid: false, cli_pid: 0 }, false],
  ['recovering', { internalTokenAuthenticated: true, ready_slots: 1, recovering: true, cli_pid: 0 }, false],
]) {
  test(`failed pinned CRAG update verifies rollback readiness (${label})`, async (t) => {
    const previous = { kernel: 'crag', version: '3.1.2', installed_at: '2026-11-16T00:00:00Z' }
    const { root, vm, home } = fixture(t, {
      dataplane: 'crag',
      crag_kernel_version: 'v2',
      kernel_installation: previous,
    })
    activateFixture(root, vm)
    assert.equal(materializeResolvedKernel(root, vm).ok, true)
    const manifest = path.join(home, '.kin', 'crag-v2', 'manifest.json')
    const oldManifest = fs.readFileSync(manifest)
    const registration = path.join(cragLicenseDirectory(root, vm), 'registration.code')
    const oldGrant = fs.readFileSync(registration)
    const pkg = seedEncryptedPackage(root, { revision: 'candidate' })
    const newManifest = fs.readFileSync(path.join(pkg, 'manifest.json'))
    assert.notDeepEqual(newManifest, oldManifest)
    let starts = 0
    let stops = 0
    const life = lifecycle(root, {
      describeKernelCatalog: () => [{ id: 'crag', ready: true, release_tag: 'v1.4.104', version: '3.1.3' }],
      stopSlot(current) {
        assert.equal(current.id, vm.id)
        assert.equal(getVm(root, vm.id).status, stops++ === 0 ? 'running' : 'stopped')
        return { ok: true }
      },
      startSlotReady(record, projectRoot, options) {
        assert.equal(projectRoot, root)
        assert.equal(options.useInstalledCrag, true)
        assert.equal(record.schedulable, false)
        if (++starts === 1) {
          assert.deepEqual(fs.readFileSync(manifest), newManifest)
          return { ok: false, code: 'kernel_health_timeout' }
        }
        assert.deepEqual(fs.readFileSync(manifest), oldManifest)
        assert.deepEqual(record.kernel_installation, previous)
        return { ok: true, rust: { ok: true } }
      },
      rustKernelHealth(exec, options) {
        assert.equal(exec.vmId, vm.id)
        assert.deepEqual(options, { requireInternalToken: true })
        return { ok: true, healthy: true, execution_mode: 'v2_process_pool', ...health }
      },
    })
    const result = await installKernelTargets({
      projectRoot: root,
      targets: [{ ...target()[0], expected_tag: 'v1.4.104' }],
      ops: life.ops,
    })
    assert.equal(starts, 2, JSON.stringify(result))
    assert.equal(result.ok, false, 'the requested version never became ready')
    assert.equal(result.items[0].code, 'kernel_health_timeout')
    assert.equal(result.items[0].rolled_back, recovered)
    assert.equal(result.items[0].stopped, !recovered)
    assert.equal(stops, recovered ? 2 : 3)
    assert.deepEqual(fs.readFileSync(registration), oldGrant)
    assert.deepEqual(fs.readFileSync(manifest), oldManifest)
    const saved = getVm(root, vm.id)
    assert.deepEqual(saved.kernel_installation, previous)
    assert.equal(saved.schedulable, recovered)
    assert.equal(saved.status, recovered ? 'running' : 'stopped')
    if (recovered) assert.equal(saved.kernel_operation, undefined)
    else {
      assert.equal(saved.kernel_operation.phase, 'failed')
      const backup = path.join(root, 'vms', vm.id, saved.kernel_operation.rollback_package, 'package')
      assert.deepEqual(fs.readFileSync(path.join(backup, 'manifest.json')), oldManifest)
    }
  })
}

test('interrupted cluster install resumes after node reconnect without an in-memory recovery command', async (t) => {
  const { root, vm, run } = fixture(t, { node_id: 'node-recovery', status: 'stopped' })
  patchVmRecord(root, vm.id, {
    kernel_operation: { id: 'lost-command', kernel: 'cli-node', phase: 'pending', recovery_attempts: 0 },
    schedule_hold: { reason: 'maintenance', detail: { tag: 'lost-command' } },
    schedulable: false,
  })
  let ready = false
  const life = lifecycle(root, {
    nodeReady: () => ready,
    stopSlot: () => ({ ok: true }),
    deployBakedKernel: () => ({ ok: true }),
    writeKernelConfig: () => ({ configPath: path.join(run, 'kernel.json'), runDir: run }),
    startSlotReady(candidate) {
      assert.equal(candidate.dataplane, 'wrap')
      assert.equal(getVm(root, vm.id).kernel_operation.recovery_attempts, 1)
      return { ok: true, rust_ok: true, runtime: { kernel_socket: '/relay/kernel.sock', stopped: false } }
    },
  })
  assert.equal((await resumePendingKernelInstalls({ projectRoot: root, ops: life.ops })).total, 0)
  assert.equal(getVm(root, vm.id).kernel_operation.recovery_attempts, 0)
  ready = true
  const report = await resumePendingKernelInstalls({ projectRoot: root, ops: life.ops })
  assert.equal(report.ok, true, JSON.stringify(report))
  const saved = getVm(root, vm.id)
  assert.equal(saved.status, 'running')
  assert.equal(saved.schedulable, true)
  assert.equal(saved.runtime.kernel_socket, '/relay/kernel.sock')
  assert.equal(saved.kernel_operation, undefined)
  assert.equal((await resumePendingKernelInstalls({ projectRoot: root, ops: life.ops })).total, 0)
})

test('lost cluster restart acknowledgement retains durable intent and converges on readiness', async (t) => {
  const { root, vm, run } = fixture(t, { node_id: 'node-recovery' })
  let starts = 0
  const life = lifecycle(root, {
    nodeReady: () => true,
    stopSlot: () => ({ ok: true }),
    deployBakedKernel: () => ({ ok: true }),
    writeKernelConfig: () => ({ configPath: path.join(run, 'kernel.json'), runDir: run }),
    startSlotReady() {
      starts++
      return starts === 1 ? { ok: false, code: 'docker_timeout' } : { ok: true, rust_ok: true }
    },
  })
  const first = await installKernelTargets({ projectRoot: root, targets: target('cli-node'), ops: life.ops })
  assert.equal(first.ok, false)
  assert.equal(getVm(root, vm.id).kernel_operation.phase, 'pending')
  assert.equal(getVm(root, vm.id).schedulable, false)
  const resumed = await resumePendingKernelInstalls({ projectRoot: root, ops: life.ops })
  assert.equal(resumed.ok, true, JSON.stringify(resumed))
  assert.equal(starts, 2)
  assert.equal(getVm(root, vm.id).status, 'running')
  assert.equal(getVm(root, vm.id).schedulable, true)
})

test('maintenance admission drains inflight requests before stopping the slot', async (t) => {
  const { root, vm } = fixture(t)
  const inflight = new Map([[vm.id, 1]])
  let stopped = false
  const life = lifecycle(root, {
    stopSlot() {
      assert.equal(inflight.get(vm.id), 0)
      stopped = true
      return { ok: true }
    },
  })
  const operation = installKernelTargets({
    projectRoot: root,
    targets: target('cli-node'),
    ops: life.ops,
    poolScheduler: { vmInflight: inflight },
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(stopped, false)
  assert.equal(getVm(root, vm.id).schedulable, false)
  inflight.set(vm.id, 0)
  assert.equal((await operation).ok, true)
})

for (const patch of [{ recovery_attempts: 3 }, { operatorOff: true }]) {
  test(`interrupted recovery respects bounded admission and subsequent operator stop: ${JSON.stringify(patch)}`, async (t) => {
    const { root, vm } = fixture(t)
    patchVmRecord(root, vm.id, {
      kernel_operation: {
        id: 'lost',
        kernel: 'cli-node',
        phase: 'pending',
        recovery_attempts: patch.recovery_attempts || 0,
      },
      ...(patch.operatorOff ? { schedule_off: true, schedule_off_reason: 'stopped' } : {}),
    })
    await resumePendingKernelInstalls({ projectRoot: root, ops: { stopSlot: () => assert.fail('must not restart') } })
    assert.equal(getVm(root, vm.id).kernel_operation.phase, 'failed')
  })
}

test('restart preserves independent credential failure and proxy hold', async (t) => {
  const hold = { reason: 'proxy_cooldown', detail: { tag: 'existing-proxy' } }
  const { root, vm } = fixture(t, { unschedulable: { reason: 'oauth_revoked' }, schedule_hold: hold })
  const result = await installKernelTargets({
    projectRoot: root,
    targets: target('cli-node'),
    ops: lifecycle(root).ops,
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  const saved = getVm(root, vm.id)
  assert.equal(saved.status, 'running')
  assert.equal(saved.schedulable, false)
  assert.equal(saved.unschedulable.reason, 'oauth_revoked')
  assert.deepEqual(saved.schedule_hold, hold)
})

for (const invalid of [
  [],
  [{ id: '', kernel: 'crag' }],
  [{ id: '../vm-13', kernel: 'crag' }],
  [{ id: 'vm-13', kernel: 'cc' }],
  [...target(), ...target()],
  [...target(), ...target('cli-node')],
  [...target(), { id: 'missing', kernel: 'crag' }],
]) {
  test(`invalid explicit selection is all-or-nothing: ${JSON.stringify(invalid)}`, async (t) => {
    const { root, vm } = fixture(t)
    const before = fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`))
    const result = await installKernelTargets({
      projectRoot: root,
      targets: invalid,
      ops: {
        stopSlot() {
          assert.fail('no stop')
        },
      },
    })
    assert.equal(result.ok, false)
    assert.ok(result.code)
    assert.deepEqual(fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`)), before)
  })
}

for (const state of ['unlicensed', 'expired', 'wrong-vm', 'package-tamper', 'different-payload']) {
  test(`paid preflight rejects ${state} before stop and preserves payload, identity and grant bytes`, async (t) => {
    const { root, vm, home } = fixture(t)
    if (state !== 'unlicensed') {
      const active = activateFixture(root, vm)
      const codeFile = path.join(cragLicenseDirectory(root, vm), 'registration.code')
      if (state === 'expired')
        fs.writeFileSync(
          codeFile,
          issueFixtureCode(root, active.machine_code, { issued_at: Math.floor(Date.now() / 1000) - 70 * 86400 }).code,
        )
      if (state === 'wrong-vm')
        fs.writeFileSync(codeFile, issueFixtureCode(root, active.machine_code, { vm_id: 'vm-other' }).code)
      if (state === 'different-payload') seedEncryptedPackage(root, { payloadKey: randomBytes(32) })
      if (state === 'package-tamper') {
        const pkg = path.join(
          root,
          'share/crag/kernels/v2',
          process.arch === 'arm64' ? 'arm64' : 'amd64',
          'crag-v2.payload.enc',
        )
        fs.appendFileSync(pkg, 'tampered')
      }
    }
    const codeFile = path.join(cragLicenseDirectory(root, vm), 'registration.code')
    const beforeGrant = fs.existsSync(codeFile) ? fs.readFileSync(codeFile) : null
    const record = fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`))
    const result = await installKernelTargets({
      projectRoot: root,
      targets: state === 'different-payload' ? [{ ...target()[0], expected_tag: 'v1.4.104' }] : target(),
      cragSubscription: {
        authorizeInstall() {
          assert.fail('only a pinned and unlicensed candidate can trigger authorization')
        },
      },
      ops: {
        ...(state === 'different-payload' && {
          describeKernelCatalog: () => [{ id: 'crag', ready: true, release_tag: 'v1.4.104' }],
        }),
        stopSlot() {
          assert.fail('preflight cannot stop')
        },
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.items[0].stopped, false)
    if (state === 'different-payload') assert.equal(result.items[0].code, 'crag_subscription_migration_required')
    assert.equal(fs.readFileSync(path.join(home, '.kin', 'kin-kernel.bin'), 'utf8'), 'previous-kernel')
    assert.deepEqual(fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`)), record)
    if (beforeGrant) assert.deepEqual(fs.readFileSync(codeFile), beforeGrant)
    else assert.equal(fs.existsSync(cragLicenseDirectory(root, vm)), false)
  })
}

test('a pinned CRAG install verifies runtime admission before authorizing, stopping and checking health', async (t) => {
  const { root, vm } = fixture(t)
  const routing = {}
  const events = []
  let authorized = false
  const life = lifecycle(root)
  configureCragRuntimeAdmission(root, async (desired, options, run) => {
    assert.equal(desired.id, vm.id)
    assert.equal(desired.dataplane, 'crag')
    assert.deepEqual(options, { routing, install: true })
    events.push('admit')
    const item = await run()
    assert.equal(getVm(root, vm.id).status, 'running')
    events.push('release')
    return item
  })
  t.after(() => configureCragRuntimeAdmission(root))
  const result = await installKernelTargets({
    projectRoot: root,
    targets: [{ ...target()[0], expected_tag: 'v1.4.104' }],
    routing,
    cragSubscription: {
      authorizeInstall(vm) {
        events.push('bind')
        activateFixture(root, vm)
        authorized = true
      },
    },
    ops: {
      ...life.ops,
      describeKernelCatalog: () => [{ id: 'crag', ready: true, release_tag: 'v1.4.104' }],
      checkCragLicense(_root, _vm, _routing, options) {
        assert.equal(options.preferInstalled, false)
        events.push('verify')
        return authorized ? { ok: true } : { ok: false, code: 'license_required' }
      },
      stopSlot(vm) {
        events.push('stop')
        return life.ops.stopSlot(vm)
      },
      startSlotReady(...args) {
        events.push('health')
        return life.ops.startSlotReady(...args)
      },
    },
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(events, ['verify', 'admit', 'verify', 'bind', 'verify', 'stop', 'health', 'release'])
})

for (const [label, reissue, expected] of [
  ['an admin-confirmed reissue reaches authorizeInstall', true, true],
  ['a plain install does not ask for a legacy reissue', undefined, false],
]) {
  test(`${label} (#1263)`, async (t) => {
    const { root, vm: _vm } = fixture(t)
    let seen = 'never-called'
    let authorized = false
    const life = lifecycle(root)
    const result = await installKernelTargets({
      projectRoot: root,
      targets: [{ ...target()[0], expected_tag: 'v1.4.104', ...(reissue === undefined ? {} : { reissue }) }],
      routing: {},
      cragSubscription: {
        // The allowLegacyReissue branches themselves are covered in
        // crag-subscription.test.mjs; this layer only has to pass the flag on.
        authorizeInstall(desired, options) {
          seen = options?.allowLegacyReissue
          activateFixture(root, desired)
          authorized = true
        },
      },
      ops: {
        ...life.ops,
        describeKernelCatalog: () => [{ id: 'crag', ready: true, release_tag: 'v1.4.104' }],
        checkCragLicense: () => (authorized ? { ok: true } : { ok: false, code: 'license_required' }),
      },
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    // Compare the opt-in itself, not whether it arrived as false or undefined.
    assert.equal(seen === true, expected)
  })
}

for (const partialInstall of [false, true]) {
  test(`explicit pinned reissue replaces a mismatched signed grant before stopping (${partialInstall ? 'partial tree' : 'no installed tree'})`, async (t) => {
    const { root, vm, home } = fixture(t)
    const old = activateFixture(root, vm)
    const registration = path.join(cragLicenseDirectory(root, vm), 'registration.code')
    const oldGrant = fs.readFileSync(registration)
    const identity = fs.readFileSync(path.join(cragLicenseDirectory(root, vm), 'device.json'))
    if (partialInstall) {
      fs.mkdirSync(path.join(home, '.kin', 'crag-v2', 'claude-code-2.1.321'), { recursive: true })
      assert.equal(getCragLicense(root, vm).license.code, 'license_unconfigured')
    }
    fixtureAuthority(root).payloadKey = randomBytes(32)
    seedEncryptedPackage(root)
    assert.equal(getCragLicense(root, vm, { preferInstalled: false }).license.code, 'license_payload_key_mismatch')
    const events = []
    const life = lifecycle(root, {
      stopSlot() {
        events.push('stop')
        assert.equal(getCragLicense(root, vm, { preferInstalled: false }).license.valid, true)
        return { ok: true }
      },
    })
    const result = await installKernelTargets({
      projectRoot: root,
      targets: [{ ...target()[0], expected_tag: 'v1.4.104', reissue: true }],
      cragSubscription: {
        authorizeInstall(desired, options) {
          assert.equal(desired.id, vm.id)
          assert.equal(options.allowLegacyReissue, true)
          events.push('authorize')
          // Simulate the issuer returning a signature for this exact candidate;
          // the installer must verify it before stopping the old runtime.
          fs.writeFileSync(registration, issueFixtureCode(root, old.machine_code).code)
        },
      },
      ops: {
        ...life.ops,
        describeKernelCatalog: () => [{ id: 'crag', ready: true, release_tag: 'v1.4.104' }],
      },
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(events, ['authorize', 'stop'])
    assert.notDeepEqual(fs.readFileSync(registration), oldGrant)
    assert.deepEqual(fs.readFileSync(path.join(cragLicenseDirectory(root, vm), 'device.json')), identity)
    assert.equal(getCragLicense(root, getVm(root, vm.id)).license.valid, true)
    assert.equal(getVm(root, vm.id).dataplane, 'crag')
  })
}

for (const scenario of ['no-reissue', 'no-pin', 'no-authorizer', 'issuer-unavailable', 'permit-not-replaced']) {
  test(`payload migration rejects ${scenario} before stopping and preserves the old grant`, async (t) => {
    const { root, vm } = fixture(t)
    activateFixture(root, vm)
    fixtureAuthority(root).payloadKey = randomBytes(32)
    seedEncryptedPackage(root)
    const registration = path.join(cragLicenseDirectory(root, vm), 'registration.code')
    const before = fs.readFileSync(registration)
    let authorizations = 0
    const result = await installKernelTargets({
      projectRoot: root,
      targets: [
        {
          ...target()[0],
          ...(scenario !== 'no-pin' && { expected_tag: 'v1.4.104' }),
          ...(scenario !== 'no-reissue' && { reissue: true }),
        },
      ],
      ...(scenario !== 'no-authorizer' && {
        cragSubscription: {
          authorizeInstall() {
            authorizations++
            if (scenario === 'issuer-unavailable') {
              throw Object.assign(new Error('issuer unavailable'), { code: 'crag_subscription_authority_unavailable' })
            }
          },
        },
      }),
      ops: {
        describeKernelCatalog: () => [{ id: 'crag', ready: true, release_tag: 'v1.4.104' }],
        stopSlot: () => assert.fail('unconfirmed migration must not stop the slot'),
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.items[0].stopped, false)
    assert.equal(authorizations, ['issuer-unavailable', 'permit-not-replaced'].includes(scenario) ? 1 : 0)
    assert.equal(
      result.items[0].code,
      scenario === 'issuer-unavailable'
        ? 'crag_subscription_authority_unavailable'
        : 'crag_subscription_migration_required',
    )
    assert.deepEqual(fs.readFileSync(registration), before)
    assert.equal(getVm(root, vm.id).status, 'running')
    assert.equal(getVm(root, vm.id).dataplane, 'wrap')
  })
}

for (const node_id of [undefined, 'remote-kvm']) {
  test(`a confirmed ${node_id ? 'remote' : 'local'} KVM reinstall verifies a signed host permit before stopping`, async (t) => {
    const machineId = randomBytes(16).toString('hex')
    const { root, vm, run } = fixture(t, {
      ...(node_id && { node_id }),
      runtime: { type: 'kvm' },
      fingerprint: { hostname: 'existing-computer', guest_machine_id: machineId },
    })
    fs.writeFileSync(path.join(root, 'vms', vm.id, 'machine-id'), `${machineId}\n`)
    const publicDir = cragSubscriptionPublicDirectory(root)
    fs.mkdirSync(publicDir, { recursive: true, mode: 0o755 })
    const hostId = randomBytes(32).toString('hex')
    const entitlement = issueHostEntitlement(root, hostId)
    fs.writeFileSync(path.join(publicDir, 'host_id'), `${hostId}\n`, { mode: 0o644 })
    fs.writeFileSync(path.join(publicDir, 'entitlement.code'), `${entitlement.code}\n`, { mode: 0o644 })
    const events = []
    const life = lifecycle(root)
    const result = await installKernelTargets({
      projectRoot: root,
      targets: [{ ...target()[0], expected_tag: 'v1.4.117' }],
      cragSubscription: {
        authorizeInstall(candidate) {
          events.push('bind')
          const machineCode = prepareCragSubscriptionBinding(root, candidate)
          const permit = issueSlotPermit(root, machineCode, hostId)
          activateCragSubscriptionBinding(root, candidate, permit.code)
        },
      },
      ops: {
        ...life.ops,
        ...(node_id && {
          deployBakedKernel: () => ({ ok: true }),
          writeKernelConfig: () => ({ configPath: path.join(run, 'kernel.json'), runDir: run }),
        }),
        describeKernelCatalog: () => [{ id: 'crag', ready: true, release_tag: 'v1.4.117' }],
        stopSlot(candidate) {
          const license = getCragLicense(root, candidate).license
          assert.equal(license.valid, true)
          assert.equal(license.scope, 'host')
          events.push('stop')
          return life.ops.stopSlot(candidate)
        },
      },
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(events, ['bind', 'stop'])
    const installed = getVm(root, vm.id)
    assert.equal(installed.runtime.type, 'kvm')
    assert.equal(getCragLicense(root, installed).license.scope, 'host')
    assert.equal(fs.readFileSync(path.join(root, 'vms', vm.id, 'machine-id'), 'utf8'), `${machineId}\n`)
  })
}

for (const [name, placement] of [
  ['local KVM without a pinned release', { runtime: { type: 'kvm' } }],
  ['remote KVM without a pinned release', { node_id: 'remote-node', runtime: { type: 'kvm' } }],
]) {
  test(`${name} cannot implicitly obtain a host permit during installation`, async (t) => {
    const { root } = fixture(t, placement)
    const result = await installKernelTargets({
      projectRoot: root,
      targets: target(),
      cragSubscription: { authorizeInstall: () => assert.fail('unexpected host permit request') },
      ops: {
        describeKernelCatalog: () => [{ id: 'crag', ready: true, release_tag: 'v1.4.117' }],
        checkCragLicense: () => ({ ok: false, code: 'license_required' }),
        stopSlot: () => assert.fail('unlicensed slot cannot be stopped'),
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.items[0].code, 'license_required')
    assert.equal(result.items[0].stopped, false)
  })
}

test('failed runtime admission for a pinned CRAG install prevents Authority and stop side effects', async (t) => {
  const { root, vm } = fixture(t)
  fs.writeFileSync(path.join(root, 'vms', vm.id, 'machine-id'), randomBytes(16).toString('hex') + '\n')
  const file = path.join(root, 'vms', `${vm.id}.json`)
  const before = fs.readFileSync(file)
  configureCragRuntimeAdmission(root, () => ({ ok: false, code: 'slot_limit_reached', error: 'at capacity' }))
  t.after(() => configureCragRuntimeAdmission(root))
  const result = await installKernelTargets({
    projectRoot: root,
    targets: [{ ...target()[0], expected_tag: 'v1.4.104' }],
    cragSubscription: { authorizeInstall: () => assert.fail('admission rejected the slot') },
    ops: {
      describeKernelCatalog: () => [{ id: 'crag', ready: true, release_tag: 'v1.4.104' }],
      stopSlot: () => assert.fail('admission rejected the slot'),
    },
  })
  assert.equal(result.items[0].code, 'slot_limit_reached')
  assert.equal(result.items[0].stopped, false)
  assert.deepEqual(fs.readFileSync(file), before)
})

for (const code of ['crag_subscription_authority_unavailable', 'kernel_release_changed']) {
  test(`pinned CRAG authorization aborts before stop on ${code}`, async (t) => {
    const { root, vm } = fixture(t)
    fs.writeFileSync(path.join(root, 'vms', vm.id, 'machine-id'), randomBytes(16).toString('hex') + '\n')
    let release_tag = 'v1.4.104'
    let calls = 0
    const result = await installKernelTargets({
      projectRoot: root,
      targets: [{ ...target()[0], expected_tag: release_tag }],
      cragSubscription: {
        async authorizeInstall() {
          calls++
          if (code === 'crag_subscription_authority_unavailable') throw Object.assign(new Error(code), { code })
          release_tag = 'v1.4.105'
        },
      },
      ops: {
        describeKernelCatalog: () => [{ id: 'crag', ready: true, release_tag }],
        stopSlot: () => assert.fail('authorization did not confirm this exact release'),
      },
    })
    assert.equal(calls, 1)
    assert.equal(result.items[0].code, code)
    assert.equal(result.items[0].stopped, false)
    const saved = getVm(root, vm.id)
    assert.equal(saved.status, 'running')
    assert.equal(saved.schedule_hold, undefined)
    assert.equal(saved.kernel_operation, undefined)
  })
}

for (const [patch, kernel, code] of [
  [{ platform: 'openai', family: 'codex', codex_kernel: true }, 'cli-node', 'kernel_codex_unsupported'],
  [{ node_platform: 'darwin' }, 'crag', 'kernel_install_unsupported_placement'],
]) {
  test(`unsupported target rejects ${code} without stopping`, async (t) => {
    const { root } = fixture(t, patch)
    const result = await installKernelTargets({
      projectRoot: root,
      targets: target(kernel),
      ops: {
        stopSlot() {
          assert.fail('unsupported stop')
        },
      },
    })
    assert.equal(result.items[0].code, code)
    assert.equal(result.items[0].stopped, false)
  })
}

for (const type of ['docker', 'kvm']) {
  test(`cluster ${type} install pushes the kernel and leaves the local tree untouched`, async (t) => {
    const { root, vm, home, run } = fixture(t, { node_id: 'remote-node', runtime: { type } })
    const calls = []
    const life = lifecycle(root, {
      checkCragLicense() {
        return { ok: true }
      },
      deployBakedKernel(_project, candidate, kernel) {
        calls.push({ id: candidate.id, node_id: candidate.node_id, kernel, dataplane: candidate.dataplane })
        assert.equal(fs.existsSync(path.join(home, '.kin', 'crag-v2')), false)
        return { ok: true }
      },
      writeKernelConfig() {
        return { configPath: path.join(run, 'kernel.json'), runDir: run }
      },
    })
    const result = await installKernelTargets({
      projectRoot: root,
      targets: target('crag'),
      ops: life.ops,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(life.stops(), 1)
    assert.deepEqual(calls, [{ id: 'vm-13', node_id: 'remote-node', kernel: 'crag', dataplane: 'crag' }])
    assert.equal(fs.readFileSync(path.join(home, '.kin', 'kin-kernel.bin'), 'utf8'), 'previous-kernel')
    assert.equal(fs.existsSync(path.join(home, '.kin', 'crag-kernel')), false)
    assert.equal(getVm(root, vm.id).dataplane, 'crag')
    assert.equal(getVm(root, vm.id).status, 'running')
  })
}

test('local kvm crag install writes the guest entry and does not push to a node', async (t) => {
  const built = fixture(t)
  activateCragLicense(built.root, built.vm, issueUniversalCode(built.root).code)
  const vm = { ...built.vm, runtime: { ...built.vm.runtime, type: 'kvm' } }
  fs.writeFileSync(path.join(built.root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  const life = lifecycle(built.root, {
    deployBakedKernel() {
      assert.fail('local kvm does not push')
    },
  })
  const licenseDir = cragLicenseDirectory(built.root, vm)
  const registration = fs.readFileSync(path.join(licenseDir, 'registration.code'))
  patchVmRecord(built.root, vm.id, (record) => {
    record.schedule_off = true
    record.schedule_off_reason = 'disabled'
  })
  const result = await installKernelTargets({
    projectRoot: built.root,
    targets: target('crag'),
    ops: life.ops,
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.match(fs.readFileSync(path.join(built.home, '.kin', 'kin-kernel'), 'utf8'), /crag-v2/)
  assert.equal(fs.readFileSync(path.join(built.home, 'workspace.txt'), 'utf8'), 'protected-workspace')
  assert.equal(getVm(built.root, vm.id).status, 'running')
  const config = JSON.parse(fs.readFileSync(path.join(built.run, 'kernel.json')))
  assert.equal(config.socket_path, '/run/kin-guest/kernel.sock')
  assert.equal(config.runtime_kind, 'kvm')
  assert.equal(config.runtime_variant, 'crag-v2')
  assert.equal(config.license_dir, '/run/kin/crag-license')
  assert.equal(config.claude_bin, '/home/kincli/.kin/crag-v2/claude-code-2.1.321/claude')
  const back = await installKernelTargets({
    projectRoot: built.root,
    targets: target('cli-node'),
    ops: life.ops,
  })
  assert.equal(back.ok, true, JSON.stringify(back))
  assert.doesNotMatch(fs.readFileSync(path.join(built.home, '.kin', 'kin-kernel'), 'utf8'), /crag-v2/)
  const saved = getVm(built.root, vm.id)
  assert.equal(saved.dataplane, 'wrap')
  assert.equal(saved.runtime.type, 'kvm')
  assert.equal(saved.schedule_off, true)
  assert.equal(saved.schedule_off_reason, 'disabled')
  assert.equal(saved.schedule_hold, undefined)
  assert.deepEqual(fs.readFileSync(path.join(licenseDir, 'registration.code')), registration)
  assert.equal(fs.readFileSync(path.join(built.home, '.claude/credentials.json'), 'utf8'), 'protected-credential')
})

test('KVM preflight requires the CRAG preload before stopping even for a free-kernel install', async (t) => {
  const { root, vm } = fixture(t, { runtime: { type: 'kvm' } })
  fs.rmSync(path.join(root, 'share/crag'), { recursive: true })
  const life = lifecycle(root)
  const result = await installKernelTargets({ projectRoot: root, targets: target('cli-node'), ops: life.ops })
  assert.equal(result.ok, false)
  assert.equal(result.items[0].code, 'crag_v2_package_missing')
  assert.equal(life.stops(), 0)
  assert.equal(getVm(root, vm.id).status, 'running')
})

test('legacy KVM without a CRAG version migrates stale config and missing payload through reinstall', async (t) => {
  const built = fixture(t, { dataplane: 'crag', runtime_type: 'kvm' })
  delete built.vm.runtime.type
  fs.writeFileSync(path.join(built.root, 'vms', `${built.vm.id}.json`), JSON.stringify(built.vm))
  activateCragLicense(built.root, built.vm, issueUniversalCode(built.root).code)
  fs.mkdirSync(built.run, { recursive: true })
  fs.writeFileSync(
    path.join(built.run, 'kernel.json'),
    JSON.stringify({
      dataplane: 'crag',
      claude_bin: '/opt/kin/cc-node',
      socket_path: '/run/kin/kernel.sock',
    }),
  )
  const life = lifecycle(built.root)
  const result = await installKernelTargets({ projectRoot: built.root, targets: target(), ops: life.ops })
  assert.equal(result.ok, true, JSON.stringify(result))
  const saved = getVm(built.root, built.vm.id)
  assert.equal(saved.crag_kernel_version, 'v2')
  assert.equal(saved.kernel_installation.kernel, 'crag')
  assert.ok(saved.kernel_installation.version)
  const config = JSON.parse(fs.readFileSync(path.join(built.run, 'kernel.json')))
  assert.equal(config.runtime_kind, 'kvm')
  assert.equal(config.socket_path, '/run/kin-guest/kernel.sock')
  assert.equal(config.claude_bin, '/home/kincli/.kin/crag-v2/claude-code-2.1.321/claude')
  assert.ok(fs.existsSync(path.join(built.home, '.kin/crag-v2/claude-code-2.1.321/claude')))
  assert.equal(result.items[0].restarted, true)
  assert.equal(saved.schedulable, true)
  assert.equal(fs.readFileSync(path.join(built.home, '.claude/credentials.json'), 'utf8'), 'protected-credential')
})

test('payload publish replaces only changed files and the kvm selector execs the live entry', () => {
  const plan = selectChangedPayloadFiles(
    [
      { rel: 'crag-kernel', sha256: 'aaa' },
      { rel: 'crag-v2/claude-code-2.1.321/claude', sha256: 'bbb' },
    ],
    new Map([['crag-v2/claude-code-2.1.321/claude', 'bbb']]),
  )
  assert.deepEqual(
    plan.map((file) => file.rel),
    ['crag-kernel'],
  )
  assert.equal(Object.hasOwn(plan[0], 'unlink'), false)
  assert.match(kvmKernelSelector('crag'), /^#!\/bin\/sh\nexec \/opt\/kin-live\/crag-kernel "\$@"\n$/)
  assert.match(kvmKernelSelector('cli-node'), /exec \/opt\/kin-live\/kin-kernel /)
})

test('cluster Docker CRAG install is not rejected as a local-only slot', async (t) => {
  const { root } = fixture(t, { node_id: 'remote-node' })
  const result = await installKernelTargets({
    projectRoot: root,
    targets: target('crag'),
    ops: {
      stopSlot() {
        assert.fail('preflight cannot stop')
      },
    },
  })
  assert.notEqual(result.items[0].code, 'crag_v2_unsupported_placement')
  assert.equal(result.items[0].stopped, false)
})

test('CRAG update stages a stopped cluster slot without starting it, including after reconnect', async (t) => {
  const { root, vm } = fixture(t, {
    status: 'stopped',
    node_id: 'remote-node',
    dataplane: undefined,
    crag_kernel_version: undefined,
    schedule_off: true,
    schedule_off_reason: 'stopped',
  })
  const routing = { inference: { dataplane: 'crag' } }
  const payload_tag = 'payload-2026.11.20-crag-3.1.8'
  const targets = [{ id: vm.id, kernel: 'crag', payload_tag, update_existing: true }]
  let attempts = 0
  const ops = {
    describeKernelCatalog: () => [{ id: 'crag', ready: true, version: '3.1.8', payload_tag }],
    checkCragLicense: () => ({ ok: true }),
    nodeReady: () => true,
    stopSlot: (candidate) => {
      assert.equal(candidate.status, 'stopped')
      return { ok: true }
    },
    suspendVmRuntimeRestart: () => assert.fail('不能对本机 Docker 操作集群槽'),
    startSlotReady: () => assert.fail('更新不能启动已停止的槽'),
    deployBakedKernel: async (_root, candidate) => {
      assert.equal(candidate.node_id, 'remote-node')
      return ++attempts === 1 ? { ok: false, code: 'ssh_closed' } : { ok: true }
    },
    initializeSlotSeedFiles: async () => {},
    writeKernelConfig: () => ({ configPath: '/tmp/kernel.json' }),
  }
  const first = await installKernelTargets({ projectRoot: root, targets, routing, ops })
  assert.equal(first.items[0].code, 'ssh_closed')
  assert.equal(getVm(root, vm.id).kernel_operation.phase, 'pending')
  const resumed = await resumePendingKernelInstalls({ projectRoot: root, routing, ops })
  assert.equal(resumed.ok, true, JSON.stringify(resumed))
  assert.equal(resumed.items[0].payload_tag, payload_tag)
  assert.equal(resumed.items[0].restarted, false)
  const saved = getVm(root, vm.id)
  assert.equal(saved.status, 'stopped')
  assert.equal(saved.schedule_off, true)
  assert.equal(saved.kernel_operation, undefined)
  assert.equal(saved.kernel_installation.payload_tag, payload_tag)
  assert.equal(saved.dataplane, undefined)
  assert.equal(saved.crag_kernel_version, undefined)
})

for (const field of ['active_requests', 'continuations', 'queued', 'missing_relay']) {
  test(`CRAG update leaves a cluster slot with ${field} untouched`, async (t) => {
    const relay = '/tmp/remote-kernel.sock'
    const { root, vm } = fixture(t, {
      node_id: 'remote-node',
      dataplane: 'crag',
      runtime: field === 'missing_relay' ? {} : { kernel_socket: relay },
    })
    const payload_tag = 'payload-2026.11.20-crag-3.1.8'
    const result = await installKernelTargets({
      projectRoot: root,
      targets: [{ id: vm.id, kernel: 'crag', payload_tag, update_existing: true }],
      ops: {
        describeKernelCatalog: () => [{ id: 'crag', ready: true, payload_tag }],
        checkCragLicense: () => ({ ok: true }),
        stopSlot: () => assert.fail('不能停止仍有请求或续接的槽'),
        rustKernelHealth: async (exec) => {
          assert.notEqual(field, 'missing_relay', '缺少节点转发时不能探测本机套接字')
          assert.equal(exec.vm.runtime.kernel_socket, relay)
          assert.equal(getVm(root, vm.id).schedule_hold.reason, 'maintenance')
          return {
            healthy: true,
            runtime_variant: 'crag-v2',
            license_valid: true,
            active_requests: 0,
            continuations: 0,
            queued: 0,
            [field]: 1,
          }
        },
      },
    })
    assert.equal(result.items[0].code, 'crag_slot_not_idle')
    const saved = getVm(root, vm.id)
    assert.equal(saved.status, 'running')
    assert.equal(saved.schedule_hold, undefined)
    assert.equal(saved.kernel_operation, undefined)
  })
}

for (const stage of ['policy', 'materialize', 'seed', 'config']) {
  test(`post-stop ${stage} failure retains previous selection and remains durably stopped`, async (t) => {
    const { root, vm } = fixture(t, { dataplane: 'crag', crag_kernel_version: 'v2' })
    const life = lifecycle(root, {
      ...(stage === 'policy'
        ? { suspendVmRuntimeRestart: () => ({ ok: false, code: 'policy_denied', error: 'policy denied' }) }
        : {}),
      ...(stage === 'materialize'
        ? { materializeResolvedKernel: () => ({ ok: false, code: 'disk_full', error: 'disk full' }) }
        : {}),
      ...(stage === 'seed'
        ? {
            initializeSlotSeedFiles: () => {
              throw Object.assign(new Error('publish denied'), { code: 'seed_publish_failed' })
            },
          }
        : {}),
      ...(stage === 'config'
        ? {
            writeKernelConfig: () => {
              throw Object.assign(new Error('write denied'), { code: 'EACCES' })
            },
          }
        : {}),
    })
    const result = await installKernelTargets({ projectRoot: root, targets: target('cli-node'), ops: life.ops })
    assert.equal(result.ok, false)
    assert.equal(result.items[0].stopped, true)
    const saved = getVm(root, vm.id)
    assert.equal(saved.status, 'stopped')
    assert.equal(saved.schedule_hold.reason, 'maintenance')
    assert.equal(saved.kernel_operation.phase, 'failed')
    assert.equal(saved.runtime.stopped, true)
    assert.equal(saved.dataplane, 'crag')
    assert.equal(saved.crag_kernel_version, 'v2')
    assert.equal(saved.kernel_installation, undefined)
  })
}
test('failed old-version restart stays stopped and does not report the slot as running', async (t) => {
  const previous = { kernel: 'crag', version: '3.1.2', installed_at: '2026-11-16T00:00:00Z' }
  const { root, vm, home } = fixture(t, {
    dataplane: 'crag',
    crag_kernel_version: 'v2',
    kernel_installation: previous,
    runtime: { type: 'docker', pid: 77, ip: '10.0.0.8' },
  })
  activateFixture(root, vm)
  assert.equal(materializeResolvedKernel(root, vm).ok, true)
  const manifest = path.join(home, '.kin', 'crag-v2', 'manifest.json')
  const oldManifest = fs.readFileSync(manifest)
  let starts = 0
  const life = lifecycle(root, {
    materializeResolvedKernel: () => ({ ok: false, code: 'disk_full', error: 'disk full' }),
    stopSlot() {
      return { ok: true }
    },
    startSlotReady() {
      starts++
      return { ok: false, code: 'kernel_health_timeout' }
    },
  })
  const result = await installKernelTargets({ projectRoot: root, targets: target('crag'), ops: life.ops })
  assert.equal(starts, 1, 'only the verified old version may be started')
  assert.equal(result.items[0].code, 'disk_full', JSON.stringify(result))
  assert.equal(result.items[0].stopped, true)
  assert.equal(result.items[0].rolled_back, false)
  assert.match(result.items[0].error, /未能验证原版本恢复/)
  assert.doesNotMatch(result.items[0].error, /原版本仍在运行/)
  assert.deepEqual(fs.readFileSync(manifest), oldManifest)
  const saved = getVm(root, vm.id)
  assert.equal(saved.status, 'stopped')
  assert.equal(saved.runtime.pid, null)
  assert.equal(saved.kernel_operation.phase, 'failed')
  const backup = path.join(root, 'vms', vm.id, saved.kernel_operation.rollback_package, 'package', 'manifest.json')
  assert.deepEqual(fs.readFileSync(backup), oldManifest)
})

test('VM lock and watchdog drain complete before stop; newer credentials are preserved', async (t) => {
  const { root, vm } = fixture(t)
  const file = path.join(root, 'vms', `${vm.id}.json`)
  let unlock, finishRestart, heldResolve
  const lockWait = new Promise((resolve) => {
    unlock = resolve
  })
  const draining = new Promise((resolve) => {
    finishRestart = resolve
  })
  const held = new Promise((resolve) => {
    heldResolve = resolve
  })
  let stops = 0
  const writer = withVmLock(file, async () => {
    await lockWait
    const current = JSON.parse(fs.readFileSync(file))
    current.claude.account_uuid = 'newer-account'
    fs.writeFileSync(file, JSON.stringify(current))
  })
  const operation = installKernelTargets({
    projectRoot: root,
    targets: target('cli-node'),
    watchdog: {
      hold() {
        heldResolve()
        return draining
      },
      release() {},
      reset() {
        assert.equal(getVm(root, vm.id).status, 'running')
      },
    },
    ops: {
      stopSlot(current) {
        stops++
        assert.equal(current.claude.account_uuid, 'newer-account')
        return { ok: true }
      },
      suspendVmRuntimeRestart: () => ({ ok: true }),
      startSlotReady: () => ({ ok: true, rust_ok: true }),
    },
  })
  assert.equal(stops, 0)
  unlock()
  await writer
  await held
  assert.equal(stops, 0, 'in-flight watchdog restart still owns the runtime')
  finishRestart()
  const result = await operation
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(stops, 1)
  assert.equal(getVm(root, vm.id).claude.account_uuid, 'newer-account')
})

test('a failed stop leaves the previous record and package untouched and releases the watchdog', async (t) => {
  const { root, vm, home } = fixture(t)
  const before = fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`))
  let released = false
  const result = await installKernelTargets({
    projectRoot: root,
    targets: target('cli-node'),
    watchdog: {
      hold() {},
      release() {
        released = true
      },
    },
    ops: {
      stopSlot: () => ({ ok: false, error: 'stop denied' }),
      materializeResolvedKernel() {
        assert.fail('cannot replace a running kernel')
      },
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.items[0].stopped, false)
  assert.equal(result.items[0].code, 'kernel_stop_failed')
  assert.equal(released, true)
  const saved = getVm(root, vm.id)
  for (const [key, value] of Object.entries(JSON.parse(before))) assert.deepEqual(saved[key], value)
  assert.equal(saved.kernel_operation, undefined)
  assert.equal(saved.schedule_hold, undefined)
  assert.equal(fs.readFileSync(path.join(home, '.kin', 'kin-kernel.bin'), 'utf8'), 'previous-kernel')
})

test('package publication during asynchronous stop reports the version actually materialized', async (t) => {
  const { root, vm, home } = fixture(t)
  const cli = path.join(root, 'share', 'wrap-cli')
  fs.writeFileSync(path.join(cli, 'RELEASE.json'), JSON.stringify({ version: '1.0.0' }))
  const life = lifecycle(root, {
    async stopSlot() {
      await Promise.resolve()
      fs.writeFileSync(path.join(cli, 'RELEASE.json'), JSON.stringify({ version: '2.0.0' }))
      fs.writeFileSync(path.join(cli, 'kin-kernel.bin'), elf('new-publication'))
      return { ok: true }
    },
  })
  const result = await installKernelTargets({ projectRoot: root, targets: target('cli-node'), ops: life.ops })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.items[0].version, '2.0.0')
  assert.equal(getVm(root, vm.id).kernel_installation.version, '2.0.0')
  assert.ok(fs.readFileSync(path.join(home, '.kin', 'kin-kernel.bin')).equals(elf('new-publication')))
})

test('a confirmed CRAG payload cannot install another variant of the same version', async (t) => {
  const { root, vm } = fixture(t)
  activateFixture(root, vm)
  const standard = 'payload-2026.11.15-crag-3.0.5'
  const legacy = `${standard}-legacy`
  let cached = standard
  const life = lifecycle(root, {
    describeKernelCatalog: () => [{ id: 'crag', ready: true, version: '3.0.5', payload_tag: cached }],
  })
  const install = () =>
    installKernelTargets({
      projectRoot: root,
      targets: [{ id: vm.id, kernel: 'crag', payload_tag: legacy }],
      ops: life.ops,
    })
  const refused = await install()
  assert.equal(refused.items[0].code, 'crag_payload_changed')
  assert.equal(refused.items[0].stopped, false)
  assert.equal(getVm(root, vm.id).status, 'running')
  cached = legacy
  const installed = await install()
  assert.equal(installed.ok, true, JSON.stringify(installed))
  assert.equal(installed.items[0].payload_tag, legacy)
  assert.equal(summarizeVm(getVm(root, vm.id), root).kernel_installation.payload_tag, legacy)
})

test('failed STOPPED persistence keeps the watchdog held rather than reviving stale running intent', async (t) => {
  const { root, vm, home } = fixture(t)
  const file = path.join(root, 'vms', `${vm.id}.json`)
  const rename = fs.renameSync
  let released = false
  let physicallyStopped = false
  const watchdog = {
    hold() {},
    release() {
      released = true
    },
  }
  fs.renameSync = (from, to) => {
    if (to === file && physicallyStopped)
      throw Object.assign(new Error('fixture record permission failure'), { code: 'EACCES' })
    return rename(from, to)
  }
  try {
    const result = await installKernelTargets({
      projectRoot: root,
      targets: target('cli-node'),
      watchdog,
      ops: {
        stopSlot() {
          physicallyStopped = true
          return { ok: true }
        },
        materializeResolvedKernel() {
          assert.fail('cannot replace before stopped intent is durable')
        },
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.items[0].stopped, true)
    assert.equal(result.items[0].code, 'kernel_stop_persist_failed')
    assert.equal(released, false)
    assert.equal(fs.readFileSync(path.join(home, '.kin', 'kin-kernel.bin'), 'utf8'), 'previous-kernel')
  } finally {
    fs.renameSync = rename
  }
  assert.equal(releaseKernelInstallSafetyHold(root + '-different-project', vm.id, watchdog), false)
  assert.equal(
    releaseKernelInstallSafetyHold(root, vm.id, {
      release() {
        assert.fail('foreign watchdog hold')
      },
    }),
    false,
  )
  const failedRetry = await installKernelTargets({
    projectRoot: root,
    targets: target('cli-node'),
    watchdog,
    ops: {
      stopSlot: () => ({ ok: false, error: 'retry stop denied' }),
    },
  })
  assert.equal(failedRetry.ok, false)
  assert.equal(released, false, 'an unsuccessful retry cannot clear an inherited installer safety hold')
  const retry = await installKernelTargets({
    projectRoot: root,
    targets: target('cli-node'),
    watchdog,
    ops: lifecycle(root).ops,
  })
  assert.equal(retry.ok, true, JSON.stringify(retry))
  assert.equal(released, true, 'successful explicit installation releases its inherited safety hold')
  assert.equal(
    releaseKernelInstallSafetyHold(root, vm.id, watchdog),
    false,
    'no generic watchdog release once installer hold is gone',
  )
})

for (const recoveredOk of [true, false]) {
  test(`explicit recovery ${recoveredOk ? 'clears' : 'preserves'} installer safety marker based on the full recovery report`, async (t) => {
    const { root, vm } = fixture(t)
    const file = path.join(root, 'vms', `${vm.id}.json`)
    let physicallyRunning = true
    const held = new Set()
    const watchdog = {
      hold(id) {
        held.add(id)
      },
      release(id) {
        held.delete(id)
      },
      reset() {
        return { faulted: false }
      },
    }
    const rename = fs.renameSync
    fs.renameSync = (from, to) => {
      if (to === file && !physicallyRunning)
        throw Object.assign(new Error('fixture stopped-intent write denied'), { code: 'EACCES' })
      return rename(from, to)
    }
    try {
      const stopped = await installKernelTargets({
        projectRoot: root,
        targets: target('cli-node'),
        watchdog,
        ops: {
          stopSlot() {
            physicallyRunning = false
            return { ok: true }
          },
        },
      })
      assert.equal(stopped.items[0].code, 'kernel_stop_persist_failed')
      assert.equal(stopped.items[0].stopped, true)
      assert.equal(physicallyRunning, false)
      assert.equal(held.has(vm.id), true)
    } finally {
      fs.renameSync = rename
    }
    const response = {}
    const handle = createPanelHandler({
      cfg: { paths: { project: root } },
      routingConfig: {},
      kernelWatchdog: watchdog,
      kernelRecoveryOps: {
        cluster: () => null,
        settleMs: 0,
        stopSlot() {
          physicallyRunning = false
          return { ok: true }
        },
        powerOn() {
          physicallyRunning = true
          patchVmRecord(root, vm.id, { status: 'running' })
          return { ok: true, boot: { rust: { ok: true } } }
        },
        // The failed case boots but fails diagnosis: recoverSlot still returns outer ok:true.
        diagnose: () => ({
          ok: recoveredOk,
          checks: recoveredOk ? [] : [{ id: 'kernel', status: 'error', code: 'kernel_down' }],
        }),
      },
      requireAuth(req) {
        req.panelUser = 'fixture'
        req.panelRole = 'admin'
        return true
      },
      json(_res, status, body) {
        response.status = status
        response.body = body
        return true
      },
      readBody: async () => ({}),
    })
    await handle({ method: 'POST' }, {}, new URL(`http://localhost/api/panel/vms/${vm.id}/recover`))
    assert.equal(response.status, 200)
    assert.equal(response.body.data.ok, recoveredOk)
    assert.equal(physicallyRunning, true)
    assert.equal(getVm(root, vm.id).status, 'running')
    const failedPreflight = await installKernelTargets({
      projectRoot: root,
      targets: target('crag'),
      watchdog,
      ops: {
        stopSlot() {
          assert.fail('unlicensed preflight must not stop the recovered runtime')
        },
      },
    })
    assert.equal(failedPreflight.ok, false)
    assert.equal(failedPreflight.items[0].stopped, false)
    assert.equal(physicallyRunning, true)
    assert.equal(
      held.has(vm.id),
      !recoveredOk,
      'successful recovery must not leave a stale installer marker; failed recovery must not clear it',
    )
  })
}

test('kernel installation resets an open request circuit only after verified readiness', async (t) => {
  const { root } = fixture(t)
  const account = 'existing-account'
  t.after(() => unitCircuit.reset(account))
  for (let i = 0; i < 3; i++) unitCircuit.recordFailure(account)
  const failed = await installKernelTargets({
    projectRoot: root,
    targets: target('cli-node'),
    ops: lifecycle(root, { startSlotReady: () => ({ ok: true, rust_ok: false }) }).ops,
  })
  assert.equal(failed.ok, false)
  assert.equal(unitCircuit.view(account).state, 'open')
  const repaired = await installKernelTargets({
    projectRoot: root,
    targets: target('cli-node'),
    ops: {
      ...lifecycle(root).ops,
      stopSlot: () => ({ ok: true }),
    },
  })
  assert.equal(repaired.ok, true, JSON.stringify(repaired))
  assert.equal(unitCircuit.view(account).state, 'closed')
})

test('a forced cancel stops the installer at its next checkpoint without starting the slot', async (t) => {
  const { root, vm } = fixture(t)
  let releaseStop
  const stopping = new Promise((resolve) => (releaseStop = resolve))
  let stopEntered
  const entered = new Promise((resolve) => (stopEntered = resolve))
  let started = false
  const life = lifecycle(root, {
    async stopSlot(current) {
      stopEntered()
      await stopping
      return { ok: true, runtime: { ...current.runtime, stopped: true } }
    },
    startSlotReady() {
      started = true
      return { ok: true, rust_ok: true }
    },
  })
  const running = installKernelTargets({ projectRoot: root, targets: target('cli-node'), ops: life.ops })
  await entered
  assert.deepEqual(
    listActiveKernelInstalls().map(({ id, kernel, phase }) => ({ id, kernel, phase })),
    [{ id: vm.id, kernel: 'cli-node', phase: 'kernel_stop_failed' }],
  )
  const cancel = cancelKernelInstall(vm.id)
  assert.equal(cancel.ok, true, JSON.stringify(cancel))
  releaseStop()
  const result = await running
  assert.equal(result.ok, false)
  assert.equal(result.items[0].code, 'kernel_install_cancelled')
  assert.equal(result.items[0].stopped, true)
  assert.equal(started, false, 'a cancelled install must not start the slot')
  const saved = getVm(root, vm.id)
  assert.equal(saved.kernel_operation.phase, 'failed')
  assert.equal(saved.kernel_operation.code, 'kernel_install_cancelled')
  assert.equal(saved.schedulable, false, 'a stopped slot stays under maintenance for review')
  assert.deepEqual(listActiveKernelInstalls(), [])
  assert.equal(cancelKernelInstall(vm.id).code, 'kernel_install_not_running')
})

test('a kernel start failure keeps the runtime cause on the result and the install record', async (t) => {
  const { root, vm } = fixture(t)
  const result = await installKernelTargets({
    projectRoot: root,
    targets: target('cli-node'),
    ops: lifecycle(root, {
      // Container came up; the kernel behind it did not. The cause lives on boot.rust.
      startSlotReady: () => ({
        ok: true,
        rust_ok: false,
        rust: {
          ok: false,
          code: 'kernel_health_timeout',
          error: 'Legacy telemetry process did not stop',
          rust: { ok: false, reason: 'legacy_telemetry_stop_failed' },
        },
      }),
    }).ops,
  })
  assert.equal(result.ok, false)
  assert.equal(result.items[0].code, 'kernel_health_timeout', JSON.stringify(result))
  assert.equal(result.items[0].error, 'Legacy telemetry process did not stop')
  const operation = getVm(root, vm.id).kernel_operation
  assert.equal(operation.phase, 'failed')
  assert.equal(operation.code, 'kernel_start_failed', 'the phase stays the record code')
  assert.equal(operation.failure.code, 'kernel_health_timeout')
  assert.equal(operation.failure.error, 'Legacy telemetry process did not stop')
  assert.equal(operation.failure.reason, 'legacy_telemetry_stop_failed')
  assert.ok(Date.parse(operation.failure.at) > 0)
})

test('a start failure without runtime detail still reports the generic phase', async (t) => {
  const { root, vm } = fixture(t)
  const result = await installKernelTargets({
    projectRoot: root,
    targets: target('cli-node'),
    ops: lifecycle(root, { startSlotReady: () => ({ ok: true, rust_ok: false }) }).ops,
  })
  assert.equal(result.items[0].code, 'kernel_start_failed')
  assert.equal(result.items[0].error, '内核重启或健康检查失败')
  assert.equal(getVm(root, vm.id).kernel_operation.failure.reason, null)
})

test('CRAG install preflight rejects a non-amd64 slot with crag_v2_arch_mismatch before stopping', async (t) => {
  const { root, vm } = fixture(t)
  fs.rmSync(path.join(root, 'share/crag/kernels/v2/arm64'), { recursive: true, force: true })
  if (!fs.existsSync(path.join(root, 'share/crag/kernels/v2/amd64/manifest.json'))) {
    seedEncryptedPackage(root, { arch: 'amd64' })
  }
  const armVmFile = path.join(root, 'vms', `${vm.id}.json`)
  const armRecord = { ...JSON.parse(fs.readFileSync(armVmFile, 'utf8')), runtime: { type: 'docker', arch: 'arm64' } }
  fs.writeFileSync(armVmFile, JSON.stringify(armRecord))
  const before = fs.readFileSync(armVmFile)
  const result = await installKernelTargets({
    projectRoot: root,
    targets: target('crag'),
    ops: {
      describeKernelCatalog: undefined,
      stopSlot() {
        assert.fail('arch mismatch preflight must not stop the slot')
      },
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.items[0].code, 'crag_v2_arch_mismatch')
  assert.equal(result.items[0].stopped, false)
  assert.deepEqual(fs.readFileSync(armVmFile), before)
})
