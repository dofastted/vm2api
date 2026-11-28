import type {
  ClientSystemPolicy,
  IntraTierStrategy,
  JevProfile,
  PoolNodeType,
  PoolRole,
  ProviderScope,
  SchedulerExplainResponse,
  SchedulerPool,
  SchedulerPoolDraft,
  SessionOverflowPolicy,
  SystemPromptMode,
  SystemPromptPreset,
} from '@/types/panel-pools'

/** PRD v4 §4.2 & §7.3 锁定默认值（D1/D2/D3/D4）。 */
export const POOL_LOCKED_DEFAULTS = {
  enabled: true,
  exclusive_members: false, // D1: 允许 Anthropic CRAG VM 跨不同 Prompt 池复用（UI 强警告）
  provider_scope: 'anthropic' as ProviderScope,
  plan_tags: [] as string[],
  pool_role: 'standard' as PoolRole,
  sort_order: 0,
  fallback_pool_id: null as string | null,
  allow_cross_prompt_fallback: false,
  intra_tier_strategy: 'least_inflight_swrr' as IntraTierStrategy,
  session_queue_max: 16,
  session_queue_timeout_ms: 60000,
  queue_wait_ms: 15000,
  queue_max: 50,
  machine_sticky_enabled: true,
  machine_ttl_seconds: 604800, // 7 天
  session_sticky_enabled: true,
  session_ttl_seconds: 86400, // 24 小时
  session_overflow_policy: 'spill_immediately' as SessionOverflowPolicy, // D2: 满了就换
  session_busy_wait_ms: 0, // D2: 零干等
  system_prompt_mode: 'inherit_global' as SystemPromptMode,
  system_prompt_preset: 'official_full' as SystemPromptPreset,
  system_prompt_text: '',
  client_system_policy: 'prepend_pool' as ClientSystemPolicy,
  jev_profile: 'inherit_global' as JevProfile,
} as const

export const SYSTEM_PROMPT_MAX_BYTES = 64 * 1024 // 64 KiB 非 v3 CRAG 预检上限
export const MACHINE_TTL_MIN_SECONDS = 60
export const MACHINE_TTL_MAX_SECONDS = 2592000 // 30 天
export const SESSION_TTL_MIN_SECONDS = 60
export const SESSION_TTL_MAX_SECONDS = 604800 // 7 天
export const SESSION_QUEUE_MAX_MIN = 1
export const SESSION_QUEUE_MAX_LIMIT = 128
export const SESSION_QUEUE_TIMEOUT_MIN_MS = 1000
export const SESSION_QUEUE_TIMEOUT_MAX_MS = 300000
export const POOL_QUEUE_WAIT_MIN_MS = 0
export const POOL_QUEUE_WAIT_MAX_MS = 60000
export const POOL_QUEUE_MAX_MIN = 1
export const POOL_QUEUE_MAX_LIMIT = 999
export const SESSION_BUSY_WAIT_MAX_MS = 30000
export const MAX_FALLBACK_DEPTH = 3

export const PRESET_PLAN_TAGS = [
  'max_20x',
  'max_5x',
  'pro',
  'team',
  'gemini_ultra',
  'gemini_pro',
  'free',
  'payg',
] as const

export const PROVIDER_SCOPE_LABELS: Record<ProviderScope, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  api: 'API 直连',
  mixed: '混合',
}

export const POOL_ROLE_LABELS: Record<PoolRole, string> = {
  primary: '首选池',
  standard: '标准池',
  overflow: '溢出备用',
  downgrade: 'JEV 降级',
  dedicated: '专享池',
}

export const SYSTEM_PROMPT_MODE_LABELS: Record<SystemPromptMode, string> = {
  official: '官方提示词',
  zero_inject: '0 注入',
  override: '自定义覆写',
  append: '尾部追加',
  passthrough: '原样透传',
  inherit_global: '继承全局',
}

export const SYSTEM_PROMPT_PRESET_LABELS: Record<SystemPromptPreset, string> = {
  official_full: 'official_full（官方完整）',
  official: 'official（官方精简）',
  official_303: 'official_303（303 版）',
}

export const CLIENT_SYSTEM_POLICY_LABELS: Record<ClientSystemPolicy, string> = {
  prepend_pool: '池文本前置（prepend_pool）',
  append_pool: '池文本后置 · 最优保 Cache（append_pool）',
  replace_client: '完全替换客户端 system（replace_client）',
}

