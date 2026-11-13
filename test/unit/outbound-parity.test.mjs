import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyCrsUnofficialPersona,
  isOfficialClaudeCodeTraffic,
  CRS_OFFICIAL_SYSTEM,
} from '../../src/lib/identity/crs-persona.mjs'
import { storeAccountHeaders, resolveCrsHeaders } from '../../src/lib/identity/crs-headers.mjs'
import { sanitizeInboundBody, defaultSeedPolicy } from '../../src/lib/protocol/seed-policy.mjs'
import {
  prepareCliHopBody,
  prepareOutboundAttempt,
  prepareOutboundHeaders,
  prepareOutboundEnvelope,
} from '../../src/lib/protocol/outbound-attempt.mjs'
import { CONTEXT_MANAGEMENT_BETA } from '../../src/lib/protocol/anthropic-policy.mjs'
import {
  CLAUDE_CLI_UA,
  claudeCodeInboundBody,
  claudeCodeInboundHeaders,
} from '../../src/lib/protocol/claude-code-inbound.mjs'
import { buildVmTestInbound } from '../../src/lib/admin/vm-test-chat.mjs'
import { classifyClient } from '../../src/lib/protocol/client-fingerprint.mjs'
import { finalizeWorkerPayload } from '../../src/lib/transport/go-worker-client.mjs'

test('CLI hop normalizes markers added after a caller 5m marker', () => {
  const out = prepareCliHopBody(
    {
      model: 'claude-sonnet-5',
      tools: [{ name: 'Read', cache_control: { type: 'ephemeral', ttl: '5m' } }],
      system: [{ type: 'text', text: 'generated', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
      ],
    },
    { personaPreset: 'zero', cacheTtl: '5m' },
  )
  assert.deepEqual(
    [out.tools[0], out.system[0], out.messages[0].content[0]].map((block) => block.cache_control.ttl),
    ['5m', '5m', '5m'],
  )
})
test('saved entrypoint overrides stale slot and caller UAs on both outbound boundaries', () => {
  const body = { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hello' }] }
  const routing = { compatibility: { cc_entrypoint: 'cli' } }
  const identity = { userAgent: 'claude-cli/2.1.321 (external, sdk-cli)' }
  const reqHeaders = { 'user-agent': 'claude-cli/9.9.9 (external, vscode)' }
  for (const slotIdentity of [identity, {}]) {
    for (const entrypoint of ['cli', 'sdk-cli', 'cli']) {
      routing.compatibility.cc_entrypoint = entrypoint
      const envelope = prepareOutboundEnvelope({ canonicalBody: body, identity: slotIdentity, reqHeaders, routing })
      const worker = finalizeWorkerPayload({ body, identity: slotIdentity, reqHeaders, routing })
      for (const outbound of [envelope, worker]) {
        assert.equal(outbound.headers['user-agent'], `claude-cli/2.1.321 (external, ${entrypoint})`)
        assert.equal(outbound.headers['x-stainless-lang'], 'js')
      }
    }
  }
  assert.equal(identity.userAgent, 'claude-cli/2.1.321 (external, sdk-cli)')
})

test('entrypoint selection leaves inference-only credential headers unchanged', () => {
  const body = { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hello' }] }
  for (const credentialMode of ['setup-token', 'official-setup-token', 'apikey']) {
    for (const entrypoint of ['cli', 'sdk-cli']) {
      const routing = { compatibility: { cc_entrypoint: entrypoint } }
      const envelope = prepareOutboundEnvelope({ canonicalBody: body, identity: {}, credentialMode, routing })
      const worker = finalizeWorkerPayload({ body, exec: { vm: { claude: { mode: credentialMode } } }, routing })
      for (const outbound of [envelope, worker]) {
        assert.equal(outbound.headers['user-agent'], 'kin-inference/1.0')
        assert.equal(outbound.headers['x-stainless-lang'], undefined)
      }
    }
  }
})

function fixtureIdentity(homeDir) {
  return {
    vmId: 'vm-01',
    deviceId: 'd'.repeat(64),
    accountUuid: '11111111-1111-4111-8111-111111111111',
    userAgent: CLAUDE_CLI_UA,
    fingerprint: {
      x_app: 'cli',
      stainless_lang: 'js',
      stainless_os: 'Linux',
      stainless_arch: 'x64',
      stainless_runtime: 'node',
      stainless_runtime_version: 'v24.3.0',
      stainless_package_version: '0.112.1',
    },
    homeDir,
  }
}

function seedStoredOfficial(homeDir) {
  storeAccountHeaders(homeDir, {
    'user-agent': CLAUDE_CLI_UA,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20,prompt-caching-scope-2025-01-01',
    'x-app': 'cli',
    'x-stainless-os': 'Linux',
  })
}

test('vm connectivity inbound matches probe Claude Code shape', () => {
  const { inbound, headers } = buildVmTestInbound({
    model: 'claude-haiku-4-5',
    prompt: 'hello',
    maxTokens: 8192,
    sessionId: 'vm-test-vm-01',
  })
  assert.equal(headers['user-agent'], CLAUDE_CLI_UA)
  assert.equal(headers['anthropic-beta'], undefined)
  assert.equal(inbound.system, CRS_OFFICIAL_SYSTEM)
  assert.equal(isOfficialClaudeCodeTraffic(headers, inbound), true)
})

test('spoofed CLI UA + user_id on test14 messages is third-party, not official CC', () => {
  const body = {
    model: 'claude-sonnet-5',
    max_tokens: 1024,
    tools: [{ name: 'get_weather', input_schema: { type: 'object', properties: {} } }],
    tool_choice: { type: 'tool', name: 'get_weather' },
    messages: [{ role: 'user', content: '请查询东京现在的天气，使用摄氏度。' }],
    metadata: { user_id: JSON.stringify({ device_id: 'dev-1', session_id: 'sess-1' }) },
  }
  const headers = { 'user-agent': CLAUDE_CLI_UA }
  assert.equal(isOfficialClaudeCodeTraffic(headers, body), false)
  assert.equal(classifyClient(headers, body), 'third_party_sdk')
})

test('official UA without anthropic-beta does not overwrite stored CLI headers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-store-'))
  seedStoredOfficial(dir)
  const before = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'kin-cc-headers.json'), 'utf8'))
  const skipped = storeAccountHeaders(dir, claudeCodeInboundHeaders({ sessionId: 'x' }))
  assert.equal(skipped.stored, false)
  const after = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'kin-cc-headers.json'), 'utf8'))
  assert.deepEqual(after.headers, before.headers)
  assert.match(String(after.headers['anthropic-beta'] || ''), /oauth-2025-04-20/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('same slot different unofficial UAs share outbound headers except inbound-only noise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-same-'))
  const identity = fixtureIdentity(dir)
  const a = resolveCrsHeaders(
    { 'user-agent': 'Go-http-client/2.0', 'anthropic-beta': 'claude-code-20250219' },
    dir,
    identity,
    'claude-opus-5',
  )
  const b = resolveCrsHeaders(
    { 'user-agent': 'third-party/1.0', 'anthropic-beta': 'oauth-2025-04-20,interleaved-thinking-2025-05-14' },
    dir,
    identity,
    'claude-opus-5',
  )
  assert.equal(a['user-agent'], b['user-agent'])
  assert.equal(a['anthropic-beta'], b['anthropic-beta'])
  assert.equal(a['x-stainless-os'], b['x-stainless-os'])
  assert.match(String(a['anthropic-beta'] || ''), /context-management-2025-06-27/)
  fs.rmSync(dir, { recursive: true, force: true })
})

