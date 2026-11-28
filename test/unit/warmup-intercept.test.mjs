import test from 'node:test'
import assert from 'node:assert/strict'
import { detectWarmupIntercept, formatWarmupSse, warmupMockMessage } from '../../src/lib/protocol/warmup-intercept.mjs'
import { normalizeHealthProbeConfig } from '../../src/lib/admin/health-probe.mjs'

const CC_FULL_HEADERS = {
  'user-agent': 'claude-cli/2.1.321 (external, cli)',
  'x-app': 'cli',
  'anthropic-version': '2023-06-01',
  'anthropic-dangerous-direct-browser-access': 'true',
  'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14',
  'x-stainless-lang': 'js',
  'x-stainless-os': 'Linux',
  'x-stainless-arch': 'x64',
  'x-stainless-runtime': 'node',
  'x-stainless-runtime-version': 'v26.12.1',
  'x-stainless-package-version': '0.128.0',
  'x-stainless-retry-count': '0',
  'x-stainless-timeout': '600',
  'x-claude-code-session-id': '11111111-2222-4333-8444-555555555555',
}
const CC = { officialTraffic: true, headers: CC_FULL_HEADERS }
const text = (t) => [{ type: 'text', text: t }]
const user = (content) => ({ role: 'user', content })

test('V13: Haiku ping with max_tokens=1 requires verified official CC, never bare claude-cli UA', () => {
  const body = { model: 'claude-haiku-4-5', max_tokens: 1, messages: [user(text('quota'))] }
  assert.equal(detectWarmupIntercept(body, CC), 'haiku_ping')
  assert.equal(detectWarmupIntercept(body, { headers: CC_FULL_HEADERS }), 'haiku_ping')
  assert.equal(detectWarmupIntercept(body, { userAgent: 'claude-cli/2.1.281 (external, cli)' }), null)
  assert.equal(detectWarmupIntercept(body, { officialTraffic: false, headers: CC_FULL_HEADERS }), null)
  assert.equal(detectWarmupIntercept(body, { userAgent: 'Go-http-client/1.1' }), null)
  assert.equal(detectWarmupIntercept({ ...body, model: 'claude-sonnet-5' }, CC), null)
})

test('suggestion mode on the last message', () => {
  const body = {
    messages: [user(text('hi')), { role: 'assistant', content: text('x') }, user(text('[SUGGESTION MODE: go]'))],
  }
  assert.equal(detectWarmupIntercept(body), 'suggestion')
})

test('tools prevent Warmup interception but not Haiku pings', () => {
  const body = {
    tools: [{ name: 'Bash' }],
    messages: [user(text('why Warmup?')), { role: 'assistant', content: text('ok') }, user(text('Warmup'))],
  }
  assert.equal(detectWarmupIntercept(body), null)
  assert.equal(detectWarmupIntercept({ ...body, tools: [] }), 'warmup')
  // The Haiku ping check runs before the tools guard.
  assert.equal(
    detectWarmupIntercept(
      { model: 'claude-haiku-4-5', max_tokens: 1, tools: [{ name: 'x' }], messages: [user(text('q'))] },
      CC,
    ),
    'haiku_ping',
  )
})

test('Warmup and title prompts match anywhere in all-array history', () => {
  const body = {
    messages: [
      user(text('why does the gateway answer Warmup?')),
      { role: 'assistant', content: text('ok') },
      user(text('Warmup')),
      { role: 'assistant', content: text('ok') },
      user(text('now refactor handle-protocol.mjs')),
    ],
  }
  assert.equal(detectWarmupIntercept(body), 'warmup')
  assert.equal(
    detectWarmupIntercept({
      messages: [user(text('Please write a 5-10 word title for the following conversation: x'))],
    }),
    'warmup',
  )
  assert.equal(
    detectWarmupIntercept({
      system: [
        { text: 'Analyze if this message indicates a new conversation topic. If it does, extract a 2-3 word title' },
      ],
      messages: [user(text('fix it'))],
    }),
    'warmup',
  )
})

test('string content anywhere bypasses warmup interception', () => {
  const body = {
    messages: [
      user(text('Warmup')),
      { role: 'system', content: 'SessionStart hook additional context' },
      user(text('now refactor')),
    ],
  }
  assert.equal(detectWarmupIntercept(body), null)
  assert.equal(detectWarmupIntercept({ messages: [user('Warmup')] }), null)
  assert.equal(detectWarmupIntercept({ system: 'Warmup', messages: [user(text('Warmup'))] }), null)
})

test('exact Warmup only; no keyword means no parse', () => {
  assert.equal(detectWarmupIntercept({ messages: [user(text(' Warmup'))] }), null)
  assert.equal(detectWarmupIntercept({ messages: [user(text('hello'))] }), null)
})

test('JSON mocks match sendMockInterceptResponse', () => {
  const ping = warmupMockMessage('haiku_ping', 'claude-haiku-4-5')
  assert.equal(ping.content[0].text, '#')
  assert.equal(ping.stop_reason, 'max_tokens')
  assert.equal(ping.stop_details, null)
  assert.deepEqual(ping.usage.cache_creation, { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 })
  assert.match(ping.id, /^msg_01[0-9A-Za-z]{22}$/)
  assert.equal(warmupMockMessage('warmup', 'm').content[0].text, 'New Conversation')
  assert.equal(warmupMockMessage('suggestion', 'm').usage.output_tokens, 1)
})

test('SSE mock matches sendMockInterceptStream, including its haiku branch', () => {
  const parse = (sse) =>
    sse
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)))
  const warm = parse(formatWarmupSse('warmup', 'm'))
  assert.deepEqual(
    warm.map((d) => d.type),
    [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ],
  )
  assert.equal(warm[2].delta.text + warm[3].delta.text, 'New Conversation')
  const ping = parse(formatWarmupSse('haiku_ping', 'claude-haiku-4-5'))
  assert.equal(ping[5].delta.stop_reason, 'end_turn')
  assert.equal(parse(formatWarmupSse('suggestion', 'm'))[2].delta.text, '')
})

test('intercept_warmup defaults on and can be turned off', () => {
  assert.equal(normalizeHealthProbeConfig({}).intercept_warmup, true)
  assert.equal(normalizeHealthProbeConfig({ intercept_warmup: false }).intercept_warmup, false)
})
