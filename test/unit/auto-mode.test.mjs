import test from 'node:test'
import assert from 'node:assert/strict'
import { classifierFixture } from '../fixtures/auto-mode.mjs'
import {
  prepareCliHopBody,
  prepareOutboundAttempt,
  prepareOutboundEnvelope,
} from '../../src/lib/protocol/outbound-attempt.mjs'
import { finalizeWorkerPayload } from '../../src/lib/transport/go-worker-client.mjs'
import {
  classifyClaudeRequestPurpose,
  prepareClassifierBody,
  classifierRequestSummary,
} from '../../src/lib/protocol/request-purpose.mjs'
import { mapUpstreamError } from '../../src/lib/core/errors.mjs'
import { classifyUpstreamResult } from '../../src/lib/pool/upstream-error-policy.mjs'
import { isOfficialClaudeCodeTraffic, isProxiedOfficialClaudeCode } from '../../src/lib/identity/crs-persona.mjs'

const context = { purpose: 'auto_mode_classifier', format: 'xml', stage: 'xml_s1' }
test('classifier assembly retains caller fields across both outbound paths', () => {
  const input = classifierFixture()
  for (const body of [
    prepareCliHopBody(input, { requestContext: context }),
    prepareOutboundAttempt({ canonicalBody: input, identity: {}, requestContext: context }).body,
  ]) {
    assert.deepEqual(body.thinking, input.thinking)
    assert.equal(body.temperature, 1)
    assert.equal(body.max_tokens, 64)
    assert.deepEqual(body.system, input.system)
    assert.deepEqual(body.messages, input.messages)
    assert.deepEqual(body.stop_sequences, input.stop_sequences)
    assert.equal(body.output_config, undefined)
    assert.equal(body.context_management, undefined)
    assert.equal(body.request_context, undefined)
  }
})

test('classifier outbound skips thinking_display rewrite on envelope and worker finalize', () => {
  const input = {
    ...classifierFixture({ model: 'claude-sonnet-5-5' }),
    thinking: { type: 'adaptive', display: 'omitted' },
  }
  const prepared = prepareClassifierBody(input)
  const envelope = prepareOutboundEnvelope({
    requestContext: context,
    canonicalBody: input,
    inbound: input,
    identity: {},
    unofficial: true,
    stream: true,
  })
  assert.equal(envelope.body.thinking.display, 'omitted')
  const exec = { homeDir: '', vm: { claude: { mode: 'setup-token', scope: 'user:inference' } } }
  const worker = finalizeWorkerPayload({
    body: prepared,
    reqHeaders: {},
    exec,
    identity: null,
    requestContext: context,
    cliHop: true,
  })
  assert.equal(worker.body.thinking.display, 'omitted')
})

