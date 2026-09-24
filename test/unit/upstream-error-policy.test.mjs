import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyUpstreamResult,
  repairAnthropicRequest,
  shouldContinue,
} from '../../src/lib/pool/upstream-error-policy.mjs'

test('unified account 429 without reset header uses usage window then 30 minutes', () => {
  const now = 1_700_000_000_000
  const usageReset = now + 3_600_000
  const fromUsage = classifyUpstreamResult(
    {
      status: 429,
      body: { type: 'error', error: { type: 'rate_limit_error', message: 'limited' } },
      headers: {
        'anthropic-ratelimit-unified-5h-status': 'rejected',
      },
    },
    { model: 'claude-opus-test', now, usage: { reset_5h: new Date(usageReset).toISOString() } },
  )
  assert.equal(fromUsage.reason, 'account_quota_exhausted')
  assert.equal(fromUsage.cooldownUntil, usageReset)
  const fallback = classifyUpstreamResult(
    {
      status: 429,
      body: { type: 'error', error: { type: 'rate_limit_error', message: 'limited' } },
      headers: {
        'anthropic-ratelimit-unified-5h-status': 'rejected',
      },
    },
    { model: 'claude-opus-test', now },
  )
  assert.equal(fallback.cooldownUntil, now + 30 * 60_000)
})

test('unified account 429 cools account until authoritative reset', () => {
  const now = 1_700_000_000_000
  const reset = now + 120_000
  const policy = classifyUpstreamResult(
    {
      status: 429,
      body: { type: 'error', error: { type: 'rate_limit_error', message: 'limited' } },
      headers: {
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'anthropic-ratelimit-unified-5h-reset': String(reset),
      },
    },
    { model: 'claude-opus-test', now },
  )
  assert.equal(policy.scope, 'account')
  assert.equal(policy.action, 'continue-and-cooldown')
  assert.equal(policy.cooldownUntil, reset)
  assert.equal(shouldContinue(policy), true)
})

test('model 429 stays on the model and does not open the unit circuit', () => {
  const policy = classifyUpstreamResult(
    {
      status: 429,
      body: { error: { type: 'rate_limit_error', message: 'model capacity' } },
      headers: {},
    },
    { model: 'claude-sonnet-test', now: 1000 },
  )
  assert.equal(policy.scope, 'model')
  assert.equal(policy.model, 'claude-sonnet-test')
  assert.equal(policy.cooldownUntil, 61_000)
  assert.equal(policy.circuit, undefined)
  assert.equal(policy.decision.scope, 'model')
})

test('entitlement 429 stops without poisoning pool', () => {
  const policy = classifyUpstreamResult(
    {
      status: 429,
      body: { error: { message: 'Usage credits are required for fast mode' } },
    },
    { model: 'claude-opus-test' },
  )
  assert.equal(policy.scope, 'request')
  assert.equal(policy.action, 'stop')
})

test('wrap Connection error retries the same account', () => {
  const policy = classifyUpstreamResult({
    status: 200,
    ok: false,
    committed: false,
    terminalState: 'incomplete',
    body: { error: { type: 'api_error', message: 'provider error: provider error: Connection error.' } },
  })
  assert.equal(policy.scope, 'worker')
  assert.equal(policy.action, 'continue')
  assert.equal(policy.reason, 'wrap_connection_error')
  assert.equal(policy.retrySameAccount, true)
})

test('committed incomplete stream never switches account', () => {
  const policy = classifyUpstreamResult({
    status: 200,
    ok: false,
    committed: true,
    terminalState: 'incomplete',
  })
  assert.equal(policy.scope, 'stream')
  assert.equal(policy.action, 'stop')
})

test('transport proxy error rotates with proxy cooldown', () => {
  const policy = classifyUpstreamResult(
    {
      status: 0,
      transportError: true,
      body: { error: { code: 'worker_transport_error', message: 'SOCKS proxy dial failed' } },
    },
    { now: 1000 },
  )
  assert.equal(policy.scope, 'proxy')
  assert.equal(policy.action, 'continue-and-cooldown')
})

