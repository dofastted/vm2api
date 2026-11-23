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

import { SeatPlanner } from '../../src/lib/pool/seat-planner.mjs'
import {
  createForeignLoad,
  exportLiveLoad,
  startLoadReader,
  startLoadWriter,
} from '../../src/lib/pool/foreign-load.mjs'

function fakeScheduler() {
  const notified = []
  return {
    inflight: new Map(),
    inflightFamily: new Map(),
    vmInflight: new Map(),
    planner: new SeatPlanner(),
    notified,
    notifyCapacity: (id) => notified.push(id),
    signalChange() {},
  }
}

test('the new leader counts the draining peer load and takes it out again', () => {
  const peer = fakeScheduler()
  peer.inflight.set('acct-1', 2)
  peer.inflightFamily.set('acct-1', new Map([['opus', 2]]))
  peer.vmInflight.set('vm-1', 2)
  const peerSeat = peer.planner.open('sess:a', { vmId: 'vm-1', accountId: 'acct-1', cap: 4 })
  peer.planner.hold(peerSeat)
  const quota = { inflight: new Map([['acct-1', 2]]) }
  const snap = exportLiveLoad({ scheduler: peer, accountQuota: quota })

  const me = fakeScheduler()
  me.inflight.set('acct-1', 1)
  const myQuota = { inflight: new Map([['acct-1', 1]]) }
  const foreign = createForeignLoad({ scheduler: me, accountQuota: myQuota })
  foreign.apply(snap)
  assert.equal(me.inflight.get('acct-1'), 3)
  assert.equal(me.inflightFamily.get('acct-1').get('opus'), 2)
  assert.equal(me.vmInflight.get('vm-1'), 2)
  assert.equal(myQuota.inflight.get('acct-1'), 3)
  assert.equal(me.planner.openCount('vm-1'), 1, 'peer seat occupies a slot here')

  // One peer request finished.
  foreign.apply({ ...snap, accounts: { 'acct-1': 1 }, vms: { 'vm-1': 1 }, quota: { 'acct-1': 1 }, families: { 'acct-1': { opus: 1 } } })
  assert.equal(me.inflight.get('acct-1'), 2)
  assert.equal(me.planner.openCount('vm-1'), 1)

  foreign.clear()
  assert.equal(me.inflight.get('acct-1'), 1, 'own load is untouched')
  assert.equal(me.vmInflight.has('vm-1'), false)
  assert.equal(myQuota.inflight.get('acct-1'), 1)
  assert.equal(me.inflightFamily.has('acct-1'), false)
  assert.equal(me.planner.openCount('vm-1'), 0, 'idle ghost seat is freed')
  assert.ok(me.notified.includes('acct-1'))
})

test('a ghost seat the session continued on here is kept when the peer lets go', () => {
  const me = fakeScheduler()
  const foreign = createForeignLoad({ scheduler: me })
  foreign.apply({ seats: [{ seatKey: 'sess:b', vmId: 'vm-2', accountId: 'acct-2', index: 0 }] })
  const seat = me.planner.seatOf('sess:b')
  me.planner.hold(seat)
  foreign.clear()
  assert.equal(me.planner.seatOf('sess:b'), seat)
  assert.equal(me.planner.openCount('vm-2'), 1)
})

test('load file round trip; a stale file counts as no load', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-load-'))
  const file = path.join(dir, 'run', 'handover-load.json')
  let load = { accounts: { a: 3 } }
  const writer = startLoadWriter({ file, read: () => load, intervalMs: 20 })
  const me = fakeScheduler()
  const reader = startLoadReader({ file, foreign: createForeignLoad({ scheduler: me }), intervalMs: 20, staleMs: 200 })
  assert.equal(me.inflight.get('a'), 3)
  load = { accounts: { a: 1 } }
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(me.inflight.get('a'), 1)
  writer.stop()
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(me.inflight.has('a'), false)
  reader.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('reader reports the peer gone once: file removed, heartbeat lost, or never written', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-gone-'))
  const file = path.join(dir, 'run', 'handover-load.json')
  const opts = { foreign: createForeignLoad({ scheduler: fakeScheduler() }), intervalMs: 20, staleMs: 100, goneMs: 300 }
  // Clean exit: the writer removes its file.
  let gone = 0
  const writer = startLoadWriter({ file, read: () => ({}), intervalMs: 20 })
  const r1 = startLoadReader({ ...opts, file, onGone: () => gone++ })
  await sleep(100)
  assert.equal(gone, 0)
  writer.stop()
  await sleep(100)
  assert.equal(gone, 1)
  await sleep(100)
  assert.equal(gone, 1)
  r1.stop()
  // Crash: the file stays but stops being refreshed.
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ at: Date.now(), load: {} }))
  let gone2 = 0
  const r2 = startLoadReader({ ...opts, file, onGone: () => gone2++ })
  await sleep(200)
  assert.equal(gone2, 0)
  await sleep(300)
  assert.equal(gone2, 1)
  r2.stop()
  // Never written at all.
  let gone3 = 0
  const r3 = startLoadReader({ ...opts, file: path.join(dir, 'none.json'), onGone: () => gone3++ })
  await sleep(150)
  assert.equal(gone3, 0)
  await sleep(300)
  assert.equal(gone3, 1)
  r3.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

import { ClusterManager } from '../../src/lib/cluster/cluster-manager.mjs'

test('standby pre-dials node links and activation adopts them instead of dialling again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-prewarm-'))
  const repo = {
    list: () => [{ id: 'n1' }],
    get: () => null,
    getSecrets: () => null,
    directLinks: () => new Map(),
  }
  const states = []
  const manager = new ClusterManager({
    repo,
    dataDir: dir,
    vmsOnNode: () => [],
    logger: { log: (line) => states.push(line), warn() {} },
  })
  manager.prewarmLinks()
  const warm = manager.prewarmed.get('n1')
  assert.ok(warm, 'link dialled during standby')
  assert.notEqual(warm.state, 'idle')
  assert.equal(manager.links.size, 0, 'standby attaches nothing')
  assert.equal(manager.bridges.size, 0, 'standby binds no relay sockets')
  manager.prewarmLinks()
  assert.equal(manager.prewarmed.get('n1'), warm, 'idempotent')
  const early = await manager.prewarmReady({ timeoutMs: 50, pollMs: 10 })
  assert.deepEqual(early, { ready: 0, total: 1 }, 'an unreachable node is reported, not waited on forever')
  manager.start()
  assert.equal(manager.links.get('n1'), warm, 'activation adopts the pre-dialled link')
  assert.equal(manager.prewarmed.size, 0)
  assert.ok(states.some((l) => l.includes('"node":"n1"')), 'adopted link state is replayed')
  await manager.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})
