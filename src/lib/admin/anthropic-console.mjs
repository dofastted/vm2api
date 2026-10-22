/**
 * Panel Anthropic console.
 *
 * Direct mode calls one URL with the typed key. Scheduled mode reuses the API
 * endpoint picker (priority, prefix, alias, key round-robin) and that key's proxy.
 * The browser never dials upstream.
 */
import { normalizeAuthScheme, AUTH_SCHEME_BEARER, AUTH_SCHEME_X_API_KEY } from '../oauth/auth-scheme.mjs'
import { messagesUrl, trimBaseUrl, upstreamAuthHeaders } from '../pool/api-presets.mjs'
import { forwardApi, readApiJson } from '../transport/api-kernel-client.mjs'

export const ANTHROPIC_CONSOLE_URL = 'https://api.anthropic.com'
export const ANTHROPIC_CONSOLE_TIMEOUT_MS = 60_000
const MAX_MESSAGE_CHARS = 16_000
const MAX_HEADER_PAIRS = 24
const MAX_KEYS = 32

export function anthropicMessagesUrl(baseUrl) {
  const trimmed = trimBaseUrl(baseUrl) || ANTHROPIC_CONSOLE_URL
  if (!/^https?:\/\//i.test(trimmed)) {
    throw Object.assign(new Error('地址必须是 http 或 https'), { code: 'invalid_base_url', status: 400 })
  }
  return messagesUrl(trimmed)
}

export function anthropicProxyUrl(raw) {
  const value = String(raw || '').trim()
  if (!value) return ''
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw Object.assign(new Error('代理地址无效'), { code: 'invalid_proxy_url', status: 400 })
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
  if (!['http', 'https', 'socks5', 'socks5h'].includes(scheme)) {
    throw Object.assign(new Error('代理只支持 http、https、socks5'), { code: 'invalid_proxy_url', status: 400 })
  }
  if (!parsed.hostname || (scheme.startsWith('socks5') && !parsed.port)) {
    throw Object.assign(new Error('代理地址缺少主机或端口'), { code: 'invalid_proxy_url', status: 400 })
  }
  return value
}

function headerMap(raw) {
  if (raw == null || raw === '') return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw Object.assign(new Error('自定义头必须是对象'), { code: 'invalid_headers', status: 400 })
  }
  const out = {}
  const entries = Object.entries(raw)
  if (entries.length > MAX_HEADER_PAIRS) {
    throw Object.assign(new Error('自定义头过多'), { code: 'invalid_headers', status: 400 })
  }
  for (const [key, value] of entries) {
    const name = String(key || '').trim()
    if (!name || /[\r\n:]/.test(name) || /[\r\n]/.test(String(value ?? ''))) {
      throw Object.assign(new Error('自定义头含无效字符'), { code: 'invalid_headers', status: 400 })
    }
    out[name] = String(value ?? '')
  }
  return out
}

async function directKeys(input = {}, store = null) {
  const listed = Array.isArray(input.keys) ? input.keys : [input]
  const keys = []
  for (const [row, item] of listed.entries()) {
    const source = item && typeof item === 'object' ? item : { api_key: item }
    const saved = source.key_id || source.keyId ? await savedEndpointKey(store, source.key_id || source.keyId) : null
    const apiKey = String(source.api_key || source.apiKey || saved?.api_key || '').trim()
    if (!apiKey) continue
    const label = String(source.label || '')
      .trim()
      .slice(0, 40)
    keys.push({
      row,
      label: label || `key ${keys.length + 1}`,
      api_key: apiKey,
      proxy_id: chosen(source, 'proxy_id', 'proxyId', saved?.proxy_id || ''),
      base_url: chosen(source, 'base_url', 'baseUrl', saved?.base_url || ''),
      auth_scheme: chosen(source, 'auth_scheme', 'authScheme', saved?.auth_scheme || ''),
    })
  }
  if (!keys.length) {
    throw Object.assign(new Error('先填 API key'), { code: 'api_key_required', status: 400 })
  }
  if (keys.length > MAX_KEYS) {
    throw Object.assign(new Error(`一次最多 ${MAX_KEYS} 把 key`), { code: 'too_many_keys', status: 400 })
  }
  return keys
}

