/**
 * Managed-key schedule scope.
 * group_type all schedules every VM. anthropic/openai only schedule the checked VMs of that platform.
 * vm_pool_id schedules the pool's current members instead of a copied allowlist.
 * group_id (coding/other) is a rate multiplier and is not this field.
 */
import { isDbOpen, getDb } from '../db/database.mjs'
import { VmPoolsRepo } from '../db/repos/vm-pools-repo.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import {
  PLATFORM_SCOPE,
  endpointMatchesOwnerScope,
  geminiEnvMatchesOwnerScope,
  normalizeOwnerId,
  vmMatchesOwnerScope,
} from './resource-owner.mjs'

export const KEY_PERMISSION_TIERS = Object.freeze(['platform', 'tenant', 'resource'])
export const KEY_CATEGORIES = Object.freeze(['oauth', 'api', 'all'])

const POOL_DENIAL = {
  missing: '账号池不存在',
  disabled: '账号池已停用',
  empty: '账号池没有槽位',
}

export function vmGroupType(vm) {
  return isCodexVm(vm) ? 'openai' : 'anthropic'
}

export function parseAllowedVms(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((id) => String(id || '').trim()).filter(Boolean))]
  }
  if (value == null || value === '') return []
  const text = String(value).trim()
  if (!text) return []
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) return parseAllowedVms(parsed)
    } catch {
      return []
    }
  }
  return [
    ...new Set(
      text
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ]
}

/** Empty uses fallback; an unsupported platform returns null. */
export function normalizeGroupType(value, { fallback = 'all' } = {}) {
  if (value == null || value === '') return fallback
  if (value === 'pool') return null
  const v = String(value).trim().toLowerCase()
  if (v === 'all') return 'all'
  if (v === 'anthropic' || v === 'claude') return 'anthropic'
  if (v === 'openai' || v === 'gpt' || v === 'codex') return 'openai'
  if (v === 'gemini') return 'gemini'
  return null
}

function parsePoolId(value) {
  if (value == null || value === '') return null
  const id = String(value).trim()
  if (!/^pool_[a-f0-9]{8}$/.test(id)) {
    throw Object.assign(new Error('账号池 id 无效'), { code: 'invalid_vm_pool_id' })
  }
  return id
}

function poolIdOf(value) {
  const id = String(value || '').trim()
  return /^pool_[a-f0-9]{8}$/.test(id) ? id : null
}

export function normalizeKeyCategory(value, { fallback = 'oauth' } = {}) {
  if (value == null || value === '') return fallback
  const v = String(value).trim().toLowerCase()
  if (v === 'oauth' || v === 'api' || v === 'all') return v
  return null
}

export function normalizePermissionTier(value, { fallback = 'platform' } = {}) {
  if (value == null || value === '') return fallback
  const v = String(value).trim().toLowerCase()
  if (KEY_PERMISSION_TIERS.includes(v)) return v
  return null
}

export function parseAllowedIds(value) {
  return parseAllowedVms(value)
}

export function keyScopeFromRecord(rec) {
  if (!rec) return { group_type: 'all', allowed_vms: [], vm_pool_id: null }
  const group_type = normalizeGroupType(rec.group_type) || 'all'
  const vm_pool_id = group_type === 'gemini' ? null : poolIdOf(rec.vm_pool_id)
  const tier = normalizePermissionTier(rec.permission_tier, { fallback: 'platform' })
  const pinnedVms = parseAllowedVms(rec.allowed_vms)
  const keepAllVms = tier === 'resource' && group_type === 'all' && pinnedVms.length > 0
  return {
    group_type,
    allowed_vms: vm_pool_id || group_type === 'gemini' || (group_type === 'all' && !keepAllVms) ? [] : pinnedVms,
    vm_pool_id,
  }
}

function defaultPoolLookup(id) {
  if (!isDbOpen()) return null
  return new VmPoolsRepo(getDb()).get(id)
}