test('response-header timeout does not cool the account', () => {
  const policy = classifyUpstreamResult(
    {
      status: 502,
      body: {
        error: {
          type: 'api_error',
          code: 'upstream_transport_error',
          message: 'net/http: timeout awaiting response headers',
        },
      },
    },
    { now: 1000 },
  )
  assert.equal(policy.scope, 'provider')
  assert.equal(policy.action, 'continue')
  assert.equal(policy.reason, 'provider_timeout')
  assert.equal(policy.cooldownUntil, null)
  assert.equal(policy.retrySameAccount, true)
  assert.equal(shouldContinue(policy), true)
})

test('generic 502 overload switches units through the circuit, not a 15s cooldown', () => {
  const policy = classifyUpstreamResult(
    {
      status: 502,
      body: { error: { type: 'api_error', message: 'Upstream service temporarily unavailable' } },
    },
    { now: 1000 },
  )
  assert.equal(policy.action, 'continue')
  assert.equal(policy.reason, 'provider_overloaded')
  assert.equal(policy.cooldownUntil, null)
  assert.equal(policy.circuit, true)
  assert.equal(policy.decision.scope, 'unit')
  assert.equal(policy.decision.action, 'next_unit')
  assert.equal(policy.retrySameAccount, false)
  assert.equal(shouldContinue(policy), true)
})

test('incomplete 502 is an empty hop, not account overload', () => {
  const policy = classifyUpstreamResult(
    {
      status: 502,
      terminalState: 'incomplete',
      committed: false,
      body: { type: 'error', error: { type: 'api_error', message: 'provider error' } },
    },
    { now: 1000 },
  )
  assert.equal(policy.scope, 'stream')
  assert.equal(policy.reason, 'empty_response')
  assert.equal(policy.action, 'continue')
  assert.equal(policy.cooldownUntil, null)
  assert.equal(policy.retrySameAccount, true)
})

test('slot_busy 503 does not park the account', () => {
  const policy = classifyUpstreamResult(
    {
      status: 503,
      body: {
        type: 'error',
        error: { type: 'worker_error', code: 'slot_busy', message: 'rust kernel has no free slot' },
      },
    },
    { now: 1000 },
  )
  assert.equal(policy.action, 'continue')
  assert.equal(policy.reason, 'slot_busy')
  assert.equal(policy.cooldownUntil, null)
  assert.equal(policy.retrySameAccount, false)
})

test('a 502 plan-limit message switches accounts until the reset named in the text', () => {
  const now = Date.parse('2026-09-23T12:37:10Z')
  const policy = classifyUpstreamResult(
    {
      status: 502,
      body: {
        error: {
          type: 'api_error',
          message: "provider error: You've hit your limit · resets 4:20pm (America/Los_Angeles)",
        },
      },
    },
    // An elapsed leftover window reset must lose to the text reset.
    { now, usage: { reset_5h: new Date(now - 3_600_000).toISOString() } },
  )
  assert.equal(policy.action, 'continue-and-cooldown')
  assert.equal(policy.reason, 'account_quota_exhausted')
  assert.equal(policy.cooldownUntil, Date.parse('2026-09-23T23:20:00Z'))
  assert.equal(policy.rememberRefusal, undefined)
  assert.equal(shouldContinue(policy), true)
})

test('200 + streamed plan-limit error is account quota, not http_200 stop', () => {
  const now = Date.parse('2026-09-23T12:37:10Z')
  const policy = classifyUpstreamResult(
    {
      ok: false,
      status: 200,
      committed: false,
      terminalState: 'incomplete',
      body: {
        type: 'error',
        error: {
          type: 'api_error',
          message: "provider error: provider error: You've hit your limit · resets 11am (America/New_York)",
        },
      },
    },
    { now },
  )
  assert.equal(policy.scope, 'account')
  assert.equal(policy.reason, 'account_quota_exhausted')
  assert.equal(policy.cooldownUntil, Date.parse('2026-09-23T15:00:00Z'))
  assert.equal(policy.retrySameAccount, false)
})

