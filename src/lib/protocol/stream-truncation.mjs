/**
 * Upstream sometimes closes a Claude stream mid-response: no error event, no
 * message_stop. Interactive Claude Code then shows "Connection lost
 * mid-response" and ends the turn. It recovers from max_tokens everywhere:
 * a cut tool call comes back as an input validation error and the model
 * re-issues it, cut text gets the output-limit resume nudge. Once output
 * reached the client, close the message as max_tokens instead of dropping it.
 * A thinking block cut mid-way cannot be closed (it needs a signature).
 */

import { ErrorCode, mapUpstreamError, rewritePoolErrorForClient } from '../core/errors.mjs'
import { semanticStatusForStreamError } from './stream-error-status.mjs'

const CLOSABLE_BLOCKS = new Set(['text', 'tool_use'])

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** Anthropic streaming error. `type` is what clients branch on (`overloaded_error`, …). */
export function buildAnthropicSseError(error = {}, poolReason = null) {
  const body = {
    type: String(error.type || 'api_error'),
    message: String(error.message || 'An error occurred while processing the request'),
  }
  if (error.code) body.code = String(error.code)
  if (error.code === ErrorCode.POOL_OVERLOADED && poolReason === 'subagent_limit') {
    body.details = { reason: poolReason }
  }
  return sse('error', { type: 'error', error: body })
}

const MID_STREAM_TRUNCATION_MSG_RE =
  /Provider observation is incomplete|invalid native response stream|stream closed before message_stop|ended before a valid terminal event|Native provider response (?:is incomplete|ended before)/i

const MID_STREAM_TRUNCATION_CODES = new Set([
  'native_handoff_incomplete',
  'upstream_stream_incomplete',
  'stream_incomplete',
])

export function isRetryableMidStreamSseError(payload, mapped) {
  const rawErr = payload?.error || payload || {}
  const mappedErr = mapped?.body?.error
  if (!mappedErr || mapped.status < 500 || mappedErr.type !== 'upstream_error') return false
  const rawType = String(rawErr.type || '').toLowerCase()
  const rawCode = String(rawErr.code || mappedErr.code || '').toLowerCase()
  const rawMsg = String(rawErr.message || mappedErr.message || '')
  if (/timeout/i.test(`${rawCode} ${rawType} ${rawMsg}`)) return false
  if (rawType === 'capture_error') return true
  if (MID_STREAM_TRUNCATION_CODES.has(rawCode)) return true
  return MID_STREAM_TRUNCATION_MSG_RE.test(rawMsg)
}

/**
 * Remap upstream `event: error` SSE data lines through mapUpstreamError so
 * streaming Anthropic clients see the same taxonomy as non-streaming responses.
 * Once a stream has already delivered `message_start`, transient mid-response
 * capture/stream interruptions are remapped to a retryable `rate_limit_error`
 * so Claude Code retries instead of ending the turn with mid-response disconnect.
 */
export function createAnthropicSseErrorRemapper({ headers = {}, isStarted = null, onRetryableTruncation = null } = {}) {
  let pendingEvent = null
  return {
    remapLine(line) {
      const text = String(line)
      const trimmed = text.trimEnd()
      const bare = trimmed.trim()
      if (bare.startsWith('event:')) {
        pendingEvent = bare.slice(6).trim()
        return line
      }
      if (bare === '') {
        pendingEvent = null
        return line
      }
      if (!bare.startsWith('data:') || pendingEvent !== 'error') return line
      pendingEvent = null
      let payload
      try {
        payload = JSON.parse(bare.slice(5).trim())
      } catch {
        return line
      }
      if (payload?.type !== 'error' && !payload?.error) return line
      const hopStatus = semanticStatusForStreamError(payload)
      const mapped = rewritePoolErrorForClient(mapUpstreamError(hopStatus, payload, headers), payload)
      const err = mapped.body?.error
      if (!err) return line
      const suffix = text.slice(trimmed.length)
      if (isStarted?.() === true && isRetryableMidStreamSseError(payload, mapped)) {
        onRetryableTruncation?.(payload, mapped)
        const data = JSON.stringify({
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: 'Upstream stream was interrupted mid-response; please retry',
            ...(err.request_id ? { request_id: err.request_id } : {}),
          },
        })
        return `data: ${data}${suffix || '\n'}`
      }
      const data = JSON.stringify({
        type: 'error',
        error: {
          type: err.type,
          message: err.message,
          ...(err.code ? { code: err.code } : {}),
          ...(err.details && Object.keys(err.details).length ? { details: err.details } : {}),
          ...(err.request_id ? { request_id: err.request_id } : {}),
        },
      })
      return `data: ${data}${suffix || '\n'}`
    },
  }
}

export function createAnthropicStreamTracker() {
  let started = false
  let finished = false
  let open = null
  let outputTokens = 0
  return {
    observe(line) {
      const text = String(line)
      const dataLine = text
        .split('\n')
        .map((row) => row.trim())
        .find((row) => row.startsWith('data:'))
      if (!dataLine) return
      let event
      try {
        event = JSON.parse(dataLine.slice(5).trim())
      } catch {
        return
      }
      switch (event?.type) {
        case 'message_start':
          started = true
          outputTokens = event.message?.usage?.output_tokens || outputTokens
          break
        case 'content_block_start':
          open = { index: event.index, type: event.content_block?.type }
          break
        case 'content_block_stop':
          if (open?.index === event.index) open = null
          break
        case 'message_delta':
          outputTokens = event.usage?.output_tokens || outputTokens
          break
        case 'message_stop':
        case 'error':
          finished = true
          break
        default:
          break
      }
    },
    hasStarted() {
      return started
    },
    /** Type of the content block still open when the stream ended, or null. */
    openBlockType() {
      return open?.type || null
    },
    isFinished() {
      return finished
    },
    /** SSE text that ends the message as max_tokens, or null when it cannot be closed. */
    closingEvents() {
      if (!started || finished) return null
      if (open && !CLOSABLE_BLOCKS.has(open.type)) return null
      let out = ''
      if (open) out += sse('content_block_stop', { type: 'content_block_stop', index: open.index })
      out += sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'max_tokens', stop_sequence: null },
        usage: { output_tokens: outputTokens },
      })
      out += sse('message_stop', { type: 'message_stop' })
      finished = true
      return out
    },
  }
}

/**
 * A started stream that cannot be closed as max_tokens (thinking block open,
 * or a timeout) would otherwise just drop the connection. Send a retryable
 * rate_limit_error (429) instead; the real cause stays in the request log.
 */
export function buildRetryableTruncationError() {
  return buildAnthropicSseError({
    type: 'rate_limit_error',
    message: 'Upstream stream was interrupted mid-response; please retry',
  })
}

/** Why a started stream could not be closed, for the log. */
export function truncationReason(result, tracker) {
  if (!isRecoverableTruncation(result)) return 'timeout'
  if (tracker?.openBlockType() === 'thinking') return 'thinking_open'
  return 'other'
}

/** A timeout would just stall again if the client retries. An upstream error event already reached the client. */
export function isRecoverableTruncation(result) {
  // A negotiated provider handoff must supply its own terminal proof.
  // Closing a failed handoff as max_tokens would manufacture a success.
  if (result?.nativeHandoff === true) return false
  const error = result?.body?.error
  if (error?.code === ErrorCode.CLUSTER_DELIVERY_UNCONFIRMED) return false
  if (!error) return true
  return !/timeout/i.test(`${error.code || ''} ${error.type || ''} ${error.message || ''}`)
}