/** Live membership. A missing, disabled, or empty pool never widens to the global set. */
export function applyVmPool(scope, lookup = defaultPoolLookup) {
  if (!scope?.vm_pool_id) return scope
  const pool = lookup?.(scope.vm_pool_id) || null
  if (!pool) return { ...scope, allowed_vms: [], vm_pool_error: 'missing' }
  if (!pool.enabled) return { ...scope, allowed_vms: [], vm_pool_error: 'disabled' }
  const ids = Array.isArray(pool.vm_ids) ? pool.vm_ids.map((id) => String(id || '').trim()).filter(Boolean) : []
  if (!ids.length) return { ...scope, allowed_vms: [], vm_pool_error: 'empty' }
  return { ...scope, allowed_vms: ids, vm_pool_error: null }
}

export function keyScopeFromRequest(req, lookup = defaultPoolLookup) {
  if (!req || req.apiKeyKind === 'master') return { group_type: 'all', allowed_vms: [], vm_pool_id: null }
  return applyVmPool(keyScopeFromRecord(req.apiKeyRecord), lookup)
}

export function vmPoolDenial(scope) {
  if (!scope?.vm_pool_error) return null
  return {
    code: 'vm_pool_unavailable',
    message: POOL_DENIAL[scope.vm_pool_error] || '账号池不可用',
  }
}

export function keyAllowsVm(scope, vm) {
  if (scope?.group_type === 'gemini') return false
  if (scope?.vm_pool_id) {
    if (scope.vm_pool_error) return false
    if (!vm?.id || !(scope.allowed_vms || []).includes(vm.id)) return false
    const group = scope.group_type || 'all'
    if (group !== 'all' && vmGroupType(vm) !== group) return false
    return true
  }
  const group = scope?.group_type || 'all'
  const pinned = Array.isArray(scope?.allowed_vms) ? scope.allowed_vms : []
  if (scope?.permission_tier === 'resource') {
    if (!vm?.id || !pinned.length) return false
    if (group !== 'all' && vmGroupType(vm) !== group) return false
    return pinned.includes(vm.id)
  }
  if (group === 'all') {
    if (pinned.length > 0) return !!vm?.id && pinned.includes(vm.id)
    return true
  }
  if (!vm?.id) return false
  if (vmGroupType(vm) !== group) return false
  if (scope?.permission_tier === 'tenant' && pinned.length === 0) return true
  return pinned.includes(vm.id)
}

/**
 * Write-side scope. Unknown group_type throws instead of widening to all.
 * partial + neither field → null (leave the row alone).
 * A named pool replaces the copied allowlist. An explicit platform list
 * clears a previously bound pool. Does not check that the VM or pool exists.
 */
