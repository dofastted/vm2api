import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { SocketRelay } from '../../src/lib/cluster/socket-relay.mjs'
import { kernelFaults } from '../../src/lib/transport/rust-kernel-client.mjs'
import {
  createSlotBridgeHealer,
  diagnoseSlotServices,
  recoverSlot,
  reviveDownSlots,
} from '../../src/lib/vm/slot-recovery.mjs'

const SOCKS = { id: 'px-a', host: '203.0.113.7', port: 1080, url: 'socks5://u:p@203.0.113.7:1080' }
const CRED = { has_access: true, has_refresh: true }
const quiet = { warn() {}, log() {} }

function project(vms) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-recovery-'))
  fs.mkdirSync(path.join(root, 'vms'))
  for (const vm of vms) fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  return root
}

function healthyProbes(over = {}) {
  return {
    container: async () => ({ exists: true, running: true, status: 'running' }),
    rustHealth: async () => ({ ok: true, healthy: true, ready_slots: 3, cli_pid: 42 }),
    codexHealth: async () => ({ ok: true }),
    localEgress: () => ({ ok: true }),
    socksEgress: () => ({ ok: true }),
    remoteEgress: async () => ({ exists: true, running: true }),
    cluster: () => null,
    ...over,
  }
}

test('diagnosis names each broken service with its own code, in dependency order', async () => {
  const vm = { id: 'vm-d1', status: 'running', claude: CRED, proxy: SOCKS }
  const root = project([vm])
  kernelFaults.set(vm.id, 'kernel unhealthy after 3 container restarts: cli restarts spent')
  try {
    const d = await diagnoseSlotServices(vm, {
      projectRoot: root,
      internal: true,
      probes: healthyProbes({
        socksEgress: () => ({ ok: false, reason: 'not_running' }),
        container: async () => ({ exists: true, running: false, status: 'exited', exit_code: 137, oom_killed: true }),
        rustHealth: async () => ({ ok: true, healthy: false, unhealthy_reason: 'cli restarts spent' }),
      }),
    })
    assert.deepEqual(
      d.checks.map((c) => c.id),
      ['record', 'credential', 'egress', 'container', 'kernel', 'watchdog', 'schedule'],
    )
    const by = Object.fromEntries(d.checks.map((c) => [c.id, c]))
    assert.equal(d.ok, false)
    assert.equal(d.first_failure, 'egress')
    assert.equal(d.placement, 'local')
    assert.equal(by.egress.code, 'egress_down')
    assert.equal(by.container.code, 'container_stopped')
    assert.equal(by.container.detail.exit_code, 137)
    assert.match(by.container.message, /内存不足/)
    assert.equal(by.kernel.code, 'kernel_unhealthy')
    assert.match(by.kernel.message, /cli restarts spent/)
    assert.equal(by.watchdog.code, 'kernel_faulted')
  } finally {
    kernelFaults.delete(vm.id)
  }
})

test('diagnosis separates a missing credential from a dead kernel and busy from stalled', async () => {
  const bare = { id: 'vm-d2', status: 'running', proxy: SOCKS }
  const live = { id: 'vm-d3', status: 'running', claude: CRED, proxy: SOCKS }
  const root = project([bare, live])
  const down = healthyProbes({ rustHealth: async () => null })
  const noCred = await diagnoseSlotServices(bare, { projectRoot: root, probes: down })
  const kernelOf = (d) => d.checks.find((c) => c.id === 'kernel')
  assert.equal(noCred.first_failure, 'credential')
  assert.equal(noCred.checks[1].code, 'no_credential')
  assert.equal(kernelOf(noCred).status, 'skip', 'no credential: the kernel is down by design')
  assert.equal(kernelOf(await diagnoseSlotServices(live, { projectRoot: root, probes: down })).code, 'kernel_down')

  const busy = healthyProbes({ rustHealth: async () => ({ ok: true, healthy: true, ready_slots: 0, cli_pid: 9 }) })
  const busyKernel = kernelOf(await diagnoseSlotServices(live, { projectRoot: root, probes: busy }))
  assert.equal(busyKernel.status, 'warn')
  assert.equal(busyKernel.code, 'kernel_busy')
  const stalled = healthyProbes({ rustHealth: async () => ({ ok: true, healthy: true, ready_slots: 0, cli_pid: 0 }) })
  assert.equal(kernelOf(await diagnoseSlotServices(live, { projectRoot: root, probes: stalled })).code, 'kernel_no_cli')

  const healthy = await diagnoseSlotServices(live, { projectRoot: root, probes: healthyProbes() })
  assert.equal(healthy.ok, true)
  assert.equal(healthy.first_failure, null)
})

