import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mapUpstreamError,
  rewritePoolErrorForClient,
  poolErrorKind,
  isWrapConnectionError,
  isUsagePolicyErrorMessage,
  isAssistantMessageBody,
  isCompleteAssistantMessage,
  isIncompleteAssistantMessage,
  finalizeAssembledAssistantHop,
  mergeAssembledAssistantHop,
  CLIENT_POOL_BUSY_MESSAGE,
  CLIENT_POOL_UNAVAILABLE_MESSAGE,
} from '../../src/lib/core/errors.mjs'

test('an empty pool is a 503 "no available account", never a load message', () => {
  const mapped = mapUpstreamError(503, {
    error: { type: 'api_error', code: 'account_pool_exhausted', message: 'No eligible Claude accounts remain' },
  })
  assert.equal(mapped.status, 503)
  assert.equal(mapped.body.error.code, 'pool_unavailable')
  assert.equal(mapped.body.error.message, CLIENT_POOL_UNAVAILABLE_MESSAGE)
  assert.equal(mapped.body.error.details, undefined)
})

test('real capacity exhaustion is a 429 pool_overloaded', () => {
  for (const code of ['pool_overloaded', 'pool_wait_queue_full']) {
    const mapped = mapUpstreamError(429, { error: { type: 'rate_limit_error', code, message: 'busy' } })
    assert.equal(mapped.status, 429, code)
    assert.equal(mapped.body.error.type, 'rate_limit_error', code)
    assert.equal(mapped.body.error.code, 'pool_overloaded', code)
    assert.equal(mapped.body.error.message, CLIENT_POOL_BUSY_MESSAGE, code)
  }
})

test('api pool empty message is not leaked to the client', () => {
  const mapped = mapUpstreamError(503, {
    error: { type: 'api_error', code: 'api_pool_exhausted', message: 'no ready api key for this model' },
  })
  assert.equal(mapped.body.error.code, 'pool_unavailable')
  assert.doesNotMatch(mapped.body.error.message, /no ready api|eligible/i)
})

test('rewritePoolErrorForClient strips leftover pool details', () => {
  const rewritten = rewritePoolErrorForClient({
    status: 503,
    body: {
      error: {
        type: 'api_error',
        code: 'account_pool_exhausted',
        message: 'No eligible Claude accounts remain',
        details: { excluded_accounts: ['acc-1'], reason: 'no_eligible_accounts' },
      },
    },
  })
  assert.equal(rewritten.body.error.code, 'pool_unavailable')
  assert.equal(rewritten.body.error.details, undefined)
})

test('fable_requires_max remains a dedicated HTTP 429', () => {
  const mapped = mapUpstreamError(429, {
    type: 'error',
    error: {
      type: 'rate_limit_error',
      code: 'fable_requires_max',
      message: 'Fable requires an available Max account',
    },
  })
  const rewritten = rewritePoolErrorForClient(mapped)
  assert.equal(rewritten.status, 429)
  assert.equal(rewritten.body.error.type, 'rate_limit_error')
  assert.equal(rewritten.body.error.code, 'fable_requires_max')
  assert.equal(rewritten.body.error.message, 'Fable requires an available Max account')
})

test('incomplete upstream stream maps to 502, not api_error 500', () => {
  const mapped = mapUpstreamError(200, {
    type: 'error',
    error: {
      type: 'api_error',
      message: 'Upstream stream ended before a valid terminal event',
    },
  })
  assert.equal(mapped.status, 502)
  assert.equal(mapped.body.error.type, 'upstream_error')
  assert.match(mapped.body.error.message, /valid terminal event/)
})

test('successful Messages payload is not classified as Upstream error: message', () => {
  const body = { type: 'message', role: 'assistant', content: [] }
  assert.equal(isAssistantMessageBody(body), true)
  const mapped = mapUpstreamError(200, body)
  assert.doesNotMatch(String(mapped.body.error.message), /Upstream error: message/)
  assert.notEqual(mapped.body.error.details?.upstream_type, 'message')
})

test('thinking-only assistant is an envelope but not a complete message', () => {
  const thinkingOnly = {
    ok: true,
    terminalState: 'verified',
    body: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'thinking', thinking: '', signature: 'sig' }],
      stop_reason: null,
    },
  }
  assert.equal(isAssistantMessageBody(thinkingOnly.body), true)
  assert.equal(isCompleteAssistantMessage(thinkingOnly), false)
  assert.equal(isIncompleteAssistantMessage(thinkingOnly), true)
  const finalized = finalizeAssembledAssistantHop(thinkingOnly)
  assert.equal(finalized.ok, false)
  assert.equal(finalized.committed, false)
  assert.equal(finalized.terminalState, 'incomplete')
})

test('message_stop completes a hop that has no visible text', () => {
  const stopped = {
    ok: false,
    sawMessageStop: true,
    body: { type: 'message', role: 'assistant', content: [], stop_reason: null },
  }
  assert.equal(isCompleteAssistantMessage(stopped), true)
  assert.equal(finalizeAssembledAssistantHop(stopped).ok, true)
})

