import test from 'node:test'
import assert from 'node:assert/strict'
import { isClaudeCodeFamilyRequest } from '../../src/lib/identity/claude-code-only.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { handleUserCountTokens } from '../../src/lib/protocol/user-count-tokens.mjs'
import { validatePersonaRoutingPatch } from '../../src/lib/admin/panel-api.mjs'
import {
  applyCrsUnofficialPersona,
  isOfficialClaudeCodeTraffic,
  isProxiedOfficialClaudeCode,
} from '../../src/lib/identity/crs-persona.mjs'

const CLI_UA = 'claude-cli/2.1.293 (external, cli)'
const SESSION = '11111111-2222-4333-8444-555555555555'
const USER_ID = JSON.stringify({ device_id: 'd'.repeat(64), session_id: SESSION })
const BILLING = 'x-anthropic-billing-header: cc_version=2.1.293.9; cc_entrypoint=cli; cch=ab;'
// Header set a real 2.1.280 CLI sent on both /v1/messages and count_tokens.
const CLI_HEADERS = {
  'user-agent': CLI_UA,
  'x-app': 'cli',
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14',
  'x-stainless-lang': 'js',
  'x-stainless-runtime': 'node',
  'x-stainless-package-version': '0.112.1',
  'x-claude-code-session-id': SESSION,
}
const OFFICIAL_BODY = {
  model: 'claude-sonnet-5',
  max_tokens: 32000,
  system: [
    { type: 'text', text: BILLING },
    { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
  ],
  metadata: { user_id: USER_ID },
  messages: [{ role: 'user', content: 'hi' }],
}
const THIRD_PARTY_BODY = {
  model: 'claude-sonnet-5',
  max_tokens: 4096,
  system: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: 'hi' }],
}
const ON = { compatibility: { claude_code_only: true } }

const NO_RELAY = { routing: { compatibility: { detect_proxied_official_cc: false } } }

