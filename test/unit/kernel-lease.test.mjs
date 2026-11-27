import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PoolScheduler, normalizePoolRouting } from '../../src/lib/pool/pool-scheduler.mjs'
import {
  KernelLeaseStats,
  kernelCapacityOf,
  leaseVerdict,
  normalizeKernelLeaseMode,
} from '../../src/lib/pool/kernel-lease.mjs'
import { SchedulerUnavailableError } from '../../src/lib/scheduler/scheduler-runtime.mjs'
import { createMockSchedulerRuntime } from '../helpers/mock-scheduler-runtime.mjs'

function project(policy = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-pool-scheduler-'))
  const vms = path.join(root, 'vms')
  fs.mkdirSync(vms, { recursive: true })
  const write = (id, accountId, extraPolicy = {}) => {
    const vm = {
      id,
      name: id,
      status: 'running',
      schedulable: true,
      proxy_cli_enabled: true,
      proxy: {
        id: `proxy-${id}`,
        url: `socks5h://127.0.0.1:${id === 'vm-01' ? 10001 : 10002}`,
      },
      runtime: { worker_socket: path.join(vms, id, 'run', 'worker.sock') },
      policy: {
        maxConcurrency: 2,
        concurrencyOverride: true,
        weight: 1,
        priority: 0,
        ...policy,
        ...extraPolicy,
      },
      claude: {
        account_uuid: accountId,
        account_tier: 'max',
        access_token: `access-${accountId}`,
        refresh_token: `refresh-${accountId}`,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    }
    fs.writeFileSync(path.join(vms, `${id}.json`), JSON.stringify(vm))
    return vm
  }
  write('vm-01', 'account-1')
  write('vm-02', 'account-2')
  fs.writeFileSync(path.join(vms, 'active.json'), JSON.stringify({ active_vm: 'vm-01' }))
  return root
}

test('kernel lease helpers', () => {
  assert.equal(normalizeKernelLeaseMode('Observe'), 'observe')
  assert.equal(normalizeKernelLeaseMode('enforce'), 'enforce')
  assert.equal(normalizeKernelLeaseMode('yes'), 'off')
  assert.equal(normalizeKernelLeaseMode(undefined), 'off')
  assert.equal(kernelCapacityOf({ runnable_capacity: 2 }), 2)
  assert.equal(kernelCapacityOf({ runnable_capacity: 0 }), 0)
  assert.equal(kernelCapacityOf({ ready_slots: 2 }), null)
  assert.equal(kernelCapacityOf(null), null)
  assert.equal(leaseVerdict({ capacity: 1, inflight: 0 }), 'ok')
  assert.equal(leaseVerdict({ capacity: 1, inflight: 1 }), 'over')
  assert.equal(leaseVerdict({ capacity: null, inflight: 9 }), 'unknown')
})

test('normalizePoolRouting keeps kernel_lease and clamps kernel_lease_queue_grace_ms', () => {
  assert.equal(normalizePoolRouting({ kernel_lease: 'observe' }).kernel_lease, 'observe')
  assert.equal(normalizePoolRouting({ kernel_lease: 'enforce' }).kernel_lease, 'enforce')
  assert.equal(normalizePoolRouting({}).kernel_lease, 'off')
  assert.equal(normalizePoolRouting({ kernel_lease_queue_grace_ms: 0 }).kernel_lease_queue_grace_ms, 0)
  assert.equal(normalizePoolRouting({ kernel_lease_queue_grace_ms: 999_999 }).kernel_lease_queue_grace_ms, 120_000)
})

test('KernelLeaseStats records observe/enforce grants, denials, slot_busy desyncs, and summary flush', () => {
  let clock = 1_000
  const lines = []
  const stats = new KernelLeaseStats({
    log: (line) => lines.push(line),
    intervalMs: 60_000,
    now: () => clock,
  })

  stats.noteGrant({ mode: 'observe', verdict: 'ok', vmId: 'vm-01', capacity: 1, inflight: 0 })
  stats.noteGrant({
    mode: 'observe',
    verdict: 'over',
    vmId: 'vm-01',
    capacity: 1,
    inflight: 1,
    selectionReason: 'balanced',
  })
  stats.noteGrant({ mode: 'enforce', verdict: 'over', vmId: 'vm-02', capacity: 1, inflight: 1, denied: true })
  stats.noteGrant({ mode: 'enforce', verdict: 'unknown', vmId: 'vm-02', capacity: null, inflight: 0 })

  stats.noteSlotBusy({ mode: 'observe', verdict: 'over', vmId: 'vm-01', capacity: 1, inflight: 1, message: 'busy' })
  stats.noteSlotBusy({ mode: 'observe', verdict: 'ok', vmId: 'vm-01', capacity: 1, inflight: 0, message: 'desync' })
  stats.noteSlotBusy({ mode: 'enforce', verdict: 'unknown', vmId: 'vm-02', capacity: null, inflight: 0 })

  const snap = stats.snapshot()
  assert.equal(snap.total.granted, 3)
  assert.equal(snap.total.unknown, 1)
  assert.equal(snap.total.over, 1)
  assert.equal(snap.total.denied, 1)
  assert.equal(snap.total.slot_busy, 3)
  assert.equal(snap.total.slot_busy_over, 1)
  assert.equal(snap.total.desync, 1)
  assert.equal(snap.total.slot_busy_unknown, 1)
  assert.equal(snap.by_vm['vm-01'].over, 1)
  assert.equal(snap.by_vm['vm-01'].desync, 1)
  assert.equal(snap.by_vm['vm-02'].denied, 1)
  assert.ok(lines.some((line) => line.includes('would-deny') && line.includes('vm=vm-01')))
  assert.ok(lines.some((line) => line.includes('deny') && line.includes('vm=vm-02')))

  clock += 60_000
  stats.maybeFlush('observe')
  assert.ok(lines.some((line) => line.includes('[kernel-lease] summary mode=observe')))
})

test('PoolScheduler.noteKernelSlotBusy feeds kernelLeaseSnapshot and ignores selections without kernelLease', () => {
  const lines = []
  const pool = new PoolScheduler({ config: { kernel_lease: 'observe' } })
  pool.kernelLeaseStats = new KernelLeaseStats({ log: (line) => lines.push(line) })

  pool.noteKernelSlotBusy({ vmId: 'vm-01' })
  assert.equal(pool.kernelLeaseSnapshot().total.slot_busy, 0)

  pool.noteKernelSlotBusy({
    vmId: 'vm-01',
    kernelLease: { mode: 'observe', verdict: 'over', capacity: 1, inflight: 1 },
  })
  pool.noteKernelSlotBusy({
    vmId: 'vm-01',
    kernelLease: { mode: 'observe', verdict: 'ok', capacity: 1, inflight: 0 },
  })
  const snap = pool.kernelLeaseSnapshot()
  assert.equal(snap.mode, 'observe')
  assert.equal(snap.total.slot_busy, 2)
  assert.equal(snap.total.slot_busy_over, 1)
  assert.equal(snap.total.desync, 1)
})

test('M3 cutover (D4): PoolScheduler delegates capacity enforcement to schedulerRuntime and fails closed without it', async (t) => {
  const root = project({ maxConcurrency: 1 })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const unbacked = new PoolScheduler({ projectRoot: root, config: { kernel_lease: 'enforce' } })
  await assert.rejects(
    () => unbacked.selectAndReserve({ model: 'claude-test', allowWait: false }),
    (err) => err instanceof SchedulerUnavailableError && err.code === 'scheduler_unavailable',
  )

  const runtime = createMockSchedulerRuntime({ projectRoot: root })
  const pool = new PoolScheduler({
    projectRoot: root,
    schedulerRuntime: runtime,
    config: { kernel_lease: 'enforce' },
  })

  const req = { model: 'claude-test', allowWait: false }
  const a = await pool.selectAndReserve(req)
  const b = await pool.selectAndReserve(req)
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.notEqual(a.vmId, b.vmId, 'single-concurrency slots spill across VMs via schedulerRuntime')
  assert.equal(a.kernelLease, undefined, 'legacy Node PoolScheduler kernelLease field is removed in M3')

  const c = await pool.selectAndReserve(req)
  assert.equal(c.ok, false, 'saturated slots reject when capacity is full')

  a.release()
  await new Promise((resolve) => setImmediate(resolve))
  const d = await pool.selectAndReserve(req)
  assert.equal(d.ok, true, 'release returns capacity to schedulerRuntime')
  assert.equal(d.vmId, a.vmId)
  b.release()
  d.release()
})
