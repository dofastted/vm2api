export const DEFAULT_URL = 'https://api.anthropic.com'
export const DIRECT = '__direct__'
export type ApiProtocol = 'anthropic' | 'openai'
export const API_DEFAULTS = {
  anthropic: { baseUrl: DEFAULT_URL, authScheme: 'x_api_key' },
  openai: {
    baseUrl: 'https://api.openai.com',
    authScheme: 'authorization_bearer',
  },
} as const

export type AuthScheme = 'x_api_key' | 'authorization_bearer'

/** 载入时的服务端值；保存已存地址只发和它不同的字段。 */
export type StoredSnapshot = {
  protocol?: ApiProtocol
  riskReviewEnabled?: boolean
  baseUrl: string
  authScheme: AuthScheme
  proxyId: string
}

export type EndpointDraft = {
  protocol?: ApiProtocol
  riskReviewEnabled?: boolean
  fetchedModels?: string[]
  id: string
  storedId?: string
  keyId?: string
  baseUrl: string
  authScheme: AuthScheme
  apiKey: string
  proxyId: string
  stored?: StoredSnapshot
}

type StoredItem = {
  id: string
  protocol?: ApiProtocol
  risk_review_enabled?: boolean
  base_url?: string
  auth_scheme?: string
  api_key_entries?: { id?: string; proxy_id?: string }[]
  models?: { id?: string; name?: string; alias?: string }[]
}
export function draftFromStored(item: StoredItem): EndpointDraft {
  const key = item.api_key_entries?.[0]
  const stored: StoredSnapshot = {
    protocol: item.protocol || 'anthropic',
    riskReviewEnabled: item.risk_review_enabled === true,
    baseUrl:
      item.base_url || API_DEFAULTS[item.protocol || 'anthropic'].baseUrl,
    authScheme:
      item.protocol === 'openai' || item.auth_scheme === 'authorization_bearer'
        ? 'authorization_bearer'
        : 'x_api_key',
    proxyId: key?.proxy_id || DIRECT,
  }
  const existingModels = (item.models || [])
    .map((m) => (m.alias || m.name || m.id || '').trim())
    .filter(Boolean)
  return {
    id: item.id,
    storedId: item.id,
    keyId: key?.id || '',
    apiKey: '',
    fetchedModels: existingModels.length ? existingModels : undefined,
    ...stored,
    stored,
  }
}

function kindOf(baseUrl: string, protocol: ApiProtocol) {
  if (protocol === 'anthropic' && baseUrl === DEFAULT_URL) return 'claude'
  if (protocol === 'openai' && baseUrl === API_DEFAULTS.openai.baseUrl)
    return 'openai'
  return 'custom'
}

/**
 * 新地址整条创建；已存地址只发密钥和改过的字段。后端 PATCH 对 name / models
 * 是整体覆盖，因此只发送 fetched_models 让服务端合并，不覆盖名称或已有别名。
 */
export function endpointSaveRequest(
  item: EndpointDraft,
  model: string
): { method: 'POST' | 'PATCH'; path: string; body: Record<string, unknown> } {
  const protocol = item.protocol || 'anthropic'
  const baseUrl = item.baseUrl.trim() || API_DEFAULTS[protocol].baseUrl
  const apiKey = item.apiKey.trim()
  const proxyId = item.proxyId === DIRECT ? '' : item.proxyId
  if (!item.storedId) {
    const names = item.fetchedModels?.length
      ? item.fetchedModels
      : model.trim()
        ? [model.trim()]
        : []
    if (!names.length) throw new Error('先获取模型或填写模型再保存')
    return {
      method: 'POST',
      path: '/api/panel/api-endpoints',
      body: {
        kind: kindOf(baseUrl, protocol),
        protocol,
        ...(protocol === 'anthropic'
          ? { risk_review_enabled: item.riskReviewEnabled === true }
          : {}),
        name: baseUrl,
        base_url: baseUrl,
        auth_scheme: item.authScheme,
        proxy_id: proxyId,
        key_id: item.keyId || '',
        api_key: apiKey,
        models: names.map((name) => ({ name, alias: name })),
        api_key_entries: apiKey ? [{ api_key: apiKey }] : [],
      },
    }
  }
  const was = item.stored
  const body: Record<string, unknown> = { key_id: item.keyId || '' }
  if (apiKey) body.api_key = apiKey
  if (
    protocol === 'anthropic' &&
    item.riskReviewEnabled !== undefined &&
    (!was || item.riskReviewEnabled !== (was.riskReviewEnabled === true))
  )
    body.risk_review_enabled = item.riskReviewEnabled
  if (!was || item.proxyId !== was.proxyId) body.proxy_id = proxyId
  if (!was || item.authScheme !== was.authScheme)
    body.auth_scheme = item.authScheme
  if (
    was &&
    (baseUrl !== was.baseUrl || protocol !== (was.protocol || 'anthropic'))
  ) {
    body.kind = kindOf(baseUrl, protocol)
    body.base_url = baseUrl
    if (protocol !== (was.protocol || 'anthropic')) body.protocol = protocol
  }
  if (item.fetchedModels?.length) {
    body.fetched_models = item.fetchedModels.map((name) => ({
      name,
      alias: name,
    }))
  }
  return {
    method: 'PATCH',
    path: `/api/panel/api-endpoints/${encodeURIComponent(item.storedId)}`,
    body,
  }
}
