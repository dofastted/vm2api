import test from 'node:test'
import assert from 'node:assert/strict'
import { queueSlotPush, SLOT_PUSH_RETRY_DELAYS_MS } from '../../src/lib/cluster/remote-slot-files.mjs'

function recorder() {
  const events = []
  return { events, logger: { warn: (line) => events.push(JSON.parse(line)) } }
}

const noWait = async () => {}

test('queued slot push retries a transient channel failure and then succeeds', async () => {
  const { events, logger } = recorder()
  let calls = 0
  const push = async () => {
    calls += 1
    if (calls < 3) throw new Error('(SSH) Channel open failure: open failed')
    return { pushed: ['run/kernel.json'] }
  }
  const result = await queueSlotPush({ id: 'retry-ok' }, '/unused', ['run'], { logger, push, wait: noWait })
  assert.deepEqual(result, { pushed: ['run/kernel.json'] })
  assert.equal(calls, 3)
  assert.deepEqual(
    events.map((e) => [e.event, e.attempt]),
    [
      ['remote_slot_push_retry', 1],
      ['remote_slot_push_retry', 2],
    ],
  )
})

test('queued slot push gives up after the configured retries and logs one failure', async () => {
  const { events, logger } = recorder()
  const waits = []
  let calls = 0
  const push = async () => {
    calls += 1
    throw new Error('(SSH) Channel open failure: open failed')
  }
  const result = await queueSlotPush({ id: 'retry-fail' }, '/unused', ['run'], {
    logger,
    push,
    retryDelaysMs: [100, 200],
    wait: async (ms) => waits.push(ms),
  })
  assert.equal(result, undefined)
  assert.equal(calls, 3)
  assert.equal(waits.length, 2)
  assert.ok(waits[0] >= 75 && waits[0] <= 125, `jittered first wait ${waits[0]}`)
  assert.ok(waits[1] >= 150 && waits[1] <= 250, `jittered second wait ${waits[1]}`)
  assert.deepEqual(
    events.map((e) => e.event),
    ['remote_slot_push_retry', 'remote_slot_push_retry', 'remote_slot_push_failed'],
  )
  assert.equal(events.at(-1).vm_id, 'retry-fail')
})

test('a later push for the same VM waits for the retrying one', async () => {
  const { logger } = recorder()
  const order = []
  let firstCalls = 0
  const first = queueSlotPush({ id: 'retry-order' }, '/unused', ['run'], {
    logger,
    wait: noWait,
    push: async () => {
      firstCalls += 1
      order.push(`first-${firstCalls}`)
      if (firstCalls === 1) throw new Error('open failed')
      return { pushed: [] }
    },
  })
  const second = queueSlotPush({ id: 'retry-order' }, '/unused', ['run'], {
    logger,
    wait: noWait,
    push: async () => {
      order.push('second')
      return { pushed: [] }
    },
  })
  await Promise.all([first, second])
  assert.deepEqual(order, ['first-1', 'first-2', 'second'])
})

test('default retry schedule stays short enough for a fire-and-forget push', () => {
  assert.ok(SLOT_PUSH_RETRY_DELAYS_MS.length >= 1)
  assert.ok(SLOT_PUSH_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) <= 30_000)
})