export function normalizeKeyScope(input = {}, { partial = false, current = null, isApi = false } = {}) {
  const hasType = input.group_type != null && input.group_type !== ''
  const hasVms = input.allowed_vms != null
  const hasPool = Object.prototype.hasOwnProperty.call(input, 'vm_pool_id')
  const base = current ? keyScopeFromRecord(current) : { group_type: 'all', allowed_vms: [], vm_pool_id: null }
  let group_type = !partial && !hasType ? 'all' : base.group_type
  if (hasType) {
    const parsed = normalizeGroupType(input.group_type, { fallback: null })
    if (!parsed) {
      throw Object.assign(new Error('group_type 只能是 all、anthropic、openai 或 gemini'), {
        code: 'invalid_group_type',
      })
    }
    group_type = parsed
  }
  const apiMode =
    isApi ||
    String(input.category || current?.category || '')
      .trim()
      .toLowerCase() === 'api'
  const mixedMode =
    String(input.category || current?.category || '')
      .trim()
      .toLowerCase() === 'all'
  const effectiveTier = normalizePermissionTier(input.permission_tier ?? current?.permission_tier, {
    fallback: 'platform',
  })
  if (group_type === 'gemini') {
    if (apiMode || (hasVms && parseAllowedVms(input.allowed_vms).length) || (hasPool && input.vm_pool_id)) {
      throw Object.assign(new Error('Gemini 密钥只能使用宿主机 OAuth 池，不能绑定 VM、账号池或 API 渠道'), {
        code: 'invalid_gemini_key_scope',
      })
    }
    return { group_type, allowed_vms: [], vm_pool_id: null }
  }
  if (partial && !hasType && !hasVms && !hasPool) return null
  let allowed_vms = hasVms ? parseAllowedVms(input.allowed_vms) : !partial && !hasType ? [] : base.allowed_vms
  let vm_pool_id = hasPool ? parsePoolId(input.vm_pool_id) : base.vm_pool_id
  if (apiMode) {
    return { group_type, allowed_vms: [], vm_pool_id: null }
  }
  const manual = (hasType && group_type !== 'all') || (hasVms && allowed_vms.length > 0)
  if (!hasPool && manual) vm_pool_id = null
  if (vm_pool_id) {
    return { group_type, allowed_vms: [], vm_pool_id }
  }
  if (group_type === 'all' && effectiveTier !== 'resource') allowed_vms = []
  const allowTenantEmptyVms =
    effectiveTier === 'tenant' && Boolean(normalizeOwnerId(input.owner_id ?? current?.owner_id))
  if (group_type !== 'all' && allowed_vms.length === 0 && !allowTenantEmptyVms && !mixedMode) {
    throw Object.assign(new Error('选择 anthropic 或 openai 时至少勾选一台 VM'), { code: 'key_vms_required' })
  }
  return { group_type, allowed_vms, vm_pool_id: null }
}

/** Panel check: every id is a live VM of the chosen platform. Pool membership is checked separately. */
export function assertVmScope(vms, scope) {
  if (!scope || scope.group_type === 'gemini' || scope.vm_pool_id) return []
  if (scope.group_type === 'all' && !(scope.allowed_vms || []).length) return []
  const byId = new Map((vms || []).map((vm) => [vm.id, vm]))
  for (const id of scope.allowed_vms) {
    const vm = byId.get(id)
    if (!vm) throw Object.assign(new Error('所选 VM 不存在'), { code: 'key_vm_unknown' })
    if (scope.group_type !== 'all' && vmGroupType(vm) !== scope.group_type) {
      throw Object.assign(new Error('所选 VM 不属于该分组'), { code: 'key_vm_mismatch' })
    }
  }
  return scope.allowed_vms
}

/**
 * Multi-tier key policy decoder (SSOT).
 * Combines tier (`platform` | `tenant` | `resource`), owner binding (`owner_id`),
 * category (`oauth` | `api` | `all`), and per-service resource pins.
 */
export function keyTierPolicyFromRecord(rec) {
  if (!rec) {
    return {
      permission_tier: 'platform',
      owner_id: null,
      category: 'oauth',
      group_type: 'all',
      allowed_vms: [],
      vm_pool_id: null,
      api_endpoint_id: null,
      allowed_endpoints: [],
      allowed_gemini_envs: [],
    }
  }
  const owner_id = normalizeOwnerId(rec.owner_id)
  const category = normalizeKeyCategory(rec.category, { fallback: 'oauth' }) || 'oauth'
  const group_type = normalizeGroupType(rec.group_type, { fallback: 'all' }) || 'all'
  const vm_pool_id = group_type === 'gemini' ? null : poolIdOf(rec.vm_pool_id)
  const allowed_vms = vm_pool_id || group_type === 'gemini' ? [] : parseAllowedIds(rec.allowed_vms)
  const api_endpoint_id = category === 'api' || category === 'all' ? normalizeOwnerId(rec.api_endpoint_id) : null
  let allowed_endpoints = category === 'api' || category === 'all' ? parseAllowedIds(rec.allowed_endpoints) : []
  if (api_endpoint_id) {
    allowed_endpoints = allowed_endpoints.length
      ? allowed_endpoints.filter((id) => id === api_endpoint_id)
      : [api_endpoint_id]
  }
  const allowed_gemini_envs =
    category === 'api' || (group_type !== 'gemini' && group_type !== 'all')
      ? []
      : parseAllowedIds(rec.allowed_gemini_envs)

  const explicitTier = normalizePermissionTier(rec.permission_tier, { fallback: null })
  let permission_tier = explicitTier
  if (!permission_tier) {
    permission_tier = owner_id ? 'tenant' : 'platform'
  }
  // If a record has an explicit owner_id but legacy default 'platform', narrow to 'tenant' (fail-safe).
  if (owner_id && permission_tier === 'platform') {
    permission_tier = 'tenant'
  }
  return {
    permission_tier,
    owner_id,
    category,
    group_type,
    allowed_vms: permission_tier === 'resource' || group_type !== 'all' ? allowed_vms : [],
    vm_pool_id,
    api_endpoint_id,
    allowed_endpoints,
    allowed_gemini_envs,
  }
}

