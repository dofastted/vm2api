import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { writeRemoteFile } from '../../src/lib/cluster/remote-fs.mjs'
import { sealWorkerCredentialFile, writeWorkerCredentialFile } from '../../src/lib/oauth/oauth-credentials.mjs'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import { buildPanelOauthConfig, runSlotOauth } from '../../src/lib/transport/slot-oauth.mjs'
import { pushCustomKvmSlotCredentials, slotHost } from '../../src/lib/vm/slot-host.mjs'

function makeKvmSlot(t, vm = { id: 'vm-33', runtime: { type: 'kvm' }, kernel: 'crag-debian13', status: 'running' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-ssot-kvm-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const slotDir = path.join(root, 'vms', vm.id)
  const homeDir = path.join(slotDir, 'cli-home')
  const runDir = path.join(slotDir, 'run')
  const kvmDir = path.join(slotDir, 'kvm')
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true })
  fs.mkdirSync(runDir, { recursive: true })
  fs.mkdirSync(kvmDir, { recursive: true })
  return { root, slotDir, homeDir, runDir, kvmDir, vm }
}

test('slotHost exposes Panel SSOT one-way syncCredentials and no-op afterRefresh across runtimes', async () => {
  const localDocker = slotHost({ id: 'vm-01' })
  const localKvm = slotHost({ id: 'vm-33', runtime: { type: 'kvm' }, kernel: 'crag-debian13' })
  const remoteNode = slotHost({ id: 'vm-40', node_id: 'node-a' })

  assert.equal(typeof localDocker.syncCredentials, 'function')
  assert.equal(typeof localKvm.syncCredentials, 'function')
  assert.equal(typeof remoteNode.syncCredentials, 'function')

  assert.deepEqual(await localDocker.afterRefresh(), { skipped: true })
  assert.deepEqual(await localKvm.afterRefresh(), { skipped: true })
  assert.deepEqual(await remoteNode.afterRefresh(), { skipped: true })
})

test('pushCustomKvmSlotCredentials strips email and one-way pushes sanitized credentials over kin-slot-agent', async (t) => {
  const { slotDir, homeDir, vm } = makeKvmSlot(t)
  const credFile = path.join(homeDir, '.claude', 'credentials.json')
  fs.writeFileSync(
    credFile,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'at-kvm',
        refreshToken: 'rt-kvm',
        expiresAt: Date.now() + 3600_000,
        email: 'never-guest@example.com',
      },
    }),
  )
  const synced = []
  const client = {
    syncFile: async (params) => {
      synced.push(params)
      return { ok: true, result: { target: params.target } }
    },
  }
  const result = await pushCustomKvmSlotCredentials(vm, slotDir, { client })
  assert.equal(result.pushed, true)
  assert.equal(synced.length, 1)
  assert.equal(synced[0].target, 'credentials')
  const pushedText = Buffer.from(synced[0].content).toString('utf8')
  assert.doesNotMatch(pushedText, /never-guest@example\.com|"email"/)
  assert.equal(JSON.parse(pushedText).claudeAiOauth.refreshToken, 'rt-kvm')
})

test('pushCustomKvmSlotCredentials skips stopped KVM slots and fails closed when running without agent', async (t) => {
  const { slotDir, homeDir, vm } = makeKvmSlot(t)
  writeWorkerCredentialFile(homeDir, {
    access_token: 'at-kvm',
    refresh_token: 'rt-kvm',
    expires_at: Date.now() + 3600_000,
  })

  // Stopped container without agent socket skips cleanly (next boot syncs via rust-kernel-supervisor).
  const stoppedRes = await pushCustomKvmSlotCredentials({ ...vm, status: 'stopped' }, slotDir, {
    isRunning: async () => false,
  })
  assert.deepEqual(stoppedRes, { pushed: false, skipped: true, reason: 'slot_stopped' })

  // Stopped container with stale unreachable socket also skips cleanly.
  const staleRes = await pushCustomKvmSlotCredentials({ ...vm, status: 'stopped' }, slotDir, {
    isRunning: async () => false,
    syncFiles: async () => ({ ok: false, error: 'agent_unreachable', message: 'ECONNREFUSED' }),
  })
  assert.deepEqual(staleRes, { pushed: false, skipped: true, reason: 'slot_stopped' })

  // Running container without agent socket fails closed.
  await assert.rejects(pushCustomKvmSlotCredentials(vm, slotDir, { isRunning: async () => true }), {
    code: 'agent_socket_missing',
  })

  // Running container with socket present but missing token fails closed with agent_token_missing.
  const fakeSock = path.join(slotDir, 'kvm', 'agent.sock')
  fs.writeFileSync(fakeSock, '')
  await assert.rejects(pushCustomKvmSlotCredentials(vm, slotDir, { isRunning: async () => true }), {
    code: 'agent_token_missing',
  })

  // Running container whose agent rejects fails closed.
  await assert.rejects(
    pushCustomKvmSlotCredentials(vm, slotDir, {
      isRunning: async () => true,
      client: { syncFile: async () => ({ ok: false, error: 'unsafe_path', message: 'rejected' }) },
    }),
    { code: 'unsafe_path' },
  )
})

