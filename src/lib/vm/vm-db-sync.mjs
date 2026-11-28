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
import { isDbOpen, getDb, getPgPool } from '../db/database.mjs'
import { notifyDbTablesMutated } from '../cache/index.mjs'
import { maybeEncrypt, encryptionEnabled } from '../db/secure.mjs'
import { VmsRepo } from '../db/repos/vms-repo.mjs'
import { VmPoolsRepo } from '../db/repos/vm-pools-repo.mjs'
import { hasAccessPresence, hasRefreshPresence, stripCredentialSecrets } from '../oauth/oauth-credentials.mjs'
import { normalizeOwnerId, vmOriginOf } from '../admin/resource-owner.mjs'
import { setVmWriteHook, atomicWriteJson, isVmRecordFile } from './vm-file.mjs'
import { migrateScheduleFields, reclaimAssignedVms, repairSlotSmbios, repairVmProxyCliEnabled } from './vm-registry.mjs'

const ACTIVE_VM_KEY = 'active_vm'
const WATCH_DEBOUNCE_MS = 500
const PG_UPSERT_BATCH_CHUNK = 100

let _repo = null
let _watcher = null
let _watchTimer = null
let _projectRoot = null
let _explicitPgPool = null
let _watchFullScan = false
let _lastActiveVmId = null
let _pgPendingActive = undefined
let _pgFlushScheduled = false
let _pgFlushChain = Promise.resolve()

const _lastSyncedMtime = new Map() // filePath -> Math.floor(mtimeMs)
const _watchDirtyFiles = new Set() // base filenames changed inside vms/
const _pgPendingVms = new Map() // vmId -> { vm, mtimeMs }

function repo() {
  if (!isDbOpen()) return null
  if (!_repo || _repo.db !== getDb()) _repo = new VmsRepo(getDb())
  return _repo
}

function resolvePgPool() {
  if (_explicitPgPool && typeof _explicitPgPool.query === 'function') return _explicitPgPool
  if (!isDbOpen()) return null
  const db = getDb()
  if (db?.engine === 'postgres') {
    const pool = getPgPool()
    if (pool && typeof pool.query === 'function') return pool
  }
  return null
}

/** Optional test/runtime seam to bind or clear an explicit async pgPool. */
export function setVmDbSyncPgPool(pgPool = null) {
  _explicitPgPool = pgPool || null
}

function buildSafeVmRowParams(vm, mtimeMs, now) {
  const c = vm.claude || {}
  const safeClaude = stripCredentialSecrets({
    ...c,
    has_access: hasAccessPresence(c),
    has_refresh: hasRefreshPresence(c),
  })
  const safeVm = { ...vm, claude: safeClaude }
  const enc = encryptionEnabled()
  return {
    id: String(vm.id),
    name: vm.name ?? null,
    status: vm.status ?? null,
    schedulable: vm.schedulable === false ? 0 : 1,
    email: safeClaude.email ?? null,
    account_uuid: safeClaude.account_uuid ?? null,
    org_uuid: safeClaude.org_uuid ?? null,
    access_token: null,
    refresh_token: null,
    session_key: null,
    oauth_expires_at: c.expires_at != null ? String(c.expires_at) : null,
    oauth_source: safeClaude.source ?? null,
    proxy_id: vm.proxy?.id ?? null,
    claude_code_version: vm.claude_code_version ?? null,
    timezone: vm.timezone ?? null,
    locale: vm.locale ?? null,
    owner_user_id: normalizeOwnerId(vm.owner_user_id),
    origin: vmOriginOf(vm),
    vm_json: enc ? maybeEncrypt(JSON.stringify(safeVm)) : JSON.stringify(safeVm),
    encrypted: enc ? 1 : 0,
    file_mtime_ms: mtimeMs != null ? Math.floor(mtimeMs) : null,
    synced_at: now,
    created_at: vm.created_at ?? now,
    updated_at: now,
  }
}