export const INTRA_TIER_STRATEGY_LABELS: Record<IntraTierStrategy, string> = {
  least_inflight_swrr: '最低并发 + SWRR（默认）',
  balanced: '负载均衡（balanced）',
  fill: '集中填满（fill）',
  ordered: '固定顺序（ordered）',
}

export const SESSION_OVERFLOW_POLICY_LABELS: Record<
  SessionOverflowPolicy,
  string
> = {
  spill_immediately: '满了就换（spill_immediately · 默认）',
  wait_then_spill: '短等后切（wait_then_spill）',
  strict: '严格守槽（strict）',
}

export const JEV_PROFILE_LABELS: Record<JevProfile, string> = {
  inherit_global: '继承全局',
  enforce: '强制审查拦截',
  downgrade_only: '仅降级分流',
  bypass_trusted: '信任池豁免',
}

export const NODE_TYPE_LABELS: Record<PoolNodeType, string> = {
  claude_vm: 'Claude VM',
  codex_vm: 'Codex VM',
  gemini_env: 'Gemini 邮箱',
  api_endpoint: 'API 渠道',
}

const utf8Encoder = new TextEncoder()

export function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text || '').length
}

/** 规范化 provider_scope，兼容别名 `gemini` -> `google`。 */
export function normalizeProviderScope(raw: string | undefined): ProviderScope {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
  if (s === 'gemini' || s === 'google') return 'google'
  if (s === 'anthropic' || s === 'claude') return 'anthropic'
  if (s === 'openai' || s === 'codex') return 'openai'
  if (s === 'api') return 'api'
  return 'mixed'
}

/** PRD §4.2: openai / google 分组池不做池级 System Prompt 注入，强制锁定 passthrough。 */
export function isPromptLockedProvider(
  scope: ProviderScope | string | undefined
): boolean {
  const normalized = normalizeProviderScope(scope)
  return normalized === 'openai' || normalized === 'google'
}

export function defaultSystemPromptModeForProvider(
  scope: ProviderScope | string | undefined
): SystemPromptMode {
  return isPromptLockedProvider(scope) ? 'passthrough' : 'inherit_global'
}

export function createDefaultPoolDraft(
  overrides: Partial<SchedulerPoolDraft> = {}
): SchedulerPoolDraft {
  const provider_scope = normalizeProviderScope(
    overrides.provider_scope ?? POOL_LOCKED_DEFAULTS.provider_scope
  )
  const locked = isPromptLockedProvider(provider_scope)
  const base: SchedulerPoolDraft = {
    name: '',
    slug: '',
    description: '',
    enabled: POOL_LOCKED_DEFAULTS.enabled,
    exclusive_members: POOL_LOCKED_DEFAULTS.exclusive_members,
    provider_scope,
    plan_tags: [...POOL_LOCKED_DEFAULTS.plan_tags],
    pool_role: POOL_LOCKED_DEFAULTS.pool_role,
    sort_order: POOL_LOCKED_DEFAULTS.sort_order,
    fallback_pool_id: POOL_LOCKED_DEFAULTS.fallback_pool_id,
    allow_cross_prompt_fallback:
      POOL_LOCKED_DEFAULTS.allow_cross_prompt_fallback,
    intra_tier_strategy: POOL_LOCKED_DEFAULTS.intra_tier_strategy,
    session_queue_max: POOL_LOCKED_DEFAULTS.session_queue_max,
    session_queue_timeout_ms: POOL_LOCKED_DEFAULTS.session_queue_timeout_ms,
    queue_wait_ms: POOL_LOCKED_DEFAULTS.queue_wait_ms,
    queue_max: POOL_LOCKED_DEFAULTS.queue_max,
    machine_sticky_enabled: POOL_LOCKED_DEFAULTS.machine_sticky_enabled,
    machine_ttl_seconds: POOL_LOCKED_DEFAULTS.machine_ttl_seconds,
    session_sticky_enabled: POOL_LOCKED_DEFAULTS.session_sticky_enabled,
    session_ttl_seconds: POOL_LOCKED_DEFAULTS.session_ttl_seconds,
    session_busy_wait_ms: POOL_LOCKED_DEFAULTS.session_busy_wait_ms,
    session_overflow_policy: POOL_LOCKED_DEFAULTS.session_overflow_policy,
    system_prompt_mode: defaultSystemPromptModeForProvider(provider_scope),
    system_prompt_preset: POOL_LOCKED_DEFAULTS.system_prompt_preset,
    system_prompt_text: '',
    client_system_policy: POOL_LOCKED_DEFAULTS.client_system_policy,
    jev_profile: POOL_LOCKED_DEFAULTS.jev_profile,
  }
  const merged: SchedulerPoolDraft = { ...base, ...overrides, provider_scope }
  if (locked) {
    merged.system_prompt_mode = 'passthrough'
    merged.system_prompt_text = ''
  }
  return merged
}

