/**
 * Managed-key schedule scope.
 * group_type all schedules every VM. anthropic/openai only schedule the checked VMs of that platform.
 * vm_pool_id schedules the pool's current members instead of a copied allowlist.
 * group_id (coding/other) is a rate multiplier and is not this field.
 */
import { DB_INSTANCE_ID, isDbOpen, getDb } from '../db/database.mjs'
import { getCacheRuntime } from '../cache/index.mjs'
import { SchedulerPoolsRepo } from '../db/repos/scheduler-pools-repo.mjs'
import { VmPoolsRepo } from '../db/repos/vm-pools-repo.mjs'
import { resolveUpstreamModel, stripAntigravityPrefix } from '../gemini/model-catalog.mjs'
import { endpointMatchesModel, stripPrefix } from '../pool/api-scheduler.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { modelMatchesAllowlist } from '../pool/slot-model-gate.mjs'
import { keyAllowsModel, parseKeyAllowedModels } from './key-models.mjs'
import {
  PLATFORM_SCOPE,
  endpointMatchesOwnerScope,
  geminiEnvMatchesOwnerScope,
  normalizeOwnerId,
  ownerScopeFromApiKey,
  vmMatchesOwnerScope,
} from './resource-owner.mjs'

export const KEY_PERMISSION_TIERS = Object.freeze(['platform', 'tenant', 'resource'])
export const KEY_CATEGORIES = Object.freeze(['oauth', 'api', 'all'])
export const POOL_BINDING_MODES = Object.freeze(['strict_pool', 'legacy_scope'])

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
  if (KEY_CATEGORIES.includes(v)) return v
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

const cachedSchedPoolsRepos = new WeakMap()
const cachedVmPoolsRepos = new WeakMap()

function getSchedPoolsRepo(db) {
  let repo = cachedSchedPoolsRepos.get(db)
  if (!repo) {
    repo = new SchedulerPoolsRepo(db)
    cachedSchedPoolsRepos.set(db, repo)
  }
  return repo
}

function getVmPoolsRepo(db) {
  let repo = cachedVmPoolsRepos.get(db)
  if (!repo) {
    repo = new VmPoolsRepo(db)
    cachedVmPoolsRepos.set(db, repo)
  }
  return repo
}

function poolEntityScopePrefix(db) {
  if (isDbOpen() && db === getDb()) return ''
  return `${db?.[DB_INSTANCE_ID] || 'isolated'}:`
}

function shouldUsePoolAccessCache(poolsRepo, useCache) {
  if (typeof useCache === 'boolean') return useCache
  const cache = getCacheRuntime()
  if (!cache?.client?.enabled) return false
  if (!poolsRepo) return isDbOpen()
  if (!poolsRepo.db) return false
  return poolsRepo.db.engine === 'postgres' || cache.client.hasRedis
}