test('extra usage required stays a request-scoped entitlement stop', () => {
  const policy = classifyUpstreamResult(
    {
      status: 429,
      body: { type: 'error', error: { type: 'rate_limit_error', message: 'Extra usage required for this model' } },
    },
    { now: 1000 },
  )
  assert.equal(policy.reason, 'entitlement_required')
})

test('empty_response retries the same account', () => {
  const policy = classifyUpstreamResult(
    {
      ok: false,
      status: 502,
      terminalState: 'incomplete',
      body: { type: 'error', error: { type: 'api_error', code: 'empty_response', message: 'no output' } },
    },
    { now: 1000 },
  )
  assert.equal(policy.reason, 'empty_response')
  assert.equal(policy.retrySameAccount, true)
  assert.equal(shouldContinue(policy), true)
})

test('transport timeout is not treated as a dead proxy', () => {
  const policy = classifyUpstreamResult(
    {
      status: 0,
      transportError: true,
      body: { error: { code: 'upstream_transport_error', message: 'SOCKS connection timed out' } },
    },
    { now: 1000 },
  )
  assert.equal(policy.scope, 'worker')
  assert.equal(policy.action, 'continue')
  assert.equal(policy.reason, 'worker_timeout')
  assert.equal(policy.cooldownUntil, null)
})

test('529 stays on the overload column and does not open the unit circuit', () => {
  const policy = classifyUpstreamResult(
    {
      status: 529,
      body: { error: { type: 'overloaded_error', message: 'Overloaded' } },
    },
    { now: 1000 },
  )
  assert.equal(policy.scope, 'provider')
  assert.equal(policy.action, 'continue')
  assert.equal(policy.reason, 'provider_overloaded')
  assert.equal(policy.cooldownUntil, null)
  assert.equal(policy.circuit, undefined)
  assert.equal(policy.decision.action, 'next_unit')
})

test('signature error has one scoped repair', () => {
  const policy = classifyUpstreamResult(
    {
      status: 400,
      body: { error: { message: 'thinking.signature: Field required' } },
    },
    { repaired: false, signatureRepair: true },
  )
  assert.equal(policy.action, 'repair-and-retry')
  const body = repairAnthropicRequest(
    {
      thinking: { type: 'enabled', budget_tokens: 1000 },
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'x' },
            { type: 'text', text: 'keep' },
          ],
        },
      ],
    },
    policy,
  )
  assert.equal(body.thinking, undefined)
  assert.deepEqual(body.messages[0].content, [
    { type: 'text', text: 'x' },
    { type: 'text', text: 'keep' },
  ])
  const second = classifyUpstreamResult(
    {
      status: 400,
      body: { error: { message: 'thinking.signature: Field required' } },
    },
    { repaired: true },
  )
  assert.equal(second.action, 'stop')
})

test('invalid thinking signature converts signed blocks to text', () => {
  const policy = classifyUpstreamResult(
    {
      status: 400,
      body: { error: { message: 'messages.1.content.0: Invalid `signature` in `thinking` block' } },
    },
    { signatureRepair: true },
  )
  assert.equal(policy.action, 'repair-and-retry')
  const body = repairAnthropicRequest(
    {
      thinking: { type: 'adaptive' },
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'draft', signature: 'bad_sig' },
            { type: 'redacted_thinking', data: 'xx', signature: 'also_bad' },
            { type: 'text', text: 'visible' },
          ],
        },
      ],
    },
    policy,
  )
  assert.equal(body.thinking, undefined)
  assert.deepEqual(body.messages[0].content, [
    { type: 'text', text: 'draft' },
    { type: 'text', text: 'visible' },
  ])
})

