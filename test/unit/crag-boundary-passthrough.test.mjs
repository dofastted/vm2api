import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRespond, extractOfficialResponseHeaders } from '../../src/lib/http/respond.mjs'
import { mapUpstreamError, passthroughUpstreamError, validateRequestBody } from '../../src/lib/core/errors.mjs'
import { cragStrictPassthroughEnabled, cragStrictPassthroughFromRouting } from '../../src/lib/identity/crs-persona.mjs'
import { toClaudeMessages } from '../../src/lib/protocol/convert.mjs'
import {
  CRAG_PROVIDER_HISTORY_BLOCK_TYPES,
  CRAG_PROVIDER_TOOL_NAMES,
  sanitizeCragBodyWhitelist,
  sanitizeCragCacheControl,
} from '../../src/lib/protocol/crag-whitelist.mjs'
import { prepareCragRequest } from '../../src/lib/protocol/kernel-request.mjs'
import { prepareCragPrintBody } from '../../src/lib/protocol/crag-print-prompt.mjs'
import { buildAnthropicSseError, createAnthropicSseErrorRemapper } from '../../src/lib/protocol/stream-truncation.mjs'
import { consumeNativeHandoffStream, createNativeHandoffState } from '../../src/lib/protocol/native-handoff.mjs'
import {
  finalizeWorkerPayload,
  prepareWorkerPayload,
  recoverThinkingOnlyMaxTokens,
  workerEnvelope,
} from '../../src/lib/transport/go-worker-client.mjs'
import { classifyUpstreamResult } from '../../src/lib/pool/upstream-error-policy.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { createFailoverMockSchedulerRuntime } from '../helpers/mock-scheduler-runtime.mjs'
import {
  dropForeignThinkingForCrag,
  inspectForeignThinking,
  thinkingSignatureKey,
} from '../../src/lib/pool/thinking-owner.mjs'
import { createCliNodeGuard, isCliNodeGuardTarget } from '../../src/lib/vm/cli-node-guard.mjs'
import { CRAG_CLAUDE_VERSION } from '../../src/lib/vm/slot-engine.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const V3_CAPS = ['generation_controls_v3', 'linux_tui_native_queue', 'prompt_append', 'prompt_replace', 'caller_cwd']

function makeExec(overrides = {}) {
  return {
    vmId: 'vm-crag-1',
    homeDir: '/tmp/vm-crag-1',
    vm: {
      id: 'vm-crag-1',
      dataplane: 'crag',
      crag_kernel_version: 'v2',
      claude: {},
    },
    workerStatus: {
      ok: true,
      dataplane: 'crag',
      kernel_version: 'v2',
      runtime_variant: 'crag-v2',
      capabilities: V3_CAPS,
    },
    ...overrides,
  }
}

function mockResponse() {
  const state = { status: null, headers: {}, chunks: [], ended: false, req: { headers: {} } }
  return {
    state,
    req: state.req,
    _kinRequestId: 'kin-req-999',
    setHeader(name, value) {
      state.headers[String(name).toLowerCase()] = value
    },
    writeHead(status, headers = {}) {
      state.status = status
      for (const [k, v] of Object.entries(headers)) {
        state.headers[String(k).toLowerCase()] = v
      }
    },
    write(chunk) {
      state.chunks.push(String(chunk))
    },
    end(data) {
      if (data != null) state.chunks.push(String(data))
      state.ended = true
    },
  }
}

function makeAsyncLines(lines) {
  return (async function* () {
    for (const line of lines) {
      yield Buffer.from(`${line}\n`, 'utf8')
    }
  })()
}

// ---------------------------------------------------------------------------
// (a) Rollout toggle defaults to false and preserves legacy default behavior
// ---------------------------------------------------------------------------

test('routing.json defaults crag_strict_passthrough to false and helper gates strictly on officialPassthrough', () => {
  const routing = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/config/routing.json'), 'utf8'))
  assert.equal(routing.compatibility.crag_strict_passthrough, false)
  assert.equal(cragStrictPassthroughFromRouting(routing), false)
  assert.equal(cragStrictPassthroughEnabled(true, routing), false)
  assert.equal(cragStrictPassthroughEnabled(false, { compatibility: { crag_strict_passthrough: true } }), false)
  assert.equal(cragStrictPassthroughEnabled(true, { compatibility: { crag_strict_passthrough: true } }), true)
})