const DESKTOP_HEADERS = {
  ...CLI_HEADERS,
  'user-agent': 'claude-cli/2.1.299 (external, local-agent, agent-sdk/0.3.299)',
  'anthropic-client-platform': 'desktop_app',
  'anthropic-client-version': '2.42304.0',
  'x-stainless-package-version': '0.128.0',
}
const DESKTOP_BODY = {
  ...OFFICIAL_BODY,
  system: [
    { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.299.fa6; cc_entrypoint=local-agent;' },
    { type: 'text', text: "You are Claude Code, built on Anthropic's Claude Agent SDK." },
  ],
}

test('local-agent with desktop markers passes the existing Claude Code checks', () => {
  assert.equal(isClaudeCodeFamilyRequest(DESKTOP_HEADERS, DESKTOP_BODY, NO_RELAY), true)
  assert.equal(isClaudeCodeFamilyRequest(DESKTOP_HEADERS, DESKTOP_BODY), true)
  assert.equal(isOfficialClaudeCodeTraffic(DESKTOP_HEADERS, DESKTOP_BODY), true)
  assert.equal(applyCrsUnofficialPersona(DESKTOP_BODY, { headers: DESKTOP_HEADERS, mode: 'rewrite' }), DESKTOP_BODY)
  assert.equal(isProxiedOfficialClaudeCode(DESKTOP_BODY, DESKTOP_HEADERS), false)
})

test('local-agent still rejects incomplete headers, inconsistent sessions/builds, and OMP', () => {
  for (const key of Object.keys(DESKTOP_HEADERS)) {
    const { [key]: dropped, ...headers } = DESKTOP_HEADERS
    assert.equal(isClaudeCodeFamilyRequest(headers, DESKTOP_BODY), false, key)
  }
  for (const headers of [
    { ...DESKTOP_HEADERS, 'anthropic-client-platform': 'web' },
    { ...DESKTOP_HEADERS, 'anthropic-client-version': 'unknown' },
    { ...DESKTOP_HEADERS, 'user-agent': 'claude-cli/2.1.299 (external, cli)' },
    { ...DESKTOP_HEADERS, 'user-agent': 'claude-cli/2.1.299 (external, local-agent)' },
    { ...DESKTOP_HEADERS, 'user-agent': 'Go-http-client/1.1' },
    { ...DESKTOP_HEADERS, 'x-claude-code-session-id': '99999999-2222-4333-8444-555555555555' },
    { ...DESKTOP_HEADERS, 'user-agent': 'claude-cli/2.1.280 (external, local-agent, agent-sdk/0.3.280)' },
  ]) {
    assert.equal(isClaudeCodeFamilyRequest(headers, DESKTOP_BODY), false)
  }
  assert.equal(isClaudeCodeFamilyRequest(DESKTOP_HEADERS, { ...DESKTOP_BODY, metadata: undefined }), false)
  for (const text of [
    'You are operating in the Oh My Pi coding harness.',
    '<system-conventions>rules</system-conventions>\n<workstation>test</workstation>',
    'ROLE\n====\nAssistant\nPROJECT\n====\nWorkspace',
    'You are operating in the pi coding harness.',
    'You are operating in the omp coding harness.',
  ]) {
    const body = { ...DESKTOP_BODY, system: [...DESKTOP_BODY.system, { type: 'text', text }] }
    assert.equal(isClaudeCodeFamilyRequest(DESKTOP_HEADERS, body), false, text)
    assert.equal(isClaudeCodeFamilyRequest(DESKTOP_HEADERS, body, { countTokens: true }), false, text)
    assert.equal(isOfficialClaudeCodeTraffic(DESKTOP_HEADERS, body), false, text)
  }
  const tools = [{ type: 'function', function: { name: 'read_file' } }]
  assert.equal(isClaudeCodeFamilyRequest(DESKTOP_HEADERS, { ...DESKTOP_BODY, tools }), false)
})

test('local-agent desktop count_tokens follows the existing header-only admission contract', () => {
  const body = { model: DESKTOP_BODY.model, system: DESKTOP_BODY.system, messages: DESKTOP_BODY.messages }
  assert.equal(isClaudeCodeFamilyRequest(DESKTOP_HEADERS, body, { countTokens: true }), true)
  assert.equal(isClaudeCodeFamilyRequest(DESKTOP_HEADERS, body), false)
})

test('Claude Code family recognition needs the full client fingerprint, not the UA', () => {
  assert.equal(isClaudeCodeFamilyRequest(CLI_HEADERS, OFFICIAL_BODY, NO_RELAY), true)
  // UA plus a copied official body is not enough without the client header set.
  assert.equal(isClaudeCodeFamilyRequest({ 'user-agent': CLI_UA }, OFFICIAL_BODY, NO_RELAY), false)
  for (const key of ['x-app', 'anthropic-beta', 'x-stainless-lang', 'x-claude-code-session-id']) {
    const { [key]: _drop, ...partial } = CLI_HEADERS
    assert.equal(isClaudeCodeFamilyRequest(partial, OFFICIAL_BODY, NO_RELAY), false, key)
  }
  assert.equal(isClaudeCodeFamilyRequest(CLI_HEADERS, THIRD_PARTY_BODY), false)
  // Header session and metadata.user_id session come from the same CLI value.
  const otherSession = { ...CLI_HEADERS, 'x-claude-code-session-id': '99999999-2222-4333-8444-555555555555' }
  assert.equal(isClaudeCodeFamilyRequest(otherSession, OFFICIAL_BODY, NO_RELAY), false)
  // Billing cc_version and UA version come from the same build.
  const otherVersion = { ...CLI_HEADERS, 'user-agent': 'claude-cli/2.1.280 (external, cli)' }
  assert.equal(isClaudeCodeFamilyRequest(otherVersion, OFFICIAL_BODY, NO_RELAY), false)
})

test('Claude Code family recognition: relayed traffic follows detect_proxied_official_cc', () => {
  const relayed = { 'user-agent': 'Go-http-client/1.1' }
  assert.equal(isClaudeCodeFamilyRequest(relayed, OFFICIAL_BODY, { routing: {} }), true)
  assert.equal(isClaudeCodeFamilyRequest(relayed, OFFICIAL_BODY, NO_RELAY), false)
  assert.equal(isClaudeCodeFamilyRequest(relayed, THIRD_PARTY_BODY, { routing: {} }), false)
})

// The CLI's quota check (claudeAiLimits `makeTestQuery`): fixed body, its own user_id, no system.
const QUOTA_PROBE = {
  model: 'claude-haiku-4-5',
  max_tokens: 1,
  messages: [{ role: 'user', content: 'quota' }],
  metadata: { user_id: USER_ID },
}

test('Claude Code family recognition: bodiless calls need the header set, not just the UA', () => {
  assert.equal(isClaudeCodeFamilyRequest(CLI_HEADERS, QUOTA_PROBE), true)
  assert.equal(isClaudeCodeFamilyRequest({ 'user-agent': CLI_UA }, QUOTA_PROBE), false)

  const count = { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] }
  assert.equal(isClaudeCodeFamilyRequest(CLI_HEADERS, count, { countTokens: true }), true)
  assert.equal(isClaudeCodeFamilyRequest({ 'user-agent': CLI_UA }, count, { countTokens: true }), false)
  const ohMyPi = { ...count, system: 'x\ncc_entrypoint=local-agent\n' }
  assert.equal(isClaudeCodeFamilyRequest(CLI_HEADERS, ohMyPi, { countTokens: true }), false)
})

