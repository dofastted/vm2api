/**
 * Structured error taxonomy for KIN gateway.
 * Every error response:
 * {
 *   error: {
 *     type: string,      // high-level category
 *     code: string,      // machine-readable code
 *     message: string,   // human-readable
 *     param?: string,    // which field failed
 *     details?: object,  // optional context
 *     request_id?: string
 *   }
 * }
 */

export const ErrorType = {
  AUTH: 'authentication_error',
  PERMISSION: 'permission_error',
  INVALID_REQUEST: 'invalid_request_error',
  NOT_FOUND: 'not_found_error',
  RATE_LIMIT: 'rate_limit_error',
  QUOTA: 'quota_error',
  UPSTREAM: 'upstream_error',
  API: 'api_error',
  OVERLOADED: 'overloaded_error',
  TIMEOUT: 'timeout_error',
  PROTOCOL: 'protocol_error',
}

export const ErrorCode = {
  // auth
  INVALID_API_KEY: 'invalid_api_key',
  MISSING_API_KEY: 'missing_api_key',
  // body
  INVALID_JSON: 'invalid_json',
  BODY_TOO_LARGE: 'body_too_large',
  EMPTY_BODY: 'empty_body',
  MISSING_FIELD: 'missing_field',
  INVALID_FIELD: 'invalid_field',
  INVALID_MESSAGES: 'invalid_messages',
  INVALID_CONTENT: 'invalid_content',
  // model
  MODEL_REQUIRED: 'model_required',
  MODEL_NOT_SUPPORTED: 'model_not_supported',
  // quota / rate
  GATEWAY_RATE_LIMIT: 'gateway_rate_limit',
  QUOTA_5H_SAFETY: 'quota_5h_safety',
  QUOTA_7D_SAFETY: 'quota_7d_safety',
  CONCURRENCY_LIMIT: 'concurrency_limit',
  API_KEY_DISABLED: 'api_key_disabled',
  API_KEY_EXPIRED: 'api_key_expired',
  API_KEY_QUOTA_EXHAUSTED: 'api_key_quota_exhausted',
  API_KEY_RATE_LIMIT: 'api_key_rate_limit',
  API_KEY_CONCURRENCY_LIMIT: 'api_key_concurrency_limit',
  // upstream
  UPSTREAM_AUTH: 'upstream_auth_error',
  UPSTREAM_RATE_LIMIT: 'upstream_rate_limit',
  UPSTREAM_INVALID: 'upstream_invalid_request',
  UPSTREAM_OVERLOADED: 'upstream_overloaded',
  UPSTREAM_TIMEOUT: 'upstream_timeout',
  UPSTREAM_ERROR: 'upstream_error',
  FABLE_REQUIRES_MAX: 'fable_requires_max',

  INCOMPLETE_RESPONSE: 'incomplete_response',
  CLIENT_CANCELLED: 'client_cancelled',
  // protocol
  PROTOCOL_UNSUPPORTED: 'protocol_unsupported',
  CONVERT_FAILED: 'convert_failed',
  HEALTH_UNAVAILABLE: 'health_unavailable',
  // policy
  DISTILL_BLOCKED: 'distill_blocked',
  REFUSAL_GUARD: 'refusal_guard',
  CONTENT_FILTER_REFUSAL: 'content_filter_refusal',
  // resource
  VM_NOT_FOUND: 'vm_not_found',
  NOT_FOUND: 'not_found',
  OAUTH_NEED_REIMPORT: 'oauth_need_reimport',
  OAUTH_REFRESH_FAILED: 'oauth_refresh_failed',
  COUNT_TOKENS_UNSUPPORTED: 'count_tokens_unsupported',
  USAGE_UNSUPPORTED: 'usage_unsupported',
  // pool — client-facing only; internal codes stay on the log bag
  POOL_OVERLOADED: 'pool_overloaded',
  POOL_UNAVAILABLE: 'pool_unavailable',
}

export const CLIENT_POOL_BUSY_MESSAGE = '号池负载过高，稍后再试'
export const CLIENT_POOL_UNAVAILABLE_MESSAGE = '号池当前没有可用账号'

/** Every eligible seat stayed busy until the bounded wait ran out. */
const POOL_OVERLOADED_CODES = new Set(['pool_overloaded', 'pool_wait_queue_full'])
/** Nothing eligible to wait for: configuration, quota, credentials, or model gates. */
const POOL_UNAVAILABLE_CODES = new Set([
  'account_pool_exhausted',
  'api_pool_exhausted',
  'no_available_accounts',
  'no_eligible_accounts',
])