test('crag_strict_passthrough: false preserves legacy CRAG cleaning and 400 auto-repair behavior', () => {
  const routing = {
    compatibility: {
      crag_strict_passthrough: false,
      thinking_display: 'summarized',
      cc_entrypoint: 'cli',
      cache_ttl: '5m',
    },
  }
  const input = {
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    temperature: 0.7,
    top_k: 5,
    thinking: { type: 'adaptive', display: 'omitted' },
    messages: [
      { role: 'user', content: 'first' },
      { role: 'system', content: 'mid-conv system notice' },
      { role: 'user', content: 'second' },
    ],
  }
  const printed = prepareCragPrintBody(input, {
    preset: 'official_full',
    officialPassthrough: true,
    capabilities: V3_CAPS,
    foldSystemMessages: true,
    strictPassthrough: false,
  })
  // Legacy mode folds mid-conversation system turns into user role.
  assert.equal(
    printed.messages.some((m) => m.role === 'system'),
    false,
  )

  const prepared = prepareWorkerPayload({
    body: printed,
    reqHeaders: {},
    exec: makeExec(),
    routing,
    cliHop: true,
    cragPrint: true,
    strictPassthrough: false,
  })
  // Legacy mode aligns sampling with thinking (clamps temperature=1, drops top_k) and rewrites thinking.display.
  assert.equal(prepared.gated.temperature, 1)
  assert.equal('top_k' in prepared.gated, false)
  assert.equal(prepared.gated.thinking.display, 'summarized')

  // Legacy mode classifies HTTP 400 signature errors as repair-and-retry.
  const policy = classifyUpstreamResult(
    {
      ok: false,
      status: 400,
      body: { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid signature in thinking block' } },
    },
    { signatureRepair: true, disableRequestRepair: false },
  )
  assert.equal(policy.action, 'repair-and-retry')
  assert.equal(policy.reason, 'signature_repairable')
})

// ---------------------------------------------------------------------------
// (b) crag_strict_passthrough: true — zero mutations, zero 400 auto-retries,
//     verbatim errors/SSE, nativeOwnsHeaders, and full official header forwarding
// ---------------------------------------------------------------------------

test('crag_strict_passthrough: true performs 0 silent mutations, strips only private keys, and keeps nativeOwnsHeaders=true', async () => {
  const routing = {
    compatibility: {
      crag_strict_passthrough: true,
      thinking_display: 'omitted',
      cc_entrypoint: 'cli',
      min_max_tokens: 4096,
      eager_input_streaming: true,
      cache_ttl: '1h',
    },
  }
  const rawInbound = {
    model: 'claude-sonnet-4-6',
    max_tokens: 16,
    temperature: 0.7,
    thinking: { type: 'adaptive', display: 'updates' },
    safeguards: { mode: 'strict', custom: true },
    output_config: { effort: 'high' },
    future_official_flag: { enabled: true },
    gateway_policy: { tenant: 'secret-drop' },
    request_context: { purpose: 'drop-me' },
    kin_outbound_shape: { version: 2 },
    request_id: 'internal-drop',
    delivery_mode: 'realtime',
    caller_cwd: '/tmp/drop',
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.321.abc; cc_entrypoint=cli; cch=00000;' },
      { type: 'text', text: 'Official prompt', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' } },
    ],
    tools: [
      {
        name: 'custom_tool',
        description: 'Does work',
        input_schema: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
          { type: 'future_block', payload: { k: 1 } },
        ],
      },
      { role: 'system', content: 'mid-conversation system turn', clear_at: 2 },
      { role: 'user', content: 'continue' },
    ],
  }

  // validateRequestBody allows clear_at turns without content as well
  assert.equal(
    validateRequestBody('anthropic.messages', {
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', clear_at: 1 },
      ],
    }).ok,
    true,
  )

  // Ingress conversion fast-path strips only private keys and preserves everything else
  const converted = toClaudeMessages('anthropic.messages', rawInbound, {
    strict_passthrough: true,
    preserve_content_shape: true,
  })
  assert.equal(converted.mode, 'passthrough')
  assert.equal(converted.claude.max_tokens, 16)
  assert.equal(converted.claude.temperature, 0.7)
  assert.deepEqual(converted.claude.future_official_flag, { enabled: true })
  assert.deepEqual(converted.claude.safeguards, { mode: 'strict', custom: true })
  assert.equal(converted.claude.messages[1].role, 'system')
  assert.equal(converted.claude.messages[1].clear_at, 2)
  assert.equal('gateway_policy' in converted.claude, false)
  assert.equal('kin_outbound_shape' in converted.claude, false)

  // prepareCragPrintBody skips folding, automatic cache, safeguards strip, and crag_prompt rewrite
  const printed = prepareCragPrintBody(converted.claude, {
    preset: 'official_full',
    officialPassthrough: true,
    capabilities: V3_CAPS,
    foldSystemMessages: true,
    strictPassthrough: true,
  })
  assert.equal(printed.messages[1].role, 'system')
  assert.equal('crag_prompt' in printed, false)
  assert.deepEqual(printed.safeguards, { mode: 'strict', custom: true })

  // prepareWorkerPayload + finalizeWorkerPayload + workerEnvelope preserve all fields verbatim
  // and keep nativeOwnsHeaders = true (headers === undefined) EVEN on thread / requestContext / repaired
  const preparedWithThread = prepareWorkerPayload({
    body: { ...printed, thread: { id: 'thr_1', parent_message_id: 'msg_1' } },
    reqHeaders: { 'anthropic-beta': 'caller-beta-1' },
    exec: makeExec(),
    routing,
    cliHop: true,
    cragPrint: true,
    requestContext: { purpose: 'auto_mode_classifier' },
    repaired: true,
    strictPassthrough: true,
  })
  assert.equal(preparedWithThread.headers, undefined)
  assert.equal(preparedWithThread.gated.max_tokens, 16)
  assert.equal(preparedWithThread.gated.temperature, 0.7)
  assert.deepEqual(preparedWithThread.gated.thinking, { type: 'adaptive', display: 'updates' })
  assert.equal('eager_input_streaming' in preparedWithThread.gated.tools[0], false)
  assert.equal(preparedWithThread.gated.messages[0].content[1].source.type, 'url')
  assert.equal(preparedWithThread.gated.messages[0].content[2].type, 'future_block')
  assert.equal(preparedWithThread.gated.messages[1].role, 'system')
  assert.equal(preparedWithThread.gated.messages[1].clear_at, 2)
  assert.equal(preparedWithThread.gated.system[0].text.includes('cch=00000;'), true)
  assert.deepEqual(preparedWithThread.gated.future_official_flag, { enabled: true })

  // Omitted thinking stays omitted (ensureOfficialPrintThinking must NOT inject adaptive thinking)
  const { body: sealedNoThinking } = finalizeWorkerPayload({
    body: {
      model: 'claude-sonnet-4-6',
      max_tokens: 16,
      system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.321; cch=00000;' }],
      messages: [{ role: 'user', content: 'hi' }],
    },
    reqHeaders: {},
    exec: makeExec(),
    routing,
    cliHop: true,
    cragPrint: true,
    strictPassthrough: true,
  })
  assert.equal('thinking' in sealedNoThinking, false)
  assert.equal(sealedNoThinking.system[0].text.includes('cch=00000;'), true)

  // workerEnvelope preserves caller cache breakpoints and does not inject default cache_ttl
  const { envelope } = await workerEnvelope({
    body: printed,
    reqHeaders: {},
    exec: makeExec(),
    routing,
    stream: true,
    cliHop: true,
    cragPrint: true,
    strictPassthrough: true,
  })
  assert.equal(envelope.headers, undefined)
  assert.equal(envelope.preserve_cache_breakpoints, true)
  assert.equal(envelope.cache_ttl, null)
})

