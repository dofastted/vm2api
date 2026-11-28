import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveRemoteSharedStoreDir, slotContainerBody } from '../../src/lib/cluster/remote-slot.mjs'
import { cragSlotPayload, slotImageSpec } from '../../src/lib/cluster/slot-image.mjs'
import { runGuestOAuthAuthService } from '../../src/lib/oauth/guest-oauth-helper.mjs'
import {
  cancelRustKernelStart,
  ensureRustKernel,
  reconcileCliHopRuntime,
  writeKernelConfig,
} from '../../src/lib/transport/rust-kernel-supervisor.mjs'
import { activateCragSubscriptionBinding, prepareCragSubscriptionBinding } from '../../src/lib/vm/crag-license.mjs'
import { cragSubscriptionPublicDirectory } from '../../src/lib/vm/crag-subscription-paths.mjs'
import {
  CUSTOM_OS_ASSETS_GUEST_DIR,
  CUSTOM_OS_EROFS_FILENAME,
  CUSTOM_OS_INITRD_FILENAME,
  CUSTOM_OS_KERNEL_FILENAME,
  CUSTOM_OS_STORE_GUEST_DIR,
} from '../../src/lib/vm/custom-os-runtime.mjs'
import {
  createKvmSlotAgentClient,
  ensureSlotAgentToken,
  syncCustomKvmSlotFiles,
} from '../../src/lib/vm/kvm-slot-agent-client.mjs'
import { slotHost } from '../../src/lib/vm/slot-host.mjs'
import { buildKvmRunArgs, syncSharedStoreGuestBins, writeWorkerFiles } from '../../src/lib/vm/vm-runtime.mjs'
import { issueHostEntitlement, issueSlotPermit, seedEncryptedPackage } from '../fixtures/crag-license.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const AGENT_SCRIPT = path.join(REPO_ROOT, 'docker', 'kin-kvm', 'guest', 'kin-slot-agent')
const linuxTest = process.platform === 'linux' ? test : test.skip

const ENV_NAMES = [
  'KIN_SLOT_RUN_ROOT',
  'KIN_CRAG_V2_ROOT',
  'KIN_DATA_DIR',
  'KIN_KVM_MODE',
  'KIN_OS_RUNTIME_MODE',
  'KIN_SHARED_STORE_DIR',
  'KIN_REMOTE_SHARED_STORE_DIR',
  'KIN_REMOTE_CRAG_DEBIAN13_OS_DIR',
  'KIN_KERNEL_BIN',
  'KIN_WORKER_BIN',
  'KIN_CLUSTER_WORKER_BIN',
  'KIN_OAUTH_AUTH_BIN',
  'KIN_CLUSTER_EGRESS_BIN',
  'KIN_CODEX_KERNEL_BIN',
]
const savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]))

before(() => {
  for (const name of ENV_NAMES) delete process.env[name]
})
after(() => {
  for (const name of ENV_NAMES) {
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

function fakeLinuxAmd64Elf(tag = 'bin') {
  const buf = Buffer.alloc(128, 0)
  // \x7fELF, 64-bit, little-endian, version 1, x86_64 (EM_X86_64 = 0x3e)
  buf[0] = 0x7f
  buf[1] = 0x45
  buf[2] = 0x4c
  buf[3] = 0x46
  buf[4] = 2
  buf[5] = 1
  buf[6] = 1
  buf.writeUInt16LE(2, 16)
  buf.writeUInt16LE(0x3e, 18)
  buf.write(tag, 64, 'utf8')
  return buf
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function startMockAgentServer(t, socketPath, handler) {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true })
  fs.rmSync(socketPath, { force: true })
  const server = net.createServer((conn) => {
    let buf = ''
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      while (true) {
        const nl = buf.indexOf('\n')
        if (nl === -1) break
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        const req = JSON.parse(line)
        handler(req, conn)
      }
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      t.after(() => {
        server.close()
        fs.rmSync(socketPath, { force: true })
      })
      resolve({ server, socketPath })
    })
  })
}

async function spawnRealSlotAgent(t, { kvmDir, machineId, cragRoot, token }) {
  const guestBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-guest-wu2f-'))
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
  const cragPidFile = path.join(runDir, 'crag.pid')

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
      cragPidFile,
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
  return { proc, sockPath, stateDir, claudeDir, runDir, managedDir, cragPidFile }
}

