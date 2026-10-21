/**
 * Managed-key schedule scope.
 * group_type all schedules every VM. anthropic/openai only schedule the checked VMs of that platform.
 * vm_pool_id schedules the pool's current members instead of a copied allowlist.
 * group_id (coding/other) is a rate multiplier and is not this field.
 */
import { isDbOpen, getDb } from '../db/database.mjs'
import { VmPoolsRepo } from '../db/repos/vm-pools-repo.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'

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

/** null when the value is present but not all/anthropic/openai. Empty uses fallback. */
export function normalizeGroupType(value, { fallback = 'all' } = {}) {
  if (value == null || value === '') return fallback
  if (value === 'pool') return null
  const v = String(value).trim().toLowerCase()
  if (v === 'all') return 'all'
  if (v === 'anthropic' || v === 'claude') return 'anthropic'
  if (v === 'openai' || v === 'gpt' || v === 'codex') return 'openai'
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

export function keyScopeFromRecord(rec) {
  if (!rec) return { group_type: 'all', allowed_vms: [], vm_pool_id: null }
  const group_type = normalizeGroupType(rec.group_type) || 'all'
  const vm_pool_id = poolIdOf(rec.vm_pool_id)
  return {
    group_type,
    allowed_vms: vm_pool_id || group_type === 'all' ? [] : parseAllowedVms(rec.allowed_vms),
    vm_pool_id,
  }
}

async function defaultPoolLookup(id) {
  if (!isDbOpen()) return null
  return await new VmPoolsRepo(getDb()).get(id)
}

/** Live membership. A missing, disabled, or empty pool never widens to the global set. */
export async function applyVmPool(scope, lookup = defaultPoolLookup) {
  if (!scope?.vm_pool_id) return scope
  const pool = (await lookup?.(scope.vm_pool_id)) || null
  if (!pool) return { ...scope, allowed_vms: [], vm_pool_error: 'missing' }
  if (!pool.enabled) return { ...scope, allowed_vms: [], vm_pool_error: 'disabled' }
  const ids = Array.isArray(pool.vm_ids) ? pool.vm_ids.map((id) => String(id || '').trim()).filter(Boolean) : []
  if (!ids.length) return { ...scope, allowed_vms: [], vm_pool_error: 'empty' }
  return { ...scope, allowed_vms: ids, vm_pool_error: null }
}

export async function keyScopeFromRequest(req, lookup = defaultPoolLookup) {
  if (!req || req.apiKeyKind === 'master') return { group_type: 'all', allowed_vms: [], vm_pool_id: null }
  return await applyVmPool(keyScopeFromRecord(req.apiKeyRecord), lookup)
}

export function vmPoolDenial(scope) {
  if (!scope?.vm_pool_error) return null
  return {
    code: 'vm_pool_unavailable',
    message: POOL_DENIAL[scope.vm_pool_error] || '账号池不可用',
  }
}

export function keyAllowsVm(scope, vm) {
  if (scope?.vm_pool_id) {
    if (scope.vm_pool_error) return false
    if (!vm?.id || !(scope.allowed_vms || []).includes(vm.id)) return false
    const group = scope.group_type || 'all'
    if (group !== 'all' && vmGroupType(vm) !== group) return false
    return true
  }
  const group = scope?.group_type || 'all'
  if (group === 'all') return true
  if (!vm?.id) return false
  if (vmGroupType(vm) !== group) return false
  return (scope.allowed_vms || []).includes(vm.id)
}

/**
 * Write-side scope. Unknown group_type throws instead of widening to all.
 * partial + neither field → null (leave the row alone).
 * A named pool replaces the copied allowlist. An explicit platform list
 * clears a previously bound pool. Does not check that the VM or pool exists.
 */
export function normalizeKeyScope(input = {}, { partial = false, current = null } = {}) {
  const hasType = input.group_type != null && input.group_type !== ''
  const hasVms = input.allowed_vms != null
  const hasPool = Object.prototype.hasOwnProperty.call(input, 'vm_pool_id')
  if (partial && !hasType && !hasVms && !hasPool) return null

  const base = current ? keyScopeFromRecord(current) : { group_type: 'all', allowed_vms: [], vm_pool_id: null }
  let group_type = !partial && !hasType ? 'all' : base.group_type
  if (hasType) {
    const parsed = normalizeGroupType(input.group_type, { fallback: null })
    if (!parsed) {
      throw Object.assign(new Error('group_type 只能是 all、anthropic 或 openai'), { code: 'invalid_group_type' })
    }
    group_type = parsed
  }
  let allowed_vms = hasVms ? parseAllowedVms(input.allowed_vms) : !partial && !hasType ? [] : base.allowed_vms
  let vm_pool_id = hasPool ? parsePoolId(input.vm_pool_id) : base.vm_pool_id
  const manual = (hasType && group_type !== 'all') || (hasVms && allowed_vms.length > 0)
  if (!hasPool && manual) vm_pool_id = null
  if (vm_pool_id) {
    return { group_type, allowed_vms: [], vm_pool_id }
  }
  if (group_type === 'all') allowed_vms = []
  if (group_type !== 'all' && allowed_vms.length === 0) {
    throw Object.assign(new Error('选择 anthropic 或 openai 时至少勾选一台 VM'), { code: 'key_vms_required' })
  }
  return { group_type, allowed_vms, vm_pool_id: null }
}

/** Panel check: every id is a live VM of the chosen platform. Pool membership is checked separately. */
export function assertVmScope(vms, scope) {
  if (!scope || scope.group_type === 'all' || scope.vm_pool_id) return []
  const byId = new Map((vms || []).map((vm) => [vm.id, vm]))
  for (const id of scope.allowed_vms) {
    const vm = byId.get(id)
    if (!vm) throw Object.assign(new Error('所选 VM 不存在'), { code: 'key_vm_unknown' })
    if (vmGroupType(vm) !== scope.group_type) {
      throw Object.assign(new Error('所选 VM 不属于该分组'), { code: 'key_vm_mismatch' })
    }
  }
  return scope.allowed_vms
}