test('crag_strict_passthrough: true disables all silent 400 auto-repair retries and thinking_incompatible message rewrite', async () => {
  const repairCases = [
    {
      name: 'cache_control_repairable',
      status: 400,
      body: {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'A maximum of 4 blocks with cache_control may be provided' },
      },
    },
    {
      name: 'signature_repairable',
      status: 400,
      body: { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid signature in thinking block' } },
    },
    {
      name: 'search_repairable',
      status: 400,
      body: {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'server_tool_use blocks cannot be sent in history' },
      },
    },
    {
      name: 'prefill_repairable',
      status: 400,
      body: {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'This model does not support assistant message prefill' },
      },
    },
    {
      name: 'tool_pair_repairable',
      status: 400,
      body: {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'unexpected tool_use_id found in tool_result blocks' },
      },
    },
    {
      name: 'schema_repairable',
      status: 400,
      body: {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'tools.0.custom.input_schema: JSON schema is invalid' },
      },
    },
    {
      name: 'sampling_repairable',
      status: 400,
      body: {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'temperature may only be set to 1 when thinking is enabled' },
      },
    },
    {
      name: 'thinking_repairable',
      status: 400,
      body: {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Expected thinking or redacted_thinking, but found text' },
      },
    },
  ]

  for (const tc of repairCases) {
    const policy = classifyUpstreamResult(
      { ok: false, status: tc.status, body: tc.body },
      { signatureRepair: true, disableRequestRepair: true },
    )
    assert.equal(policy.action, 'stop', `${tc.name} must stop instead of repair-and-retry`)
  }

  // End-to-end through FailoverRunner: 1 attempt only, verbatim thinking_incompatible message
  let attempts = 0
  const rawMessage = 'max_tokens must be greater than thinking.budget_tokens (raw upstream)'
  const scheduler = {
    async selectAndReserve() {
      return { ok: true, accountId: 'acc-1', vmId: 'vm-1', exec: makeExec(), vm: { id: 'vm-1' }, release() {} }
    },
    release() {},
    markSuccess() {},
    markCooldown() {},
    markError() {},
  }
  const runner = new FailoverRunner({
    scheduler,
    schedulerRuntime: createFailoverMockSchedulerRuntime({ scheduler }),
    config: { signature_repair: true },
  })
  const result = await runner.run({
    requestId: 'req-strict-400',
    model: 'claude-sonnet-4-6',
    canonicalBody: { model: 'claude-sonnet-4-6', max_tokens: 512, messages: [{ role: 'user', content: 'hi' }] },
    applyAttempt: async (body) => ({
      body,
      meta: { strictPassthrough: true, foreignThinking: true, cliHop: true, cragPrint: true },
    }),
    callAttempt: async () => {
      attempts++
      return {
        ok: false,
        status: 400,
        body: {
          type: 'error',
          error: { type: 'invalid_request_error', message: rawMessage },
          request_id: 'req_01Strict400',
        },
        headers: { 'request-id': 'req_01Strict400' },
        terminalState: 'rejected',
      }
    },
  })
  assert.equal(attempts, 1)
  assert.equal(result.status, 400)
  assert.equal(result.body.error.message, rawMessage)
  assert.equal('code' in result.body.error, false)
})