function chosen(source, snake, camel, fallback) {
  if (Object.prototype.hasOwnProperty.call(source, snake)) return String(source[snake] ?? '').trim()
  if (Object.prototype.hasOwnProperty.call(source, camel)) return String(source[camel] ?? '').trim()
  return String(fallback || '').trim()
}

export async function savedEndpointKey(store, keyId) {
  const id = String(keyId || '').trim()
  if (!id || !store?.listRaw) return null
  for (const endpoint of await store.listRaw()) {
    const key = (endpoint.api_key_entries || []).find((item) => item.id === id)
    if (!key) continue
    return {
      api_key: key.api_key,
      proxy_id: key.proxy_id || '',
      proxy_url: key.proxy_url || '',
      base_url: endpoint.base_url || '',
      auth_scheme: endpoint.auth_scheme || endpoint.headers?.auth_scheme || '',
    }
  }
  return null
}
export function resolveConsoleProxyUrl(proxyPool, proxyId) {
  const id = String(proxyId || '').trim()
  if (!id) return ''
  const proxy = proxyPool?.getProxyByIdWithAuth?.(id)
  if (!proxy?.url) {
    throw Object.assign(new Error('所选代理不存在或没有可转发地址'), { code: 'proxy_not_found', status: 400 })
  }
  return anthropicProxyUrl(proxy.url)
}

export function buildAnthropicConsoleRequest(input = {}, picked = null, proxyPool = null) {
  const scheduled = input.mode === 'scheduled'
  if (scheduled && !picked?.ok) {
    const error = Object.assign(new Error(picked?.message || '没有可用的 API 上游'), {
      code: picked?.code || 'api_pool_exhausted',
      status: picked?.code === 'model_not_found' ? 404 : 503,
    })
    throw error
  }

  const model = String((scheduled ? picked.upstream_model : input.model) || '').trim()
  if (!model) {
    throw Object.assign(new Error('先填模型'), { code: 'model_required', status: 400 })
  }
  const message = String(input.message ?? input.prompt ?? '').trim()
  if (!message) {
    throw Object.assign(new Error('先填消息'), { code: 'message_required', status: 400 })
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    throw Object.assign(new Error('消息过长'), { code: 'message_too_long', status: 400 })
  }
  const maxTokens = Number(input.max_tokens ?? input.maxTokens ?? 256)
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) {
    throw Object.assign(new Error('max_tokens 需要 1 到 8192 的整数'), { code: 'invalid_max_tokens', status: 400 })
  }

  const endpoint = scheduled ? picked.endpoint : null
  const key = scheduled ? String(picked.key?.api_key || '').trim() : String(input.api_key || input.apiKey || '').trim()
  if (!key) {
    throw Object.assign(new Error('先填 API key'), { code: 'api_key_required', status: 400 })
  }
  const scheme =
    normalizeAuthScheme(scheduled ? endpoint.auth_scheme : input.auth_scheme || input.authScheme) ||
    AUTH_SCHEME_X_API_KEY
  const baseUrl = scheduled ? endpoint.base_url : input.base_url || input.baseUrl || ANTHROPIC_CONSOLE_URL
  const proxyUrl = scheduled
    ? anthropicProxyUrl(picked.key?.proxy_url)
    : resolveConsoleProxyUrl(proxyPool, input.proxy_id || input.proxyId)
  const extra = headerMap(scheduled ? endpoint.headers : input.headers)
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    ...upstreamAuthHeaders('anthropic', key, { ...extra, auth_scheme: scheme }),
  }

  return {
    method: 'POST',
    url: anthropicMessagesUrl(baseUrl),
    headers,
    body: {
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: message }],
    },
    proxyUrl,
    timeoutMs: ANTHROPIC_CONSOLE_TIMEOUT_MS,
    meta: {
      mode: scheduled ? 'scheduled' : 'direct',
      auth_scheme: scheme === AUTH_SCHEME_BEARER ? AUTH_SCHEME_BEARER : AUTH_SCHEME_X_API_KEY,
      endpoint_id: endpoint?.id || null,
      endpoint_name: endpoint?.name || null,
      key_id: scheduled ? picked.key?.id || null : null,
      requested_model: scheduled ? picked.requested_model : model,
      upstream_model: model,
      proxy: Boolean(proxyUrl),
    },
  }
}

function textFromContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('')
}

export function anthropicConsoleResult(upstream, meta) {
  const status = Number(upstream?.statusCode) || 502
  return readApiJson(upstream).then((payload) => {
    const body = payload && typeof payload === 'object' ? payload : { raw: String(payload ?? '') }
    const message = body?.error?.message || body?.message || ''
    return {
      ok: status >= 200 && status < 300,
      status,
      text: textFromContent(body?.content),
      error: status >= 400 ? String(message || `上游返回 ${status}`).slice(0, 500) : '',
      body,
      ...meta,
    }
  })
}

async function forwardConsoleRequest(request, { cfg, forward }) {
  try {
    const upstream = await forward({
      cfg,
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body,
      proxyUrl: request.proxyUrl,
      timeoutMs: request.timeoutMs,
    })
    return anthropicConsoleResult(upstream, request.meta)
  } catch (error) {
    throw Object.assign(new Error(String(error?.message || error).slice(0, 300)), {
      code: error?.code || 'api_kernel_transport',
      status: 502,
    })
  }
}

export async function runAnthropicConsole({
  cfg,
  scheduler,
  proxyPool = null,
  store = null,
  input,
  forward = forwardApi,
}) {
  const scheduled = input?.mode === 'scheduled'
  if (scheduled) {
    if (!scheduler?.pick) {
      throw Object.assign(new Error('API 调度不可用'), { code: 'scheduler_unavailable', status: 503 })
    }
    const request = buildAnthropicConsoleRequest(input || {}, scheduler.pick(input?.model), proxyPool)
    return forwardConsoleRequest(request, { cfg, forward })
  }

  const keys = await directKeys(input, store)
  const index = Number.isInteger(Number(input?.key_index)) ? Number(input.key_index) : null
  const selected = index == null ? keys : keys.filter((key) => key.row === index)
  if (!selected.length) {
    throw Object.assign(new Error('要测试的 key 不存在'), { code: 'key_not_found', status: 400 })
  }
  const items = []
  for (const key of selected) {
    const row = key.row
    try {
      const request = buildAnthropicConsoleRequest({ ...(input || {}), ...key }, null, proxyPool)
      const result = await forwardConsoleRequest(request, { cfg, forward })
      items.push({ label: key.label, row, ...result, key_id: null })
    } catch (error) {
      items.push({
        label: key.label,
        row,
        ok: false,
        status: error.status && error.status < 600 ? error.status : 502,
        text: '',
        error: String(error.message || error).slice(0, 300),
        proxy: Boolean(key.proxy_id),
        key_id: null,
      })
    }
  }
  if (items.length === 1 && index == null && !Array.isArray(input?.keys)) return items[0]
  const ready = items.filter((item) => item.ok).length
  return {
    ok: ready === items.length,
    status: items.find((item) => !item.ok)?.status || items[0]?.status || 200,
    text: items.map((item) => `${item.label}: ${item.ok ? item.text || '可用' : item.error}`).join('\n'),
    error: ready === items.length ? '' : `${items.length - ready}/${items.length} 把 key 不可用`,
    mode: 'direct',
    items,
  }
}
