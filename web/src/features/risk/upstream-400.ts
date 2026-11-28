export type UpstreamErrorAction =
  'session_10m' | 'strike_1_of_2' | 'skipped' | 'no_session' | 'permanent_kept'

/**
 * Mirrors `UPSTREAM_ERROR_CATEGORIES` in `src/lib/core/refusal-guard.mjs`.
 */
export const UPSTREAM_400_CATEGORY_LABELS: Record<string, string> = {
  // Tier 3: Cleaned / Excluded (NEVER block caller session)
  auto_mode_classifier: '自动模式分类器侧请求',
  gateway_local: '网关/内核本地前置拒绝',
  account_disabled: '上游账号/组织被禁用或受限',
  auth_credential: '上游凭据或鉴权失效',
  billing_credit: '上游账号余额或额度不足',
  model_unavailable: '上游模型不可用或无权限',
  upstream_502_bad_gateway: '上游 502 网关/代理或流中断',
  upstream_503_unavailable: '上游 503 服务不可用或调度繁忙',
  upstream_504_timeout: '上游 504 网关或推理超时',
  upstream_529_overloaded: '上游 529 过载限流',
  worker_local_5xx: '本地 Worker 进程异常或连接中断',

  // Tier 1: Immediate 10m session block (threshold = 1)
  policy_refusal: '上游内容/使用政策拒答',
  third_party_client: '第三方客户端计费拒绝',
  state_reference_invalid: '会话/响应引用 ID 已失效',
  poison_abort: '跨多槽位 5xx 毒请求熔断',

  // Tier 2: Recoverable / Repeat 10m session block (threshold = 2 in 5m, cleared on 200)
  context_too_long: '上下文或 Token 超限',
  param_range_invalid: '请求参数范围或采样参数非法',
  beta_or_header_invalid: 'Beta 请求头非法或不支持',
  tool_pair_broken: '工具调用历史配对损坏',
  thinking_history_broken: 'Thinking/推理签名或配置损坏',
  search_or_cache_invalid: '搜索加密块或缓存标记非法',
  media_invalid: '图片/文档附件超限或损坏',
  message_structure_invalid: '消息角色或空内容结构损坏',
  tool_schema_invalid: '工具 Schema 或参数校验失败',
  unknown: '其他上游 400 请求错误',
  internal_server_error: '上游 500 服务端内部错误',
}

export const UPSTREAM_400_ACTION_LABELS: Record<string, string> = {
  session_10m: '已封锁会话 10 分钟',
  strike_1_of_2: '可自愈放行（计 1/2 次）',
  skipped: '已清洗跳过封锁',
  no_session: '无会话标识未封锁',
  permanent_kept: '维持永久封禁',
}

export function upstream400CategoryLabel(category: string | null | undefined) {
  if (!category) return ''
  return UPSTREAM_400_CATEGORY_LABELS[category] || category
}

export function upstreamErrorActionLabel(action: string | null | undefined) {
  if (!action) return ''
  if (UPSTREAM_400_ACTION_LABELS[action]) {
    return UPSTREAM_400_ACTION_LABELS[action]
  }
  const strike = /^strike_(\d+)_of_(\d+)$/.exec(action)
  if (strike) return `可自愈放行（计 ${strike[1]}/${strike[2]} 次）`
  return action
}

export function formatBanReasonLabel(reason: string | null | undefined) {
  const raw = String(reason || '').trim()
  if (!raw) return 'refusal_guard'
  if (raw === 'upstream_400') return '上游 400 · 其他请求错误 (upstream_400)'
  if (raw === 'upstream_500') return '上游 500 · 服务端内部错误 (upstream_500)'
  if (raw.startsWith('upstream_400:')) {
    const cat = raw.slice('upstream_400:'.length)
    const label = UPSTREAM_400_CATEGORY_LABELS[cat]
    return label ? `上游 400 · ${label} (${raw})` : raw
  }
  if (raw.startsWith('upstream_500:')) {
    const cat = raw.slice('upstream_500:'.length)
    const label = UPSTREAM_400_CATEGORY_LABELS[cat]
    return label ? `上游 500 · ${label} (${raw})` : raw
  }
  return raw
}