test('fable 504 cools only the fable family', () => {
  const policy = classifyUpstreamResult(
    {
      status: 504,
      body: { error: { message: 'timeout awaiting response headers' } },
    },
    { model: 'claude-fable-5', now: 1000 },
  )
  assert.equal(policy.scope, 'model')
  assert.equal(policy.model, 'fable')
  assert.equal(policy.reason, 'fable_timeout')
})

test('7d_oi 429 cools fable family not the account', () => {
  const now = 1_700_000_000_000
  const policy = classifyUpstreamResult(
    {
      status: 429,
      body: { error: { type: 'rate_limit_error', message: 'limited' } },
      headers: {
        'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
        'anthropic-ratelimit-unified-7d_oi-reset': String(now + 90_000),
      },
    },
    { model: 'claude-fable-5[1m]', now },
  )
  assert.equal(policy.scope, 'model')
  assert.equal(policy.model, 'fable')
  assert.equal(policy.cooldownUntil, now + 90_000)
})

test('thinking-only verified hop retries the same account', () => {
  const policy = classifyUpstreamResult({
    ok: true,
    status: 200,
    terminalState: 'verified',
    committed: false,
    body: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'plan', signature: 'sig' }],
      stop_reason: null,
    },
  })
  assert.equal(policy.action, 'continue')
  assert.equal(policy.reason, 'incomplete_assistant')
  assert.equal(policy.retrySameAccount, true)
  assert.equal(shouldContinue(policy), true)
})

test('text plus end_turn is success even without ok flag', () => {
  const policy = classifyUpstreamResult({
    ok: true,
    status: 200,
    terminalState: 'verified',
    body: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
    },
  })
  assert.equal(policy.scope, 'success')
  assert.equal(policy.action, 'complete')
})

test('verified text without stop_reason retries instead of succeeding', () => {
  const policy = classifyUpstreamResult({
    ok: true,
    status: 200,
    terminalState: 'verified',
    committed: false,
    body: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'partial' }],
    },
  })
  assert.equal(policy.action, 'continue')
  assert.equal(policy.reason, 'incomplete_assistant')
})

test('non-assistant ok envelope is not classified as success', () => {
  const policy = classifyUpstreamResult({
    ok: true,
    status: 200,
    terminalState: 'verified',
    committed: false,
    body: { output_text: 'assembled text', error: { message: 'original upstream failure' } },
  })
  assert.equal(policy.action, 'continue')
  assert.equal(policy.reason, 'incomplete_assistant')
})

test('200 refusal with empty visible output is content_filter, not success', () => {
  const policy = classifyUpstreamResult({
    ok: true,
    status: 200,
    terminalState: 'verified',
    stopReason: 'refusal',
    body: {
      stop_reason: 'refusal',
      content: [{ type: 'thinking', thinking: 'hidden' }],
      usage: { input_tokens: 7582, output_tokens: 12 },
    },
  })
  assert.equal(policy.scope, 'request')
  assert.equal(policy.action, 'stop')
  assert.equal(policy.reason, 'content_filter_refusal')
})

test('502 pauses the account for one hour and is not a content-filter refusal', () => {
  const before = Date.now()
  const policy = classifyUpstreamResult({
    ok: false,
    status: 502,
    terminalState: 'incomplete',
    body: {
      type: 'error',
      error: {
        type: 'api_error',
        message:
          'provider error: provider error: API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup)',
      },
    },
  })
  assert.equal(policy.action, 'pause')
  assert.equal(policy.reason, 'provider_pause')
  assert.equal(policy.rememberRefusal, true)
  assert.equal(policy.refusalTtlMs, 60 * 60 * 1000)
  assert.ok(policy.cooldownUntil >= before + 60 * 60 * 1000)
  assert.equal(shouldContinue(policy), false)
  assert.notEqual(policy.reason, 'content_filter_refusal')
})