export function poolToDraft(pool: SchedulerPool): SchedulerPoolDraft {
  const scope = normalizeProviderScope(pool.provider_scope)
  const locked = isPromptLockedProvider(scope)
  return {
    name: pool.name || '',
    slug: pool.slug || '',
    description: pool.description || '',
    enabled: pool.enabled !== false,
    exclusive_members: Boolean(pool.exclusive_members),
    provider_scope: scope,
    plan_tags: Array.isArray(pool.plan_tags) ? [...pool.plan_tags] : [],
    pool_role: pool.pool_role || 'standard',
    sort_order: Number(pool.sort_order ?? 0),
    fallback_pool_id: pool.fallback_pool_id ?? null,
    allow_cross_prompt_fallback: Boolean(pool.allow_cross_prompt_fallback),
    intra_tier_strategy: pool.intra_tier_strategy || 'least_inflight_swrr',
    session_queue_max: Number(
      pool.session_queue_max ?? POOL_LOCKED_DEFAULTS.session_queue_max
    ),
    session_queue_timeout_ms: Number(
      pool.session_queue_timeout_ms ??
        POOL_LOCKED_DEFAULTS.session_queue_timeout_ms
    ),
    queue_wait_ms: Number(
      pool.queue_wait_ms ?? POOL_LOCKED_DEFAULTS.queue_wait_ms
    ),
    queue_max: Number(pool.queue_max ?? POOL_LOCKED_DEFAULTS.queue_max),
    machine_sticky_enabled: pool.machine_sticky_enabled !== false,
    machine_ttl_seconds: Number(
      pool.machine_ttl_seconds ?? POOL_LOCKED_DEFAULTS.machine_ttl_seconds
    ),
    session_sticky_enabled: pool.session_sticky_enabled !== false,
    session_ttl_seconds: Number(
      pool.session_ttl_seconds ?? POOL_LOCKED_DEFAULTS.session_ttl_seconds
    ),
    session_busy_wait_ms: Number(
      pool.session_busy_wait_ms ?? POOL_LOCKED_DEFAULTS.session_busy_wait_ms
    ),
    session_overflow_policy:
      pool.session_overflow_policy ||
      POOL_LOCKED_DEFAULTS.session_overflow_policy,
    system_prompt_mode: locked
      ? 'passthrough'
      : pool.system_prompt_mode || defaultSystemPromptModeForProvider(scope),
    system_prompt_preset: pool.system_prompt_preset || 'official_full',
    system_prompt_text: locked ? '' : pool.system_prompt_text || '',
    client_system_policy: pool.client_system_policy || 'prepend_pool',
    jev_profile: pool.jev_profile || 'inherit_global',
  }
}

export function slugifyPoolName(name: string): string {
  const ascii = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return ascii || 'pool'
}

export type PoolPromptValidation = {
  ok: boolean
  code?:
    'pool_prompt_unsupported_provider' | 'prompt_too_large' | 'prompt_empty'
  message?: string
  bytes: number
}

export function validatePoolPromptPolicy(input: {
  provider_scope: ProviderScope | string
  system_prompt_mode: SystemPromptMode
  system_prompt_text?: string
}): PoolPromptValidation {
  const bytes = utf8ByteLength(input.system_prompt_text || '')
  if (
    isPromptLockedProvider(input.provider_scope) &&
    input.system_prompt_mode !== 'passthrough'
  ) {
    return {
      ok: false,
      code: 'pool_prompt_unsupported_provider',
      message:
        'OpenAI / Google 分组池不使用 System Prompt 注入，必须锁定为原样透传（passthrough）',
      bytes,
    }
  }
  if (
    (input.system_prompt_mode === 'override' ||
      input.system_prompt_mode === 'append') &&
    bytes > SYSTEM_PROMPT_MAX_BYTES
  ) {
    return {
      ok: false,
      code: 'prompt_too_large',
      message: `提示词正文超出非 v3 CRAG 64 KiB 上限（当前 ${bytes.toLocaleString()} 字节）`,
      bytes,
    }
  }
  if (
    (input.system_prompt_mode === 'override' ||
      input.system_prompt_mode === 'append') &&
    !String(input.system_prompt_text || '').trim()
  ) {
    return {
      ok: false,
      code: 'prompt_empty',
      message: '自定义覆写 / 尾部追加模式下提示词正文不能为空',
      bytes,
    }
  }
  return { ok: true, bytes }
}

