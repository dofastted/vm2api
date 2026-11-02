import type { JevScopeAccount } from '@/types/panel-routing'
import type { UsageLogRow } from '@/types/panel-usage-logs'

/** Gate order matches `evaluateProtocolIntercept`: cheap rules first, the model last. */
export type StageId = 'distill' | 'hard-regex' | 'refusal' | 'jev'
export type ViewKey = 'all' | StageId | 'pass'

export const STAGES: { id: StageId; name: string; does: string }[] = [
  {
    id: 'distill',
    name: '蒸馏',
    does: '收割模板、结构特征、题目指纹。命中即 403，并封 device。',
  },
  {
    id: 'hard-regex',
    name: '硬正则',
    does: '按类别正则扫用户正文。命中即 403，不 hop。',
  },
  {
    id: 'refusal',
    name: '拒答缓存',
    does: '上游拒过的正文、近似正文和被封的 device，直接 503。',
  },
  {
    id: 'jev',
    name: '决策模型',
    does: '最多五题各自打分，任一题低于阈值就拦。命中会写拒答缓存并封 device + Session。',
  },
]

export const VIEW_KEYS: ViewKey[] = ['all', ...STAGES.map((s) => s.id), 'pass']

export function isViewKey(value: unknown): value is ViewKey {
  return typeof value === 'string' && VIEW_KEYS.includes(value as ViewKey)
}

export const PASS_REASONS: Record<string, { label: string; hint: string }> = {
  jev: { label: '模型判安全', hint: '决策模型打过分' },
  regex: { label: '正则未命中', hint: '决策模型关闭或跳过' },
  'fail-open': { label: '模型故障放行', hint: '打分失败，按失败放行出站' },
  unchecked: { label: '未检查', hint: '没有任何规则在跑' },
  platform: {
    label: 'OpenAI 平台未接入',
    hint: 'GPT / Codex 请求，「OpenAI 平台」开关关闭',
  },
  scope: {
    label: '账号不在范围',
    hint: '请求落到的槽位不在选中的平台和套餐里',
  },
  'scope-wait': {
    label: '等待账号判定',
    hint: '范围含这个平台或指定了账号，等到槽位确定后再判',
  },
  unknown: {
    label: '未经关卡',
    hint: '鉴权、请求体等错误在关卡前结束，或升级前的旧日志',
  },
}

/** 风控的账号范围。一对是 `claude:max` / `gpt:plus` 这种平台+套餐。 */
export type AccountScope = {
  account_platform_plans: string[]
  account_ids: string[]
}

export function scopeConfigured(scope: AccountScope) {
  return scope.account_platform_plans.length > 0 || scope.account_ids.length > 0
}

/**
 * 与后端 `jevAccountInScope` 同一套判断：平台+套餐和指定账号取并集，
 * 全空 = 所有账号。面板用它实时算「当前范围命中几个槽位」。
 */
export function accountInScope(scope: AccountScope, account: JevScopeAccount) {
  if (!scopeConfigured(scope)) return true
  const ids = scope.account_ids.map((item) => item.trim().toLowerCase())
  const id = (account.id || '').trim().toLowerCase()
  const email = (account.email || '').trim().toLowerCase()
  const name = (account.name || '').trim().toLowerCase()
  if (
    ids.some((want) => want && (want === id || want === email || want === name))
  )
    return true
  const key = (account.scope_key || '').trim().toLowerCase()
  return !!key && scope.account_platform_plans.includes(key)
}

export function scopeMatches(scope: AccountScope, accounts: JevScopeAccount[]) {
  return accounts.filter((account) => accountInScope(scope, account))
}

/** `upstream` = passed every gate and the upstream refused it. */
export type FeedKind = StageId | 'upstream'

export function feedKindOf(row: UsageLogRow): FeedKind {
  const state = row.finalState || ''
  const via = row.via || ''
  if (state === 'distill_blocked' || via === 'distill-detect') return 'distill'
  if (via === 'hard-regex') return 'hard-regex'
  if (via === 'jev') return 'jev'
  if (state.startsWith('refusal_') || via === 'refusal-guard') return 'refusal'
  return 'upstream'
}

const REFUSAL_MATCH: Record<string, string> = {
  refusal_guard: '精确指纹',
  refusal_similar: '近似正文',
  refusal_device: '封禁 device',
}

/** The part of the stored block message that says why: `nsfw: 关键词`. */
export function evidenceOf(row: UsageLogRow): string {
  const kind = feedKindOf(row)
  if (kind === 'refusal') return REFUSAL_MATCH[row.finalState || ''] || '拒答'
  const text = String(row.errorMessage || row.blockedReason || '').trim()
  if (kind === 'upstream') return text
  const at = text.search(/[:：]/)
  return at >= 0 ? text.slice(at + 1).trim() : text
}

export function share(part: number, whole: number) {
  if (!whole || !part) return '0%'
  const value = (part / whole) * 100
  if (value < 0.1) return '<0.1%'
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`
}