test('crag_strict_passthrough: true preserves verbatim Anthropic error JSON, >300-char messages, statuses, SSE errors, and V2 providerResult.error', () => {
  const longMessage = 'Exact official Anthropic error detail: ' + 'x'.repeat(420)
  const cases = [
    [400, 'invalid_request_error', 'Input exceeds context window and Usage Policy note: ' + 'y'.repeat(350)],
    [401, 'authentication_error', 'OAuth token has been revoked. ' + longMessage],
    [403, 'permission_error', 'Third-party apps now draw from your extra usage. ' + longMessage],
    [404, 'not_found_error', 'model: claude-nonexistent-9'],
    [413, 'request_too_large', 'Request exceeds maximum size. ' + longMessage],
    [429, 'rate_limit_error', 'Number of request tokens has exceeded your rate limit.'],
    [500, 'api_error', 'Internal server error. ' + longMessage],
    [529, 'overloaded_error', 'Overloaded'],
  ]

  for (const [status, type, message] of cases) {
    const mapped = passthroughUpstreamError(
      status,
      { type: 'error', error: { type, message }, request_id: `req_${status}` },
      { 'request-id': `req_${status}`, 'retry-after': '17' },
    )
    assert.equal(mapped.status, status)
    assert.equal(mapped.body.type, 'error')
    assert.equal(mapped.body.error.type, type)
    assert.equal(mapped.body.error.message, message)
    assert.equal(mapped.body.request_id, `req_${status}`)
    assert.equal(mapped.headers['retry-after'], '17')
  }

  // Gateway-local errors still map via mapUpstreamError
  const poolMapped = passthroughUpstreamError(529, {
    type: 'error',
    error: { type: 'overloaded_error', code: 'pool_overloaded', message: 'busy' },
  })
  const baselinePool = mapUpstreamError(529, {
    type: 'error',
    error: { type: 'overloaded_error', code: 'pool_overloaded', message: 'busy' },
  })
  assert.equal(poolMapped.status, baselinePool.status)
  assert.equal(poolMapped.body.error.code, baselinePool.body.error.code)

  // SSE error remapper preserves started-stream errors verbatim (never rewrites to fake rate_limit_error)
  const remapper = createAnthropicSseErrorRemapper({ strictPassthrough: true, isStarted: () => true })
  const rawSseLine = `data: ${JSON.stringify({
    type: 'error',
    error: { type: 'overloaded_error', message: longMessage },
    request_id: 'req_sse_1',
  })}`
  assert.equal(remapper.remapLine(rawSseLine), rawSseLine)

  // buildAnthropicSseError in strictPassthrough keeps exact type, untruncated message, and top-level request_id
  const sseChunk = buildAnthropicSseError({ type: 'authentication_error', message: longMessage }, null, {
    requestId: 'req_sse_2',
    strictPassthrough: true,
  })
  const parsedSse = JSON.parse(sseChunk.split('\n')[1].slice(6))
  assert.equal(parsedSse.type, 'error')
  assert.equal(parsedSse.error.type, 'authentication_error')
  assert.equal(parsedSse.error.message, longMessage)
  assert.equal(parsedSse.request_id, 'req_sse_2')

  // Native handoff V2 exposes providerResult.error verbatim when strictPassthrough === true
  const handoff = createNativeHandoffState({ nativeHandoff: true, strictPassthrough: true })
  handoff.observeResult({
    type: 'kin_provider_result',
    schema_version: 2,
    source: 'crag',
    provider_complete: false,
    usage_complete: false,
    http_status: 400,
    public_status: 400,
    request_id: 'req_v2_real',
    error: {
      type: 'invalid_request_error',
      message: longMessage,
    },
  })
  assert.equal(handoff.errorBody.type, 'error')
  assert.equal(handoff.errorBody.error.type, 'invalid_request_error')
  assert.equal(handoff.errorBody.error.message, longMessage)
  assert.equal(handoff.errorBody.request_id, 'req_v2_real')

  // recoverThinkingOnlyMaxTokens must NOT fabricate an empty 200 under strictPassthrough
  const thinkingOnlyFailure = {
    ok: false,
    status: 502,
    committed: false,
    terminalState: 'incomplete',
    body: { type: 'error', error: { type: 'api_error', message: 'native request completed without response content' } },
    providerResult: {
      schema_version: 2,
      type: 'kin_provider_result',
      http_status: 200,
      public_status: 502,
      provider_complete: true,
      usage_complete: true,
      response_valid: false,
      delivery_error: { status: 502, type: 'api_error' },
      validation_error: { type: 'api_error', message: 'native request completed without response content' },
      message_id: 'msg_thinking_only_1',
      model: 'claude-sonnet-5',
      stop_reason: 'max_tokens',
      usage: { input_tokens: 100, output_tokens: 64 },
    },
  }
  const notRecovered = recoverThinkingOnlyMaxTokens(thinkingOnlyFailure, { strictPassthrough: true })
  assert.equal(notRecovered, thinkingOnlyFailure)
  assert.equal(notRecovered.ok, false)
  assert.equal(notRecovered.status, 502)
})

