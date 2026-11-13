import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAnthropicSseError,
  createAnthropicSseErrorRemapper,
  createAnthropicStreamTracker,
  isRecoverableTruncation,
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

test('non-error SSE lines pass through the Anthropic error remapper unchanged', () => {
  const remapper = createAnthropicSseErrorRemapper()
  const line = 'data: {"type":"message_start","message":{"id":"msg_1","content":[]}}\n'
  assert.equal(remapper.remapLine(line), line)
})
