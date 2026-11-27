import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  ZOMBIE_SCAN_SCRIPT,
  createCragZombieGuard,
  isCragZombieGuardSchedulable,
  isCragZombieGuardTarget,
  nativeKernelBusy,
  normalizeCragZombieGuardConfig,
  parseZombieScan,
  scanSlotZombies,
} from '../../src/lib/vm/crag-zombie-guard.mjs'
import { KVM_GUEST_EXEC } from '../../src/lib/vm/slot-exec.mjs'
import { recoverSlot } from '../../src/lib/vm/slot-recovery.mjs'
import { stateOfReason } from '../../src/lib/pool/schedule-state.mjs'

const quiet = { warn() {} }
const PROXY = { id: 'px-1', host: '203.0.113.9', port: 1080, url: 'socks5://u:p@203.0.113.9:1080' }
const cragVm = (over = {}) => ({ id: 'vm-c1', status: 'running', dataplane: 'crag', proxy: PROXY, ...over })
const IDLE = { ok: true, healthy: true, active_requests: 0, continuations: 0, queued: 0, active: 0, waiting: 0 }

function procFixture(t, rows) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-zombie-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const { pid, ppid, state, comm, cmdline = '' } of rows) {
    const dir = path.join(root, String(pid))
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'stat'), `${pid} (${comm}) ${state} ${ppid} ${pid} ${pid} 0 -1 4194560`)
    fs.writeFileSync(path.join(dir, 'cmdline'), cmdline ? `${cmdline.split(' ').join('\0')}\0` : '')
  }
  return root
}

