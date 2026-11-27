import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  VSOCK_CID_MAX,
  VSOCK_CID_MIN,
  allocateCid,
  attachCidOwnerPid,
  claimExistingCid,
  defaultVsockLeaseFile,
  getCidLease,
  reconcileStaleCids,
  releaseCid,
} from '../../src/lib/vm/kvm-vsock-cid.mjs'

function makeTempLease(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vsock-cid-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return {
    dir,
    leaseFile: defaultVsockLeaseFile(dir),
  }
}

test('allocateCid assigns unique sequential host-global CIDs starting at 1000', (t) => {
  const { leaseFile } = makeTempLease(t)
  const live = new Set([101, 102, 103])
  const isPidAlive = (pid) => live.has(pid)

  const a = allocateCid('vm-01', { leaseFile, ownerPid: 101, isPidAlive })
  const b = allocateCid('vm-02', { leaseFile, ownerPid: 102, isPidAlive })
  const c = allocateCid('vm-03', { leaseFile, ownerPid: 103, isPidAlive })

  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(c.ok, true)
  assert.equal(a.cid, VSOCK_CID_MIN)
  assert.equal(b.cid, VSOCK_CID_MIN + 1)
  assert.equal(c.cid, VSOCK_CID_MIN + 2)
  assert.equal(VSOCK_CID_MIN, 1000)
  assert.equal(VSOCK_CID_MAX, 65535)
  assert.equal(a.reused, false)

  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(leaseFile).mode & 0o777, 0o600)
  }

  // Re-allocating the same VM with the same PID is idempotent.
  const aAgain = allocateCid('vm-01', { leaseFile, ownerPid: 101, isPidAlive })
  assert.equal(aAgain.ok, true)
  assert.equal(aAgain.reused, true)
  assert.equal(aAgain.cid, a.cid)
})

test('allocateCid refuses to steal an existing VM CID while its owner PID is alive', (t) => {
  const { leaseFile } = makeTempLease(t)
  const live = new Set([201])
  const isPidAlive = (pid) => live.has(pid)

  const first = allocateCid('vm-01', { leaseFile, ownerPid: 201, isPidAlive })
  assert.equal(first.ok, true)

  const blocked = allocateCid('vm-01', { leaseFile, ownerPid: 202, isPidAlive })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'vsock_cid_owner_alive')
  assert.equal(blocked.cid, first.cid)
  assert.equal(blocked.ownerPid, 201)

  // Once PID 201 exits, the same VM can attach the new owner PID while keeping its CID.
  live.delete(201)
  live.add(202)
  const reclaimed = allocateCid('vm-01', { leaseFile, ownerPid: 202, isPidAlive })
  assert.equal(reclaimed.ok, true)
  assert.equal(reclaimed.reused, true)
  assert.equal(reclaimed.cid, first.cid)
  assert.equal(reclaimed.ownerPid, 202)
})

test('releaseCid refuses while owner PID is alive and succeeds once exited', (t) => {
  const { leaseFile } = makeTempLease(t)
  const live = new Set([301])
  const isPidAlive = (pid) => live.has(pid)

  const alloc = allocateCid('vm-01', { leaseFile, ownerPid: 301, isPidAlive })
  assert.equal(alloc.ok, true)

  const denied = releaseCid('vm-01', { leaseFile, isPidAlive })
  assert.equal(denied.ok, false)
  assert.equal(denied.released, false)
  assert.equal(denied.code, 'vsock_cid_owner_alive')
  assert.equal(getCidLease('vm-01', { leaseFile })?.cid, alloc.cid)

  live.delete(301)
  const released = releaseCid('vm-01', { leaseFile, isPidAlive })
  assert.equal(released.ok, true)
  assert.equal(released.released, true)
  assert.equal(released.cid, alloc.cid)
  assert.equal(getCidLease('vm-01', { leaseFile }), null)

  // Releasing an already-absent lease is a safe no-op.
  const absent = releaseCid('vm-01', { leaseFile, isPidAlive })
  assert.equal(absent.ok, true)
  assert.equal(absent.released, false)
  assert.equal(absent.reason, 'not_found')
})