/** 构造提交到 POST/PATCH /api/panel/pools 的净化载荷（OpenAI/Google 强锁 passthrough）。 */
export function buildPoolPayload(
  draft: SchedulerPoolDraft
): Record<string, unknown> {
  const scope = normalizeProviderScope(draft.provider_scope)
  const locked = isPromptLockedProvider(scope)
  const name = draft.name.trim()
  if (!name) throw new Error('分组池名称不能为空')
  const mode: SystemPromptMode = locked
    ? 'passthrough'
    : draft.system_prompt_mode
  const text = locked ? '' : draft.system_prompt_text || ''
  const promptCheck = validatePoolPromptPolicy({
    provider_scope: scope,
    system_prompt_mode: mode,
    system_prompt_text: text,
  })
  if (!promptCheck.ok) throw new Error(promptCheck.message || 'Prompt 策略无效')

  const machineTtl = clampInt(
    draft.machine_ttl_seconds,
    MACHINE_TTL_MIN_SECONDS,
    MACHINE_TTL_MAX_SECONDS,
    POOL_LOCKED_DEFAULTS.machine_ttl_seconds
  )
  const sessionTtl = clampInt(
    draft.session_ttl_seconds,
    SESSION_TTL_MIN_SECONDS,
    SESSION_TTL_MAX_SECONDS,
    POOL_LOCKED_DEFAULTS.session_ttl_seconds
  )
  const sessionBusyWait =
    draft.session_overflow_policy === 'spill_immediately'
      ? 0
      : clampInt(
          draft.session_busy_wait_ms,
          0,
          SESSION_BUSY_WAIT_MAX_MS,
          POOL_LOCKED_DEFAULTS.session_busy_wait_ms
        )

  return {
    name,
    slug: draft.slug.trim() || slugifyPoolName(name),
    description: draft.description.trim(),
    enabled: draft.enabled,
    exclusive_members: draft.exclusive_members,
    provider_scope: scope,
    plan_tags: [
      ...new Set(draft.plan_tags.map((t) => t.trim()).filter(Boolean)),
    ],
    pool_role: draft.pool_role,
    sort_order: Number.isFinite(draft.sort_order)
      ? Math.trunc(draft.sort_order)
      : 0,
    fallback_pool_id: draft.fallback_pool_id?.trim() || null,
    allow_cross_prompt_fallback: locked
      ? false
      : Boolean(draft.allow_cross_prompt_fallback),
    intra_tier_strategy: draft.intra_tier_strategy,
    session_queue_max: clampInt(
      draft.session_queue_max,
      SESSION_QUEUE_MAX_MIN,
      SESSION_QUEUE_MAX_LIMIT,
      POOL_LOCKED_DEFAULTS.session_queue_max
    ),
    session_queue_timeout_ms: clampInt(
      draft.session_queue_timeout_ms,
      SESSION_QUEUE_TIMEOUT_MIN_MS,
      SESSION_QUEUE_TIMEOUT_MAX_MS,
      POOL_LOCKED_DEFAULTS.session_queue_timeout_ms
    ),
    queue_wait_ms: clampInt(
      draft.queue_wait_ms,
      POOL_QUEUE_WAIT_MIN_MS,
      POOL_QUEUE_WAIT_MAX_MS,
      POOL_LOCKED_DEFAULTS.queue_wait_ms
    ),
    queue_max: clampInt(
      draft.queue_max,
      POOL_QUEUE_MAX_MIN,
      POOL_QUEUE_MAX_LIMIT,
      POOL_LOCKED_DEFAULTS.queue_max
    ),
    machine_sticky_enabled: draft.machine_sticky_enabled,
    machine_ttl_seconds: machineTtl,
    session_sticky_enabled: draft.session_sticky_enabled,
    session_ttl_seconds: sessionTtl,
    session_overflow_policy: draft.session_overflow_policy,
    session_busy_wait_ms: sessionBusyWait,
    system_prompt_mode: mode,
    system_prompt_preset: draft.system_prompt_preset,
    system_prompt_text: text,
    client_system_policy: draft.client_system_policy,
    jev_profile: draft.jev_profile,
  }
}

function clampInt(
  value: number,
  min: number,
  max: number,
  fallback: number
): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

// ── TTL 单位换算（天 / 时 / 分）────────────────────────────────────────────────

export type TtlUnit = 'minutes' | 'hours' | 'days'

export const TTL_UNIT_SECONDS: Record<TtlUnit, number> = {
  minutes: 60,
  hours: 3600,
  days: 86400,
}

