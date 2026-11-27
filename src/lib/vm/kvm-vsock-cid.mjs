/**
 * Host-global 32-bit virtio-vsock Guest CID allocator (`CID 1000..65535`).
 *
 * Standard Linux has no vsock network namespace, so Guest CIDs must be unique across the
 * entire host. Uses an exclusive lockfile + atomic write/rename lease table and NEVER
 * recycles a CID until the owning QEMU/runner PID is confirmed exited.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const VSOCK_CID_MIN = 1000
export const VSOCK_CID_MAX = 65535
const LOCK_STALE_MS = 30_000
const LOCK_RETRY_ATTEMPTS = 200

export function defaultVsockLeaseFile(projectRoot) {
  if (!projectRoot) throw new Error('projectRoot or leaseFile is required for vsock CID allocator')
  return path.join(projectRoot, 'data', 'run', 'vsock-cids.json')
}

function resolveLeaseFile({ leaseFile, projectRoot } = {}) {
  return leaseFile ? path.resolve(leaseFile) : defaultVsockLeaseFile(projectRoot)
}

export function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

function sleepMsSync(ms) {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

function withExclusiveLock(leaseFile, fn) {
  const dir = path.dirname(leaseFile)
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
  const lockPath = `${leaseFile}.lock`
  let fd = null
  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt += 1) {
    try {
      fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600)
      fs.writeFileSync(fd, `${process.pid}\n${Date.now()}\n`)
      break
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      try {
        const st = fs.statSync(lockPath)
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true })
          continue
        }
      } catch {}
      sleepMsSync(5)
    }
  }
  if (fd == null) {
    throw new Error(`failed to acquire vsock CID lease lock: ${lockPath}`)
  }
  try {
    return fn()
  } finally {
    try {
      fs.closeSync(fd)
    } catch {}
    try {
      fs.rmSync(lockPath, { force: true })
    } catch {}
  }
}

function readLeaseTable(leaseFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(leaseFile, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const leases =
        parsed.leases && typeof parsed.leases === 'object' && !Array.isArray(parsed.leases) ? { ...parsed.leases } : {}
      const nextCid = Number.isInteger(parsed.next_cid)
        ? Math.min(VSOCK_CID_MAX, Math.max(VSOCK_CID_MIN, parsed.next_cid))
        : VSOCK_CID_MIN
      return { schema_version: 1, next_cid: nextCid, leases }
    }
  } catch {}
  return { schema_version: 1, next_cid: VSOCK_CID_MIN, leases: {} }
}

function writeLeaseTableAtomic(leaseFile, table) {
  const dir = path.dirname(leaseFile)
  const tmp = path.join(dir, `.${path.basename(leaseFile)}.tmp.${crypto.randomBytes(6).toString('hex')}`)
  const body = `${JSON.stringify(table, null, 2)}\n`
  let fd = null
  try {
    fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_WRONLY, 0o600)
    fs.writeFileSync(fd, body, 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    if (process.platform !== 'win32') fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, leaseFile)
  } catch (err) {
    if (fd != null) {
      try {
        fs.closeSync(fd)
      } catch {}
    }
    try {
      fs.rmSync(tmp, { force: true })
    } catch {}
    throw err
  }
}

function normalizeOwnerPid(ownerPid) {
  if (ownerPid == null || ownerPid === '') return null
  const n = Number(ownerPid)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid ownerPid: ${ownerPid}`)
  return n
}

function isLeaseConfirmedExited(lease, isPidAlive) {
  if (!lease || typeof lease !== 'object') return true
  if (lease.owner_pid == null) return false
  return !isPidAlive(lease.owner_pid)
}

/**
 * Allocate or return a host-unique 32-bit virtio-vsock Guest CID (`1000..65535`) for `vmId`.
 * Only leases whose `owner_pid` is confirmed exited may be reclaimed for reuse.
 */