const POOL_CAPACITY_MESSAGE = /no eligible|no ready api|account pool|号池没有|无可用账号|eligible claude/i
const WRAP_CONNECTION_MESSAGE = /provider error:.*connection error/i
const USAGE_POLICY_MESSAGE =
  /usage policy|legal\/aup|unable to respond to this request|violate our usage|content_filter_refusal/i

export function isWrapConnectionError(message = '') {
  return WRAP_CONNECTION_MESSAGE.test(String(message || ''))
}

export function isUsagePolicyErrorMessage(message = '') {
  return USAGE_POLICY_MESSAGE.test(String(message || ''))
}

/** `overloaded` (real capacity, 429), `unavailable` (nothing eligible, 503), or null. */
export function poolErrorKind(code, message = '') {
  const key = String(code || '').trim()
  if (POOL_OVERLOADED_CODES.has(key)) return 'overloaded'
  if (POOL_UNAVAILABLE_CODES.has(key)) return 'unavailable'
  if (POOL_CAPACITY_MESSAGE.test(String(message || ''))) return 'unavailable'
  return null
}

function poolClientError(kind) {
  if (kind === 'overloaded') {
    return makeError({
      type: ErrorType.RATE_LIMIT,
      code: ErrorCode.POOL_OVERLOADED,
      message: CLIENT_POOL_BUSY_MESSAGE,
      status: 429,
    })
  }
  return makeError({
    type: ErrorType.OVERLOADED,
    code: ErrorCode.POOL_UNAVAILABLE,
    message: CLIENT_POOL_UNAVAILABLE_MESSAGE,
    status: 503,
  })
}

export function rewritePoolErrorForClient(mapped, originalBody = null) {
  const code = originalBody?.error?.code || mapped?.body?.error?.code
  const message = originalBody?.error?.message || mapped?.body?.error?.message || ''
  const kind = poolErrorKind(code, message)
  return kind ? poolClientError(kind) : mapped
}

export function makeError({
  type = ErrorType.API,
  code = 'unknown_error',
  message,
  param,
  details,
  status = 500,
  request_id,
}) {
  const error = { type, code, message: message || code }
  if (param) error.param = param
  if (details && Object.keys(details).length) error.details = details
  if (request_id) error.request_id = request_id
  return { status, body: { error } }
}

// Cancellation is decided by the request's own AbortSignal, never by transport
// text: an upstream ECONNRESET or a local timeout is a real failure, not a cancel.
const CLIENT_CANCEL_CODES = new Set(['client_cancelled', 'request_cancelled', 'client_aborted', 'selection_cancelled'])

export function isClientCancelledCode(code, message = '') {
  if (CLIENT_CANCEL_CODES.has(String(code || '').trim())) return true
  return /client_aborted|request_cancelled|selection_cancelled|context canceled/i.test(`${code || ''} ${message || ''}`)
}

export function isClientCancelledResult(result = {}) {
  if (result?.clientCancelled === true || result?.terminalState === 'cancelled') return true
  const code = result?.body?.error?.code || result?.error_code || ''
  const message = result?.body?.error?.message || result?.error_message || ''
  return isClientCancelledCode(code, message)
}

/**
 * Client lifecycle terminal: the caller went away. Not an error, not a success.
 * Keeps committed/usage so billing and the log see what was really delivered.
 */
export function clientCancelledResult(result = {}, details = null) {
  return {
    ...result,
    ok: false,
    status: 499,
    clientCancelled: true,
    transportError: false,
    terminalState: 'cancelled',
    finalState: 'cancelled',
    committed: !!result?.committed,
    body: {
      type: 'error',
      error: {
        type: ErrorType.TIMEOUT,
        code: ErrorCode.CLIENT_CANCELLED,
        message: 'Client closed the connection',
        ...(details && Object.keys(details).length ? { details } : {}),
      },
    },
  }
}

/** Classify & map Anthropic upstream error body + HTTP status */
function upstreamErrorType(body) {
  if (body?.error?.type) return body.error.type
  // A successful Messages payload is `{ type: "message", role: "assistant" }`.
  // Never treat that as an error class — it became "Upstream error: message (HTTP 200)".
  if (body?.type === 'error') return 'error'
  return null
}

export function isAssistantMessageBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  if (body.error) return false
  if (body.type && body.type !== 'message') return false
  if (body.role && body.role !== 'assistant') return false
  return body.type === 'message' || Array.isArray(body.content)
}