test('diagnosis reports an expired refresh-failed credential as such', async () => {
  const now = Math.floor(Date.now() / 1000)
  const vm = {
    id: 'vm-d4',
    status: 'running',
    schedulable: true,
    claude: { has_access: true, has_refresh: true, expires_at: now - 6 * 3600, refresh_error: 'worker_output_invalid' },
    proxy: SOCKS,
  }
  const root = project([vm])
  const d = await diagnoseSlotServices(vm, { projectRoot: root, probes: healthyProbes() })
  assert.equal(d.ok, false)
  assert.equal(d.first_failure, 'credential')
  assert.equal(d.checks[1].code, 'credential_refresh_failed')
})

test('Codex kernel: idle only when nothing listens and no child is tracked; other failures stay errors', async () => {
  const vm = { id: 'vm-gpt', status: 'running', platform: 'openai', family: 'codex', proxy: SOCKS }
  const root = project([vm])
  const kernelOf = async (health, tracked = false) =>
    (
      await diagnoseSlotServices(vm, {
        projectRoot: root,
        probes: healthyProbes({ codexHealth: async () => health, codexTracked: () => tracked }),
      })
    ).checks.find((c) => c.id === 'kernel')
  const refused = { ok: false, status: 0, code: 'ECONNREFUSED' }
  const cases = [
    ['no socket file', { ok: false, status: 0, code: 'ENOENT' }, false, 'warn', 'codex_kernel_idle'],
    ['stale socket', refused, false, 'warn', 'codex_kernel_idle'],
    ['child still starting', refused, true, 'error', 'codex_kernel_down'],
    ['hung process', { ok: false, status: 0, code: 'worker_timeout' }, false, 'error', 'codex_kernel_down'],
    ['kernel answers non-200', { ok: false, status: 401 }, false, 'error', 'codex_kernel_down'],
    ['permission denied', { ok: false, status: 0, code: 'EACCES' }, false, 'error', 'codex_kernel_down'],
    ['live', { ok: true, status: 200 }, false, 'ok', null],
  ]
  for (const [name, health, tracked, status, code] of cases) {
    const kernel = await kernelOf(health, tracked)
    assert.equal(kernel.status, status, name)
    assert.equal(kernel.code, code, name)
  }
  assert.match((await kernelOf({ ok: false, status: 0, code: 'worker_timeout' })).message, /超时/)
})

test('Codex kernel probe codes come from the real socket: missing, stale and hung are told apart', async () => {
  const vm = { id: 'vm-gpt2', status: 'running', platform: 'openai', family: 'codex', proxy: SOCKS }
  const root = project([vm])
  const run = path.join(root, 'vms', vm.id, 'run')
  fs.mkdirSync(run, { recursive: true })
  const sock = path.join(run, 'codex-kernel.sock')
  // Real codexHealth (no override): codes come from the kernel's socket, not a stub.
  const { codexHealth: _real, ...probes } = healthyProbes()
  const kernel = async () =>
    (await diagnoseSlotServices(vm, { projectRoot: root, probes })).checks.find((c) => c.id === 'kernel')

  assert.equal((await kernel()).code, 'codex_kernel_idle', 'no socket file')
  // A leftover path nobody listens on refuses the connection, like a socket a killed kernel left.
  fs.writeFileSync(sock, '')
  assert.equal((await kernel()).code, 'codex_kernel_idle', 'stale socket path')
  fs.rmSync(sock)

  const net = await import('node:net')
  const hung = net.createServer(() => {})
  await new Promise((resolve) => hung.listen(sock, resolve))
  try {
    const result = await kernel()
    assert.equal(result.status, 'error', 'a listener that never answers is not idle')
    assert.equal(result.detail.error_code, 'worker_timeout')
  } finally {
    hung.close()
  }
})

