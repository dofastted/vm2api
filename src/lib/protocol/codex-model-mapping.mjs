/**
 * CPR-style inbound model id rewrite (client model → upstream GPT id).
 * Applied before detectInboundPlatform; literal detect on raw ids is unchanged.
 */
import { isGptSeriesId } from './gpt-ids.mjs'
import { isGptModelEnabled } from './gpt-model-policy.mjs'
import { canonicalImageToolModel } from './image-tool-models.mjs'
import { detectInboundPlatform } from './platform-detect.mjs'

/** Recommended secondary default when an operator clears the primary auto-review target. */
export const DEFAULT_CODEX_MODEL_MAPPING_FALLBACK = 'gpt-6.1-sol'

export const DEFAULT_CODEX_MODEL_MAPPINGS = Object.freeze({
  'codex-auto-review': 'gpt-6-luna',
})

function bareModelId(model) {
  const raw = String(model || '').trim()
  if (!raw) return ''
  return raw.split('/').filter(Boolean).pop() || raw
}

function mappingLookup(map, model) {
  const bare = bareModelId(model)
  if (!bare) return null
  const lower = bare.toLowerCase()
  if (Object.prototype.hasOwnProperty.call(map, bare)) return map[bare]
  if (Object.prototype.hasOwnProperty.call(map, lower)) return map[lower]
  for (const [key, target] of Object.entries(map)) {
    if (String(key).toLowerCase() === lower) return target
  }
  return null
}

/**
 * Merge routing overrides onto product defaults. Empty/null target for codex-auto-review
 * falls back to {@link DEFAULT_CODEX_MODEL_MAPPING_FALLBACK}; other keys with empty target drop the override.
 */
export function normalizeCodexModelMappings(raw) {
  const merged = { ...DEFAULT_CODEX_MODEL_MAPPINGS }
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  if (!src) return merged
  for (const [key, value] of Object.entries(src)) {
    const alias = String(key || '').trim()
    if (!alias) continue
    if (value === null || value === '') {
      if (alias.toLowerCase() === 'codex-auto-review') {
        merged[alias] = DEFAULT_CODEX_MODEL_MAPPING_FALLBACK
      } else {
        delete merged[alias]
        if (alias.toLowerCase() !== alias) delete merged[alias.toLowerCase()]
      }
      continue
    }
    merged[alias] = String(value).trim()
  }
  return merged
}

export function validateCodexModelMappingTarget(target) {
  const id = String(target || '').trim()
  if (!id || !isGptSeriesId(id)) {
    return {
      ok: false,
      code: 'codex_model_mapping_invalid',
      message: `model mapping target '${id || ''}' must be an enabled GPT chat model id`,
    }
  }
  if (!isGptModelEnabled(id)) {
    return {
      ok: false,
      code: 'model_disabled',
      message: `model mapping target '${id}' is disabled by gateway GPT model policy`,
    }
  }
  return { ok: true, target: id }
}

export function validateCodexModelMappingsPatch(raw, path = 'codex.model_mappings') {
  if (raw == null) return
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw typedError(`${path} 必须是对象`, 'invalid_codex_model_mappings')
  }
  for (const [key, value] of Object.entries(raw)) {
    const alias = String(key || '').trim()
    if (!alias) throw typedError(`${path} 的键必须是非空字符串`, 'invalid_codex_model_mappings')
    // The rewrite runs before platform detection, so an alias must not capture Claude or image traffic.
    if (/[\s\p{Cc}]/u.test(key)) {
      throw typedError(`${path} 的别名 '${alias}' 不能包含空白或控制字符`, 'invalid_codex_model_mappings')
    }
    if (detectInboundPlatform(alias).platform === 'anthropic') {
      throw typedError(
        `${path} 的别名 '${alias}' 是 Anthropic 模型名，会劫持 Claude 请求`,
        'invalid_codex_model_mappings',
      )
    }
    if (canonicalImageToolModel(alias)) {
      throw typedError(`${path} 的别名 '${alias}' 是图像模型，不能映射`, 'invalid_codex_model_mappings')
    }
    if (value === null || value === '') continue
    if (typeof value !== 'string' || !value.trim()) {
      throw typedError(`${path}.${alias} 必须是字符串、null 或空字符串`, 'invalid_codex_model_mappings')
    }
    const check = validateCodexModelMappingTarget(value.trim())
    if (!check.ok) throw typedError(`${path}.${alias}: ${check.message}`, check.code)
  }
}

function typedError(message, code) {
  const error = new TypeError(message)
  error.code = code
  return error
}

function rewriteModelField(model, upstreamId) {
  const raw = String(model || '').trim()
  const parts = raw.split('/').filter(Boolean)
  if (parts.length <= 1) return upstreamId
  parts[parts.length - 1] = upstreamId
  return parts.join('/')
}

/**
 * @returns {{ ok: true, body: object, mapped?: boolean, requestedModel?: string, upstreamModel?: string | null } | { ok: false, code: string, message: string }}
 */
export function applyCodexInboundModelRewrite(body, routing = {}) {
  if (!body || typeof body !== 'object') return { ok: true, body: body || {} }
  const model = body.model
  if (typeof model !== 'string' || !model.trim()) return { ok: true, body }
  const codex = routing.codex && typeof routing.codex === 'object' ? routing.codex : routing
  const mappings = normalizeCodexModelMappings(codex?.model_mappings)
  const target = mappingLookup(mappings, model)
  if (target == null) return { ok: true, body, requestedModel: model.trim(), upstreamModel: null, mapped: false }
  const validated = validateCodexModelMappingTarget(target)
  if (!validated.ok) return validated
  const upstreamModel = validated.target
  return {
    ok: true,
    body: { ...body, model: rewriteModelField(model, upstreamModel) },
    mapped: true,
    requestedModel: model.trim(),
    upstreamModel,
  }
}
