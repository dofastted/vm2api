import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  deferUntilExclusive,
  deferredKeys,
  handoverRole,
  isOverlap,
  markExclusive,
  resetHandoverForTests,
  setHandoverRole,
  setOverlap,
} from '../../src/lib/core/handover.mjs'
import { SocketRelay } from '../../src/lib/cluster/socket-relay.mjs'

test('without a draining peer, deferred work runs at once', () => {
  resetHandoverForTests()
  let ran = 0
  assert.equal(
    deferUntilExclusive('egress:a', () => ++ran),
    1,
  )
  assert.deepEqual(deferredKeys(), [])
})

test('during overlap work waits, coalesces per key and runs once the peer has gone', async () => {
  resetHandoverForTests()
  setOverlap(true)
  const calls = []
  deferUntilExclusive('egress:a', () => calls.push('a1'))
  deferUntilExclusive('egress:a', () => calls.push('a2'))
  deferUntilExclusive('gate:n1', async () => calls.push('n1'))
  assert.deepEqual(calls, [])
  assert.deepEqual(deferredKeys(), ['egress:a', 'gate:n1'])
  const done = await markExclusive({ logger: { warn() {} } })
  assert.equal(isOverlap(), false)
  assert.deepEqual(calls, ['a2', 'n1'])
  assert.deepEqual(done, ['egress:a', 'gate:n1'])
  assert.deepEqual(await markExclusive(), [])
})

test('a failing deferred job does not stop the others', async () => {
  resetHandoverForTests()
  setOverlap(true)
  const calls = []
  deferUntilExclusive('x', () => {
    throw new Error('boom')
  })
  deferUntilExclusive('y', () => calls.push('y'))
  const done = await markExclusive({ logger: { warn() {} } })
  assert.deepEqual(done, ['y'])
  assert.deepEqual(calls, ['y'])
})

test('role defaults to leader and is settable', () => {
  resetHandoverForTests()
  assert.equal(handoverRole(), 'leader')
  setHandoverRole('draining')
  assert.equal(handoverRole(), 'draining')
  resetHandoverForTests()
})

test('a handed-over relay leaves the socket path to the new leader', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-relay-'))
  const socketPath = path.join(dir, 'kernel.sock')
  const mk = () => new SocketRelay({ socketPath, remotePath: '/x', getClient: () => null, logger: { warn() {} } })
  const oldRelay = mk()
  await oldRelay.start()
  // The new leader re-binds the same path while the old one is still alive.
  const newRelay = mk()
  await newRelay.start()
  const inode = fs.statSync(socketPath).ino
  await oldRelay.stop({ unlink: false })
  assert.equal(fs.statSync(socketPath).ino, inode, 'new leader socket must survive the old relay stopping')
  await newRelay.stop()
  assert.equal(fs.existsSync(socketPath), false)
  fs.rmSync(dir, { recursive: true, force: true })
})
