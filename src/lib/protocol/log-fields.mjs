/**
 * Pure normalizers for request-log columns captured from the inbound request.
 * Kept dependency-free so protocol handlers can import them without the DB.
 */

export const REASONING_EFFORTS = new Set(['none', 'minimal', 'auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

/**
 * Requested thinking effort across inbound dialects: Anthropic
 * `output_config.effort`, OpenAI chat `reasoning_effort`, Responses
 * `reasoning.effort`. Message-level `output_config.effort` (pi mid-conversation
 * control) wins over the top-level field so the log matches the current turn.
 * Unknown values are dropped so the column stays a closed set.
 */
export function reasoningEffortOf(inbound) {
  if (!inbound || typeof inbound !== 'object') return null
  let raw = inbound.output_config?.effort ?? inbound.reasoning_effort ?? inbound.reasoning?.effort
  if (Array.isArray(inbound.messages)) {
    for (let i = inbound.messages.length - 1; i >= 0; i--) {
      const effort = inbound.messages[i]?.output_config?.effort
      if (effort != null && effort !== '') {
        raw = effort
        break
      }
    }
  }
  if (typeof raw !== 'string') return null
  const effort = raw.trim().toLowerCase()
  return REASONING_EFFORTS.has(effort) ? effort : null
}

const SESSION_ID_MAX = 200

/** Caller session ids come from client headers/bodies; cap them before they hit an index. */
export function sessionIdForLog(value) {
  const s = String(value ?? '').trim()
  return s ? s.slice(0, SESSION_ID_MAX) : null
}