test('Claude Code family recognition: max_tokens 1 is not a bypass for arbitrary bodies', () => {
  const strict = { routing: { compatibility: { detect_proxied_official_cc: false } } }
  const bodies = {
    prompt: { ...QUOTA_PROBE, messages: [{ role: 'user', content: 'write me an essay' }] },
    system: { ...QUOTA_PROBE, system: 'You are a helpful assistant.' },
    tools: { ...QUOTA_PROBE, tools: [{ name: 'x', input_schema: { type: 'object' } }] },
    turns: { ...QUOTA_PROBE, messages: [...QUOTA_PROBE.messages, { role: 'assistant', content: 'q' }] },
    noUserId: { ...QUOTA_PROBE, metadata: undefined },
  }
  for (const [name, body] of Object.entries(bodies)) {
    assert.equal(isClaudeCodeFamilyRequest(CLI_HEADERS, body, strict), false, name)
  }
  const otherSession = { ...CLI_HEADERS, 'x-claude-code-session-id': '99999999-2222-4333-8444-555555555555' }
  assert.equal(isClaudeCodeFamilyRequest(otherSession, QUOTA_PROBE, strict), false)
})

const REACHED = new Error('reached-scheduler')

function protocolHarness({ routing, body, healthMonitor }) {
  const response = { headersSent: false, on() {}, once() {}, off() {}, write() {}, end() {} }
  const stats = { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 }
  const handler = createHandleProtocol({
    json: (_res, status, payload) => {
      response.status = status
      response.body = payload
      return payload
    },
    writeSSEHeaders() {},
    readBody: async () => structuredClone(body),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
      paths: {},
    },
    requestLog: { start: () => ({ request_id: 'cc-only-test' }), finish() {} },
    stickyRouter: {},
    accountQuota: {},
    apiKeyStore: { acquire: () => ({ ok: true }), release() {} },
    apiScheduler: {
      pick: () => {
        throw REACHED
      },
    },
    failoverRunner: {
      run: async () => {
        throw REACHED
      },
    },
    apiEndpointStore: {},
    stats,
    getRoutingConfig: () => routing,
    groupsRepo: { rateMultiplier: () => 1 },
    getHealthMonitor: () => healthMonitor,
  })
  return { handler, response }
}

async function runProtocol({
  routing,
  body,
  headers,
  protocol = 'anthropic.messages',
  healthMonitor,
  apiKeyKind = 'managed',
  apiKeyRecord = { category: 'api' },
}) {
  const { handler, response } = protocolHarness({ routing, body, healthMonitor })
  const req = {
    method: 'POST',
    url: '/v1/messages',
    headers:
      apiKeyKind === 'master'
        ? { authorization: 'Bearer master', ...headers }
        : { authorization: 'Bearer sk-vm-api', ...headers },
    apiKeyKind,
    apiKeyRecord: apiKeyKind === 'managed' ? apiKeyRecord : undefined,
    once() {},
    off() {},
  }
  let reached = false
  try {
    await handler.handleProtocol(req, response, protocol, '/v1/messages')
  } catch (error) {
    if (error !== REACHED) throw error
    reached = true
  }
  return { reached, status: response.status, code: response.body?.error?.code }
}

const AXIOS = { 'user-agent': 'axios/1.7' }
const BLOCKED = { reached: false, status: 403, code: 'claude_code_only' }

test('switch on: third-party Claude requests are 403 before any account is picked', async () => {
  assert.deepEqual(await runProtocol({ routing: ON, body: THIRD_PARTY_BODY, headers: AXIOS }), BLOCKED)
  // With relay detection off, a spoofed UA on a copied official body is third-party.
  const strict = { compatibility: { claude_code_only: true, detect_proxied_official_cc: false } }
  const spoofed = await runProtocol({ routing: strict, body: OFFICIAL_BODY, headers: { 'user-agent': CLI_UA } })
  assert.deepEqual(spoofed, BLOCKED)
  // Official Claude Code never uses the OpenAI Chat entry, even with its headers.
  const chat = await runProtocol({ routing: ON, body: OFFICIAL_BODY, headers: CLI_HEADERS, protocol: 'openai.chat' })
  assert.deepEqual(chat, BLOCKED)
})

test('switch on: health probes are refused, never answered from the probe cache', async () => {
  const seen = []
  const healthMonitor = {
    decide: () => {
      seen.push('decide')
      return { action: 'fail', via: 'health-fail', snapshot: {} }
    },
  }
  assert.deepEqual(await runProtocol({ routing: ON, body: THIRD_PARTY_BODY, headers: AXIOS, healthMonitor }), BLOCKED)
  // sub2api's account test carries the CLI banner; even with a full CLI header set it is a probe.
  const accountTest = {
    model: 'claude-sonnet-5',
    max_tokens: 1024,
    temperature: 1,
    system: "You are Claude Code, Anthropic's official CLI for Claude.",
    metadata: { user_id: USER_ID },
    messages: [{ role: 'user', content: 'hi' }],
  }
  assert.equal(isClaudeCodeFamilyRequest(CLI_HEADERS, accountTest), true)
  assert.deepEqual(await runProtocol({ routing: ON, body: accountTest, headers: CLI_HEADERS, healthMonitor }), BLOCKED)
  assert.deepEqual(seen, [])
})

