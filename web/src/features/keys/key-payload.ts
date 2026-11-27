import type { PoolBindingMode } from '@/types/panel-pools'

export type KeyGroupType = 'all' | 'anthropic' | 'openai' | 'gemini'

export const KEY_ALLOWED_MODELS_MAX = 200

export type KeyLimitsDraft = {
  name: string
  category: 'oauth' | 'api' | 'all'
  api_endpoint_id?: string
  permission_tier?: 'platform' | 'tenant' | 'resource'
  owner_id?: string | null
  allowed_endpoints?: string[]
  allowed_gemini_envs?: string[]
  pool_binding_mode?: PoolBindingMode
  default_pool_id?: string
  allowed_pool_ids?: string[]
  max_concurrency: number
  quota_requests: number
  quota_usd: number
  rpm: number
  expires_in_days: number
  group_type: KeyGroupType
  allowed_vms: string[]
  /** 兼容旧单池字段别名；新表单优先读写 default_pool_id。 */
  vm_pool_id?: string
  /** 逗号、空格或换行分隔；留空不限。 */
  allowed_models: string
}

function nonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${label}必须是非负数`)
  return value
}

/** 拆成模型名列表：去空白，按不分大小写去重，保留第一次的写法。 */
export function parseModelList(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of text.split(/[\s,，]+/)) {
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    out.push(name)
  }
  return out
}

function groupTypeOf(value: string): KeyGroupType {
  if (value === 'anthropic' || value === 'openai' || value === 'gemini')
    return value
  return 'all'
}

function dedupeIds(list: string[] | undefined): string[] {
  if (!Array.isArray(list)) return []
  return [...new Set(list.map((id) => String(id || '').trim()).filter(Boolean))]
}

export function keyLimitsPayload(
  draft: KeyLimitsDraft,
  mode: 'create' | 'edit',
  options: { isAdmin?: boolean } = {}
): Record<string, unknown> {
  const isAdmin = options.isAdmin ?? true
  const requests = nonNegative(draft.quota_requests, '请求额度')
  if (!Number.isInteger(requests)) throw new Error('请求额度必须是整数')
  const body: Record<string, unknown> = {
    max_concurrency: nonNegative(draft.max_concurrency, '并发'),
    quota_requests: requests,
    quota_usd: nonNegative(draft.quota_usd, 'USD 额度'),
    rpm: nonNegative(draft.rpm, 'RPM'),
  }
  const isApi = draft.category === 'api'
  const allowsEndpoint = isApi || draft.category === 'all'
  const allowTenantEmptyVms =
    draft.permission_tier === 'tenant' &&
    Boolean(String(draft.owner_id || '').trim())

  const poolBindingMode: PoolBindingMode =
    isAdmin && draft.pool_binding_mode === 'strict_pool'
      ? 'strict_pool'
      : 'legacy_scope'
  const hasPoolConfig =
    isAdmin &&
    (draft.pool_binding_mode !== undefined ||
      draft.default_pool_id !== undefined ||
      draft.allowed_pool_ids !== undefined ||
      draft.vm_pool_id !== undefined)

  if (draft.group_type === 'gemini' && (!isAdmin || isApi)) {
    throw new Error('Gemini 平台只允许管理员创建宿主机 OAuth 密钥')
  }
  // API 直连与混合模式只有管理员可以设置
  if (isAdmin) body.category = draft.category

  // 权限分层、属主、多端点与多 Gemini 环境授权（仅管理员可配）
  if (isAdmin && draft.permission_tier !== undefined) {
    body.permission_tier = draft.permission_tier
  }
  if (isAdmin && draft.owner_id !== undefined) {
    const owner = String(draft.owner_id || '').trim()
    body.owner_id = owner || null
  }
  if (isAdmin && draft.allowed_endpoints !== undefined) {
    body.allowed_endpoints = dedupeIds(draft.allowed_endpoints)
  }
  if (isAdmin && draft.allowed_gemini_envs !== undefined) {
    body.allowed_gemini_envs = dedupeIds(draft.allowed_gemini_envs)
  }

  if (
    isAdmin &&
    poolBindingMode !== 'strict_pool' &&
    allowsEndpoint &&
    draft.api_endpoint_id !== undefined
  ) {
    const endpointId = draft.api_endpoint_id.trim()
    if (isApi && mode === 'create' && !endpointId)
      throw new Error('请选择 API 渠道')
    body.api_endpoint_id = endpointId || null
  }

  if (poolBindingMode === 'strict_pool') {
    const rawDefault = String(
      draft.default_pool_id ?? draft.vm_pool_id ?? ''
    ).trim()
    const allowed = dedupeIds(draft.allowed_pool_ids)
    if (rawDefault && !allowed.includes(rawDefault)) allowed.unshift(rawDefault)
    const effectiveDefault = rawDefault || allowed[0] || ''
    if (!effectiveDefault) {
      throw new Error('严格分组池模式下至少选择一个分组池')
    }
    body.pool_binding_mode = 'strict_pool'
    body.default_pool_id = effectiveDefault
    body.allowed_pool_ids = allowed
    body.vm_pool_id = effectiveDefault
    body.group_type = 'all'
    body.allowed_vms = []
  } else {
    const group_type = groupTypeOf(draft.group_type)
    const allowed_vms =
      group_type === 'all' || group_type === 'gemini'
        ? []
        : dedupeIds(draft.allowed_vms)
    if (
      !isApi &&
      draft.category !== 'all' &&
      !allowTenantEmptyVms &&
      group_type !== 'all' &&
      group_type !== 'gemini' &&
      allowed_vms.length === 0
    ) {
      throw new Error('至少选择一台 VM')
    }
    body.group_type = group_type
    body.allowed_vms = allowed_vms
    if (hasPoolConfig) {
      const rawDefault = String(
        draft.default_pool_id ?? draft.vm_pool_id ?? ''
      ).trim()
      const allowed = dedupeIds(draft.allowed_pool_ids)
      if (rawDefault && !allowed.includes(rawDefault))
        allowed.unshift(rawDefault)
      body.pool_binding_mode = 'legacy_scope'
      body.default_pool_id = rawDefault || null
      body.allowed_pool_ids = allowed
      body.vm_pool_id = rawDefault || null
    }
  }

  const allowed_models = parseModelList(draft.allowed_models)
  if (allowed_models.length > KEY_ALLOWED_MODELS_MAX) {
    throw new Error(`允许的模型最多 ${KEY_ALLOWED_MODELS_MAX} 个`)
  }
  body.allowed_models = allowed_models
  if (mode === 'create') {
    body.name = draft.name.trim()
    const days = nonNegative(draft.expires_in_days, '有效期')
    if (days > 0) body.expires_in_days = days
  }
  return body
}
