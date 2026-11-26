/**
 * Pure normalizers for request-log columns captured from the inbound request.
 * Kept dependency-free so protocol handlers can import them without the DB.
 */

export const REASONING_EFFORTS = new Set(['none', 'minimal', 'auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

/** Missing, null, or whitespace-only effort is treated as omitted. */
export function isEmptyEffortValue(value) {
  return value == null || (typeof value === 'string' && value.trim() === '')
}

export function firstNonEmptyEffort(...values) {
  for (const value of values) {
    if (!isEmptyEffortValue(value)) return value
  }
  return undefined
}

const MODEL_PAREN_EFFORT_RE = /\((none|minimal|auto|low|medium|high|xhigh|max|ultra)\)$/i
const MODEL_SUFFIX_EFFORT_RE = /(?:^|[-_])(minimal|low|medium|high|xhigh|max)$/i

export function normalizeReasoningEffort(raw) {
  if (typeof raw !== 'string') return null
  const effort = raw
    .trim()
    .toLowerCase()
    .replace(/^thinking_level_/, '')
  return REASONING_EFFORTS.has(effort) ? effort : null
}

export function effortFromThinkingBudget(budget) {
  if (typeof budget !== 'number' || !Number.isFinite(budget)) return null
  if (budget === 0) return 'none'
  if (budget < 0) return 'auto'
  if (budget <= 4096) return 'low'
  if (budget <= 12288) return 'medium'
  return 'high'
}

export function effortFromModelName(model) {
  let text = String(model || '').trim()
  if (!text) return null
  text = text.replace(/\[1m\]$/i, '')
  const paren = MODEL_PAREN_EFFORT_RE.exec(text)
  if (paren) return normalizeReasoningEffort(paren[1])
  text = text.replace(/-latest$/i, '').replace(/-thinking$/i, '')
  const suffix = MODEL_SUFFIX_EFFORT_RE.exec(text)
  if (suffix) return normalizeReasoningEffort(suffix[1])
  return null
}

function geminiThinkingConfigOf(body) {
  if (!body || typeof body !== 'object') return null
  const gc = body.generationConfig ?? body.generation_config
  if (!gc || typeof gc !== 'object') return null
  const tc = gc.thinkingConfig ?? gc.thinking_config
  return tc && typeof tc === 'object' ? tc : null
}

/**
 * Requested thinking effort across inbound dialects: Anthropic
 * `output_config.effort`, OpenAI chat `reasoning_effort`, Responses
 * `reasoning.effort`, Gemini `generationConfig.thinkingConfig.thinkingLevel`.
 * Message-level `output_config.effort` (pi mid-conversation control) wins over
 * the top-level field so the log matches the current turn.
 * Unknown values are dropped so the column stays a closed set.
 */
export function reasoningEffortOf(inbound) {
  if (!inbound || typeof inbound !== 'object') return null
  const tc = geminiThinkingConfigOf(inbound)
  let raw = firstNonEmptyEffort(
    inbound.output_config?.effort,
    inbound.reasoning_effort,
    inbound.reasoning?.effort,
    tc?.thinkingLevel,
    tc?.thinking_level,
  )
  if (Array.isArray(inbound.messages)) {
    for (let i = inbound.messages.length - 1; i >= 0; i--) {
      const effort = inbound.messages[i]?.output_config?.effort
      if (!isEmptyEffortValue(effort)) {
        raw = effort
        break
      }
    }
  }
  return normalizeReasoningEffort(raw)
}

/**
 * Effective Gemini/Antigravity reasoning effort for request logs:
 * explicit request effort → parsed thinking IR → Gemini thinkingBudget →
 * outbound thinkingConfig → model tier suffix (e.g. `gemini-3.1-pro-high`).
 */
export function resolveGeminiReasoningEffort({
  inbound = null,
  parsed = null,
  outboundBody = null,
  model = null,
  upstreamModel = null,
  defaultEffort = null,
} = {}) {
  const explicit = reasoningEffortOf(inbound)
  if (explicit) return explicit
  if (parsed?.thinking) {
    if (parsed.thinking.disabled === true || parsed.thinking.budgetTokens === 0) return 'none'
    const parsedEffort = normalizeReasoningEffort(parsed.thinking.effort)
    if (parsedEffort) return parsedEffort
    if (typeof parsed.thinking.budgetTokens === 'number') {
      const fromBudget = effortFromThinkingBudget(parsed.thinking.budgetTokens)
      if (fromBudget) return fromBudget
    }
  }
  const inboundTc = geminiThinkingConfigOf(inbound)
  const inboundBudget = inboundTc?.thinkingBudget ?? inboundTc?.thinking_budget
  if (typeof inboundBudget === 'number') {
    const fromBudget = effortFromThinkingBudget(inboundBudget)
    if (fromBudget) return fromBudget
  }
  const outTc = geminiThinkingConfigOf(outboundBody)
  if (outTc) {
    const outLevel = normalizeReasoningEffort(outTc.thinkingLevel ?? outTc.thinking_level)
    if (outLevel) return outLevel
    const outBudget = outTc.thinkingBudget ?? outTc.thinking_budget
    if (typeof outBudget === 'number') {
      const fromBudget = effortFromThinkingBudget(outBudget)
      if (fromBudget) return fromBudget
    }
  }
  const fromModel = effortFromModelName(model) || effortFromModelName(upstreamModel)
  if (fromModel) return fromModel
  if (defaultEffort && String(defaultEffort).trim().toLowerCase() !== 'off') {
    return normalizeReasoningEffort(String(defaultEffort))
  }
  return null
}

const SESSION_ID_MAX = 200
export const THIRD_PARTY_CLIENT_SESSION_ID = '第三方'

/** Caller session ids come from client headers/bodies; cap them before they hit an index. */
export function sessionIdForLog(value) {
  const s = String(value ?? '').trim()
  return s ? s.slice(0, SESSION_ID_MAX) : null
}

const CORRELATION_ID_MAX = 128
const CORRELATION_SECRET_RE = /^(?:sk-(?:ant|kin|vm)-|AIza|eyJ)/i

/** Safe bounded correlation ID (UUIDs, Anthropic req_*, CRAG run/turn IDs); never whitespace, controls, or secrets. */
export function correlationIdForLog(value, maxLen = CORRELATION_ID_MAX) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  const limit = Math.min(CORRELATION_ID_MAX, Math.max(1, Number(maxLen) || CORRELATION_ID_MAX))
  if (!trimmed || trimmed.length > limit) return null
  if (/[\x00-\x1f\x7f\s]/.test(trimmed)) return null
  if (CORRELATION_SECRET_RE.test(trimmed)) return null
  return trimmed
}

function nonNegativeSafeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * Extract safe, bounded hop & native providerResult correlation IDs for
 * `hop_meta.native_handoff` and `request_attempts` so operators can join
 * gateway rows directly against `docker logs kin-NN`.
 */
export function extractProviderCorrelation(result = null) {
  const provider =
    result?.providerResult && typeof result.providerResult === 'object' && !Array.isArray(result.providerResult)
      ? result.providerResult
      : null
  const turnRaw =
    typeof provider?.turn_id === 'number' && Number.isSafeInteger(provider.turn_id) && provider.turn_id >= 0
      ? String(provider.turn_id)
      : provider?.turn_id
  const providerRequestId = correlationIdForLog(provider?.request_id)
  const fallbackRequestId = correlationIdForLog(
    result?.body?.error?.request_id ?? result?.body?.request_id ?? result?.headers?.['request-id'],
  )
  return {
    hop_request_id: correlationIdForLog(result?.hopRequestId),
    run_id: correlationIdForLog(provider?.run_id),
    turn_id: correlationIdForLog(turnRaw),
    attempt_id: nonNegativeSafeInt(provider?.attempt_id),
    provider_request_id: providerRequestId,
    request_id: providerRequestId || fallbackRequestId,
  }
}

const GEMINI_MODEL_PREFIX_RE = /^gemini-/i
const GEMINI_PAREN_EFFORT_RE = /\(([^()]+)\)$/
const GEMINI_TIER_SUFFIX_RE = /-(minimal|low|medium|high|xhigh|extra-high|max)$/i

function normalizeGeminiTierToken(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^thinking_level_/, '')
  if (!s) return null
  if (s === 'none' || s === 'off' || s === 'disabled' || s === '0') return 'none'
  if (s === 'minimal' || s === 'min') return 'minimal'
  if (s === 'low') return 'low'
  if (s === 'medium' || s === 'med' || s === 'auto' || s === 'adaptive') return 'medium'
  if (s === 'high') return 'high'
  if (s === 'xhigh' || s === 'extra_high' || s === 'extra-high' || s === 'max') return 'xhigh'
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    if (n === 0) return 'none'
    if (n <= 1024) return 'minimal'
    if (n <= 4096) return 'low'
    if (n <= 12288) return 'medium'
    if (n <= 24576) return 'high'
    return 'xhigh'
  }
  return null
}

