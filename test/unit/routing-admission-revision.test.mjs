import test from 'node:test'
import assert from 'node:assert/strict'
import { getDb } from '../../src/lib/db/database.mjs'
import { ExecutionAdmissionsRepo } from '../../src/lib/db/repos/execution-admissions-repo.mjs'
import { SharedExecutionAdmissions } from '../../src/lib/pool/shared-execution-admissions.mjs'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'

const input = {
  accountId: 'routing-account',
  vmId: 'routing-vm',
  accountLimit: 1,
  vmLimit: 1,
  rpmLimit: 0,
  fableLimit: 0,
}
const stale = () => Object.assign(new Error('routing changed'), { code: 'routing_config_stale' })

test('execution admission rejects an outdated routing revision inside its transaction', async () => {
  const db = getDb()
  const repo = new ExecutionAdmissionsRepo(db, {
    assertRoutingRevision: async (revision) => {
      assert.equal(db.isTransaction, true)
      if (revision !== 7) throw stale()
    },
  })
  await assert.rejects(repo.tryReserve({ ...input, routingRevision: 6 }), { code: 'routing_config_stale' })
  assert.equal((await repo.getCounts(input)).vmInflight, 0)
  const granted = await repo.tryReserve({ ...input, routingRevision: 7 })
  assert.equal(granted.ok, true)
  await granted.release()
})

test('shared device admission checks routing before every resource lock', async () => {
  const events = []
  const db = getDb()
  const admissions = new SharedExecutionAdmissions(db, {
    assertRoutingRevision: async (revision) => {
      assert.equal(db.isTransaction, true)
      assert.equal(revision, 7)
      events.push('revision')
    },
  })
  const lock = admissions.executions.lockResources.bind(admissions.executions)
  admissions.executions.lockResources = async (...args) => {
    events.push('resources')
    return lock(...args)
  }
  const device = admissions.lockDevice.bind(admissions)
  admissions.lockDevice = async (...args) => {
    events.push('device')
    return device(...args)
  }
  const granted = await admissions.tryReserve({
    ...input,
    accountId: 'routing-seat-account',
    vmId: 'routing-seat-vm',
    routingRevision: 7,
    seatKey: 'routing-device',
    seatCap: 2,
    seatGraceMs: 0,
    seatReservePct: 0,
    seatHeadroom: 1,
  })
  assert.equal(granted.ok, true)
  assert.equal(events[0], 'revision')
  assert.ok(events.indexOf('revision') < events.indexOf('device'))
  await granted.release()
})

test('scheduler rejects its old candidate after a routing change and refreshes committed configuration', async () => {
  const previous = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  let refreshed = 0
  const routingState = {
    currentRevision: 8,
    async assertRevision(revision) {
      if (revision !== 8) throw stale()
    },
    async refresh() {
      refreshed++
    },
  }
  let pool
  try {
    pool = new PoolScheduler({ routingState })
  } finally {
    if (previous === undefined) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = previous
  }
  const candidate = {
    accountId: 'routing-pool-account',
    vmId: 'routing-pool-vm',
    routingRevision: 7,
    maxConcurrency: 1,
    vm: { policy: { maxConcurrency: 1 } },
  }
  const lease = await pool.reserveShared(candidate, {})
  if (lease) await lease.release()
  assert.equal(lease, null)
  assert.equal(refreshed, 1)
  assert.equal((await pool.executionAdmissions.getCounts(candidate.accountId, candidate.vmId)).vmInflight, 0)
})

test('configuration writes wait until admission commits its validated revision', async () => {
  const db = getDb()
  await db.prepare("INSERT INTO settings(key,value) VALUES('routing-admission-lock','7')").run()
  let entered
  let resume
  const checked = new Promise((resolve) => {
    entered = resolve
  })
  const hold = new Promise((resolve) => {
    resume = resolve
  })
  const repo = new ExecutionAdmissionsRepo(db, {
    assertRoutingRevision: async (revision) => {
      const row = await db.prepare("SELECT value FROM settings WHERE key='routing-admission-lock' FOR SHARE").get()
      assert.equal(Number(row.value), revision)
      entered()
      await hold
    },
  })
  const pending = repo.tryReserve({
    ...input,
    accountId: 'routing-lock-account',
    vmId: 'routing-lock-vm',
    routingRevision: 7,
  })
  await checked
  const client = await db.pool.connect()
  const changed = client.query("UPDATE settings SET value='8' WHERE key='routing-admission-lock'")
  try {
    let blocked = false
    for (let i = 0; i < 100; i++) {
      const { rows } = await db.query('SELECT cardinality(pg_blocking_pids($1::integer)) AS blockers', [
        client.processID,
      ])
      if (rows[0].blockers > 0) {
        blocked = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(blocked, true, 'the configuration update must wait for the admission transaction')
  } finally {
    resume()
    const lease = await pending
    await changed
    client.release()
    await lease.release()
  }
})

test('current global limits replace stale inherited VM policy while explicit overrides remain', () => {
  const pool = new PoolScheduler({ routingState: { currentRevision: 8 } })
  const candidate = { maxConcurrency: 2, vm: { policy: { maxConcurrency: 9, concurrencyOverride: false } } }
  assert.equal(pool.executionLimits(candidate).vmLimit, 2)
  candidate.vm.policy.concurrencyOverride = true
  assert.equal(pool.executionLimits(candidate).vmLimit, 9)
})
