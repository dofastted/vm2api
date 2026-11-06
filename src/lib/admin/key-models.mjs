/**
 * Managed-key model allowlist (api_keys.allowed_models, JSON array text).
 * Checked against the model name the client sent, before any mapping or alias:
 * exact and case-insensitive; Claude Code's client-side `[1m]` suffix is ignored on
 * both sides (it is a context opt-in, not a model). Empty = no limit. The master key and panel
 * sessions carry no record and are never limited. The slot-level
 * policy.allowed_models (pool/slot-model-gate.mjs) is separate and unchanged.
 */
import { ErrorCode, ErrorType, makeError } from '../core/errors.mjs'
import { stripClaudeCode1mSuffix } from '../protocol/context-1m.mjs'

export const KEY_ALLOWED_MODELS_MAX = 200
const MODEL_NAME_MAX = 128

function invalid(message) {
  return Object.assign(new Error(message), { code: 'invalid_allowed_models' })
}

function dedupe(names) {
  const seen = new Set()
  const out = []
  for (const name of names) {
    const k = name.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(name)
  }
  return out
}

/** Read side: stored JSON text or an array → trimmed names. Anything else reads as no limit. */
export function parseKeyAllowedModels(value) {
  let list = value
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value || '[]')
    } catch {
      return []
    }
  }
  if (!Array.isArray(list)) return []
  return dedupe(
    list
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean),
  )
}

/** Write side: null clears; otherwise a string array, trimmed and deduped (case-insensitive). */
export function normalizeKeyAllowedModels(value) {
  if (value == null) return []
  if (!Array.isArray(value)) throw invalid('allowed_models 必须是字符串数组')
  const names = []
  for (const item of value) {
    if (typeof item !== 'string') throw invalid('allowed_models 必须是字符串数组')
    const name = item.trim()
    if (!name) continue
    if (name.length > MODEL_NAME_MAX) throw invalid(`模型名不能超过 ${MODEL_NAME_MAX} 个字符`)
    names.push(name)
  }
  const out = dedupe(names)
  if (out.length > KEY_ALLOWED_MODELS_MAX) throw invalid(`allowed_models 最多 ${KEY_ALLOWED_MODELS_MAX} 个`)
  return out
}

export function keyAllowsModel(allowed, model) {
  const list = parseKeyAllowedModels(allowed)
  if (!list.length) return true
  const base = (name) => stripClaudeCode1mSuffix(name.trim()).toLowerCase()
  const want = typeof model === 'string' ? base(model) : ''
  return !!want && list.some((name) => base(name) === want)
}

function managedAllowlist(req) {
  if (!req || req.apiKeyKind === 'master') return []
  return parseKeyAllowedModels(req.apiKeyRecord?.allowed_models)
}

/** null when the request's key may use `model`; else a 400 in the Anthropic or OpenAI error shape. */
export function keyModelError(req, model, { anthropic = false } = {}) {
  const list = managedAllowlist(req)
  if (keyAllowsModel(list, model)) return null
  const name = typeof model === 'string' ? model.trim() : ''
  const { status, body } = makeError({
    type: ErrorType.INVALID_REQUEST,
    code: ErrorCode.API_KEY_MODEL_NOT_ALLOWED,
    message: name ? `此密钥不允许使用模型 ${name}` : '此密钥只能调用指定模型，请求必须写明 model',
    param: 'model',
    status: 400,
  })
  return { status, body: anthropic ? { type: 'error', ...body } : body }
}

/** /v1/models: a limited key only sees the listed ids. */
export function filterModelCatalogForKey(catalog, req) {
  const list = managedAllowlist(req)
  if (!list.length || !Array.isArray(catalog?.data)) return catalog
  return { ...catalog, data: catalog.data.filter((item) => keyAllowsModel(list, item?.id)) }
}