test('switch on: official Claude Code and its own quota probe reach the scheduler', async () => {
  const result = await runProtocol({ routing: ON, body: OFFICIAL_BODY, headers: CLI_HEADERS })
  assert.equal(result.reached, true)
  assert.equal((await runProtocol({ routing: ON, body: QUOTA_PROBE, headers: CLI_HEADERS })).reached, true)
  assert.deepEqual(await runProtocol({ routing: ON, body: QUOTA_PROBE, headers: { 'user-agent': CLI_UA } }), BLOCKED)
  const essay = { ...QUOTA_PROBE, messages: [{ role: 'user', content: 'write me an essay' }] }
  assert.deepEqual(await runProtocol({ routing: ON, body: essay, headers: CLI_HEADERS }), BLOCKED)
})

test('switch on: local-agent desktop reaches the scheduler without relay detection', async () => {
  const routing = { compatibility: { claude_code_only: true, detect_proxied_official_cc: false } }
  assert.equal((await runProtocol({ routing, body: DESKTOP_BODY, headers: DESKTOP_HEADERS })).reached, true)
  const body = { ...DESKTOP_BODY, system: [...DESKTOP_BODY.system, { type: 'text', text: 'Oh My Pi coding harness' }] }
  assert.deepEqual(await runProtocol({ routing, body, headers: DESKTOP_HEADERS }), BLOCKED)
})

test('switch on: master-key pinned panel diagnostics are not inbound clients', async () => {
  const result = await runProtocol({
    routing: ON,
    body: THIRD_PARTY_BODY,
    headers: { ...AXIOS, 'x-kin-vm': 'vm-01' },
    apiKeyKind: 'master',
  })
  assert.equal(result.reached, true)
})

test('switch off: third-party Claude requests are not gated', async () => {
  const result = await runProtocol({ routing: {}, body: THIRD_PARTY_BODY, headers: AXIOS })
  assert.equal(result.reached, true)
})

test('switch on: GPT models are never gated', async () => {
  const result = await runProtocol({
    routing: ON,
    body: { model: 'gpt-5.5', input: 'hi' },
    headers: AXIOS,
    protocol: 'openai.responses',
  }).catch(() => ({ code: null }))
  assert.notEqual(result.code, 'claude_code_only')
})

function countTokensDeps(routing, model) {
  const seen = { peeked: 0 }
  return {
    seen,
    deps: {
      json: (_res, status, body) => {
        seen.status = status
        seen.body = body
      },
      requireAuth: () => true,
      readBody: async () => ({ model, messages: [{ role: 'user', content: 'hi' }] }),
      cfg: { limits: { max_body_bytes: 4096 } },
      stickyRouter: { extractPoolKey: () => null },
      getRoutingConfig: () => routing,
      getPoolScheduler: () => ({
        peekAccount: async () => {
          seen.peeked++
          return { ok: true, vmId: 'vm-01', accountId: 'a', vm: { credential_mode: 'setup-token' }, exec: {} }
        },
      }),
      countTokensViaWorker: async () => ({ ok: true, status: 200, body: { input_tokens: 5 } }),
    },
  }
}

test('count_tokens: switch on blocks third-party Claude, admits the CLI and GPT models', async () => {
  for (const headers of [AXIOS, { 'user-agent': CLI_UA }]) {
    const third = countTokensDeps(ON, 'claude-sonnet-5')
    await handleUserCountTokens({ headers }, {}, third.deps)
    assert.equal(third.seen.status, 403)
    assert.equal(third.seen.body.error.code, 'claude_code_only')
    assert.equal(third.seen.peeked, 0)
  }

  const cli = countTokensDeps(ON, 'claude-sonnet-5')
  await handleUserCountTokens({ headers: CLI_HEADERS }, {}, cli.deps)
  assert.equal(cli.seen.status, 200)

  const gpt = countTokensDeps(ON, 'gpt-5.5')
  await handleUserCountTokens({ headers: AXIOS }, {}, gpt.deps)
  assert.equal(gpt.seen.peeked, 1)
})

test('routing patch rejects a non-boolean claude_code_only', () => {
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { claude_code_only: true } }), [])
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { claude_code_only: 'yes' } }), [
    'claude_code_only 必须是布尔',
  ])
})