export function keyAllowsEndpoint(policy, endpoint) {
  if (!endpoint?.id || endpoint.disabled) return false
  if (policy?.api_endpoint_id && endpoint.id !== policy.api_endpoint_id) return false
  const allowed = Array.isArray(policy?.allowed_endpoints) ? policy.allowed_endpoints : []
  if (policy?.permission_tier === 'resource') {
    if (!policy.api_endpoint_id && allowed.length === 0) return false
  }
  if (allowed.length > 0 && !allowed.includes(endpoint.id)) return false
  return true
}

export function keyAllowsGeminiEnv(policy, envId) {
  const id = String(envId || '').trim()
  if (!id) return false
  const group = policy?.group_type || 'all'
  if (group !== 'gemini' && group !== 'all') return false
  const allowed = Array.isArray(policy?.allowed_gemini_envs) ? policy.allowed_gemini_envs : []
  if (policy?.permission_tier === 'resource') {
    if (allowed.length === 0) return false
    return allowed.includes(id)
  }
  if (allowed.length > 0) return allowed.includes(id)
  return true
}

/**
 * Validate write-side multi-tier permission fields.
 */
export function normalizeMultiTierKeyConfig(input = {}, { partial = false, current = null } = {}) {
  const cur = current ? keyTierPolicyFromRecord(current) : keyTierPolicyFromRecord(null)
  const hasTier =
    Object.prototype.hasOwnProperty.call(input, 'permission_tier') &&
    input.permission_tier != null &&
    input.permission_tier !== ''
  const hasOwner = Object.prototype.hasOwnProperty.call(input, 'owner_id')
  const hasCat =
    Object.prototype.hasOwnProperty.call(input, 'category') && input.category != null && input.category !== ''
  const hasEndpoints = Object.prototype.hasOwnProperty.call(input, 'allowed_endpoints')
  const hasGemini = Object.prototype.hasOwnProperty.call(input, 'allowed_gemini_envs')

  const category = hasCat ? normalizeKeyCategory(input.category, { fallback: null }) : cur.category
  if (!category) {
    throw Object.assign(new Error('category 只能是 oauth、api 或 all'), { code: 'invalid_key_category' })
  }

  const owner_id = hasOwner ? normalizeOwnerId(input.owner_id) : cur.owner_id
  let permission_tier = hasTier
    ? normalizePermissionTier(input.permission_tier, { fallback: null })
    : partial
      ? cur.permission_tier
      : owner_id
        ? 'tenant'
        : 'platform'
  if (!permission_tier) {
    throw Object.assign(new Error('permission_tier 只能是 platform、tenant 或 resource'), {
      code: 'invalid_permission_tier',
    })
  }
  if (permission_tier === 'platform' && owner_id) {
    if (hasTier) {
      throw Object.assign(new Error('platform 层级密钥不能绑定租户 owner_id'), {
        code: 'invalid_permission_tier',
      })
    }
    permission_tier = 'tenant'
  }
  if (permission_tier === 'tenant' && !owner_id && !normalizeOwnerId(input.user_id ?? current?.user_id)) {
    throw Object.assign(new Error('tenant 层级密钥必须指定 owner_id'), { code: 'key_owner_required' })
  }

  const allowed_endpoints =
    category === 'oauth' ? [] : hasEndpoints ? parseAllowedIds(input.allowed_endpoints) : cur.allowed_endpoints
  const allowed_gemini_envs =
    category === 'api' ? [] : hasGemini ? parseAllowedIds(input.allowed_gemini_envs) : cur.allowed_gemini_envs

  return {
    permission_tier,
    owner_id,
    category,
    allowed_endpoints,
    allowed_gemini_envs,
  }
}