export const TTL_UNIT_LABELS: Record<TtlUnit, string> = {
  minutes: '分钟',
  hours: '小时',
  days: '天',
}

export function ttlPartsToSeconds(value: number, unit: TtlUnit): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(n * TTL_UNIT_SECONDS[unit])
}

export function secondsToTtlParts(
  seconds: number,
  preferredUnit?: TtlUnit
): { value: number; unit: TtlUnit } {
  const s = Math.max(60, Math.round(Number(seconds) || 60))
  if (preferredUnit && s % TTL_UNIT_SECONDS[preferredUnit] === 0) {
    return {
      value: s / TTL_UNIT_SECONDS[preferredUnit],
      unit: preferredUnit,
    }
  }
  if (s % 86400 === 0) return { value: s / 86400, unit: 'days' }
  if (s % 3600 === 0) return { value: s / 3600, unit: 'hours' }
  return { value: Math.max(1, Math.round(s / 60)), unit: 'minutes' }
}

/** 人类可读粘性时长：`7 天` / `24 小时` / `1 天 12 小时` / `30 分钟`。 */
export function formatTtlLabel(seconds: number): string {
  const s = Math.max(0, Math.round(Number(seconds) || 0))
  if (s === 0) return '0 秒'
  if (s < 60) return `${s} 秒`
  if (s === 86400) return '24 小时'
  if (s % 86400 === 0) return `${s / 86400} 天`
  if (s % 3600 === 0) return `${s / 3600} 小时`
  if (s > 86400) {
    const days = Math.floor(s / 86400)
    const hours = Math.round((s % 86400) / 3600)
    return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`
  }
  if (s > 3600) {
    const hours = Math.floor(s / 3600)
    const mins = Math.round((s % 3600) / 60)
    return mins > 0 ? `${hours} 小时 ${mins} 分钟` : `${hours} 小时`
  }
  return `${Math.round(s / 60)} 分钟`
}

// ── 成员跨池冲突与 D1 风控判定 ────────────────────────────────────────────────

export type MemberConflictResult =
  | { level: 'ok' }
  | {
      level: 'warning'
      reason: 'crag_cross_prompt'
      conflictingPools: Array<{
        id: string
        name: string
        system_prompt_mode: SystemPromptMode
      }>
      message: string
    }
  | {
      level: 'blocked'
      reason:
        'exclusive_target' | 'exclusive_other' | 'cli_node_prompt_conflict'
      conflictingPools: Array<{
        id: string
        name: string
        system_prompt_mode: SystemPromptMode
      }>
      message: string
    }

export function nodeKeyOf(nodeType: PoolNodeType | string, nodeId: string) {
  return `${nodeType}:${nodeId}`
}

/**
 * PRD §4.2 & §7.3 D1:
 * - 开启 `exclusive_members`（目标池或其他持有池）→ 硬拦截；
 * - 旧式 Anthropic `cli-node` 跨不同 `system_prompt_mode` 启用池 → 硬拦截；
 * - Anthropic CRAG VM 跨不同 `system_prompt_mode` 启用池 → 允许添加，但给出强风控警告（D1）；
 * - OpenAI (`codex_vm`) / Google (`gemini_env`) 不涉及 Prompt 冲突。
 */
export function analyzeMemberConflicts(params: {
  targetPool: Pick<
    SchedulerPool,
    | 'id'
    | 'enabled'
    | 'exclusive_members'
    | 'provider_scope'
    | 'system_prompt_mode'
  >
  candidate: {
    node_type: PoolNodeType
    node_id: string
    runtime_kind?:
      'crag' | 'cli-node' | 'codex' | 'gemini' | 'api' | string | null
    dataplane?: string | null
  }
  allPools: SchedulerPool[]
}): MemberConflictResult {
  const { targetPool, candidate, allPools } = params
  const otherHolders = allPools.filter((pool) => {
    if (pool.id === targetPool.id) return false
    const inMembers = (pool.members || []).some(
      (m) =>
        m.node_type === candidate.node_type &&
        m.node_id === candidate.node_id &&
        m.enabled !== false
    )
    const inVmIds =
      (candidate.node_type === 'claude_vm' ||
        candidate.node_type === 'codex_vm') &&
      (pool.vm_ids || []).includes(candidate.node_id)
    return inMembers || inVmIds
  })

  if (otherHolders.length === 0) return { level: 'ok' }

  if (targetPool.exclusive_members) {
    return {
      level: 'blocked',
      reason: 'exclusive_target',
      conflictingPools: otherHolders.map((p) => ({
        id: p.id,
        name: p.name,
        system_prompt_mode: p.system_prompt_mode,
      })),
      message: `本池已开启成员独占（exclusive_members），节点已属于：${otherHolders.map((p) => p.name).join('、')}`,
    }
  }

  const exclusiveOwners = otherHolders.filter((p) => p.exclusive_members)
  if (exclusiveOwners.length > 0) {
    return {
      level: 'blocked',
      reason: 'exclusive_other',
      conflictingPools: exclusiveOwners.map((p) => ({
        id: p.id,
        name: p.name,
        system_prompt_mode: p.system_prompt_mode,
      })),
      message: `该节点已被独占池占用：${exclusiveOwners.map((p) => p.name).join('、')}`,
    }
  }

  // System Prompt 冲突仅针对 Anthropic VM（claude_vm）
  if (
    candidate.node_type === 'claude_vm' &&
    !isPromptLockedProvider(targetPool.provider_scope)
  ) {
    const promptConflictPools = otherHolders.filter(
      (p) =>
        p.enabled !== false &&
        !isPromptLockedProvider(p.provider_scope) &&
        p.system_prompt_mode !== targetPool.system_prompt_mode
    )
    if (promptConflictPools.length > 0) {
      const isCrag =
        candidate.runtime_kind === 'crag' || candidate.dataplane === 'crag'
      const summary = promptConflictPools
        .map(
          (p) =>
            `${p.name}（${SYSTEM_PROMPT_MODE_LABELS[p.system_prompt_mode] || p.system_prompt_mode}）`
        )
        .join('、')
      if (!isCrag) {
        return {
          level: 'blocked',
          reason: 'cli_node_prompt_conflict',
          conflictingPools: promptConflictPools.map((p) => ({
            id: p.id,
            name: p.name,
            system_prompt_mode: p.system_prompt_mode,
          })),
          message: `旧式 cli-node 容器槽禁止同时加入不同 System Prompt 模式的启用池（冲突池：${summary}）`,
        }
      }
      return {
        level: 'warning',
        reason: 'crag_cross_prompt',
        conflictingPools: promptConflictPools.map((p) => ({
          id: p.id,
          name: p.name,
          system_prompt_mode: p.system_prompt_mode,
        })),
        message: `风控警告：该 Anthropic CRAG VM 已在 ${summary} 中，与本池「${SYSTEM_PROMPT_MODE_LABELS[targetPool.system_prompt_mode]}」不同。系统允许复用（D1），请确认同号跨提示词风控。`,
      }
    }
  }

  return { level: 'ok' }
}

// ── Fallback 链防环 / 最大深度 3 / 跨 Prompt 校验 ──────────────────────────────

export type FallbackValidation = {
  ok: boolean
  warning?: string
  error?: string
  chain: string[]
}

export function validateFallbackPool(params: {
  sourcePool: Pick<
    SchedulerPool,
    | 'id'
    | 'provider_scope'
    | 'system_prompt_mode'
    | 'allow_cross_prompt_fallback'
  >
  nextFallbackPoolId: string | null
  allPools: SchedulerPool[]
}): FallbackValidation {
  const { sourcePool, nextFallbackPoolId, allPools } = params
  if (!nextFallbackPoolId) return { ok: true, chain: [sourcePool.id] }
  if (nextFallbackPoolId === sourcePool.id) {
    return {
      ok: false,
      error: 'Fallback 目标不能指向自身',
      chain: [sourcePool.id],
    }
  }
  const byId = new Map(allPools.map((p) => [p.id, p]))
  const target = byId.get(nextFallbackPoolId)
  if (!target) {
    return {
      ok: false,
      error: `未找到 Fallback 目标池：${nextFallbackPoolId}`,
      chain: [sourcePool.id],
    }
  }

  const chain = [sourcePool.id]
  let cur: string | null = nextFallbackPoolId
  while (cur) {
    if (chain.includes(cur)) {
      return {
        ok: false,
        error: `检测到 Fallback 环形引用：${[...chain, cur].join(' → ')}`,
        chain: [...chain, cur],
      }
    }
    chain.push(cur)
    if (chain.length > MAX_FALLBACK_DEPTH) {
      return {
        ok: false,
        error: `Fallback 链长度不能超过 ${MAX_FALLBACK_DEPTH} 层（当前 ${chain.length} 层）`,
        chain,
      }
    }
    cur = byId.get(cur)?.fallback_pool_id ?? null
  }

  // Anthropic 跨 Prompt 回落校验
  const involvesAnthropic =
    !isPromptLockedProvider(sourcePool.provider_scope) &&
    !isPromptLockedProvider(target.provider_scope)
  if (
    involvesAnthropic &&
    sourcePool.system_prompt_mode !== target.system_prompt_mode
  ) {
    const desc = `目标池「${target.name}」的 Prompt 模式为「${SYSTEM_PROMPT_MODE_LABELS[target.system_prompt_mode]}」，与本池「${SYSTEM_PROMPT_MODE_LABELS[sourcePool.system_prompt_mode]}」不一致`
    if (!sourcePool.allow_cross_prompt_fallback) {
      return {
        ok: false,
        error: `${desc}；默认禁止跨 Prompt 回落，请勾选「允许跨 Prompt 模式 Fallback」或改选同策略池`,
        chain,
      }
    }
    return {
      ok: true,
      warning: `注意：${desc}，跨池回落时请求将切换为目标池的 Prompt 策略。`,
      chain,
    }
  }

  return { ok: true, chain }
}

// ── Explain 结果中文格式化 ────────────────────────────────────────────────────

const AFFINITY_WHY_LABELS: Record<
  string,
  { label: string; tone: 'ok' | 'caution' | 'warn' | 'neutral' }
> = {
  SessionHit: { label: '会话 1:1 粘性命中', tone: 'ok' },
  SessionHitAfterWait: { label: '会话短等后命中原节点', tone: 'ok' },
  SessionSpillBusy: { label: '会话绑定节点满载 → 满了就换', tone: 'caution' },
  SessionNodeUnavailable: { label: '会话原节点不可用 → 重选', tone: 'warn' },
  SubagentFollowParent: { label: '子 Agent 跟随父会话节点', tone: 'ok' },
  MachineHomeHit: { label: '设备 1 周粘性权重 1 命中', tone: 'ok' },
  MachineHomeCapacitySpill: {
    label: '设备主节点满载 → 零冷却溢出（保主绑定）',
    tone: 'caution',
  },
  MachineHomeUnavailable: { label: '设备主节点不可用 → 重定锚', tone: 'warn' },
  TierRanked: { label: '按权重等级优选分配', tone: 'neutral' },
  AdminPinned: { label: '管理面定向诊断直达', tone: 'neutral' },
}

const EXCLUDED_REASON_LABELS: Record<string, string> = {
  schedulable_false: '已关闭调度',
  unschedulable: '不可调度（故障/吊销）',
  active_hours: '不在工作时段',
  active_hours_outside: '不在工作时段',
  model_unsupported: '不支持该模型',
  cooldown: '冷却中',
  model_cooldown: '单模型冷却中',
  node_cooldown: '节点冷却中',
  quota_exhausted: '配额已达硬上限 (≥95%)',
  host_memory_pressure: '宿主机内存压力',
  proxy_not_ready: '出口代理未就绪',
  circuit_open: '熔断开启',
  excluded: '尝试排除列表',
  key_scope: '超出 API Key 权限范围',
  tenant_mismatch: '租户隔离不匹配',
  member_disabled: '池成员已停用',
  capacity_full: '并发/席位已满',
}

export function formatAffinityWhy(why: string | null | undefined): {
  label: string
  tone: 'ok' | 'caution' | 'warn' | 'neutral'
} {
  const key = String(why || '').trim()
  if (!key) return { label: '按权重等级分配', tone: 'neutral' }
  return AFFINITY_WHY_LABELS[key] ?? { label: key, tone: 'neutral' }
}

export function formatExcludedReason(reason: string): string {
  const key = String(reason || '').trim()
  return EXCLUDED_REASON_LABELS[key] ?? key
}

export type FormattedExplainSummary = {
  resolvedPoolLabel: string
  selectedNodeLabel: string
  affinityLabel: string
  affinityTone: 'ok' | 'caution' | 'warn' | 'neutral'
  gateLabel: string
  gateTone: 'ok' | 'caution' | 'warn'
  jevLabel: string
  jevTone: 'ok' | 'caution' | 'bad' | 'neutral'
  promptLabel: string
  orderCount: number
  excludedCount: number
  excludedItems: Array<{
    node_key: string
    pool_id?: string
    reasonCode: string
    reasonLabel: string
    detail?: string
  }>
}

export function formatExplainSummary(
  resp: SchedulerExplainResponse
): FormattedExplainSummary {
  const resolvedPoolLabel = resp.resolved_pool_name
    ? `${resp.resolved_pool_name} (${resp.resolved_pool_id || '—'})`
    : resp.resolved_pool_id || '未命中池'

  const selectedNodeLabel = resp.selected_node
    ? `${resp.selected_node.name || resp.selected_node.node_key}${
        resp.selected_node.effective_weight_tier != null
          ? ` · T${resp.selected_node.effective_weight_tier}`
          : ''
      }${resp.selected_node.stood_in ? ' · 临时替补' : ''}`
    : resp.error?.message || '无可用节点'

  const aff = formatAffinityWhy(resp.affinity?.why)

  const gate = resp.session_gate
  let gateLabel = '空闲（无需排队）'
  let gateTone: 'ok' | 'caution' | 'warn' = 'ok'
  if (gate?.held || gate?.would_wait) {
    const depth = gate.queue_depth ?? 0
    const max = gate.queue_max ?? POOL_LOCKED_DEFAULTS.session_queue_max
    gateLabel = `持有中 · FIFO 排队 ${depth}/${max}（模拟只读不阻塞）`
    gateTone = depth >= max ? 'warn' : 'caution'
  }

  const jevAction = resp.jev_decision?.action
  let jevLabel = resp.jev_profile
    ? JEV_PROFILE_LABELS[resp.jev_profile as JevProfile] || resp.jev_profile
    : '继承全局'
  let jevTone: 'ok' | 'caution' | 'bad' | 'neutral' = 'neutral'
  if (jevAction === 'allow') {
    jevLabel = `放行 (${jevLabel})`
    jevTone = 'ok'
  } else if (jevAction === 'downgrade') {
    jevLabel = `触发降级 → ${resp.jev_decision?.downgrade_pool_id || '降级池'}`
    jevTone = 'caution'
  } else if (jevAction === 'block') {
    jevLabel = `前置拦截：${resp.jev_decision?.reason || '高风险'}`
    jevTone = 'bad'
  }

  let promptLabel = '原样透传（无注入）'
  if (resp.prompt_policy?.mode) {
    const m =
      SYSTEM_PROMPT_MODE_LABELS[resp.prompt_policy.mode] ||
      resp.prompt_policy.mode
    promptLabel =
      resp.prompt_policy.applies === false
        ? `${m}（当前节点非 Anthropic，恒透传）`
        : m
  }

  const excludedItems = (resp.excluded || []).map((item) => ({
    node_key: item.node_key,
    pool_id: item.pool_id,
    reasonCode: item.reason,
    reasonLabel: formatExcludedReason(item.reason),
    detail: item.detail,
  }))

  return {
    resolvedPoolLabel,
    selectedNodeLabel,
    affinityLabel: aff.label,
    affinityTone: aff.tone,
    gateLabel,
    gateTone,
    jevLabel,
    jevTone,
    promptLabel,
    orderCount: (resp.order || []).length,
    excludedCount: excludedItems.length,
    excludedItems,
  }
}

/** 聚合提取池指标（兼容嵌套 metrics 与扁平字段）。 */
export function poolSummaryMetrics(pool: SchedulerPool) {
  const m = pool.metrics || {}
  const totalMembers =
    m.total_members ??
    pool.total_members ??
    pool.members?.length ??
    pool.vm_ids?.length ??
    0
  const healthyMembers =
    m.healthy_members ??
    pool.healthy_members ??
    (pool.members
      ? pool.members.filter(
          (item) => item.enabled !== false && item.healthy !== false
        ).length
      : totalMembers)
  const inflight =
    m.inflight ??
    pool.inflight ??
    (pool.members || []).reduce(
      (acc, item) => acc + (Number(item.inflight) || 0),
      0
    )
  const maxConcurrency =
    m.max_concurrency ??
    pool.max_concurrency ??
    (pool.members || []).reduce(
      (acc, item) => acc + (Number(item.max_concurrency) || 0),
      0
    )
  const boundKeysCount =
    m.bound_keys_count ?? pool.bound_keys_count ?? pool.bound_keys?.length ?? 0
  const activeBoundKeysCount =
    m.active_bound_keys_count ??
    pool.active_bound_keys_count ??
    (pool.bound_keys
      ? pool.bound_keys.filter((k) => k.status !== 'disabled').length
      : boundKeysCount)

  return {
    totalMembers,
    healthyMembers,
    inflight,
    maxConcurrency,
    concurrencyPct:
      maxConcurrency > 0
        ? Math.min(100, Math.round((inflight / maxConcurrency) * 100))
        : 0,
    machineHitRate: m.machine_sticky_hit_rate_1h ?? null,
    sessionHitRate: m.session_sticky_hit_rate_1h ?? null,
    spillRate: m.spill_rate_1h ?? null,
    boundKeysCount,
    activeBoundKeysCount,
  }
}