async function upsertVmsPgAsync(pgPool, entries) {
  if (!entries.length) return 0
  const now = new Date().toISOString()
  let written = 0
  for (let i = 0; i < entries.length; i += PG_UPSERT_BATCH_CHUNK) {
    const chunk = entries.slice(i, i + PG_UPSERT_BATCH_CHUNK)
    const cols = {
      id: [],
      name: [],
      status: [],
      schedulable: [],
      email: [],
      account_uuid: [],
      org_uuid: [],
      access_token: [],
      refresh_token: [],
      session_key: [],
      oauth_expires_at: [],
      oauth_source: [],
      proxy_id: [],
      claude_code_version: [],
      timezone: [],
      locale: [],
      owner_user_id: [],
      origin: [],
      vm_json: [],
      encrypted: [],
      file_mtime_ms: [],
      synced_at: [],
      created_at: [],
      updated_at: [],
    }
    for (const item of chunk) {
      const p = buildSafeVmRowParams(item.vm, item.mtimeMs, now)
      for (const k of Object.keys(cols)) cols[k].push(p[k])
    }
    await pgPool.query(
      `INSERT INTO vms (
        id, name, status, schedulable, email, account_uuid, org_uuid,
        access_token, refresh_token, session_key, oauth_expires_at, oauth_source,
        proxy_id, claude_code_version, timezone, locale,
        owner_user_id, origin,
        vm_json, encrypted, file_mtime_ms, synced_at, created_at, updated_at
      )
      SELECT * FROM UNNEST(
        $1::text[], $2::text[], $3::text[], $4::integer[], $5::text[], $6::text[], $7::text[],
        $8::text[], $9::text[], $10::text[], $11::text[], $12::text[],
        $13::text[], $14::text[], $15::text[], $16::text[],
        $17::text[], $18::text[],
        $19::text[], $20::integer[], $21::bigint[], $22::text[], $23::text[], $24::text[]
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, status = EXCLUDED.status, schedulable = EXCLUDED.schedulable,
        email = EXCLUDED.email, account_uuid = EXCLUDED.account_uuid, org_uuid = EXCLUDED.org_uuid,
        access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token,
        session_key = EXCLUDED.session_key, oauth_expires_at = EXCLUDED.oauth_expires_at,
        oauth_source = EXCLUDED.oauth_source, proxy_id = EXCLUDED.proxy_id,
        claude_code_version = EXCLUDED.claude_code_version, timezone = EXCLUDED.timezone,
        locale = EXCLUDED.locale, owner_user_id = EXCLUDED.owner_user_id, origin = EXCLUDED.origin,
        vm_json = EXCLUDED.vm_json, encrypted = EXCLUDED.encrypted,
        file_mtime_ms = EXCLUDED.file_mtime_ms, synced_at = EXCLUDED.synced_at,
        updated_at = EXCLUDED.updated_at`,
      [
        cols.id,
        cols.name,
        cols.status,
        cols.schedulable,
        cols.email,
        cols.account_uuid,
        cols.org_uuid,
        cols.access_token,
        cols.refresh_token,
        cols.session_key,
        cols.oauth_expires_at,
        cols.oauth_source,
        cols.proxy_id,
        cols.claude_code_version,
        cols.timezone,
        cols.locale,
        cols.owner_user_id,
        cols.origin,
        cols.vm_json,
        cols.encrypted,
        cols.file_mtime_ms,
        cols.synced_at,
        cols.created_at,
        cols.updated_at,
      ],
    )
    written += chunk.length
  }
  return written
}

