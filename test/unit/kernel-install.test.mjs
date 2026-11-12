import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  installKernelTargets,
  releaseKernelInstallSafetyHold,
  resumePendingKernelInstalls,
} from '../../src/lib/vm/kernel-install.mjs'
import { kvmKernelSelector, selectChangedPayloadFiles } from '../../src/lib/cluster/remote-slot-files.mjs'
import { describeKernelCatalog } from '../../src/lib/admin/kernel-catalog.mjs'
import { getVm, patchVmRecord, summarizeVm } from '../../src/lib/vm/vm-registry.mjs'
import { withVmLock } from '../../src/lib/vm/vm-file.mjs'
import { activateCragLicense, cragLicenseDirectory } from '../../src/lib/vm/crag-license.mjs'
import { writeKernelConfig } from '../../src/lib/transport/rust-kernel-supervisor.mjs'
import {
  activateFixture,
  issueFixtureCode,
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
function lifecycle(root, extra = {}) {
  let stopCount = 0
  return {
    ops: {
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

test('native switch stops before real replacement, writes candidate config and commits only after success', async (t) => {
  const { root, vm, home, run } = fixture(t)
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
    targets: target(),
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

for (const state of ['unlicensed', 'expired', 'wrong-vm', 'package-tamper']) {
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
      targets: target(),
      ops: {
        stopSlot() {
          assert.fail('preflight cannot stop')
        },
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.items[0].stopped, false)
    assert.equal(fs.readFileSync(path.join(home, '.kin', 'kin-kernel.bin'), 'utf8'), 'previous-kernel')
    assert.deepEqual(fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`)), record)
    if (beforeGrant) assert.deepEqual(fs.readFileSync(codeFile), beforeGrant)
    else assert.equal(fs.existsSync(cragLicenseDirectory(root, vm)), false)
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

test('cluster install pushes the kernel and leaves the local tree, including crag-kernel, untouched', async (t) => {
  const { root, vm, home, run } = fixture(t, { node_id: 'remote-node' })
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
  const result = await installKernelTargets({
    projectRoot: built.root,
    targets: target('crag'),
    ops: life.ops,
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.match(fs.readFileSync(path.join(built.home, '.kin', 'kin-kernel'), 'utf8'), /crag-v2/)
  assert.equal(fs.readFileSync(path.join(built.home, 'workspace.txt'), 'utf8'), 'protected-workspace')
  assert.equal(getVm(built.root, vm.id).status, 'running')
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

for (const stage of ['policy', 'materialize', 'config']) {
  test(`post-stop ${stage} failure retains previous selection and remains durably stopped`, async (t) => {
    const { root, vm } = fixture(t, { dataplane: 'crag', crag_kernel_version: 'v2' })
    const life = lifecycle(root, {
      ...(stage === 'policy'
        ? { suspendVmRuntimeRestart: () => ({ ok: false, code: 'policy_denied', error: 'policy denied' }) }
        : {}),
      ...(stage === 'materialize'
        ? { materializeResolvedKernel: () => ({ ok: false, code: 'disk_full', error: 'disk full' }) }
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
