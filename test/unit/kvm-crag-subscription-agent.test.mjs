import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  activateCragSubscriptionBinding,
  cragLicenseDirectory,
  prepareCragSubscriptionBinding,
  readCragSubscriptionFiles,
} from '../../src/lib/vm/crag-license.mjs'
import { cragSubscriptionPublicDirectory } from '../../src/lib/vm/crag-subscription-paths.mjs'
import {
  blockKvmCragSubscription,
  clearKvmCragSubscription,
  getKvmCragSubscriptionStatus,
  holdKvmCragSubscriptionPublications,
  kvmCragSubscriptionStatusCommand,
  publishKvmCragSubscription,
  publishLocalKvmCragLicense,
} from '../../src/lib/vm/kvm-crag-subscription.mjs'
import { ensureSlotAgentToken } from '../../src/lib/vm/kvm-slot-agent-client.mjs'
import {
  issueHostEntitlement,
  issueSlotPermit,
  issueUniversalCode,
  seedEncryptedPackage,
} from '../fixtures/crag-license.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const AGENT_SCRIPT = path.join(REPO_ROOT, 'docker', 'kin-kvm', 'guest', 'kin-slot-agent')
const linuxTest = process.platform === 'linux' ? test : test.skip

const envNames = ['KIN_SLOT_RUN_ROOT', 'KIN_CRAG_V2_ROOT', 'KIN_DATA_DIR', 'KIN_KVM_MODE', 'KIN_OS_RUNTIME_MODE']
const savedEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]))

before(() => {
  for (const name of envNames) delete process.env[name]
})
after(() => {
  for (const name of envNames) {
    if (savedEnv[name] === undefined) delete process.env[name]
    else process.env[name] = savedEnv[name]
  }
})

function hasDevShmTmpfs() {
  try {
    return fs.statfsSync('/dev/shm').type === 0x01021994
  } catch {
    return false
  }
}

