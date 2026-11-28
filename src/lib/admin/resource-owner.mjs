/**
 * Tenant ownership for VMs, proxies, and /v1 dispatch.
 * vm.json is SSOT for VM owner/origin; this module is the only decoder.
 */

import { DB_INSTANCE_ID, getDb, isDbOpen } from '../db/database.mjs'
import { getCacheRuntime } from '../cache/index.mjs'
import { isValidVmId } from '../vm/vm-file.mjs'

const requestOwnerMemo = new WeakMap()

function userEntityCacheKey(db, userId) {
  if (isDbOpen() && db === getDb()) return String(userId)
  return `${db?.[DB_INSTANCE_ID] || 'isolated'}:${userId}`
}

/**
 * Resolve the key owner user record with minimal DB I/O:
 * 1. Reuse `_authProjection.owner` populated during API key authentication (0 RPC).
 * 2. Reuse request-scoped memoization across multiple checks in the same request (0 RPC).
 * 3. Read through `cache.entity.getPanelUserByIdSync` for DB-backed UsersRepo instances.
 * Plain mock `usersRepo` objects without `.db` bypass global EntityCache to preserve test isolation.
 */
export function resolveOwnerUserSync(req, userId, usersRepo = null) {
  const uid = normalizeOwnerId(userId)
  if (!uid) return null

  const proj = req?.apiKeyRecord?._authProjection
  if (proj?.ownerLoaded && normalizeOwnerId(proj.userId) === uid) {
    return proj.owner || null
  }

  const hasReqObj = req && typeof req === 'object'
  if (hasReqObj && usersRepo?.db) {
    const memo = requestOwnerMemo.get(req)
    if (memo?.has(uid)) return memo.get(uid)
  }

  if (!usersRepo?.getById) return null

  let owner = null
  try {
    if (usersRepo.db) {
      const cacheKey = userEntityCacheKey(usersRepo.db, uid)
      owner = getCacheRuntime().entity.getPanelUserByIdSync(cacheKey, () => usersRepo.getById(uid))
    } else {
      owner = usersRepo.getById(uid)
    }
  } catch {
    owner = null
  }

  if (hasReqObj && usersRepo.db) {
    let memo = requestOwnerMemo.get(req)
    if (!memo) {
      memo = new Map()
      requestOwnerMemo.set(req, memo)
    }
    memo.set(uid, owner || null)
  }
  return owner || null
}

export async function resolveOwnerUserAsync(req, userId, usersRepo = null) {
  const uid = normalizeOwnerId(userId)
  if (!uid) return null

  const proj = req?.apiKeyRecord?._authProjection
  if (proj?.ownerLoaded && normalizeOwnerId(proj.userId) === uid) {
    return proj.owner || null
  }

  const hasReqObj = req && typeof req === 'object'
  if (hasReqObj && usersRepo?.db) {
    const memo = requestOwnerMemo.get(req)
    if (memo?.has(uid)) return memo.get(uid)
  }

  if (!usersRepo?.getById) return null

  let owner = null
  try {
    if (usersRepo.db) {
      const cacheKey = userEntityCacheKey(usersRepo.db, uid)
      owner = await getCacheRuntime().entity.getPanelUserById(cacheKey, () => usersRepo.getById(uid))
    } else {
      owner = usersRepo.getById(uid)
    }
  } catch {
    owner = null
  }

  if (hasReqObj && usersRepo.db) {
    let memo = requestOwnerMemo.get(req)
    if (!memo) {
      memo = new Map()
      requestOwnerMemo.set(req, memo)
    }
    memo.set(uid, owner || null)
  }
  return owner || null
}

export const VM_ORIGIN = {
  platform: 'platform',
  adminAssigned: 'admin_assigned',
  userCreated: 'user_created',
}

export const PLATFORM_SCOPE = Object.freeze({ type: 'platform' })

const isAdminRole = (role) => {
  const name = String(role || '')
    .trim()
    .toLowerCase()
  return name === 'admin' || name === 'super'
}

export function normalizeOwnerId(id) {
  const s = String(id || '').trim()
  return s || null
}

export function clampVmCreateQuota(value, fallback = 0) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(100, Math.round(n)))
}

export function vmOwnerId(vm) {
  return normalizeOwnerId(vm?.owner_user_id)
}

export function vmOriginOf(vm) {
  const origin = String(vm?.origin || '').trim()
  if (origin === VM_ORIGIN.adminAssigned || origin === VM_ORIGIN.userCreated || origin === VM_ORIGIN.platform) {
    return origin
  }
  return vmOwnerId(vm) ? VM_ORIGIN.adminAssigned : VM_ORIGIN.platform
}

export function proxyOwnerId(proxy) {
  return normalizeOwnerId(proxy?.owner_user_id)
}

export function endpointOwnerId(endpoint) {
  return normalizeOwnerId(endpoint?.owner_user_id)
}