function parseGeminiModelForAudit(raw) {
  let work = String(raw || '')
    .trim()
    .split('/')
    .filter(Boolean)
    .pop()
  if (!work) return null
  work = work.replace(/\[1m\]$/i, '').toLowerCase()
  if (!GEMINI_MODEL_PREFIX_RE.test(work)) return null
  let effort = null
  const paren = GEMINI_PAREN_EFFORT_RE.exec(work)
  if (paren && paren.index > 0) {
    const parsed = normalizeGeminiTierToken(paren[1])
    if (parsed) {
      effort = parsed
      work = work.slice(0, paren.index)
    }
  }
  work = work.replace(/-thinking$/i, '')
  const suffix = GEMINI_TIER_SUFFIX_RE.exec(work)
  if (suffix && suffix.index > 0) {
    if (!effort) effort = normalizeGeminiTierToken(suffix[1])
    work = work.slice(0, suffix.index)
  }
  work = work.replace(/-thinking$/i, '')
  return { base: work, effort }
}

/**
 * Tri-state model mismatch: null = upstream did not declare a model, 0 = match, 1 = mismatch.
 * Gemini models commonly carry a thinking-tier suffix (e.g. `gemini-4-neon-high`,
 * `gemini-4-neon(high)`, `gemini-2.5-pro-thinking`) while upstream `modelVersion`
 * echoes the bare base model (`gemini-4-neon`). Treat them as matching when the base
 * model matches and neither side contradicts the other's explicit tier.
 */
export function modelMismatch(requested, upstream) {
  if (!requested || !upstream) return null
  const norm = (m) =>
    String(m)
      .split('/')
      .filter(Boolean)
      .pop()
      .replace(/\[1m\]$/i, '')
      .toLowerCase()
  const normReq = norm(requested)
  const normUp = norm(upstream)
  if (normReq === normUp) return 0
  const reqGemini = parseGeminiModelForAudit(normReq)
  const upGemini = parseGeminiModelForAudit(normUp)
  if (reqGemini && upGemini && reqGemini.base === upGemini.base) {
    if (!reqGemini.effort || !upGemini.effort || reqGemini.effort === upGemini.effort) {
      return 0
    }
  }
  return 1
}
