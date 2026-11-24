import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAnthropicSseError,
  buildRetryableTruncationError,
  createAnthropicSseErrorRemapper,
  createAnthropicStreamTracker,
  isRecoverableTruncation,
  truncationReason,
} from '../../src/lib/protocol/stream-truncation.mjs'

test('a cut tool call closes as max_tokens and a thinking block does not', () => {
  const tracker = createAnthropicStreamTracker()
  tracker.observe('data: {"type":"message_start","message":{"usage":{"output_tokens":3}}}\n\n')
  tracker.observe(
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"Write"}}\n\n',
  )
  tracker.observe(
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"file"}}\n\n',
  )
  const closing = tracker.closingEvents()
  assert.match(closing, /content_block_stop/)
  assert.match(closing, /"stop_reason":"max_tokens"/)
  assert.match(closing, /message_stop/)
  assert.equal(tracker.closingEvents(), null)

  const thinking = createAnthropicStreamTracker()
  thinking.observe('data: {"type":"message_start","message":{"usage":{"output_tokens":1}}}\n\n')
  thinking.observe('data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n')
  assert.equal(thinking.closingEvents(), null)
})

test('an unstarted stream reports that, and an error event names overloaded_error', () => {
  const tracker = createAnthropicStreamTracker()
  assert.equal(tracker.hasStarted(), false)
  assert.equal(tracker.isFinished(), false)
  const event = buildAnthropicSseError({
    type: 'overloaded_error',
    code: 'pool_overloaded',
    message: '号池负载过高，稍后再试',
    details: { reason: 'pool_deadline_exceeded' },
  })
  assert.match(event, /^event: error\ndata: /)
  const payload = JSON.parse(event.split('\n')[1].slice(5).trim())
  assert.equal(payload.type, 'error')
  assert.equal(payload.error.type, 'overloaded_error')
  assert.equal(payload.error.code, 'pool_overloaded')
  assert.equal(payload.error.details, undefined)
})

test('a worker timeout is not closed as max_tokens', () => {
  assert.equal(isRecoverableTruncation({ ok: false }), true)
  assert.equal(
    isRecoverableTruncation({ body: { error: { code: 'worker_timeout', message: 'slot worker idle timeout' } } }),
    false,
  )
})

test('a failed native handoff never manufactures a max_tokens terminal', () => {
  for (const body of [undefined, { error: { type: 'api_error', message: 'native terminal unavailable' } }]) {
    assert.equal(isRecoverableTruncation({ ok: false, nativeHandoff: true, committed: true, body }), false)
  }
})

test('an unconfirmed cluster turn is never closed as max_tokens', () => {
  assert.equal(
    isRecoverableTruncation({ body: { error: { code: 'cluster_delivery_unconfirmed' } }, committed: true }),
    false,
  )
})

test('streaming Usage Policy SSE error remaps to policy_blocked / refusal_guard (#503)', () => {
  const msg =
    'provider error: provider error: API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup). Try rephrasing the request'
  const upstream = JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message: msg },
  })
  const remapper = createAnthropicSseErrorRemapper()
  remapper.remapLine('event: error\n')
  const remapped = remapper.remapLine(`data: ${upstream}\n`)
  assert.match(remapped, /^data: /)
  const payload = JSON.parse(remapped.trim().slice(5))
  assert.equal(payload.type, 'error')
  assert.equal(payload.error.type, 'policy_blocked')
  assert.equal(payload.error.code, 'refusal_guard')
  assert.notEqual(payload.error.type, 'invalid_request_error')
  assert.notEqual(payload.error.code, 'upstream_invalid_request')
  assert.equal(payload.error.details?.blocked_by, 'upstream')
  assert.equal(payload.error.details?.retryable, false)
})

test('streaming third-party extra-usage SSE error remaps to third_party_client, not a refusal', () => {
  const msg =
    'Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.'
  const upstream = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: msg } })
  const remapper = createAnthropicSseErrorRemapper()
  remapper.remapLine('event: error\n')
  const payload = JSON.parse(remapper.remapLine(`data: ${upstream}\n`).trim().slice(5))
  assert.equal(payload.error.type, 'invalid_request_error')
  assert.equal(payload.error.code, 'third_party_client')
  assert.equal(payload.error.details?.upstream_message, msg)
  assert.equal(payload.error.details?.retryable, false)
  assert.notEqual(payload.error.code, 'refusal_guard')
})

test('non-error SSE lines pass through the Anthropic error remapper unchanged', () => {
  const remapper = createAnthropicSseErrorRemapper()
  const line = 'data: {"type":"message_start","message":{"id":"msg_1","content":[]}}\n'
  assert.equal(remapper.remapLine(line), line)
})

