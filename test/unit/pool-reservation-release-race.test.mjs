import test from 'node:test'
import assert from 'node:assert/strict'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import { SchedulerApiError } from '../../src/lib/scheduler/scheduler-runtime.mjs'

function makeCappedRuntime({ vmId = 'race-vm', maxConcurrency = 2, beforeAcquire = null } = {}) {
  let leaseSeq = 0
  const activeLeases = new Map()
  const releasedLeaseIds = []

  return {
    activeLeases,
    releasedLeaseIds,
    async acquireNode(params, { signal } = {}) {
      if (signal?.aborted) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      }
      if (typeof beforeAcquire === 'function') {
        await beforeAcquire(params)
      }
      if (activeLeases.size >= maxConcurrency) {
        throw new SchedulerApiError({
          status: 529,
          code: 'all_accounts_busy',
          message: 'All configured capacity is in flight',
          retryAfterSec: 1,
        })
      }
      const leaseId = `race-lease-${++leaseSeq}`
      activeLeases.set(leaseId, { vmId })
      return {
        lease_id: leaseId,
        lease_ttl_ms: 30_000,
        resolved_pool_id: params.originPoolId || '__virtual_claude__',
        selected_node: {
          node_type: 'claude_vm',
          node_id: vmId,
          node_key: `claude_vm:${vmId}`,
        },
        explain: { affinity: { why: 'balanced' } },
      }
    },
    async releaseLease(leaseId) {
      if (!activeLeases.delete(leaseId)) return { ok: true, released: false }
      releasedLeaseIds.push(leaseId)
      return { ok: true, released: true }
    },
  }
}

for (const timing of ['sync', 'async']) {
  test(`selectAndReserve preserves a ${timing} re-entrant release triggered during acquireNode`, async () => {
    let releaseDuringAcquire = null
    const runtime = makeCappedRuntime({
      vmId: 'race-vm',
      maxConcurrency: 2,
      async beforeAcquire() {
        if (timing === 'async') {
          await new Promise((resolve) => setImmediate(resolve))
        }
        if (releaseDuringAcquire) {
          const release = releaseDuringAcquire
          releaseDuringAcquire = null
          release()
        }
      },
    })
    const scheduler = new PoolScheduler({ schedulerRuntime: runtime })
    const request = { model: 'claude-sonnet-4-5', allowWait: false }

    for (let round = 0; round < 20; round += 1) {
      const first = await scheduler.selectAndReserve(request)
      assert.equal(first.ok, true)
      assert.equal(scheduler.inflight.get('race-vm'), 1)
      assert.equal(scheduler.vmInflight.get('race-vm'), 1)
      assert.equal(runtime.activeLeases.size, 1)

      releaseDuringAcquire = first.release
      const second = await scheduler.selectAndReserve(request)
      assert.equal(second.ok, true)
      assert.equal(scheduler.inflight.get('race-vm'), 1)
      assert.equal(scheduler.vmInflight.get('race-vm'), 1)
      assert.equal(runtime.activeLeases.size, 1)

      const third = await scheduler.selectAndReserve(request)
      assert.equal(third.ok, true, 'released capacity must be reusable')
      assert.equal(scheduler.inflight.get('race-vm'), 2)
      assert.equal(scheduler.vmInflight.get('race-vm'), 2)
      assert.equal(runtime.activeLeases.size, 2)

      const fourth = await scheduler.selectAndReserve(request)
      assert.equal(fourth.ok, false, 'the configured cap must still hold')
      assert.equal(fourth.reason, 'all_accounts_busy')
      assert.equal(scheduler.inflight.get('race-vm'), 2)
      assert.equal(scheduler.vmInflight.get('race-vm'), 2)

      const releasesBefore = runtime.releasedLeaseIds.length
      second.release()
      third.release()
      third.release()
      await new Promise((resolve) => setImmediate(resolve))

      assert.equal(scheduler.inflight.size, 0)
      assert.equal(scheduler.vmInflight.size, 0)
      assert.equal(runtime.activeLeases.size, 0)
      assert.equal(runtime.releasedLeaseIds.length, releasesBefore + 2, 'duplicate release must be idempotent')
    }
  })
}

test('concurrent selectAndReserve bursts enforce capacity and release without leaking inflight gauges', async () => {
  const runtime = makeCappedRuntime({
    vmId: 'burst-vm',
    maxConcurrency: 2,
    async beforeAcquire() {
      await new Promise((resolve) => setImmediate(resolve))
    },
  })
  const scheduler = new PoolScheduler({ schedulerRuntime: runtime })
  const request = { model: 'claude-sonnet-4-5', allowWait: false }

  const results = await Promise.all(Array.from({ length: 6 }, () => scheduler.selectAndReserve(request)))
  const granted = results.filter((r) => r.ok)
  const denied = results.filter((r) => !r.ok)

  assert.equal(granted.length, 2)
  assert.equal(denied.length, 4)
  assert.equal(scheduler.inflight.get('burst-vm'), 2)
  assert.equal(scheduler.vmInflight.get('burst-vm'), 2)
  assert.equal(runtime.activeLeases.size, 2)

  for (const item of granted) {
    item.release()
    item.release()
  }
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(scheduler.inflight.size, 0)
  assert.equal(scheduler.vmInflight.size, 0)
  assert.equal(runtime.activeLeases.size, 0)

  const reused = await scheduler.selectAndReserve(request)
  assert.equal(reused.ok, true)
  reused.release()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(scheduler.inflight.size, 0)
  assert.equal(scheduler.vmInflight.size, 0)
})
