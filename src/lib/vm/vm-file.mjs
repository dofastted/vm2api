/**
 * Safe vm.json / slot-file writes (T7).
 *
 * - atomicWriteJson: write to a temp file in the same dir then rename, so a
 *   concurrent reader (or a crash mid-write) never sees a torn/partial file.
 * - withVmLock: standalone per-path async mutex; Kubernetes uses a durable
 *   per-VM claim shared with execution admission.
 * - writeJsonIfChanged: skip the write entirely when the on-disk content is
 *   byte-identical, cutting per-request write amplification.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getDb } from '../db/database.mjs'
import { isKubernetesMode, isKubernetesHaMode } from '../core/control-plane-mode.mjs'
import { haUnsupported } from '../core/ha-control-plane-policy.mjs'
import { SharedVmOperations } from './shared-vm-operations.mjs'

/**
 * Names inside `vms/` that are not slot records: `active.json` is the active
 * pointer, `<id>-chat.json` is a test-chat side file, and `create`/`import`
 * collide with the `/api/panel/vms/:id` route segments.
 */
const RESERVED_VM_IDS = new Set(['active', 'create', 'create-options', 'import', 'package'])

/** True when `id` must not be used for a slot record. */
export function isReservedVmId(id) {
  const s = String(id || '').toLowerCase()
  return !s || RESERVED_VM_IDS.has(s) || s.endsWith('-chat')
}

/** Slot ids are filename-safe (`[A-Za-z0-9_-]`) and never a reserved name. */
export function isValidVmId(id) {
  return /^[A-Za-z0-9_-]+$/.test(String(id || '')) && !isReservedVmId(id)
}

/** True for a `vms/<id>.json` slot record — any id, not just `vm-` prefixed. */
export function isVmRecordFile(base) {
  const name = String(base || '')
  if (!name.endsWith('.json') || name.startsWith('.')) return false
  return !isReservedVmId(name.slice(0, -5))
}

/** Slot record file names inside `dir` (missing/unreadable dir → `[]`). */
export function listVmRecordFiles(dir) {
  try {
    return fs.readdirSync(dir).filter(isVmRecordFile)
  } catch {
    return []
  }
}

/* --------------------------------------------------------------------------
 * Slot-record read cache.
 *
 * A scheduling attempt reads every slot record, and the pool re-runs the
 * attempt on every request, retry and failover. Caching UTF-8 text (never a
 * parsed object) keyed by path + (mtimeMs, size, ino) avoids repeating those
 * decodes while the on-disk identity is unchanged. A matching signature is a
 * freshness hint, not a byte-identity proof: writers that change bytes
 * without a new mtime/size/inode can miss. Callers always receive a newly
 * parsed object, so mutating a returned record cannot poison the next read.
 *
 * `KIN_VM_READ_CACHE_MS=0` disables the cache (escape hatch). The name is
 * historical; the value is only an on/off switch, not a TTL. Capacity is a
 * fixed LRU so deleted paths cannot accumulate without bound.
 * ------------------------------------------------------------------------ */
const readCache = new Map()

/** Conservative bound: a large fleet of records + credential files, LRU. */
export const VM_READ_CACHE_MAX_ENTRIES = 1024

const readCacheEnabled = (() => {
  const raw = process.env.KIN_VM_READ_CACHE_MS
  if (raw == null || raw === '') return true
  const value = Number(raw)
  return Number.isFinite(value) ? value > 0 : true
})()

function isNotFound(err) {
  return err && err.code === 'ENOENT'
}

function putReadCache(file, entry) {
  if (readCache.has(file)) readCache.delete(file)
  readCache.set(file, entry)
  if (readCache.size <= VM_READ_CACHE_MAX_ENTRIES) return
  const oldest = readCache.keys().next().value
  if (oldest !== undefined && oldest !== file) readCache.delete(oldest)
}

/** File text for `file`. Missing file → null; other I/O throws. */
export function readFileCached(file) {
  if (!readCacheEnabled) {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }
  let stat
  try {
    stat = fs.statSync(file)
  } catch (err) {
    readCache.delete(file)
    if (isNotFound(err)) return null
    throw err
  }
  const hit = readCache.get(file)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size && hit.ino === stat.ino) {
    putReadCache(file, hit)
    return hit.text
  }
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    readCache.delete(file)
    if (isNotFound(err)) return null
    throw err
  }
  putReadCache(file, { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, text })
  return text
}

/** Parsed JSON for `file`. Missing file → null; corrupt JSON and other I/O throw. */
export function readJsonCached(file) {
  const text = readFileCached(file)
  if (text == null) return null
  return JSON.parse(text)
}

