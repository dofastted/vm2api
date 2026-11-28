export type Upstream400Action =
  'session_10m' | 'skipped' | 'no_session' | 'permanent_kept'

/**
 * Mirrors `UPSTREAM_400_CATEGORIES` in `src/lib/core/refusal-guard.mjs`.
 */
export const UPSTREAM_400_CATEGORY_LABELS: Record<string, string> = {
  // Cleaned / Excluded (do NOT block caller session)
  auto_mode_classifier: '自动模式分类器侧请求',
  gateway_local: '网关/内核本地前置拒绝',
  account_disabled: '上游账号/组织被禁用或受限',
  auth_credential: '上游凭据或鉴权失效',
  billing_credit: '上游账号余额或额度不足',
  model_unavailable: '上游模型不可用或无权限',

  // Blocked for 10m (prevent repeat upstream 400 loops)
  policy_refusal: '上游内容/使用政策拒答',
  third_party_client: '第三方客户端计费拒绝',
  context_too_long: '上下文或 Token 超限',
  tool_pair_broken: '工具调用历史配对损坏',
  thinking_history_broken: 'Thinking/推理签名或配置损坏',
  search_or_cache_invalid: '搜索加密块或缓存标记非法',
  media_invalid: '图片/文档附件超限或损坏',
  message_structure_invalid: '消息角色或空内容结构损坏',
  tool_schema_invalid: '工具 Schema 或参数校验失败',
  state_reference_invalid: '会话/响应引用 ID 已失效',
  beta_or_header_invalid: 'Beta 请求头或采样参数非法',
  unknown: '其他上游 400 请求错误',
}

export const UPSTREAM_400_ACTION_LABELS: Record<string, string> = {
  session_10m: '已封锁会话 10 分钟',
  skipped: '已清洗跳过封锁',
  no_session: '无会话标识未封锁',
  permanent_kept: '维持永久封禁',
}

export function upstream400CategoryLabel(category: string | null | undefined) {
  if (!category) return ''
  return UPSTREAM_400_CATEGORY_LABELS[category] || category
}

export function formatBanReasonLabel(reason: string | null | undefined) {
  const raw = String(reason || '').trim()
  if (!raw) return 'refusal_guard'
  if (raw === 'upstream_400') return '上游 400 · 其他请求错误 (upstream_400)'
  if (raw.startsWith('upstream_400:')) {
    const cat = raw.slice('upstream_400:'.length)
    const label = UPSTREAM_400_CATEGORY_LABELS[cat]
    return label ? `上游 400 · ${label} (${raw})` : raw
  }
  return raw
}
