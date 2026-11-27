/**
 * Control-plane routes for unified scheduler pools (`/api/panel/pools*`,
 * `/api/panel/scheduler/sticky`) plus thin compatibility helpers for
 * `/api/panel/vm-pools` and `/api/panel/api-keys`.
 *
 * Byte-level contract aligned with `web/src/features/pools/api.ts`,
 * `web/src/types/panel-pools.ts`, and PRD v4 (§4.2, §6.3, §7.3 D1-D4).
 */
import {
  SCHEDULER_POOL_DEFAULTS,
  SchedulerPoolsRepo,
  defaultSystemPromptModeForProvider,
  isPromptLockedProvider,
  normalizeProviderScope,
  slugifyPoolName,
} from '../db/repos/scheduler-pools-repo.mjs'
import { resolveCredentialScheduleLevel } from '../pool/credential-weight.mjs'
import {
  SchedulerApiError,
  SchedulerUnavailableError,
  formatNodeKey,
  formatSchedulerError,
  inferModelFamily,
  parseNodeKey,
  resolveVirtualPoolId,
} from '../scheduler/scheduler-runtime.mjs'
import { resolveKernelDataplane } from '../vm/slot-engine.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { listVms } from '../vm/vm-registry.mjs'
import { resolvePoolAccessForKey } from './key-scope.mjs'
import * as panel from './panel-api.mjs'
import { PLATFORM_SCOPE, ownerScopeFromApiKey } from './resource-owner.mjs'

const NAME_MAX = 64
const SLUG_MAX = 64
const SYSTEM_PROMPT_MAX_BYTES = 64 * 1024
const MAX_FALLBACK_DEPTH = 3

const VALID_PROVIDER_SCOPES = new Set(['anthropic', 'openai', 'google', 'api', 'mixed'])
const VALID_POOL_ROLES = new Set(['primary', 'standard', 'overflow', 'downgrade', 'dedicated'])
const VALID_INTRA_TIER = new Set(['least_inflight_swrr', 'balanced', 'fill', 'ordered'])
const VALID_OVERFLOW_POLICIES = new Set(['spill_immediately', 'wait_then_spill', 'strict'])
const VALID_PROMPT_MODES = new Set(['official', 'zero_inject', 'override', 'append', 'passthrough', 'inherit_global'])
const VALID_PROMPT_PRESETS = new Set(['official_full', 'official', 'official_303'])
const VALID_CLIENT_SYSTEM_POLICIES = new Set(['prepend_pool', 'append_pool', 'replace_client'])
const VALID_JEV_PROFILES = new Set(['inherit_global', 'enforce', 'downgrade_only', 'bypass_trusted'])
const VALID_NODE_TYPES = new Set(['claude_vm', 'codex_vm', 'gemini_env', 'api_endpoint'])
const VALID_MEMBER_ROLES = new Set(['active', 'standby'])

function badRequest(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, status: 400, ...extra })
}

function conflictError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, status: 409, ...extra })
}

function parseIntInRange(value, min, max, field) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw badRequest(`invalid_${field}`, `${field} 必须是 ${min}–${max} 之间的整数`)
  }
  return n
}

function normalizePlanTags(raw) {
  if (raw == null) return []
  if (Array.isArray(raw)) {
    return [...new Set(raw.map((t) => String(t || '').trim()).filter(Boolean))].slice(0, 32)
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return []
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (Array.isArray(parsed)) return normalizePlanTags(parsed)
      } catch {
        throw badRequest('invalid_plan_tags', 'plan_tags JSON 格式无效')
      }
    }
    return [
      ...new Set(
        trimmed
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    ].slice(0, 32)
  }
  throw badRequest('invalid_plan_tags', 'plan_tags 必须是字符串数组')
}

function validatePromptPolicy({ provider_scope, system_prompt_mode, system_prompt_text }) {
  if (!VALID_PROMPT_MODES.has(system_prompt_mode)) {
    throw badRequest('invalid_system_prompt_mode', `不支持的 system_prompt_mode: ${system_prompt_mode}`)
  }
  if (isPromptLockedProvider(provider_scope) && system_prompt_mode !== 'passthrough') {
    throw badRequest(
      'pool_prompt_unsupported_provider',
      `provider_scope=${provider_scope} 不支持池级 System Prompt 注入，必须锁定为 passthrough`,
    )
  }
  const text = String(system_prompt_text || '')
  const bytes = Buffer.byteLength(text, 'utf8')
  if (system_prompt_mode === 'override' || system_prompt_mode === 'append') {
    if (!text.trim()) {
      throw badRequest('prompt_empty', 'override / append 模式下 system_prompt_text 不能为空')
    }
    if (bytes > SYSTEM_PROMPT_MAX_BYTES) {
      throw badRequest('prompt_too_large', `提示词正文超出 64 KiB 上限（当前 ${bytes} 字节）`)
    }
  }
}

/**
 * Validate fallback chain: target exists, no self-loop, no cycle, max depth 3,
 * and cross-prompt fallback forbidden on Anthropic/mixed/api pools unless
 * `allow_cross_prompt_fallback === true`. Also checks incoming chains on PATCH.
 */
export function validateFallbackChain({ poolId, nextFallbackId, sourcePool, allPools }) {
  const byId = new Map(allPools.map((p) => [p.id, p]))
  const simulated = new Map(byId)
  simulated.set(poolId, { ...sourcePool, id: poolId, fallback_pool_id: nextFallbackId })

  const warnings = []

  const checkFrom = (startId) => {
    const start = simulated.get(startId)
    if (!start?.fallback_pool_id) return
    const seen = [startId]
    let cur = start.fallback_pool_id
    while (cur) {
      if (cur === startId || seen.includes(cur)) {
        throw badRequest('fallback_cycle', `检测到 Fallback 环形引用：${[...seen, cur].join(' -> ')}`)
      }
      const target = simulated.get(cur)
      if (!target) {
        throw badRequest('fallback_pool_not_found', `Fallback 目标池不存在: ${cur}`)
      }
      seen.push(cur)
      if (seen.length > MAX_FALLBACK_DEPTH) {
        throw badRequest('fallback_depth_exceeded', `Fallback 链长度不能超过 ${MAX_FALLBACK_DEPTH} 层`)
      }
      cur = target.fallback_pool_id || null
    }
  }

  if (nextFallbackId) {
    if (nextFallbackId === poolId) {
      throw badRequest('fallback_self', 'Fallback 目标不能指向自身')
    }
    const target = byId.get(nextFallbackId)
    if (!target) {
      throw badRequest('fallback_pool_not_found', `Fallback 目标池不存在: ${nextFallbackId}`)
    }
    checkFrom(poolId)
    const involvesAnthropic =
      !isPromptLockedProvider(sourcePool.provider_scope) && !isPromptLockedProvider(target.provider_scope)
    if (involvesAnthropic && sourcePool.system_prompt_mode !== target.system_prompt_mode) {
      if (!sourcePool.allow_cross_prompt_fallback) {
        throw badRequest(
          'fallback_cross_prompt_forbidden',
          `目标池「${target.name}」的 Prompt 模式（${target.system_prompt_mode}）与本池（${sourcePool.system_prompt_mode}）不一致；默认禁止跨 Prompt 回落`,
        )
      }
      warnings.push({
        code: 'fallback_cross_prompt',
        target_pool_id: target.id,
        message: `已开启跨 Prompt 回落：${sourcePool.system_prompt_mode} -> ${target.system_prompt_mode}`,
      })
    }
  }

  // Re-validate every existing pool whose chain reaches poolId (prevents introducing depth > 3,
  // indirect cycles, or breaking an upstream pool's cross-prompt fallback policy on PATCH).
  for (const p of simulated.values()) {
    if (p.id !== poolId && p.fallback_pool_id) {
      checkFrom(p.id)
      if (p.fallback_pool_id === poolId) {
        const involvesAnthropic =
          !isPromptLockedProvider(p.provider_scope) && !isPromptLockedProvider(sourcePool.provider_scope)
        if (involvesAnthropic && p.system_prompt_mode !== sourcePool.system_prompt_mode) {
          if (!p.allow_cross_prompt_fallback) {
            throw badRequest(
              'fallback_cross_prompt_forbidden',
              `上游池「${p.name}」的 Fallback 指向本池且未开启跨 Prompt 回落（${p.system_prompt_mode} -> ${sourcePool.system_prompt_mode}）`,
            )
          }
          warnings.push({
            code: 'fallback_cross_prompt',
            source_pool_id: p.id,
            target_pool_id: poolId,
            message: `上游池「${p.name}」已开启跨 Prompt 回落：${p.system_prompt_mode} -> ${sourcePool.system_prompt_mode}`,
          })
        }
      }
    }
  }

  return warnings
}

function runtimeKindOfVm(vm) {
  if (!vm) return null
  if (isCodexVm(vm)) return 'codex'
  if (vm.runtime_kind === 'crag' || vm.runtime_kind === 'cli-node') return vm.runtime_kind
  const dp = resolveKernelDataplane(vm)
  if (dp === 'crag') return 'crag'
  return 'cli-node'
}

/**
 * Evaluate D1 & exclusive_members conflicts for a pool's proposed member set.
 * - `exclusive_members=true` on target or any other holder -> 400 hard reject.
 * - Legacy Anthropic `cli-node` across enabled pools with different `system_prompt_mode` -> 400 hard reject.
 * - Anthropic CRAG VM across enabled pools with different `system_prompt_mode` -> ALLOWED (D1) with warning.
 * - `codex_vm` / `gemini_env` -> no prompt conflict.
 */