function seedSlotWithSubscription(t, { kernel = 'crag-debian13', vmId = 'vm-wu2f-1', seat = 1 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wu2f-slot-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  seedEncryptedPackage(root)

  const hostId = crypto.randomBytes(32).toString('hex')
  const publicDir = cragSubscriptionPublicDirectory(root)
  fs.mkdirSync(publicDir, { recursive: true, mode: 0o755 })
  fs.writeFileSync(path.join(publicDir, 'host_id'), `${hostId}\n`, { mode: 0o644 })
  const entitlement = issueHostEntitlement(root, hostId, { slot_limit: 8 })
  fs.writeFileSync(path.join(publicDir, 'entitlement.code'), `${entitlement.code}\n`, { mode: 0o644 })

  const vm = {
    id: vmId,
    kernel,
    status: 'running',
    dataplane: 'crag',
    crag_kernel_version: 'v2',
    runtime: { type: 'kvm', container: `kin-${vmId.replace(/^vm-/, '')}` },
    proxy: { id: 'px-bound', host: '127.0.0.1', port: 20881 },
    fingerprint: { guest_machine_id: crypto.randomBytes(16).toString('hex') },
  }
  const vmDir = path.join(root, 'vms', vm.id)
  const kvmDir = path.join(vmDir, 'kvm')
  const runDir = path.join(vmDir, 'run')
  const homeDir = path.join(vmDir, 'cli-home')
  const claudeDir = path.join(homeDir, '.claude')
  const presetDir = path.join(kvmDir, 'fingerprint', 'system', 'etc', 'claude-code', 'managed-settings.d')
  for (const dir of [kvmDir, runDir, claudeDir, presetDir]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  fs.writeFileSync(path.join(vmDir, 'machine-id'), `${vm.fingerprint.guest_machine_id}\n`)

  const challenge = prepareCragSubscriptionBinding(root, vm)
  const permit = issueSlotPermit(root, challenge, hostId, { seat })
  activateCragSubscriptionBinding(root, vm, permit.code)

  return { root, vm, vmDir, kvmDir, runDir, homeDir, claudeDir, presetDir }
}

linuxTest(
  'cross-process Python kin-slot-agent: syncCustomKvmSlotFiles, proxy env rejection, and real restart_crag SIGTERM',
  async (t) => {
    if (!hasDevShmTmpfs()) {
      t.skip('/dev/shm tmpfs unavailable in test environment')
      return
    }
    const { root, vm, kvmDir, runDir, claudeDir, presetDir } = seedSlotWithSubscription(t)
    const token = ensureSlotAgentToken(kvmDir)
    const cragRoot = fs.mkdtempSync(path.join('/dev/shm', 'kin-wu2f-crag-'))
    t.after(() => fs.rmSync(cragRoot, { recursive: true, force: true }))

    const guest = await spawnRealSlotAgent(t, {
      kvmDir,
      machineId: vm.fingerprint.guest_machine_id,
      cragRoot,
      token,
    })

    const kernelBody = JSON.stringify({ vm_id: vm.id, dataplane: 'crag', crag_kernel_version: 'v2' }) + '\n'
    const workerBody = JSON.stringify({ vm_id: vm.id, egress_mode: 'transparent', proxy_url: '' }) + '\n'
    const credBody = JSON.stringify({ claudeAiOauth: { accessToken: 'tok-live' } }) + '\n'
    const safePresetBody = JSON.stringify({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } }) + '\n'
    fs.writeFileSync(path.join(runDir, 'kernel.json'), kernelBody)
    fs.writeFileSync(path.join(runDir, 'worker.json'), workerBody)
    fs.writeFileSync(path.join(claudeDir, 'credentials.json'), credBody)
    fs.writeFileSync(path.join(presetDir, '10-workstation.json'), safePresetBody)

    const synced = await syncCustomKvmSlotFiles(root, vm)
    assert.equal(synced.ok, true)
    assert.deepEqual(synced.synced, [
      'kernel_config',
      'worker_config',
      'credentials',
      'managed_preset:10-workstation.json',
    ])

    assert.equal(fs.readFileSync(path.join(guest.runDir, 'kernel.json'), 'utf8'), kernelBody)
    assert.equal(fs.readFileSync(path.join(guest.runDir, 'worker.json'), 'utf8'), workerBody)
    assert.equal(fs.statSync(path.join(guest.runDir, 'worker.json')).mode & 0o777, 0o600)
    assert.equal(fs.readFileSync(path.join(guest.claudeDir, 'credentials.json'), 'utf8'), credBody)
    assert.equal(fs.statSync(path.join(guest.claudeDir, 'credentials.json')).mode & 0o777, 0o440)
    assert.equal(fs.readlinkSync(path.join(guest.claudeDir, '.credentials.json')), 'credentials.json')
    assert.equal(fs.readFileSync(path.join(guest.managedDir, '10-workstation.json'), 'utf8'), safePresetBody)

    const client = createKvmSlotAgentClient({ socketPath: guest.sockPath, token })

    // Every proxy/API override env key must be rejected fail-closed by real kin-slot-agent.
    const forbiddenKeys = [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
      'no_proxy',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      'CLAUDE_CODE_ATTRIBUTION_HEADER',
      'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
    ]
    for (const key of forbiddenKeys) {
      const rejected = await client.syncFile({
        target: 'managed_preset',
        name: '99-evil.json',
        content: JSON.stringify({ env: { [key]: 'http://127.0.0.1:1080' } }),
      })
      assert.equal(rejected.ok, false, `expected forbidden managed_preset env key ${key} to be rejected`)
      assert.equal(rejected.error, 'invalid_params')
    }
    assert.equal(fs.existsSync(path.join(guest.managedDir, '99-evil.json')), false)

    // restart_crag with no pid file returns signaled=false cleanly.
    const noPid = await client.restartCrag()
    assert.equal(noPid.ok, true)
    assert.deepEqual(noPid.result, { signaled: false, pid: null })

    // Spawn a real dummy process owned by our UID, write crag.pid, and verify restart_crag sends SIGTERM.
    const dummy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
    t.after(() => {
      try {
        dummy.kill('SIGKILL')
      } catch {}
    })
    fs.writeFileSync(guest.cragPidFile, `${dummy.pid}\n`)
    const status = await client.status()
    assert.equal(status.ok, true)
    assert.equal(status.result.crag_pid, dummy.pid)

    const exitPromise = new Promise((resolve) => dummy.once('exit', (code, sig) => resolve({ code, sig })))
    const restarted = await client.restartCrag()
    assert.equal(restarted.ok, true)
    assert.deepEqual(restarted.result, { signaled: true, pid: dummy.pid })
    const exited = await exitPromise
    assert.equal(exited.sig, 'SIGTERM')
  },
)

test('ensureRustKernel on custom-erofs KVM uses agent.sock exclusively (zero systemd/AppArmor/docker exec) while legacy KVM is preserved', async (t) => {
  const { root, vm, kvmDir, runDir, homeDir, claudeDir, presetDir } = seedSlotWithSubscription(t, {
    kernel: 'crag-debian13',
    vmId: 'vm-cust-1',
  })
  const token = ensureSlotAgentToken(kvmDir)
  fs.writeFileSync(
    path.join(runDir, 'kernel.json'),
    JSON.stringify({ vm_id: vm.id, dataplane: 'crag', crag_kernel_version: 'v2', slots_per_worker: 2 }) + '\n',
  )
  fs.writeFileSync(
    path.join(runDir, 'worker.json'),
    JSON.stringify({ vm_id: vm.id, egress_mode: 'transparent', proxy_url: '' }) + '\n',
  )
  fs.writeFileSync(path.join(claudeDir, 'credentials.json'), '{"claudeAiOauth":{"accessToken":"t"}}\n')
  fs.writeFileSync(path.join(presetDir, '10-preset.json'), '{"env":{"CLAUDE_CODE_DISABLE_AUTO_MEMORY":"1"}}\n')

  const rpcLog = []
  let restarted = false
  let postRestartStatusCalls = 0
  await startMockAgentServer(t, path.join(kvmDir, 'agent.sock'), (req, conn) => {
    assert.equal(req.token, token)
    rpcLog.push(req.op === 'sync_file' ? `sync_file:${req.params.target}` : req.op)
    if (req.op === 'status') {
      let cragPid = 4242
      if (restarted) {
        postRestartStatusCalls += 1
        // 1st post-restart status still reports old pid 4242; 2nd reports respawned pid 5151.
        cragPid = postRestartStatusCalls === 1 ? 4242 : 5151
      }
      conn.end(
        `${JSON.stringify({
          id: req.id,
          ok: true,
          result: { tmpfs_ok: true, machine_id: vm.fingerprint.guest_machine_id, crag_pid: cragPid },
        })}\n`,
      )
      return
    }
    if (req.op === 'restart_crag') {
      restarted = true
      conn.end(`${JSON.stringify({ id: req.id, ok: true, result: { signaled: true, pid: 4242 } })}\n`)
      return
    }
    conn.end(`${JSON.stringify({ id: req.id, ok: true, result: {} })}\n`)
  })

  const publishedCalls = []
  const exec = { projectRoot: root, vmId: vm.id, vm, homeDir }
  const started = await ensureRustKernel(exec, {
    timeoutMs: 5000,
    force: true,
    runDockerExec: async (args) => {
      assert.fail(`custom-erofs KVM must not invoke docker exec / systemd / AppArmor: ${JSON.stringify(args)}`)
    },
    publishCragLicense: async (_root, targetVm) => {
      publishedCalls.push(targetVm.id)
      return true
    },
    waitForHealthFn: async () => {
      rpcLog.push('wait_health')
      return {
        ok: true,
        reason: 'started_in_vm',
        health: { ok: true, ready: true, runtime_variant: 'crag-v2', capacity: 2 },
      }
    },
  })
  assert.equal(started.ok, true)
  assert.deepEqual(publishedCalls, [vm.id])
  assert.deepEqual(rpcLog, [
    'status',
    'sync_file:kernel_config',
    'sync_file:worker_config',
    'sync_file:credentials',
    'sync_file:managed_preset',
    'restart_crag',
    'status',
    'status',
    'wait_health',
  ])

  // Missing host kernel.json fails closed via requiredTargets without waiting for health.
  const origKernelJson = fs.readFileSync(path.join(runDir, 'kernel.json'), 'utf8')
  let healthCheckedOnMissingKernel = false
  const missingKernelRes = await ensureRustKernel(exec, {
    timeoutMs: 5000,
    force: true,
    runDockerExec: async (args) => assert.fail(`must not run docker exec: ${JSON.stringify(args)}`),
    publishCragLicense: async () => {
      fs.rmSync(path.join(runDir, 'kernel.json'), { force: true })
      return true
    },
    waitForHealthFn: async () => {
      healthCheckedOnMissingKernel = true
      return { ok: true }
    },
  })
  assert.equal(missingKernelRes.ok, false)
  assert.equal(missingKernelRes.reason, 'kernel_config_missing')
  assert.equal(healthCheckedOnMissingKernel, false)
  fs.writeFileSync(path.join(runDir, 'kernel.json'), origKernelJson)

  // Stuck old crag_pid after restart_crag times out with crag_restart_timeout and never enters waitForHealthFn.
  let healthCheckedOnStuckRestart = false
  const stuckRes = await ensureRustKernel(exec, {
    timeoutMs: 5000,
    force: true,
    runDockerExec: async (args) => assert.fail(`must not run docker exec: ${JSON.stringify(args)}`),
    publishCragLicense: async () => true,
    agentClient: {
      status: async () => ({
        ok: true,
        result: { tmpfs_ok: true, machine_id: vm.fingerprint.guest_machine_id, crag_pid: 4242 },
      }),
      syncFile: async () => ({ ok: true, result: {} }),
      restartCrag: async () => ({ ok: true, result: { signaled: true, pid: 4242 } }),
    },
    waitForHealthFn: async () => {
      healthCheckedOnStuckRestart = true
      return { ok: true }
    },
  })
  assert.equal(stuckRes.ok, false)
  assert.equal(stuckRes.reason, 'crag_restart_timeout')
  assert.equal(healthCheckedOnStuckRestart, false)

  // reconcileCliHopRuntime on custom-erofs KVM makes zero docker exec calls and still clears paused -> running.
  const pausedVm = { ...vm, status: 'paused', schedulable: true }
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(pausedVm))
  const rec = await reconcileCliHopRuntime(
    { projectRoot: root, vmId: vm.id, vm: pausedVm, homeDir },
    {
      runDockerExec: async (args) => {
        assert.fail(`reconcileCliHopRuntime must not run docker exec on custom-erofs KVM: ${JSON.stringify(args)}`)
      },
    },
  )
  assert.equal(rec.ok, true)
  assert.equal(rec.actions.includes('reap_zombies'), false)
  assert.equal(rec.actions.includes('status_running'), true)

  // writeKernelConfig fires non-blocking kernel_config push when agent.sock + .agent-token exist.
  const pushLog = []
  const pushedPromise = new Promise((resolve) => {
    startMockAgentServer(t, path.join(kvmDir, 'agent.sock'), (req, conn) => {
      pushLog.push(req)
      conn.end(`${JSON.stringify({ id: req.id, ok: true, result: { target: req.params.target } })}\n`)
      if (req.op === 'sync_file' && req.params.target === 'kernel_config') resolve()
    })
  })
  writeKernelConfig(root, vm, { routing: { inference: { dataplane: 'crag' } }, publish: true })
  await Promise.race([
    pushedPromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('kernel_config push timeout')), 2000)),
  ])
  assert.equal(
    pushLog.some((r) => r.op === 'sync_file' && r.params.target === 'kernel_config'),
    true,
  )

  // Legacy ubuntu-24.04 KVM still takes the legacy AppArmor + systemctl restart kin-kernel.service path.
  const legacy = seedSlotWithSubscription(t, { kernel: 'ubuntu-24.04', vmId: 'vm-leg-1', seat: 2 })
  fs.writeFileSync(
    path.join(legacy.runDir, 'kernel.json'),
    JSON.stringify({ vm_id: legacy.vm.id, dataplane: 'crag', crag_kernel_version: 'v2', slots_per_worker: 2 }) + '\n',
  )
  const legacyDockerCalls = []
  const legacyExec = { projectRoot: legacy.root, vmId: legacy.vm.id, vm: legacy.vm, homeDir: legacy.homeDir }
  const legacyRes = await ensureRustKernel(legacyExec, {
    timeoutMs: 3000,
    force: true,
    runDockerExec: async (args) => {
      legacyDockerCalls.push(args)
      if (args[0] === 'container' && args[1] === 'inspect') {
        return { ok: true, code: 0, stdout: 'true\n' }
      }
      if (args.includes('systemctl') && args.includes('kin-kernel.service')) {
        cancelRustKernelStart(legacy.vm.id)
        return { ok: true, code: 0, stdout: '' }
      }
      return { ok: true, code: 0, stdout: '{"ok":true}\n' }
    },
  })
  assert.equal(legacyRes.ok, false)
  assert.equal(legacyRes.reason, 'start_cancelled')
  assert.equal(
    legacyDockerCalls.some((args) => args.some((a) => String(a).includes('apparmor_parser'))),
    true,
    'legacy KVM must keep AppArmor preparation',
  )
  assert.equal(
    legacyDockerCalls.some((args) => args.includes('systemctl') && args.includes('kin-kernel.service')),
    true,
    'legacy KVM must keep systemctl restart kin-kernel.service',
  )
})

