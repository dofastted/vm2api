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
    const id = `vm-0${n}`
    const accountId = `fast-account-${n}`
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
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { db, root, quota, runtime, pool, probes, sql }
}

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

test('missing and disabled account admissions have explicit schedule-state reasons', async () => {
  const { stateOfReason } = await import('../../src/lib/pool/schedule-state.mjs')
  assert.equal(stateOfReason('account_missing').state, 'unschedulable')
  assert.equal(stateOfReason('account_disabled').state, 'unschedulable')
})

test('M3 cutover (D4): PoolScheduler no longer holds local reserve/wait-queue state', () => {
  assert.equal(typeof PoolScheduler.prototype.eligibleCandidates, 'undefined')
  assert.equal(typeof PoolScheduler.prototype.reserve, 'undefined')
  assert.equal(typeof PoolScheduler.prototype.rememberMachine, 'undefined')
})