export function allocateCid(vmId, { leaseFile, projectRoot, ownerPid = null, isPidAlive = defaultIsPidAlive } = {}) {
  const id = String(vmId || '').trim()
  if (!id) throw new Error('vmId is required for vsock CID allocation')
  const pid = normalizeOwnerPid(ownerPid)
  const file = resolveLeaseFile({ leaseFile, projectRoot })

  return withExclusiveLock(file, () => {
    const table = readLeaseTable(file)
    const existing = table.leases[id]
    if (existing && Number.isInteger(existing.cid) && existing.cid >= VSOCK_CID_MIN && existing.cid <= VSOCK_CID_MAX) {
      if (pid != null && existing.owner_pid != null && existing.owner_pid !== pid && isPidAlive(existing.owner_pid)) {
        return {
          ok: false,
          code: 'vsock_cid_owner_alive',
          vmId: id,
          cid: existing.cid,
          ownerPid: existing.owner_pid,
          error: `CID ${existing.cid} for ${id} is still owned by live PID ${existing.owner_pid}`,
        }
      }
      if (pid != null) {
        existing.owner_pid = pid
        existing.updated_at = new Date().toISOString()
        writeLeaseTableAtomic(file, table)
      }
      return { ok: true, vmId: id, cid: existing.cid, ownerPid: existing.owner_pid ?? null, reused: true }
    }

    // Reclaim ONLY leases whose owning PID is confirmed exited; live or unverified leases stay reserved.
    const usedCids = new Set()
    for (const [otherId, entry] of Object.entries(table.leases)) {
      if (isLeaseConfirmedExited(entry, isPidAlive)) {
        delete table.leases[otherId]
      } else if (Number.isInteger(entry?.cid)) {
        usedCids.add(entry.cid)
      }
    }

    const total = VSOCK_CID_MAX - VSOCK_CID_MIN + 1
    let chosen = null
    for (let i = 0; i < total; i += 1) {
      const candidate = VSOCK_CID_MIN + ((table.next_cid - VSOCK_CID_MIN + i) % total)
      if (!usedCids.has(candidate)) {
        chosen = candidate
        break
      }
    }
    if (chosen == null) {
      return {
        ok: false,
        code: 'vsock_cid_exhausted',
        vmId: id,
        error: `all virtio-vsock CIDs (${VSOCK_CID_MIN}..${VSOCK_CID_MAX}) are actively leased`,
      }
    }

    const now = new Date().toISOString()
    table.leases[id] = {
      vm_id: id,
      cid: chosen,
      owner_pid: pid,
      allocated_at: now,
      updated_at: now,
    }
    table.next_cid = chosen >= VSOCK_CID_MAX ? VSOCK_CID_MIN : chosen + 1
    writeLeaseTableAtomic(file, table)
    return { ok: true, vmId: id, cid: chosen, ownerPid: pid, reused: false }
  })
}

/**
 * Release the CID lease for `vmId`. When `verifyExited` is true (default), refuses to
 * release if the recorded `owner_pid` is still alive.
 */
export function releaseCid(vmId, { leaseFile, projectRoot, verifyExited = true, isPidAlive = defaultIsPidAlive } = {}) {
  const id = String(vmId || '').trim()
  if (!id) throw new Error('vmId is required for vsock CID release')
  const file = resolveLeaseFile({ leaseFile, projectRoot })

  return withExclusiveLock(file, () => {
    const table = readLeaseTable(file)
    const existing = table.leases[id]
    if (!existing) {
      return { ok: true, released: false, vmId: id, reason: 'not_found' }
    }
    if (verifyExited && existing.owner_pid != null && isPidAlive(existing.owner_pid)) {
      return {
        ok: false,
        released: false,
        code: 'vsock_cid_owner_alive',
        vmId: id,
        cid: existing.cid,
        ownerPid: existing.owner_pid,
        error: `refusing to release CID ${existing.cid}: owner PID ${existing.owner_pid} is still alive`,
      }
    }
    const releasedCid = existing.cid
    delete table.leases[id]
    writeLeaseTableAtomic(file, table)
    return { ok: true, released: true, vmId: id, cid: releasedCid }
  })
}

/**
 * Reclaim all stale leases whose `owner_pid` is confirmed exited. Leases with live PIDs
 * or without an attached `owner_pid` are conservatively preserved.
 */
export function reconcileStaleCids({ leaseFile, projectRoot, isPidAlive = defaultIsPidAlive } = {}) {
  const file = resolveLeaseFile({ leaseFile, projectRoot })

  return withExclusiveLock(file, () => {
    const table = readLeaseTable(file)
    const removed = []
    const remaining = []
    for (const [vmId, entry] of Object.entries(table.leases)) {
      if (isLeaseConfirmedExited(entry, isPidAlive)) {
        removed.push({ vmId, cid: entry.cid, ownerPid: entry.owner_pid })
        delete table.leases[vmId]
      } else {
        remaining.push({ vmId, cid: entry.cid, ownerPid: entry.owner_pid ?? null })
      }
    }
    if (removed.length > 0) {
      writeLeaseTableAtomic(file, table)
    }
    return { ok: true, removed, remaining }
  })
}