test('a crash-looping container is reported with its restart count and last log line', async () => {
  const vm = { id: 'vm-loop', status: 'running', claude: CRED, proxy: SOCKS }
  const root = project([vm])
  const d = await diagnoseSlotServices(vm, {
    projectRoot: root,
    internal: true,
    probes: healthyProbes({
      container: async () => ({
        exists: true,
        running: false,
        restarting: true,
        restart_count: 8,
        status: 'restarting',
        exit_code: 1,
        log_tail: ['booting', 'kin-os: persisted persona missing under /var/lib/kin-persona.'],
      }),
    }),
  })
  const container = d.checks.find((c) => c.id === 'container')
  assert.equal(container.code, 'container_crash_loop')
  assert.match(container.message, /已重启 8 次/)
  assert.match(container.message, /最后日志：kin-os: persisted persona missing/)
  assert.equal(container.detail.log_tail.length, 2)
})

test('diagnosis of a node slot reports the SSH link and dead relays', async () => {
  const vm = { id: 'vm-n1', status: 'running', claude: CRED, proxy: SOCKS, node_id: 'node-a' }
  const root = project([vm])
  const status = {
    link: { state: 'backoff', error: { code: 'ssh_closed', message: 'SSH 连接已断开' } },
    bridge: { alive: true },
    relays: { kernel: { alive: false }, worker: { alive: true } },
  }
  const d = await diagnoseSlotServices(vm, {
    projectRoot: root,
    internal: true,
    probes: healthyProbes({
      cluster: () => ({ slotBridgeStatus: () => status }),
      container: async () => {
        throw Object.assign(new Error('节点未连接（backoff）'), { code: 'node_not_ready' })
      },
    }),
  })
  const by = Object.fromEntries(d.checks.map((c) => [c.id, c]))
  assert.equal(d.placement, 'node')
  assert.equal(d.first_failure, 'node_link')
  assert.equal(by.node_link.code, 'node_link_down')
  assert.match(by.node_link.message, /SSH 连接已断开/)
  assert.equal(by.relay.code, 'relay_down')
  assert.match(by.relay.message, /kernel\.sock/)
  assert.equal(by.container.code, 'node_not_ready', 'a failing probe becomes an error check, not a thrown request')
})

const SECRETS = ['rt-secret-1', 'ak-secret-2', 'oat01secretABC', 'sk-simplesecret3', 'bt-secret-4', 'pw-secret-5']
const LEAKY_LOG = [
  '{"refresh_token":"rt-secret-1","expires":1}',
  'loading api_key=ak-secret-2 from env',
  'oauth sk-ant-oat01secretABC and sk-simplesecret3',
  'Authorization: Bearer bt-secret-4',
  'dial socks5://user:pw-secret-5@203.0.113.7:1080 failed',
]

function leakyProbes() {
  return healthyProbes({
    cluster: () => ({
      slotBridgeStatus: () => ({
        link: { state: 'backoff', error: { code: 'ssh_closed', message: 'connect to 10.0.0.9 as root failed' } },
        bridge: { alive: false, error: 'listen /var/lib/vm2api/cluster/node-a/docker.sock EACCES' },
        relays: null,
      }),
    }),
    container: async () => ({
      exists: true,
      running: false,
      restarting: true,
      restart_count: 4,
      status: 'restarting',
      exit_code: 126,
      error: 'exec: "/home/kincli/.kin/kin-kernel": permission denied',
      log_tail: LEAKY_LOG,
    }),
    rustHealth: async () => ({ ok: true, healthy: false, unhealthy_reason: 'cli at /home/kincli/.kin/cli-node died' }),
    socksEgress: () => {
      throw new Error('probe failed with api_key=ak-secret-2')
    },
    remoteEgress: async () => {
      throw new Error('probe failed with api_key=ak-secret-2')
    },
  })
}

