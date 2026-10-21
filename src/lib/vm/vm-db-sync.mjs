/**
 * VM metadata DB mirror — write-through + reconcile + fs.watch.
 *
 * Policy (VmsRepo omits active credentials and retains their presence flags):
 *   - vms/*.json stay the runtime single-writer surface (persistOauthToVm,
 *     CLI seed, execution context all read files — no behavior drift).
 *   - Every vm.json write is mirrored into the `vms` table:
 *       1. write-through hook installed on vm-file.atomicWriteJson
 *       2. explicit syncVmFile() calls from writers that bypass vm-file
 *       3. startup reconcile: newer file → upsert; missing file + DB row →
 *          rebuild the file from vm_json (disaster/restore pull-up)
 *       4. fs.watch on vms/ (debounced) catches external edits
 *   - active.json ↔ settings.active_vm mirrored the same way.
 *
 * All entry points no-op safely when the global DB is not open, so unit
 * tests that exercise oauth-credentials/vm-registry against bare temp dirs
 * keep working without a database.
 */

import fs from 'node:fs'
import path from 'node:path'
import { isDbOpen, getDb } from '../db/database.mjs'
import { VmsRepo } from '../db/repos/vms-repo.mjs'
import { WriteQueue } from '../pool/write-queue.mjs'
import { setVmWriteHook, atomicWriteJson, isVmRecordFile } from './vm-file.mjs'
import { reclaimAssignedVms, repairSlotSmbios, repairVmProxyCliEnabled } from './vm-registry.mjs'

let _repo = null
let _watcher = null
let _watchTimer = null
let _projectRoot = null
let _writes = new WriteQueue()
let _paused = false
const _deleted = new Set()

function repo() {
  if (!isDbOpen()) return null
  if (!_repo || _repo.db !== getDb()) _repo = new VmsRepo(getDb())
  return _repo
}

export function isVmJsonPath(filePath) {
  const base = path.basename(String(filePath || ''))
  const dir = path.basename(path.dirname(String(filePath || '')))
  if (dir !== 'vms') return false
  return isVmRecordFile(base) || base === 'active.json'
}

/** Mirror a captured file snapshot in write order. Flush reports persistence errors. */
export function syncVmFile(filePath) {
  const r = repo()
  if (!r || _paused) return Promise.resolve(false)
  let value
  let mtimeMs
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    mtimeMs = fs.statSync(filePath).mtimeMs
  } catch (error) {
    if (error.code === 'ENOENT') return Promise.resolve(false)
    _writes.enqueue(() => {
      throw error
    })
    return _writes.flush().then(() => false)
  }
  const active = path.basename(filePath) === 'active.json'
  if (!active && value?.id) _deleted.delete(value.id)
  if (active ? !value?.active_vm : !value?.id) return Promise.resolve(false)
  _writes.enqueue(() => (active ? r.setActiveVmId(value.active_vm) : r.upsertFromVmJson(value, { mtimeMs })))
  return _writes.flush().then(() => true)
}

/** Deletes follow every previously captured upsert. */
export async function removeVmFromDb(id) {
  const r = repo()
  if (!r || !id) return false
  _deleted.add(id)
  let removed = false
  _writes.enqueue(async () => {
    removed = await r.remove(id)
  })
  await _writes.flush()
  return removed
}

export async function clearActiveVmFromDb() {
  const r = repo()
  if (!r) return false
  _writes.enqueue(() => r.clearActiveVmId())
  await _writes.flush()
  return true
}

export function flushVmDbSync() {
  return _writes.flush()
}

export async function pauseVmDbSync() {
  _paused = true
  stopVmWatch()
  await flushVmDbSync()
}

export function resumeVmDbSync() {
  _paused = false
  if (_projectRoot) startVmWatch(_projectRoot)
}

/**
 * Startup reconcile:
 *   - file newer than DB row (or row missing) → upsert from file
 *   - DB row exists but file missing → rebuild file from vm_json
 * @returns {{ upserted: number, rebuilt: number, active: string|null }}
 */
