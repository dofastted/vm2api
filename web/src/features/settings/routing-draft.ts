import type { OpenAIQuotaPolicy, QuotaTierPolicy } from '@/types/panel-vm'
import {
  cacheTtlFromCompat,
  detectProxiedOfficialCcFromCompat,
} from '@/lib/cache-breakpoints'
import { SEAT_CAP_MAX } from '@/components/scheduler-viz'
import { SETTINGS_TAB_LABELS, type SettingsTabId } from './navigation'
import {
  cchEnabledFromCompat,
  cragDropForeignThinkingFromCompat,
  cragDropForeignThinkingToCompat,
  sessionIdleTtlFromInference,
  thinkingDisplayFromCompat,
} from './protocol-authority'
import { numberOf, openaiPolicy, recordOf } from './quota-values'

type Obj = Record<string, unknown>
type RedactionRule = { kind?: string; prefix?: string; regex?: string }

export const READONLY_ROUTING_KEYS = new Set([
  'redaction_runtime',
  'sessions',
  'max_body_bytes',
  'max_body_mib',
])

/** 与后端 DEFAULT_POOL_ROUTING 及 src/config/routing.json 预置默认值一致。 */
export const POOL_DEFAULTS = {
  queue_max: 50,
  seat_budget_reserve_pct: 0.02,
  sticky_wait_timeout_ms: 45000,
  fallback_wait_timeout_ms: 30000,
  circuit_failure_threshold: 3,
  circuit_open_ms: 30000,
}

export const FAILOVER_DEFAULTS = {
  max_same_account_retries: 3,
  same_account_retry_delay_ms: 500,
  max_account_switches: 3,
  max_total_attempts: 12,
  total_retry_deadline_ms: 120000,
  oauth_401_cooldown_ms: 120000,
  same_account_retry_max_hop_ms: 10000,
  signature_repair: false,
  stream_idle_timeout_ms: 180000,
  eager_tool_streaming: true,
}

export const DEFAULT_CODEX_USER_AGENT = 'codex_cli_rs/0.170.0 (linux x86_64)'
const CODEX_CATALOG_VERSION_RE = /^v?\d+\.\d+\.\d+$/i

export const REDACTION_WORD_LIMIT = 256
export const REDACTION_WORD_BYTES = 1024
export const REDACTION_WORDS_BYTES = 64 * 1024
export const REDACTION_RULE_LIMIT = 32
export const REDACTION_PREFIX_MIN = 3
export const REDACTION_PREFIX_MAX = 64
export const REDACTION_REGEX_MAX = 300

export const LOGGING_RETAIN_DAYS_MIN = 1
export const LOGGING_RETAIN_DAYS_MAX = 90
export const LOGGING_MAX_MB_MIN = 0
export const LOGGING_MAX_MB_MAX = 102400

const DEFAULT_RETAIN_DAYS = 7
const DEFAULT_DEBUG_RETAIN_DAYS = 3
const DEFAULT_MAX_MB = 2048

const utf8Encoder = new TextEncoder()
function utf8Bytes(text: string): number {
  return utf8Encoder.encode(text).length
}

function sessionLimitOf(value: unknown, min: number): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= min &&
    value <= SEAT_CAP_MAX
    ? value
    : null
}

/** 对齐后端 PoolScheduler.familyLimitsOf：`subagents == null ? physical : primary`。 */
export function effectiveSeatCap(pool: Obj, inference: Obj): number {
  const rawSlots = Number(inference.session_slots ?? SEAT_CAP_MAX)
  const physical = Math.min(
    SEAT_CAP_MAX,
    Math.max(1, Number.isFinite(rawSlots) ? rawSlots : SEAT_CAP_MAX)
  )
  const subagents = sessionLimitOf(pool.max_subagents_per_session, 0)
  if (subagents == null) return physical
  return sessionLimitOf(pool.max_primary_sessions, 1) ?? physical
}

