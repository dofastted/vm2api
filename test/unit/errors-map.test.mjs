import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mapUpstreamError,
  rewritePoolErrorForClient,
  poolErrorKind,
  retryAfterSeconds,
  isWrapConnectionError,
  isUsagePolicyErrorMessage,
  isUnanswerablePromptMessage,
  makeRefusalGuardError,
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

test('real capacity exhaustion and queue timeout are a 529 overloaded_error with retry-after', () => {
  for (const code of ['pool_overloaded', 'pool_wait_queue_full', 'pool_queue_timeout']) {
    const mapped = mapUpstreamError(529, { error: { type: 'overloaded_error', code, message: 'busy' } })
    assert.equal(mapped.status, 529, code)
    assert.equal(mapped.body.error.type, 'overloaded_error', code)
    assert.equal(mapped.body.error.code, 'pool_overloaded', code)
    assert.equal(mapped.body.error.message, CLIENT_POOL_BUSY_MESSAGE, code)
    assert.ok(mapped.retryAfterSec >= 1, code)
    assert.equal(poolErrorKind(code), 'overloaded', code)
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

test('kernel-reported failure codes reach the client as themselves', () => {
  for (const [code, status] of [
    ['upstream_network_error', 502],
    ['upstream_stream_interrupted', 502],
    ['upstream_empty_stream', 502],
    ['cli_error', 502],
    ['kernel_unavailable', 503],
    ['upstream_error', 502],
  ]) {
    const mapped = mapUpstreamError(200, { error: { type: 'api_error', code, message: 'cause' } })
    assert.equal(mapped.status, status, code)
    assert.equal(mapped.body.error.code, code)
  }
})

test('structured upstream causes outrank text heuristics and preserve actual HTTP status', () => {
  for (const [status, code, message] of [
    [502, 'upstream_network_error', 'Connection error.'],
    [500, 'upstream_error', 'fixture server failure'],
    [404, 'upstream_invalid_request', 'fixture missing model'],
    [504, 'upstream_timeout', 'upstream body read failed'],
  ]) {
    const mapped = mapUpstreamError(status, { error: { type: 'api_error', code, message } })
    assert.equal(mapped.status, status)
    assert.equal(mapped.body.error.code, code)
  }
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

test('Claude Code AUP API Error is a non-retryable 400 policy rejection, not a login error', () => {
  const msg =
    'provider error: provider error: API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup). Try rephrasing the request'
  assert.equal(isUsagePolicyErrorMessage(msg), true)
  for (const status of [400, 502]) {
    const mapped = mapUpstreamError(status, {
      type: 'error',
      error: { type: 'api_error', message: msg },
    })
    assert.equal(mapped.status, 400)
    assert.equal(mapped.body.error.code, 'refusal_guard')
    assert.equal(mapped.body.error.type, 'policy_blocked')
    assert.notEqual(mapped.body.error.code, 'content_filter_refusal')
    assert.notEqual(mapped.body.error.code, 'upstream_invalid_request')
  }
})

test('third-party extra-usage 400 and 503 are non-retryable refusals, not invalid requests', () => {
  const msg =
    'HTTP 400: Third-party apps now draw from your extra usage, not your plan limits. Claim it at claude.ai/settings/usage.'
  assert.equal(isUsagePolicyErrorMessage(msg), false)
  assert.equal(isUnanswerablePromptMessage(msg), true)
  assert.equal(isUnanswerablePromptMessage('Extra usage required for this model'), false)
  for (const status of [400, 503]) {
    const mapped = mapUpstreamError(status, {
      type: 'error',
      error: { type: 'invalid_request_error', code: 'upstream_invalid_request', message: msg },
    })
    assert.equal(mapped.status, 400)
    assert.equal(mapped.body.error.code, 'refusal_guard')
    assert.equal(mapped.body.error.type, 'policy_blocked')
    assert.equal(mapped.body.error.details.retryable, false)
    assert.notEqual(mapped.body.error.code, 'upstream_invalid_request')
  }
})

test('real authentication failures keep their HTTP status and are not policy refusals', () => {
  const policyText =
    'Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup).'
  for (const status of [401, 403]) {
    const mapped = mapUpstreamError(status, {
      error: { type: 'authentication_error', message: status === 401 ? policyText : 'Expired OAuth credentials' },
    })
    assert.equal(mapped.status, status)
    assert.equal(mapped.body.error.code, 'upstream_auth_error')
    assert.notEqual(mapped.body.error.code, 'refusal_guard')
  }
})

test('mapping an existing refusal error retains its block kind and safe device source', () => {
  for (const blockedBy of ['exact', 'similar', 'device']) {
    const original = makeRefusalGuardError({
      requestId: 'current',
      blockedBy,
      sourceRequestId: '36e239bf-7e70-4a79-80fd-c8a717ff464b',
    })
    assert.deepEqual(mapUpstreamError(original.status, original.body), original)
  }
})

test('kernel slot_busy on the last hop is pool capacity: 529 with Retry-After', () => {
  const mapped = mapUpstreamError(503, {
    type: 'error',
    error: { type: 'worker_error', code: 'slot_busy', message: 'rust kernel has no free slot' },
  })
  assert.equal(mapped.status, 529)
  assert.equal(mapped.body.error.type, 'overloaded_error')
  assert.equal(mapped.body.error.code, 'pool_overloaded')
  assert.ok(mapped.retryAfterSec >= 1)
})

test('upstream 429 / 529 hand their Retry-After to the client; 529 always has one', () => {
  const limited = mapUpstreamError(
    429,
    { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
    { 'retry-after': '17' },
  )
  assert.equal(limited.status, 429)
  assert.equal(limited.retryAfterSec, 17)
  const bare = mapUpstreamError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } })
  assert.equal(bare.retryAfterSec, undefined)
  const overloaded = mapUpstreamError(529, { type: 'error', error: { type: 'overloaded_error', message: 'busy' } })
  assert.equal(overloaded.status, 529)
  assert.equal(overloaded.retryAfterSec, 1)
})

test('retryAfterSeconds reads delta seconds and HTTP dates', () => {
  const now = Date.parse('2026-10-06T00:00:00Z')
  assert.equal(retryAfterSeconds('2.2', now), 3)
  assert.equal(retryAfterSeconds('Tue, 06 Oct 2026 00:00:30 GMT', now), 30)
  assert.equal(retryAfterSeconds('0', now), null)
  assert.equal(retryAfterSeconds('', now), null)
  assert.equal(retryAfterSeconds('soon', now), null)
})

test('pool-wide cooldowns: 529 overload cooldown is capacity, 429 cooldown is a 429', () => {
  const capacity = rewritePoolErrorForClient(null, { error: { code: 'pool_overload_cooldown' } })
  assert.equal(capacity.status, 529)
  assert.equal(capacity.body.error.code, 'pool_overloaded')
  const limited = rewritePoolErrorForClient(null, { error: { code: 'pool_rate_limited' } })
  assert.equal(limited.status, 429)
  assert.equal(limited.body.error.type, 'rate_limit_error')
  assert.equal(limited.body.error.code, 'upstream_rate_limit')
  assert.ok(limited.retryAfterSec >= 1)
})

test('poolErrorKind separates capacity from nothing-eligible and leaves upstream errors alone', () => {
  assert.equal(poolErrorKind('pool_overloaded'), 'overloaded')
  assert.equal(poolErrorKind('account_pool_exhausted'), 'unavailable')
  assert.equal(poolErrorKind('api_pool_exhausted'), 'unavailable')
  assert.equal(poolErrorKind('upstream_error', 'No eligible Claude accounts remain'), 'unavailable')
  assert.equal(poolErrorKind('upstream_rate_limit', 'Rate limit exceeded'), null)
  assert.equal(poolErrorKind('incomplete_response'), null)
})
