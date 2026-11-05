import assert from 'node:assert/strict'
import EventEmitter from 'node:events'
import test from 'node:test'
import { createGracefulShutdown } from '../../src/lib/http/graceful-shutdown.mjs'

class FakeResponse extends EventEmitter {
  constructor() {
    super()
    this.destroyed = false
  }
  destroy() {
    this.destroyed = true
    this.emit('close')
  }
  end() {
    this.emit('finish')
  }
}

class FakeServer extends EventEmitter {
  constructor() {
    super()
    this.closed = false
    this.allConnectionsClosed = false
  }
  close(cb) {
    this.closed = true
    cb?.()
  }
  closeAllConnections() {
    this.allConnectionsClosed = true
  }
}

test('createGracefulShutdown: tracks in-flight requests and decrements on finish or close', () => {
  const gs = createGracefulShutdown({ exit: () => {} })
  assert.equal(gs.isShuttingDown(), false)
  assert.equal(gs.getActiveCount(), 0)

  const res1 = new FakeResponse()
  const res2 = new FakeResponse()

  assert.equal(gs.trackRequest({}, res1), true)
  assert.equal(gs.trackRequest({}, res2), true)
  assert.equal(gs.getActiveCount(), 2)

  res1.end()
  assert.equal(gs.getActiveCount(), 1)

  res2.destroy()
  assert.equal(gs.getActiveCount(), 0)
})

test('createGracefulShutdown: waits for in-flight requests to drain before calling afterDrain and exit', async () => {
  const server = new FakeServer()
  const events = []
  let exitCode = null

  const gs = createGracefulShutdown({
    server,
    drainTimeoutMs: 1000,
    beforeDrain: async () => {
      events.push('beforeDrain')
    },
    afterDrain: async () => {
      events.push('afterDrain')
    },
    exit: (code) => {
      exitCode = code
      events.push('exit')
    },
    logger: { log() {}, warn() {} },
  })

  const res = new FakeResponse()
  gs.trackRequest({}, res)
  assert.equal(gs.getActiveCount(), 1)

  const shutdownPromise = gs.shutdown('SIGTERM')
  assert.equal(gs.isShuttingDown(), true)
  assert.equal(server.closed, true)
  assert.deepEqual(events, ['beforeDrain'])

  // Requests after shutdown started are rejected
  const resLate = new FakeResponse()
  assert.equal(gs.trackRequest({}, resLate), false)

  // In-flight request finishes
  res.end()

  await shutdownPromise
  assert.equal(exitCode, 0)
  assert.deepEqual(events, ['beforeDrain', 'afterDrain', 'exit'])
})

test('createGracefulShutdown: times out and force-closes remaining requests if drain takes too long', async () => {
  const server = new FakeServer()
  const events = []
  let exitCode = null

  const gs = createGracefulShutdown({
    server,
    drainTimeoutMs: 50,
    beforeDrain: async () => {
      events.push('beforeDrain')
    },
    afterDrain: async () => {
      events.push('afterDrain')
    },
    exit: (code) => {
      exitCode = code
      events.push('exit')
    },
    logger: { log() {}, warn() {} },
  })

  const res = new FakeResponse()
  gs.trackRequest({}, res)
  assert.equal(gs.getActiveCount(), 1)

  // Start shutdown without finishing res
  await gs.shutdown('SIGINT')

  assert.equal(res.destroyed, true)
  assert.equal(server.allConnectionsClosed, true)
  assert.equal(exitCode, 0)
  assert.deepEqual(events, ['beforeDrain', 'afterDrain', 'exit'])
})

test('createGracefulShutdown: shutdown is idempotent', async () => {
  let beforeDrainCount = 0
  let afterDrainCount = 0

  const gs = createGracefulShutdown({
    drainTimeoutMs: 50,
    beforeDrain: async () => {
      beforeDrainCount++
    },
    afterDrain: async () => {
      afterDrainCount++
    },
    exit: () => {},
    logger: { log() {}, warn() {} },
  })

  const p1 = gs.shutdown('SIGTERM')
  const p2 = gs.shutdown('SIGINT')
  assert.equal(p1, p2)
  await p1

  assert.equal(beforeDrainCount, 1)
  assert.equal(afterDrainCount, 1)
})