async function upsertActiveVmPgAsync(pgPool, activeVmId) {
  await pgPool.query(
    `INSERT INTO settings (key, value, updated_at)
    VALUES ($1, $2, $3)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [ACTIVE_VM_KEY, JSON.stringify(activeVmId), new Date().toISOString()],
  )
}

function schedulePgFlush() {
  if (_pgFlushScheduled) return
  _pgFlushScheduled = true
  queueMicrotask(() => {
    _pgFlushScheduled = false
    void flushVmDbSyncAsync().catch(() => {})
  })
}

/** Drain all pending async PostgreSQL VM mirror upserts (no-op in SQLite mode). */
export function flushVmDbSyncAsync() {
  const run = async () => {
    const pgPool = resolvePgPool()
    if (!pgPool) {
      _pgPendingVms.clear()
      _pgPendingActive = undefined
      return { upserted: 0, activeUpdated: false }
    }
    let upserted = 0
    let activeUpdated = false
    for (let round = 0; round < 8; round += 1) {
      if (_pgPendingVms.size === 0 && _pgPendingActive === undefined) break
      const vmEntries = [..._pgPendingVms.entries()]
      _pgPendingVms.clear()
      const pendingActive = _pgPendingActive
      _pgPendingActive = undefined
      const mutated = []
      try {
        if (vmEntries.length > 0) {
          upserted += await upsertVmsPgAsync(
            pgPool,
            vmEntries.map(([, item]) => item),
          )
          mutated.push('vms')
        }
        if (pendingActive !== undefined) {
          await upsertActiveVmPgAsync(pgPool, pendingActive)
          _lastActiveVmId = pendingActive
          activeUpdated = true
          mutated.push('settings')
        }
        if (mutated.length > 0) {
          notifyDbTablesMutated(mutated)
        }
      } catch (err) {
        for (const [id, item] of vmEntries) {
          if (!_pgPendingVms.has(id)) _pgPendingVms.set(id, item)
        }
        if (pendingActive !== undefined && _pgPendingActive === undefined) {
          _pgPendingActive = pendingActive
        }
        throw err
      }
    }
    return { upserted, activeUpdated }
  }
  const next = _pgFlushChain.then(run, run)
  _pgFlushChain = next.catch(() => {})
  return next
}

export function isVmJsonPath(filePath) {
  const base = path.basename(String(filePath || ''))
  const dir = path.basename(path.dirname(String(filePath || '')))
  if (dir !== 'vms') return false
  return isVmRecordFile(base) || base === 'active.json'
}

/** Mirror one vms/*.json file into the DB (safe no-op without DB; async pgPool in PG mode). */
export function syncVmFile(filePath) {
  const pgPool = resolvePgPool()
  const r = pgPool ? null : repo()
  if (!pgPool && !r) return false
  try {
    const base = path.basename(filePath)
    const st = fs.statSync(filePath)
    const mtimeFloor = Math.floor(st.mtimeMs)
    if (base === 'active.json') {
      const a = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      _lastSyncedMtime.set(filePath, mtimeFloor)
      if (!a?.active_vm) return true
      if (pgPool) {
        if (a.active_vm !== _lastActiveVmId) {
          _pgPendingActive = a.active_vm
          schedulePgFlush()
        }
      } else {
        r.setActiveVmId(a.active_vm)
        _lastActiveVmId = a.active_vm
      }
      return true
    }
    const vm = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (!vm?.id) return false
    _lastSyncedMtime.set(filePath, mtimeFloor)
    if (pgPool) {
      _pgPendingVms.set(String(vm.id), { vm, mtimeMs: st.mtimeMs })
      schedulePgFlush()
    } else {
      r.upsertFromVmJson(vm, { mtimeMs: st.mtimeMs })
    }
    return true
  } catch {
    return false
  }
}

/** Remove a VM row (called when the vm.json file is deleted). */
export function removeVmFromDb(id) {
  const r = repo()
  if (!r || !id) return false
  const removed = r.remove(id)
  // A deleted slot must not linger in named pools: the panel cannot render or
  // uncheck an unknown id, and every save of that pool used to fail.
  if (isDbOpen()) {
    try {
      new VmPoolsRepo(getDb()).removeVm(id)
    } catch {}
  }
  return removed
}

function pruneVmPools(knownIds) {
  if (!isDbOpen()) return []
  try {
    return new VmPoolsRepo(getDb()).pruneUnknown(knownIds)
  } catch {
    return []
  }
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
        _lastSyncedMtime.set(file, Math.floor(st.mtimeMs))
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

  // Pool memberships for slots that exist nowhere any more (file deleted outside
  // the panel, or DB row gone). Rebuilt rows above count as alive.
  const known = new Set(seen)
  for (const row of r.list()) if (row?.id && row.vm) known.add(row.id)
  out.pruned_pool_members = pruneVmPools(known)

  // active.json ↔ settings.active_vm
  const activeFile = path.join(dir, 'active.json')
  try {
    if (fs.existsSync(activeFile)) {
      const st = fs.statSync(activeFile)
      _lastSyncedMtime.set(activeFile, Math.floor(st.mtimeMs))
      const a = JSON.parse(fs.readFileSync(activeFile, 'utf8'))
      if (a?.active_vm) {
        r.setActiveVmId(a.active_vm)
        _lastActiveVmId = a.active_vm
        out.active = a.active_vm
      }
    } else {
      const dbActive = r.getActiveVmId()
      if (dbActive) {
        fs.mkdirSync(dir, { recursive: true })
        atomicWriteJson(activeFile, { active_vm: dbActive, updated_at: new Date().toISOString() })
        _lastActiveVmId = dbActive
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
  try {
    const migrated = migrateScheduleFields(projectRoot)
    result.schedule_migrated = migrated.length
    for (const row of migrated) {
      console.warn(
        `[vm] schedule state ${row.id}: ${row.from || '-'} -> ${row.state}${row.reason ? `:${row.reason}` : ''}`,
      )
    }
  } catch (error) {
    console.warn(`[vm] schedule state migration failed: ${error?.message || error}`)
    result.schedule_migrated = 0
  }
  if (watch) startVmWatch(projectRoot)
  return result
}

/** Debounced fs.watch on vms/ — catches external edits/manual fixes incrementally. */
export function startVmWatch(projectRoot) {
  stopVmWatch()
  const dir = path.join(projectRoot, 'vms')
  if (!fs.existsSync(dir)) return false
  try {
    _watcher = fs.watch(dir, (_eventType, filename) => {
      if (typeof filename === 'string' && filename) {
        const base = path.basename(filename)
        if (isVmRecordFile(base) || base === 'active.json') {
          _watchDirtyFiles.add(base)
        } else {
          // Ignore temp files (.tmp) and unrelated files to prevent 200-VM watch storms
          return
        }
      } else {
        _watchFullScan = true
      }
      if (_watchTimer) clearTimeout(_watchTimer)
      _watchTimer = setTimeout(() => {
        _watchTimer = null
        try {
          reconcileDeletionsAndChanges(projectRoot)
        } catch {}
      }, WATCH_DEBOUNCE_MS)
      if (typeof _watchTimer.unref === 'function') _watchTimer.unref()
    })
    return true
  } catch {
    // non-fatal: write-through hook still covers the primary path
    _watcher = null
    return false
  }
}

function syncChangedVmFilesPgAsync(pgPool, dir, candidates) {
  if (!candidates.length) return
  void (async () => {
    try {
      const ids = candidates.map((c) => String(c.vm.id))
      const res = await pgPool.query('SELECT id, file_mtime_ms FROM vms WHERE id = ANY($1::text[])', [ids])
      const existingMtime = new Map()
      for (const row of res?.rows || []) {
        if (row?.id) existingMtime.set(String(row.id), Number(row.file_mtime_ms) || 0)
      }
      let queued = false
      for (const c of candidates) {
        const prevMtime = existingMtime.get(String(c.vm.id)) ?? -1
        if (prevMtime < c.mtimeFloor) {
          _pgPendingVms.set(String(c.vm.id), { vm: c.vm, mtimeMs: c.mtimeMs })
          queued = true
        }
        _lastSyncedMtime.set(c.file, c.mtimeFloor)
      }
      if (queued) await flushVmDbSyncAsync()
    } catch {}
  })()
}

function reconcileDeletionsAndChanges(projectRoot) {
  const pgPool = resolvePgPool()
  const r = pgPool ? null : repo()
  if (!pgPool && !r) return
  const dirtyFiles = [..._watchDirtyFiles]
  const fullScan = _watchFullScan
  _watchDirtyFiles.clear()
  _watchFullScan = false
  reconcileVmsChangesOnly(projectRoot, { r, pgPool, dirtyFiles, fullScan })
}

/**
 * Watch-triggered pass: upsert only changed files; DO NOT rebuild deleted files
 * (a panel-initiated VM delete must stay deleted — server removes the row).
 * In PG mode, never loops synchronous `r.get(vm.id)` across all VMs.
 */
function reconcileVmsChangesOnly(projectRoot, { r, pgPool, dirtyFiles = [], fullScan = false }) {
  const dir = path.join(projectRoot, 'vms')
  if (!fs.existsSync(dir)) return
  const targets = fullScan ? fs.readdirSync(dir) : dirtyFiles
  const pgCandidates = []

  for (const base of targets) {
    if (base === 'active.json') {
      const activeFile = path.join(dir, 'active.json')
      try {
        if (!fs.existsSync(activeFile)) continue
        const st = fs.statSync(activeFile)
        const mtimeFloor = Math.floor(st.mtimeMs)
        if (mtimeFloor <= (_lastSyncedMtime.get(activeFile) || 0)) continue
        _lastSyncedMtime.set(activeFile, mtimeFloor)
        const a = JSON.parse(fs.readFileSync(activeFile, 'utf8'))
        if (a?.active_vm && a.active_vm !== _lastActiveVmId) {
          if (pgPool) {
            _pgPendingActive = a.active_vm
            schedulePgFlush()
          } else if (a.active_vm !== r.getActiveVmId()) {
            r.setActiveVmId(a.active_vm)
            _lastActiveVmId = a.active_vm
          }
        }
      } catch {}
      continue
    }
    if (!isVmRecordFile(base)) continue
    const file = path.join(dir, base)
    try {
      const st = fs.statSync(file)
      const mtimeFloor = Math.floor(st.mtimeMs)
      if (mtimeFloor <= (_lastSyncedMtime.get(file) || 0)) continue
      const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!vm?.id) continue
      if (pgPool) {
        pgCandidates.push({ file, vm, mtimeMs: st.mtimeMs, mtimeFloor })
      } else {
        _lastSyncedMtime.set(file, mtimeFloor)
        const row = r.get(vm.id)
        if (!row || (row.file_mtime_ms || 0) < mtimeFloor) {
          r.upsertFromVmJson(vm, { mtimeMs: st.mtimeMs })
        }
      }
    } catch {
      _lastSyncedMtime.delete(file)
    }
  }

  if (pgPool && pgCandidates.length > 0) {
    syncChangedVmFilesPgAsync(pgPool, dir, pgCandidates)
  }
}

export function stopVmWatch() {
  if (_watchTimer) {
    clearTimeout(_watchTimer)
    _watchTimer = null
  }
  _watchDirtyFiles.clear()
  _watchFullScan = false
  if (_watcher) {
    try {
      _watcher.close()
    } catch {}
    _watcher = null
  }
}

/** Test helper: inspect/clear in-process mtime cache. */
export function resetVmDbSyncState() {
  _lastSyncedMtime.clear()
  _watchDirtyFiles.clear()
  _watchFullScan = false
  _lastActiveVmId = null
  _pgPendingVms.clear()
  _pgPendingActive = undefined
  _pgFlushScheduled = false
}

export function getVmSyncProjectRoot() {
  return _projectRoot
}