export function exhaustionGuardOrderError(quota: Obj): string | null {
  const newSession = Math.round(
    numberOf(quota.exhaustion_guard_new_session, 0.85) * 100
  )
  const stop = Math.round(numberOf(quota.exhaustion_guard_stop, 0.95) * 100)
  if (newSession > stop) {
    return `「不接新对话」（${newSession}%）不能高于「完全停用」（${stop}%）。`
  }
  return null
}

export function codexCatalogVersionError(value: unknown): string | null {
  const trimmed = String(value ?? '').trim()
  if (!trimmed || trimmed.toLowerCase() === 'auto') return null
  if (CODEX_CATALOG_VERSION_RE.test(trimmed)) return null
  return 'Codex 目录客户端版本仅支持 auto 或语义版本号（例如 0.170.0 / v0.170.0）'
}

function analyzeRedactionTextList(raw: unknown, label: string) {
  const items = Array.isArray(raw) ? raw : []
  const seen = new Set<string>()
  let count = 0
  let totalBytes = 0
  let error: string | null = null
  for (const item of items) {
    const word = String(item ?? '').trim()
    if (!word || seen.has(word)) continue
    seen.add(word)
    count += 1
    const bytes = utf8Bytes(word)
    totalBytes += bytes
    if (!error && bytes > REDACTION_WORD_BYTES) {
      error = `${label}存在超过 1 KiB 的条目`
    }
  }
  if (!error && count > REDACTION_WORD_LIMIT) {
    error = `${label}最多 ${REDACTION_WORD_LIMIT} 条（当前 ${count} 条）`
  } else if (!error && totalBytes > REDACTION_WORDS_BYTES) {
    error = `${label}总大小不能超过 64 KiB`
  }
  return { count, totalBytes, error }
}

export type RedactionValidation = {
  blockingError: string | null
  emptyPolicyError: string | null
  wordsError: string | null
  allowError: string | null
  rulesError: string | null
  ruleErrors: (string | null)[]
  wordCount: number
  allowCount: number
  ruleCount: number
}

export function validateRedactionDraft(redaction: Obj): RedactionValidation {
  const enabled = redaction.enabled === true
  const secrets = redaction.secrets !== false
  const personal = redaction.personal !== false
  const words = analyzeRedactionTextList(redaction.words, '自定义词')
  const allow = analyzeRedactionTextList(redaction.allow, '放行名单')
  const rules = Array.isArray(redaction.rules)
    ? (redaction.rules as RedactionRule[])
    : []
  const ruleErrors: (string | null)[] = rules.map((rule, index) => {
    const prefix = String(rule?.prefix ?? '').trim()
    const regex = String(rule?.regex ?? '').trim()
    if (prefix && regex) {
      return `规则 ${index + 1} 不能同时填写前缀与正则`
    }
    if (!prefix && !regex) {
      return `规则 ${index + 1} 内容不能为空，请填写前缀或正则，或删除该条规则`
    }
    if (prefix) {
      const bytes = utf8Bytes(prefix)
      if (bytes < REDACTION_PREFIX_MIN || bytes > REDACTION_PREFIX_MAX) {
        return `规则 ${index + 1} 前缀长度须为 ${REDACTION_PREFIX_MIN}–${REDACTION_PREFIX_MAX} 字节`
      }
    }
    if (regex && utf8Bytes(regex) > REDACTION_REGEX_MAX) {
      return `规则 ${index + 1} 正则长度不能超过 ${REDACTION_REGEX_MAX} 字节`
    }
    return null
  })
  const rulesError =
    rules.length > REDACTION_RULE_LIMIT
      ? `自定义规则最多 ${REDACTION_RULE_LIMIT} 条（当前 ${rules.length} 条）`
      : null
  const firstRuleError = ruleErrors.find(Boolean) ?? null
  const validRuleCount = rules.filter((rule) => {
    const prefix = String(rule?.prefix ?? '').trim()
    const regex = String(rule?.regex ?? '').trim()
    return Boolean(prefix || regex)
  }).length
  const emptyPolicyError =
    enabled &&
    !secrets &&
    !personal &&
    words.count === 0 &&
    validRuleCount === 0
      ? '启用内容脱敏时，至少需开启「凭据与秘密」「个人信息」，或填写至少一条自定义词 / 自定义规则。'
      : null
  const blockingError =
    emptyPolicyError ||
    words.error ||
    rulesError ||
    firstRuleError ||
    allow.error ||
    null
  return {
    blockingError,
    emptyPolicyError,
    wordsError: words.error,
    allowError: allow.error,
    rulesError,
    ruleErrors,
    wordCount: words.count,
    allowCount: allow.count,
    ruleCount: rules.length,
  }
}