test('runSlotOauth serializes panel refresh before read-only probes when panel credentials are due', async (t) => {
  const { root, homeDir } = makeKvmSlot(t)
  const vm = { id: 'vm-33', proxy: { id: 'px-local', kind: 'local' } }
  const exec = { vmId: 'vm-33', projectRoot: root, homeDir, vm }
  writeWorkerCredentialFile(homeDir, {
    access_token: 'at-expiring',
    refresh_token: 'rt-old',
    expires_at: Date.now() + 30_000,
  })
  const ops = []
  let projections = 0
  const host = {
    kind: 'local',
    syncCredentials: async () => {
      projections += 1
      return { pushed: true }
    },
  }
  const result = await runSlotOauth(exec, 'usage', {
    host,
    runWorker: async (argv) => {
      const op = argv[1]
      ops.push(op)
      if (op === 'refresh') {
        writeWorkerCredentialFile(homeDir, {
          access_token: 'at-fresh',
          refresh_token: 'rt-new',
          expires_at: Date.now() + 3600_000,
        })
        return { code: 0, stdout: '{"ok":true,"status":200,"body":{"refreshed":true},"headers":{}}', stderr: '' }
      }
      return {
        code: 0,
        stdout: '{"ok":true,"status":200,"body":{"five_hour":{"utilization":0.25}},"headers":{}}',
        stderr: '',
      }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.body.five_hour.utilization, 0.25)
  assert.deepEqual(ops, ['refresh', 'usage'])
  assert.equal(projections, 1)

  // Subsequent probe while fresh runs only the read-only probe, never refresh.
  const second = await runSlotOauth(exec, 'profile', {
    host,
    runWorker: async (argv) => {
      ops.push(argv[1])
      return { code: 0, stdout: '{"ok":true,"status":200,"body":{"account":{"uuid":"a1"}},"headers":{}}', stderr: '' }
    },
  })
  assert.equal(second.ok, true)
  assert.deepEqual(ops, ['refresh', 'usage', 'profile'])
  assert.equal(projections, 1)
})

test('PoolScheduler clearAuthCooldownFor and clearGrantRevokeCooldownFor unconditionally unrest Rust scheduler nodes', () => {
  const unrested = []
  let capacityNotifications = 0
  const pool = new PoolScheduler({
    runtimeRepo: {
      clearAuthCooldown: () => false,
      clearGrantRevokeCooldown: () => false,
    },
    schedulerRuntime: {
      unrestNode: async (nodeKey) => {
        unrested.push(nodeKey)
        return { sink_cleared: true }
      },
      pushTelemetryNow: async () => {
        capacityNotifications += 1
      },
    },
  })
  assert.equal(pool.clearAuthCooldownFor('vm-33', 'acct-33'), false)
  assert.equal(pool.clearGrantRevokeCooldownFor('vm-33', 'acct-33'), false)
  assert.equal(pool.unrestVmNode('vm-35'), true)
  assert.deepEqual(unrested, ['claude_vm:vm-33', 'claude_vm:vm-33', 'claude_vm:vm-35'])
  assert.equal(capacityNotifications, 2)
})

test('writeRemoteFile opens temp writable (0600) before fchmod to read-only 0400', async () => {
  const events = []
  const fakeSftp = {
    open(_tmp, flags, attrs, cb) {
      events.push({ op: 'open', flags, mode: attrs.mode })
      cb(null, Buffer.from('h1'))
    },
    write(_handle, _data, _off, len, _pos, cb) {
      events.push({ op: 'write', len })
      cb(null)
    },
    fchmod(_handle, mode, cb) {
      events.push({ op: 'fchmod', mode })
      cb(null)
    },
    close(_handle, cb) {
      events.push({ op: 'close' })
      cb(null)
    },
    ext_openssh_rename(_tmp, dest, cb) {
      events.push({ op: 'rename', dest })
      cb(null)
    },
  }
  await writeRemoteFile(fakeSftp, '/srv/vms/vm-07/claude/credentials.json', Buffer.from('{}'), { mode: 0o400 })
  assert.deepEqual(events, [
    { op: 'open', flags: 'wx', mode: 0o600 },
    { op: 'write', len: 2 },
    { op: 'fchmod', mode: 0o400 },
    { op: 'close' },
    { op: 'rename', dest: '/srv/vms/vm-07/claude/credentials.json' },
  ])
})

test('host credential operations reject symlinked .claude and credentials.json while keeping .credentials.json alias valid', async (t) => {
  const { root, homeDir } = makeKvmSlot(t, { id: 'vm-51', proxy: { id: 'px-local', kind: 'local' } })
  const victimDir = path.join(root, 'vms', 'vm-victim', 'cli-home', '.claude')
  fs.mkdirSync(victimDir, { recursive: true })
  const victimCred = path.join(victimDir, 'credentials.json')
  const victimBody = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'victim-at',
      refreshToken: 'victim-rt',
      expiresAt: Date.now() + 3600_000,
    },
  })
  fs.writeFileSync(victimCred, victimBody, { mode: 0o600 })

  const vm = { id: 'vm-51', proxy: { id: 'px-local', kind: 'local' } }
  const exec = { vmId: 'vm-51', projectRoot: root, homeDir, vm }
  let workerInvoked = false
  const runWorker = async () => {
    workerInvoked = true
    return { code: 0, stdout: '{"ok":true,"status":200,"body":{},"headers":{}}', stderr: '' }
  }

  // Case 1: .claude replaced with a symlink to another slot's .claude directory.
  const claudeDir = path.join(homeDir, '.claude')
  fs.rmSync(claudeDir, { recursive: true, force: true })
  fs.symlinkSync(victimDir, claudeDir)

  const builtDirLink = buildPanelOauthConfig(exec)
  assert.equal(builtDirLink.ok, false)
  assert.equal(builtDirLink.code, 'unsafe_credential_path')

  const oauthDirLink = await runSlotOauth(exec, 'refresh', { runWorker })
  assert.equal(oauthDirLink.ok, false)
  assert.equal(oauthDirLink.body.error.code, 'unsafe_credential_path')
  assert.equal(workerInvoked, false)

  assert.throws(() => sealWorkerCredentialFile(homeDir), { code: 'unsafe_credential_path' })
  assert.throws(
    () =>
      writeWorkerCredentialFile(homeDir, {
        access_token: 'attacker-at',
        refresh_token: 'attacker-rt',
        expires_at: Date.now() + 3600_000,
      }),
    { code: 'unsafe_credential_path' },
  )
  assert.equal(fs.readFileSync(victimCred, 'utf8'), victimBody, 'victim credentials must remain untouched')

  // Case 2: real .claude dir, but credentials.json is a symlink to another slot's credentials.json.
  fs.unlinkSync(claudeDir)
  fs.mkdirSync(claudeDir, { recursive: true })
  fs.symlinkSync(victimCred, path.join(claudeDir, 'credentials.json'))

  const builtFileLink = buildPanelOauthConfig(exec)
  assert.equal(builtFileLink.ok, false)
  assert.equal(builtFileLink.code, 'unsafe_credential_path')

  const oauthFileLink = await runSlotOauth(exec, 'usage', { runWorker })
  assert.equal(oauthFileLink.ok, false)
  assert.equal(oauthFileLink.body.error.code, 'unsafe_credential_path')
  assert.equal(workerInvoked, false)

  assert.throws(() => sealWorkerCredentialFile(homeDir), { code: 'unsafe_credential_path' })
  assert.throws(
    () =>
      writeWorkerCredentialFile(homeDir, {
        access_token: 'attacker-at',
        refresh_token: 'attacker-rt',
        expires_at: Date.now() + 3600_000,
      }),
    { code: 'unsafe_credential_path' },
  )
  assert.equal(fs.readFileSync(victimCred, 'utf8'), victimBody, 'victim credentials must remain untouched')

  // Case 3: legitimate regular credentials.json + relative `.credentials.json -> credentials.json` alias succeeds.
  fs.unlinkSync(path.join(claudeDir, 'credentials.json'))
  const written = writeWorkerCredentialFile(homeDir, {
    access_token: 'legit-at',
    refresh_token: 'legit-rt',
    expires_at: Date.now() + 3600_000,
  })
  assert.equal(written, path.join(claudeDir, 'credentials.json'))
  assert.equal(fs.readlinkSync(path.join(claudeDir, '.credentials.json')), 'credentials.json')
  assert.equal(sealWorkerCredentialFile(homeDir).sealed, true)
  assert.equal(buildPanelOauthConfig(exec).ok, true)
})