test('slotHost bins, syncSharedStoreGuestBins, writeWorkerFiles, and runGuestOAuthAuthService custom-erofs KVM closure', async (t) => {
  // 1. slotHost bins separation between custom-erofs KVM and legacy KVM
  const customHost = slotHost({ id: 'vm-c1', kernel: 'crag-debian13', runtime: { type: 'kvm' } })
  assert.equal(customHost.bins.oauthAuth, '/usr/local/bin/kin-oauth-auth')
  assert.equal(customHost.bins.worker, '/usr/local/bin/kin-worker')

  const legacyHost = slotHost({ id: 'vm-l1', kernel: 'ubuntu-24.04', runtime: { type: 'kvm' } })
  assert.equal(legacyHost.bins.oauthAuth, '/opt/kin-payload/usr/local/bin/kin-oauth-auth')
  assert.equal(legacyHost.bins.worker, '/opt/kin-payload/usr/local/bin/kin-worker')

  // 2. syncSharedStoreGuestBins copies bin/{kin-oauth-auth,kin-worker} into <store>/bin/ as 0555 and is idempotent
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wu2f-bins-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const storeDir = path.join(root, 'share', 'claude-store')
  fs.mkdirSync(storeDir, { recursive: true })
  // Missing host bins skip cleanly.
  assert.deepEqual(syncSharedStoreGuestBins(root, { sharedStoreHostDir: storeDir }).synced, [])

  const binDir = path.join(root, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const oauthBytes = fakeLinuxAmd64Elf('kin-oauth-auth-v1')
  const workerBytes = fakeLinuxAmd64Elf('kin-worker-v1')
  fs.writeFileSync(path.join(binDir, 'kin-oauth-auth'), oauthBytes, { mode: 0o755 })
  fs.writeFileSync(path.join(binDir, 'kin-worker'), workerBytes, { mode: 0o755 })

  const firstSync = syncSharedStoreGuestBins(root, { sharedStoreHostDir: storeDir })
  assert.deepEqual(firstSync.synced, ['kin-oauth-auth', 'kin-worker'])
  assert.deepEqual(fs.readFileSync(path.join(storeDir, 'bin', 'kin-oauth-auth')), oauthBytes)
  assert.deepEqual(fs.readFileSync(path.join(storeDir, 'bin', 'kin-worker')), workerBytes)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(storeDir, 'bin', 'kin-oauth-auth')).mode & 0o777, 0o555)
    assert.equal(fs.statSync(path.join(storeDir, 'bin', 'kin-worker')).mode & 0o777, 0o555)
  }
  // Idempotent second call does not rewrite or fail on 0555 destination.
  const secondSync = syncSharedStoreGuestBins(root, { sharedStoreHostDir: storeDir })
  assert.deepEqual(secondSync.synced, [])
  // Updated source binary replaces 0555 destination atomically.
  const oauthBytesV2 = fakeLinuxAmd64Elf('kin-oauth-auth-v2-updated')
  fs.writeFileSync(path.join(binDir, 'kin-oauth-auth'), oauthBytesV2, { mode: 0o755 })
  const thirdSync = syncSharedStoreGuestBins(root, { sharedStoreHostDir: storeDir })
  assert.deepEqual(thirdSync.synced, ['kin-oauth-auth'])
  assert.deepEqual(fs.readFileSync(path.join(storeDir, 'bin', 'kin-oauth-auth')), oauthBytesV2)

  // buildKvmRunArgs triggers syncSharedStoreGuestBins automatically for custom-erofs KVM.
  const vm = {
    id: 'vm-oauth-1',
    kernel: 'crag-debian13',
    dataplane: 'crag',
    crag_kernel_version: 'v2',
    runtime: { type: 'kvm', container: 'kin-oauth-1' },
    proxy: { id: 'px-bound', host: '127.0.0.1', port: 20881 },
    fingerprint: { guest_machine_id: crypto.randomBytes(16).toString('hex') },
  }
  const vmDir = path.join(root, 'vms', vm.id)
  const kvmDir = path.join(vmDir, 'kvm')
  const runDir = path.join(vmDir, 'run')
  const homeDir = path.join(vmDir, 'cli-home')
  for (const dir of [kvmDir, runDir, homeDir]) fs.mkdirSync(dir, { recursive: true })
  const storeDir2 = path.join(root, 'share', 'claude-store-2')
  fs.mkdirSync(storeDir2, { recursive: true })
  buildKvmRunArgs({
    vm,
    name: 'kin-oauth-1',
    image: 'ghcr.io/example/kin-kvm:latest',
    hostName: 'wk-1',
    network: 'kin-eg-px',
    memory: '2048m',
    accel: 'tcg',
    uid: 999,
    gid: 987,
    home: homeDir,
    runDir,
    kvmDir,
    projectRoot: root,
    sharedStoreHostDir: storeDir2,
  })
  assert.equal(fs.existsSync(path.join(storeDir2, 'bin', 'kin-oauth-auth')), true)
  assert.equal(fs.existsSync(path.join(storeDir2, 'bin', 'kin-worker')), true)

  // 3. writeWorkerFiles pushes worker_config over agent.sock when live
  const token = ensureSlotAgentToken(kvmDir)
  const workerPushEvents = []
  let resolveWorkerPush
  const workerPushDone = new Promise((r) => {
    resolveWorkerPush = r
  })
  await startMockAgentServer(t, path.join(kvmDir, 'agent.sock'), (req, conn) => {
    assert.equal(req.token, token)
    workerPushEvents.push(req)
    conn.end(`${JSON.stringify({ id: req.id, ok: true, result: { target: req.params.target } })}\n`)
    if (req.op === 'sync_file' && req.params.target === 'worker_config') resolveWorkerPush()
  })
  writeWorkerFiles(vm, root)
  await Promise.race([
    workerPushDone,
    new Promise((_, rej) => setTimeout(() => rej(new Error('worker_config push timeout')), 2000)),
  ])
  assert.equal(
    workerPushEvents.some((r) => r.op === 'sync_file' && r.params.target === 'worker_config'),
    true,
  )

  // 4. runGuestOAuthAuthService syncs worker_config BEFORE invoking /usr/local/bin/kin-oauth-auth
  const timeline = []
  await startMockAgentServer(t, path.join(kvmDir, 'agent.sock'), (req, conn) => {
    if (req.op === 'sync_file' && req.params.target === 'worker_config') {
      timeline.push('agent:sync_file:worker_config')
    }
    conn.end(`${JSON.stringify({ id: req.id, ok: true, result: { target: req.params.target } })}\n`)
  })
  const exec = { projectRoot: root, vmId: vm.id, vm, homeDir }
  let capturedArgv = null
  let capturedStdin = null
  const cred = await runGuestOAuthAuthService(
    { operation: 'exchange_code', code: 'c1', code_verifier: 'v1', proxy_url: 'socks5h://127.0.0.1:9999' },
    {
      exec,
      prepare: async () => ({
        exec,
        host: slotHost(vm),
        configDir: '/home/kincli/.claude',
        home: '/home/kincli',
      }),
      postTelemetry: async () => ({ ok: true }),
      runDocker: async (argv, { stdin }) => {
        timeline.push('docker:run_oauth')
        capturedArgv = argv
        capturedStdin = JSON.parse(stdin)
        return { code: 0, stdout: JSON.stringify({ ok: true, credential: { access_token: 'oauth-ok-tok' } }) }
      },
    },
  )
  assert.equal(cred.access_token, 'oauth-ok-tok')
  assert.deepEqual(timeline, ['agent:sync_file:worker_config', 'docker:run_oauth'])
  assert.equal(capturedArgv.includes('/usr/local/bin/kin-oauth-auth'), true)
  assert.equal(capturedArgv.includes('KIN_WORKER_CONFIG=/run/kin/worker.json'), true)
  assert.equal(capturedArgv.includes('HTTP_PROXY='), true)
  assert.equal(capturedArgv.includes('HTTPS_PROXY='), true)
  assert.equal(capturedStdin.proxy_url, '')

  // 5. Fail-closed when worker_config sync fails or host worker.json is missing/empty: runDocker must NOT execute
  let dockerRanOnFailure = false
  await assert.rejects(
    runGuestOAuthAuthService(
      { operation: 'exchange_code', code: 'c1', code_verifier: 'v1' },
      {
        exec,
        prepare: async () => ({
          exec,
          host: slotHost(vm),
          configDir: '/home/kincli/.claude',
          home: '/home/kincli',
        }),
        syncWorkerConfig: async () => ({ ok: false, error: 'agent_unreachable', message: 'agent down' }),
        postTelemetry: async () => ({ ok: true }),
        runDocker: async () => {
          dockerRanOnFailure = true
          return { code: 0, stdout: '{}' }
        },
      },
    ),
    { code: 'agent_unreachable', message: 'agent down' },
  )
  assert.equal(dockerRanOnFailure, false)

  // Missing host worker.json fails closed via default syncCustomKvmSlotFiles(requiredTargets: ['worker_config'])
  fs.rmSync(path.join(runDir, 'worker.json'), { force: true })
  await assert.rejects(
    runGuestOAuthAuthService(
      { operation: 'exchange_code', code: 'c1', code_verifier: 'v1' },
      {
        exec,
        prepare: async () => ({
          exec,
          host: slotHost(vm),
          configDir: '/home/kincli/.claude',
          home: '/home/kincli',
        }),
        postTelemetry: async () => ({ ok: true }),
        runDocker: async () => {
          dockerRanOnFailure = true
          return { code: 0, stdout: '{}' }
        },
      },
    ),
    { code: 'worker_config_missing' },
  )
  assert.equal(dockerRanOnFailure, false)

  // Even a custom syncWorkerConfig returning ok:true with synced:[] fails closed.
  await assert.rejects(
    runGuestOAuthAuthService(
      { operation: 'exchange_code', code: 'c1', code_verifier: 'v1' },
      {
        exec,
        prepare: async () => ({
          exec,
          host: slotHost(vm),
          configDir: '/home/kincli/.claude',
          home: '/home/kincli',
        }),
        syncWorkerConfig: async () => ({ ok: true, synced: [] }),
        postTelemetry: async () => ({ ok: true }),
        runDocker: async () => {
          dockerRanOnFailure = true
          return { code: 0, stdout: '{}' }
        },
      },
    ),
    { code: 'oauth_worker_config_sync_failed' },
  )
  assert.equal(dockerRanOnFailure, false)

  // 6. Legacy KVM and Docker slots must NOT invoke syncWorkerConfig
  for (const otherVm of [
    { id: 'vm-leg-oauth', kernel: 'ubuntu-24.04', runtime: { type: 'kvm', container: 'kin-leg-oauth' } },
    { id: 'vm-doc-oauth', kernel: 'crag-debian13', runtime: { type: 'docker', container: 'kin-doc-oauth' } },
  ]) {
    const otherExec = { projectRoot: root, vmId: otherVm.id, vm: otherVm }
    const res = await runGuestOAuthAuthService(
      { operation: 'exchange_code', code: 'c2', code_verifier: 'v2' },
      {
        exec: otherExec,
        prepare: async () => ({
          exec: otherExec,
          host: slotHost(otherVm),
          configDir: '/home/kincli/.claude',
          home: '/home/kincli',
        }),
        syncWorkerConfig: async () => {
          assert.fail(`syncWorkerConfig must not run for ${otherVm.id}`)
        },
        postTelemetry: async () => ({ ok: true }),
        runDocker: async () => ({ code: 0, stdout: JSON.stringify({ ok: true, credential: { access_token: 'ok' } }) }),
      },
    )
    assert.equal(res.access_token, 'ok')
  }
})