export type LoggingValidation = {
  blockingError: string | null
  retainDaysError: string | null
  debugRetainDaysError: string | null
  maxMbError: string | null
}

function strictIntOf(raw: unknown, fallback: number): number | null {
  if (raw === undefined) return fallback
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null
  return raw
}

export function validateLoggingDraft(logging: Obj): LoggingValidation {
  const retain = strictIntOf(logging.retain_days, DEFAULT_RETAIN_DAYS)
  const debugRetain = strictIntOf(
    logging.debug_retain_days,
    DEFAULT_DEBUG_RETAIN_DAYS
  )
  const maxMb = strictIntOf(logging.max_mb, DEFAULT_MAX_MB)

  const retainDaysError =
    retain === null ||
    retain < LOGGING_RETAIN_DAYS_MIN ||
    retain > LOGGING_RETAIN_DAYS_MAX
      ? `保留天数须为 ${LOGGING_RETAIN_DAYS_MIN}–${LOGGING_RETAIN_DAYS_MAX} 的整数`
      : null

  let debugRetainDaysError =
    debugRetain === null ||
    debugRetain < LOGGING_RETAIN_DAYS_MIN ||
    debugRetain > LOGGING_RETAIN_DAYS_MAX
      ? `Debug 保留天数须为 ${LOGGING_RETAIN_DAYS_MIN}–${LOGGING_RETAIN_DAYS_MAX} 的整数`
      : null

  if (!debugRetainDaysError && !retainDaysError && debugRetain! > retain!) {
    debugRetainDaysError = `Debug 保留天数（${debugRetain} 天）不能大于保留天数（${retain} 天）`
  }

  const maxMbError =
    maxMb === null || maxMb < LOGGING_MAX_MB_MIN || maxMb > LOGGING_MAX_MB_MAX
      ? `Debug 载荷上限须为 ${LOGGING_MAX_MB_MIN}–${LOGGING_MAX_MB_MAX} MiB 的整数`
      : null

  return {
    blockingError:
      retainDaysError || debugRetainDaysError || maxMbError || null,
    retainDaysError,
    debugRetainDaysError,
    maxMbError,
  }
}