export function assistantVisibleOutput(body) {
  const content = body?.content || body?.message?.content
  if (!Array.isArray(content)) return false
  for (const block of content) {
    const kind = String(block?.type || '')
    if (kind === 'text' && String(block.text || '').trim()) return true
    if (kind === 'tool_use' || kind === 'server_tool_use' || kind === 'mcp_tool_use') return true
    if (kind.endsWith('_tool_use')) return true
    if (kind === 'refusal' && String(block.refusal || block.text || '').trim()) return true
  }
  return false
}

export function assistantStopReason(result = {}) {
  return String(result?.stopReason || result?.body?.stop_reason || '').trim()
}

/**
 * sub2api: message_stop ends the stream even when the body has no visible text.
 * Without that terminal event, stop_reason plus visible text/tool/refusal is required.
 * Thinking-only and a bare stop_reason are not complete.
 */
export function isCompleteAssistantMessage(result = {}) {
  const body = result?.body && typeof result.body === 'object' ? result.body : result
  if (!isAssistantMessageBody(body)) return false
  if (result?.sawMessageStop) return true
  if (!assistantStopReason({ body, stopReason: result?.stopReason })) return false
  return assistantVisibleOutput(body)
}

export function isIncompleteAssistantMessage(result = {}) {
  const body = result?.body && typeof result.body === 'object' ? result.body : result
  if (!isAssistantMessageBody(body)) return false
  return !isCompleteAssistantMessage(result?.body ? result : { body })
}

export function finalizeAssembledAssistantHop(result = {}) {
  if (isClientCancelledResult(result)) return result
  if (isCompleteAssistantMessage(result)) return result?.ok ? result : { ...result, ok: true }
  if (isIncompleteAssistantMessage(result) || result?.ok) {
    return {
      ...result,
      ok: false,
      committed: !!result?.committed,
      terminalState: 'incomplete',
    }
  }
  return result
}

export function mergeAssembledAssistantHop(result = {}, assembled = null) {
  if (!assembled || result?.body?.error || result?.body?.type === 'error') return result
  const assembledResult = { body: assembled, stopReason: assembled.stop_reason }
  if (!isCompleteAssistantMessage(assembledResult) && isCompleteAssistantMessage(result)) return result
  return {
    ...result,
    body: assembled,
    usage: assembled.usage || result.usage,
    model: assembled.model || result.model,
    stopReason: assembled.stop_reason || result.stopReason,
  }
}

export function incompleteAssistantClientError(result = {}) {
  return {
    ...result,
    ok: false,
    committed: !!result?.committed,
    terminalState: 'incomplete',
    status: 502,
    body: {
      type: 'error',
      error: {
        type: ErrorType.UPSTREAM,
        code: ErrorCode.INCOMPLETE_RESPONSE,
        message: 'Assistant hop ended without visible output or stop_reason',
      },
    },
  }
}