test('cluster slot-image.mjs supports bundled:false CRAG v2 on crag-debian13 while keeping legacy strict, and remote-slot.mjs injects custom-erofs KVM spec cleanly', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wu2f-cluster-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  // Seed dummy amd64 ELFs for slotPayload.
  const binDir = path.join(root, 'bin')
  const wrapDir = path.join(root, 'share', 'wrap-cli')
  const cragDir = path.join(root, 'share', 'crag', 'kernels', 'v2', 'amd64')
  const storeDir = path.join(root, 'share', 'claude-store')
  const claudeVersion = '2.1.321'
  const claudeStorePath = path.join(storeDir, 'claude', 'versions', claudeVersion, 'claude')
  for (const dir of [binDir, wrapDir, cragDir, path.dirname(claudeStorePath)]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const elfFiles = [
    path.join(binDir, 'kin-kernel'),
    path.join(binDir, 'kin-worker'),
    path.join(binDir, 'kin-oauth-auth'),
    path.join(binDir, 'kin-egress'),
    path.join(binDir, 'kin-codex-kernel'),
    path.join(wrapDir, 'cli-node'),
  ]
  for (const file of elfFiles) {
    fs.writeFileSync(file, fakeLinuxAmd64Elf(path.basename(file)), { mode: 0o755 })
  }
  process.env.KIN_KERNEL_BIN = path.join(binDir, 'kin-kernel')
  process.env.KIN_WORKER_BIN = path.join(binDir, 'kin-worker')
  process.env.KIN_OAUTH_AUTH_BIN = path.join(binDir, 'kin-oauth-auth')
  process.env.KIN_CLUSTER_EGRESS_BIN = path.join(binDir, 'kin-egress')
  process.env.KIN_CODEX_KERNEL_BIN = path.join(binDir, 'kin-codex-kernel')

  // Seed a real signed bundled:false CRAG v2 package + RO shared store claude binary.
  const keys = crypto.generateKeyPairSync('ed25519')
  const payloadKey = crypto.randomBytes(32)
  const cragBin = fakeLinuxAmd64Elf('crag-v2')
  const claudeBin = fakeLinuxAmd64Elf('claude-shared')
  const claudeSha = sha256(claudeBin)
  fs.writeFileSync(claudeStorePath, claudeBin, { mode: 0o555 })
  if (process.platform !== 'win32') fs.chmodSync(claudeStorePath, 0o555)

  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', payloadKey, nonce)
  cipher.setAAD(Buffer.from('CRAG-V2-PAYLOAD-V1\0'))
  const encrypted = Buffer.concat([cipher.update(cragBin), cipher.final()])
  const payloadBytes = Buffer.concat([Buffer.from('CRAGV2E1'), nonce, cipher.getAuthTag(), encrypted])
  const pem = keys.publicKey.export({ format: 'pem', type: 'spki' })
  const pubRaw = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  const issuerPublicKeyId = sha256(pubRaw)
  const payloadSigned = {
    product: 'crag-v2',
    format: 'CRAGV2E1',
    algorithm: 'aes-256-gcm',
    key_id: sha256(payloadKey),
    plaintext_sha256: sha256(cragBin),
    ciphertext_sha256: sha256(payloadBytes),
  }
  const payloadSignature = crypto
    .sign(
      null,
      Buffer.concat([Buffer.from('CRAG-PAYLOAD-V1\0'), Buffer.from(JSON.stringify(payloadSigned))]),
      keys.privateKey,
    )
    .toString('base64url')
  const pkgFiles = {
    'crag-v2': cragBin,
    'crag-v2.payload.enc': payloadBytes,
    'crag-license-public.pem': Buffer.from(pem, 'utf8'),
  }
  for (const [rel, bytes] of Object.entries(pkgFiles)) {
    fs.writeFileSync(path.join(cragDir, rel), bytes, { mode: rel === 'crag-v2' ? 0o755 : 0o644 })
  }
  const claudeRelPath = `claude-code-${claudeVersion}/claude`
  const signedOfficial = {
    product: 'crag-v2',
    arch: 'amd64',
    version: claudeVersion,
    path: claudeRelPath,
    sha256: claudeSha,
  }
  const officialSig = crypto
    .sign(
      null,
      Buffer.concat([Buffer.from('CRAG-OFFICIAL-CLAUDE-V1\0'), Buffer.from(JSON.stringify(signedOfficial))]),
      keys.privateKey,
    )
    .toString('base64url')
  const manifest = {
    family: 'crag',
    version: 'v2',
    arch: 'amd64',
    runtime: 'native',
    entrypoint: 'crag-v2',
    encrypted: true,
    capabilities: ['official_full', 'zero', 'cancel', 'telemetry', 'unix_socket_envelope', 'headless_claude_bridge_v1'],
    officialClaude: {
      version: claudeVersion,
      bundled: false,
      path: claudeRelPath,
      sha256: claudeSha,
      signature: officialSig,
    },
    authorization: {
      scheme: 'ed25519-x25519-v1',
      product: 'crag-v2',
      public_key: pubRaw.toString('base64url'),
      public_key_id: issuerPublicKeyId,
    },
    payload: {
      path: 'crag-v2.payload.enc',
      ...payloadSigned,
      signature: payloadSignature,
    },
    sha256: Object.fromEntries(Object.entries(pkgFiles).map(([rel, bytes]) => [rel, sha256(bytes)])),
  }
  fs.writeFileSync(path.join(cragDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  // crag-debian13 accepts bundled:false with RO shared store for both docker & kvm cluster builds.
  const payload = cragSlotPayload(root, { kernel: 'crag-debian13', sharedClaudeStoreRoot: storeDir })
  assert.ok(payload.digest.length === 64)
  assert.equal(
    payload.files.some((f) => f.name === 'opt/kin/crag-v2/crag-v2'),
    true,
  )

  const dockerSpec = slotImageSpec(root, 'crag-debian13', { runtime: 'docker', sharedClaudeStoreRoot: storeDir })
  assert.match(dockerSpec.ref, /^vm2api\/kin-slot-crag-debian13:[0-9a-f]{12}$/)
  const kvmSpec = slotImageSpec(root, 'crag-debian13', { runtime: 'kvm', sharedClaudeStoreRoot: storeDir })
  assert.match(kvmSpec.ref, /^vm2api\/kin-slot-kvm-crag-debian13:[0-9a-f]{12}$/)

  // Legacy ubuntu-24.04 MUST still reject bundled:false!
  assert.throws(
    () => slotImageSpec(root, 'ubuntu-24.04', { runtime: 'docker', sharedClaudeStoreRoot: storeDir }),
    (err) => err?.code === 'slot_payload_invalid',
  )
  // Prototype keys are rejected safely.
  assert.throws(
    () => slotImageSpec(root, 'toString', { runtime: 'docker' }),
    (err) => err?.code === 'invalid_kernel',
  )

  // remote-slot.mjs slotContainerBody: crag-debian13 KVM defaults hasInitrd=true and never leaks local KIN_SHARED_STORE_DIR
  const baseVm = {
    id: 'vm-cluster-1',
    node_id: 'node-eu-1',
    timezone: 'UTC',
    locale: 'en_US.UTF-8',
    runtime: { type: 'kvm' },
    fingerprint: { hostname: 'wk-eu-1', guest_machine_id: 'a'.repeat(32) },
  }
  const customBody = slotContainerBody(
    { ...baseVm, kernel: 'crag-debian13' },
    {
      image: kvmSpec.ref,
      network: 'kin-cluster-1-net',
      remoteDir: '/srv/node/vms/vm-cluster-1',
      user: '1000:1000',
      routing: {},
      accel: 'kvm',
      sharedStoreDir: '/srv/node/share/claude-store',
      osAssetsDir: '/srv/node/share/os/crag-debian13',
      vhostVsockAvailable: true,
      vsockCid: 1005,
      agentToken: 'e'.repeat(64),
    },
  )
  assert.equal(customBody.Env.includes('KIN_KVM_MODE=custom-erofs'), true)
  assert.equal(customBody.Env.includes(`KIN_KVM_STORE_DIR=${CUSTOM_OS_STORE_GUEST_DIR}`), true)
  assert.equal(
    customBody.Env.includes(`KIN_KVM_EROFS_IMAGE=${CUSTOM_OS_ASSETS_GUEST_DIR}/${CUSTOM_OS_EROFS_FILENAME}`),
    true,
  )
  assert.equal(
    customBody.Env.includes(`KIN_KVM_KERNEL=${CUSTOM_OS_ASSETS_GUEST_DIR}/${CUSTOM_OS_KERNEL_FILENAME}`),
    true,
  )
  assert.equal(
    customBody.Env.includes(`KIN_KVM_INITRD=${CUSTOM_OS_ASSETS_GUEST_DIR}/${CUSTOM_OS_INITRD_FILENAME}`),
    true,
  )
  assert.equal(customBody.Env.includes('KIN_KVM_VSOCK_CID=1005'), true)
  assert.equal(customBody.Env.includes(`KIN_AGENT_TOKEN=${'e'.repeat(64)}`), true)
  assert.equal(
    customBody.HostConfig.Binds.includes(`/srv/node/share/claude-store:${CUSTOM_OS_STORE_GUEST_DIR}:ro`),
    true,
  )
  assert.equal(
    customBody.HostConfig.Binds.includes(`/srv/node/share/os/crag-debian13:${CUSTOM_OS_ASSETS_GUEST_DIR}:ro`),
    true,
  )
  assert.equal(
    customBody.HostConfig.Devices.some((d) => d.PathOnHost === '/dev/vhost-vsock'),
    true,
  )

  // Explicit hasInitrd: false omits KIN_KVM_INITRD.
  const noInitrdBody = slotContainerBody(
    { ...baseVm, kernel: 'crag-debian13' },
    {
      image: kvmSpec.ref,
      network: 'kin-cluster-1-net',
      remoteDir: '/srv/node/vms/vm-cluster-1',
      user: '1000:1000',
      routing: {},
      accel: 'kvm',
      osAssetsDir: '/srv/node/share/os/crag-debian13',
      hasInitrd: false,
    },
  )
  assert.equal(
    noInitrdBody.Env.some((e) => e.startsWith('KIN_KVM_INITRD=')),
    false,
  )

  // Remote shared store precedence: explicit > KIN_REMOTE_SHARED_STORE_DIR > <remoteRoot>/store; never local KIN_SHARED_STORE_DIR.
  const prevLocalStore = process.env.KIN_SHARED_STORE_DIR
  const prevRemoteStore = process.env.KIN_REMOTE_SHARED_STORE_DIR
  try {
    process.env.KIN_SHARED_STORE_DIR = '/local/control-plane/store'
    delete process.env.KIN_REMOTE_SHARED_STORE_DIR

    assert.equal(resolveRemoteSharedStoreDir({ remoteRoot: '/srv/node' }), '/srv/node/store')
    assert.equal(
      resolveRemoteSharedStoreDir({ sharedStoreDir: '/explicit/store', remoteRoot: '/srv/node' }),
      '/explicit/store',
    )
    assert.equal(resolveRemoteSharedStoreDir({}), '')

    const kvmNoLeak = slotContainerBody(
      { ...baseVm, kernel: 'crag-debian13' },
      {
        image: kvmSpec.ref,
        network: 'kin-cluster-1-net',
        remoteDir: '/srv/node/vms/vm-cluster-1',
        user: '1000:1000',
        routing: {},
        accel: 'kvm',
      },
    )
    assert.equal(
      kvmNoLeak.HostConfig.Binds.some((b) => b.includes('/local/control-plane/store')),
      false,
    )

    const dockerNoLeak = slotContainerBody(
      { ...baseVm, kernel: 'crag-debian13', dataplane: 'crag', crag_kernel_version: 'v2', runtime: { type: 'docker' } },
      {
        image: dockerSpec.ref,
        network: 'kin-cluster-1-net',
        remoteDir: '/srv/node/vms/vm-cluster-1',
        user: '1000:1000',
        routing: { inference: { dataplane: 'crag' } },
      },
    )
    assert.equal(
      dockerNoLeak.HostConfig.Binds.some((b) => b.includes('/local/control-plane/store')),
      false,
    )

    process.env.KIN_REMOTE_SHARED_STORE_DIR = '/srv/node/remote-store'
    assert.equal(resolveRemoteSharedStoreDir({ remoteRoot: '/srv/node' }), '/srv/node/remote-store')
    const kvmRemoteEnv = slotContainerBody(
      { ...baseVm, kernel: 'crag-debian13' },
      {
        image: kvmSpec.ref,
        network: 'kin-cluster-1-net',
        remoteDir: '/srv/node/vms/vm-cluster-1',
        user: '1000:1000',
        routing: {},
        accel: 'kvm',
      },
    )
    assert.equal(kvmRemoteEnv.HostConfig.Binds.includes(`/srv/node/remote-store:${CUSTOM_OS_STORE_GUEST_DIR}:ro`), true)
    const dockerRemoteEnv = slotContainerBody(
      { ...baseVm, kernel: 'crag-debian13', dataplane: 'crag', crag_kernel_version: 'v2', runtime: { type: 'docker' } },
      {
        image: dockerSpec.ref,
        network: 'kin-cluster-1-net',
        remoteDir: '/srv/node/vms/vm-cluster-1',
        user: '1000:1000',
        routing: { inference: { dataplane: 'crag' } },
      },
    )
    assert.equal(
      dockerRemoteEnv.HostConfig.Binds.includes(`/srv/node/remote-store:${CUSTOM_OS_STORE_GUEST_DIR}:ro`),
      true,
    )
  } finally {
    if (prevLocalStore === undefined) delete process.env.KIN_SHARED_STORE_DIR
    else process.env.KIN_SHARED_STORE_DIR = prevLocalStore
    if (prevRemoteStore === undefined) delete process.env.KIN_REMOTE_SHARED_STORE_DIR
    else process.env.KIN_REMOTE_SHARED_STORE_DIR = prevRemoteStore
  }

  const legacyBody = slotContainerBody(
    { ...baseVm, kernel: 'ubuntu-24.04' },
    {
      image: 'vm2api/kin-slot-kvm-ubuntu-24.04:deadbeefcafe',
      network: 'kin-cluster-1-net',
      remoteDir: '/srv/node/vms/vm-cluster-1',
      user: '1000:1000',
      routing: {},
      accel: 'kvm',
      sharedStoreDir: '/srv/node/share/claude-store',
      osAssetsDir: '/srv/node/share/os/crag-debian13',
      hasInitrd: true,
      vhostVsockAvailable: true,
      vsockCid: 1005,
    },
  )
  assert.equal(
    legacyBody.Env.some((e) => e.startsWith('KIN_KVM_MODE=')),
    false,
  )
  assert.equal(
    legacyBody.Env.some((e) => e.startsWith('KIN_KVM_EROFS_IMAGE=')),
    false,
  )
  assert.equal(
    legacyBody.HostConfig.Binds.some((b) => b.includes(CUSTOM_OS_STORE_GUEST_DIR)),
    false,
  )
  assert.equal(
    legacyBody.HostConfig.Binds.some((b) => b.includes(CUSTOM_OS_ASSETS_GUEST_DIR)),
    false,
  )
  assert.equal(
    legacyBody.HostConfig.Devices.some((d) => d.PathOnHost === '/dev/vhost-vsock'),
    false,
  )
})
