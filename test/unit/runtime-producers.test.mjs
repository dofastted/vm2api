import test from 'node:test'
import assert from 'node:assert/strict'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import { SchedulingRuntime } from '../../src/lib/pool/scheduling-runtime.mjs'
import { getDb } from '../../src/lib/db/database.mjs'

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('worker health acquires its observation ticket before remote I/O', async () => {
  const events = []
  let persisted
  const pool = new PoolScheduler({
    projectRoot: '/tmp/vm2api-648-runtime-producer',
    workerHealth: async () => {
      events.push('health')
      return { ok: true, credential: { generation: 1 } }
    },
    runtimeRepo: {
      beginObservation: async () => {
        events.push('ticket')
        return 41
      },
      get: () => null,
      upsert: (patch, options) => {
        persisted = { patch, options }
      },
    },
  })
  await pool.getWorkerHealth({ vmId: 'vm-health', accountId: 'account-health' })
  assert.deepEqual(events, ['ticket', 'health'])
  assert.equal(persisted.options?.observation, 41)
})

test('request success cannot restore the worker snapshot captured before a newer heartbeat', async () => {
  const runtime = await new SchedulingRuntime(getDb()).init()
  runtime.upsert({ account_id: 'account-success', vm_id: 'vm-success', worker_status: { generation: 1 } })
  await runtime.flush()
  const selected = { accountId: 'account-success', vmId: 'vm-success', state: runtime.get('account-success') }
  runtime.upsert({ account_id: 'account-success', worker_status: { generation: 2 } })
  await runtime.flush()
  const pool = new PoolScheduler({ projectRoot: '/tmp/vm2api-648-runtime-producer', runtimeRepo: runtime })
  pool.markSuccess(selected)
  await runtime.flush()
  assert.equal((await runtime.persistence.get('account-success')).worker_status.generation, 2)
})

test('runtime observation tickets retain local invocation order while allocation is delayed', async () => {
  const runtime = new SchedulingRuntime(getDb())
  const first = deferred()
  let calls = 0
  runtime.persistence.beginObservation = () => {
    calls++
    return calls === 1 ? first.promise : Promise.resolve(2)
  }
  const a = runtime.beginObservation()
  const b = runtime.beginObservation()
  await Promise.resolve()
  assert.equal(calls, 1)
  first.resolve(1)
  assert.deepEqual(await Promise.all([a, b]), [1, 2])
})