export type RoutingSaveResult = {
  kernel_persona?: { updated?: number; skipped?: number } | null
  telemetry_sync?: {
    updated?: number
    queued?: number
    skipped?: number
    opted_in?: number
    failed?: string[]
  } | null
  gemini_sync?: {
    ok?: boolean
    shards_updated?: number
    shards_total?: number
    code?: string
  } | null
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

function objOf(source: Obj | undefined, key: string): Obj {
  const value = source?.[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Obj)
    : {}
}

/** 对比 draft 与服务端快照，返回实际发生变更的可编辑顶层配置段集合。 */
export function changedRoutingSections(
  draft: Obj,
  server: Obj | undefined
): Set<string> {
  const changed = new Set<string>()
  if (!server) return changed
  const keys = new Set([...Object.keys(server), ...Object.keys(draft)])
  for (const key of keys) {
    if (READONLY_ROUTING_KEYS.has(key)) continue
    if (!sameJson(draft[key], server[key])) changed.add(key)
  }
  return changed
}

const SECTION_TAB_HINT: Record<string, SettingsTabId> = {
  sticky: 'sticky',
  pool: 'pool',
  failover: 'pool',
  tiers: 'quota',
  quota: 'quota',
  websocket: 'openai',
  codex: 'openai',
  gemini: 'gemini-config',
  compatibility: 'protocol',
  inference: 'protocol',
  redaction: 'redaction',
  official_cc: 'init',
  health_probe: 'health',
  telemetry: 'telemetry',
  notify: 'notify',
  logging: 'logs',
}

/** 根据实际变更段推断涉及的设置页签名称，用于跨页签保留 SaveBar 提示。 */
export function dirtySettingsTabLabels(
  draft: Obj,
  server: Obj | undefined
): string[] {
  const sections = changedRoutingSections(draft, server)
  const tabs = new Set<SettingsTabId>()
  for (const section of sections) {
    if (section === 'failover') {
      const df = objOf(draft, 'failover')
      const sf = objOf(server, 'failover')
      if (!sameJson(df.max_request_mib, sf.max_request_mib)) tabs.add('quota')
      const dfRest = { ...df }
      const sfRest = { ...sf }
      delete dfRest.max_request_mib
      delete sfRest.max_request_mib
      if (!sameJson(dfRest, sfRest)) tabs.add('pool')
      continue
    }
    if (section === 'inference') {
      const di = objOf(draft, 'inference')
      const si = objOf(server, 'inference')
      if (
        !sameJson(di.session_slots, si.session_slots) ||
        !sameJson(di.prewarm_enabled, si.prewarm_enabled)
      ) {
        tabs.add('pool')
      }
      if (!sameJson(di.session_idle_ttl_seconds, si.session_idle_ttl_seconds)) {
        tabs.add('protocol')
      }
      continue
    }
    if (section === 'compatibility') {
      const dc = objOf(draft, 'compatibility')
      const sc = objOf(server, 'compatibility')
      if (!sameJson(dc.min_max_tokens, sc.min_max_tokens)) tabs.add('health')
      const dcRest = { ...dc }
      const scRest = { ...sc }
      delete dcRest.min_max_tokens
      delete scRest.min_max_tokens
      if (!sameJson(dcRest, scRest)) tabs.add('protocol')
      continue
    }
    const hint = SECTION_TAB_HINT[section]
    if (hint) tabs.add(hint)
  }
  return [...tabs].map((id) => SETTINGS_TAB_LABELS[id])
}

/**
 * 构建 PUT /api/panel/routing 请求体：
 * - 按实际变更的配置段归一化，而不是按当前激活 tab；
 * - 绝不覆写 ProtocolPane 未暴露的 compatibility 字段（如 overlay_preset、persona_park、cache_breakpoints）。
 */
export function buildRoutingSavePayload(
  draft: Obj,
  server: Obj | undefined
): {
  body: Obj
  changedSections: Set<string>
  telemetryOptIn: boolean
} {
  const changedSections = changedRoutingSections(draft, server)
  const body: Obj = { ...draft }
  for (const key of READONLY_ROUTING_KEYS) delete body[key]

  if (changedSections.has('compatibility')) {
    const compat = objOf(body, 'compatibility')
    body.compatibility = {
      ...compat,
      cache_ttl: cacheTtlFromCompat(compat),
      detect_proxied_official_cc: detectProxiedOfficialCcFromCompat(compat),
      claude_code_only: compat.claude_code_only === true,
      official_cc_passthrough: compat.official_cc_passthrough === true,
      cch_enabled: cchEnabledFromCompat(compat),
      thinking_display: thinkingDisplayFromCompat(compat),
      crag_drop_foreign_thinking: cragDropForeignThinkingToCompat(
        cragDropForeignThinkingFromCompat(compat)
      ),
    }
  }
  if (changedSections.has('inference')) {
    const inference = objOf(body, 'inference')
    body.inference = {
      ...inference,
      session_idle_ttl_seconds: sessionIdleTtlFromInference(inference),
    }
  }
  if (changedSections.has('official_cc')) {
    const official = objOf(body, 'official_cc')
    body.official_cc = { ...official, inference: 'cli-hop' }
  }
  if (changedSections.has('codex')) {
    const codex = objOf(body, 'codex')
    const version = String(codex.catalog_client_version ?? '').trim()
    const ua = String(codex.user_agent ?? '').trim()
    body.codex = {
      ...codex,
      catalog_client_version: version || 'auto',
      user_agent: ua || DEFAULT_CODEX_USER_AGENT,
    }
  }

  const telemetryOptIn =
    objOf(draft, 'telemetry').default_enabled === true &&
    objOf(server, 'telemetry').default_enabled !== true

  return { body, changedSections, telemetryOptIn }
}

/** 保存前跨页签校验：有阻塞错误时禁掉 SaveBar 保存按钮并给出原因。 */
export function computeSettingsBlockedReason(
  draft: Obj,
  changedSections: Set<string>
): string | undefined {
  if (changedSections.has('redaction')) {
    const err = validateRedactionDraft(objOf(draft, 'redaction')).blockingError
    if (err) return err
  }
  if (changedSections.has('codex')) {
    const err = codexCatalogVersionError(
      objOf(draft, 'codex').catalog_client_version
    )
    if (err) return err
  }
  if (changedSections.has('logging')) {
    const err = validateLoggingDraft(objOf(draft, 'logging')).blockingError
    if (err) return err
  }
  if (changedSections.has('quota')) {
    const err = exhaustionGuardOrderError(objOf(draft, 'quota'))
    if (err) return err
  }
  return undefined
}

/**
 * 基于实际变更段和服务端回执拼装保存提示，不再依赖当前激活 tab：
 * - telemetry_sync.failed 非空或 kernel_persona.skipped > 0 一律弹出 warning；
 * - 存量槽遥测批量开启时显式汇报已同步 VM 数与失败数。
 */
export function settingsSaveToast({
  changedSections,
  telemetryOptIn = false,
  saved,
}: {
  changedSections: Set<string>
  telemetryOptIn?: boolean
  saved?: RoutingSaveResult | null
}): { level: 'success' | 'warning'; message: string } {
  const parts: string[] = []
  let warning = false

  const kernel = saved?.kernel_persona
  if (kernel && typeof kernel === 'object') {
    const updated = Number(kernel.updated ?? 0)
    const skipped = Number(kernel.skipped ?? 0)
    if (skipped > 0) {
      warning = true
      parts.push(
        updated > 0
          ? `kernel 配置已热更新 ${updated} 个槽，${skipped} 个槽跳过或同步失败`
          : `${skipped} 个槽 kernel 配置跳过或同步失败`
      )
    } else if (updated > 0) {
      parts.push(`kernel 配置已热更新 ${updated} 个槽`)
    } else if (
      changedSections.has('compatibility') ||
      changedSections.has('inference')
    ) {
      parts.push('kernel 配置已一致')
    }
  }

  const telemetry = saved?.telemetry_sync
  if (telemetry) {
    const updated = Number(telemetry.updated ?? 0)
    const optedIn = Number(telemetry.opted_in ?? 0)
    const failedList = Array.isArray(telemetry.failed) ? telemetry.failed : []
    if (failedList.length > 0) warning = true
    const failedText = failedList.length
      ? `，${failedList.length} 个未生效：${failedList.slice(0, 3).join('、')}`
      : ''
    if (telemetryOptIn || optedIn > 0) {
      parts.push(
        optedIn > 0
          ? `存量 Claude 槽已批量开启遥测（${optedIn} 个），已确认发布 ${updated} 个 VM${failedText}`
          : `已开启存量 Claude 槽遥测并确认发布 ${updated} 个 VM${failedText}`
      )
    } else {
      parts.push(`遥测已确认发布 ${updated} 个 VM${failedText}`)
    }
  }

  const geminiSync = saved?.gemini_sync
  if (changedSections.has('gemini') || geminiSync) {
    if (geminiSync?.ok) {
      parts.push(
        geminiSync.shards_total
          ? `Gemini 配置（已热更新 ${geminiSync.shards_updated ?? 0}/${geminiSync.shards_total} 个分片）`
          : 'Gemini 配置（已同步宿主）'
      )
    } else if (geminiSync && !geminiSync.ok) {
      parts.push('Gemini 配置（宿主未在线，启动后生效）')
    } else {
      parts.push('Gemini 配置')
    }
  }

  if (changedSections.has('codex') || changedSections.has('websocket')) {
    parts.push('GPT 配置')
  }

  return {
    level: warning ? 'warning' : 'success',
    message: parts.length ? `已保存 · ${parts.join(' · ')}` : '已保存',
  }
}

function tierField(
  tiers: Record<string, QuotaTierPolicy>,
  key: 'default' | 'pro' | 'max',
  field: 'limit_5h' | 'limit_7d' | 'max_concurrency' | 'max_rpm',
  fallback: number
): number {
  return numberOf(tiers[key]?.[field], fallback)
}

const CLAUDE_TIER_DEFAULTS = {
  default: { max_concurrency: 2, max_rpm: 0, limit_5h: 0.85, limit_7d: 0.8 },
  pro: { max_concurrency: 2, max_rpm: 0, limit_5h: 0.85, limit_7d: 0.8 },
  max: { max_concurrency: 4, max_rpm: 0, limit_5h: 0.95, limit_7d: 0.95 },
} as const

function quotaGatesSnapshot(source: Obj | undefined) {
  const tiers =
    (objOf(source, 'tiers') as Record<string, QuotaTierPolicy>) || {}
  const quota = objOf(source, 'quota')
  const weekly = recordOf(quota.weekly_split)
  return {
    tiers: (['default', 'pro', 'max'] as const).map((k) => [
      tierField(tiers, k, 'limit_5h', CLAUDE_TIER_DEFAULTS[k].limit_5h),
      tierField(tiers, k, 'limit_7d', CLAUDE_TIER_DEFAULTS[k].limit_7d),
    ]),
    block_on_5h: quota.block_on_5h !== false,
    block_on_7d: quota.block_on_7d !== false,
    guard_large_cold: quota.guard_large_cold !== false,
    exhaustion_guard: quota.exhaustion_guard === true,
    exhaustion_guard_new_session: numberOf(
      quota.exhaustion_guard_new_session,
      0.85
    ),
    exhaustion_guard_stop: numberOf(quota.exhaustion_guard_stop, 0.95),
    critical_band: numberOf(quota.critical_band, 0.05),
    gate_overshoot: numberOf(quota.gate_overshoot, 0.05),
    large_cold_uncached_tokens: Math.round(
      numberOf(quota.large_cold_uncached_tokens, 100000)
    ),
    weekly_enabled: weekly.enabled === true,
    weekly_fable_share: numberOf(weekly.fable_share, 0.5),
  }
}

export type SettingsPendingCards = {
  sticky: { binding: boolean; ttl: boolean; outbound: boolean }
  pool: { strategy: boolean; seats: boolean; queue: boolean }
  quota: { gates: boolean; concurrency: boolean; rpm: boolean }
  openai: {
    gates: boolean
    concurrency: boolean
    rpm: boolean
    sessions: boolean
  }
}

/** 按卡片管理的字段切片逐一计算 13 张摘要卡的「待保存」状态（P3-02）。 */
export function computePendingCards(
  draft: Obj,
  server: Obj | undefined
): SettingsPendingCards {
  if (!server) {
    return {
      sticky: { binding: false, ttl: false, outbound: false },
      pool: { strategy: false, seats: false, queue: false },
      quota: { gates: false, concurrency: false, rpm: false },
      openai: {
        gates: false,
        concurrency: false,
        rpm: false,
        sessions: false,
      },
    }
  }
  const ds = objOf(draft, 'sticky')
  const ss = objOf(server, 'sticky')

  const dp = objOf(draft, 'pool')
  const sp = objOf(server, 'pool')
  const di = objOf(draft, 'inference')
  const si = objOf(server, 'inference')

  const dt = (objOf(draft, 'tiers') as Record<string, QuotaTierPolicy>) || {}
  const st = (objOf(server, 'tiers') as Record<string, QuotaTierPolicy>) || {}

  const dqOpenai = openaiPolicy(
    recordOf(objOf(draft, 'codex').quota) as Partial<OpenAIQuotaPolicy>
  )
  const sqOpenai = openaiPolicy(
    recordOf(objOf(server, 'codex').quota) as Partial<OpenAIQuotaPolicy>
  )

  return {
    sticky: {
      binding: (ds.enabled !== false) !== (ss.enabled !== false),
      ttl:
        Number(ds.session_ttl_seconds ?? ds.ttl_seconds ?? 86400) !==
          Number(ss.session_ttl_seconds ?? ss.ttl_seconds ?? 86400) ||
        Number(ds.machine_ttl_seconds ?? 604800) !==
          Number(ss.machine_ttl_seconds ?? 604800),
      outbound:
        String(ds.outbound_session || 'rebuild') !==
        String(ss.outbound_session || 'rebuild'),
    },
    pool: {
      strategy:
        (dp.strategy === 'fill' ? 'fill' : 'balanced') !==
          (sp.strategy === 'fill' ? 'fill' : 'balanced') ||
        (dp.reset_priority !== false) !== (sp.reset_priority !== false),
      seats: !sameJson(
        [
          numberOf(di.session_slots, 20),
          di.prewarm_enabled === true,
          dp.max_primary_sessions ?? null,
          dp.max_subagents_per_session ?? null,
          numberOf(
            dp.seat_budget_reserve_pct,
            POOL_DEFAULTS.seat_budget_reserve_pct
          ),
        ],
        [
          numberOf(si.session_slots, 20),
          si.prewarm_enabled === true,
          sp.max_primary_sessions ?? null,
          sp.max_subagents_per_session ?? null,
          numberOf(
            sp.seat_budget_reserve_pct,
            POOL_DEFAULTS.seat_budget_reserve_pct
          ),
        ]
      ),
      queue: !sameJson(
        [
          numberOf(dp.queue_max, POOL_DEFAULTS.queue_max),
          numberOf(
            dp.sticky_wait_timeout_ms,
            POOL_DEFAULTS.sticky_wait_timeout_ms
          ),
          numberOf(
            dp.fallback_wait_timeout_ms,
            POOL_DEFAULTS.fallback_wait_timeout_ms
          ),
        ],
        [
          numberOf(sp.queue_max, POOL_DEFAULTS.queue_max),
          numberOf(
            sp.sticky_wait_timeout_ms,
            POOL_DEFAULTS.sticky_wait_timeout_ms
          ),
          numberOf(
            sp.fallback_wait_timeout_ms,
            POOL_DEFAULTS.fallback_wait_timeout_ms
          ),
        ]
      ),
    },
    quota: {
      gates: !sameJson(quotaGatesSnapshot(draft), quotaGatesSnapshot(server)),
      concurrency: !sameJson(
        (['default', 'pro', 'max'] as const).map((k) =>
          tierField(
            dt,
            k,
            'max_concurrency',
            CLAUDE_TIER_DEFAULTS[k].max_concurrency
          )
        ),
        (['default', 'pro', 'max'] as const).map((k) =>
          tierField(
            st,
            k,
            'max_concurrency',
            CLAUDE_TIER_DEFAULTS[k].max_concurrency
          )
        )
      ),
      rpm: !sameJson(
        (['default', 'pro', 'max'] as const).map((k) =>
          tierField(dt, k, 'max_rpm', CLAUDE_TIER_DEFAULTS[k].max_rpm)
        ),
        (['default', 'pro', 'max'] as const).map((k) =>
          tierField(st, k, 'max_rpm', CLAUDE_TIER_DEFAULTS[k].max_rpm)
        )
      ),
    },
    openai: {
      gates:
        dqOpenai.limit_5h !== sqOpenai.limit_5h ||
        dqOpenai.limit_7d !== sqOpenai.limit_7d,
      concurrency: dqOpenai.max_concurrency !== sqOpenai.max_concurrency,
      rpm: dqOpenai.max_rpm !== sqOpenai.max_rpm,
      sessions: dqOpenai.max_sessions !== sqOpenai.max_sessions,
    },
  }
}
