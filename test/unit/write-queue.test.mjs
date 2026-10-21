import test from 'node:test'
import assert from 'node:assert/strict'
import { WriteQueue } from '../../src/lib/pool/write-queue.mjs'

test('flush waits for ordered writes even when the first write is delayed', async () => {
  const queue = new WriteQueue()
  const writes = []
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  queue.enqueue(async () => {
    await gate
    writes.push('first')
  })
  queue.enqueue(() => writes.push('second'))
  const flushed = queue.flush()
  await Promise.resolve()
  assert.deepEqual(writes, [])
  release()
  await flushed
  assert.deepEqual(writes, ['first', 'second'])
})

test('failed persistence is reported by flush and later writes cannot report success', async () => {
  const queue = new WriteQueue()
  const failure = Object.assign(new Error('synthetic persistence failure'), { code: 'test_failure' })
  let wroteAfterFailure = false
  queue.enqueue(() => {
    throw failure
  })
  queue.enqueue(() => {
    wroteAfterFailure = true
  })
  await assert.rejects(queue.flush(), (error) => error === failure)
  assert.equal(wroteAfterFailure, false)
  await assert.rejects(queue.flush(), (error) => error === failure)
})