function defaultPoolLookup(id) {
  if (!isDbOpen()) return null
  const db = getDb()
  const load = () => {
    try {
      const schedPool = getSchedPoolsRepo(db).get(id)
      if (schedPool) {
        return {
          id: schedPool.id,
          name: schedPool.name,
          enabled: schedPool.enabled,
          vm_ids: (schedPool.members || [])
            .filter((m) => m.enabled !== false && (m.node_type === 'claude_vm' || m.node_type === 'codex_vm'))
            .map((m) => m.node_id),
        }
      }
    } catch {
      // Databases before migration 071 fall back to vm_pools.
    }
    return getVmPoolsRepo(db).get(id)
  }
  const cache = getCacheRuntime()
  if (cache?.client?.enabled && (db.engine === 'postgres' || cache.client.hasRedis)) {
    return cache.entity.getPoolAccessSync(`vmpool:${id}`, load)
  }
  return load()
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
      Boolean(policy.default_pool_id) ||
      (policy.allowed_pool_ids?.length || 0) > 0 ||
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

export function normalizePoolBindingMode(value, { fallback = 'legacy_scope' } = {}) {
  if (value == null || value === '') return fallback
  const v = String(value).trim().toLowerCase()
  if (POOL_BINDING_MODES.includes(v)) return v
  return null
}

/**
 * Validate and normalize panel API key pool binding fields (`pool_binding_mode`,
 * `default_pool_id`, `allowed_pool_ids`, plus legacy `vm_pool_id` alias).
 */
export function normalizeKeyPoolBindingInput(body = {}, { current = null, poolsRepo = null, partial = false } = {}) {
  const obj = body && typeof body === 'object' ? body : {}
  const hasMode = Object.prototype.hasOwnProperty.call(obj, 'pool_binding_mode')
  const hasDefault = Object.prototype.hasOwnProperty.call(obj, 'default_pool_id')
  const hasAllowed = Object.prototype.hasOwnProperty.call(obj, 'allowed_pool_ids')
  const hasLegacyPool = Object.prototype.hasOwnProperty.call(obj, 'vm_pool_id')
  if (partial && !hasMode && !hasDefault && !hasAllowed && !hasLegacyPool) {
    return null
  }

  const curBindings = current?.id && poolsRepo ? poolsRepo.listBindingsByKey(current.id).map((b) => b.pool_id) : []
  const curDefault = String(current?.default_pool_id || current?.vm_pool_id || '').trim() || (curBindings[0] ?? null)
  const curMode = normalizePoolBindingMode(current?.pool_binding_mode, { fallback: 'legacy_scope' }) || 'legacy_scope'

  const mode = hasMode
    ? normalizePoolBindingMode(obj.pool_binding_mode, { fallback: null })
    : partial
      ? curMode
      : 'legacy_scope'
  if (!mode) {
    throw Object.assign(new Error('pool_binding_mode 只能是 strict_pool 或 legacy_scope'), {
      code: 'invalid_pool_binding_mode',
      status: 400,
    })
  }

  const rawDefault = hasDefault ? obj.default_pool_id : hasLegacyPool ? obj.vm_pool_id : partial ? curDefault : null
  let default_pool_id = rawDefault == null || String(rawDefault).trim() === '' ? null : String(rawDefault).trim()

  let allowed_pool_ids = hasAllowed ? parseAllowedIds(obj.allowed_pool_ids) : partial ? [...curBindings] : []

  if (hasLegacyPool && !hasAllowed && !hasDefault) {
    // Legacy single-pool update: replace allowed_pool_ids with the single legacy vm_pool_id.
    allowed_pool_ids = default_pool_id ? [default_pool_id] : []
  }

  if (default_pool_id && !allowed_pool_ids.includes(default_pool_id)) {
    allowed_pool_ids = [default_pool_id, ...allowed_pool_ids]
  }
  if (!default_pool_id && allowed_pool_ids.length > 0) {
    default_pool_id = allowed_pool_ids[0]
  }

  if (mode === 'strict_pool' && !default_pool_id && allowed_pool_ids.length === 0) {
    throw Object.assign(new Error('strict_pool 模式下必须至少绑定一个分组池'), {
      code: 'pool_binding_required',
      status: 400,
    })
  }

  if (poolsRepo && allowed_pool_ids.length > 0) {
    for (const pid of allowed_pool_ids) {
      if (!poolsRepo.get(pid)) {
        throw Object.assign(new Error(`分组池不存在: ${pid}`), { code: 'pool_not_found', status: 400, pool_id: pid })
      }
    }
  }

  return {
    pool_binding_mode: mode,
    default_pool_id,
    allowed_pool_ids,
    vm_pool_id: default_pool_id,
  }
}

function inferModelFamilyForMemberCheck(model) {
  const m = String(model || '')
    .trim()
    .toLowerCase()
    .replace(/^models\//, '')
  if (!m) return 'unknown'
  if (m.startsWith('ag-')) return 'gemini'
  if (m.startsWith('claude')) return 'claude'
  if (m.startsWith('gemini') || m.startsWith('imagen') || m.startsWith('veo') || m.startsWith('gemma')) {
    return 'gemini'
  }
  if (m.startsWith('gpt-') || m.startsWith('chatgpt-') || m.startsWith('codex') || /^o[134](?:-|$)/.test(m)) {
    return 'openai'
  }
  return 'unknown'
}

function endpointServesModel(ep, model) {
  const raw = String(model || '').trim()
  if (!raw) return true
  if (ep?.disabled) return false

  const stripped = stripPrefix(raw, ep?.prefix)
    .replace(/^models\//i, '')
    .trim()
    .toLowerCase()
  if (!stripped) return true
  const models = Array.isArray(ep?.models) ? ep.models : []
  if (models.length > 0) {
    const explicitHit = models.some((m) => {
      const alias = String(m?.alias || '')
        .trim()
        .toLowerCase()
      const name = String(m?.name || '')
        .trim()
        .toLowerCase()
      const upstream = String(m?.upstream_name || '')
        .trim()
        .toLowerCase()
      return (alias && alias === stripped) || (name && name === stripped) || (upstream && upstream === stripped)
    })
    if (explicitHit) return true
  }

  const fam = inferModelFamilyForMemberCheck(stripped)
  if (ep?.kind === 'claude') {
    if (fam === 'openai' || fam === 'gemini') return false
    return endpointMatchesModel(ep, raw)
  }
  if (ep?.kind === 'openai') {
    if (fam === 'claude' || fam === 'gemini') return false
    return endpointMatchesModel(ep, raw)
  }

  if (endpointMatchesModel(ep, raw)) return true
  return models.length === 0
}

function geminiEnvServesModel(env, model, { allowUnprefixedGemini3p = false } = {}) {
  const rawModels = Array.isArray(env?.models)
    ? env.models.map((x) => (typeof x === 'string' ? x : String(x?.id ?? x?.name ?? ''))).filter(Boolean)
    : []
  if (!rawModels.length) return true
  const cleaned = String(model || '')
    .trim()
    .replace(/^models\//i, '')
  if (!cleaned) return true
  if (resolveUpstreamModel(cleaned, rawModels, { allowUnprefixedNonGemini: allowUnprefixedGemini3p })) {
    return true
  }
  const wantLower = cleaned.toLowerCase()
  const wantStripped = stripAntigravityPrefix(cleaned).toLowerCase()
  const hadAgPrefix = wantLower.startsWith('ag-')
  return rawModels.some((entry) => {
    const eLower = String(entry || '')
      .trim()
      .replace(/^models\//i, '')
      .toLowerCase()
    if (!eLower) return false
    if (eLower === wantLower) return true
    const eStripped = stripAntigravityPrefix(eLower)
    if (hadAgPrefix && eStripped === wantStripped) return true
    if (allowUnprefixedGemini3p && eStripped === wantStripped) return true
    return false
  })
}

function memberServesModel(member, model, { vmById, geminiById, epById, allowUnprefixedGemini3p = false } = {}) {
  const family = inferModelFamilyForMemberCheck(model)
  if (member.node_type === 'claude_vm') {
    if (family === 'openai' || family === 'gemini') return false
    const vm = vmById?.get(member.node_id)
    if (vm?.policy?.allowed_models?.length && !modelMatchesAllowlist(model, vm.policy.allowed_models)) {
      return false
    }
    return true
  }
  if (member.node_type === 'codex_vm') {
    if (family === 'claude' || family === 'gemini') return false
    const vm = vmById?.get(member.node_id)
    if (vm?.policy?.allowed_models?.length && !modelMatchesAllowlist(model, vm.policy.allowed_models)) {
      return false
    }
    return true
  }
  if (member.node_type === 'gemini_env') {
    if (!allowUnprefixedGemini3p && (family === 'claude' || family === 'openai')) return false
    const env = geminiById?.get(member.node_id)
    return geminiEnvServesModel(env, model, { allowUnprefixedGemini3p })
  }
  if (member.node_type === 'api_endpoint') {
    const ep = epById?.get(member.node_id)
    if (!ep) return true
    return endpointServesModel(ep, model)
  }
  return true
}

function buildGeminiLookup(geminiEnvs, geminiOwnerMap) {
  const hasEnvs = Array.isArray(geminiEnvs)
  const byId = new Map()
  if (hasEnvs) {
    for (const item of geminiEnvs) {
      if (typeof item === 'string') {
        const id = item.trim()
        if (id) byId.set(id, { id, enabled: true, owner_user_id: geminiOwnerMap?.get(id) ?? null })
      } else if (item && typeof item === 'object') {
        const id = String(item.id ?? item.env_id ?? item.name ?? '').trim()
        if (id) {
          byId.set(id, {
            ...item,
            id,
            enabled: item.enabled !== false,
            owner_user_id: item.owner_user_id ?? geminiOwnerMap?.get(id) ?? null,
          })
        }
      }
    }
  }
  return { hasEnvs, byId }
}

/**
 * Unified Fail-Closed pool authorization and effective pool resolution for an API key.
 *
 * - `legacy_scope` keys with no pool bindings, no `requestedPoolId`, and no trusted
 *   JEV downgrade pool return `{ ok: true, legacy: true, effectivePool: null }` to
 *   preserve 100% backward compatibility with legacy key scoping.
 * - `strict_pool` keys (and any key bound to or requesting a pool) fail closed with
 *   `403 pool_forbidden` (out-of-scope `X-VM2API-Pool`) or `403 pool_unavailable`
 *   (missing/disabled/empty pool or empty owner/model intersection).
 * - System-trusted `jevDowngradePoolId` (`isTrustedDowngrade === true`) validates
 *   that the target pool is enabled and trusted (`pool_role === 'downgrade'` or in
 *   `trustedDowngradePoolIds`), exempting ONLY the `allowed_pool_ids` whitelist while
 *   keeping owner isolation and `allowed_models` intersection enforced.
 */
export function resolvePoolAccessForKey({
  key = null,
  apiKeyKind = null,
  requestedPoolId = null,
  jevDowngradePoolId = null,
  isTrustedDowngrade = false,
  trustedDowngradePoolIds = null,
  model = null,
  poolsRepo = null,
  vms = null,
  geminiEnvs = null,
  geminiOwnerMap = null,
  apiEndpoints = null,
  ownerScope = null,
  useCache = null,
} = {}) {
  const repo = poolsRepo || (isDbOpen() ? getSchedPoolsRepo(getDb()) : null)
  const cacheEnabled = Boolean(repo && shouldUsePoolAccessCache(poolsRepo, useCache))
  const scopePrefix = cacheEnabled ? poolEntityScopePrefix(repo.db) : ''
  const entityCache = cacheEnabled ? getCacheRuntime().entity : null
  const loadPoolById = (poolId) => {
    if (!poolId || !repo?.get) return null
    if (!entityCache) return repo.get(poolId) || null
    return entityCache.getPoolAccessSync(`${scopePrefix}pool:${poolId}`, () => repo.get(poolId) || null)
  }
  const isMaster = apiKeyKind === 'master' || !key
  const reqPool = requestedPoolId == null ? null : String(requestedPoolId).trim() || null
  const downgradeId =
    isTrustedDowngrade === true && jevDowngradePoolId != null ? String(jevDowngradePoolId).trim() || null : null
  const trustedSet = new Set(
    trustedDowngradePoolIds ? [...trustedDowngradePoolIds].map((id) => String(id || '').trim()).filter(Boolean) : [],
  )

  const poolBindingMode = !isMaster && key?.pool_binding_mode === 'strict_pool' ? 'strict_pool' : 'legacy_scope'
  const keyAllowedModels = isMaster ? [] : parseKeyAllowedModels(key?.allowed_models)

  let boundRows = []
  if (!isMaster && key?.id && repo) {
    try {
      boundRows = entityCache
        ? entityCache.getPoolAccessSync(`${scopePrefix}bindings:${key.id}`, () => repo.listBindingsByKey(key.id)) || []
        : repo.listBindingsByKey(key.id)
    } catch {
      boundRows = []
    }
  }
  const allowedPoolSet = new Set(boundRows.map((b) => b.pool_id))
  if (!isMaster && Array.isArray(key?.allowed_pool_ids)) {
    for (const pid of key.allowed_pool_ids) {
      const s = String(pid || '').trim()
      if (s) allowedPoolSet.add(s)
    }
  }
  const explicitDefault = !isMaster ? String(key?.default_pool_id || '').trim() || null : null
  const bindingDefault = boundRows.find((b) => b.is_default)?.pool_id || null
  const legacyVmPoolId =
    !isMaster && normalizeGroupType(key?.group_type) !== 'gemini' ? poolIdOf(key?.vm_pool_id) : null
  const defaultPoolId = explicitDefault || bindingDefault || legacyVmPoolId || null
  if (defaultPoolId) allowedPoolSet.add(defaultPoolId)
  const allowedPoolIds = [...allowedPoolSet]

  // Unbound master or legacy_scope key with no pool request and no trusted downgrade -> legacy path.
  if (poolBindingMode === 'legacy_scope' && !reqPool && !downgradeId && !defaultPoolId && allowedPoolIds.length === 0) {
    return {
      ok: true,
      status: 200,
      code: null,
      mode: 'legacy_scope',
      legacy: true,
      isDowngraded: false,
      originPool: null,
      effectivePool: null,
      allowedPoolIds: [],
      allowedMembers: null,
      allowedVmIds: null,
      allowedClaudeVmIds: null,
      allowedCodexVmIds: null,
      allowedGeminiEnvIds: null,
      allowedEndpointIds: null,
      allowedModels: keyAllowedModels,
    }
  }

  // Managed key requesting an explicit pool via X-VM2API-Pool must be authorized.
  if (!isMaster && reqPool && !allowedPoolSet.has(reqPool)) {
    return {
      ok: false,
      status: 403,
      code: 'pool_forbidden',
      reason: 'requested_pool_not_allowed',
      message: 'API 密钥无权访问请求的分组池',
      originPool: null,
      effectivePool: null,
    }
  }

  const originPoolId = reqPool || defaultPoolId || allowedPoolIds[0] || null
  if (poolBindingMode === 'strict_pool' && !originPoolId) {
    return {
      ok: false,
      status: 403,
      code: 'pool_unavailable',
      reason: 'no_pool_bound',
      message: 'API 密钥未绑定可用分组池',
      originPool: null,
      effectivePool: null,
    }
  }

  let originPool = null
  if (originPoolId) {
    originPool = loadPoolById(originPoolId)
    if (!originPool) {
      return {
        ok: false,
        status: 403,
        code: 'pool_unavailable',
        reason: 'missing',
        message: '分组池不存在',
        originPool: null,
        effectivePool: null,
      }
    }
    if (!originPool.enabled) {
      return {
        ok: false,
        status: 403,
        code: 'pool_unavailable',
        reason: 'disabled',
        message: '分组池已停用',
        originPool,
        effectivePool: null,
      }
    }
  }

  let effectivePool = originPool
  let isDowngraded = false
  if (downgradeId) {
    const dp = loadPoolById(downgradeId)
    const isTrustedTarget = Boolean(dp && dp.enabled && (dp.pool_role === 'downgrade' || trustedSet.has(dp.id)))
    if (!isTrustedTarget) {
      return {
        ok: false,
        status: 403,
        code: 'pool_unavailable',
        reason: 'downgrade_pool_untrusted_or_unavailable',
        message: '降级分组池不可用或未受信任',
        originPool,
        effectivePool: null,
      }
    }
    effectivePool = dp
    isDowngraded = true
  }

  if (!effectivePool) {
    return {
      ok: false,
      status: 403,
      code: 'pool_unavailable',
      reason: 'missing',
      message: '分组池不存在',
      originPool: null,
      effectivePool: null,
    }
  }

  const enabledMembers = (effectivePool.members || []).filter((m) => m.enabled !== false)
  if (enabledMembers.length === 0) {
    return {
      ok: false,
      status: 403,
      code: 'pool_unavailable',
      reason: 'empty',
      message: '分组池没有可用成员',
      originPool,
      effectivePool: null,
    }
  }

  const reqModel = model == null ? null : String(model).trim() || null
  if (reqModel && keyAllowedModels.length > 0 && !keyAllowsModel(keyAllowedModels, reqModel)) {
    return {
      ok: false,
      status: 403,
      code: 'pool_unavailable',
      reason: 'model_not_allowed',
      message: `API 密钥不允许使用模型 ${reqModel}`,
      originPool,
      effectivePool: null,
    }
  }

  const effOwnerScope = ownerScope || (isMaster ? PLATFORM_SCOPE : ownerScopeFromApiKey(key, { apiKeyKind }))
  const allowUnprefixedGemini3p = !isMaster && normalizeGroupType(key?.group_type) === 'gemini'
  const hasVms = Array.isArray(vms)
  const vmById = hasVms ? new Map(vms.map((v) => [v.id, v])) : null
  const { hasEnvs, byId: geminiById } = buildGeminiLookup(geminiEnvs, geminiOwnerMap)
  const hasEndpoints = Array.isArray(apiEndpoints)
  const epById = hasEndpoints ? new Map(apiEndpoints.map((e) => [e.id, e])) : null

  const admittedMembers = enabledMembers.filter((m) => {
    // 1. Owner & inventory intersection
    if (m.node_type === 'claude_vm' || m.node_type === 'codex_vm') {
      if (hasVms) {
        const vm = vmById.get(m.node_id)
        if (!vm) return false
        if (!vmMatchesOwnerScope(vm, effOwnerScope)) return false
      }
    } else if (m.node_type === 'gemini_env') {
      if (hasEnvs) {
        const env = geminiById.get(m.node_id)
        if (!env || env.enabled === false) return false
        if (!geminiEnvMatchesOwnerScope(env.owner_user_id ?? null, effOwnerScope)) return false
      } else if (geminiOwnerMap) {
        if (!geminiEnvMatchesOwnerScope(geminiOwnerMap.get(m.node_id) ?? null, effOwnerScope)) return false
      }
    } else if (m.node_type === 'api_endpoint') {
      if (hasEndpoints) {
        const ep = epById.get(m.node_id)
        if (!ep || ep.disabled) return false
        if (!endpointMatchesOwnerScope(ep, effOwnerScope)) return false
      }
    }

    // 2. Model intersection (requested model and/or key.allowed_models)
    if (reqModel) {
      if (!memberServesModel(m, reqModel, { vmById, geminiById, epById, allowUnprefixedGemini3p })) return false
    } else if (keyAllowedModels.length > 0) {
      const anyAllowed = keyAllowedModels.some((allowedModel) =>
        memberServesModel(m, allowedModel, { vmById, geminiById, epById, allowUnprefixedGemini3p }),
      )
      if (!anyAllowed) return false
    }

    return true
  })

  if (admittedMembers.length === 0) {
    return {
      ok: false,
      status: 403,
      code: 'pool_unavailable',
      reason: 'empty_intersection',
      message: '分组池成员与密钥属主或模型白名单交集为空',
      originPool,
      effectivePool: null,
    }
  }

  const allowedClaudeVmIds = admittedMembers.filter((m) => m.node_type === 'claude_vm').map((m) => m.node_id)
  const allowedCodexVmIds = admittedMembers.filter((m) => m.node_type === 'codex_vm').map((m) => m.node_id)
  const allowedVmIds = [...new Set([...allowedClaudeVmIds, ...allowedCodexVmIds])]
  const allowedGeminiEnvIds = admittedMembers.filter((m) => m.node_type === 'gemini_env').map((m) => m.node_id)
  const allowedEndpointIds = admittedMembers.filter((m) => m.node_type === 'api_endpoint').map((m) => m.node_id)

  return {
    ok: true,
    status: 200,
    code: null,
    mode: poolBindingMode,
    legacy: false,
    isDowngraded,
    originPool,
    effectivePool,
    allowedPoolIds,
    allowedMembers: admittedMembers,
    allowedVmIds,
    allowedClaudeVmIds,
    allowedCodexVmIds,
    allowedGeminiEnvIds,
    allowedEndpointIds,
    allowedModels: keyAllowedModels,
    allowUnprefixedGemini3p,
  }
}

/**
 * Filter `/v1/models` (`{ data }`) or `/v1beta/models` (`{ models }`) catalog
 * strictly to models authorized by `poolAccess` (Fail-Closed on empty/denied pool).
 */
export function filterModelsForPoolAccess(
  catalog,
  poolAccess,
  { vms = null, geminiEnvs = null, apiEndpoints = null } = {},
) {
  if (!poolAccess) return catalog
  const wrap = (items) => {
    if (Array.isArray(catalog)) return items
    if (Array.isArray(catalog?.data)) return { ...catalog, data: items }
    if (Array.isArray(catalog?.models)) return { ...catalog, models: items }
    return catalog
  }
  const source = Array.isArray(catalog)
    ? catalog
    : Array.isArray(catalog?.data)
      ? catalog.data
      : Array.isArray(catalog?.models)
        ? catalog.models
        : null
  if (!source) return catalog
  if (!poolAccess.ok) return wrap([])

  const modelIdOf = (item) => {
    if (typeof item === 'string') return item
    const raw = item?.id ?? item?.name ?? ''
    return String(raw).replace(/^models\//, '')
  }

  const allowedModels = Array.isArray(poolAccess.allowedModels) ? poolAccess.allowedModels : []
  if (poolAccess.legacy) {
    if (!allowedModels.length) return catalog
    return wrap(source.filter((item) => keyAllowsModel(allowedModels, modelIdOf(item))))
  }

  const members = Array.isArray(poolAccess.allowedMembers) ? poolAccess.allowedMembers : []
  if (!members.length) return wrap([])

  const vmById = Array.isArray(vms) ? new Map(vms.map((v) => [v.id, v])) : null
  const { byId: geminiById } = buildGeminiLookup(geminiEnvs, null)
  const epById = Array.isArray(apiEndpoints) ? new Map(apiEndpoints.map((e) => [e.id, e])) : null
  const allowUnprefixedGemini3p = Boolean(poolAccess.allowUnprefixedGemini3p)

  return wrap(
    source.filter((item) => {
      const id = modelIdOf(item)
      if (!id) return false
      if (allowedModels.length > 0 && !keyAllowsModel(allowedModels, id)) return false
      return members.some((m) => memberServesModel(m, id, { vmById, geminiById, epById, allowUnprefixedGemini3p }))
    }),
  )
}
