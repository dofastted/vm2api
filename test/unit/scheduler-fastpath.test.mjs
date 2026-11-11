import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import { AccountRuntimeRepo } from '../../src/lib/db/repos/account-runtime-repo.mjs'
import { RequestAttemptsRepo } from '../../src/lib/db/repos/request-attempts-repo.mjs'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import { UnitCircuit } from '../../src/lib/pool/unit-circuit.mjs'

function fixture(t, { concurrency = 2, workerHealth } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-fastpath-'))
  const db = createDatabase({ dataDir: path.join(root, 'data') })
  const sql = []
  const prepare = db.prepare.bind(db)
  db.prepare = (text) => {
    const statement = prepare(text)
    return new Proxy(statement, {
      get(target, name) {
        const value = Reflect.get(target, name, target)
        if (['run', 'get', 'all', 'iterate'].includes(name)) {
          return (...args) => {
            sql.push(text.trim())
            return value.apply(target, args)
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }
  fs.mkdirSync(path.join(root, 'vms'))
  const quota = new AccountQuota({ db, config: { concurrency: { default_max_per_account: concurrency } } })
  const runtime = new AccountRuntimeRepo(db)
  quota.attachRuntimeRepo(runtime)
  for (const n of [1, 2]) {
    const id = `vm-0${n}`,
      accountId = `fast-account-${n}`
    quota.ensure({ account_id: accountId, vm_id: id, max_concurrency: concurrency, concurrency_override: true })
    fs.writeFileSync(
      path.join(root, 'vms', `${id}.json`),
      JSON.stringify({
        id,
        name: id,
        status: 'running',
        schedulable: true,
        proxy_cli_enabled: true,
        proxy: { id: `proxy-${id}`, url: 'socks5h://127.0.0.1:10001' },
        policy: { maxConcurrency: concurrency, concurrencyOverride: true },
        claude: {
          account_uuid: accountId,
          account_tier: 'max',
          access_token: `synthetic-${id}`,
          refresh_token: `synthetic-refresh-${id}`,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      }),
    )
  }
  const probes = []
  const pool = new PoolScheduler({
    projectRoot: root,
    runtimeRepo: runtime,
    accountQuota: quota,
    workerHealth:
      workerHealth ||
      (async (exec) => {
        probes.push(exec.vmId)
        return { ok: true, healthy: true }
      }),
    config: { worker_health_ttl_ms: 5000, default_session_slots: 20, fallback_wait_timeout_ms: 1000 },
  })
  pool.unitCircuit = new UnitCircuit({ repo: runtime })
  t.after(async () => {
    pool.stopMaintenance()
    await pool.maintenanceFlight
    db.close()
  })
  return { db, root, quota, runtime, pool, probes, sql }
}
const options = { model: 'claude-sonnet-5-5', allowWait: false }

test('scheduler reads account/runtime in one credential-free snapshot', (t) => {
  const { runtime, sql } = fixture(t)
  sql.length = 0
  const snapshots = runtime.schedulingSnapshot(['fast-account-1', 'fast-account-2'])
  assert.equal(sql.length, 1)
  assert.equal(snapshots.size, 2)
  assert.equal(snapshots.get('fast-account-1').account.max_concurrency, 2)
  assert.equal(snapshots.get('fast-account-1').state.vm_id, 'vm-01')
  assert(!/credentials|access_token|refresh_token/.test(sql[0]))
})

test('a held session uses two reads and checks only its home even with cold health', async (t) => {
  const { pool, probes, sql } = fixture(t)
  const first = await pool.selectAndReserve({ ...options, seatKey: 'seat:sess:fast' })
  assert(first.ok)
  pool.healthCache.clear()
  probes.length = 0
  sql.length = 0
  const second = await pool.selectAndReserve({ ...options, seatKey: 'seat:sess:fast' })
  assert(second.ok)
  assert.equal(second.vmId, first.vmId)
  assert.deepEqual(probes, [first.vmId])
  assert.equal(sql.length, 2, JSON.stringify(sql))
  assert(sql.every((statement) => statement.startsWith('SELECT')))
  assert.equal(second.queueWaitMs, 0)
  assert.equal(second.schedulingMs, second.waitMs)
  first.release()
  second.release()
  assert.equal(pool.inflight.size, 0)
})

test('health singleflight survives caller cancellation and persists without touching account rows', async (t) => {
  let probes = 0
  const { pool, runtime, sql } = fixture(t, {
    workerHealth: async () => {
      probes++
      await delay(30)
      return { ok: true, healthy: true }
    },
  })
  const exec = { vmId: 'vm-01', accountId: 'fast-account-1' }
  const controller = new AbortController()
  const cancelled = pool.getWorkerHealth(exec, { signal: controller.signal })
  const surviving = pool.getWorkerHealth(exec)
  controller.abort()
  await assert.rejects(cancelled, { code: 'selection_cancelled' })
  assert.equal((await surviving).ok, true)
  assert.equal(probes, 1)
  assert.equal(runtime.get(exec.accountId).worker_heartbeat_at, null)
  runtime.markCooldown(exec.accountId, {
    vmId: exec.vmId,
    until: Date.now() + 60000,
    reason: 'test',
    model: 'claude-sonnet-5-5',
  })
  sql.length = 0
  await pool.flushHealthWrites()
  assert.equal(sql.length, 1)
  assert(sql[0].startsWith('INSERT INTO account_runtime'))
  assert.equal(runtime.get(exec.accountId).model_states['claude-sonnet-5-5'].reason, 'test')
  pool.workerHealth = async () => ({ ok: true, healthy: true, marker: 'new-account' })
  assert.equal((await pool.getWorkerHealth({ ...exec, accountId: 'fast-account-2' })).marker, 'new-account')
})

test('admission rejects a new disable, cooldown or scope restriction after selection', async (t) => {
  const { pool, runtime, db } = fixture(t)
  const candidate = (await pool.eligibleCandidates(options))[0]
  db.prepare("UPDATE accounts SET status='disabled' WHERE id=?").run(candidate.accountId)
  assert.equal(pool.reserve(candidate), null)
  db.prepare("UPDATE accounts SET status='active' WHERE id=?").run(candidate.accountId)
  runtime.updateWindow(candidate.accountId, { vmId: candidate.vmId, overloadUntil: Date.now() + 60000 })
  assert.equal(pool.reserve(candidate), null)
  runtime.updateWindow(candidate.accountId, { vmId: candidate.vmId, overloadUntil: Date.now() - 1 })
  assert.equal(pool.reserve({ ...candidate, keyScope: { group_type: 'anthropic', allowed_vms: [] } }), null)
  const lease = pool.reserve(candidate)
  assert(lease)
  lease.release()
})

test('expired health cannot grant a queued stale candidate', async (t) => {
  const { pool } = fixture(t)
  const candidate = (await pool.eligibleCandidates(options))[0]
  pool.healthCache.get(candidate.vmId).at = Date.now() - 60000
  assert.equal(pool.reserve(candidate), null)
  const fresh = (await pool.eligibleCandidates(options))[0]
  const lease = pool.reserve(fresh)
  assert(lease)
  lease.release()
})

test('capacity and RPM are checked on the fresh admission snapshot', async (t) => {
  const { pool, quota } = fixture(t, { concurrency: 2 })
  const candidate = (await pool.eligibleCandidates(options))[0]
  const grants = Array.from({ length: 10 }, () => pool.reserve(candidate))
  assert.equal(grants.filter(Boolean).length, 2)
  grants.forEach((lease) => lease?.release())
  const account = quota.repo.get(candidate.accountId)
  account.max_rpm = 2
  account.rpm_override = 1
  quota.repo.save(account)
  assert.equal(pool.reserve(candidate), null, 'releasing concurrency must not reset RPM')
  assert.equal(pool.inflight.size, 0)
})

test('capacity queue time is separate and cancellation frees its ticket', async (t) => {
  const { pool } = fixture(t, { concurrency: 1 })
  const held = await pool.selectAndReserve({ ...options, seatKey: 'seat:sess:queue' })
  const queued = pool.selectAndReserve({ ...options, allowWait: true, seatKey: 'seat:sess:queue' })
  await delay(60)
  held.release()
  const granted = await queued
  assert(granted.ok)
  assert.equal(granted.selectionReason, 'queued')
  assert(granted.queueWaitMs >= 30)
  assert.equal(granted.waitMs, granted.queueWaitMs + granted.schedulingMs)
  const controller = new AbortController()
  const cancelled = pool.selectAndReserve({
    ...options,
    allowWait: true,
    seatKey: 'seat:sess:queue',
    signal: controller.signal,
  })
  await delay(20)
  controller.abort()
  await assert.rejects(cancelled, { code: 'selection_cancelled' })
  granted.release()
  assert.equal(pool.queuedTotal(), 0)
  assert.equal(pool.inflight.size, 0)
})

async function queueRequest(pool, args) {
  const before = pool.queuedTotal()
  const entered = new Promise((resolve) => {
    const listener = () => {
      if (pool.queuedTotal() <= before) return
      pool.off('change', listener)
      resolve()
    }
    pool.on('change', listener)
  })
  const result = pool.selectAndReserve({ ...options, excluded: new Set(['fast-account-2']), allowWait: true, ...args })
  await Promise.race([entered, result.then(() => assert.fail('request did not queue'))])
  return { result }
}

for (const seatKey of [null, 'seat:sess:handoff']) {
  test(`${seatKey ? 'seat' : 'direct'} handoff owns capacity before wake and recycles a cancelled grant`, async (t) => {
    const { pool, quota } = fixture(t, { concurrency: 1 })
    const args = { ...options, excluded: new Set(['fast-account-2']), seatKey }
    const held = await pool.selectAndReserve(args)
    assert(held.ok)
    const controller = new AbortController()
    const cancelled = await queueRequest(pool, { seatKey, signal: controller.signal })
    const next = await queueRequest(pool, { seatKey })
    const rejected = assert.rejects(cancelled.result, { code: 'selection_cancelled' })
    held.release()
    assert.equal(pool.inflight.get(held.accountId), 1, 'release synchronously transfers the permit')
    assert.equal(quota.inflight.get(held.accountId), 1)
    assert.equal(pool.queuedTotal(), 1)
    const newcomer = pool.selectAndReserve(args)
    controller.abort()
    await rejected
    const granted = await next.result
    assert(granted.ok)
    assert.equal((await newcomer).ok, false)
    granted.release()
    assert.equal(pool.inflight.size, 0)
    assert.equal(quota.inflight.get(held.accountId), 0)
    assert.equal(pool.queuedTotal(), 0)
  })
}

test('direct handoff skips an expired waiter and does not dispatch into a new cooldown', async (t) => {
  const { pool, runtime } = fixture(t, { concurrency: 1 })
  const held = await pool.selectAndReserve(options)
  assert.equal(held.accountId, 'fast-account-1')
  const deadline = Date.now() + 500
  const expired = await queueRequest(pool, { deadline })
  const waiting = await queueRequest(pool, {})
  runtime.updateWindow(held.accountId, { vmId: held.vmId, overloadUntil: Date.now() + 60000 })
  held.release()
  assert.equal(pool.inflight.size, 0)
  runtime.updateWindow(held.accountId, { vmId: held.vmId, overloadUntil: Date.now() - 1 })
  const now = Date.now
  Date.now = () => deadline + 1
  try {
    pool.notifyCapacity()
    assert.equal(pool.inflight.get(held.accountId), 1, 'threshold lift grants without another release')
  } finally {
    Date.now = now
  }
  assert.equal((await expired.result).ok, false)
  const granted = await waiting.result
  assert(granted.ok)
  granted.release()
})

test('a direct queue refresh cannot restart the shorter lane timeout', async (t) => {
  const { pool } = fixture(t, { concurrency: 1 })
  t.mock.timers.enable({ apis: ['Date'] })
  const start = Date.now()
  const held = await pool.selectAndReserve({ ...options, excluded: new Set(['fast-account-2']) })
  const waiting = await queueRequest(pool, { deadline: start + 10_000 })
  const requeued = new Promise((resolve) => {
    const listener = () => {
      if (pool.queuedTotal() !== 1) return
      pool.off('change', listener)
      resolve()
    }
    pool.on('change', listener)
  })
  t.mock.timers.setTime(start + 600)
  pool.notifyCapacity()
  await requeued
  t.mock.timers.setTime(start + 1001)
  held.release()
  assert.equal(pool.inflight.size, 0)
  assert.equal((await waiting.result).ok, false)
})

test('maintenance grants a queued request after cooldown without another release', async (t) => {
  const { pool, runtime } = fixture(t, { concurrency: 1 })
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  pool.config.fallback_wait_timeout_ms = 4000
  const held = await pool.selectAndReserve(options)
  const waiting = await queueRequest(pool, {})
  runtime.updateWindow(held.accountId, { vmId: held.vmId, overloadUntil: Date.now() + 1000 })
  held.release()
  assert.equal(pool.inflight.size, 0)
  assert.equal(pool.queuedTotal(), 1)
  t.mock.timers.tick(2000)
  const granted = await waiting.result
  assert(granted.ok)
  assert.equal(granted.accountId, held.accountId)
  granted.release()
})

test('failed device affinity setup does not strand a seat request permit', async (t) => {
  const { pool, quota } = fixture(t, { concurrency: 1 })
  const accountId = 'fast-account-1'
  const args = { ...options, excluded: new Set(['fast-account-2']), seatKey: 'seat:sess:setup' }
  const binding = t.mock.method(pool, 'rememberMachine', () => {
    throw new Error('affinity write failed')
  })
  await assert.rejects(pool.selectAndReserve(args), /affinity write failed/)
  binding.mock.restore()
  assert.equal(pool.inflight.size, 0)
  assert.equal(quota.inflight.get(accountId), 0)
  const next = await pool.selectAndReserve(args)
  assert(next.ok)
  next.release()
})

test('late heartbeat and generic runtime updates cannot overwrite newer health or cooldowns', async (t) => {
  const { pool, runtime } = fixture(t)
  const exec = { vmId: 'vm-01', accountId: 'fast-account-1' }
  runtime.upsert({
    account_id: exec.accountId,
    vm_id: exec.vmId,
    status: 'disabled',
    cooldown_reason: 'operator_disabled',
  })
  await pool.getWorkerHealth(exec)
  await pool.flushHealthWrites()
  const first = runtime.get(exec.accountId)
  assert.equal(first.status, 'disabled')
  runtime.upsert({ ...first, worker_heartbeat_at: first.worker_heartbeat_at - 1, worker_status: { ok: false } })
  const after = runtime.get(exec.accountId)
  assert.equal(after.worker_status.ok, true)
  assert.equal(after.cooldown_reason, 'operator_disabled')
})

test('timing migration persists new measurements and does not invent historical queue times', (t) => {
  const { db } = fixture(t)
  const repo = new RequestAttemptsRepo(db)
  const current = repo.begin({ requestId: 'new', attemptNo: 1, waitMs: 250, queueWaitMs: 0, schedulingMs: 250 })
  assert.equal(current.queue_wait_ms, 0)
  assert.equal(current.scheduling_ms, 250)
  const historical = repo.begin({ requestId: 'old', attemptNo: 1, waitMs: 5500 })
  assert.equal(historical.queue_wait_ms, null)
  assert.equal(historical.scheduling_ms, null)
})

test('database errors do not reuse a prior candidate snapshot', async (t) => {
  const { pool, runtime } = fixture(t)
  const held = await pool.selectAndReserve({ ...options, seatKey: 'seat:sess:db-error' })
  runtime.schedulingSnapshot = () => {
    throw Error('synthetic database failure')
  }
  await assert.rejects(
    pool.selectAndReserve({ ...options, seatKey: 'seat:sess:db-error' }),
    /synthetic database failure/,
  )
  held.release()
  assert.equal(pool.inflight.size, 0)
})

test('missing and disabled account admissions have explicit schedule-state reasons', async () => {
  const { stateOfReason } = await import('../../src/lib/pool/schedule-state.mjs')
  assert.equal(stateOfReason('account_missing').state, 'unschedulable')
  assert.equal(stateOfReason('account_disabled').state, 'unschedulable')
})