/**
 * Enforce strict two-way owner isolation at key creation / patch time:
 *  - A tenant/supplier key can ONLY bind VMs, official API endpoints, and Gemini envs it owns.
 *  - A platform/admin key can ONLY bind platform-owned resources (never tenant/supplier resources).
 */
export function assertKeyResourceOwnership({
  vms = [],
  endpoints = [],
  geminiOwnerMap = null,
  policy,
  ownerScope = PLATFORM_SCOPE,
} = {}) {
  if (!policy) return
  if (policy.permission_tier === 'resource') {
    const hasAnyPin =
      (policy.allowed_vms?.length || 0) > 0 ||
      Boolean(policy.vm_pool_id) ||
      Boolean(policy.api_endpoint_id) ||
      (policy.allowed_endpoints?.length || 0) > 0 ||
      (policy.allowed_gemini_envs?.length || 0) > 0
    if (!hasAnyPin) {
      throw Object.assign(new Error('resource 层级密钥必须至少绑定一个 VM、API 渠道或 Gemini 环境'), {
        code: 'key_resources_required',
        status: 400,
      })
    }
  }

  if (policy.allowed_vms?.length) {
    const vmById = new Map((vms || []).map((v) => [v.id, v]))
    for (const id of policy.allowed_vms) {
      const vm = vmById.get(id)
      if (!vm) {
        throw Object.assign(new Error(`所选 VM 不存在: ${id}`), { code: 'key_vm_unknown', status: 400 })
      }
      if (!vmMatchesOwnerScope(vm, ownerScope)) {
        throw Object.assign(new Error(`无权绑定非本归属域的 VM: ${id}`), {
          code: 'scope_owner_mismatch',
          status: 403,
        })
      }
    }
  }

  const epIds = new Set(policy.allowed_endpoints || [])
  if (policy.api_endpoint_id) epIds.add(policy.api_endpoint_id)
  if (epIds.size > 0) {
    const epById = new Map((endpoints || []).map((e) => [e.id, e]))
    for (const id of epIds) {
      const ep = epById.get(id)
      if (!ep) {
        throw Object.assign(new Error(`所选 API 渠道不存在: ${id}`), {
          code: 'api_endpoint_unavailable',
          status: 400,
        })
      }
      if (!endpointMatchesOwnerScope(ep, ownerScope)) {
        throw Object.assign(new Error(`无权绑定非本归属域的 API 渠道: ${id}`), {
          code: 'scope_owner_mismatch',
          status: 403,
        })
      }
    }
  }

  if (policy.allowed_gemini_envs?.length && geminiOwnerMap) {
    for (const envId of policy.allowed_gemini_envs) {
      const envOwner = geminiOwnerMap.get(envId) ?? null
      if (!geminiEnvMatchesOwnerScope(envOwner, ownerScope)) {
        throw Object.assign(new Error(`无权绑定非本归属域的 Gemini 环境: ${envId}`), {
          code: 'scope_owner_mismatch',
          status: 403,
        })
      }
    }
  }
}