test('assistant prefill 400 is repairable', () => {
  const policy = classifyUpstreamResult({
    status: 400,
    body: { error: { message: 'Conversation must end with a user message' } },
  })
  assert.equal(policy.action, 'repair-and-retry')
  assert.equal(policy.reason, 'prefill_repairable')
  const body = repairAnthropicRequest(
    {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      ],
    },
    policy,
  )
  assert.equal(body.messages.at(-1).role, 'user')
})

test('invalid encrypted_content flattens the replayed search history once', () => {
  const result = {
    status: 400,
    body: { error: { message: 'messages.1.content.0: Invalid `encrypted_content` in `search_result` block' } },
  }
  const policy = classifyUpstreamResult(result)
  assert.equal(policy.action, 'repair-and-retry')
  assert.equal(policy.reason, 'search_repairable')
  const body = repairAnthropicRequest(
    {
      messages: [
        { role: 'user', content: [{ type: 'text', text: '搜索最新公告' }] },
        {
          role: 'assistant',
          content: [
            { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'news' } },
            {
              type: 'web_search_tool_result',
              tool_use_id: 'srvtoolu_1',
              content: [{ type: 'web_search_result', title: 'T', url: 'https://a.co', encrypted_content: 'AAAA' }],
            },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: '继续' }] },
      ],
    },
    policy,
  )
  assert.equal(JSON.stringify(body).includes('encrypted_content'), false)
  assert.equal(
    body.messages[1].content.every((block) => block.type === 'text'),
    true,
  )

  assert.equal(classifyUpstreamResult(result, { repaired: true }).action, 'stop')
})

test('401 with refresh asks for one same-unit refresh instead of permanent revoke', () => {
  const policy = classifyUpstreamResult(
    {
      status: 401,
      body: { error: { message: 'invalid or expired credentials' } },
    },
    { hasRefresh: true, oauth401CooldownMs: 20_000 },
  )
  assert.equal(policy.scope, 'credential')
  assert.equal(policy.action, 'continue')
  assert.equal(policy.reason, 'oauth_refresh_required')
  assert.equal(policy.cooldownUntil, null)
  assert.equal(policy.retrySameAccount, true)
  assert.equal(policy.decision.action, 'retry_same')
  assert.equal(policy.decision.credentialRefreshNeeded, true)
  assert.equal(shouldContinue(policy), true)
})

test('401 revoked message is oauth_revoked', () => {
  const policy = classifyUpstreamResult(
    {
      status: 401,
      body: { error: { message: 'OAuth access token has been revoked' } },
    },
    {
      hasRefresh: true,
      credentialGeneration: 7,
      priorAuth401Generation: 7,
    },
  )
  assert.equal(policy.scope, 'account')
  assert.equal(policy.action, 'continue-and-cooldown')
  assert.equal(policy.reason, 'oauth_revoked')
  assert.equal(shouldContinue(policy), true)
})

test('wrap incomplete 401 with null request_id is not grant death', () => {
  const policy = classifyUpstreamResult(
    {
      ok: false,
      status: 200,
      committed: true,
      terminalState: 'incomplete',
      body: {
        error: {
          type: 'authentication_error',
          code: 'upstream_stream_incomplete',
          message:
            'provider error: provider error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."},"request_id":null} · api_error · upstream_stream_incomplete',
        },
      },
    },
    { hasRefresh: true },
  )
  assert.equal(policy.reason, 'oauth_unconfirmed')
  assert.equal(policy.action, 'stop')
  assert.equal(policy.cooldownUntil, null)
})

