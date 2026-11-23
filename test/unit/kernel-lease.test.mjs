import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import {
  KernelLeaseStats,
  kernelCapacityOf,
  leaseVerdict,
  normalizeKernelLeaseMode,
} from '../../src/lib/pool/kernel-lease.mjs'

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-pool-scheduler-'))
  const vms = path.join(root, 'vms')
  fs.mkdirSync(vms, { recursive: true })
  const write = (id, accountId, policy = {}) => {
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

class RuntimeRepo {
  constructor(accounts = null) {
    this.accounts = accounts
  }
  schedulingSnapshot(ids) {
    return new Map(
      ids.map((id) => [
        id,
        {
          state: this.get(id),
          account: this.accounts?.get(id) ? { status: 'active', schedulable: true, ...this.accounts.get(id) } : null,
        },
      ]),
    )
  }
  writeHeartbeat(input) {
    this.upsert(input)
  }
  states = new Map()

  get(id) {
    return this.states.get(id) || null
  }
  clearExpired() {}
  upsert(state) {
    const next = { ...(this.states.get(state.account_id) || {}), ...state }
    this.states.set(state.account_id, next)
    return next
  }
  clearGrantRevokeCooldown(id, { vmId = null } = {}) {
    const state = this.states.get(id)
    if (!state) return false
    if (
      !/oauth_revoked|oauth_invalid_grant|invalid_grant|token has been revoked|oauth_no_refresh/i.test(
        String(state.cooldown_reason || ''),
      )
    ) {
      return false
    }
    this.states.set(id, {
      ...state,
      vm_id: state.vm_id || vmId,
      status: 'ready',
      cooldown_until: null,
      cooldown_reason: null,
    })
    return true
  }

  markCooldown(id, update) {
    const state = this.states.get(id) || {
      account_id: id,
      vm_id: update.vmId,
      model_states: {},
    }
    if (update.model) {
      state.model_states = {
        ...(state.model_states || {}),
        [update.model]: { cooldown_until: update.until, reason: update.reason },
      }
    } else {
      state.cooldown_until = update.until
      state.cooldown_reason = update.reason
      state.status = update.status
    }
    this.states.set(id, state)
    return state
  }
}

function scheduler(root, extras = {}) {
  const runtime = extras.runtimeRepo || new RuntimeRepo()
  runtime.accounts = extras.accountQuota?.repo || null
  return new PoolScheduler({
    projectRoot: root,
    runtimeRepo: runtime,
    stickyRouter: extras.stickyRouter || null,
    accountQuota: extras.accountQuota || { canAccept: () => ({ ok: true }) },
    workerHealth:
      extras.workerHealth ||
      (async () => ({
        ok: true,
        credential: { generation: 1, has_access: true },
      })),
    config: {
      fallback_wait_timeout_ms: 5,
      sticky_wait_timeout_ms: 5,
      ...extras.config,
    },
  })
}

const health = (capacity) => async (exec) => ({
  ok: true,
  credential: { generation: 1, has_access: true },
  ...(capacity == null
    ? {}
    : {
        runnable_capacity: typeof capacity === 'object' ? capacity[exec.vmId] : capacity,
      }),
})

function leasePool(root, mode, capacity, lines = []) {
  const pool = scheduler(root, {
    workerHealth: health(capacity),
    config: { kernel_lease: mode },
  })
  pool.kernelLeaseStats = new KernelLeaseStats({
    log: (line) => lines.push(line),
  })
  return pool
}

const only1 = {
  model: 'claude-test',
  excluded: new Set(['account-2']),
  allowWait: false,
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

test('kernel_lease off: no lease on the reservation', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = leasePool(root, 'off', 1)
  const a = await pool.selectAndReserve(only1)
  const b = await pool.selectAndReserve(only1)
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(a.kernelLease, null)
  a.release()
  b.release()
})

test('kernel_lease observe: grants beyond runnable_capacity but counts them', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const lines = []
  const pool = leasePool(root, 'observe', 1, lines)
  const a = await pool.selectAndReserve(only1)
  const b = await pool.selectAndReserve(only1)
  assert.equal(a.ok, true)
  assert.equal(b.ok, true, 'observe never changes the decision')
  assert.equal(a.kernelLease.verdict, 'ok')
  assert.equal(b.kernelLease.verdict, 'over')
  const snap = pool.kernelLeaseSnapshot()
  assert.equal(snap.mode, 'observe')
  assert.equal(snap.total.over, 1)
  assert.equal(snap.total.denied, 0)
  assert.ok(lines.some((line) => line.includes('would-deny') && line.includes('vm=vm-01')))
  // The kernel then says busy for the over-capacity request, and once for a granted one (desync).
  pool.noteKernelSlotBusy(b)
  pool.noteKernelSlotBusy(a)
  assert.equal(pool.kernelLeaseSnapshot().total.slot_busy_over, 1)
  assert.equal(pool.kernelLeaseSnapshot().total.desync, 1)
  a.release()
  b.release()
})

