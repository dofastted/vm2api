/**
 * VM/credential DB mirror — write-through + reconcile + fs.watch.
 *
 * Policy (user requirement: credentials must live in the database):
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
import { setVmWriteHook, atomicWriteJson, isVmRecordFile } from './vm-file.mjs'
import { reclaimAssignedVms, repairSlotSmbios, repairVmProxyCliEnabled } from './vm-registry.mjs'

let _repo = null
let _watcher = null
let _watchTimer = null
let _projectRoot = null

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

/** Mirror one vms/*.json file into the DB (safe no-op without DB). */
export function syncVmFile(filePath) {
  const r = repo()
  if (!r) return false
  try {
    const base = path.basename(filePath)
    if (base === 'active.json') {
      const a = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      if (a?.active_vm) r.setActiveVmId(a.active_vm)
      return true
    }
    const vm = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (!vm?.id) return false
    const st = fs.statSync(filePath)
    r.upsertFromVmJson(vm, { mtimeMs: st.mtimeMs })
    return true
  } catch {
    return false
  }
}

/** Remove a VM row (called when the vm.json file is deleted). */
export function removeVmFromDb(id) {
  const r = repo()
  if (!r || !id) return false
  return r.remove(id)
}

/** Forget settings.active_vm so startup reconcile does not rewrite active.json. */
export function clearActiveVmFromDb() {
  const r = repo()
  if (!r) return false
  r.clearActiveVmId()
  return true
}

/**
 * Startup reconcile:
 *   - file newer than DB row (or row missing) → upsert from file
 *   - DB row exists but file missing → rebuild file from vm_json
 * @returns {{ upserted: number, rebuilt: number, active: string|null }}
 */
export function reconcileVms(projectRoot) {
  const r = repo()
  if (!r) return { upserted: 0, rebuilt: 0, active: null }
  const dir = path.join(projectRoot, 'vms')
  const out = { upserted: 0, rebuilt: 0, active: null }
  const seen = new Set()

  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!isVmRecordFile(f)) continue
      const file = path.join(dir, f)
      try {
        const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (!vm?.id) continue
        seen.add(vm.id)
        const st = fs.statSync(file)
        const row = r.get(vm.id)
        if (!row || (row.file_mtime_ms || 0) < Math.floor(st.mtimeMs)) {
          r.upsertFromVmJson(vm, { mtimeMs: st.mtimeMs })
          out.upserted += 1
        }
      } catch {}
    }
  }

  // DB rows without files → rebuild files (restore / disaster pull-up)
  for (const row of r.list()) {
    if (seen.has(row.id) || !row.vm) continue
    try {
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `${row.id}.json`)
      atomicWriteJson(file, row.vm, { mode: 0o600 })
      out.rebuilt += 1
    } catch {}
  }

  // active.json ↔ settings.active_vm
  const activeFile = path.join(dir, 'active.json')
  try {
    if (fs.existsSync(activeFile)) {
      const a = JSON.parse(fs.readFileSync(activeFile, 'utf8'))
      if (a?.active_vm) {
        r.setActiveVmId(a.active_vm)
        out.active = a.active_vm
      }
    } else {
      const dbActive = r.getActiveVmId()
      if (dbActive) {
        fs.mkdirSync(dir, { recursive: true })
        atomicWriteJson(activeFile, { active_vm: dbActive, updated_at: new Date().toISOString() })
        out.active = dbActive
      }
    }
  } catch {}

  return out
}

/**
 * Install the write-through hook + directory watcher.
 * Call once at server startup, after openDatabase().
 */
export function initVmDbSync(projectRoot, { watch = true } = {}) {
  _projectRoot = projectRoot
  setVmWriteHook((filePath) => {
    if (isVmJsonPath(filePath)) syncVmFile(filePath)
  })
  const result = reconcileVms(projectRoot)
  // Older releases soft-deleted tenants without releasing their assigned slots.
  // Only confirmed deletions qualify; disabled/missing users and private slots stay isolated.
  const deletedOwners = isDbOpen()
    ? new Set(
        getDb()
          .prepare('SELECT id FROM users WHERE deleted_at IS NOT NULL')
          .all()
          .map((row) => row.id),
      )
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
      _watchTimer = setTimeout(() => {
        _watchTimer = null
        try {
          reconcileDeletionsAndChanges(projectRoot)
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

function reconcileDeletionsAndChanges(projectRoot) {
  const r = repo()
  if (!r) return
  reconcileVmsChangesOnly(projectRoot, r)
}

/** Watch-triggered pass: upsert changed files; DO NOT rebuild deleted files
 *  (a panel-initiated VM delete must stay deleted — server removes the row). */
function reconcileVmsChangesOnly(projectRoot, r) {
  const dir = path.join(projectRoot, 'vms')
  if (!fs.existsSync(dir)) return
  for (const f of fs.readdirSync(dir)) {
    if (!isVmRecordFile(f)) continue
    const file = path.join(dir, f)
    try {
      const st = fs.statSync(file)
      const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!vm?.id) continue
      const row = r.get(vm.id)
      if (!row || (row.file_mtime_ms || 0) < Math.floor(st.mtimeMs)) {
        r.upsertFromVmJson(vm, { mtimeMs: st.mtimeMs })
      }
    } catch {}
  }
  const activeFile = path.join(dir, 'active.json')
  try {
    if (fs.existsSync(activeFile)) {
      const a = JSON.parse(fs.readFileSync(activeFile, 'utf8'))
      if (a?.active_vm && a.active_vm !== r.getActiveVmId()) r.setActiveVmId(a.active_vm)
    }
  } catch {}
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