test('confirmed 401 revoked still parks the grant', () => {
  const policy = classifyUpstreamResult(
    {
      ok: false,
      status: 401,
      terminalState: 'rejected',
      body: {
        error: {
          type: 'authentication_error',
          message: 'OAuth access token has been revoked.',
          request_id: 'req_live',
        },
      },
    },
    { hasRefresh: true },
  )
  assert.equal(policy.reason, 'oauth_revoked')
  assert.equal(policy.action, 'continue-and-cooldown')
})

test('401 without refresh disables the grant and keeps failover', () => {
  const policy = classifyUpstreamResult(
    {
      status: 401,
      body: { error: { message: 'invalid or expired credentials' } },
    },
    { hasRefresh: false },
  )
  assert.equal(policy.scope, 'account')
  assert.equal(policy.action, 'continue-and-cooldown')
  assert.equal(policy.reason, 'oauth_no_refresh')
  assert.equal(policy.cooldownUntil, Number.MAX_SAFE_INTEGER)
  assert.equal(shouldContinue(policy), true)
})

test('fable 403 is plan denied and does not park the credential', () => {
  const policy = classifyUpstreamResult(
    {
      status: 403,
      body: { error: { type: 'permission_error', message: 'permission denied' } },
    },
    { model: 'claude-fable-5' },
  )
  assert.equal(policy.reason, 'fable_plan_denied')
  assert.equal(policy.action, 'continue')
  assert.equal(policy.mark_tier, 'pro')
  assert.equal(policy.retrySameAccount, false)
  assert.equal(policy.cooldownUntil, null)
  assert.equal(shouldContinue(policy), true)
})

test('non-fable 403 still cools the credential', () => {
  const now = 1_700_000_000_000
  const policy = classifyUpstreamResult(
    {
      status: 403,
      body: { error: { type: 'permission_error', message: 'permission denied' } },
    },
    { model: 'claude-sonnet-5', now, oauth401CooldownMs: 20_000 },
  )
  assert.equal(policy.reason, 'permission_denied')
  assert.equal(policy.action, 'continue-and-cooldown')
  assert.equal(policy.scope, 'credential')
})

test('empty thinking history after repair gets a placeholder', () => {
  const body = repairAnthropicRequest(
    {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: '', signature: 'x' }],
        },
      ],
    },
    { action: 'repair-and-retry' },
  )
  assert.deepEqual(body.messages[0].content, [{ type: 'text', text: '(assistant content removed)' }])
})

const SIGNATURE_400 = {
  status: 400,
  body: {
    error: {
      type: 'invalid_request_error',
      message: 'messages.1.content.0.thinking: The `signature` field is invalid',
    },
  },
}

test('signature 400 is passed through by default', () => {
  const policy = classifyUpstreamResult(SIGNATURE_400, { model: 'claude-sonnet-5' })
  assert.equal(policy.reason, 'invalid_request')
  assert.equal(policy.action, 'stop')
  assert.equal(shouldContinue(policy), false)
})

test('signatureRepair=true repairs and retries the signature 400', () => {
  const policy = classifyUpstreamResult(SIGNATURE_400, {
    model: 'claude-sonnet-5',
    signatureRepair: true,
  })
  assert.equal(policy.reason, 'signature_repairable')
  assert.equal(policy.action, 'repair-and-retry')
})

test('signatureRepair=false passes the upstream signature 400 back to the caller', () => {
  const policy = classifyUpstreamResult(SIGNATURE_400, {
    model: 'claude-sonnet-5',
    signatureRepair: false,
  })
  assert.equal(policy.reason, 'invalid_request')
  assert.equal(policy.action, 'stop')
  assert.equal(shouldContinue(policy), false)
})

test('signatureRepair=false leaves the other 400 repairs alone', () => {
  const policy = classifyUpstreamResult(
    {
      status: 400,
      body: { error: { message: 'Invalid `encrypted_content` in `search_result` block' } },
    },
    { model: 'claude-sonnet-5', signatureRepair: false },
  )
  assert.equal(policy.reason, 'search_repairable')
  assert.equal(policy.action, 'repair-and-retry')
})
