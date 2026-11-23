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
  foreign.apply({
    ...snap,
    accounts: { 'acct-1': 1 },
    vms: { 'vm-1': 1 },
    quota: { 'acct-1': 1 },
    families: { 'acct-1': { opus: 1 } },
  })
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

test('load file round trip; a removed file counts as no load, a stale one keeps its snapshot and is logged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-load-'))
  const file = path.join(dir, 'run', 'handover-load.json')
  let load = { accounts: { a: 3 } }
  const writer = startLoadWriter({ file, read: () => load, intervalMs: 20 })
  const me = fakeScheduler()
  const lines = []
  const logger = { log: (line) => lines.push(JSON.parse(line).event) }
  const reader = startLoadReader({
    file,
    foreign: createForeignLoad({ scheduler: me }),
    intervalMs: 20,
    staleMs: 200,
    logger,
  })
  assert.equal(me.inflight.get('a'), 3)
  load = { accounts: { a: 1 } }
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(me.inflight.get('a'), 1)
  // The writer stalls: the file stays, ages past staleMs, and its last snapshot is kept.
  writer.stop({ remove: false })
  await new Promise((r) => setTimeout(r, 320))
  assert.equal(me.inflight.get('a'), 1, 'stale snapshot kept')
  assert.deepEqual(lines, ['handover-load-stale'])
  // It recovers.
  const writer2 = startLoadWriter({ file, read: () => load, intervalMs: 20 })
  await new Promise((r) => setTimeout(r, 80))
  assert.deepEqual(lines, ['handover-load-stale', 'handover-load-fresh'])
  // A clean exit removes the file: no load.
  writer2.stop()
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(me.inflight.has('a'), false)
  reader.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a family seat that left home while still streaming is exported and restored off-home', () => {
  const peer = fakeScheduler()
  const away = peer.planner.open('sess:f', { vmId: 'vm-1', accountId: 'acct-1', cap: 4 })
  away.family = true
  peer.planner.hold(away)
  // The session moved to vm-2 while its subagent on vm-1 is still running (#1627).
  peer.planner.leaveHome(away)
  const home = peer.planner.open('sess:f', { vmId: 'vm-2', accountId: 'acct-2', cap: 4 })
  home.family = true
  peer.planner.hold(home)
  assert.equal(peer.planner.seats.get('sess:f'), home)
  const snap = exportLiveLoad({ scheduler: peer })
  assert.deepEqual(snap.seats.map((s) => [s.vmId, s.home, s.family]).sort(), [
    ['vm-1', false, true],
    ['vm-2', true, true],
  ])

  const me = fakeScheduler()
  const foreign = createForeignLoad({ scheduler: me })
  foreign.apply(snap)
  assert.equal(me.planner.openCount('vm-1'), 1, 'off-home seat occupies its cell')
  assert.equal(me.planner.openCount('vm-2'), 1)
  assert.equal(me.planner.seatOf('sess:f').vmId, 'vm-2', 'home stays the peer home')
  // The subagent on vm-1 finishes on the peer: that cell frees, the home stays.
  foreign.apply({ ...snap, seats: snap.seats.filter((s) => s.home) })
  assert.equal(me.planner.openCount('vm-1'), 0)
  assert.equal(me.planner.openCount('vm-2'), 1)
  foreign.clear()
  assert.equal(me.planner.openCount('vm-2'), 0)
})

test('a request the new leader finishes first does not free a seat the peer still streams on', () => {
  const me = fakeScheduler()
  const foreign = createForeignLoad({ scheduler: me })
  const snap = { seats: [{ seatKey: 'sess:c', vmId: 'vm-3', accountId: 'acct-3', index: 0 }] }
  foreign.apply(snap)
  const seat = me.planner.seatOf('sess:c')
  // The same session sends a request to the new leader, which finishes before the peer's.
  me.planner.hold(seat)
  me.planner.release(seat)
  assert.equal(me.planner.seatOf('sess:c'), seat, 'peer hold keeps the seat')
  assert.equal(me.planner.openCount('vm-3'), 1)
  foreign.apply(snap)
  assert.equal(me.planner.openCount('vm-3'), 1)
  foreign.clear()
  assert.equal(me.planner.openCount('vm-3'), 0, 'freed once the peer lets go')
})

test('managed-key concurrency of the draining peer counts here', () => {
  const peerKeys = { inflight: new Map([['key-1', 1]]) }
  const snap = exportLiveLoad({ scheduler: fakeScheduler(), apiKeys: peerKeys })
  assert.deepEqual(snap.keys, { 'key-1': 1 })
  const myKeys = { inflight: new Map([['key-1', 1]]) }
  const foreign = createForeignLoad({ scheduler: fakeScheduler(), apiKeys: myKeys })
  foreign.apply(snap)
  assert.equal(myKeys.inflight.get('key-1'), 2)
  foreign.apply({ ...snap, keys: {} })
  assert.equal(myKeys.inflight.get('key-1'), 1)
  foreign.clear()
  assert.equal(myKeys.inflight.get('key-1'), 1, 'own load is untouched')
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
  assert.ok(
    states.some((l) => l.includes('"node":"n1"')),
    'adopted link state is replayed',
  )
  await manager.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})