export function evaluatePoolMemberConflicts({ targetPool, members, allPools, vmById }) {
  const warnings = []
  const enabledMembers = (members || []).filter((m) => m.enabled !== false)

  for (const cand of enabledMembers) {
    const otherHolders = allPools.filter((pool) => {
      if (pool.id === targetPool.id) return false
      return (pool.members || []).some(
        (m) => m.enabled !== false && m.node_type === cand.node_type && m.node_id === cand.node_id,
      )
    })
    if (!otherHolders.length) continue

    if (targetPool.exclusive_members) {
      throw badRequest(
        'exclusive_member_conflict',
        `本池已开启成员独占（exclusive_members），节点 ${cand.node_type}:${cand.node_id} 已属于其他池：${otherHolders.map((p) => p.name).join('、')}`,
        { node_type: cand.node_type, node_id: cand.node_id, conflicting_pools: otherHolders.map((p) => p.id) },
      )
    }

    const exclusiveOwners = otherHolders.filter((p) => p.exclusive_members)
    if (exclusiveOwners.length > 0) {
      throw badRequest(
        'exclusive_member_conflict',
        `节点 ${cand.node_type}:${cand.node_id} 已被独占池占用：${exclusiveOwners.map((p) => p.name).join('、')}`,
        { node_type: cand.node_type, node_id: cand.node_id, conflicting_pools: exclusiveOwners.map((p) => p.id) },
      )
    }

    if (
      cand.node_type === 'claude_vm' &&
      targetPool.enabled !== false &&
      !isPromptLockedProvider(targetPool.provider_scope)
    ) {
      const promptConflicts = otherHolders.filter(
        (p) =>
          p.enabled !== false &&
          !isPromptLockedProvider(p.provider_scope) &&
          p.system_prompt_mode !== targetPool.system_prompt_mode,
      )
      if (promptConflicts.length > 0) {
        const vm = vmById?.get(cand.node_id)
        const kind = runtimeKindOfVm(vm)
        const isCrag = kind === 'crag'
        const conflictSummary = promptConflicts.map((p) => ({
          id: p.id,
          name: p.name,
          system_prompt_mode: p.system_prompt_mode,
        }))
        if (!isCrag) {
          throw badRequest(
            'cli_node_prompt_conflict',
            `旧式 cli-node 槽位 ${cand.node_id} 禁止同时加入不同 System Prompt 模式的启用池（冲突池：${promptConflicts.map((p) => p.name).join('、')}）`,
            { node_type: cand.node_type, node_id: cand.node_id, conflicting_pools: conflictSummary },
          )
        }
        warnings.push({
          code: 'crag_cross_prompt',
          node_type: cand.node_type,
          node_id: cand.node_id,
          conflicting_pools: conflictSummary,
          message: `风控警告：Anthropic CRAG VM ${cand.node_id} 同时属于不同 Prompt 模式池（${promptConflicts.map((p) => `${p.name}:${p.system_prompt_mode}`).join('、')}），已按 D1 允许复用`,
        })
      }
    }
  }

  return warnings
}

function validateAndNormalizePoolInput(body, { existing = null } = {}) {
  const raw = body && typeof body === 'object' ? body : {}
  const isCreate = !existing

  const name = raw.name !== undefined ? String(raw.name || '').trim() : existing ? existing.name : ''
  if (!name || name.length > NAME_MAX) {
    throw badRequest('invalid_pool_name', `分组池名称需要 1–${NAME_MAX} 个字符`)
  }

  let slug = existing ? existing.slug : slugifyPoolName(name)
  if (raw.slug !== undefined && String(raw.slug || '').trim() !== '') {
    slug = String(raw.slug).trim().toLowerCase()
  }
  if (!slug || slug.length > SLUG_MAX || !/^[a-z0-9][a-z0-9_-]*$/.test(slug)) {
    throw badRequest('invalid_pool_slug', `slug 须为 1–${SLUG_MAX} 位小写字母/数字/连字符/下划线`)
  }

  const rawScope =
    raw.provider_scope !== undefined
      ? String(raw.provider_scope).trim().toLowerCase()
      : existing
        ? existing.provider_scope
        : SCHEDULER_POOL_DEFAULTS.provider_scope
  const provider_scope = rawScope === 'gemini' ? 'google' : rawScope
  if (!VALID_PROVIDER_SCOPES.has(provider_scope)) {
    throw badRequest('invalid_provider_scope', `不支持的 provider_scope: ${raw.provider_scope}`)
  }

  const pool_role =
    raw.pool_role !== undefined
      ? String(raw.pool_role).trim()
      : (existing?.pool_role ?? SCHEDULER_POOL_DEFAULTS.pool_role)
  if (!VALID_POOL_ROLES.has(pool_role)) {
    throw badRequest('invalid_pool_role', `不支持的 pool_role: ${pool_role}`)
  }

  const intra_tier_strategy =
    raw.intra_tier_strategy !== undefined
      ? String(raw.intra_tier_strategy).trim()
      : (existing?.intra_tier_strategy ?? SCHEDULER_POOL_DEFAULTS.intra_tier_strategy)
  if (!VALID_INTRA_TIER.has(intra_tier_strategy)) {
    throw badRequest('invalid_intra_tier_strategy', `不支持的 intra_tier_strategy: ${intra_tier_strategy}`)
  }

  const session_overflow_policy =
    raw.session_overflow_policy !== undefined
      ? String(raw.session_overflow_policy).trim()
      : (existing?.session_overflow_policy ?? SCHEDULER_POOL_DEFAULTS.session_overflow_policy)
  if (!VALID_OVERFLOW_POLICIES.has(session_overflow_policy)) {
    throw badRequest('invalid_session_overflow_policy', `不支持的 session_overflow_policy: ${session_overflow_policy}`)
  }

  const jev_profile =
    raw.jev_profile !== undefined
      ? String(raw.jev_profile).trim()
      : (existing?.jev_profile ?? SCHEDULER_POOL_DEFAULTS.jev_profile)
  if (!VALID_JEV_PROFILES.has(jev_profile)) {
    throw badRequest('invalid_jev_profile', `不支持的 jev_profile: ${jev_profile}`)
  }

  const system_prompt_mode =
    raw.system_prompt_mode !== undefined
      ? String(raw.system_prompt_mode).trim()
      : existing
        ? existing.system_prompt_mode
        : defaultSystemPromptModeForProvider(provider_scope)
  const system_prompt_preset =
    raw.system_prompt_preset !== undefined
      ? String(raw.system_prompt_preset).trim()
      : (existing?.system_prompt_preset ?? SCHEDULER_POOL_DEFAULTS.system_prompt_preset)
  if (!VALID_PROMPT_PRESETS.has(system_prompt_preset)) {
    throw badRequest('invalid_system_prompt_preset', `不支持的 system_prompt_preset: ${system_prompt_preset}`)
  }
  const client_system_policy =
    raw.client_system_policy !== undefined
      ? String(raw.client_system_policy).trim()
      : (existing?.client_system_policy ?? SCHEDULER_POOL_DEFAULTS.client_system_policy)
  if (!VALID_CLIENT_SYSTEM_POLICIES.has(client_system_policy)) {
    throw badRequest('invalid_client_system_policy', `不支持的 client_system_policy: ${client_system_policy}`)
  }
  const system_prompt_text =
    raw.system_prompt_text !== undefined
      ? String(raw.system_prompt_text ?? '')
      : (existing?.system_prompt_text ?? SCHEDULER_POOL_DEFAULTS.system_prompt_text)

  validatePromptPolicy({ provider_scope, system_prompt_mode, system_prompt_text })

  const machine_ttl_seconds =
    raw.machine_ttl_seconds !== undefined
      ? parseIntInRange(raw.machine_ttl_seconds, 60, 2_592_000, 'machine_ttl_seconds')
      : (existing?.machine_ttl_seconds ?? SCHEDULER_POOL_DEFAULTS.machine_ttl_seconds)
  const session_ttl_seconds =
    raw.session_ttl_seconds !== undefined
      ? parseIntInRange(raw.session_ttl_seconds, 60, 604_800, 'session_ttl_seconds')
      : (existing?.session_ttl_seconds ?? SCHEDULER_POOL_DEFAULTS.session_ttl_seconds)
  const session_queue_max =
    raw.session_queue_max !== undefined
      ? parseIntInRange(raw.session_queue_max, 1, 128, 'session_queue_max')
      : (existing?.session_queue_max ?? SCHEDULER_POOL_DEFAULTS.session_queue_max)
  const session_queue_timeout_ms =
    raw.session_queue_timeout_ms !== undefined
      ? parseIntInRange(raw.session_queue_timeout_ms, 1000, 300_000, 'session_queue_timeout_ms')
      : (existing?.session_queue_timeout_ms ?? SCHEDULER_POOL_DEFAULTS.session_queue_timeout_ms)
  const queue_wait_ms =
    raw.queue_wait_ms !== undefined
      ? parseIntInRange(raw.queue_wait_ms, 0, 60_000, 'queue_wait_ms')
      : (existing?.queue_wait_ms ?? SCHEDULER_POOL_DEFAULTS.queue_wait_ms)
  const queue_max =
    raw.queue_max !== undefined
      ? parseIntInRange(raw.queue_max, 1, 999, 'queue_max')
      : (existing?.queue_max ?? SCHEDULER_POOL_DEFAULTS.queue_max)
  const session_busy_wait_ms =
    raw.session_busy_wait_ms !== undefined
      ? parseIntInRange(raw.session_busy_wait_ms, 0, 30_000, 'session_busy_wait_ms')
      : (existing?.session_busy_wait_ms ?? SCHEDULER_POOL_DEFAULTS.session_busy_wait_ms)
  const sort_order =
    raw.sort_order !== undefined
      ? parseIntInRange(raw.sort_order, -10_000, 10_000, 'sort_order')
      : (existing?.sort_order ?? SCHEDULER_POOL_DEFAULTS.sort_order)

  const plan_tags =
    raw.plan_tags !== undefined || raw.plan_tags_json !== undefined
      ? normalizePlanTags(raw.plan_tags !== undefined ? raw.plan_tags : raw.plan_tags_json)
      : (existing?.plan_tags ?? [])

  const fallback_pool_id =
    raw.fallback_pool_id !== undefined
      ? raw.fallback_pool_id == null || String(raw.fallback_pool_id).trim() === ''
        ? null
        : String(raw.fallback_pool_id).trim()
      : (existing?.fallback_pool_id ?? null)

  const enabled =
    raw.enabled !== undefined ? Boolean(raw.enabled) : (existing?.enabled ?? SCHEDULER_POOL_DEFAULTS.enabled)
  const exclusive_members =
    raw.exclusive_members !== undefined
      ? Boolean(raw.exclusive_members)
      : (existing?.exclusive_members ?? SCHEDULER_POOL_DEFAULTS.exclusive_members)
  const allow_cross_prompt_fallback = isPromptLockedProvider(provider_scope)
    ? false
    : raw.allow_cross_prompt_fallback !== undefined
      ? Boolean(raw.allow_cross_prompt_fallback)
      : (existing?.allow_cross_prompt_fallback ?? SCHEDULER_POOL_DEFAULTS.allow_cross_prompt_fallback)

  return {
    ...(isCreate && raw.id ? { id: String(raw.id).trim() } : {}),
    name,
    slug,
    description: raw.description !== undefined ? String(raw.description ?? '') : (existing?.description ?? ''),
    enabled,
    exclusive_members,
    provider_scope,
    plan_tags,
    pool_role,
    sort_order,
    fallback_pool_id,
    allow_cross_prompt_fallback,
    intra_tier_strategy,
    session_queue_max,
    session_queue_timeout_ms,
    queue_wait_ms,
    queue_max,
    machine_sticky_enabled:
      raw.machine_sticky_enabled !== undefined
        ? Boolean(raw.machine_sticky_enabled)
        : (existing?.machine_sticky_enabled ?? SCHEDULER_POOL_DEFAULTS.machine_sticky_enabled),
    machine_ttl_seconds,
    session_sticky_enabled:
      raw.session_sticky_enabled !== undefined
        ? Boolean(raw.session_sticky_enabled)
        : (existing?.session_sticky_enabled ?? SCHEDULER_POOL_DEFAULTS.session_sticky_enabled),
    session_ttl_seconds,
    session_busy_wait_ms,
    session_overflow_policy,
    system_prompt_mode,
    system_prompt_preset,
    system_prompt_text: isPromptLockedProvider(provider_scope) ? '' : system_prompt_text,
    client_system_policy,
    jev_profile,
  }
}

