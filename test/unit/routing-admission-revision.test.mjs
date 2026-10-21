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