test('reconcileStaleCids reclaims ONLY leases whose owner PID is confirmed exited', (t) => {
  const { leaseFile } = makeTempLease(t)
  const live = new Set([401, 402])
  const isPidAlive = (pid) => live.has(pid)

  const a = allocateCid('vm-alive', { leaseFile, ownerPid: 401, isPidAlive })
  const b = allocateCid('vm-exited', { leaseFile, ownerPid: 402, isPidAlive })
  const c = allocateCid('vm-pending-pid', { leaseFile, ownerPid: null, isPidAlive })
  assert.equal(a.ok && b.ok && c.ok, true)

  live.delete(402)
  const rec = reconcileStaleCids({ leaseFile, isPidAlive })
  assert.equal(rec.ok, true)
  assert.deepEqual(rec.removed, [{ vmId: 'vm-exited', cid: b.cid, ownerPid: 402 }])
  assert.deepEqual(rec.remaining.map((r) => r.vmId).sort(), ['vm-alive', 'vm-pending-pid'])
  assert.equal(getCidLease('vm-exited', { leaseFile }), null)
  assert.equal(getCidLease('vm-alive', { leaseFile })?.cid, a.cid)
  assert.equal(getCidLease('vm-pending-pid', { leaseFile })?.cid, c.cid)
})

test('attachCidOwnerPid records container PID and prevents premature reclaim', (t) => {
  const { leaseFile } = makeTempLease(t)
  const live = new Set([555])
  const isPidAlive = (pid) => live.has(pid)

  const missing = attachCidOwnerPid('vm-missing', 555, { leaseFile })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'vsock_cid_not_found')

  const alloc = allocateCid('vm-01', { leaseFile })
  assert.equal(alloc.ok, true)
  assert.equal(alloc.ownerPid, null)

  const attached = attachCidOwnerPid('vm-01', 555, { leaseFile })
  assert.equal(attached.ok, true)
  assert.equal(attached.cid, alloc.cid)
  assert.equal(attached.ownerPid, 555)

  const denied = releaseCid('vm-01', { leaseFile, isPidAlive })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'vsock_cid_owner_alive')

  // Next allocation reclaims stale exited leases automatically without touching live ones.
  live.delete(555)
  const next = allocateCid('vm-02', { leaseFile, ownerPid: 556, isPidAlive: (p) => p === 556 })
  assert.equal(next.ok, true)
  assert.equal(getCidLease('vm-01', { leaseFile }), null)
  assert.equal(getCidLease('vm-02', { leaseFile })?.cid, next.cid)
})

test('claimExistingCid restores a stopped container CID lease or reports conflict when another live slot holds it', (t) => {
  const { leaseFile } = makeTempLease(t)
  const live = new Set([601])
  const isPidAlive = (pid) => live.has(pid)

  const a = allocateCid('vm-01', { leaseFile, ownerPid: 601, isPidAlive })
  assert.equal(a.ok, true)

  // vm-01 stops and another allocation sweeps its exited lease.
  live.delete(601)
  live.add(602)
  const b = allocateCid('vm-02', { leaseFile, ownerPid: 602, isPidAlive })
  assert.equal(b.ok, true)
  assert.notEqual(b.cid, a.cid)
  assert.equal(getCidLease('vm-01', { leaseFile }), null)

  // Case 1: vm-01 restarts with its baked CID still free -> lease restored and re-bound to new PID.
  const restored = claimExistingCid('vm-01', a.cid, { leaseFile, isPidAlive })
  assert.equal(restored.ok, true)
  assert.equal(restored.restored, true)
  assert.equal(restored.cid, a.cid)
  assert.equal(getCidLease('vm-01', { leaseFile })?.cid, a.cid)

  live.add(603)
  const rebound = claimExistingCid('vm-01', a.cid, { leaseFile, ownerPid: 603, isPidAlive })
  assert.equal(rebound.ok, true)
  assert.equal(rebound.restored, false)
  assert.equal(rebound.ownerPid, 603)
  assert.equal(getCidLease('vm-01', { leaseFile })?.owner_pid, 603)

  // Case 2: another VM tries to claim a CID held by live vm-02 -> fails closed with vsock_cid_conflict.
  const conflict = claimExistingCid('vm-03', b.cid, { leaseFile, isPidAlive })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, 'vsock_cid_conflict')
  assert.equal(conflict.conflictVmId, 'vm-02')
  assert.equal(conflict.conflictOwnerPid, 602)

  // Once vm-02 exits, vm-03 can cleanly reclaim that CID.
  live.delete(602)
  const reclaimed = claimExistingCid('vm-03', b.cid, { leaseFile, ownerPid: 604, isPidAlive: (p) => p === 604 })
  assert.equal(reclaimed.ok, true)
  assert.equal(reclaimed.cid, b.cid)
  assert.equal(getCidLease('vm-02', { leaseFile }), null)
  assert.equal(getCidLease('vm-03', { leaseFile })?.owner_pid, 604)
})