export async function reconcileVms(projectRoot) {
  const r = repo()
  if (!r) return { upserted: 0, rebuilt: 0, active: null }
  const dir = path.join(projectRoot, 'vms')
  const out = { upserted: 0, rebuilt: 0, active: null }
  const seen = new Set()

  // The file snapshot and its conditional database write share the same queue
  // as write hooks. A newer hook always executes after this snapshot.
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (!isVmRecordFile(name)) continue
      _writes.enqueue(async () => {
        const file = path.join(dir, name)
        let vm
        let stat
        try {
          vm = JSON.parse(fs.readFileSync(file, 'utf8'))
          stat = fs.statSync(file)
        } catch (error) {
          if (error.code === 'ENOENT' || error instanceof SyntaxError) return
          throw error
        }
        if (!vm?.id || _deleted.has(vm.id)) return
        seen.add(vm.id)
        const row = await r.get(vm.id)
        if (!row || (row.file_mtime_ms || 0) < Math.floor(stat.mtimeMs)) {
          await r.upsertFromVmJson(vm, { mtimeMs: stat.mtimeMs })
          out.upserted += 1
        }
      })
    }
  }
  await flushVmDbSync()

  let rows = []
  _writes.enqueue(async () => {
    rows = await r.list()
  })
  await flushVmDbSync()
  for (const row of rows) {
    if (seen.has(row.id)) continue
    _writes.enqueue(async () => {
      const current = await r.get(row.id)
      const file = path.join(dir, `${row.id}.json`)
      if (!current?.vm || _deleted.has(row.id) || fs.existsSync(file)) return
      fs.mkdirSync(dir, { recursive: true })
      atomicWriteJson(file, current.vm, { mode: 0o600 })
      out.rebuilt += 1
    })
  }
  await flushVmDbSync()

  _writes.enqueue(async () => {
    const activeFile = path.join(dir, 'active.json')
    if (fs.existsSync(activeFile)) {
      let active
      try {
        active = JSON.parse(fs.readFileSync(activeFile, 'utf8'))
      } catch (error) {
        if (error instanceof SyntaxError) return
        throw error
      }
      if (active?.active_vm && !_deleted.has(active.active_vm)) {
        await r.setActiveVmId(active.active_vm)
        out.active = active.active_vm
      }
    } else {
      const active = await r.getActiveVmId()
      if (active && !_deleted.has(active)) {
        fs.mkdirSync(dir, { recursive: true })
        atomicWriteJson(activeFile, { active_vm: active, updated_at: new Date().toISOString() })
        out.active = active
      }
    }
  })
  await flushVmDbSync()
  return out
}

/**
 * Install the write-through hook + directory watcher.
 * Call once at server startup, after openDatabase().
 */
export async function initVmDbSync(projectRoot, { watch = true } = {}) {
  _projectRoot = projectRoot
  await flushVmDbSync()
  _writes = new WriteQueue(isDbOpen() ? getDb() : null)
  _paused = false
  _deleted.clear()
  setVmWriteHook(async (filePath) => {
    if (isVmJsonPath(filePath)) syncVmFile(filePath).catch(() => {})
  })
  const result = await reconcileVms(projectRoot)
  // Older releases soft-deleted tenants without releasing their assigned slots.
  // Only confirmed deletions qualify; disabled/missing users and private slots stay isolated.
  const deletedOwners = isDbOpen()
    ? new Set((await getDb().prepare('SELECT id FROM users WHERE deleted_at IS NOT NULL').all()).map((row) => row.id))
    : new Set()
  result.reclaimed_vm_ids = reclaimAssignedVms(projectRoot, deletedOwners, {
    onError: (error, name) => {
      console.warn(`[vm] ownership recovery skipped ${name}: ${error.code || error.name}`)
    },
  })
  try {
    result.proxy_cli_repaired = repairVmProxyCliEnabled(projectRoot).length
  } catch {
    result.proxy_cli_repaired = 0
  }
  try {
    result.smbios_repaired = repairSlotSmbios(projectRoot).length
  } catch {
    result.smbios_repaired = 0
  }
  await flushVmDbSync()
  if (watch) startVmWatch(projectRoot)
  return result
}

/** Debounced fs.watch on vms/ — catches external edits/manual fixes. */
export function startVmWatch(projectRoot) {
  stopVmWatch()
  const dir = path.join(projectRoot, 'vms')
  if (!fs.existsSync(dir)) return false
  try {
    _watcher = fs.watch(dir, () => {
      if (_watchTimer) clearTimeout(_watchTimer)
      _watchTimer = setTimeout(async () => {
        _watchTimer = null
        try {
          reconcileDeletionsAndChanges(projectRoot).catch((error) => {
            console.warn(`[vm] database mirror failed: ${error.code || error.name}`)
          })
        } catch {}
      }, 500)
      if (typeof _watchTimer.unref === 'function') _watchTimer.unref()
    })
    return true
  } catch {
    // non-fatal: write-through hook still covers the primary path
    _watcher = null
    return false
  }
}

async function reconcileDeletionsAndChanges(projectRoot) {
  const r = repo()
  if (!r) return
  if (!_paused) await reconcileVmsChangesOnly(projectRoot, r)
}

/** Watch-triggered pass: upsert changed files; DO NOT rebuild deleted files
 *  (a panel-initiated VM delete must stay deleted — server removes the row). */
async function reconcileVmsChangesOnly(projectRoot) {
  const dir = path.join(projectRoot, 'vms')
  if (!fs.existsSync(dir)) return
  for (const file of fs.readdirSync(dir)) {
    if (_paused) return
    if (isVmRecordFile(file) || file === 'active.json') await syncVmFile(path.join(dir, file))
  }
}

export function stopVmWatch() {
  if (_watchTimer) {
    clearTimeout(_watchTimer)
    _watchTimer = null
  }
  if (_watcher) {
    try {
      _watcher.close()
    } catch {}
    _watcher = null
  }
}

export function getVmSyncProjectRoot() {
  return _projectRoot
}