test('end-to-end official response header forwarding preserves all 6 exact + 14 unified ratelimit headers on JSON 200, SSE 200, and errors without overwriting gateway headers', async () => {
  const upstreamHeaders = {
    'request-id': 'req_01OfficialAnthropic',
    'retry-after': '42',
    'x-should-retry': 'true',
    'anthropic-organization-id': 'org_01Abc',
    'anthropic-should-fallback': 'true',
    'cf-ray': '9999999999abcdef-SJC',
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-reset': '1795689600',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-fallback': 'available',
    'anthropic-ratelimit-unified-fallback-percentage': '0.25',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-reset': '1795689600',
    'anthropic-ratelimit-unified-5h-utilization': '0.31',
    'anthropic-ratelimit-unified-7d-status': 'allowed',
    'anthropic-ratelimit-unified-7d-reset': '1796294400',
    'anthropic-ratelimit-unified-7d-utilization': '0.18',
    'anthropic-ratelimit-unified-overage-status': 'rejected',
    'anthropic-ratelimit-unified-overage-reset': '1796294400',
    'anthropic-ratelimit-unified-overage-disabled-reason': 'out_of_credits',
    // Must be stripped / never overwrite gateway headers:
    'x-request-id': 'evil-spoof',
    'x-kin-request-id': 'evil-kin-spoof',
    'x-kin-rewrite': 'evil-rewrite',
    'content-type': 'text/plain',
    'set-cookie': 'session=secret',
    'anthropic-ratelimit-unified-injected': 'ok\r\nX-Injected: 1',
  }

  const extracted = extractOfficialResponseHeaders(upstreamHeaders)
  assert.equal(Object.keys(extracted).length, 20)
  assert.equal('x-request-id' in extracted, false)
  assert.equal('x-kin-request-id' in extracted, false)
  assert.equal('set-cookie' in extracted, false)
  assert.equal('anthropic-ratelimit-unified-injected' in extracted, false)

  const respond = createRespond({ rewrite: { enabled: false } })

  // 1. JSON 200
  const jsonRes = mockResponse()
  respond.json(jsonRes, 200, { id: 'msg_1', type: 'message', role: 'assistant', content: [] }, upstreamHeaders)
  assert.equal(jsonRes.state.status, 200)
  assert.equal(jsonRes.state.headers['x-request-id'], 'kin-req-999')
  assert.equal(jsonRes.state.headers['content-type'], 'application/json; charset=utf-8')
  for (const [k, v] of Object.entries(extracted)) {
    assert.equal(jsonRes.state.headers[k], v, `JSON 200 missing header ${k}`)
  }

  // 2. SSE 200
  const sseRes = mockResponse()
  respond.writeSSEHeaders(sseRes, upstreamHeaders)
  assert.equal(sseRes.state.status, 200)
  assert.equal(sseRes.state.headers['x-request-id'], 'kin-req-999')
  assert.equal(sseRes.state.headers['content-type'], 'text/event-stream; charset=utf-8')
  for (const [k, v] of Object.entries(extracted)) {
    assert.equal(sseRes.state.headers[k], v, `SSE 200 missing header ${k}`)
  }

  // 3. HTTP error response
  const errRes = mockResponse()
  respond.json(
    errRes,
    429,
    { type: 'error', error: { type: 'rate_limit_error', message: 'limited' }, request_id: 'req_01OfficialAnthropic' },
    upstreamHeaders,
  )
  assert.equal(errRes.state.status, 429)
  assert.equal(errRes.state.headers['x-request-id'], 'kin-req-999')
  assert.equal(errRes.state.headers['retry-after'], '42')
  assert.equal(errRes.state.headers['anthropic-ratelimit-unified-5h-utilization'], '0.31')

  // 4. consumeNativeHandoffStream forwards merged response_headers into onCommit
  let committedHeaders = null
  const stream = makeAsyncLines([
    'event: response_headers',
    `data: ${JSON.stringify({ type: 'response_headers', headers: { 'request-id': 'req_stream_commit', 'anthropic-ratelimit-unified-status': 'allowed' } })}`,
    '',
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_s1","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    'event: kin_provider_result',
    'data: {"type":"kin_provider_result","schema_version":2,"provider_complete":true,"message_id":"msg_s1","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}',
    '',
  ])
  stream.headers = { 'cf-ray': 'abc-LAX' }
  stream.trailers = {}
  const handoffState = createNativeHandoffState({ nativeHandoff: true })
  await consumeNativeHandoffStream(stream, {
    state: handoffState,
    deliveryMode: 'realtime',
    isCommitEvent: (ev) => ev?.type === 'content_block_delta',
    onCommit: (hdrs) => {
      committedHeaders = hdrs
    },
    onEvent: async () => {},
  })
  assert.equal(committedHeaders['request-id'], 'req_stream_commit')
  assert.equal(committedHeaders['anthropic-ratelimit-unified-status'], 'allowed')
  assert.equal(committedHeaders['cf-ray'], 'abc-LAX')
})

