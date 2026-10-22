import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { readRawBody } from '../../src/lib/http/respond.mjs'
import { controlPlaneMode, shutdownTimeoutMs } from '../../src/lib/core/control-plane-mode.mjs'
import { ControlPlaneLifecycle, withTimeout } from '../../src/lib/core/control-plane-lifecycle.mjs'

test('Kubernetes mode is explicit and shutdown timeout accepts positive integer milliseconds', () => {
  assert.equal(controlPlaneMode({}), 'standalone')
  assert.equal(controlPlaneMode({ VM2API_CONTROL_PLANE_MODE: 'kubernetes' }), 'kubernetes')
  assert.throws(() => controlPlaneMode({ VM2API_CONTROL_PLANE_MODE: 'kubernete' }), /CONTROL_PLANE_MODE/)
  assert.equal(shutdownTimeoutMs({}), 60_000)
  assert.equal(shutdownTimeoutMs({ VM2API_SHUTDOWN_TIMEOUT_MS: '300' }), 300)
  assert.throws(() => shutdownTimeoutMs({ VM2API_SHUTDOWN_TIMEOUT_MS: '-1' }), /SHUTDOWN_TIMEOUT_MS/)
})

test('readiness requires initialization, database, control lock, and no maintenance or drain', async () => {
  let database = true
  let locked = true
  let maintaining = false
  const lifecycle = new ControlPlaneLifecycle({
    probe: async () => {
      if (!database) throw new Error('private connection details')
    },
    lockHealthy: () => locked,
    isMaintaining: () => maintaining,
  })
  assert.equal(await lifecycle.isReady(), false)
  lifecycle.markReady()
  assert.equal(await lifecycle.isReady(), true)
  maintaining = true
  assert.equal(await lifecycle.isReady(), false)
  maintaining = false
  locked = false
  assert.equal(await lifecycle.isReady(), false)
  locked = true
  database = false
  assert.equal(await lifecycle.isReady(), false)
  database = true
  lifecycle.beginDrain()
  assert.equal(await lifecycle.isReady(), false)
})

test('HTTP drain waits for both the handler and the response to finish', async () => {
  const lifecycle = new ControlPlaneLifecycle()
  const req = new EventEmitter()
  const res = new EventEmitter()
  const handlerFinished = lifecycle.trackHttp(req, res)
  let drained = false
  const pending = lifecycle.waitForIdle().then(() => {
    drained = true
  })
  handlerFinished()
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(drained, false, 'a returned SSE handler still owns its open response')
  res.emit('finish')
  await pending
  assert.equal(drained, true)
})

test('readiness and draining waits have bounded deadlines', async () => {
  const lifecycle = new ControlPlaneLifecycle({ probe: () => new Promise(() => {}), probeTimeoutMs: 20 })
  lifecycle.markReady()
  assert.equal(await lifecycle.isReady(), false)
  await assert.rejects(withTimeout(new Promise(() => {}), 20), { code: 'shutdown_timeout' })
})

test('forced shutdown rejects an unfinished body before closing its response', async () => {
  const lifecycle = new ControlPlaneLifecycle()
  const req = new PassThrough()
  const res = new EventEmitter()
  res.destroy = () => {
    req.destroy()
    res.emit('close')
  }
  const handlerFinished = lifecycle.trackHttp(req, res)
  const body = readRawBody(req, 100).finally(handlerFinished)
  req.write('{')
  lifecycle.forceClose()
  await assert.rejects(withTimeout(body, 30), (error) => {
    assert.equal(error.body?.error?.code, 'request_stream_error')
    return true
  })
  await lifecycle.waitForIdle()
})
