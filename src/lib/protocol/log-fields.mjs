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
  const text = String(model || '').trim()
  if (!text) return null
  const paren = MODEL_PAREN_EFFORT_RE.exec(text)
  if (paren) return normalizeReasoningEffort(paren[1])
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

/** Caller session ids come from client headers/bodies; cap them before they hit an index. */
export function sessionIdForLog(value) {
  const s = String(value ?? '').trim()
  return s ? s.slice(0, SESSION_ID_MAX) : null
}