// ---------------------------------------------------------------------------
// (c) Deduplicated passes: single SQLite query + SSOT provider tools / version
// ---------------------------------------------------------------------------

test('thinking-owner CRAG helpers execute at most 1 SQLite ownersOf query and never mutate on inspect', () => {
  const sigOwn = 'sig_own_' + 'a'.repeat(32)
  const sigOther = 'sig_other_' + 'b'.repeat(32)
  const sigUnknown = 'sig_unknown_' + 'c'.repeat(32)
  const keyOwn = thinkingSignatureKey({ type: 'thinking', signature: sigOwn })
  const keyOther = thinkingSignatureKey({ type: 'thinking', signature: sigOther })
  const keyUnknown = thinkingSignatureKey({ type: 'thinking', signature: sigUnknown })
  const body = {
    model: 'claude-sonnet-4-6',
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'a', signature: sigOwn },
          { type: 'thinking', thinking: 'b', signature: sigOther },
          { type: 'thinking', thinking: 'c', signature: sigUnknown },
          { type: 'text', text: 'done' },
        ],
      },
      { role: 'user', content: 'next' },
    ],
  }
  const snapshot = JSON.stringify(body)
  let queries = 0
  const store = {
    ownersOf(keys) {
      queries++
      assert.deepEqual(keys, [keyOwn, keyOther, keyUnknown])
      return new Map([
        [keyOwn, 'acc-1'],
        [keyOther, 'acc-2'],
      ])
    },
  }

  const inspected = inspectForeignThinking(body, 'acc-1', store)
  assert.equal(queries, 1)
  assert.deepEqual(inspected, { kept: 1, foreign: 2, unknown: 1 })
  assert.equal(JSON.stringify(body), snapshot)

  queries = 0
  const dropped = dropForeignThinkingForCrag(body, 'acc-1', store, { mode: 'foreign_only' })
  assert.equal(queries, 1)
  assert.equal(dropped.kept, 1)
  assert.equal(dropped.unknownKept, 1)
  assert.equal(dropped.dropped, 1)
  assert.equal(dropped.foreign, 2)
})