/** Drop one path (or the whole cache). Returns whether a path entry was present. */
export function invalidateReadCache(file = null) {
  if (!file) {
    readCache.clear()
    return
  }
  return readCache.delete(file)
}

/** Drop the slot record and any cached files under `vms/<id>/` (credentials). */
export function invalidateVmSlotReadCache(projectRoot, id) {
  if (!projectRoot || !id) return
  invalidateReadCache(path.join(projectRoot, 'vms', `${id}.json`))
  const home = path.join(projectRoot, 'vms', id)
  const prefix = home + path.sep
  for (const file of readCache.keys()) {
    if (file === home || file.startsWith(prefix)) readCache.delete(file)
  }
}

const locks = new Map()
const pendingLocks = new Map()
const sharedOperations = new WeakMap()

/** Includes queued operations: connection changes must not interrupt an awaiting VM mutation. */
export function vmLockBusy(key) {
  return (pendingLocks.get(key) || 0) > 0
}

/**
 * Optional post-write hook (installed by lib/vm-db-sync.mjs) so every
 * vm.json write is mirrored into the SQLite `vms` table. Kept as a
 * registration seam to avoid an import cycle and to keep unit tests
 * (no DB) behavior-identical.
 */
let vmWriteHook = null
export function setVmWriteHook(fn) {
  vmWriteHook = typeof fn === 'function' ? fn : null
}

function notifyVmWrite(filePath) {
  if (!vmWriteHook) return
  try {
    vmWriteHook(filePath)
  } catch {}
}

export function withVmLock(key, fn, { operations, vmId, kind = 'mutation' } = {}) {
  if (isKubernetesHaMode()) throw haUnsupported()
  if (operations || isKubernetesMode()) {
    if (vmId == null) {
      const name = path.basename(String(key || ''))
      if (
        path.basename(path.dirname(String(key || ''))) !== 'vms' ||
        !name.endsWith('.json') ||
        !isValidVmId(name.slice(0, -5))
      ) {
        return Promise.reject(
          Object.assign(new Error('invalid VM operation key'), { code: 'invalid_vm_operation', status: 400 }),
        )
      }
      vmId = name.slice(0, -5)
    }
    try {
      if (!isValidVmId(vmId)) {
        throw Object.assign(new Error('invalid VM operation ID'), { code: 'invalid_vm_operation', status: 400 })
      }
      if (!operations) {
        const db = getDb()
        if (!sharedOperations.has(db)) sharedOperations.set(db, new SharedVmOperations(db))
        operations = sharedOperations.get(db)
      }
      const run = operations.run(vmId, fn, { kind })
      pendingLocks.set(key, (pendingLocks.get(key) || 0) + 1)
      return run.finally(() => {
        const pending = pendingLocks.get(key) - 1
        if (pending) pendingLocks.set(key, pending)
        else pendingLocks.delete(key)
      })
    } catch (error) {
      return Promise.reject(error)
    }
  }
  const prev = locks.get(key) || Promise.resolve()
  pendingLocks.set(key, (pendingLocks.get(key) || 0) + 1)
  const run = prev.then(fn, fn).finally(() => {
    const pending = pendingLocks.get(key) - 1
    if (pending) pendingLocks.set(key, pending)
    else pendingLocks.delete(key)
  })
  // Keep the chain alive but never reject the stored promise.
  locks.set(
    key,
    run.then(
      () => {},
      () => {},
    ),
  )
  return run
}

export function atomicWriteJson(filePath, obj, { mode } = {}) {
  assertVmWriteAllowed(filePath)
  const dir = path.dirname(filePath)
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  const data = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)
  const opts = mode ? { mode } : undefined
  fs.writeFileSync(tmp, data, opts)
  try {
    fs.renameSync(tmp, filePath)
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {}
    throw e
  }
  if (mode) {
    try {
      fs.chmodSync(filePath, mode)
    } catch {}
  }
  invalidateReadCache(filePath)
  notifyVmWrite(filePath)
  return true
}

export function writeJsonIfChanged(filePath, obj, { mode } = {}) {
  assertVmWriteAllowed(filePath)
  const data = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)
  try {
    if (fs.existsSync(filePath) && readFileCached(filePath) === data) {
      return false
    }
  } catch {}
  atomicWriteJson(filePath, data, { mode })
  return true
}

function assertVmWriteAllowed(filePath) {
  if (isKubernetesHaMode() && path.resolve(filePath).split(path.sep).includes('vms')) throw haUnsupported()
}