test('server_tool_use plus stop_reason is a complete assistant hop', () => {
  const complete = {
    ok: false,
    body: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'news' } }],
      stop_reason: 'tool_use',
    },
  }
  assert.equal(isCompleteAssistantMessage(complete), true)
  assert.equal(finalizeAssembledAssistantHop(complete).ok, true)
})

test('text plus stop_reason is a complete assistant hop', () => {
  const complete = {
    ok: false,
    body: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
    },
  }
  assert.equal(isCompleteAssistantMessage(complete), true)
  assert.equal(finalizeAssembledAssistantHop(complete).ok, true)
})

test('ok text without stop_reason is finalized as incomplete', () => {
  const finalized = finalizeAssembledAssistantHop({
    ok: true,
    terminalState: 'verified',
    body: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'partial' }],
    },
  })
  assert.equal(finalized.ok, false)
  assert.equal(finalized.terminalState, 'incomplete')
})

test('finalize does not clear a committed partial hop', () => {
  const finalized = finalizeAssembledAssistantHop({
    ok: true,
    committed: true,
    terminalState: 'verified',
    body: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'partial' }],
    },
  })
  assert.equal(finalized.ok, false)
  assert.equal(finalized.committed, true)
  assert.equal(finalized.terminalState, 'incomplete')
})

test('client cancel is not rewritten when message_stop is missing', () => {
  const finalized = finalizeAssembledAssistantHop({
    ok: false,
    clientCancelled: true,
    terminalState: 'cancelled',
    committed: true,
    body: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
  })
  assert.equal(finalized.clientCancelled, true)
  assert.equal(finalized.terminalState, 'cancelled')
  assert.equal(finalized.committed, true)
})

test('ok non-assistant envelope is finalized as incomplete', () => {
  const finalized = finalizeAssembledAssistantHop({
    ok: true,
    terminalState: 'verified',
    body: { output_text: 'assembled over an error', error: { message: 'upstream failed' } },
  })
  assert.equal(finalized.ok, false)
  assert.equal(finalized.terminalState, 'incomplete')
})

test('assembled message never overwrites a real SSE error', () => {
  const upstream = {
    ok: false,
    status: 200,
    terminalState: 'incomplete',
    body: {
      type: 'error',
      error: { type: 'api_error', message: 'provider error: API Error: 400 invalid cache ttl order' },
    },
  }
  const assembled = { type: 'message', role: 'assistant', content: [] }
  assert.equal(mergeAssembledAssistantHop(upstream, assembled), upstream)
})

test('incomplete_response maps to HTTP 502', () => {
  const mapped = mapUpstreamError(502, {
    error: {
      type: 'api_error',
      code: 'incomplete_response',
      message: 'Assistant hop ended without visible output or stop_reason',
    },
  })
  assert.equal(mapped.status, 502)
  assert.equal(mapped.body.error.code, 'incomplete_response')
})

test('wrap Connection error is not upstream', () => {
  assert.equal(isWrapConnectionError('provider error: provider error: Connection error.'), true)
  const mapped = mapUpstreamError(200, {
    type: 'error',
    error: { type: 'api_error', message: 'provider error: provider error: Connection error.' },
  })
  assert.equal(mapped.status, 503)
  assert.equal(mapped.body.error.code, 'wrap_connection_error')
  assert.notEqual(mapped.body.error.type, 'upstream_error')
})

test('Claude Code AUP wrap error stays 502, not content_filter 403', () => {
  const msg =
    'provider error: provider error: API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup). Try rephrasing the request'
  assert.equal(isUsagePolicyErrorMessage(msg), true)
  const mapped = mapUpstreamError(502, {
    type: 'error',
    error: { type: 'api_error', message: msg },
  })
  assert.equal(mapped.status, 502)
  assert.notEqual(mapped.body.error.code, 'content_filter_refusal')
})

test('kernel slot_busy is overloaded, not upstream', () => {
  const mapped = mapUpstreamError(503, {
    type: 'error',
    error: { type: 'worker_error', code: 'slot_busy', message: 'rust kernel has no free slot' },
  })
  assert.equal(mapped.status, 503)
  assert.equal(mapped.body.error.type, 'overloaded_error')
  assert.equal(mapped.body.error.code, 'slot_busy')
  assert.match(mapped.body.error.message, /no free slot/)
})

test('poolErrorKind separates capacity from nothing-eligible and leaves upstream errors alone', () => {
  assert.equal(poolErrorKind('pool_overloaded'), 'overloaded')
  assert.equal(poolErrorKind('account_pool_exhausted'), 'unavailable')
  assert.equal(poolErrorKind('api_pool_exhausted'), 'unavailable')
  assert.equal(poolErrorKind('upstream_error', 'No eligible Claude accounts remain'), 'unavailable')
  assert.equal(poolErrorKind('upstream_rate_limit', 'Rate limit exceeded'), null)
  assert.equal(poolErrorKind('incomplete_response'), null)
})