test('SSOT CRAG provider tools include advisor_tool_result and CRAG_CLAUDE_VERSION is unified', () => {
  assert.equal(CRAG_PROVIDER_TOOL_NAMES.get('web_search_20250305'), 'web_search')
  assert.equal(CRAG_PROVIDER_HISTORY_BLOCK_TYPES.has('advisor_tool_result'), true)
  assert.match(CRAG_CLAUDE_VERSION, /^\d+\.\d+\.\d+$/)

  const wrapSrc = fs.readFileSync(path.join(ROOT, 'src/lib/vm/wrap-cli-runtime.mjs'), 'utf8')
  assert.equal(wrapSrc.includes('CRAG_CLAUDE_VERSION'), true)
  assert.equal(wrapSrc.includes('claude-code-2.1.104'), false)

  // sanitizeCragBodyWhitelist supports skip flags for already-normalized tools & safeguards
  const cleaned = sanitizeCragBodyWhitelist(
    {
      model: 'claude-sonnet-4-6',
      tools: [{ name: 't', input_schema: { type: 'object', properties: {} } }],
      messages: [{ role: 'user', content: 'hi' }],
    },
    { toolsNormalized: true, safeguardsSanitized: true },
  )
  assert.equal(cleaned.body.tools[0].name, 't')
})

// ---------------------------------------------------------------------------
// (d) cli-node-guard skips CRAG v2 containers while guarding wrap containers
// ---------------------------------------------------------------------------

test('cli-node-guard skips CRAG v2 containers across dataplane, kernel_installation, runtime_variant, and global routing', async () => {
  const wrapVm = { id: 'vm-wrap', status: 'running', dataplane: 'wrap', runtime: { container_name: 'kin-vm-wrap' } }
  const cragDataplaneVm = {
    id: 'vm-crag-dp',
    status: 'running',
    dataplane: 'crag',
    runtime: { container_name: 'kin-vm-crag-dp' },
  }
  const cragKernelVm = {
    id: 'vm-crag-k',
    status: 'running',
    kernel_installation: { kernel: 'crag' },
    runtime: { container_name: 'kin-vm-crag-k' },
  }
  const cragVariantVm = {
    id: 'vm-crag-v',
    status: 'running',
    runtime: { container_name: 'kin-vm-crag-v', runtime_variant: 'crag-v2' },
  }
  const implicitVm = { id: 'vm-implicit', status: 'running', runtime: { container_name: 'kin-vm-implicit' } }

  assert.equal(isCliNodeGuardTarget(wrapVm, { inference: { dataplane: 'wrap' } }), true)
  assert.equal(isCliNodeGuardTarget(cragDataplaneVm, { inference: { dataplane: 'wrap' } }), false)
  assert.equal(isCliNodeGuardTarget(cragKernelVm, { inference: { dataplane: 'wrap' } }), false)
  assert.equal(isCliNodeGuardTarget(cragVariantVm, { inference: { dataplane: 'wrap' } }), false)
  assert.equal(isCliNodeGuardTarget(implicitVm, { inference: { dataplane: 'crag' } }), false)

  const executedContainers = []
  const guard = createCliNodeGuard({
    listTargets: () => [wrapVm, cragDataplaneVm, cragKernelVm, cragVariantVm],
    getRouting: () => ({ inference: { dataplane: 'wrap' } }),
    hostFor: () => ({ native: false, bakedKernel: false, dockerApi: () => ({ socketPath: '/var/run/docker.sock' }) }),
    exec: async (_connect, container) => {
      executedContainers.push(container)
    },
  })
  await guard.tick()
  assert.deepEqual(executedContainers, ['kin-wrap'])
})

// ---------------------------------------------------------------------------
// (e) 2.1.321 / 5.x safe whitelist fields accepted (even with toggle OFF)
// ---------------------------------------------------------------------------