export function mapUpstreamError(status, body, headers = {}) {
  const upType = upstreamErrorType(body)
  const inboundCode = body?.error?.code || null
  let msg =
    body?.error?.message ||
    (typeof body?.error === 'string' ? body.error : null) ||
    (upType ? body?.message : null) ||
    body?.raw ||
    null
  if (inboundCode === ErrorCode.FABLE_REQUIRES_MAX) {
    return makeError({
      type: ErrorType.RATE_LIMIT,
      code: ErrorCode.FABLE_REQUIRES_MAX,
      message: String(msg || 'Fable requires an available Max account'),
      status: 429,
    })
  }

  const poolKind = poolErrorKind(inboundCode, msg)
  if (poolKind) return poolClientError(poolKind)
  if (isClientCancelledCode(inboundCode, msg)) {
    return makeError({
      type: ErrorType.TIMEOUT,
      code: 'client_cancelled',
      message: String(msg || 'Client closed the connection'),
      status: 499,
      details: { upstream_status: status },
    })
  }
  if (inboundCode === 'slot_busy' || /rust kernel has no free slot/i.test(String(msg || ''))) {
    return makeError({
      type: ErrorType.OVERLOADED,
      code: 'slot_busy',
      message: String(msg || 'rust kernel has no free slot'),
      status: 503,
    })
  }
  if (inboundCode === 'wrap_connection_error' || isWrapConnectionError(msg)) {
    return makeError({
      type: ErrorType.API,
      code: 'wrap_connection_error',
      message: String(msg || 'wrap CLI connection error'),
      status: 503,
    })
  }

  // Anthropic sometimes returns literal "Error" — enrich for clients like RikkaHub
  if (!msg || String(msg).trim() === '' || /^error$/i.test(String(msg).trim())) {
    if (status === 429 || upType === 'rate_limit_error') {
      msg = 'Rate limit exceeded (upstream). Please retry later or switch account.'
    } else if (status === 401 || status === 403 || upType === 'authentication_error') {
      msg = 'Upstream authentication failed. OAuth credential may be expired.'
    } else if (status === 529 || upType === 'overloaded_error') {
      msg = 'Upstream overloaded. Please retry shortly.'
    } else if (upType) {
      msg = `Upstream error: ${upType} (HTTP ${status})`
    } else {
      msg = `Upstream HTTP ${status}`
    }
  }
  const request_id =
    body?.error?.request_id || body?.request_id || headers['request-id'] || headers['x-request-id'] || null
  if (inboundCode === ErrorCode.CONTENT_FILTER_REFUSAL) {
    return makeError({
      type: ErrorType.PERMISSION,
      code: ErrorCode.CONTENT_FILTER_REFUSAL,
      message: String(msg),
      status: 403,
      details: { upstream_type: upType, upstream_status: status },
      request_id,
    })
  }

  if (status === 401 || status === 403 || upType === 'authentication_error') {
    return makeError({
      type: ErrorType.UPSTREAM,
      code: ErrorCode.UPSTREAM_AUTH,
      message: String(msg),
      status: status === 403 ? 403 : 401,
      details: { upstream_type: upType, upstream_status: status },
      request_id,
    })
  }

  if (status === 429 || upType === 'rate_limit_error') {
    return makeError({
      type: ErrorType.RATE_LIMIT,
      code: ErrorCode.UPSTREAM_RATE_LIMIT,
      message: String(msg),
      status: 429,
      details: {
        upstream_type: upType,
        upstream_status: status,
        retry_after: headers['retry-after'] || null,
      },
      request_id,
    })
  }

  if (status === 529 || upType === 'overloaded_error') {
    return makeError({
      type: ErrorType.OVERLOADED,
      code: ErrorCode.UPSTREAM_OVERLOADED,
      message: String(msg),
      status: 529,
      details: { upstream_type: upType, upstream_status: status },
      request_id,
    })
  }

  if (status === 400 || upType === 'invalid_request_error') {
    return makeError({
      type: ErrorType.INVALID_REQUEST,
      code: ErrorCode.UPSTREAM_INVALID,
      message: String(msg),
      status: 400,
      param: body?.error?.param || undefined,
      details: { upstream_type: upType, upstream_status: status },
      request_id,
    })
  }

  if (
    inboundCode === 'incomplete_response' ||
    inboundCode === 'upstream_stream_incomplete' ||
    inboundCode === 'stream_incomplete' ||
    /ended before a valid terminal event|stream closed before message_stop|without visible output or stop_reason/i.test(
      String(msg || ''),
    )
  ) {
    return makeError({
      type: ErrorType.UPSTREAM,
      code: inboundCode === 'incomplete_response' ? ErrorCode.INCOMPLETE_RESPONSE : ErrorCode.UPSTREAM_ERROR,
      message: String(msg),
      status: 502,
      details: { upstream_type: upType, upstream_status: status, stream: 'incomplete' },
      request_id,
    })
  }

  if (status === 408 || (/timeout/i.test(String(msg)) && !/aborted|econnreset|cancel/i.test(String(msg)))) {
    return makeError({
      type: ErrorType.TIMEOUT,
      code: ErrorCode.UPSTREAM_TIMEOUT,
      message: String(msg),
      status: 504,
      details: { upstream_status: status },
      request_id,
    })
  }

  return makeError({
    type: ErrorType.UPSTREAM,
    code: ErrorCode.UPSTREAM_ERROR,
    message: String(msg),
    status: status >= 400 && status < 600 ? status : 502,
    details: { upstream_type: upType, upstream_status: status },
    request_id,
  })
}

/**
 * Validate protocol request body before convert/upstream.
 * @returns {{ ok: true, body } | { ok: false, errorResult }}
 */