test('tenant diagnosis carries codes and numbers but no raw logs, paths, hosts or secrets', async () => {
  const vm = { id: 'vm-t1', status: 'running', claude: CRED, proxy: SOCKS, node_id: 'node-a' }
  const root = project([vm])
  kernelFaults.set(vm.id, 'kernel unhealthy after 3 container restarts: cli at /home/kincli/.kin died')
  try {
    const d = await diagnoseSlotServices(vm, { projectRoot: root, probes: leakyProbes() })
    const body = JSON.stringify(d)
    for (const leak of [...SECRETS, '/home/kincli', '/var/lib/vm2api', '10.0.0.9', 'permission denied', 'log_tail']) {
      assert.equal(body.includes(leak), false, `tenant response leaks ${leak}`)
    }
    const by = Object.fromEntries(d.checks.map((c) => [c.id, c]))
    assert.equal(by.container.code, 'container_crash_loop')
    assert.match(by.container.message, /退出码 126，已重启 4 次/)
    assert.equal(by.egress.code, 'check_failed')
    assert.equal(by.kernel.code, 'kernel_unhealthy')
  } finally {
    kernelFaults.delete(vm.id)
  }
})

test('admin diagnosis shows the log tail and raw causes with secrets masked', async () => {
  const vm = { id: 'vm-a1', status: 'running', claude: CRED, proxy: SOCKS }
  const root = project([vm])
  const d = await diagnoseSlotServices(vm, { projectRoot: root, probes: leakyProbes(), internal: true })
  const body = JSON.stringify(d)
  for (const secret of SECRETS) assert.equal(body.includes(secret), false, `admin response leaks ${secret}`)
  const container = d.checks.find((c) => c.id === 'container')
  assert.equal(container.detail.log_tail.length, LEAKY_LOG.length)
  assert.match(container.message, /\/home\/kincli\/\.kin\/kin-kernel/, 'admins keep the path that names the cause')
  assert.match(container.detail.log_tail[0], /"refresh_token":"\*\*\*"/)
  assert.match(container.detail.log_tail[4], /socks5:\/\/\*\*\*@203\.0\.113\.7/)
})

test('tenant recover report hides failed-step stderr; admin gets it masked', async () => {
  const vm = { id: 'vm-t2', status: 'running', claude: CRED, proxy: SOCKS }
  const root = project([vm])
  const ops = {
    stopSlot: async () => ({ ok: true, action: 'stopped' }),
    powerOn: async () => ({
      ok: false,
      code: 'runtime_start_failed',
      error: 'docker: stat /home/kincli/.kin/kin-kernel: permission denied; api_key=ak-secret-2',
    }),
    diagnose: async () => ({ ok: false, checks: [] }),
    settleMs: 0,
  }
  const tenant = await recoverSlot({ projectRoot: root, id: vm.id, proxyPool: {}, ops })
  const tenantStart = tenant.report.steps.find((s) => s.id === 'start')
  assert.equal(tenantStart.code, 'runtime_start_failed')
  assert.equal(JSON.stringify(tenant.report).includes('/home/kincli'), false)
  assert.equal(JSON.stringify(tenant.report).includes('ak-secret-2'), false)
  const admin = await recoverSlot({ projectRoot: root, id: vm.id, proxyPool: {}, ops, internal: true })
  const adminStart = admin.report.steps.find((s) => s.id === 'start')
  assert.match(adminStart.message, /\/home\/kincli/)
  assert.equal(adminStart.message.includes('ak-secret-2'), false)
})

function recorder() {
  const events = []
  const watchdog = {
    hold: (id) => events.push(`hold:${id}`),
    release: (id) => events.push(`release:${id}`),
    reset: (id) => {
      events.push(`reset:${id}`)
      return { faulted: kernelFaults.delete(id) }
    },
  }
  return { events, watchdog }
}