export function ownerMatchesScope(owner, scope = PLATFORM_SCOPE) {
  const type = scope?.type || 'platform'
  if (type === 'any') return true
  const normalized = normalizeOwnerId(owner)
  if (type === 'platform') return !normalized
  if (type === 'user') {
    const target = normalizeOwnerId(scope.userId)
    return !!target && normalized === target
  }
  return false
}

export function ownerScopeFromApiKey(record, { apiKeyKind = null, ownerRole = null } = {}) {
  if (apiKeyKind === 'master') return PLATFORM_SCOPE
  const explicitOwner = normalizeOwnerId(record?.owner_id)
  if (explicitOwner) return { type: 'user', userId: explicitOwner }
  const tier = String(record?.permission_tier || '')
    .trim()
    .toLowerCase()
  const userId = normalizeOwnerId(record?.user_id)
  if (!userId) {
    if (tier === 'tenant') return { type: 'none' }
    return PLATFORM_SCOPE
  }
  if (isAdminRole(ownerRole)) {
    if (tier === 'tenant') return { type: 'none' }
    return PLATFORM_SCOPE
  }
  return { type: 'user', userId }
}

export function ownerScopeFromRequest(req, usersRepo = null) {
  const rec = req?.apiKeyRecord || null
  // 面板会话没有 apiKeyRecord，必须按会话角色收窄，否则租户会落到平台池
  if (!rec && req?.panelUser && req?.apiKeyKind !== 'master') {
    const role = String(req.panelRole || '')
      .trim()
      .toLowerCase()
    if (role === 'admin' || role === 'super') return PLATFORM_SCOPE
    const userId = normalizeOwnerId(req.panelUserId)
    return userId ? { type: 'user', userId } : { type: 'none' }
  }
  if (req?.apiKeyKind !== 'master' && normalizeOwnerId(rec?.owner_id)) {
    return ownerScopeFromApiKey(rec, { apiKeyKind: req?.apiKeyKind })
  }
  let ownerRole = null
  const userId = normalizeOwnerId(rec?.user_id)
  if (userId) {
    ownerRole = resolveOwnerUserSync(req, userId, usersRepo)?.role || null
  }
  return ownerScopeFromApiKey(rec, { apiKeyKind: req?.apiKeyKind, ownerRole })
}

/**
 * Slot an operator pinned with `x-kin-vm`. The master key may pin, and so may a managed key
 * whose owner is an admin, so operator test traffic can carry a user in the usage log.
 * Any other caller's header is ignored. The pin never widens what the key can reach.
 */
export function pinnedVmIdFromRequest(req, usersRepo = null) {
  const pin = String(req?.headers?.['x-kin-vm'] || '').trim()
  if (!isValidVmId(pin)) return null
  if (req?.apiKeyKind === 'master') return pin
  const userId = normalizeOwnerId(req?.apiKeyRecord?.user_id)
  if (req?.apiKeyKind !== 'managed' || !userId) return null
  const owner = resolveOwnerUserSync(req, userId, usersRepo)
  return isAdminRole(owner?.role) ? pin : null
}

export function vmMatchesOwnerScope(vm, scope = PLATFORM_SCOPE) {
  return ownerMatchesScope(vmOwnerId(vm), scope)
}

export function endpointMatchesOwnerScope(endpoint, scope = PLATFORM_SCOPE) {
  return ownerMatchesScope(endpointOwnerId(endpoint), scope)
}

export function geminiEnvMatchesOwnerScope(envOwnerId, scope = PLATFORM_SCOPE) {
  return ownerMatchesScope(envOwnerId, scope)
}

export function filterVmsForPanel(vms, { role, userId } = {}) {
  if (role === 'admin' || role === 'super') return vms
  const owner = normalizeOwnerId(userId)
  if (!owner) return []
  return (vms || []).filter((vm) => vmOwnerId(vm) === owner)
}

export function countUserCreatedVms(vms, userId) {
  const owner = normalizeOwnerId(userId)
  if (!owner) return 0
  return (vms || []).filter((vm) => vmOwnerId(vm) === owner && vmOriginOf(vm) === VM_ORIGIN.userCreated).length
}

export function canBindProxyToVm(proxy, vm, { role } = {}) {
  const pOwner = proxyOwnerId(proxy)
  const vOwner = vmOwnerId(vm)
  const r = String(role || '')
    .trim()
    .toLowerCase()
  if (r === 'user') return !!(pOwner && vOwner && pOwner === vOwner)
  // admin/super: user proxies stay off the platform pool
  if (pOwner && !vOwner) return false
  return true
}

export function assignOriginForOwner(ownerUserId, { previousOrigin = VM_ORIGIN.platform, actorRole = 'admin' } = {}) {
  const owner = normalizeOwnerId(ownerUserId)
  if (!owner) return VM_ORIGIN.platform
  if (actorRole === 'user') return VM_ORIGIN.userCreated
  if (previousOrigin === VM_ORIGIN.userCreated) return VM_ORIGIN.userCreated
  return VM_ORIGIN.adminAssigned
}