for (const verdict of ['block', 'severity'])
  for (const stage of ['xml_s1', 'fast', 'xml_s2'])
    test(`recognizes ${verdict} XML ${stage} from the wire contract`, () => {
      const input = classifierFixture({ stage, verdict })
      assert.deepEqual(classifyClaudeRequestPurpose(input, { officialTraffic: true }), {
        purpose: 'auto_mode_classifier',
        format: 'xml',
        stage,
      })
      assert.equal(classifyClaudeRequestPurpose(input), null)
      const withBilling = structuredClone(input)
      withBilling.system.unshift({ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.293;' })
      assert.deepEqual(classifyClaudeRequestPurpose(withBilling, { officialTraffic: true }), {
        purpose: 'auto_mode_classifier',
        format: 'xml',
        stage,
      })
      for (const max_tokens of [64, 256, 8192, 345]) {
        const body = prepareClassifierBody({ ...input, max_tokens })
        assert.equal(body.max_tokens, max_tokens)
        assert.equal(body.temperature, 1)
        assert.deepEqual(body.stop_sequences, input.stop_sequences)
      }
    })

test('#220 severity classifier without billing is official CLI traffic', () => {
  const input = classifierFixture({ verdict: 'severity' })
  input.metadata = { user_id: { device_id: 'fixture-device', session_id: 'fixture-session' } }
  input.system.push({ type: 'text', text: '## Session Context\nCWD: /work' })
  const headers = { 'user-agent': 'claude-cli/2.1.283 (external, cli)' }
  assert.equal(isOfficialClaudeCodeTraffic(headers, input), true)
  assert.deepEqual(classifyClaudeRequestPurpose(input, { officialTraffic: true }), context)
  const body = prepareClassifierBody(input)
  assert.equal(body.max_tokens, 64)
  assert.deepEqual(body.stop_sequences, ['</severity>'])
  assert.deepEqual(body.thinking, { type: 'disabled' })
  assert.deepEqual(body.system, input.system)
})

test('transcript split across user messages is still one classifier request', () => {
  const input = classifierFixture({ verdict: 'severity' })
  input.messages = input.messages[0].content.map((block) => ({ role: 'user', content: [block] }))
  assert.deepEqual(classifyClaudeRequestPurpose(input, { officialTraffic: true }), context)
})

test('legacy classifier requires schema and named choice together', () => {
  const input = classifierFixture({ format: 'tool' })
  assert.deepEqual(classifyClaudeRequestPurpose(input, { officialTraffic: true }), {
    purpose: 'auto_mode_classifier',
    format: 'tool',
  })
  const body = prepareClassifierBody(input)
  assert.deepEqual(body.tools, input.tools)
  assert.deepEqual(body.tool_choice, input.tool_choice)
  delete input.tools[0].input_schema.properties.shouldBlock
  assert.equal(classifyClaudeRequestPurpose(input, { officialTraffic: true }), null)
  const auto = classifierFixture()
  auto.tool_choice = { type: 'auto' }
  assert.equal(classifyClaudeRequestPurpose(auto, { officialTraffic: true }), null)
})

test('recognizes the actual string encoding of WebSearch, WebFetch and JSONL actions', () => {
  for (const action of [
    'WebSearch fixture documentation\n',
    'WebFetch https://example.invalid: read documentation\n',
    '{"WebSearch":"fixture documentation"}\n',
  ]) {
    const input = classifierFixture()
    input.messages[0].content[2].text = action
    assert.deepEqual(classifyClaudeRequestPurpose(input, { officialTraffic: true }), context)
  }
  const input = classifierFixture()
  input.messages[0].content[2].text = '{"user":"search documentation"}\n'
  assert.equal(classifyClaudeRequestPurpose(input, { officialTraffic: true }), null)
})

test('strong classifier rules identify relayed official traffic without billing', () => {
  for (const [format, verdict] of [
    ['xml', 'block'],
    ['xml', 'severity'],
    ['tool', 'block'],
  ]) {
    const input = classifierFixture({ format, verdict })
    input.metadata = { user_id: { device_id: 'fixture-device', session_id: 'fixture-session' } }
    const headers = { 'user-agent': 'Go-http-client/1.1', 'anthropic-beta': 'claude-code-20250219' }
    assert.equal(isProxiedOfficialClaudeCode(input, headers), true)
    assert.equal(
      classifyClaudeRequestPurpose(input, { officialTraffic: isProxiedOfficialClaudeCode(input, headers) }).format,
      format,
    )
    assert.equal(
      isProxiedOfficialClaudeCode(
        { ...input, system: 'You are a security monitor for autonomous AI coding agents.' },
        headers,
      ),
      false,
    )
    assert.equal(isProxiedOfficialClaudeCode(input, { 'x-kin-purpose': 'auto_mode_classifier' }), false)
  }
})

test('phrase, same-name tool, short budget or public context cannot set purpose', () => {
  const missingRules = classifierFixture({ verdict: 'severity' })
  missingRules.system[0].text = missingRules.system[0].text.replace('## HARD BLOCK', '')
  for (const input of [
    { ...classifierFixture(), system: 'You are a security monitor for autonomous AI coding agents.' },
    missingRules,
    { ...classifierFixture(), messages: [{ role: 'user', content: 'WebSearch documentation' }] },
    { ...classifierFixture({ format: 'tool' }), system: 'Use classify_result to summarize search' },
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 64,
      temperature: 1,
      request_context: context,
      messages: [{ role: 'user', content: 'search' }],
    },
  ])
    assert.equal(classifyClaudeRequestPurpose(input, { officialTraffic: true }), null)
})

for (const model of ['claude-sonnet-5', 'claude-sonnet-5-5', 'claude-opus-5.5'])
  test(`${model} XML headroom is bounded and applied once`, () => {
    const input = classifierFixture({ model })
    const body = prepareClassifierBody(input)
    assert.equal(body.max_tokens, 2112)
    assert.deepEqual(body.thinking, { type: 'adaptive' })
    assert.equal(body.temperature, undefined)
    assert.equal(body.output_config, undefined)
    assert.deepEqual(prepareClassifierBody(body), body)
    assert.throws(
      () => prepareClassifierBody({ ...input, max_tokens: 128000 }),
      (e) => e.body.error.code === 'classifier_model_incompatible',
    )
    assert.throws(
      () => prepareClassifierBody(classifierFixture({ model, format: 'tool' })),
      (e) => e.status === 400 && e.body.error.code === 'classifier_model_incompatible',
    )
  })

test('unknown capabilities fail explicitly and never substitute a model', () => {
  assert.throws(
    () => prepareClassifierBody(classifierFixture({ model: 'claude-unknown-test' })),
    /capabilities are unknown/,
  )
})

test('cache anchors and legal mixed TTL are preserved, illegal cache is rejected', () => {
  const input = classifierFixture()
  input.messages[0].content[2].cache_control.ttl = '5m'
  assert.deepEqual(prepareClassifierBody(input).messages, input.messages)
  input.system[0].cache_control.ttl = '5m'
  input.messages[0].content[2].cache_control.ttl = '1h'
  assert.throws(() => prepareClassifierBody(input), /TTL/)
  input.system[0].cache_control.ttl = '1h'
  input.messages[0].content[2].cache_control.ttl = 'bad'
  assert.throws(() => prepareClassifierBody(input), /cache control/)
  input.messages[0].content[2].cache_control.ttl = '1h'
  for (const b of input.messages[0].content) b.cache_control = { type: 'ephemeral', ttl: '1h' }
  assert.throws(() => prepareClassifierBody(input), /four/)
})

test('absent thinking differs from disabled and summaries exclude prompt or credentials', () => {
  const input = classifierFixture()
  delete input.thinking
  const body = prepareClassifierBody(input)
  assert.equal(body.thinking, undefined)
  const summary = classifierRequestSummary(input, body, context)
  assert.equal(summary.before.thinking, 'absent')
  assert.equal(summary.wire_observed, false)
  assert.equal(JSON.stringify(summary).includes('documentation'), false)
})

test('classifier incompatibilities preserve code and remain request scoped', () => {
  for (const code of [
    'classifier_model_incompatible',
    'classifier_runtime_unsupported',
    'invalid_request_context',
    'classifier_invalid_cache',
  ]) {
    const result = {
      status: 400,
      body: { error: { type: 'invalid_request_error', code, message: 'incompatible classifier' } },
    }
    assert.equal(mapUpstreamError(result.status, result.body).body.error.code, code)
    const policy = classifyUpstreamResult(result)
    assert.equal(policy.scope, 'request')
    assert.equal(policy.action, 'stop')
    assert.equal(policy.cooldownUntil, null)
  }
})
