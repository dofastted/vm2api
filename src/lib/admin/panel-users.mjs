/**
 * Panel operator accounts: scrypt passwords + admin/super/user roles.
 *
 * Env KIN_ADMIN_USER / KIN_ADMIN_PASSWORD seed the first admin when missing.
 * After that, the database hash is the source of truth (panel can change it).
 */

import crypto from 'node:crypto'
import { resolveStoreDb } from '../db/database.mjs'
import { UsersRepo } from '../db/repos/users-repo.mjs'
import { clampVmCreateQuota } from './resource-owner.mjs'
import { reclaimAssignedVms } from '../vm/vm-registry.mjs'

export const PANEL_ROLES = ['admin', 'super', 'user']

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEYLEN = 32
const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9._-]{1,31}$/

function nowIso() {
  return new Date().toISOString()
}

export function normalizeUsername(username) {
  return String(username || '').trim()
}

export function normalizeRole(role) {
  const r = String(role || '')
    .trim()
    .toLowerCase()
  if (r === 'viewer' || r === 'readonly' || r === '普通') return 'user'
  if (r === '管理员') return 'admin'
  return r
}

export function isPanelRole(role) {
  return PANEL_ROLES.includes(normalizeRole(role))
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(String(password), salt, KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$')
  if (parts[0] !== 'scrypt' || parts.length !== 6) return false
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false
  try {
    const salt = Buffer.from(parts[4], 'hex')
    const expected = Buffer.from(parts[5], 'hex')
    if (!salt.length || !expected.length) return false
    const actual = crypto.scryptSync(String(password), salt, expected.length, { N, r, p })
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

function assertUsername(username) {
  const name = normalizeUsername(username)
  if (!USERNAME_RE.test(name)) {
    const err = new Error('用户名为 2–32 位，需字母开头，仅字母数字 . _ -')
    err.code = 'invalid_username'
    throw err
  }
  return name
}

function assertPassword(password) {
  const pass = String(password ?? '')
  if (pass.length < 8) {
    const err = new Error('密码至少 8 位')
    err.code = 'invalid_password'
    throw err
  }
  if (pass.length > 128) {
    const err = new Error('密码过长')
    err.code = 'invalid_password'
    throw err
  }
  return pass
}

function assertRole(role) {
  const r = normalizeRole(role)
  if (!isPanelRole(r)) {
    const err = new Error('角色必须是 admin / super / user')
    err.code = 'invalid_role'
    throw err
  }
  return r
}

export function publicUserView(rec) {
  if (!rec) return null
  return {
    id: rec.id,
    username: rec.username,
    role: rec.role,
    enabled: rec.enabled !== false,
    vm_create_quota: clampVmCreateQuota(rec.vm_create_quota, 0),
    created_at: rec.created_at,
    updated_at: rec.updated_at,
    last_login_at: rec.last_login_at || null,
  }
}

export class PanelUserStore {
  constructor({ dataDir, db, projectRoot = null } = {}) {
    this.db = resolveStoreDb({ db, dataDir })
    this.repo = new UsersRepo(this.db)
    this.projectRoot = projectRoot
  }

  rebind(db) {
    this.db = db
    this.repo = new UsersRepo(db)
  }

  list() {
    return this.repo.list().map(publicUserView)
  }

  getById(id) {
    return this.repo.getById(id)
  }

  getByUsername(username) {
    return this.repo.getByUsername(username)
  }

  countEnabledAdmins() {
    return this.repo.countEnabledRole('admin')
  }

  bootstrapFromEnv({ username, password } = {}) {
    const name = normalizeUsername(username)
    if (!name || !password) return null
    const existing = this.repo.getByUsername(name)
    if (existing) return publicUserView(existing)
    // Import the already accepted env credential; new passwords still go through assertPassword.
    return publicUserView(
      this.repo.insert({
        id: crypto.randomUUID(),
        username: assertUsername(name),
        password_hash: hashPassword(password),
        role: 'admin',
        enabled: true,
        vm_create_quota: 0,
        created_at: nowIso(),
        updated_at: nowIso(),
        last_login_at: null,
      }),
    )
  }

  authenticate(username, password) {
    const rec = this.repo.getByUsername(username)
    if (!rec || rec.enabled === false) return null
    if (!verifyPassword(password, rec.password_hash)) return null
    const next = { ...rec, last_login_at: nowIso(), updated_at: rec.updated_at }
    this.repo.update(next)
    return publicUserView(next)
  }

  create({ username, password, role = 'user', enabled = true, vm_create_quota = 0 } = {}) {
    const name = assertUsername(username)
    if (this.repo.getByUsername(name)) {
      const err = new Error('用户名已存在')
      err.code = 'username_exists'
      throw err
    }
    const rec = {
      id: crypto.randomUUID(),
      username: name,
      password_hash: hashPassword(assertPassword(password)),
      role: assertRole(role),
      enabled: enabled !== false,
      vm_create_quota: clampVmCreateQuota(vm_create_quota, 0),
      created_at: nowIso(),
      updated_at: nowIso(),
      last_login_at: null,
    }
    return this.repo.insert(rec)
  }

  update(id, patch = {}, { actorId = null } = {}) {
    const rec = this.repo.getById(id)
    if (!rec) return null
    const next = { ...rec }

    if (patch.role != null) {
      const role = assertRole(patch.role)
      if (rec.role === 'admin' && role !== 'admin' && this.countEnabledAdmins() <= 1) {
        const err = new Error('不能取消最后一个管理员')
        err.code = 'last_admin'
        throw err
      }
      next.role = role
    }

    if (patch.enabled != null) {
      const enabled = !!patch.enabled
      if (rec.role === 'admin' && rec.enabled && !enabled && this.countEnabledAdmins() <= 1) {
        const err = new Error('不能停用最后一个管理员')
        err.code = 'last_admin'
        throw err
      }
      if (actorId && actorId === rec.id && !enabled) {
        const err = new Error('不能停用当前登录账号')
        err.code = 'self_disable'
        throw err
      }
      next.enabled = enabled
    }

    if (patch.password != null && String(patch.password) !== '') {
      next.password_hash = hashPassword(assertPassword(patch.password))
    }

    if (patch.vm_create_quota != null) {
      next.vm_create_quota = clampVmCreateQuota(patch.vm_create_quota, rec.vm_create_quota || 0)
    }

    next.updated_at = nowIso()
    return this.repo.update(next)
  }

  remove(id, { actorId = null } = {}) {
    const rec = this.repo.getById(id)
    if (!rec) return false
    if (actorId && actorId === rec.id) {
      const err = new Error('不能删除当前登录账号')
      err.code = 'self_delete'
      throw err
    }
    if (rec.role === 'admin' && rec.enabled && this.countEnabledAdmins() <= 1) {
      const err = new Error('不能删除最后一个管理员')
      err.code = 'last_admin'
      throw err
    }
    // Validate deletion first; a failed slot write must leave the user available for retry.
    if (this.projectRoot) reclaimAssignedVms(this.projectRoot, new Set([rec.id]))
    return this.repo.remove(id)
  }
}