function normalizeMemberListInput(rawMembers, { vmById, epById } = {}) {
  if (!Array.isArray(rawMembers)) {
    throw badRequest('invalid_pool_members', 'members 必须是数组')
  }
  const out = []
  const seen = new Set()
  for (let i = 0; i < rawMembers.length; i += 1) {
    const item = rawMembers[i]
    if (!item || typeof item !== 'object') {
      throw badRequest('invalid_pool_members', '成员项必须是对象')
    }
    const node_type = String(item.node_type || '').trim()
    const node_id = String(item.node_id || '').trim()
    if (!VALID_NODE_TYPES.has(node_type)) {
      throw badRequest('invalid_node_type', `不支持的节点类型: ${node_type}`)
    }
    if (!node_id) {
      throw badRequest('invalid_node_id', 'node_id 不能为空')
    }
    const key = `${node_type}:${node_id}`
    if (seen.has(key)) continue
    seen.add(key)

    if ((node_type === 'claude_vm' || node_type === 'codex_vm') && vmById) {
      const vm = vmById.get(node_id)
      if (vm) {
        const expectedType = isCodexVm(vm) ? 'codex_vm' : 'claude_vm'
        if (expectedType !== node_type) {
          throw badRequest('member_type_mismatch', `槽位 ${node_id} 实际类型为 ${expectedType}，与 ${node_type} 不符`)
        }
      } else if (vmById.size > 0) {
        throw badRequest('member_not_found', `槽位 ${node_id} 不存在`, { node_type, node_id })
      }
    }
    if (node_type === 'api_endpoint' && epById && epById.size > 0 && !epById.has(node_id)) {
      throw badRequest('member_not_found', `API 渠道 ${node_id} 不存在`, { node_type, node_id })
    }

    const member_role = item.member_role == null ? 'active' : String(item.member_role).trim()
    if (!VALID_MEMBER_ROLES.has(member_role)) {
      throw badRequest('invalid_member_role', `member_role 只能是 active 或 standby`)
    }

    let weight_tier_override = null
    if (item.weight_tier_override != null && item.weight_tier_override !== '') {
      weight_tier_override = parseIntInRange(item.weight_tier_override, 1, 10, 'weight_tier_override')
    }

    let sub_weight_override = null
    if (item.sub_weight_override != null && item.sub_weight_override !== '') {
      sub_weight_override = parseIntInRange(item.sub_weight_override, 1, 1000, 'sub_weight_override')
    }

    const member_order =
      item.member_order != null && item.member_order !== ''
        ? parseIntInRange(item.member_order, 0, 100_000, 'member_order')
        : i

    out.push({
      node_type,
      node_id,
      enabled: item.enabled !== false,
      member_role,
      weight_tier_override,
      sub_weight_override,
      member_order,
    })
  }
  return out
}

function buildEnrichedMember(
  member,
  { vmById, epById, accountQuota, accountSnap, poolSnap, geminiById, geminiPrefs, penaltiesByNode },
) {
  const node_key = `${member.node_type}:${member.node_id}`
  const penalty = penaltiesByNode.get(node_key) || null

  if (member.node_type === 'claude_vm' || member.node_type === 'codex_vm') {
    const vm = vmById.get(member.node_id) || null
    const acct = vm && accountQuota ? panel.findAccount(accountQuota, vm, accountSnap) : null
    const unified = acct?.unified || (vm?.reset_7d ? { '7d': { resets_at: vm.reset_7d } } : {})
    const manualLevel = vm?.policy?.priority ?? vm?.schedule_level_manual
    const schedInfo = resolveCredentialScheduleLevel({
      vm,
      ...(manualLevel !== undefined ? { manualLevel } : {}),
      unified,
    })
    const base_weight_tier = schedInfo.level
    const effective_weight_tier = member.weight_tier_override ?? base_weight_tier
    const rawWeight = Number(vm?.policy?.weight ?? vm?.weight)
    const baseSub = rawWeight > 0 ? rawWeight : 10
    const effective_sub_weight = member.sub_weight_override ?? baseSub
    const slotSnap =
      poolSnap?.slots?.find?.((s) => s.id === member.node_id || s.vm_id === member.node_id) ||
      poolSnap?.vms?.find?.((s) => s.id === member.node_id) ||
      null
    const inflight = Number(slotSnap?.inflight ?? slotSnap?.in_flight ?? 0) || 0
    const max_concurrency =
      Number(
        slotSnap?.max_concurrency ??
          vm?.policy?.max_concurrency ??
          vm?.policy?.maxConcurrency ??
          vm?.max_concurrency ??
          4,
      ) || 4
    const active_sessions = Number(slotSnap?.active_sessions ?? slotSnap?.seats_used ?? 0) || 0
    const max_sessions =
      Number(
        slotSnap?.max_sessions ??
          vm?.policy?.session_slots ??
          vm?.policy?.sessionSlots ??
          vm?.session_slots ??
          vm?.max_sessions ??
          max_concurrency,
      ) || 4
    const schedulable = Boolean(vm && vm.schedulable !== false && !vm.unschedulable && vm.status !== 'stopped')
    const healthy = Boolean(schedulable && !penalty)
    const unschedReason = vm
      ? vm.unschedulable
        ? typeof vm.unschedulable === 'object'
          ? String(vm.unschedulable.reason || vm.unschedulable.code || 'unschedulable')
          : String(vm.unschedulable)
        : vm.schedulable === false
          ? 'schedulable_false'
          : null
      : 'missing_vm'
    return {
      ...member,
      node_key,
      name: vm?.name || member.node_id,
      email: vm?.email || null,
      provider: member.node_type === 'codex_vm' ? 'openai' : 'anthropic',
      plan_tier: vm?.claude?.account_tier || vm?.account_tier || vm?.codex?.plan_type || vm?.plan_type || null,
      protocol: member.node_type === 'codex_vm' ? 'openai' : 'anthropic',
      dataplane: vm ? resolveKernelDataplane(vm) : null,
      runtime_kind: runtimeKindOfVm(vm),
      weight_tier_mode: schedInfo.mode === 'auto' ? 'auto_7d_reset' : 'manual',
      base_weight_tier,
      effective_weight_tier,
      effective_sub_weight,
      inflight,
      max_concurrency,
      active_sessions,
      max_sessions,
      quota_util_5h_pct: unified['5h']?.utilization != null ? Number(unified['5h'].utilization) : null,
      quota_util_7d_pct: unified['7d']?.utilization != null ? Number(unified['7d'].utilization) : null,
      healthy,
      schedulable,
      unschedulable_reason: unschedReason,
      cooldown_until_ms: penalty?.cooldown_until_ms ?? null,
      cooldown_reason: penalty?.reason ?? null,
      sink_seq: 0,
    }
  }

  if (member.node_type === 'gemini_env') {
    const env = geminiById.get(member.node_id) || null
    const pref = geminiPrefs?.[member.node_id] || null
    const base_weight_tier = Number(pref?.schedule_level) || 5
    const effective_weight_tier = member.weight_tier_override ?? base_weight_tier
    const effective_sub_weight = member.sub_weight_override ?? 10
    const inflight = Number(env?.inflight ?? env?.in_flight ?? 0) || 0
    const max_concurrency = Number(env?.max_concurrency ?? pref?.max_concurrency ?? 20) || 20
    const schedulable = env ? env.enabled !== false && env.schedulable !== false : true
    const healthy = Boolean(schedulable && (!env || env.healthy !== false) && !penalty)
    return {
      ...member,
      node_key,
      name: env?.name || env?.email || member.node_id,
      email: env?.email || null,
      provider: 'google',
      plan_tier: env?.plan_tier || env?.tier || null,
      protocol: 'google',
      dataplane: 'crag-gemini',
      runtime_kind: 'gemini',
      weight_tier_mode: 'manual',
      base_weight_tier,
      effective_weight_tier,
      effective_sub_weight,
      inflight,
      max_concurrency,
      active_sessions: Number(env?.active_sessions ?? 0) || 0,
      max_sessions: Number(env?.max_sessions ?? pref?.max_sessions ?? 20) || 20,
      quota_util_5h_pct: null,
      quota_util_7d_pct: null,
      healthy,
      schedulable,
      unschedulable_reason: !schedulable ? 'schedulable_false' : null,
      cooldown_until_ms: penalty?.cooldown_until_ms ?? null,
      cooldown_reason: penalty?.reason ?? null,
      sink_seq: 0,
    }
  }

  // api_endpoint
  const ep = epById.get(member.node_id) || null
  const base_weight_tier = Number(ep?.priority) > 0 ? Math.min(10, Math.max(1, Number(ep.priority))) : 5
  const effective_weight_tier = member.weight_tier_override ?? base_weight_tier
  const effective_sub_weight = member.sub_weight_override ?? (Number(ep?.weight) > 0 ? Number(ep.weight) : 10)
  const schedulable = Boolean(ep && !ep.disabled)
  const healthy = Boolean(schedulable && !penalty)
  return {
    ...member,
    node_key,
    name: ep?.name || member.node_id,
    email: null,
    provider: ep?.protocol === 'anthropic' ? 'anthropic' : ep?.protocol === 'openai' ? 'openai' : 'api_custom',
    plan_tier: 'payg',
    protocol: ep?.protocol || 'anthropic',
    dataplane: 'api',
    runtime_kind: 'api',
    weight_tier_mode: 'manual',
    base_weight_tier,
    effective_weight_tier,
    effective_sub_weight,
    inflight: 0,
    max_concurrency: Number(ep?.max_concurrency ?? 20) || 20,
    active_sessions: 0,
    max_sessions: Number(ep?.max_concurrency ?? 20) || 20,
    quota_util_5h_pct: null,
    quota_util_7d_pct: null,
    healthy,
    schedulable,
    unschedulable_reason: ep ? (ep.disabled ? 'disabled' : null) : 'missing_endpoint',
    cooldown_until_ms: penalty?.cooldown_until_ms ?? null,
    cooldown_reason: penalty?.reason ?? null,
    sink_seq: 0,
  }
}

