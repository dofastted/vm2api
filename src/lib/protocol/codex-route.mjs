/**
 * Codex hop routing. Claude traffic never reads this object.
 */
import { isCodexVm } from '../vm/vm-kind.mjs'
import { normalizeOpenAIQuotaPolicy } from '../pool/openai-quota-policy.mjs'
import { normalizeCodexModelMappings, validateCodexModelMappingsPatch } from './codex-model-mapping.mjs'

export { isCodexVm, normalizeVmKind } from '../vm/vm-kind.mjs'

export const DEFAULT_CODEX_USER_AGENT = 'codex_cli_rs/0.160.0 (linux x86_64)'
export const CODEX_UPSTREAM_TRANSPORTS = Object.freeze(['prefer_websocket', 'http'])

export const DEFAULT_INFERENCE_WEBSOCKET = Object.freeze({ enabled: true })

export const DEFAULT_CODEX_ROUTING = Object.freeze({
  enabled: true,
  // `auto` resolves the official Codex catalog client version at sync time,
  // falling back to 0.160.0 when the registry is unavailable.
  catalog_client_version: 'auto',
  user_agent: DEFAULT_CODEX_USER_AGENT,
  upstream_transport: 'prefer_websocket',
  websocket: { enabled: true },
  client_features: { enabled: false },
  analytics: { enabled: false },
  protocols: {
    'openai.responses': { mode: 'native', enabled: true },
    'openai.chat': { mode: 'convert', enabled: true },
    'openai.completions': { mode: 'convert', enabled: true },
    'anthropic.messages': { mode: 'reject', enabled: false },
  },
  convert: {
    chat_to_codex: true,
    completions_to_codex: true,
    anthropic_to_codex: false,
  },
  clients: {
    official_codex: 'allow',
    openai_compatible: 'allow',
    claude_code: 'reject',
    unknown: 'allow',
  },
  quota: normalizeOpenAIQuotaPolicy(),
})

function typedError(message, code) {
  const error = new TypeError(message)
  error.code = code
  return error
}

function asObject(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
}

function normalizeEnabledToggle(raw, defaultEnabled) {
  const src = asObject(raw) || {}
  return { enabled: defaultEnabled ? src.enabled !== false : src.enabled === true }
}

export function normalizeInferenceWebsocket(raw = {}) {
  return normalizeEnabledToggle(raw, true)
}

function normalizeUserAgent(raw) {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_CODEX_USER_AGENT
}

function normalizeUpstreamTransport(raw) {
  return CODEX_UPSTREAM_TRANSPORTS.includes(raw) ? raw : 'prefer_websocket'
}

function validateEnabledToggle(raw, path, code) {
  if (!asObject(raw)) throw typedError(`${path} 必须是对象`, code)
  if (Object.prototype.hasOwnProperty.call(raw, 'enabled') && typeof raw.enabled !== 'boolean') {
    throw typedError(`${path}.enabled 必须是布尔`, code)
  }
}

/** PUT /api/panel/routing strict checks. Loaded files still go through normalize. */
export function validateInferenceWebsocketPatch(body = {}) {
  if (!asObject(body)) return
  if (Object.prototype.hasOwnProperty.call(body, 'websocket')) {
    validateEnabledToggle(body.websocket, 'websocket', 'invalid_websocket')
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'codex')) return
  if (!asObject(body.codex)) throw typedError('codex 必须是对象', 'invalid_codex_websocket')
  const codex = body.codex
  if (Object.prototype.hasOwnProperty.call(codex, 'websocket')) {
    validateEnabledToggle(codex.websocket, 'codex.websocket', 'invalid_codex_websocket')
  }
  if (Object.prototype.hasOwnProperty.call(codex, 'upstream_transport')) {
    if (!CODEX_UPSTREAM_TRANSPORTS.includes(codex.upstream_transport)) {
      throw typedError('codex.upstream_transport 必须是 prefer_websocket 或 http', 'invalid_upstream_transport')
    }
  }
  if (Object.prototype.hasOwnProperty.call(codex, 'user_agent')) {
    if (typeof codex.user_agent !== 'string' || !codex.user_agent.trim()) {
      throw typedError('codex.user_agent 必须是非空字符串', 'invalid_user_agent')
    }
  }
  if (Object.prototype.hasOwnProperty.call(codex, 'client_features')) {
    validateEnabledToggle(codex.client_features, 'codex.client_features', 'invalid_client_features')
  }
  if (Object.prototype.hasOwnProperty.call(codex, 'analytics')) {
    validateEnabledToggle(codex.analytics, 'codex.analytics', 'invalid_codex_analytics')
  }
  if (Object.prototype.hasOwnProperty.call(codex, 'model_mappings')) {
    validateCodexModelMappingsPatch(codex.model_mappings)
  }
}

export function inferenceWebsocketEnabled(routing = {}) {
  return asObject(routing.websocket)?.enabled !== false && asObject(routing.codex?.websocket)?.enabled !== false
}

export function computedUpstreamTransport(routing = {}) {
  return inferenceWebsocketEnabled(routing) ? normalizeUpstreamTransport(routing.codex?.upstream_transport) : 'http'
}

export function normalizeCodexRouting(raw = {}) {
  const src = asObject(raw) || {}
  const protocols = { ...DEFAULT_CODEX_ROUTING.protocols, ...(src.protocols || {}) }
  for (const key of Object.keys(protocols)) {
    const item = protocols[key] || {}
    const mode = ['native', 'convert', 'reject'].includes(item.mode) ? item.mode : 'reject'
    protocols[key] = { mode, enabled: item.enabled !== false && mode !== 'reject' }
  }
  const clients = { ...DEFAULT_CODEX_ROUTING.clients, ...(src.clients || {}) }
  for (const [key, value] of Object.entries(clients)) {
    clients[key] = value === 'allow' ? 'allow' : 'reject'
  }
  return {
    enabled: src.enabled !== false,
    catalog_client_version:
      typeof src.catalog_client_version === 'string' && src.catalog_client_version.trim()
        ? src.catalog_client_version.trim()
        : 'auto',
    user_agent: normalizeUserAgent(src.user_agent),
    upstream_transport: normalizeUpstreamTransport(src.upstream_transport),
    websocket: normalizeEnabledToggle(src.websocket, true),
    client_features: normalizeEnabledToggle(src.client_features, false),
    analytics: normalizeEnabledToggle(src.analytics, false),
    protocols,
    convert: {
      chat_to_codex: src.convert?.chat_to_codex !== false,
      completions_to_codex: src.convert?.completions_to_codex !== false,
      anthropic_to_codex: src.convert?.anthropic_to_codex === true,
    },
    clients,
    quota: normalizeOpenAIQuotaPolicy(src.quota),
    model_mappings: normalizeCodexModelMappings(src.model_mappings),
  }
}

export function isCodexProtocolAllowed(protocol, routing = {}) {
  const codex = normalizeCodexRouting(routing.codex || routing)
  if (!codex.enabled) return { ok: false, code: 'codex_disabled', mode: 'reject' }
  const entry = codex.protocols[protocol]
  if (!entry || entry.enabled === false || entry.mode === 'reject') {
    return { ok: false, code: 'protocol_not_allowed', mode: 'reject' }
  }
  return { ok: true, mode: entry.mode }
}

export function listCodexVms(vms = []) {
  return (vms || []).filter((vm) => isCodexVm(vm))
}
