/**
 * Official Messages body shaping only.
 * The HTTP hop lives in the per-slot Go worker. This file only sanitizes the body.
 */
import {
  applyStructuredOutput,
  canonicalizeClaudeMessagesShape,
  copyOfficialAnthropicFields,
  normalizeAnthropicMessages,
  stripIllegalBodyContentFields,
} from './sanitize.mjs'
import { sanitizeAnthropicTools } from './web-search.mjs'
import { defaultMaxTokensForModel } from './model-policy.mjs'

export function officialMessagesBody(body = {}, { stream = undefined, preserveContentShape = false } = {}) {
  const out = copyOfficialAnthropicFields(body)
  applyStructuredOutput(out, body)
  normalizeAnthropicMessages(out)
  stripIllegalBodyContentFields(out)
  if (Array.isArray(out.tools)) out.tools = sanitizeAnthropicTools(out.tools)
  if (stream !== undefined) out.stream = !!stream
  if (!out.max_tokens) out.max_tokens = defaultMaxTokensForModel(out.model)
  if (Array.isArray(out.tools) && out.tools.length === 0) delete out.tools
  if (out.stop_sequences) delete out.stop
  else if (out.stop != null) {
    out.stop_sequences = Array.isArray(out.stop) ? out.stop : [out.stop]
    delete out.stop
  }
  return canonicalizeClaudeMessagesShape(out, { preserveContentShape })
}

const DISABLED = {
  status: 501,
  ok: false,
  via: 'anthropic-messages-disabled',
  body: {
    type: 'error',
    error: {
      type: 'api_error',
      message: 'Direct host HTTP hop is disabled. All Anthropic I/O goes through the Go slot worker.',
    },
  },
  headers: {},
}

/** Host-process hop stays disabled. The Go slot worker owns the Anthropic HTTP hop. */
export async function callAnthropicMessages(_opts = {}) {
  return { ...DISABLED }
}

export async function streamAnthropicMessages(_opts = {}) {
  return { ...DISABLED }
}