function thinkingInbound(sessionId) {
  const inbound = claudeCodeInboundBody({
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 8192,
    thinking: { type: 'adaptive' },
    sessionId,
    stream: true,
  })
  const headers = claudeCodeInboundHeaders({ sessionId })
  return { inbound, headers }
}

test('official empty beta default includes context-management and keeps the body field', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ctx-'))
  const identity = fixtureIdentity(dir)
  const { inbound, headers } = thinkingInbound('vm-test-vm-04')
  const raw = prepareOutboundAttempt({
    canonicalBody: inbound,
    inbound,
    identity,
    unofficial: false,
    stream: true,
  })
  assert.equal(raw.body.context_management.edits[0].type, 'clear_thinking_20251015')
  const envelope = prepareOutboundEnvelope({
    canonicalBody: inbound,
    inbound,
    identity,
    unofficial: false,
    stream: true,
    reqHeaders: headers,
    homeDir: dir,
  })
  assert.equal(envelope.body.thinking.type, 'adaptive')
  assert.match(String(envelope.headers['anthropic-beta'] || ''), /context-management-2025-06-27/)
  assert.equal(envelope.body.context_management.edits[0].type, 'clear_thinking_20251015')
  assert.equal(envelope.headers.accept, 'text/event-stream')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('official envelope keeps context_management when stored CLI beta has the token', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ctxkeep-'))
  storeAccountHeaders(dir, {
    'user-agent': CLAUDE_CLI_UA,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': `claude-code-20250219,oauth-2025-04-20,${CONTEXT_MANAGEMENT_BETA}`,
    'x-app': 'cli',
  })
  const identity = fixtureIdentity(dir)
  const { inbound, headers } = thinkingInbound('vm-test-vm-01')
  const envelope = prepareOutboundEnvelope({
    canonicalBody: inbound,
    inbound,
    identity,
    unofficial: false,
    stream: true,
    reqHeaders: headers,
    homeDir: dir,
  })
  assert.match(String(envelope.headers['anthropic-beta'] || ''), /context-management-2025-06-27/)
  assert.equal(envelope.body.context_management.edits[0].type, 'clear_thinking_20251015')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('rewritten vm-test inbound stays official Claude Code, not third-party', () => {
  const identity = fixtureIdentity(os.tmpdir())
  const { inbound, headers } = buildVmTestInbound({
    model: 'claude-haiku-4-5',
    prompt: 'hello',
    maxTokens: 8192,
    sessionId: '11111111-1111-4111-8111-111111111111',
    deviceId: 'd'.repeat(64),
    accountUuid: '11111111-1111-4111-8111-111111111111',
    identity,
    rewrite: true,
  })
  assert.equal(isOfficialClaudeCodeTraffic(headers, inbound), true)
  assert.equal(classifyClient(headers, inbound), 'claude_code_official')
  assert.equal(inbound.system.length, 4)
  assert.equal(inbound.system[0].text, CRS_OFFICIAL_SYSTEM)
  const out = prepareOutboundAttempt({
    canonicalBody: inbound,
    inbound,
    identity,
    unofficial: false,
    officialClient: true,
    sessionId: '11111111-1111-4111-8111-111111111111',
    stream: true,
  })
  assert.equal(out.body.system.length, 4)
  assert.equal(out.body.output_config?.effort, undefined)
  assert.notEqual(out.body.thinking?.type, 'adaptive')
})

test('setup-token outbound is inference-only and drops Claude Code session headers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-setup-token-out-'))
  const identity = fixtureIdentity(dir)
  seedStoredOfficial(dir)
  const inbound = {
    model: 'claude-sonnet-5',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hello' }],
  }
  const env = prepareOutboundEnvelope({
    canonicalBody: inbound,
    inbound,
    identity,
    unofficial: true,
    officialClient: false,
    reqHeaders: { 'user-agent': 'kin-console-test/1.0' },
    homeDir: dir,
    credentialMode: 'setup-token',
  })
  assert.equal(env.headers['user-agent'], 'kin-inference/1.0')
  assert.doesNotMatch(String(env.headers['anthropic-beta'] || ''), /claude-code-20250219/)
  assert.match(String(env.headers['anthropic-beta'] || ''), /oauth-2025-04-20/)
  assert.equal(env.headers['x-claude-code-session-id'], undefined)
  assert.equal(env.headers['x-app'], undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('resolveCrsHeaders unofficial never leaks caller UA', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ua-'))
  const identity = fixtureIdentity(dir)
  const callerUa = 'third-party/1.0'
  const leaked = resolveCrsHeaders(
    {
      'user-agent': callerUa,
      'anthropic-version': '2023-06-01',
    },
    dir,
    identity,
    'claude-sonnet-5',
  )
  assert.notEqual(leaked['user-agent'], callerUa)
  assert.match(leaked['user-agent'], /^claude-cli\//)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('disabled tool-name rewrite still makes duplicate and illegal names unique', () => {
  const out = prepareOutboundAttempt({
    canonicalBody: {
      model: 'claude-opus-4-8',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { name: 'odoo_import_excel', input_schema: { type: 'object' } },
        { name: 'odoo_import_excel', input_schema: { type: 'object' } },
        { name: 'mcp.server/read file', input_schema: { type: 'object' } },
      ],
    },
    identity: {},
    unofficial: true,
    officialClient: false,
    toolNameRewrite: false,
  })
  const names = out.body.tools.map((tool) => tool.name)
  assert.equal(names[0], 'odoo_import_excel')
  assert.match(names[1], /^kin_tool_/)
  assert.match(names[2], /^kin_tool_/)
  assert.equal(new Set(names).size, names.length)
  assert.equal(out.toolNames[names[1]], 'odoo_import_excel')
  assert.equal(out.toolNames[names[2]], 'mcp.server/read file')
})

test('identical server tools are deduped and conflicting names are rejected locally', () => {
  const base = {
    model: 'claude-opus-4-8',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'hi' }],
  }
  const out = prepareOutboundAttempt({
    canonicalBody: {
      ...base,
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 8 },
        { type: 'web_search_20250305', name: 'web_search', max_uses: 8 },
      ],
    },
    identity: {},
    unofficial: true,
    officialClient: false,
  })
  assert.equal(out.body.tools.filter((tool) => tool.name === 'web_search').length, 1)
  assert.throws(
    () =>
      prepareOutboundAttempt({
        canonicalBody: {
          ...base,
          tools: [
            { type: 'web_search_20250305', name: 'web_search', max_uses: 4 },
            { type: 'web_search_20250305', name: 'web_search', max_uses: 8 },
          ],
        },
        identity: {},
        unofficial: true,
        officialClient: false,
      }),
    (error) => error.status === 400 && error.body.error.code === 'invalid_tool_name',
  )
  assert.throws(
    () =>
      prepareOutboundAttempt({
        canonicalBody: {
          ...base,
          tools: [
            { type: 'web_search_20250305', name: 'web_search' },
            { type: 'web_search_20260209', name: 'web_search' },
          ],
        },
        identity: {},
        unofficial: true,
        officialClient: false,
      }),
    (error) => error.status === 400 && error.body.error.code === 'invalid_tool_name',
  )
  assert.throws(
    () =>
      prepareOutboundAttempt({
        canonicalBody: { ...base, tools: [{ type: 'computer_20250124', name: 'bad name' }] },
        identity: {},
        unofficial: true,
        officialClient: false,
      }),
    (error) => error.status === 400 && error.body.error.code === 'invalid_tool_name',
  )
})