function enrichPoolView(pool, boundKeys, liveCtx) {
  const enrichedMembers = (pool.members || []).map((m) => buildEnrichedMember(m, liveCtx))
  const total_members = enrichedMembers.length
  const active_members = enrichedMembers.filter((m) => m.enabled !== false && m.member_role === 'active').length
  const healthy_members = enrichedMembers.filter((m) => m.enabled !== false && m.healthy).length
  const inflight = enrichedMembers.reduce((sum, m) => sum + (Number(m.inflight) || 0), 0)
  const max_concurrency = enrichedMembers
    .filter((m) => m.enabled !== false)
    .reduce((sum, m) => sum + (Number(m.max_concurrency) || 0), 0)
  const active_sessions = enrichedMembers.reduce((sum, m) => sum + (Number(m.active_sessions) || 0), 0)
  const max_sessions = enrichedMembers
    .filter((m) => m.enabled !== false)
    .reduce((sum, m) => sum + (Number(m.max_sessions) || 0), 0)
  const bound_keys = boundKeys || []
  const bound_keys_count = bound_keys.length
  const active_bound_keys_count = bound_keys.filter((k) => k.status === 'active').length
  const vm_ids = enrichedMembers
    .filter((m) => m.node_type === 'claude_vm' || m.node_type === 'codex_vm')
    .map((m) => m.node_id)

  return {
    ...pool,
    members: enrichedMembers,
    bound_keys,
    vm_ids,
    total_members,
    healthy_members,
    inflight,
    max_concurrency,
    bound_keys_count,
    active_bound_keys_count,
    metrics: {
      total_members,
      healthy_members,
      active_members,
      inflight,
      max_concurrency,
      active_sessions,
      max_sessions,
      machine_sticky_hit_rate_1h: null,
      session_sticky_hit_rate_1h: null,
      spill_rate_1h: null,
      bound_keys_count,
      active_bound_keys_count,
    },
  }
}

function httpStatusForPoolError(err) {
  if (Number.isInteger(err?.status)) return err.status
  const code = String(err?.code || '')
  if (code === 'pool_not_found' || code === 'vm_pool_not_found') return 404
  if (
    code === 'scheduler_pool_name_taken' ||
    code === 'scheduler_pool_slug_taken' ||
    code === 'scheduler_pool_in_use'
  ) {
    return 409
  }
  return 400
}

/**
 * Enrich an API key view object (or list) with unified pool binding fields
 * (`pool_binding_mode`, `default_pool_id`, `default_pool_name`, `allowed_pool_ids`,
 * plus legacy `vm_pool_id` / `vm_pool_name` fallback).
 */
export function enrichApiKeyViewsWithPools(db, keys, rawById = null) {
  if (!db || !Array.isArray(keys) || !keys.length) return keys
  let poolsById = new Map()
  let bindingsByKey = new Map()
  try {
    const repo = new SchedulerPoolsRepo(db)
    for (const p of repo.list()) poolsById.set(p.id, p)
    for (const b of repo.listAllBindings()) {
      const list = bindingsByKey.get(b.api_key_id) || []
      list.push(b)
      bindingsByKey.set(b.api_key_id, list)
    }
  } catch {
    return keys
  }

  return keys.map((item) => {
    const raw = rawById?.get?.(item.id) || null
    const bindings = bindingsByKey.get(item.id) || []
    const allowed_pool_ids = bindings.map((b) => b.pool_id)
    const defaultFromBinding = bindings.find((b) => b.is_default)?.pool_id || null
    const default_pool_id =
      (raw?.default_pool_id ? String(raw.default_pool_id) : null) ||
      defaultFromBinding ||
      item.vm_pool_id ||
      allowed_pool_ids[0] ||
      null
    if (default_pool_id && !allowed_pool_ids.includes(default_pool_id)) {
      allowed_pool_ids.unshift(default_pool_id)
    }
    const pool_binding_mode =
      raw?.pool_binding_mode === 'strict_pool' || item.pool_binding_mode === 'strict_pool'
        ? 'strict_pool'
        : 'legacy_scope'
    const default_pool_name = default_pool_id
      ? (poolsById.get(default_pool_id)?.name ?? item.vm_pool_name ?? null)
      : null
    return {
      ...item,
      pool_binding_mode,
      default_pool_id,
      default_pool_name,
      allowed_pool_ids,
      vm_pool_id: item.vm_pool_id ?? default_pool_id,
      vm_pool_name: item.vm_pool_name ?? default_pool_name,
    }
  })
}

/**
 * Sync writes performed through legacy `/api/panel/vm-pools` into `scheduler_pools`
 * and `scheduler_pool_members` so both surfaces stay consistent.
 */
export function syncVmPoolToSchedulerPool(db, action, pool, vms = null) {
  if (!db || !pool?.id) return
  try {
    const repo = new SchedulerPoolsRepo(db)
    if (action === 'delete') {
      if (repo.get(pool.id)) repo.forceRemove(pool.id)
      return
    }
    const existing = repo.get(pool.id)
    if (!existing) {
      repo.insert({
        id: pool.id,
        slug: slugifyPoolName(pool.name, pool.id),
        name: pool.name,
        enabled: pool.enabled !== false,
        provider_scope: 'anthropic',
        system_prompt_mode: defaultSystemPromptModeForProvider('anthropic'),
      })
    } else {
      repo.update(pool.id, {
        name: pool.name,
        enabled: pool.enabled !== false,
      })
    }
    if (Array.isArray(pool.vm_ids)) {
      const vmById = Array.isArray(vms) ? new Map(vms.map((v) => [v.id, v])) : null
      const existingMembers = repo.listMembers(pool.id)
      const nonVm = existingMembers.filter((m) => m.node_type !== 'claude_vm' && m.node_type !== 'codex_vm')
      const prevByVm = new Map(
        existingMembers
          .filter((m) => m.node_type === 'claude_vm' || m.node_type === 'codex_vm')
          .map((m) => [m.node_id, m]),
      )
      const nextVms = pool.vm_ids.map((vmId, idx) => {
        const prev = prevByVm.get(vmId)
        const vm = vmById?.get(vmId)
        const node_type = vm ? (isCodexVm(vm) ? 'codex_vm' : 'claude_vm') : prev?.node_type || 'claude_vm'
        return {
          node_type,
          node_id: vmId,
          enabled: prev ? prev.enabled : true,
          member_role: prev ? prev.member_role : 'active',
          weight_tier_override: prev ? prev.weight_tier_override : null,
          sub_weight_override: prev ? prev.sub_weight_override : null,
          member_order: prev ? prev.member_order : idx,
        }
      })
      repo.setMembers(pool.id, [...nextVms, ...nonVm])
    }
  } catch {
    // Best-effort sync; primary legacy vm_pools write already succeeded.
  }
}