test('recover power-cycles with the watchdog held off, then clears its fault', async () => {
  const vm = { id: 'vm-r1', status: 'running', claude: CRED, proxy: SOCKS }
  const root = project([vm])
  const { events, watchdog } = recorder()
  kernelFaults.set(vm.id, 'spent')
  const result = await recoverSlot({
    projectRoot: root,
    id: vm.id,
    proxyPool: {},
    watchdog,
    ops: {
      stopSlot: async () => {
        events.push('stop')
        return { ok: true, action: 'stopped' }
      },
      powerOn: async () => {
        events.push('start')
        return { ok: true, boot: { ok: true, rust_ok: true, rust: { ok: true } } }
      },
      diagnose: async () => {
        events.push('diagnose')
        return { ok: true, checks: [] }
      },
      settleMs: 0,
    },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(events, ['hold:vm-r1', 'stop', 'start', 'reset:vm-r1', 'diagnose', 'release:vm-r1'])
  assert.deepEqual(
    result.report.steps.map((s) => [s.id, s.ok]),
    [
      ['stop', true],
      ['start', true],
      ['watchdog_reset', true],
    ],
  )
  assert.match(result.report.steps[2].message, /故障/)
  assert.equal(kernelFaults.has(vm.id), false)
  assert.equal(result.report.ok, true)
})

test('a second recover of the same slot is refused while the first runs', async () => {
  const vm = { id: 'vm-r2', status: 'running', claude: CRED, proxy: SOCKS }
  const root = project([vm])
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const ops = {
    stopSlot: async () => {
      await gate
      return { ok: true, action: 'stopped' }
    },
    powerOn: async () => ({ ok: true, boot: { ok: true } }),
    diagnose: async () => ({ ok: true, checks: [] }),
    settleMs: 0,
  }
  const first = recoverSlot({ projectRoot: root, id: vm.id, proxyPool: {}, ops })
  const second = await recoverSlot({ projectRoot: root, id: vm.id, proxyPool: {}, ops })
  assert.equal(second.status, 409)
  assert.equal(second.code, 'recover_in_progress')
  release()
  assert.equal((await first).ok, true)
  const third = await recoverSlot({ projectRoot: root, id: vm.id, proxyPool: {}, ops })
  assert.equal(third.ok, true, 'the in-progress mark clears when the cycle ends')
})

test('recover stops at the first failed step and reports a kernel that did not come back', async () => {
  const vm = { id: 'vm-r3', status: 'running', claude: CRED, proxy: SOCKS }
  const root = project([vm])
  let started = 0
  const stopFails = await recoverSlot({
    projectRoot: root,
    id: vm.id,
    proxyPool: {},
    ops: {
      stopSlot: async () => ({ ok: false, error: 'docker stop failed' }),
      powerOn: async () => {
        started += 1
        return { ok: true }
      },
      diagnose: async () => ({ ok: false, checks: [] }),
    },
  })
  assert.equal(started, 0)
  assert.deepEqual(
    stopFails.report.steps.map((s) => [s.id, s.code]),
    [['stop', 'stop_failed']],
  )
  assert.equal(stopFails.report.ok, false)

  const kernelFails = await recoverSlot({
    projectRoot: root,
    id: vm.id,
    proxyPool: {},
    ops: {
      stopSlot: async () => ({ ok: true, action: 'already-stopped' }),
      powerOn: async () => ({
        ok: true,
        boot: { ok: true, rust_ok: false, rust: { ok: false, code: 'kernel_health_timeout', error: 'timeout' } },
      }),
      diagnose: async () => ({ ok: true, checks: [] }),
    },
  })
  const start = kernelFails.report.steps.find((s) => s.id === 'start')
  assert.equal(start.ok, false)
  assert.equal(start.code, 'kernel_health_timeout')
  assert.equal(kernelFails.report.ok, false, 'a container that boots without its kernel is not recovered')
})

test('recover of a node slot that cannot reach its node never stops the container', async () => {
  const vm = { id: 'vm-r4', status: 'running', claude: CRED, proxy: SOCKS, node_id: 'node-a' }
  const root = project([vm])
  let stopped = false
  const result = await recoverSlot({
    projectRoot: root,
    id: vm.id,
    proxyPool: {},
    ops: {
      cluster: () => ({
        ensureLinkReady: async () => {
          throw Object.assign(new Error('节点未连接（error）'), { code: 'node_not_ready' })
        },
      }),
      stopSlot: async () => {
        stopped = true
        return { ok: true }
      },
      diagnose: async () => ({ ok: false, checks: [] }),
    },
  })
  assert.equal(stopped, false)
  assert.deepEqual(
    result.report.steps.map((s) => [s.id, s.code]),
    [['node_link', 'node_not_ready']],
  )
})

test('boot revival starts only running-intent slots whose container is down', async () => {
  const booted = []
  const { events, watchdog } = recorder()
  const containers = {
    'vm-exited': { exists: true, running: false, status: 'exited' },
    'vm-gone': { exists: false, running: false },
    'vm-up': { exists: true, running: true },
  }
  const revived = await reviveDownSlots({
    vms: [
      { id: 'vm-exited', status: 'running' },
      { id: 'vm-gone', status: 'running' },
      { id: 'vm-up', status: 'running' },
      { id: 'vm-off', status: 'stopped' },
      { id: 'vm-paused', status: 'paused' },
      { id: 'vm-node', status: 'running', node_id: 'node-a' },
    ],
    inspect: async (vm) => containers[vm.id],
    linkReady: () => false,
    powerOn: async (id) => {
      booted.push(id)
      return { ok: id === 'vm-exited', code: id === 'vm-gone' ? 'proxy_required' : null }
    },
    watchdog,
    logger: quiet,
  })
  assert.deepEqual(booted, ['vm-exited', 'vm-gone'])
  assert.deepEqual(revived, [
    { id: 'vm-exited', ok: true, code: null },
    { id: 'vm-gone', ok: false, code: 'proxy_required' },
  ])
  assert.deepEqual(events, ['hold:vm-exited', 'release:vm-exited', 'hold:vm-gone', 'release:vm-gone'])
})

test('bridge healer restarts a dead kin-egress once per interval and per proxy', async () => {
  let now = 0
  const started = []
  const records = {
    'vm-a': { id: 'vm-a', proxy: SOCKS },
    'vm-b': { id: 'vm-b', proxy: SOCKS },
    'vm-local': { id: 'vm-local', proxy: { id: 'px-local' } },
    'vm-codex': { id: 'vm-codex', platform: 'openai', proxy: { ...SOCKS, id: 'px-c' } },
  }
  const heal = createSlotBridgeHealer({
    projectRoot: '/unused',
    minIntervalMs: 60_000,
    now: () => now,
    logger: quiet,
    ops: {
      getVm: (_root, id) => records[id],
      egressAlive: () => false,
      ensureProxyEgress: (proxy) => {
        started.push(proxy.id)
        return { ok: true }
      },
      cluster: () => null,
    },
  })
  const vms = [
    { id: 'vm-a', status: 'running' },
    { id: 'vm-b', status: 'running' },
    { id: 'vm-local', status: 'running' },
    { id: 'vm-codex', status: 'running', platform: 'openai' },
    { id: 'vm-off', status: 'stopped' },
  ]
  await heal(vms)
  assert.deepEqual(started, ['px-a'], 'one restart for two slots on the same proxy; local and Codex have no kin-egress')
  now = 30_000
  await heal(vms)
  assert.deepEqual(started, ['px-a'], 'a crash-looping helper is not respawned every tick')
  now = 61_000
  await heal(vms)
  assert.deepEqual(started, ['px-a', 'px-a'])
})

test('bridge healer rebuilds dead node relays only over a ready link', async () => {
  const healed = []
  let state = 'backoff'
  const manager = {
    slotBridgeStatus: () => ({
      link: { state },
      bridge: { alive: true },
      relays: { kernel: { alive: false }, worker: { alive: true } },
    }),
    healSlotBridges: async (nodeId, vmId) => {
      healed.push(`${nodeId}/${vmId}`)
      return ['relay']
    },
  }
  const heal = createSlotBridgeHealer({ projectRoot: '/unused', logger: quiet, ops: { cluster: () => manager } })
  const vms = [{ id: 'vm-n', status: 'running', node_id: 'node-a' }]
  await heal(vms)
  assert.deepEqual(healed, [])
  state = 'ready'
  await heal(vms)
  assert.deepEqual(healed, ['node-a/vm-n'])
})

test('a relay whose socket file vanished is dead until restarted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'))
  const relay = new SocketRelay({ socketPath: path.join(dir, 'k.sock'), remotePath: '/x', getClient: () => null })
  try {
    await relay.start()
    assert.equal(relay.alive(), true)
    fs.rmSync(relay.socketPath)
    assert.equal(relay.snapshot().listening, true)
    assert.equal(relay.snapshot().alive, false)
    await relay.restart()
    assert.equal(relay.alive(), true)
    assert.equal(fs.existsSync(relay.socketPath), true)
  } finally {
    await relay.stop()
  }
})