function createFixture(t, { kernel = 'crag-debian13' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kvm-sub-agent-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  seedEncryptedPackage(root)

  const hostId = crypto.randomBytes(32).toString('hex')
  const publicDir = cragSubscriptionPublicDirectory(root)
  fs.mkdirSync(publicDir, { recursive: true, mode: 0o755 })
  fs.writeFileSync(path.join(publicDir, 'host_id'), `${hostId}\n`, { mode: 0o644 })

  const entitlementFile = path.join(publicDir, 'entitlement.code')
  const rights = (overrides = {}) => {
    const issued = issueHostEntitlement(root, hostId, { slot_limit: 8, ...overrides })
    fs.writeFileSync(entitlementFile, `${issued.code}\n`, { mode: 0o644 })
    return issued
  }
  rights()

  const addVm = (id, seat, vmKernel = kernel) => {
    const vm = {
      id,
      kernel: vmKernel,
      status: 'running',
      dataplane: 'crag',
      crag_kernel_version: 'v2',
      runtime: { type: 'kvm' },
      fingerprint: { guest_machine_id: crypto.randomBytes(16).toString('hex') },
    }
    const vmDir = path.join(root, 'vms', vm.id)
    const kvmDir = path.join(vmDir, 'kvm')
    fs.mkdirSync(kvmDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
    fs.writeFileSync(path.join(vmDir, 'machine-id'), `${vm.fingerprint.guest_machine_id}\n`)
    const challenge = prepareCragSubscriptionBinding(root, vm)
    const permit = issueSlotPermit(root, challenge, hostId, { seat })
    activateCragSubscriptionBinding(root, vm, permit.code)
    return { vm, kvmDir }
  }

  const { vm, kvmDir } = addVm('vm-d13-1', 1)
  return { root, vm, kvmDir, addVm, rights, publicDir, entitlementFile }
}

function inspectRunningRunner(running = true) {
  const calls = []
  const runDockerExec = async (args, options = {}) => {
    calls.push({ args, options })
    if (args[0] === 'container' && args[1] === 'inspect') {
      return { ok: true, code: 0, stdout: running ? 'true\n' : 'false\n', error: '' }
    }
    return { ok: true, code: 0, stdout: '{"ok":true}\n', error: '' }
  }
  return { runDockerExec, calls }
}

async function spawnRealSlotAgent(t, { kvmDir, machineId, cragRoot, token }) {
  const guestBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-guest-sim-'))
  t.after(() => fs.rmSync(guestBase, { recursive: true, force: true }))
  const stateDir = path.join(guestBase, 'state')
  const claudeDir = path.join(stateDir, 'home', '.claude')
  const runDir = path.join(guestBase, 'run')
  const managedDir = path.join(stateDir, 'managed-settings.d')
  const storeDir = path.join(guestBase, 'store')
  const dmiDir = path.join(guestBase, 'dmi')
  for (const dir of [claudeDir, runDir, managedDir, storeDir, dmiDir]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const machineIdFile = path.join(stateDir, 'machine-id')
  fs.writeFileSync(machineIdFile, `${machineId}\n`, { mode: 0o444 })
  fs.writeFileSync(path.join(runDir, 'store-mount-type'), 'virtiofs\n')
  fs.writeFileSync(path.join(dmiDir, 'product_name'), 'HP EliteBook 840 14 inch G9 Notebook PC\n')

  const sockPath = path.join(kvmDir, 'agent.sock')
  const tokFile = path.join(kvmDir, '.agent-token')
  fs.writeFileSync(tokFile, `${token}\n`, { mode: 0o600 })

  const proc = spawn(
    'python3',
    [
      '-B',
      AGENT_SCRIPT,
      '--unix-socket',
      sockPath,
      '--token-file',
      tokFile,
      '--state-dir',
      stateDir,
      '--claude-dir',
      claudeDir,
      '--run-dir',
      runDir,
      '--crag-root',
      cragRoot,
      '--managed-preset-dir',
      managedDir,
      '--store-dir',
      storeDir,
      '--machine-id-file',
      machineIdFile,
      '--crag-pid-file',
      path.join(runDir, 'crag.pid'),
      '--dmi-dir',
      dmiDir,
      '--kincli-uid',
      String(process.getuid()),
      '--kincli-gid',
      String(process.getgid()),
      '--no-mount-project',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stderr = ''
  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })
  t.after(() => {
    try {
      proc.kill('SIGTERM')
    } catch {}
  })

  const deadline = Date.now() + 5000
  while (!fs.existsSync(sockPath) && Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`kin-slot-agent exited early (${proc.exitCode}): ${stderr}`)
    }
    await new Promise((r) => setTimeout(r, 40))
  }
  assert.equal(fs.existsSync(sockPath), true, `agent.sock did not appear: ${stderr}`)
  return { proc, sockPath, stateDir, runDir }
}

linuxTest(
  'legacy vs custom-erofs/crag-debian13 routing stays strictly isolated and honors KIN_KVM_MODE=legacy override',
  async (t) => {
    const { root, addVm } = createFixture(t, { kernel: 'ubuntu-24.04' })
    const legacySlot = addVm('vm-leg-1', 2, 'ubuntu-24.04')
    const cragSlot = addVm('vm-crag-1', 3, 'crag-debian13')
    const compatSlot = addVm('vm-d13-compat', 4, 'debian-13')

    // Legacy ubuntu-24.04 uses legacy SSH-stdin docker exec path, never agent client.
    let agentInvoked = 0
    const legacyRunner = inspectRunningRunner(true)
    assert.equal(
      await publishKvmCragSubscription(root, legacySlot.vm, {
        runDockerExec: legacyRunner.runDockerExec,
        createAgentClient: () => {
          agentInvoked++
          throw new Error('legacy must not touch agent client')
        },
      }),
      true,
    )
    assert.equal(agentInvoked, 0)
    assert.equal(legacyRunner.calls.filter((c) => c.args[0] === 'exec').length, 1)
    assert.ok(
      kvmCragSubscriptionStatusCommand(legacySlot.vm, legacySlot.vm.fingerprint.guest_machine_id).includes('--status'),
    )

    // crag-debian13 and debian-13 route directly through createKvmSlotAgentClient with zero docker exec calls.
    for (const target of [cragSlot, compatSlot]) {
      const ops = []
      const runner = inspectRunningRunner(true)
      const mockAgent = {
        status: async () => {
          ops.push('status')
          return { ok: true, result: { tmpfs_ok: true, machine_id: target.vm.fingerprint.guest_machine_id } }
        },
        blockSubscription: async (p) => {
          ops.push(`block:${p.scope}`)
          return { ok: true, result: { blocked: true } }
        },
        publishSubscription: async (p) => {
          ops.push(`publish:${p.scope}:${p.files.map((f) => f.rel).join(',')}`)
          return { ok: true, result: { count: p.files.length } }
        },
        clearSubscription: async (p) => {
          ops.push(`clear:${p.scope}`)
          return { ok: true, result: { cleared: true } }
        },
      }
      assert.equal(
        await publishKvmCragSubscription(root, target.vm, {
          runDockerExec: runner.runDockerExec,
          agentClient: mockAgent,
        }),
        true,
      )
      assert.deepEqual(ops, [
        'status',
        'block:host',
        'publish:license:device.json,registration.code',
        'publish:host:host_id,entitlement.code',
      ])
      assert.equal(runner.calls.filter((c) => c.args[0] === 'exec').length, 0)
      const statusCmd = kvmCragSubscriptionStatusCommand(target.vm, target.vm.fingerprint.guest_machine_id)
      assert.equal(statusCmd.includes('--status'), false)
      assert.match(statusCmd[2], /0x01021994/)
    }

    // Explicit KIN_KVM_MODE=legacy, { mode: 'legacy' }, and { runtimeMode: 'legacy' } all force crag-debian13 back to legacy path.
    for (const overrideOpts of [
      { env: { KIN_KVM_MODE: 'legacy' } },
      { mode: 'legacy' },
      { runtimeMode: 'legacy' },
      { customOsRuntimeMode: 'legacy' },
    ]) {
      const overrideRunner = inspectRunningRunner(true)
      assert.equal(
        await publishKvmCragSubscription(root, cragSlot.vm, {
          runDockerExec: overrideRunner.runDockerExec,
          ...overrideOpts,
          createAgentClient: () => {
            throw new Error(`legacy override ${JSON.stringify(overrideOpts)} must bypass agent client`)
          },
        }),
        true,
      )
      assert.equal(overrideRunner.calls.filter((c) => c.args[0] === 'exec').length, 1)
      assert.ok(
        kvmCragSubscriptionStatusCommand(cragSlot.vm, cragSlot.vm.fingerprint.guest_machine_id, overrideOpts).includes(
          '--status',
        ),
      )
    }

    // Explicit { mode: 'custom-erofs' } and { runtimeMode: 'custom-os' } route non-debian13 kernel through agent client.
    for (const enableOpts of [{ mode: 'custom-erofs' }, { runtimeMode: 'custom-os' }]) {
      const enableOps = []
      const enableRunner = inspectRunningRunner(true)
      assert.equal(
        await blockKvmCragSubscription(root, legacySlot.vm, {
          runDockerExec: enableRunner.runDockerExec,
          ...enableOpts,
          agentClient: {
            blockSubscription: async (p) => {
              enableOps.push(`block:${p.scope}`)
              return { ok: true, result: { blocked: true } }
            },
          },
        }),
        true,
      )
      assert.deepEqual(enableOps, ['block:all'])
      assert.equal(enableRunner.calls.filter((c) => c.args[0] === 'exec').length, 0)
    }

    // Explicit KIN_KVM_MODE=custom-erofs enables agent path even for non-debian13 kernel.
    const forcedOps = []
    const forcedRunner = inspectRunningRunner(true)
    assert.equal(
      await blockKvmCragSubscription(root, legacySlot.vm, {
        runDockerExec: forcedRunner.runDockerExec,
        env: { KIN_KVM_MODE: 'custom-erofs' },
        agentClient: {
          blockSubscription: async (p) => {
            forcedOps.push(`block:${p.scope}`)
            return { ok: true, result: { blocked: true } }
          },
        },
      }),
      true,
    )
    assert.deepEqual(forcedOps, ['block:all'])
    assert.equal(forcedRunner.calls.filter((c) => c.args[0] === 'exec').length, 0)

    // process.env.KIN_KVM_MODE is honored when options.env is omitted.
    process.env.KIN_KVM_MODE = 'custom-erofs'
    try {
      const envOps = []
      assert.equal(
        await clearKvmCragSubscription(root, legacySlot.vm, {
          runDockerExec: inspectRunningRunner(true).runDockerExec,
          agentClient: {
            clearSubscription: async (p) => {
              envOps.push(`clear:${p.scope}`)
              return { ok: true, result: { cleared: true } }
            },
          },
        }),
        true,
      )
      assert.deepEqual(envOps, ['clear:all'])
    } finally {
      delete process.env.KIN_KVM_MODE
    }
  },
)

linuxTest(
  'custom-erofs failure paths enforce retryable semantics, identity/tmpfs guards, and fail-closed block without leaking secrets',
  async (t) => {
    const { root, vm, kvmDir } = createFixture(t)
    const files = readCragSubscriptionFiles(root, vm)
    const privateKey = JSON.parse(files.device).private_key

    // 1. Unreachable socket (booting guest) is retryable and does NOT fire follow-up block.
    const missingSockRunner = inspectRunningRunner(true)
    ensureSlotAgentToken(kvmDir)
    const unreachErr = await publishKvmCragSubscription(root, vm, {
      runDockerExec: missingSockRunner.runDockerExec,
      timeoutMs: 1000,
    }).then(
      () => assert.fail('expected agent_unreachable failure'),
      (e) => e,
    )
    assert.equal(unreachErr.code, 'crag_subscription_projection_failed')
    assert.equal(unreachErr.retryable, true)

    // 2. Missing .agent-token fails closed (non-retryable).
    fs.rmSync(path.join(kvmDir, '.agent-token'), { force: true })
    await assert.rejects(
      publishKvmCragSubscription(root, vm, { runDockerExec: inspectRunningRunner(true).runDockerExec }),
      { code: 'crag_subscription_projection_failed', retryable: false },
    )

    // 3. Guest identity mismatch triggers fail-closed block and never publishes license files.
    const mismatchOps = []
    const mismatchErr = await publishKvmCragSubscription(root, vm, {
      runDockerExec: inspectRunningRunner(true).runDockerExec,
      agentClient: {
        status: async () => {
          mismatchOps.push('status')
          return { ok: true, result: { tmpfs_ok: true, machine_id: 'f'.repeat(32) } }
        },
        blockSubscription: async (p) => {
          mismatchOps.push(`block:${p.scope}`)
          return { ok: true, result: { blocked: true } }
        },
        publishSubscription: async () => {
          mismatchOps.push('publish')
          return { ok: true }
        },
      },
    }).then(
      () => assert.fail('expected mismatch failure'),
      (e) => e,
    )
    assert.equal(mismatchErr.code, 'crag_subscription_projection_failed')
    assert.equal(mismatchErr.retryable, false)
    assert.equal(mismatchErr.message.includes(privateKey), false)
    assert.equal(mismatchErr.message.includes(files.permit), false)
    assert.deepEqual(mismatchOps, ['status', 'block:all'])

    // 4. Non-tmpfs guest (tmpfs_ok=false) is rejected fail-closed with block.
    const nonTmpfsOps = []
    await assert.rejects(
      publishKvmCragSubscription(root, vm, {
        runDockerExec: inspectRunningRunner(true).runDockerExec,
        agentClient: {
          status: async () => {
            nonTmpfsOps.push('status')
            return { ok: true, result: { tmpfs_ok: false, machine_id: vm.fingerprint.guest_machine_id } }
          },
          blockSubscription: async (p) => {
            nonTmpfsOps.push(`block:${p.scope}`)
            return { ok: true, result: { blocked: true } }
          },
        },
      }),
      { code: 'crag_subscription_projection_failed', retryable: false },
    )
    assert.deepEqual(nonTmpfsOps, ['status', 'block:all'])

    // 5. Stopped container skips agent completely and returns false.
    assert.equal(
      await publishKvmCragSubscription(root, vm, {
        runDockerExec: inspectRunningRunner(false).runDockerExec,
        createAgentClient: () => {
          throw new Error('stopped container must not call agent')
        },
      }),
      false,
    )
    assert.equal(
      await getKvmCragSubscriptionStatus(root, vm, {
        runDockerExec: inspectRunningRunner(false).runDockerExec,
      }),
      null,
    )
  },
)

linuxTest('end-to-end cross-process integration with real Python kin-slot-agent on real /dev/shm tmpfs', async (t) => {
  if (!hasDevShmTmpfs()) {
    t.skip('/dev/shm tmpfs unavailable in test environment')
    return
  }

  const { root, vm, kvmDir } = createFixture(t, { kernel: 'crag-debian13' })
  const token = ensureSlotAgentToken(kvmDir)
  const cragRoot = fs.mkdtempSync(path.join('/dev/shm', 'kin-sub-e2e-'))
  t.after(() => fs.rmSync(cragRoot, { recursive: true, force: true }))

  await spawnRealSlotAgent(t, {
    kvmDir,
    machineId: vm.fingerprint.guest_machine_id,
    cragRoot,
    token,
  })

  const runner = inspectRunningRunner(true)
  const expectedFiles = readCragSubscriptionFiles(root, vm)

  // 1. status over real kin-slot-agent RPC
  const statusBefore = await getKvmCragSubscriptionStatus(root, vm, { runDockerExec: runner.runDockerExec })
  assert.equal(statusBefore.machine_id, vm.fingerprint.guest_machine_id)
  assert.equal(statusBefore.tmpfs_ok, true)
  assert.equal(statusBefore.tmpfs_magic, '0x01021994')

  // 2. H2 publish through official publishKvmCragSubscription API
  assert.equal(await publishKvmCragSubscription(root, vm, { runDockerExec: runner.runDockerExec }), true)
  assert.equal(fs.readFileSync(path.join(cragRoot, 'license', 'device.json'), 'utf8'), expectedFiles.device)
  assert.equal(fs.readFileSync(path.join(cragRoot, 'license', 'registration.code'), 'utf8'), expectedFiles.permit)
  assert.equal(fs.readFileSync(path.join(cragRoot, 'host', 'host_id'), 'utf8'), expectedFiles.hostId)
  assert.equal(fs.readFileSync(path.join(cragRoot, 'host', 'entitlement.code'), 'utf8'), expectedFiles.entitlement)
  assert.equal(fs.statSync(path.join(cragRoot, 'license', 'device.json')).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.join(cragRoot, 'license', 'registration.code')).mode & 0o777, 0o600)
  assert.equal(fs.existsSync(path.join(cragRoot, 'host', 'sync-pending')), false)
  assert.equal(fs.existsSync(path.join(cragRoot, 'license', 'sync-pending')), false)

  // 3. block sets sync-pending on both tmpfs scopes while preserving projected files
  assert.equal(await blockKvmCragSubscription(root, vm, { runDockerExec: runner.runDockerExec }), true)
  assert.equal(fs.existsSync(path.join(cragRoot, 'license', 'sync-pending')), true)
  assert.equal(fs.existsSync(path.join(cragRoot, 'host', 'sync-pending')), true)
  assert.equal(fs.existsSync(path.join(cragRoot, 'license', 'device.json')), true)

  // 4. clear removes all files & markers from volatile tmpfs
  assert.equal(await clearKvmCragSubscription(root, vm, { runDockerExec: runner.runDockerExec }), true)
  assert.deepEqual(fs.readdirSync(path.join(cragRoot, 'license')), [])
  assert.deepEqual(fs.readdirSync(path.join(cragRoot, 'host')), [])

  // 5. publishUniversal (offline CRAGU1) through official publishLocalKvmCragLicense API even under host subscription hold
  const universal = issueUniversalCode(root)
  const licDir = cragLicenseDirectory(root, vm)
  fs.writeFileSync(path.join(licDir, 'registration.code'), universal.code, { mode: 0o600 })
  fs.rmSync(path.join(licDir, 'device.json'), { force: true })
  const releaseHold = holdKvmCragSubscriptionPublications(root)
  t.after(releaseHold)

  // Seed a stale host file to prove publish-universal clears host scope cleanly.
  fs.writeFileSync(path.join(cragRoot, 'host', 'stale_host_file'), 'stale\n')
  assert.equal(await publishLocalKvmCragLicense(root, vm, { runDockerExec: runner.runDockerExec }), true)
  assert.equal(fs.readFileSync(path.join(cragRoot, 'license', 'registration.code'), 'utf8'), universal.code)
  assert.equal(fs.statSync(path.join(cragRoot, 'license', 'registration.code')).mode & 0o777, 0o600)
  assert.deepEqual(fs.readdirSync(path.join(cragRoot, 'host')), [])

  // 6. Final clear cleans up universal registration too; zero docker exec calls occurred across entire lifecycle.
  assert.equal(await clearKvmCragSubscription(root, vm, { runDockerExec: runner.runDockerExec }), true)
  assert.deepEqual(fs.readdirSync(path.join(cragRoot, 'license')), [])
  assert.equal(runner.calls.filter((c) => c.args[0] === 'exec').length, 0)
})