test('kernel_lease enforce: refuses a VM at runnable_capacity and frees on release', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = leasePool(root, 'enforce', 1)
  const a = await pool.selectAndReserve(only1)
  assert.equal(a.ok, true)
  assert.equal(a.kernelLease.verdict, 'ok')
  assert.ok(
    a.slotWaitDeadlineMs <= Date.now() + 5000,
    'a leased request only waits the grace in the kernel (kernel_lease_queue_grace_ms)',
  )
  const b = await pool.selectAndReserve(only1)
  assert.equal(b.ok, false)
  assert.equal(pool.kernelLeaseSnapshot().total.denied >= 1, true)
  a.release()
  const c = await pool.selectAndReserve(only1)
  assert.equal(c.ok, true, 'release frees the lease')
  c.release()
})

test('kernel_lease enforce: a full kernel spills to a VM with a free slot', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = leasePool(root, 'enforce', { 'vm-01': 1, 'vm-02': 1 })
  const req = { model: 'claude-test', allowWait: false }
  const a = await pool.selectAndReserve(req)
  const b = await pool.selectAndReserve(req)
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.notEqual(a.vmId, b.vmId, 'one request per one-slot kernel')
  const c = await pool.selectAndReserve(req)
  assert.equal(c.ok, false)
  a.release()
  b.release()
})

test('kernel_lease enforce: runnable_capacity 0 takes nothing', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = leasePool(root, 'enforce', { 'vm-01': 0, 'vm-02': 2 })
  const req = { model: 'claude-test', allowWait: false }
  const a = await pool.selectAndReserve(req)
  const b = await pool.selectAndReserve(req)
  assert.equal(a.vmId, 'vm-02')
  assert.equal(b.vmId, 'vm-02')
  a.release()
  b.release()
})

test('kernel_lease enforce: a kernel that does not report capacity keeps the old limits', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = leasePool(root, 'enforce', null)
  const a = await pool.selectAndReserve(only1)
  const b = await pool.selectAndReserve(only1)
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(a.kernelLease.verdict, 'unknown')
  assert.ok(!(a.slotWaitDeadlineMs <= Date.now() - 1000), 'no fail-fast without a known capacity')
  a.release()
  b.release()
})

test('kernel_lease enforce: a queued request gets the lease when one is released', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = scheduler(root, {
    workerHealth: health(1),
    config: {
      kernel_lease: 'enforce',
      fallback_wait_timeout_ms: 3000,
      sticky_wait_timeout_ms: 3000,
    },
  })
  pool.kernelLeaseStats = new KernelLeaseStats({ log: () => {} })
  const a = await pool.selectAndReserve(only1)
  assert.equal(a.ok, true)
  const waiting = pool.selectAndReserve({ ...only1, allowWait: true })
  setTimeout(() => a.release(), 50)
  const b = await waiting
  assert.equal(b.ok, true)
  assert.equal(b.vmId, 'vm-01')
  b.release()
})

test('normalizePoolRouting keeps kernel_lease', async () => {
  const { normalizePoolRouting } = await import('../../src/lib/pool/pool-scheduler.mjs')
  assert.equal(normalizePoolRouting({ kernel_lease: 'observe' }).kernel_lease, 'observe')
  assert.equal(normalizePoolRouting({}).kernel_lease, 'off')
})

test('kernel_lease enforce: kernel_lease_queue_grace_ms 0 means the kernel must not queue', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = scheduler(root, {
    workerHealth: health(1),
    config: { kernel_lease: 'enforce', kernel_lease_queue_grace_ms: 0 },
  })
  pool.kernelLeaseStats = new KernelLeaseStats({ log: () => {} })
  const a = await pool.selectAndReserve(only1)
  assert.ok(a.slotWaitDeadlineMs <= Date.now())
  a.release()
})

test('kernel_lease enforce: a content seat takes a lease per request and spreads over free kernels', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = leasePool(root, 'enforce', 1)
  const req = { model: 'claude-test', seatKey: 'seat:h:0123456789abcdef', allowWait: false }
  const a = await pool.selectAndReserve(req)
  const b = await pool.selectAndReserve(req)
  assert.equal(a.ok, true)
  assert.equal(b.ok, true, 'second request of the batch is not stuck behind the first kernel')
  assert.notEqual(a.vmId, b.vmId)
  a.release()
  b.release()
  const c = await pool.selectAndReserve(req)
  assert.equal(c.vmId, b.vmId, 'affinity prefers the VM the seat last ran on')
  c.release()
})

test('kernel_lease enforce: a session seat stays on its VM', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = leasePool(root, 'enforce', 1)
  const req = { model: 'claude-test', seatKey: 'seat:sess:abc', allowWait: false }
  const a = await pool.selectAndReserve(req)
  assert.equal(a.ok, true)
  const b = await pool.selectAndReserve(req)
  assert.equal(b.ok, false, 'a conversation does not spill to another account for a lease')
  a.release()
})

test('kernel_lease observe: a content seat keeps the seat path', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = leasePool(root, 'observe', 1)
  const req = { model: 'claude-test', seatKey: 'seat:h:0123456789abcdef', allowWait: false }
  const a = await pool.selectAndReserve(req)
  const b = await pool.selectAndReserve(req)
  assert.equal(a.vmId, b.vmId)
  assert.equal(b.selectionReason, 'seat-held')
  a.release()
  b.release()
})
