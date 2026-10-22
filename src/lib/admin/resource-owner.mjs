/**
 * Tenant ownership for VMs, proxies, and /v1 dispatch.
 * vm.json is SSOT for VM owner/origin; this module is the only decoder.
 */

export const VM_ORIGIN = {
  platform: 'platform',
  adminAssigned: 'admin_assigned',
  userCreated: 'user_created',
}

export const PLATFORM_SCOPE = Object.freeze({ type: 'platform' })

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

export function ownerScopeFromApiKey(record, { apiKeyKind = null, ownerRole = null } = {}) {
  if (apiKeyKind === 'master') return PLATFORM_SCOPE
  const userId = normalizeOwnerId(record?.user_id)
  if (!userId) return PLATFORM_SCOPE
  const role = String(ownerRole || '')
    .trim()
    .toLowerCase()
  if (role === 'admin' || role === 'super') return PLATFORM_SCOPE
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
  let ownerRole = null
  const userId = normalizeOwnerId(rec?.user_id)
  if (userId && usersRepo?.getById) {
    try {
      ownerRole = usersRepo.getById(userId)?.role || null
    } catch {
      ownerRole = null
    }
  }
  return ownerScopeFromApiKey(rec, { apiKeyKind: req?.apiKeyKind, ownerRole })
}

export function vmMatchesOwnerScope(vm, scope = PLATFORM_SCOPE) {
  const type = scope?.type || 'platform'
  if (type === 'any') return true
  const owner = vmOwnerId(vm)
  if (type === 'platform') return !owner
  if (type === 'user') return owner === normalizeOwnerId(scope.userId)
  return false
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