export function validateRequestBody(protocol, body) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      errorResult: makeError({
        type: ErrorType.INVALID_REQUEST,
        code: ErrorCode.EMPTY_BODY,
        message: 'Request body must be a JSON object',
        status: 400,
      }),
    }
  }

  // model
  if (!body.model || typeof body.model !== 'string' || !body.model.trim()) {
    return {
      ok: false,
      errorResult: makeError({
        type: ErrorType.INVALID_REQUEST,
        code: ErrorCode.MODEL_REQUIRED,
        message: 'model is required and must be a non-empty string',
        param: 'model',
        status: 400,
      }),
    }
  }

  if (protocol === 'openai.chat' || protocol === 'anthropic.messages') {
    if (!Array.isArray(body.messages)) {
      return {
        ok: false,
        errorResult: makeError({
          type: ErrorType.INVALID_REQUEST,
          code: ErrorCode.INVALID_MESSAGES,
          message: 'messages must be an array',
          param: 'messages',
          status: 400,
        }),
      }
    }
    if (body.messages.length === 0) {
      return {
        ok: false,
        errorResult: makeError({
          type: ErrorType.INVALID_REQUEST,
          code: ErrorCode.INVALID_MESSAGES,
          message: 'messages must contain at least one item',
          param: 'messages',
          status: 400,
        }),
      }
    }
    for (let i = 0; i < body.messages.length; i++) {
      const m = body.messages[i]
      if (!m || typeof m !== 'object') {
        return {
          ok: false,
          errorResult: makeError({
            type: ErrorType.INVALID_REQUEST,
            code: ErrorCode.INVALID_MESSAGES,
            message: `messages[${i}] must be an object`,
            param: `messages[${i}]`,
            status: 400,
          }),
        }
      }
      if (!m.role || typeof m.role !== 'string') {
        return {
          ok: false,
          errorResult: makeError({
            type: ErrorType.INVALID_REQUEST,
            code: ErrorCode.MISSING_FIELD,
            message: `messages[${i}].role is required`,
            param: `messages[${i}].role`,
            status: 400,
          }),
        }
      }
      if (m.content == null && !m.tool_calls) {
        return {
          ok: false,
          errorResult: makeError({
            type: ErrorType.INVALID_REQUEST,
            code: ErrorCode.MISSING_FIELD,
            message: `messages[${i}].content is required (unless tool_calls present)`,
            param: `messages[${i}].content`,
            status: 400,
          }),
        }
      }
    }
  }

  if (protocol === 'openai.completions') {
    const prompt = body.prompt
    const ok = typeof prompt === 'string' ? prompt.length > 0 : Array.isArray(prompt) && prompt.length > 0
    if (!ok) {
      return {
        ok: false,
        errorResult: makeError({
          type: ErrorType.INVALID_REQUEST,
          code: ErrorCode.MISSING_FIELD,
          message: 'prompt is required for Completions API',
          param: 'prompt',
          status: 400,
        }),
      }
    }
  }

  if (protocol === 'openai.responses') {
    // input can be string or array; or messages
    if (body.input == null && !Array.isArray(body.messages)) {
      return {
        ok: false,
        errorResult: makeError({
          type: ErrorType.INVALID_REQUEST,
          code: ErrorCode.MISSING_FIELD,
          message: 'input (or messages) is required for Responses API',
          param: 'input',
          status: 400,
        }),
      }
    }
  }

  if (protocol === 'anthropic.messages') {
    if (body.max_tokens != null && (typeof body.max_tokens !== 'number' || body.max_tokens < 1)) {
      return {
        ok: false,
        errorResult: makeError({
          type: ErrorType.INVALID_REQUEST,
          code: ErrorCode.INVALID_FIELD,
          message: 'max_tokens must be a positive number',
          param: 'max_tokens',
          status: 400,
        }),
      }
    }
  }

  return { ok: true, body }
}

/** Inspect body for error diagnostics (safe summary, no secrets) */
export function inspectRequestBody(body) {
  if (body == null) return { empty: true }
  if (typeof body !== 'object') return { type: typeof body }
  return {
    keys: Object.keys(body).sort(),
    model: body.model ?? null,
    stream: !!body.stream,
    messages_count: Array.isArray(body.messages) ? body.messages.length : null,
    has_input: body.input != null,
    has_tools: Array.isArray(body.tools) && body.tools.length > 0,
    has_system:
      body.system != null || (Array.isArray(body.messages) && body.messages.some((m) => m?.role === 'system')),
    max_tokens: body.max_tokens ?? body.max_output_tokens ?? null,
  }
}

export function mapQuotaGateError(gate) {
  const code = gate.reason || 'quota_error'
  const type = code === 'concurrency_limit' ? ErrorType.RATE_LIMIT : ErrorType.QUOTA
  return makeError({
    type,
    code,
    message: gate.detail?.message || gate.reason || 'Quota exceeded',
    status: 429,
    details: gate.detail || undefined,
  })
}

export function mapModelError(modelCheck) {
  const e = modelCheck.error || {}
  return makeError({
    type: e.type || ErrorType.INVALID_REQUEST,
    code: e.code || ErrorCode.MODEL_NOT_SUPPORTED,
    message: e.message || 'Model not supported',
    param: e.param || 'model',
    status: 400,
  })
}