export function createSchedulerPoolsHandler({
  getDb,
  getVms = null,
  cfg = null,
  apiKeyStore = null,
  apiEndpointStore = null,
  accountQuota = null,
  poolScheduler = null,
  geminiScheduler = null,
  geminiSlotPrefs = null,
  geminiOwnersRepo = null,
  schedulerRuntime = null,
  writeSSEHeaders = null,
  json,
  readBody,
}) {
  const resolveDb = () => (typeof getDb === 'function' ? getDb() : apiKeyStore?.db)
  const resolveRuntime = () => (typeof schedulerRuntime === 'function' ? schedulerRuntime() : schedulerRuntime)
  const syncRuntimeConfig = async (reason) => {
    const rt = resolveRuntime()
    if (!rt || typeof rt.syncConfigNow !== 'function') return
    try {
      await rt.syncConfigNow(reason)
    } catch {}
  }
  const sendSchedulerError = (res, err, fallbackCode = 'scheduler_error') => {
    const mapped = formatSchedulerError(err)
    if (mapped.headers) {
      for (const [k, v] of Object.entries(mapped.headers)) {
        res.setHeader(k, v)
      }
    }
    return json(res, mapped.status, {
      ok: false,
      error: {
        code: mapped.code || fallbackCode,
        message: mapped.body?.error?.message || String(err?.message || err),
        ...(mapped.retryAfterSec != null ? { retry_after_sec: mapped.retryAfterSec } : {}),
        ...(mapped.explain ? { explain: mapped.explain } : {}),
      },
    })
  }
  const loadVms = () => {
    if (typeof getVms === 'function') return getVms() || []
    if (cfg?.paths?.project) {
      try {
        return listVms(cfg.paths.project) || []
      } catch {
        return []
      }
    }
    return []
  }

  function buildLiveContext(repo) {
    const vms = loadVms()
    const vmById = new Map(vms.map((v) => [v.id, v]))
    const endpoints = apiEndpointStore?.listRaw?.() || []
    const epById = new Map(endpoints.map((e) => [e.id, e]))
    const accountSnap = accountQuota ? panel.readAccountSnapshot(accountQuota) : null
    const schedObj = typeof poolScheduler === 'function' ? poolScheduler() : poolScheduler
    const poolSnap = schedObj?.snapshot?.() || null
    const gSched = typeof geminiScheduler === 'function' ? geminiScheduler() : geminiScheduler
    const geminiList = gSched?.listEnvironments?.() || gSched?.snapshot?.()?.accounts || []
    const geminiById = new Map()
    for (const env of geminiList) {
      const id = String(env?.id ?? env?.env_id ?? env?.name ?? '').trim()
      if (id) geminiById.set(id, env)
    }
    const geminiPrefs = geminiSlotPrefs?.all?.() || geminiSlotPrefs?.getAll?.() || {}
    const penaltiesByNode = new Map()
    for (const pen of repo.listActiveNodePenalties(Date.now())) {
      const nk = `${pen.node_type}:${pen.node_id}`
      if (!penaltiesByNode.has(nk) || pen.cooldown_until_ms > penaltiesByNode.get(nk).cooldown_until_ms) {
        penaltiesByNode.set(nk, pen)
      }
    }
    return { vms, vmById, epById, accountQuota, accountSnap, poolSnap, geminiById, geminiPrefs, penaltiesByNode }
  }

  return async function handleSchedulerPoolsRoute(req, res, p, url) {
    const db = resolveDb()
    const repo = new SchedulerPoolsRepo(db)

    // GET /api/panel/pools
    if (req.method === 'GET' && p === '/api/panel/pools') {
      const liveCtx = buildLiveContext(repo)
      const allBound = repo.listAllBoundKeySummaries()
      const boundByPool = new Map()
      for (const b of allBound) {
        const list = boundByPool.get(b.pool_id) || []
        list.push(b)
        boundByPool.set(b.pool_id, list)
      }

      let pools = repo.list().map((pool) => enrichPoolView(pool, boundByPool.get(pool.id) || [], liveCtx))

      const filterScope = url?.searchParams?.get('provider_scope')
      if (filterScope) {
        const norm = normalizeProviderScope(filterScope)
        pools = pools.filter((item) => item.provider_scope === norm)
      }
      const filterRole = url?.searchParams?.get('pool_role')
      if (filterRole) {
        pools = pools.filter((item) => item.pool_role === filterRole)
      }
      const filterPrompt = url?.searchParams?.get('system_prompt_mode')
      if (filterPrompt) {
        pools = pools.filter((item) => item.system_prompt_mode === filterPrompt)
      }
      const filterTag = url?.searchParams?.get('plan_tag')
      if (filterTag) {
        pools = pools.filter((item) => (item.plan_tags || []).includes(filterTag))
      }
      const filterEnabled = url?.searchParams?.get('enabled')
      if (filterEnabled === '1' || filterEnabled === 'true') {
        pools = pools.filter((item) => item.enabled)
      } else if (filterEnabled === '0' || filterEnabled === 'false') {
        pools = pools.filter((item) => !item.enabled)
      }

      return json(res, 200, panel.ok({ pools }))
    }

    // POST /api/panel/pools
    if (req.method === 'POST' && p === '/api/panel/pools') {
      const body = await readBody(req, 128 * 1024).catch(() => ({}))
      try {
        const normalized = validateAndNormalizePoolInput(body, { existing: null })
        const allPools = repo.list()
        const warnings = []
        if (normalized.fallback_pool_id) {
          warnings.push(
            ...validateFallbackChain({
              poolId: normalized.id || '__new__',
              nextFallbackId: normalized.fallback_pool_id,
              sourcePool: normalized,
              allPools,
            }),
          )
        }
        const liveCtx = buildLiveContext(repo)
        let memberList = null
        if (body && Object.prototype.hasOwnProperty.call(body, 'members')) {
          memberList = normalizeMemberListInput(body.members, liveCtx)
          warnings.push(
            ...evaluatePoolMemberConflicts({
              targetPool: { ...normalized, id: normalized.id || '__new__' },
              members: memberList,
              allPools,
              vmById: liveCtx.vmById,
            }),
          )
        }
        let created = repo.insert(normalized)
        if (memberList) {
          try {
            created = repo.setMembers(created.id, memberList)
          } catch (err) {
            repo.remove(created.id)
            throw err
          }
        }
        const enriched = enrichPoolView(created, repo.listBoundKeySummariesByPool(created.id), liveCtx)
        await syncRuntimeConfig('panel_pool_create')
        return json(res, 201, panel.ok({ pool: enriched, warnings }))
      } catch (e) {
        return json(res, httpStatusForPoolError(e), {
          ok: false,
          error: {
            message: String(e.message || e),
            code: e.code || 'create_pool_failed',
            ...(e.conflicting_pools ? { conflicting_pools: e.conflicting_pools } : {}),
          },
        })
      }
    }

    // GET /api/panel/pools/:id
    const singleMatch = p.match(/^\/api\/panel\/pools\/([^/]+)$/)
    if (req.method === 'GET' && singleMatch) {
      const id = decodeURIComponent(singleMatch[1])
      const pool = repo.get(id)
      if (!pool) return json(res, 404, { ok: false, error: { code: 'pool_not_found', message: '分组池不存在' } })
      const liveCtx = buildLiveContext(repo)
      const enriched = enrichPoolView(pool, repo.listBoundKeySummariesByPool(id), liveCtx)
      return json(res, 200, panel.ok({ pool: enriched }))
    }

    // PATCH /api/panel/pools/:id
    if (req.method === 'PATCH' && singleMatch) {
      const id = decodeURIComponent(singleMatch[1])
      const existing = repo.get(id)
      if (!existing) return json(res, 404, { ok: false, error: { code: 'pool_not_found', message: '分组池不存在' } })
      const body = await readBody(req, 128 * 1024).catch(() => ({}))
      try {
        const nextPool = validateAndNormalizePoolInput(body, { existing })
        const allPools = repo.list()
        const warnings = []
        if (
          nextPool.fallback_pool_id !== existing.fallback_pool_id ||
          nextPool.system_prompt_mode !== existing.system_prompt_mode ||
          nextPool.allow_cross_prompt_fallback !== existing.allow_cross_prompt_fallback ||
          nextPool.provider_scope !== existing.provider_scope
        ) {
          warnings.push(
            ...validateFallbackChain({
              poolId: id,
              nextFallbackId: nextPool.fallback_pool_id,
              sourcePool: nextPool,
              allPools,
            }),
          )
        }
        const liveCtx = buildLiveContext(repo)
        // Re-check member constraints if exclusive_members, enabled, provider_scope, or system_prompt_mode changed.
        if (
          nextPool.exclusive_members !== existing.exclusive_members ||
          nextPool.system_prompt_mode !== existing.system_prompt_mode ||
          nextPool.provider_scope !== existing.provider_scope ||
          nextPool.enabled !== existing.enabled
        ) {
          warnings.push(
            ...evaluatePoolMemberConflicts({
              targetPool: { ...nextPool, id },
              members: existing.members || [],
              allPools,
              vmById: liveCtx.vmById,
            }),
          )
        }
        const updated = repo.update(id, nextPool)
        // Keep legacy vm_pools row in sync if it exists with the same id.
        try {
          db.prepare('UPDATE vm_pools SET name = ?, enabled = ?, updated_at = ? WHERE id = ?').run(
            updated.name,
            updated.enabled ? 1 : 0,
            updated.updated_at,
            id,
          )
        } catch {}
        const enriched = enrichPoolView(updated, repo.listBoundKeySummariesByPool(id), liveCtx)
        await syncRuntimeConfig('panel_pool_update')
        return json(res, 200, panel.ok({ pool: enriched, warnings }))
      } catch (e) {
        return json(res, httpStatusForPoolError(e), {
          ok: false,
          error: {
            message: String(e.message || e),
            code: e.code || 'update_pool_failed',
            ...(e.conflicting_pools ? { conflicting_pools: e.conflicting_pools } : {}),
          },
        })
      }
    }

    // DELETE /api/panel/pools/:id
    if (req.method === 'DELETE' && singleMatch) {
      const id = decodeURIComponent(singleMatch[1])
      const existing = repo.get(id)
      if (!existing) return json(res, 404, { ok: false, error: { code: 'pool_not_found', message: '分组池不存在' } })
      const body = await readBody(req, 16 * 1024).catch(() => ({}))
      const force =
        url?.searchParams?.get('force') === '1' || url?.searchParams?.get('force') === 'true' || body?.force === true
      const migrateToPoolId =
        String(url?.searchParams?.get('migrate_to_pool_id') || body?.migrate_to_pool_id || '').trim() || null

      const boundCount = repo.countBoundKeys(id)
      const activeCount = repo.countActiveKeys(id)
      if (boundCount > 0 && !force && !migrateToPoolId) {
        return json(res, 409, {
          ok: false,
          error: {
            code: 'scheduler_pool_in_use',
            message: `分组池仍有 ${boundCount} 个绑定的 API 密钥（其中 ${activeCount} 个活跃），请先解绑/迁移或传 force=1 强制删除`,
            keys: boundCount,
            active_keys: activeCount,
          },
        })
      }
      try {
        const deleted = force || migrateToPoolId ? repo.forceRemove(id, { migrateToPoolId }) : repo.forceRemove(id)
        try {
          db.prepare('DELETE FROM vm_pools WHERE id = ?').run(id)
        } catch {}
        apiKeyStore?.reload?.()
        await syncRuntimeConfig('panel_pool_delete')
        return json(res, 200, { ok: true, deleted: Boolean(deleted), id })
      } catch (e) {
        return json(res, httpStatusForPoolError(e), {
          ok: false,
          error: { message: String(e.message || e), code: e.code || 'delete_pool_failed' },
        })
      }
    }

    // PUT /api/panel/pools/:id/members
    const membersMatch = p.match(/^\/api\/panel\/pools\/([^/]+)\/members$/)
    if (req.method === 'PUT' && membersMatch) {
      const id = decodeURIComponent(membersMatch[1])
      const existing = repo.get(id)
      if (!existing) return json(res, 404, { ok: false, error: { code: 'pool_not_found', message: '分组池不存在' } })
      const body = await readBody(req, 256 * 1024).catch(() => ({}))
      try {
        const liveCtx = buildLiveContext(repo)
        const rawMembers = Array.isArray(body) ? body : body?.members
        const members = normalizeMemberListInput(rawMembers, liveCtx)
        const warnings = evaluatePoolMemberConflicts({
          targetPool: existing,
          members,
          allPools: repo.list(),
          vmById: liveCtx.vmById,
        })
        const updated = repo.setMembers(id, members)
        const enriched = enrichPoolView(updated, repo.listBoundKeySummariesByPool(id), liveCtx)
        await syncRuntimeConfig('panel_pool_update')
        return json(res, 200, panel.ok({ pool: enriched, warnings }))
      } catch (e) {
        return json(res, httpStatusForPoolError(e), {
          ok: false,
          error: {
            message: String(e.message || e),
            code: e.code || 'update_members_failed',
            ...(e.conflicting_pools ? { conflicting_pools: e.conflicting_pools } : {}),
          },
        })
      }
    }

    // POST /api/panel/pools/:id/reset-machine-sticky
    const resetStickyMatch = p.match(/^\/api\/panel\/pools\/([^/]+)\/reset-machine-sticky$/)
    if (req.method === 'POST' && resetStickyMatch) {
      const id = decodeURIComponent(resetStickyMatch[1])
      if (!repo.get(id)) {
        return json(res, 404, { ok: false, error: { code: 'pool_not_found', message: '分组池不存在' } })
      }
      const body = await readBody(req, 16 * 1024).catch(() => ({}))
      let nodeType = body?.node_type ? String(body.node_type).trim() : null
      let nodeId = body?.node_id ? String(body.node_id).trim() : null
      if (!nodeType && !nodeId && body?.node_key) {
        const parsed = parseNodeKey(body.node_key)
        if (parsed) {
          nodeType = parsed.node_type
          nodeId = parsed.node_id
        }
      }
      const rt = resolveRuntime()
      if (rt && typeof rt.deleteSticky === 'function') {
        try {
          const result = await rt.deleteSticky({
            pool_id: id,
            scope_kind: 'machine',
            ...(nodeType && nodeId
              ? { node_type: nodeType, node_id: nodeId, node_key: formatNodeKey(nodeType, nodeId) }
              : {}),
          })
          const cleared = Number(result?.deleted) || 0
          return json(res, 200, {
            ok: true,
            cleared,
            count: cleared,
            rust_deleted: result?.rust_deleted ?? 0,
            db_deleted: result?.db_deleted ?? 0,
            data: { cleared, count: cleared },
          })
        } catch (err) {
          return sendSchedulerError(res, err, 'reset_machine_sticky_failed')
        }
      }
      const cleared = repo.resetMachineStickyForPool(id, { nodeType, nodeId })
      return json(res, 200, { ok: true, cleared, count: cleared, data: { cleared, count: cleared } })
    }

    // GET / POST /api/panel/pools/:id/keys
    const poolKeysMatch = p.match(/^\/api\/panel\/pools\/([^/]+)\/keys$/)
    if (poolKeysMatch) {
      const id = decodeURIComponent(poolKeysMatch[1])
      if (!repo.get(id)) {
        return json(res, 404, { ok: false, error: { code: 'pool_not_found', message: '分组池不存在' } })
      }
      if (req.method === 'GET') {
        const keys = repo.listBoundKeySummariesByPool(id)
        return json(res, 200, panel.ok({ pool_id: id, keys }))
      }
      if (req.method === 'POST') {
        const body = await readBody(req, 16 * 1024).catch(() => ({}))
        const apiKeyId = String(body?.api_key_id || '').trim()
        if (!apiKeyId) {
          return json(res, 400, { ok: false, error: { code: 'missing_api_key_id', message: 'api_key_id 不能为空' } })
        }
        const keyRec = apiKeyStore?.getById?.(apiKeyId)
        if (!keyRec) {
          return json(res, 404, { ok: false, error: { code: 'api_key_not_found', message: 'API 密钥不存在' } })
        }
        const existingBindings = repo.listBindingsByKey(apiKeyId)
        const nextAllowed = [...new Set([...existingBindings.map((b) => b.pool_id), id])]
        const asDefault = body?.is_default !== false
        const curDefault = existingBindings.find((b) => b.is_default)?.pool_id || keyRec.default_pool_id || null
        const nextDefault = asDefault ? id : curDefault || id
        const bindingMode =
          body?.pool_binding_mode === 'strict_pool' || body?.pool_binding_mode === 'legacy_scope'
            ? body.pool_binding_mode
            : keyRec.pool_binding_mode || 'strict_pool'
        const bindings = repo.setKeyBindings(apiKeyId, nextAllowed, { defaultPoolId: nextDefault, bindingMode })
        if (keyRec.group_type !== 'gemini') {
          const nextLegacyVmPoolId = nextDefault && /^pool_[a-f0-9]{8}$/.test(nextDefault) ? nextDefault : null
          try {
            if (bindingMode === 'strict_pool') {
              db.prepare("UPDATE api_keys SET vm_pool_id = ?, group_type = 'all', allowed_vms = '[]' WHERE id = ?").run(
                nextLegacyVmPoolId,
                apiKeyId,
              )
            } else {
              db.prepare('UPDATE api_keys SET vm_pool_id = ? WHERE id = ?').run(nextLegacyVmPoolId, apiKeyId)
            }
          } catch {}
        }
        apiKeyStore?.reload?.()
        await syncRuntimeConfig('panel_pool_bind_key')
        return json(res, 200, panel.ok({ pool_id: id, api_key_id: apiKeyId, bindings }))
      }
    }

    // DELETE /api/panel/pools/:id/keys/:keyId
    const poolKeyDeleteMatch = p.match(/^\/api\/panel\/pools\/([^/]+)\/keys\/([^/]+)$/)
    if (req.method === 'DELETE' && poolKeyDeleteMatch) {
      const id = decodeURIComponent(poolKeyDeleteMatch[1])
      const apiKeyId = decodeURIComponent(poolKeyDeleteMatch[2])
      if (!repo.get(id)) {
        return json(res, 404, { ok: false, error: { code: 'pool_not_found', message: '分组池不存在' } })
      }
      const keyRec = apiKeyStore?.getById?.(apiKeyId)
      if (!keyRec) {
        return json(res, 404, { ok: false, error: { code: 'api_key_not_found', message: 'API 密钥不存在' } })
      }
      const remaining = repo
        .listBindingsByKey(apiKeyId)
        .map((b) => b.pool_id)
        .filter((pid) => pid !== id)
      const nextDefault =
        keyRec.default_pool_id && keyRec.default_pool_id !== id ? keyRec.default_pool_id : (remaining[0] ?? null)
      // Preserve strict_pool Fail-Closed semantics: removing the last pool must NOT silently widen to legacy_scope.
      const nextMode =
        keyRec.pool_binding_mode === 'strict_pool' ? 'strict_pool' : keyRec.pool_binding_mode || 'legacy_scope'
      const bindings = repo.setKeyBindings(apiKeyId, remaining, { defaultPoolId: nextDefault, bindingMode: nextMode })
      if (keyRec.group_type !== 'gemini') {
        const nextLegacyVmPoolId = nextDefault && /^pool_[a-f0-9]{8}$/.test(nextDefault) ? nextDefault : null
        try {
          db.prepare('UPDATE api_keys SET vm_pool_id = ? WHERE id = ?').run(nextLegacyVmPoolId, apiKeyId)
        } catch {}
      }
      apiKeyStore?.reload?.()
      await syncRuntimeConfig('panel_pool_unbind_key')
      return json(res, 200, panel.ok({ pool_id: id, api_key_id: apiKeyId, bindings }))
    }

    // POST /api/panel/scheduler/explain — read-only Rust dry-run sandbox (never acquires SessionGate)
    if (req.method === 'POST' && p === '/api/panel/scheduler/explain') {
      const rt = resolveRuntime()
      if (!rt || typeof rt.explainDispatch !== 'function') {
        return sendSchedulerError(
          res,
          new SchedulerUnavailableError('scheduler runtime is not available', { reason: 'runtime_missing' }),
        )
      }
      const body = await readBody(req, 64 * 1024).catch(() => ({}))
      const model = String(body?.model || '').trim()
      if (!model) {
        return json(res, 400, { ok: false, error: { code: 'missing_model', message: 'model 不能为空' } })
      }
      let apiKeyRecord = null
      let apiKeyKind = 'master'
      const reqApiKeyId = String(body?.api_key_id || '').trim()
      const reqRawKey = String(body?.api_key || '').trim()
      if (reqApiKeyId) {
        apiKeyRecord = apiKeyStore?.getById?.(reqApiKeyId) || null
        if (!apiKeyRecord) {
          return json(res, 404, { ok: false, error: { code: 'api_key_not_found', message: 'API 密钥不存在' } })
        }
        apiKeyKind = 'managed'
      } else if (reqRawKey) {
        const auth = apiKeyStore?.authenticate?.(reqRawKey)
        if (!auth?.ok || !auth.record) {
          return json(res, 404, { ok: false, error: { code: 'api_key_not_found', message: 'API 密钥无效或不存在' } })
        }
        apiKeyRecord = auth.record
        apiKeyKind = 'managed'
      }

      const requestedPoolId = String(body?.pool_id || '').trim() || null
      const liveCtx = buildLiveContext(repo)
      const ownerScope = apiKeyKind === 'master' ? PLATFORM_SCOPE : ownerScopeFromApiKey(apiKeyRecord, { apiKeyKind })
      const geminiOwnerMap = geminiOwnersRepo?.ownerMap?.() || null
      const geminiList = [...liveCtx.geminiById.values()]
      const apiEndpoints = [...liveCtx.epById.values()]

      let poolAccess = null
      if (apiKeyRecord || requestedPoolId) {
        poolAccess = resolvePoolAccessForKey({
          key: apiKeyRecord,
          apiKeyKind,
          requestedPoolId,
          model,
          poolsRepo: repo,
          vms: liveCtx.vms,
          geminiEnvs: geminiList,
          geminiOwnerMap,
          apiEndpoints,
          ownerScope,
        })
        if (!poolAccess.ok) {
          return json(
            res,
            200,
            panel.ok({
              origin_pool_id: requestedPoolId || apiKeyRecord?.default_pool_id || null,
              resolved_pool_id: null,
              resolved_pool_name: null,
              fallback_chain: [],
              selected_node: null,
              order: [],
              excluded: [],
              error: {
                code: poolAccess.code || 'pool_unavailable',
                message: poolAccess.message || '分组池不可用',
              },
            }),
          )
        }
      }

      const protocol = String(body?.protocol || '').trim()
      const modelFamily = inferModelFamily(model, protocol)
      const originPoolId =
        poolAccess?.originPool?.id ||
        requestedPoolId ||
        resolveVirtualPoolId({ modelFamily, provider: body?.provider || null })

      try {
        const rustExplain = await rt.explainDispatch({
          originPoolId,
          poolAccess,
          apiKeyRecord,
          apiKeyKind,
          ownerScope,
          model,
          modelFamily,
          protocol,
          machineId: body?.machine_id ? String(body.machine_id).trim() : null,
          sessionId: body?.session_id ? String(body.session_id).trim() : undefined,
          parentSessionId: body?.parent_session_id ? String(body.parent_session_id).trim() : null,
        })
        const exp = rustExplain?.explain || {}
        const resolvedId = rustExplain?.resolved_pool_id || exp.resolved_pool_id || originPoolId
        const resolvedPool = resolvedId ? repo.get(resolvedId) : null
        const nodeLabelOf = (nk) => {
          const parsed = parseNodeKey(nk)
          if (!parsed) return nk
          if (parsed.node_type === 'claude_vm' || parsed.node_type === 'codex_vm') {
            return liveCtx.vmById.get(parsed.node_id)?.name || parsed.node_id
          }
          if (parsed.node_type === 'gemini_env') {
            const env = liveCtx.geminiById.get(parsed.node_id)
            return env?.name || env?.email || parsed.node_id
          }
          if (parsed.node_type === 'api_endpoint') {
            return liveCtx.epById.get(parsed.node_id)?.name || parsed.node_id
          }
          return parsed.node_id
        }
        const selKey = rustExplain?.selected_node?.node_key || exp?.affinity?.selected_node || null
        const selectedNode = rustExplain?.selected_node
          ? {
              ...rustExplain.selected_node,
              name: nodeLabelOf(rustExplain.selected_node.node_key),
              stood_in: Boolean(rustExplain.stood_in),
            }
          : null
        const order = (exp.order || []).map((o) => {
          const parsed = parseNodeKey(o.node)
          const maxConc = Number(o.max_conc) || 0
          const inFlight = Number(o.in_flight) || 0
          return {
            node_key: o.node,
            node: o.node,
            node_type: parsed?.node_type,
            node_id: parsed?.node_id,
            name: nodeLabelOf(o.node),
            effective_weight_tier: o.tier,
            tier: o.tier,
            sub_weight: o.sub_weight,
            sub_bucket: o.sub_bucket,
            inflight: inFlight,
            in_flight: inFlight,
            max_concurrency: maxConc,
            max_conc: maxConc,
            active_sessions: o.active_sessions,
            max_sessions: o.max_sessions,
            load_ratio_bps: maxConc > 0 ? Math.round((inFlight * 10_000) / maxConc) : 0,
            sink_seq: o.sunk ? 1 : 0,
            sunk: Boolean(o.sunk),
            selected: Boolean(selKey && o.node === selKey),
          }
        })
        const excluded = (exp.excluded || []).map((ex) => ({
          node_key: ex.node,
          node: ex.node,
          pool_id: ex.pool_id,
          reason: ex.reason,
          detail: ex.detail || '',
        }))
        const rawPrompt = rustExplain?.prompt_policy || exp.prompt_policy || null
        const payload = {
          origin_pool_id: exp.origin_pool_id || originPoolId,
          resolved_pool_id: resolvedId,
          resolved_pool_name: resolvedPool?.name || resolvedId,
          fallback_chain: Array.isArray(exp.fallback_chain) ? exp.fallback_chain : [],
          jev_profile: resolvedPool?.jev_profile || 'inherit_global',
          config_version: exp.config_version ?? rt.configVersion,
          decide_us: exp.decide_us ?? 0,
          session_gate: {
            key: body?.session_id ? `${originPoolId}:${modelFamily}:${body.session_id}` : null,
            held: Boolean(exp.session_gate?.busy_at_peek),
            queue_depth: Number(exp.session_gate?.queue_depth_at_peek) || 0,
            queue_max: resolvedPool?.session_queue_max ?? 16,
            would_wait: Boolean(exp.session_gate?.busy_at_peek),
            busy_at_peek: Boolean(exp.session_gate?.busy_at_peek),
            queue_depth_at_peek: Number(exp.session_gate?.queue_depth_at_peek) || 0,
            wait_ms: Number(exp.session_gate?.wait_ms) || 0,
          },
          selected_node: selectedNode,
          affinity: exp.affinity
            ? {
                why: exp.affinity.why ?? null,
                target_node_key: exp.affinity.selected_node ?? exp.affinity.machine_home_node ?? null,
                machine_home_node: exp.affinity.machine_home_node ?? null,
                selected_node: exp.affinity.selected_node ?? null,
                machine_id_present: Boolean(exp.affinity.machine_id_present),
                session_id_source: exp.affinity.session_id_source ?? null,
                stood_in: Boolean(rustExplain?.stood_in ?? exp.affinity.stood_in),
                preserve_machine_home: Boolean(
                  rustExplain?.preserve_machine_home ?? exp.affinity.preserve_machine_home,
                ),
                notes: (exp.affinity.notes || []).map((n) => ({
                  why: n.why,
                  node_key: n.node,
                  node: n.node,
                })),
              }
            : null,
          prompt_policy: rawPrompt
            ? {
                mode: rawPrompt.mode,
                preset: rawPrompt.preset ?? null,
                text: rawPrompt.text ?? null,
                client_system_policy: rawPrompt.client_system_policy ?? null,
                source: rawPrompt.source,
                applies: rawPrompt.source !== 'provider_exempt',
              }
            : null,
          order,
          excluded,
          error:
            rustExplain?.ok === false
              ? {
                  code: rustExplain.error_code || 'pool_exhausted',
                  message: `调度模拟无可用节点 (${rustExplain.error_code || 'pool_exhausted'})`,
                }
              : null,
        }
        return json(res, 200, panel.ok(payload))
      } catch (err) {
        if (err instanceof SchedulerApiError && (err.status === 403 || err.status === 400 || err.status === 404)) {
          return json(
            res,
            200,
            panel.ok({
              origin_pool_id: originPoolId,
              resolved_pool_id: null,
              resolved_pool_name: null,
              fallback_chain: [],
              selected_node: null,
              order: [],
              excluded: [],
              error: { code: err.code, message: err.message },
            }),
          )
        }
        return sendSchedulerError(res, err, 'explain_failed')
      }
    }

    // POST /api/panel/scheduler/nodes/:nodeKey/unrest
    const unrestMatch = p.match(/^\/api\/panel\/scheduler\/nodes\/([^/]+)\/unrest$/)
    if (req.method === 'POST' && unrestMatch) {
      const rt = resolveRuntime()
      if (!rt || typeof rt.unrestNode !== 'function') {
        return sendSchedulerError(
          res,
          new SchedulerUnavailableError('scheduler runtime is not available', { reason: 'runtime_missing' }),
        )
      }
      const nodeKey = decodeURIComponent(unrestMatch[1]).trim()
      if (!parseNodeKey(nodeKey)) {
        return json(res, 400, {
          ok: false,
          error: { code: 'invalid_node_key', message: 'node_key 格式应为 <node_type>:<node_id>' },
        })
      }
      const body = await readBody(req, 16 * 1024).catch(() => ({}))
      try {
        const result = await rt.unrestNode(nodeKey, {
          modelScope: body?.model_scope ? String(body.model_scope).trim() : null,
        })
        return json(
          res,
          200,
          panel.ok({
            unrested: true,
            node_key: nodeKey,
            cleared_cooldowns: Number(result?.cleared_cooldowns) || 0,
            sink_cleared: Boolean(result?.sink_cleared),
            db_cleared: Number(result?.db_cleared) || 0,
          }),
        )
      } catch (err) {
        return sendSchedulerError(res, err, 'unrest_failed')
      }
    }

    // GET /api/panel/scheduler/events — SSE live routing/concurrency event stream proxy
    if (req.method === 'GET' && p === '/api/panel/scheduler/events') {
      const rt = resolveRuntime()
      if (!rt || typeof rt.subscribeEvents !== 'function') {
        return sendSchedulerError(
          res,
          new SchedulerUnavailableError('scheduler runtime is not available', { reason: 'runtime_missing' }),
        )
      }
      const after = String(url?.searchParams?.get('after') || req.headers?.['last-event-id'] || '').trim() || undefined
      const filterPoolId = String(url?.searchParams?.get('pool_id') || '').trim() || null
      const ac = new AbortController()
      let heartbeatTimer = null
      let closed = false

      const cleanup = () => {
        if (closed) return
        closed = true
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer)
          heartbeatTimer = null
        }
        try {
          ac.abort()
        } catch {}
      }
      req.once('close', cleanup)
      res.once('close', cleanup)

      const sub = rt.subscribeEvents({ after, signal: ac.signal })
      try {
        await sub.ready
      } catch (err) {
        cleanup()
        if (err instanceof SchedulerApiError && err.status === 409) {
          return json(res, 409, {
            ok: false,
            error: {
              code: err.code || 'snapshot_required',
              message: err.message || 'event cursor evicted; snapshot refresh required',
              ...(err.currentEpoch !== undefined ? { current_epoch: err.currentEpoch } : {}),
              ...(err.oldestSeq !== undefined ? { oldest_seq: err.oldestSeq } : {}),
              ...(err.latestSeq !== undefined ? { latest_seq: err.latestSeq } : {}),
            },
          })
        }
        return sendSchedulerError(res, err, 'scheduler_events_unavailable')
      }

      if (closed || res.writableEnded || res.destroyed) {
        sub.close()
        return true
      }

      if (typeof writeSSEHeaders === 'function') {
        writeSSEHeaders(res)
      } else {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
      }
      res.write(': connected\n\n')

      heartbeatTimer = setInterval(() => {
        if (closed || res.writableEnded || res.destroyed) return
        try {
          res.write(': keep-alive\n\n')
        } catch {
          cleanup()
          sub.close()
        }
      }, 15_000)
      heartbeatTimer.unref?.()

      try {
        for await (const frame of sub) {
          if (closed || res.writableEnded || res.destroyed) break
          const raw = frame?.data && typeof frame.data === 'object' ? frame.data : {}
          if (filterPoolId && raw.pool_id && String(raw.pool_id) !== filterPoolId) {
            continue
          }
          // Strict field-whitelist sanitization (no internal secrets/tokens/bodies)
          const evKind = String(raw.kind || frame?.event || 'event')
          const sanitized = {
            cursor: frame?.id || raw.cursor || null,
            epoch: raw.epoch ?? null,
            seq: raw.seq ?? null,
            ts: raw.ts_ms ?? Date.now(),
            ts_ms: raw.ts_ms ?? Date.now(),
            kind: evKind,
            type: evKind,
            event_type: evKind,
            ...(raw.pool_id != null ? { pool_id: String(raw.pool_id) } : {}),
            ...(raw.node_key != null ? { node_key: String(raw.node_key) } : {}),
            ...(raw.request_id != null ? { request_id: String(raw.request_id) } : {}),
            ...(raw.detail != null ? { detail: String(raw.detail).slice(0, 256) } : {}),
            ...(raw.code != null ? { code: String(raw.code) } : {}),
            ...(raw.message != null ? { message: String(raw.message).slice(0, 256) } : {}),
          }
          const idLine = sanitized.cursor ? `id: ${sanitized.cursor}\n` : ''
          res.write(`${idLine}event: ${evKind}\ndata: ${JSON.stringify(sanitized)}\n\n`)
        }
      } catch {
        // Stream aborted or disconnected cleanly.
      } finally {
        cleanup()
        sub.close()
        if (!res.writableEnded && !res.destroyed) {
          try {
            res.end()
          } catch {}
        }
      }
      return true
    }

    // GET / DELETE /api/panel/scheduler/sticky
    if (p === '/api/panel/scheduler/sticky') {
      const rt = resolveRuntime()
      if (req.method === 'GET') {
        const qs = url?.searchParams
        const includeExpired = qs?.get('include_expired') === '1'
        const filter = {
          pool_id: qs?.get('pool_id') || null,
          scope_kind: qs?.get('scope_kind') || null,
          model_family: qs?.get('model_family') || null,
          identity_id: qs?.get('identity_id') || null,
          machine_id: qs?.get('machine_id') || null,
          session_id: qs?.get('session_id') || null,
          node_key: qs?.get('node_key') || null,
        }
        if (rt && typeof rt.querySticky === 'function' && !includeExpired) {
          try {
            const live = await rt.querySticky(filter)
            const items = Array.isArray(live?.bindings) ? live.bindings : []
            return json(res, 200, panel.ok({ items, bindings: items, total: items.length }))
          } catch (err) {
            return sendSchedulerError(res, err, 'query_sticky_failed')
          }
        }
        const items = repo.queryStickyBindings({
          ...filter,
          includeExpired,
        })
        return json(res, 200, panel.ok({ items, bindings: items, total: items.length }))
      }
      if (req.method === 'DELETE') {
        const qs = url?.searchParams
        const body = await readBody(req, 16 * 1024).catch(() => ({}))
        const filter = {
          pool_id: qs?.get('pool_id') || body?.pool_id || null,
          scope_kind: qs?.get('scope_kind') || body?.scope_kind || null,
          model_family: qs?.get('model_family') || body?.model_family || null,
          identity_id: qs?.get('identity_id') || body?.identity_id || null,
          machine_id: qs?.get('machine_id') || body?.machine_id || null,
          session_id: qs?.get('session_id') || body?.session_id || null,
          node_type: qs?.get('node_type') || body?.node_type || null,
          node_id: qs?.get('node_id') || body?.node_id || null,
          node_key: qs?.get('node_key') || body?.node_key || null,
          allowAll: qs?.get('all') === '1' || body?.all === true,
        }
        const hasFilter = Boolean(
          filter.pool_id ||
            filter.scope_kind ||
            filter.model_family ||
            filter.identity_id ||
            filter.machine_id ||
            filter.session_id ||
            filter.node_type ||
            filter.node_id ||
            filter.node_key,
        )
        if (!hasFilter && !filter.allowAll) {
          return json(res, 400, {
            ok: false,
            error: { message: '删除粘性绑定至少需要一个过滤条件', code: 'sticky_filter_required' },
          })
        }
        if (rt && typeof rt.deleteSticky === 'function') {
          try {
            const result = await rt.deleteSticky(filter)
            const deleted = Number(result?.deleted) || 0
            return json(res, 200, {
              ok: true,
              deleted,
              rust_deleted: result?.rust_deleted ?? 0,
              db_deleted: result?.db_deleted ?? 0,
              data: { deleted },
            })
          } catch (err) {
            return sendSchedulerError(res, err, 'delete_sticky_failed')
          }
        }
        try {
          const deleted = repo.deleteStickyBindings(filter)
          return json(res, 200, { ok: true, deleted, data: { deleted } })
        } catch (e) {
          return json(res, httpStatusForPoolError(e), {
            ok: false,
            error: { message: String(e.message || e), code: e.code || 'delete_sticky_failed' },
          })
        }
      }
    }

    return false
  }
}
