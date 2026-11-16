export const CLAUDE_OFFICIAL_URL = 'https://api.anthropic.com'
export const OPENAI_OFFICIAL_URL = 'https://api.openai.com'

export const API_ENDPOINT_PRESETS = [
  { kind: 'claude', label: 'Claude 官方', base_url: CLAUDE_OFFICIAL_URL, protocol: 'anthropic' },
  { kind: 'openai', label: 'OpenAI 官方', base_url: OPENAI_OFFICIAL_URL, protocol: 'openai' },
  { kind: 'custom', label: '自定义', base_url: '', protocol: 'anthropic' },
]

export function trimBaseUrl(url) {
  return String(url || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1$/i, '')
}

export function normalizeKind(kind, baseUrl = '') {
  const k = String(kind || '')
    .trim()
    .toLowerCase()
  if (k === 'claude' || k === 'anthropic') return 'claude'
  if (k === 'openai') return 'openai'
  const u = trimBaseUrl(baseUrl)
  if (u === CLAUDE_OFFICIAL_URL) return 'claude'
  if (u === OPENAI_OFFICIAL_URL) return 'openai'
  return 'custom'
}

export function normalizeProtocol(protocol, kind) {
  if (kind === 'claude') return 'anthropic'
  if (kind === 'openai') return 'openai'
  return String(protocol || '').toLowerCase() === 'openai' ? 'openai' : 'anthropic'
}

export function resolvePreset(kind, input = {}) {
  const resolvedKind = normalizeKind(kind || input.kind, input.base_url)
  const preset = API_ENDPOINT_PRESETS.find((p) => p.kind === resolvedKind) || API_ENDPOINT_PRESETS[2]
  const protocol = normalizeProtocol(input.protocol, resolvedKind)
  const base_url = resolvedKind === 'custom' ? trimBaseUrl(input.base_url) : preset.base_url
  return {
    kind: resolvedKind,
    protocol,
    base_url,
    name: String(input.name || '').trim() || (resolvedKind === 'custom' ? 'api' : preset.label),
  }
}

export function modelsUrl(baseUrl, { afterId } = {}) {
  const base = trimBaseUrl(baseUrl)
  const url = `${base}/v1/models`
  if (afterId) return `${url}?after_id=${encodeURIComponent(afterId)}`
  return url
}

export function messagesUrl(baseUrl) {
  return `${trimBaseUrl(baseUrl)}/v1/messages?beta=true`
}

export function chatCompletionsUrl(baseUrl) {
  return `${trimBaseUrl(baseUrl)}/v1/chat/completions`
}

export function responsesUrl(baseUrl) {
  return `${trimBaseUrl(baseUrl)}/v1/responses`
}

export function upstreamAuthHeaders(protocol, apiKey, extra = {}) {
  const key = String(apiKey || '').trim()
  const { auth_scheme, authScheme, anthropic_apikey_auth_scheme, ...rest } = extra || {}
  const headers = { ...rest }
  if (protocol === 'openai') {
    headers.authorization = `Bearer ${key}`
    return headers
  }
  const scheme = String(auth_scheme || authScheme || anthropic_apikey_auth_scheme || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
  if (scheme === 'authorization_bearer' || scheme === 'bearer' || scheme === 'authorization') {
    delete headers['x-api-key']
    headers.authorization = `Bearer ${key}`
  } else {
    delete headers.authorization
    delete headers.Authorization
    headers['x-api-key'] = key
  }
  if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01'
  return headers
}

const SKIP_OPENAI =
  /^(whisper|tts-|dall-e|chatgpt-image|gpt-image|text-embedding|text-moderation|omni-moderation|davinci|babbage|curie)/i

export function parseUpstreamModels(payload, protocol = 'anthropic') {
  const rows = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : []
  const out = []
  const seen = new Set()
  for (const row of rows) {
    const name = String((typeof row === 'string' ? row : row?.id || row?.name) || '').trim()
    if (!name) continue
    if (protocol === 'openai' && SKIP_OPENAI.test(name)) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      name,
      alias: name,
      display_name: String(row?.display_name || row?.id || name),
    })
  }
  return out
}

export function mergeModelLists(existing = [], fetched = []) {
  const have = new Map()
  const out = []
  for (const m of existing) {
    const name = String(m.name || m.upstream_name || '').trim()
    if (!name) continue
    const rec = {
      id: m.id,
      name,
      alias: String(m.alias || name).trim() || name,
      image: !!m.image,
      thinking: m.thinking,
    }
    have.set(name.toLowerCase(), rec)
    out.push(rec)
  }
  for (const m of fetched) {
    const name = String(m.name || m.id || '').trim()
    if (!name || have.has(name.toLowerCase())) continue
    const rec = {
      name,
      alias: String(m.alias || name).trim() || name,
      image: !!m.image,
    }
    have.set(name.toLowerCase(), rec)
    out.push(rec)
  }
  return out
}
