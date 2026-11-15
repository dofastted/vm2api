/**
 * Rename a stopped local slot. The id is the directory and record name;
 * display `name` is a separate label and is not rewritten here.
 */
import fs from 'node:fs'
import path from 'node:path'
import { isDbOpen, getDb } from '../db/database.mjs'
import { atomicWriteJson, invalidateReadCache, invalidateVmSlotReadCache, isValidVmId } from './vm-file.mjs'
import { removeVmFromDb } from './vm-db-sync.mjs'

const ID_MAX = 64

export function parseVmRenameId(value) {
  const id = String(value ?? '').trim()
  if (!id || id.length > ID_MAX || !isValidVmId(id)) {
    return { ok: false, error: '编号只能用字母、数字、下划线和连字符，且不能用保留名' }
  }
  return { ok: true, value: id }
}

/** File-level refusal. A live container is checked separately. */
export function vmRenameBlock(vm) {
  if (!vm) return { status: 404, code: 'vm_not_found', message: 'vm not found' }
  if (vm.node_id) {
    return { status: 409, code: 'remote_vm', message: '远程节点上的槽不能改编号' }
  }
  const running = String(vm.status || '').toLowerCase() === 'running' || vm.runtime?.stopped === false
  if (running) {
    return { status: 409, code: 'vm_running', message: '运行中的槽不能改编号，请先关机' }
  }
  if (Number(vm.inflight) > 0) {
    return { status: 409, code: 'vm_busy', message: '还有在飞请求，不能改编号' }
  }
  return null
}

function tableNames(db) {
  return new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  )
}

function columnNames(db, table) {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name),
  )
}

/** Point live references at the new id. Request history stays on the old id. */
export function retargetVmId(fromId, toId) {
  if (!isDbOpen()) return
  const db = getDb()
  const tables = tableNames(db)
  const tx = db.transaction(() => {
    const move = (table) => {
      if (!tables.has(table) || !columnNames(db, table).has('vm_id')) return
      db.prepare(`UPDATE ${table} SET vm_id = ? WHERE vm_id = ?`).run(toId, fromId)
    }
    move('accounts')
    move('account_runtime')
    move('sticky_sessions')
    if (tables.has('proxies') && columnNames(db, 'proxies').has('bound_vm_id')) {
      db.prepare('UPDATE proxies SET bound_vm_id = ? WHERE bound_vm_id = ?').run(toId, fromId)
    }
    if (tables.has('vm_pool_members')) {
      db.prepare('UPDATE vm_pool_members SET vm_id = ? WHERE vm_id = ?').run(toId, fromId)
    }
    if (tables.has('api_keys') && columnNames(db, 'api_keys').has('allowed_vms')) {
      const rows = db.prepare('SELECT id, allowed_vms FROM api_keys').all()
      const update = db.prepare('UPDATE api_keys SET allowed_vms = ? WHERE id = ?')
      for (const row of rows) {
        let list
        try {
          list = JSON.parse(row.allowed_vms || '[]')
        } catch {
          continue
        }
        if (!Array.isArray(list) || !list.includes(fromId)) continue
        const next = [...new Set(list.map((item) => (item === fromId ? toId : item)))]
        update.run(JSON.stringify(next), row.id)
      }
    }
  })
  tx()
}

/**
 * Move `vms/<from>` and `<from>.json` onto `to`.
 * `discardContainer(fromId)` runs first so a still-running container can refuse
 * the rename before any file moves.
 */
export function renameVmId(projectRoot, fromId, toId, { discardContainer } = {}) {
  const parsed = parseVmRenameId(toId)
  if (!parsed.ok) return { ok: false, status: 400, code: 'invalid_id', message: parsed.error }
  const nextId = parsed.value
  if (nextId === fromId) return { ok: true, id: fromId, unchanged: true }

  const dir = path.join(projectRoot, 'vms')
  const fromFile = path.join(dir, `${fromId}.json`)
  const toFile = path.join(dir, `${nextId}.json`)
  const fromHome = path.join(dir, fromId)
  const toHome = path.join(dir, nextId)
  if (!fs.existsSync(fromFile)) {
    return { ok: false, status: 404, code: 'vm_not_found', message: 'vm not found' }
  }
  let vm
  try {
    vm = JSON.parse(fs.readFileSync(fromFile, 'utf8'))
  } catch {
    return { ok: false, status: 404, code: 'vm_not_found', message: 'vm not found' }
  }
  const blocked = vmRenameBlock(vm)
  if (blocked) return { ok: false, ...blocked }
  if (fs.existsSync(toFile) || fs.existsSync(toHome)) {
    return { ok: false, status: 409, code: 'vm_id_taken', message: '这个编号已经有槽' }
  }
  if (discardContainer) {
    const discarded = discardContainer(fromId)
    if (!discarded?.ok) {
      return {
        ok: false,
        status: 409,
        code: discarded.code || 'container_remove_failed',
        message: discarded.error || '移除旧容器失败',
      }
    }
  }

  let moved = false
  let retargeted = false
  let previousActive = null
  const activeFile = path.join(dir, 'active.json')
  const next = { ...vm, id: nextId, updated_at: new Date().toISOString() }
  try {
    if (fs.existsSync(fromHome)) {
      fs.renameSync(fromHome, toHome)
      moved = true
    }
    atomicWriteJson(toFile, next, { mode: 0o600 })
    fs.unlinkSync(fromFile)
    invalidateReadCache(fromFile)
    invalidateVmSlotReadCache(projectRoot, fromId)
    if (fs.existsSync(activeFile)) {
      const active = JSON.parse(fs.readFileSync(activeFile, 'utf8'))
      if (active?.active_vm === fromId) {
        previousActive = active
        atomicWriteJson(activeFile, { ...active, active_vm: nextId, updated_at: next.updated_at })
      }
    }
    retargetVmId(fromId, nextId)
    retargeted = true
    removeVmFromDb(fromId)
    return { ok: true, id: nextId, vm: next }
  } catch {
    if (retargeted) {
      try {
        retargetVmId(nextId, fromId)
      } catch {}
    }
    if (moved && fs.existsSync(toHome) && !fs.existsSync(fromHome)) {
      try {
        fs.renameSync(toHome, fromHome)
      } catch {}
    }
    if (previousActive) {
      try {
        atomicWriteJson(activeFile, previousActive)
      } catch {}
    }
    if (!fs.existsSync(fromFile)) {
      try {
        atomicWriteJson(fromFile, vm, { mode: 0o600 })
      } catch {}
    }
    if (fs.existsSync(toFile)) {
      try {
        fs.unlinkSync(toFile)
      } catch {}
    }
    invalidateReadCache(toFile)
    try {
      removeVmFromDb(nextId)
    } catch {}
    return {
      ok: false,
      status: 500,
      code: 'vm_rename_failed',
      message: '改编号失败，槽位文件已保持原编号',
    }
  }
}