test('an unclosable started stream gets a retryable rate_limit_error and a logged cause', () => {
  const thinking = createAnthropicStreamTracker()
  thinking.observe('data: {"type":"message_start","message":{"usage":{"output_tokens":1}}}\n\n')
  thinking.observe('data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n')
  assert.equal(thinking.openBlockType(), 'thinking')
  assert.equal(truncationReason({ ok: false }, thinking), 'thinking_open')

  const timeout = { body: { error: { code: 'worker_timeout', message: 'slot worker idle timeout' } } }
  assert.equal(truncationReason(timeout, thinking), 'timeout')

  const text = createAnthropicStreamTracker()
  text.observe('data: {"type":"message_start","message":{"usage":{"output_tokens":1}}}\n\n')
  text.observe('data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n')
  assert.equal(truncationReason(timeout, text), 'timeout')
  assert.match(text.closingEvents(), /"stop_reason":"max_tokens"/)

  const event = buildRetryableTruncationError()
  assert.match(event, /^event: error\ndata: /)
  const payload = JSON.parse(event.split('\n')[1].slice(5).trim())
  assert.equal(payload.error.type, 'rate_limit_error')
})

test('started SSE stream remaps transient mid-response capture/stream errors to retryable rate_limit_error', () => {
  const cases = [
    { type: 'error', error: { type: 'capture_error', message: 'Provider observation is incomplete' }, request_id: 'req_1' },
    { type: 'error', error: { type: 'api_error', message: 'invalid native response stream' }, request_id: 'req_2' },
    { type: 'error', error: { type: 'api_error', code: 'native_handoff_incomplete', message: 'Native provider response is incomplete' } },
  ]
  for (const upstream of cases) {
    let notified = 0
    const started = createAnthropicSseErrorRemapper({
      isStarted: () => true,
      onRetryableTruncation: () => {
        notified++
      },
    })
    started.remapLine('event: error\n')
    const out = JSON.parse(started.remapLine(`data: ${JSON.stringify(upstream)}\n`).trim().slice(5))
    assert.equal(out.error.type, 'rate_limit_error')
    assert.equal(notified, 1)
    if (upstream.request_id) assert.equal(out.error.request_id, upstream.request_id)

    // Before message_start, keep the real upstream_error taxonomy.
    const unstarted = createAnthropicSseErrorRemapper({ isStarted: () => false })
    unstarted.remapLine('event: error\n')
    const outUnstarted = JSON.parse(unstarted.remapLine(`data: ${JSON.stringify(upstream)}\n`).trim().slice(5))
    assert.equal(outUnstarted.error.type, 'upstream_error')
  }

  // Timeouts and 4xx/policy/auth errors are never turned into retryable rate_limit_error.
  for (const nonRetryable of [
    { type: 'error', error: { type: 'api_error', message: 'request timed out: first_output' } },
    { type: 'error', error: { type: 'invalid_request_error', message: 'bad input' } },
    { type: 'error', error: { type: 'authentication_error', message: 'invalid token' } },
  ]) {
    let notified = 0
    const remapper = createAnthropicSseErrorRemapper({
      isStarted: () => true,
      onRetryableTruncation: () => {
        notified++
      },
    })
    remapper.remapLine('event: error\n')
    const out = JSON.parse(remapper.remapLine(`data: ${JSON.stringify(nonRetryable)}\n`).trim().slice(5))
    assert.notEqual(out.error.type, 'rate_limit_error')
    assert.equal(notified, 0)
  }
})

test('the retryable-truncation callback receives the raw payload and the mapped error', () => {
  // The client is told to retry, so the caller has to be able to log what really
  // happened. This relay path writes no other diagnostic fields, so if these two
  // arguments were dropped a deterministic fault would read as a transient drop.
  const upstream = {
    type: 'error',
    error: { type: 'capture_error', code: 'capture_broke', message: 'Provider observation is incomplete' },
  }
  const seen = []
  const remapper = createAnthropicSseErrorRemapper({
    isStarted: () => true,
    onRetryableTruncation: (payload, mapped) => {
      seen.push([payload, mapped])
    },
  })
  remapper.remapLine('event: error\n')
  const out = JSON.parse(remapper.remapLine(`data: ${JSON.stringify(upstream)}\n`).trim().slice(5))
  assert.equal(out.error.type, 'rate_limit_error')
  assert.equal(seen.length, 1)
  const [payload, mapped] = seen[0]
  assert.equal(payload.error.type, 'capture_error')
  assert.equal(payload.error.code, 'capture_broke')
  assert.equal(payload.error.message, 'Provider observation is incomplete')
  assert.ok(mapped?.body?.error, 'the mapped error must reach the callback too')
  assert.ok(mapped.status >= 500)
})