export function getCidLease(vmId, { leaseFile, projectRoot } = {}) {
  const id = String(vmId || '').trim()
  if (!id) return null
  const file = resolveLeaseFile({ leaseFile, projectRoot })
  const table = readLeaseTable(file)
  return table.leases[id] || null
}

export function attachCidOwnerPid(vmId, ownerPid, { leaseFile, projectRoot } = {}) {
  const id = String(vmId || '').trim()
  const pid = normalizeOwnerPid(ownerPid)
  if (!id || pid == null) throw new Error('vmId and positive integer ownerPid are required')
  const file = resolveLeaseFile({ leaseFile, projectRoot })

  return withExclusiveLock(file, () => {
    const table = readLeaseTable(file)
    const existing = table.leases[id]
    if (!existing) {
      return { ok: false, code: 'vsock_cid_not_found', vmId: id, error: `no CID lease found for ${id}` }
    }
    existing.owner_pid = pid
    existing.updated_at = new Date().toISOString()
    writeLeaseTableAtomic(file, table)
    return { ok: true, vmId: id, cid: existing.cid, ownerPid: pid }
  })
}

/**
 * Validate and re-claim a container's previously baked `KIN_KVM_VSOCK_CID` before `docker start`
 * (or re-bind it with a live `ownerPid` right after start). Reclaims stale exited holders of the
 * same CID, but fails closed with `vsock_cid_conflict` if another live/pending slot owns that CID.
 */
export function claimExistingCid(
  vmId,
  cid,
  { leaseFile, projectRoot, ownerPid = null, isPidAlive = defaultIsPidAlive } = {},
) {
  const id = String(vmId || '').trim()
  const targetCid = Number(cid)
  if (!id) throw new Error('vmId is required for vsock CID claim')
  if (!Number.isInteger(targetCid) || targetCid < VSOCK_CID_MIN || targetCid > VSOCK_CID_MAX) {
    return {
      ok: false,
      code: 'vsock_cid_invalid',
      vmId: id,
      cid: targetCid,
      error: `invalid virtio-vsock CID: ${cid}`,
    }
  }
  const pid = normalizeOwnerPid(ownerPid)
  const file = resolveLeaseFile({ leaseFile, projectRoot })

  return withExclusiveLock(file, () => {
    const table = readLeaseTable(file)
    for (const [otherId, entry] of Object.entries(table.leases)) {
      if (otherId === id) continue
      if (entry?.cid !== targetCid) continue
      if (isLeaseConfirmedExited(entry, isPidAlive)) {
        delete table.leases[otherId]
        continue
      }
      return {
        ok: false,
        code: 'vsock_cid_conflict',
        vmId: id,
        cid: targetCid,
        conflictVmId: otherId,
        conflictOwnerPid: entry.owner_pid ?? null,
        error: `CID ${targetCid} is currently held by ${otherId} (pid=${entry.owner_pid ?? 'pending'})`,
      }
    }

    const existing = table.leases[id]
    if (existing && existing.owner_pid != null && existing.owner_pid !== pid && isPidAlive(existing.owner_pid)) {
      return {
        ok: false,
        code: 'vsock_cid_owner_alive',
        vmId: id,
        cid: existing.cid,
        ownerPid: existing.owner_pid,
        error: `CID ${existing.cid} for ${id} is still owned by live PID ${existing.owner_pid}`,
      }
    }

    const now = new Date().toISOString()
    const restored = !existing || existing.cid !== targetCid
    table.leases[id] = {
      vm_id: id,
      cid: targetCid,
      owner_pid: pid ?? (existing?.cid === targetCid ? (existing.owner_pid ?? null) : null),
      allocated_at: !restored && existing?.allocated_at ? existing.allocated_at : now,
      updated_at: now,
    }
    if (table.next_cid === targetCid) {
      table.next_cid = targetCid >= VSOCK_CID_MAX ? VSOCK_CID_MIN : targetCid + 1
    }
    writeLeaseTableAtomic(file, table)
    return {
      ok: true,
      vmId: id,
      cid: targetCid,
      ownerPid: table.leases[id].owner_pid,
      restored,
    }
  })
}