function runScan(root) {
  const r = spawnSync('/bin/sh', ['-c', ZOMBIE_SCAN_SCRIPT, 'scan'], {
    env: { ...process.env, KIN_GUARD_PROC: root },
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  return parseZombieScan(r.stdout)
}

test('scan script counts only zombies parented by the gateway worker', (t) => {
  const root = procFixture(t, [
    { pid: 1, ppid: 0, state: 'S', comm: 'systemd', cmdline: '/sbin/init' },
    {
      pid: 210,
      ppid: 1,
      state: 'S',
      comm: 'crag-v2',
      cmdline: '/opt/crag/crag-v2 --gateway-worker --config /run/kin/kernel.json',
    },
    { pid: 301, ppid: 210, state: 'Z', comm: 'claude' },
    { pid: 302, ppid: 210, state: 'Z', comm: 'claude' },
    { pid: 303, ppid: 210, state: 'Z', comm: 'odd) (name' },
    { pid: 304, ppid: 210, state: 'S', comm: 'claude', cmdline: '/usr/local/bin/claude -p' },
    // Someone else's zombie is not the gateway's leak.
    { pid: 401, ppid: 1, state: 'Z', comm: 'sh' },
  ])
  const scan = runScan(root)
  assert.equal(scan.gateway, 1)
  assert.equal(scan.zombies, 3)
  assert.equal(scan.total, 4)
  assert.deepEqual(scan.comms.slice(0, 2), ['claude', 'claude'])
  assert.match(scan.comms[2], /^[A-Za-z0-9._-]+$/)
})

test('scan script reports no gateway and no zombies on a clean table', (t) => {
  const root = procFixture(t, [{ pid: 1, ppid: 0, state: 'S', comm: 'init', cmdline: '/sbin/init' }])
  assert.deepEqual(runScan(root), { gateway: 0, zombies: 0, total: 0, comms: [] })
})

test('parseZombieScan rejects partial or missing output', () => {
  assert.equal(parseZombieScan(''), null)
  assert.equal(parseZombieScan('kin-zombie-scan gateway=1 zombies='), null)
  assert.equal(parseZombieScan('garbage gateway=1 zombies=2 total=2'), null)
  assert.deepEqual(parseZombieScan('noise\nkin-zombie-scan gateway=1 zombies=2 total=5 comms=claude,claude\n'), {
    gateway: 1,
    zombies: 2,
    total: 5,
    comms: ['claude', 'claude'],
  })
})

test('config is off by default and clamps unsafe values', () => {
  const d = normalizeCragZombieGuardConfig()
  assert.equal(d.enabled, false)
  assert.equal(d.interval_sec, 600)
  assert.equal(d.zombie_threshold, 4)
  const c = normalizeCragZombieGuardConfig({ enabled: true, interval_sec: 1, cooldown_sec: 5, zombie_threshold: 0 })
  assert.equal(c.enabled, true)
  assert.equal(c.interval_sec, 60)
  assert.equal(c.cooldown_sec, 600)
  assert.equal(c.zombie_threshold, 4)
})

test('targets only running CRAG v2 slots', () => {
  assert.equal(isCragZombieGuardTarget(cragVm()), true)
  assert.equal(isCragZombieGuardTarget(cragVm({ dataplane: 'cc' })), false)
  assert.equal(isCragZombieGuardTarget(cragVm({ status: 'stopped' })), false)
  assert.equal(isCragZombieGuardTarget(cragVm({ status: 'paused' })), false)
  assert.equal(isCragZombieGuardTarget(cragVm({ migration_pending: true })), false)
  assert.equal(isCragZombieGuardTarget({ id: 'vm-x', status: 'running' }, { inference: { dataplane: 'crag' } }), true)
})

test('nativeKernelBusy only reports idle on complete counters', () => {
  assert.equal(nativeKernelBusy(IDLE), false)
  // CRAG v2 keeps warm idle processes in state.runs and lists their PIDs in `pids`.
  assert.equal(nativeKernelBusy({ ...IDLE, idle: 2, pids: [412, 415] }), false)
  assert.equal(nativeKernelBusy({ ...IDLE, idle: 1, pids: [412, 499] }), true)
  assert.equal(nativeKernelBusy({ ...IDLE, idle: -1, pids: [] }), null)
  assert.equal(nativeKernelBusy({ ...IDLE, recovering: true }), true)
  assert.equal(nativeKernelBusy({ ...IDLE, cleaning: 1 }), true)
  assert.equal(nativeKernelBusy({ ...IDLE, continuations: 1 }), true)
  assert.equal(nativeKernelBusy({ ...IDLE, pids: [12] }), true)
  assert.equal(nativeKernelBusy({ ok: false }), null)
  assert.equal(nativeKernelBusy({ ok: true, queued: 0 }), null)
  assert.equal(nativeKernelBusy({ ...IDLE, queued: -1 }), null)
})

test('scanSlotZombies execs through kin-guest-exec as root on KVM', async () => {
  const calls = []
  const host = { native: false, dockerApi: () => 'conn' }
  const out = await scanSlotZombies(cragVm({ runtime: { type: 'kvm', container: 'kin-c1' } }), {
    hostFor: () => host,
    capture: async (connect, container, cmd, opts) => {
      calls.push({ connect, container, cmd, opts })
      return { exitCode: 0, stdout: 'kin-zombie-scan gateway=1 zombies=4 total=4 comms=claude\n' }
    },
  })
  assert.equal(out.zombies, 4)
  assert.equal(calls[0].container, 'kin-c1')
  assert.equal(calls[0].cmd[0], KVM_GUEST_EXEC)
  assert.deepEqual(calls[0].cmd.slice(1, 3), ['-u', '0'])
  assert.equal(await scanSlotZombies(cragVm(), { hostFor: () => ({ native: true }) }), null)
})

function harness(over = {}) {
  const state = {
    vm: cragVm(),
    zombies: [5, 0],
    inflight: 0,
    native: IDLE,
    faulted: false,
    recovered: [],
    parked: [],
    notified: [],
    now: 1_000_000,
    recoverResult: { ok: true, report: { ok: true, steps: [{ id: 'stop', ok: true }] } },
    ...over,
  }
  const guard = createCragZombieGuard({
    config: { enabled: true, ...(over.config || {}) },
    listTargets: () => [state.vm],
    getVm: () => state.after || state.vm,
    scan: async () => {
      const z = state.zombies.length > 1 ? state.zombies.shift() : state.zombies[0]
      return z == null ? null : { gateway: 1, zombies: z, total: z, comms: [] }
    },
    inflight: () => state.inflight,
    nativeHealth: async () => state.native,
    isFaulted: () => state.faulted,
    recover: async (vm, info) => {
      state.recovered.push({ id: vm.id, ...info })
      return state.recoverResult
    },
    park: (id, detail) => state.parked.push({ id, ...detail }),
    notify: async (msg) => state.notified.push(msg),
    postScanRetryDelayMs: 0,
    now: () => state.now,
    logger: quiet,
  })
  return { guard, state }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('cycles an idle slot over the zombie threshold and verifies afterwards', async () => {
  const { guard, state } = harness()
  const { results } = await guard.tick()
  assert.equal(state.recovered.length, 1)
  assert.equal(state.recovered[0].reason, 'zombies=5')
  assert.equal(results[0].ok, true)
  assert.equal(results[0].zombies_after, 0)
  assert.equal(state.parked.length, 0)
})

test('never touches a slot with requests in flight or native work', async () => {
  for (const over of [{ inflight: 1 }, { native: { ...IDLE, continuations: 2 } }, { native: { ok: false } }]) {
    const { guard, state } = harness(over)
    await guard.tick()
    assert.equal(state.recovered.length, 0, JSON.stringify(over))
  }
})

test('stays off below threshold, when disabled, and on held or parked slots', async () => {
  let h = harness({ zombies: [3] })
  await h.guard.tick()
  assert.equal(h.state.recovered.length, 0)
  h = harness({ config: { enabled: false } })
  await h.guard.tick()
  assert.equal(h.state.recovered.length, 0)
  for (const over of [
    { schedule_hold: { reason: 'maintenance' } },
    { unschedulable: { reason: 'maintenance_failed' } },
    { schedule_off: true },
  ]) {
    h = harness({ vm: cragVm(over) })
    await h.guard.tick()
    assert.equal(h.state.recovered.length, 0, JSON.stringify(over))
  }
})

test('a kernel fault triggers a cycle even when the faulted kernel cannot report counters', async () => {
  const { guard, state } = harness({ zombies: [0], faulted: true, native: null })
  await guard.tick()
  assert.equal(state.recovered.length, 1)
  assert.equal(state.recovered[0].reason, 'kernel_fault')
  const off = harness({ zombies: [0], faulted: true, config: { restart_on_kernel_fault: false } })
  await off.guard.tick()
  assert.equal(off.state.recovered.length, 0)
})

test('cooldown prevents a second cycle until it runs out', async () => {
  const { guard, state } = harness({ zombies: [5, 0, 5, 0] })
  await guard.tick()
  await guard.tick()
  assert.equal(state.recovered.length, 1)
  state.now += 3600 * 1000
  await guard.tick()
  assert.equal(state.recovered.length, 2)
})

test('a refused cycle (drain timeout) is retried later and never parks', async () => {
  const { guard, state } = harness({ recoverResult: { ok: false, code: 'slot_drain_timeout' } })
  const { results } = await guard.tick()
  assert.equal(results[0].action, 'refused')
  assert.equal(state.parked.length, 0)
  state.recoverResult = { ok: true, report: { ok: true, steps: [] } }
  state.zombies = [5, 0]
  await guard.tick()
  assert.equal(state.recovered.length, 2)
})

test('a failed recovery parks the slot and notifies', async () => {
  const { guard, state } = harness({
    recoverResult: {
      ok: true,
      report: { ok: false, steps: [{ id: 'start', ok: false, code: 'kernel_start_failed' }] },
    },
  })
  await guard.tick()
  await flush()
  assert.equal(state.parked.length, 1)
  assert.equal(state.parked[0].code, 'recover_failed')
  assert.equal(state.parked[0].step, 'start')
  assert.equal(state.notified.length, 1)
})

test('a changed egress or lingering zombies after the cycle park the slot', async () => {
  let h = harness({ after: cragVm({ proxy: { ...PROXY, id: 'px-2' } }) })
  await h.guard.tick()
  assert.equal(h.state.parked[0]?.code, 'egress_changed')
  h = harness({ zombies: [6, 6] })
  await h.guard.tick()
  assert.equal(h.state.parked[0]?.code, 'post_check_failed')
  h = harness({ zombies: [6, null] })
  await h.guard.tick()
  assert.equal(h.state.parked[0]?.code, 'post_check_failed')
})

test('cycles at most one slot per tick', async () => {
  const vms = [cragVm({ id: 'vm-a' }), cragVm({ id: 'vm-b' })]
  const recovered = []
  const guard = createCragZombieGuard({
    config: { enabled: true },
    listTargets: () => vms,
    scan: (() => {
      const seq = [5, 0, 5, 0]
      return async () => ({ gateway: 1, zombies: seq.shift() ?? 0, total: 0, comms: [] })
    })(),
    nativeHealth: async () => IDLE,
    recover: async (vm) => {
      recovered.push(vm.id)
      return { ok: true, report: { ok: true } }
    },
    logger: quiet,
  })
  await guard.tick()
  assert.deepEqual(recovered, ['vm-a'])
  await guard.tick()
  assert.deepEqual(recovered, ['vm-a', 'vm-b'])
})

test('maintenance_failed is a 不可调度 reason', () => {
  assert.equal(stateOfReason('maintenance_failed')?.state, 'unschedulable')
})

test('the scanner never counts its own argv as a gateway worker', (t) => {
  assert.equal(ZOMBIE_SCAN_SCRIPT.includes('--gateway-worker'), false)
  const root = procFixture(t, [
    { pid: 50, ppid: 1, state: 'S', comm: 'sh', cmdline: `/bin/sh -c ${ZOMBIE_SCAN_SCRIPT.replace(/\s+/g, ' ')} scan` },
    { pid: 51, ppid: 50, state: 'Z', comm: 'tr' },
  ])
  const out = runScan(root)
  assert.equal(out.gateway, 0)
  assert.equal(out.zombies, 0)
  assert.equal(out.total, 1)
})

test('any outer recover refusal is retried; a thrown recover parks', async () => {
  let h = harness({ recoverResult: { ok: false, code: 'crag_license_expired' } })
  let { results } = await h.guard.tick()
  assert.equal(results[0].action, 'refused')
  assert.equal(h.state.parked.length, 0)
  h = harness()
  h.state.recoverResult = null
  const guard = createCragZombieGuard({
    config: { enabled: true },
    listTargets: () => [cragVm()],
    scan: async () => ({ gateway: 1, zombies: 5, total: 5, comms: [] }),
    nativeHealth: async () => IDLE,
    recover: async () => {
      throw new Error('boom')
    },
    park: (id, detail) => h.state.parked.push({ id, ...detail }),
    logger: quiet,
  })
  ;({ results } = await guard.tick())
  assert.equal(results[0].code, 'recover_failed')
  assert.equal(h.state.parked.length, 1)
})

test('beforeStop re-checks live state and native busyness inside maintenance before stopping', async () => {
  let stopCalled = false
  let freshVm = cragVm()
  let healthSeq = [
    { ...IDLE, idle: 1, pids: [412] },
    { ...IDLE, continuations: 1 },
  ]
  const guard = createCragZombieGuard({
    config: { enabled: true },
    listTargets: () => [cragVm()],
    getVm: () => freshVm,
    scan: async () => ({ gateway: 1, zombies: 5, total: 5, comms: ['claude'] }),
    nativeHealth: async () => (healthSeq.length > 1 ? healthSeq.shift() : healthSeq[0]),
    recover: async (_vm, { beforeStop }) => {
      const check = await beforeStop(freshVm)
      if (!check.ok) return { ok: false, code: check.code }
      stopCalled = true
      return { ok: true, report: { ok: true } }
    },
    postScanRetryDelayMs: 0,
    logger: quiet,
  })
  // 1) Continuation starts between initial nativeHealth and maintenance hold -> refused before stop.
  let out = await guard.tick()
  assert.equal(stopCalled, false)
  assert.equal(out.results[0].action, 'refused')
  assert.equal(out.results[0].reason, 'native_busy')

  // 2) Slot becomes unschedulable (e.g. oauth_revoked) during scan -> refused before stop.
  healthSeq = [{ ...IDLE, idle: 1, pids: [412] }]
  freshVm = cragVm({ unschedulable: { reason: 'oauth_revoked' } })
  out = await guard.tick()
  assert.equal(stopCalled, false)
  assert.equal(out.results[0].action, 'refused')
  assert.equal(out.results[0].reason, 'slot_state_changed')

  // 3) Slot stopped by operator during scan -> refused before stop.
  freshVm = cragVm({ status: 'stopped' })
  out = await guard.tick()
  assert.equal(stopCalled, false)
  assert.equal(out.results[0].action, 'refused')
  assert.equal(out.results[0].reason, 'target_changed')

  // 4) Helper allows our own maintenance hold only when ignoreMaintenanceHold is set.
  assert.equal(isCragZombieGuardSchedulable(cragVm({ schedule_hold: { reason: 'maintenance' } })), false)
  assert.equal(
    isCragZombieGuardSchedulable(cragVm({ schedule_hold: { reason: 'maintenance' } }), { ignoreMaintenanceHold: true }),
    true,
  )
  assert.equal(
    isCragZombieGuardSchedulable(cragVm({ schedule_hold: { reason: 'proxy_cooldown' } }), {
      ignoreMaintenanceHold: true,
    }),
    false,
  )
})

test('a single transient null post-cycle scan retries once before parking', async () => {
  const { guard, state } = harness({ zombies: [5, null, 0] })
  const { results } = await guard.tick()
  assert.equal(results[0].ok, true)
  assert.equal(results[0].zombies_after, 0)
  assert.equal(state.parked.length, 0)
})

test('recoverSlot respects beforeStop, clearUnschedulable:false, and runs verifyAfter while maintenance hold is active', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-zombie-recover-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  const vmPath = path.join(root, 'vms', 'vm-c1.json')
  const writeVm = (over = {}) =>
    fs.writeFileSync(
      vmPath,
      JSON.stringify({
        id: 'vm-c1',
        status: 'running',
        dataplane: 'cc',
        schedulable: true,
        proxy: PROXY,
        claude: { has_access: true, has_refresh: true },
        ...over,
      }),
    )

  // Case 1: beforeStop aborts cleanly before stopSlot runs and rolls back maintenance hold.
  writeVm()
  let stopped = false
  const aborted = await recoverSlot({
    projectRoot: root,
    id: 'vm-c1',
    proxyPool: { ensureBoundToVm: () => PROXY },
    beforeStop: async () => ({ ok: false, code: 'native_busy' }),
    ops: {
      stopSlot: async () => {
        stopped = true
        return { ok: true, action: 'stopped' }
      },
      settleMs: 0,
    },
  })
  assert.equal(aborted.ok, false)
  assert.equal(aborted.code, 'native_busy')
  assert.equal(stopped, false)
  assert.equal(JSON.parse(fs.readFileSync(vmPath, 'utf8')).schedule_hold, undefined)

  // Case 2: clearUnschedulable:false preserves unschedulable AND verifyAfter runs while HOLD_MAINTENANCE is held.
  writeVm({
    schedulable: false,
    schedule_disabled_reason: 'oauth_revoked',
    unschedulable: { reason: 'oauth_revoked', detail: null, at: new Date().toISOString() },
  })
  let holdDuringVerify = null
  const res = await recoverSlot({
    projectRoot: root,
    id: 'vm-c1',
    proxyPool: { ensureBoundToVm: () => PROXY },
    clearUnschedulable: false,
    verifyAfter: async (current) => {
      holdDuringVerify = current?.schedule_hold?.reason || null
      return { ok: true }
    },
    ops: {
      stopSlot: async () => ({ ok: true, action: 'stopped' }),
      powerOn: async () => ({ ok: true, boot: { ok: true } }),
      diagnose: async () => ({ ok: true, checks: [] }),
      settleMs: 0,
    },
  })
  assert.equal(res.ok, true)
  assert.equal(res.report.ok, true)
  assert.equal(holdDuringVerify, 'maintenance')
  const saved = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(saved.unschedulable?.reason, 'oauth_revoked')
  assert.equal(saved.schedule_hold, undefined)
})