test('2.1.321 / 5.x fields pass CRAG whitelist cleanly even when crag_strict_passthrough is false', () => {
  assert.deepEqual(
    sanitizeCragCacheControl({
      type: 'ephemeral',
      ttl: '1h',
      scope: 'global',
      evict_on_complete: true,
      unknown_junk: 123,
    }),
    { type: 'ephemeral', ttl: '1h', scope: 'global', evict_on_complete: true },
  )

  const body = {
    model: 'claude-sonnet-5-5',
    thinking: { type: 'between_tools' },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Check docs',
            citations: [
              { type: 'char_location', cited_text: 'abc', document_index: 0, start_char_index: 0, end_char_index: 3 },
            ],
            cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global', evict_on_complete: true },
          },
          {
            type: 'search_result',
            source: 'https://docs.anthropic.com',
            title: 'Messages API',
            content: [{ type: 'text', text: 'Compaction and MCP blocks' }],
            citations: { enabled: true },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'compaction', content: 'summary text', encrypted_content: 'enc_blob_1' },
          { type: 'mcp_tool_use', id: 'mcpt_1', name: 'search', server_name: 'docs', input: { q: 'cache' } },
          {
            type: 'advisor_tool_result',
            tool_use_id: 'srvtoolu_adv_1',
            content: { type: 'advisor_result', text: 'advice' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'mcp_tool_result',
            tool_use_id: 'mcpt_1',
            is_error: false,
            content: [{ type: 'text', text: 'result text' }],
            cache_control: { type: 'ephemeral', ttl: '5m', scope: 'org' },
          },
        ],
      },
    ],
  }

  const cleaned = prepareCragRequest(body, { capabilities: V3_CAPS })
  assert.deepEqual(cleaned.thinking, { type: 'between_tools' })
  assert.deepEqual(cleaned.messages[0].content[0].citations, body.messages[0].content[0].citations)
  assert.deepEqual(cleaned.messages[0].content[0].cache_control, {
    type: 'ephemeral',
    ttl: '1h',
    scope: 'global',
    evict_on_complete: true,
  })
  assert.equal(cleaned.messages[0].content[1].type, 'search_result')
  assert.equal(cleaned.messages[0].content[1].source, 'https://docs.anthropic.com')
  assert.equal(cleaned.messages[1].content[0].type, 'compaction')
  assert.equal(cleaned.messages[1].content[0].encrypted_content, 'enc_blob_1')
  assert.equal(cleaned.messages[1].content[1].type, 'mcp_tool_use')
  assert.equal(cleaned.messages[1].content[1].server_name, 'docs')
  assert.equal(cleaned.messages[1].content[2].type, 'advisor_tool_result')
  assert.equal(cleaned.messages[2].content[0].type, 'mcp_tool_result')
  assert.deepEqual(cleaned.messages[2].content[0].cache_control, { type: 'ephemeral', ttl: '5m', scope: 'org' })
})

test('crag_strict_passthrough: true preserves 2.1.321 fields, mid-conv role:"system" (incl. clear_at), unknown fields/blocks, and forwards allowlisted caller headers', async () => {
  const headlessExec = makeExec({
    workerStatus: {
      ok: true,
      dataplane: 'crag',
      kernel_version: 'v2',
      runtime_variant: 'crag-v2',
      capabilities: ['generation_controls_v3', 'headless_claude_bridge_v1', 'count_tokens_v1'],
    },
  })
  const inbound = {
    model: 'claude-sonnet-5-5',
    max_tokens: 256,
    diagnostics: { previous_message_id: 'msg_prev_9' },
    fallbacks: ['claude-sonnet-4-6'],
    fallback_credit_token: 'fb_strict_1',
    request_tags: ['strict', 'subagent'],
    future_official_extension: { mode: 'v2' },
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.321.111; cc_entrypoint=cli; cch=00000;' },
      { type: 'text', text: 'Official prompt', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' } },
    ],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'first' },
          { type: 'future_content_block', data: 42 },
        ],
      },
      { role: 'system', content: 'keep mid-conv system verbatim', clear_at: 3 },
      { role: 'user', content: 'second' },
    ],
  }
  const { envelope } = await workerEnvelope({
    body: inbound,
    reqHeaders: {
      authorization: 'Bearer secret-token',
      'x-api-key': 'sk-ant-secret',
      'user-agent': 'claude-cli/2.1.321 (external, sdk-cli)',
      'x-app': 'cli',
      'x-client-request-id': 'creq_strict_1',
      'x-claude-code-session-id': 'sess_strict_1',
      'x-claude-code-request-class': 'workflow',
      'x-claude-code-parent-session-id': 'sess_parent_strict',
    },
    exec: headlessExec,
    routing: { compatibility: { crag_strict_passthrough: true } },
    stream: true,
    cliHop: true,
    cragPrint: true,
    strictPassthrough: true,
  })
  assert.deepEqual(envelope.body.diagnostics, inbound.diagnostics)
  assert.deepEqual(envelope.body.fallbacks, inbound.fallbacks)
  assert.equal(envelope.body.fallback_credit_token, 'fb_strict_1')
  assert.deepEqual(envelope.body.request_tags, ['strict', 'subagent'])
  assert.deepEqual(envelope.body.future_official_extension, { mode: 'v2' })
  assert.equal(envelope.body.messages[0].content[1].type, 'future_content_block')
  assert.equal(envelope.body.messages[1].role, 'system')
  assert.equal(envelope.body.messages[1].clear_at, 3)
  assert.deepEqual(envelope.headers, {
    'user-agent': 'claude-cli/2.1.321 (external, sdk-cli)',
    'x-app': 'cli',
    'x-client-request-id': 'creq_strict_1',
    'x-claude-code-session-id': 'sess_strict_1',
    'x-claude-code-request-class': 'workflow',
    'x-claude-code-parent-session-id': 'sess_parent_strict',
  })
})
