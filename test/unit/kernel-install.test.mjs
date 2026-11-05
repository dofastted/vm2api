import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installKernelTargets, releaseKernelInstallSafetyHold } from '../../src/lib/vm/kernel-install.mjs'
import { describeKernelCatalog } from '../../src/lib/admin/kernel-catalog.mjs'
import { getVm, patchVmRecord, summarizeVm } from '../../src/lib/vm/vm-registry.mjs'
import { withVmLock } from '../../src/lib/vm/vm-file.mjs'
import { cragLicenseDirectory } from '../../src/lib/vm/crag-license.mjs'
import { writeKernelConfig } from '../../src/lib/transport/rust-kernel-supervisor.mjs'
import { activateFixture, issueFixtureCode, seedEncryptedPackage } from '../fixtures/crag-license.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

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
    claude: { account_uuid: 'existing-account' },
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
        assert.fail('installation must not reset watchdog')
      },
    },
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(life.stops(), 1)
  assert.equal(held, false)
  const persisted = getVm(root, vm.id)
  assert.equal(persisted.dataplane, 'crag')
  assert.equal(persisted.crag_kernel_version, 'v2')
  assert.equal(persisted.status, 'stopped')
  assert.equal(persisted.runtime.stopped, true)
  assert.equal(persisted.runtime.worker_run_dir, run)
  assert.equal(persisted.schedule_off, true)
  assert.equal(persisted.schedule_off_reason, 'stopped')
  assert.equal(persisted.schedulable, false)
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
  assert.equal(saved.status, 'stopped')
  assert.equal(saved.schedule_off_reason, 'disabled', 'original operator scheduling-off intent survives')
  assert.ok(fs.readFileSync(path.join(home, '.kin', 'kin-kernel.bin')).equals(elf('free-kernel')))
  assert.ok(fs.readFileSync(path.join(home, '.kin', 'cli-node')).equals(elf('free-cli')))
  assert.equal(fs.existsSync(cragLicenseDirectory(root, vm)), false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(run, 'kernel.json'))).dataplane, 'wrap')
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
  [{ node_id: 'remote-node' }, 'cli-node', 'kernel_install_unsupported_placement'],
  [{ runtime: { type: 'kvm' } }, 'crag', 'crag_v2_unsupported_placement'],
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
    assert.equal(saved.schedule_off, true)
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
        assert.fail('no reset')
      },
    },
    ops: {
      stopSlot(current) {
        stops++
        assert.equal(current.claude.account_uuid, 'newer-account')
        return { ok: true }
      },
      suspendVmRuntimeRestart: () => ({ ok: true }),
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
  assert.deepEqual(fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`)), before)
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
  const watchdog = {
    hold() {},
    release() {
      released = true
    },
  }
  fs.renameSync = (from, to) => {
    if (to === file) throw Object.assign(new Error('fixture record permission failure'), { code: 'EACCES' })
    return rename(from, to)
  }
  try {
    const result = await installKernelTargets({
      projectRoot: root,
      targets: target('cli-node'),
      watchdog,
      ops: {
        stopSlot: () => ({ ok: true }),
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
      if (to === file) throw Object.assign(new Error('fixture stopped-intent write denied'), { code: 'EACCES' })
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
        diagnose: () => ({ ok: recoveredOk }),
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
