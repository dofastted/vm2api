import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { OFFICIAL_CLAUDE_CLI_UA, OFFICIAL_CLI_VERSION } from '../../src/lib/identity/vm-identity.mjs'
import { computeClaudeCodeFingerprintUtf16 } from '../../src/lib/identity/official-cc-verifier.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { createFailoverMockSchedulerRuntime } from '../helpers/mock-scheduler-runtime.mjs'
import { clearCachePrefixSessions } from '../../src/lib/protocol/cache-prefix.mjs'
import {
  clearConversationCacheTtls,
  listCacheMarkers,
  validateCacheBreakpoints,
} from '../../src/lib/protocol/cache-ttl.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { activateFixture, seedEncryptedPackage } from '../fixtures/crag-license.mjs'

const unixTest = process.platform === 'win32' ? test.skip : test
const control = (ttl) => ({ type: 'ephemeral', ...(ttl ? { ttl } : {}) })
const text = (value, ttl) => ({ type: 'text', text: value, ...(ttl === null ? {} : { cache_control: control(ttl) }) })

const CRAG_V3_HEALTH = Object.freeze({
  ok: true,
  engine: 'rust',
  healthy: true,
  ready_slots: 4,
  runtime_variant: 'crag-v2',
  dataplane: 'crag',
  kernel_version: 'v2',
  transport: 'tui',
  capabilities: [
    'generation_controls_v3',
    'linux_tui_native_queue',
    'prompt_append',
    'prompt_replace',
    'system_text_cache_v3',
    'caller_cwd',
    'provider_managed_tools_v1',
  ],
})

async function runCragHop(t, { compatibility = {}, diskCompatibility = null, input = {}, headers = {} }) {
  clearConversationCacheTtls()
  clearCachePrefixSessions()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-cache-ttl-'))
  const runDir = path.join(root, 'vms', 'vm-crag', 'run')
  const homeDir = path.join(root, 'vms', 'vm-crag', 'cli-home')
  fs.mkdirSync(runDir, { recursive: true })
  fs.mkdirSync(homeDir, { recursive: true })
  const socketPath = path.join(runDir, 'kernel.sock')
  const tokenFile = path.join(runDir, 'internal.token')
  fs.writeFileSync(tokenFile, 'internal-test-token\n', { mode: 0o600 })
  const previousKernelBin = process.env.KIN_KERNEL_BIN
  process.env.KIN_KERNEL_BIN = path.join(root, 'kin-kernel')

  const routing = {
    sticky: { outbound_session: 'passthrough' },
    inference: { engine: 'rust', dataplane: 'crag', crag_kernel_version: 'v2' },
    compatibility: {
      persona_preset: 'official_full',
      crag_persona_preset: 'official_full',
      overlay_preset: 'off',
      cache_ttl: '1h',
      ...compatibility,
    },
  }
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(
    routingFile,
    JSON.stringify(
      diskCompatibility ? { ...routing, compatibility: { ...routing.compatibility, ...diskCompatibility } } : routing,
    ),
  )

  const received = []
  const server = http.createServer(async (req, res) => {
    if (req.url === '/internal/health') {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      res.end(JSON.stringify(CRAG_V3_HEALTH))
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    if (req.url === '/internal/v1/messages') {
      received.push(JSON.parse(raw))
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      const emit = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      emit({
        type: 'message_start',
        message: {
          id: 'msg_crag_ttl',
          type: 'message',
          role: 'assistant',
          model: input.model || 'claude-opus-4-6',
          content: [],
          usage: {
            input_tokens: 100,
            output_tokens: 1,
            cache_creation_input_tokens: 500,
            cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 },
          },
        },
      })
      emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } })
      emit({ type: 'content_block_stop', index: 0 })
      emit({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
      emit({ type: 'message_stop' })
      res.end()
      return
    }
    res.writeHead(404, { 'content-type': 'application/json', connection: 'close' })
    res.end(JSON.stringify({ ok: false }))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  t.after(async () => {
    if (previousKernelBin === undefined) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = previousKernelBin
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  })

  const vm = {
    id: 'vm-crag',
    dataplane: 'crag',
    crag_kernel_version: 'v2',
    persona_preset: 'official_full',
    official_cc_inference: 'cli-hop',
    runtime: {
      kernel_socket: socketPath,
      worker_socket: socketPath,
      worker_run_dir: runDir,
      worker_token_file: tokenFile,
      internal_token: 'internal-test-token',
    },
  }
  seedEncryptedPackage(root)
  activateFixture(root, vm)
  const exec = {
    vmId: vm.id,
    vm,
    homeDir,
    projectRoot: root,
    workerStatus: CRAG_V3_HEALTH,
  }
  const scheduler = {
    async selectAndReserve() {
      return { ok: true, vmId: vm.id, accountId: vm.id, vm, exec, release() {} }
    },
    markSuccess() {},
    markCooldown() {},
    releaseAccountSessions() {},
  }
  const runner = new FailoverRunner({
    scheduler,
    schedulerRuntime: createFailoverMockSchedulerRuntime({ scheduler }),
    config: { max_same_account_retries: 0 },
  })

  const incoming = {
    model: 'claude-opus-4-6',
    max_tokens: 128,
    stream: false,
    messages: [{ role: 'user', content: [text('Hello', undefined)] }],
    ...input,
  }
  const response = { headersSent: false, on() {}, once() {}, off() {}, write() {}, end() {} }
  const handler = createHandleProtocol({
    json(_res, status, body) {
      response.status = status
      response.body = body
      return body
    },
    writeSSEHeaders() {},
    readBody: async () => structuredClone(incoming),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 5000 },
      paths: { data: root, project: root },
    },
    requestLog: { start: () => ({ request_id: 'crag-cache-ttl-fixture' }), finish() {} },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: { ingestHeaders() {} },
    apiKeyStore: { acquire: () => ({ ok: true }), release() {}, recordUsage() {} },
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: routing,
    groupsRepo: { rateMultiplier: () => 1 },
    failoverRunner: runner,
    admitCragInference: () => null,
  })

  await handler.handleProtocol(
    {
      method: 'POST',
      url: '/v1/messages',
      headers: {
        authorization: 'Bearer fixture',
        'user-agent': OFFICIAL_CLAUDE_CLI_UA,
        'x-app': 'cli',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'claude-code-20250219',
        'anthropic-dangerous-direct-browser-access': 'true',
        'x-claude-code-session-id': '11111111-2222-4333-8444-555555555555',
        'x-stainless-lang': 'js',
        'x-stainless-package-version': '0.128.0',
        'x-stainless-os': 'Linux',
        'x-stainless-arch': 'x64',
        'x-stainless-runtime': 'node',
        'x-stainless-runtime-version': 'v26.12.1',
        'x-stainless-retry-count': '0',
        'x-stainless-timeout': '600',
        ...headers,
      },
      apiKeyKind: 'managed',
      apiKeyRecord: { id: 'fixture-key' },
      once() {},
      off() {},
    },
    response,
    'anthropic.messages',
    '/v1/messages',
  )
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.equal(received.length, 1)
  validateCacheBreakpoints(received[0].body)
  return received[0]
}

const officialBilling = (messages) =>
  `x-anthropic-billing-header: cc_version=${OFFICIAL_CLI_VERSION}.${computeClaudeCodeFingerprintUtf16(messages, OFFICIAL_CLI_VERSION)}; cc_entrypoint=sdk-cli; cch=0f0f0;`

const officialBody = (extra = {}) => {
  const messages = extra.messages ?? [{ role: 'user', content: [text('Inspect cache ttl', undefined)] }]
  return {
    system: [
      text(officialBilling(messages), null),
      text("You are Claude Code, Anthropic's official CLI for Claude.", undefined),
      text('Caller project instructions', undefined),
    ],
    metadata: {
      user_id: JSON.stringify({ device_id: 'd'.repeat(64), session_id: '11111111-2222-4333-8444-555555555555' }),
    },
    tools: [{ name: 'Read', input_schema: { type: 'object' }, cache_control: control() }],
    messages,
    ...extra,
  }
}

for (const webTtl of ['1h', '5m']) {
  unixTest(`CRAG V3 fills omitted TTLs from Web compatibility.cache_ttl=${webTtl}`, async (t) => {
    const envelope = await runCragHop(t, {
      compatibility: { cache_ttl: webTtl, official_cc_passthrough: false },
      input: officialBody(),
    })
    assert.equal(envelope.cache_ttl, webTtl)
    assert.equal(envelope.body.cache_ttl, webTtl)
    assert.equal(envelope.preserve_cache_breakpoints, false)
    const markers = listCacheMarkers(envelope.body)
    assert.ok(markers.length >= 2)
    assert.ok(markers.every((m) => m.ttl === webTtl))
  })
}

unixTest('CRAG V3 fills omitted TTLs on <cwd>-projected cragSystem and automatic root cache_control', async (t) => {
  const autoMessages = [{ role: 'user', content: [{ type: 'text', text: 'Auto cached turn' }] }]
  const envelope = await runCragHop(t, {
    compatibility: { cache_ttl: '1h', official_cc_passthrough: false },
    input: officialBody({
      system: [
        text(officialBilling(autoMessages), null),
        text("You are Claude Code, Anthropic's official CLI for Claude.", null),
        text('Caller rules\n<cwd>\n/workspace/app\n</cwd>', undefined),
      ],
      messages: autoMessages,
      cache_control: control(),
    }),
  })
  assert.equal(envelope.caller_cwd, '/workspace/app')
  assert.equal(envelope.preserve_cache_breakpoints, false)
  assert.equal(envelope.cache_ttl, '1h')
  const markers = listCacheMarkers(envelope.body)
  assert.ok(markers.length >= 2)
  assert.ok(markers.every((m) => m.ttl === '1h'))
})

unixTest('CRAG V3 hot-reads compatibility.cache_ttl from routing.json on disk when edited', async (t) => {
  const envelope = await runCragHop(t, {
    compatibility: { cache_ttl: '5m', official_cc_passthrough: false },
    diskCompatibility: { cache_ttl: '1h', official_cc_passthrough: false },
    input: officialBody(),
  })
  assert.equal(envelope.cache_ttl, '1h')
  assert.equal(envelope.body.cache_ttl, '1h')
  assert.ok(listCacheMarkers(envelope.body).every((m) => m.ttl === '1h'))
})

unixTest('CRAG V3 preserves explicit caller 5m and legal 1h -> 5m under Web 1h config', async (t) => {
  const mixed = await runCragHop(t, {
    compatibility: { cache_ttl: '1h', official_cc_passthrough: false },
    input: officialBody({
      tools: [{ name: 'Read', input_schema: { type: 'object' }, cache_control: control('1h') }],
      system: [text('Caller rules', undefined)],
      messages: [{ role: 'user', content: [text('Short tail', '5m')] }],
    }),
  })
  assert.deepEqual(
    listCacheMarkers(mixed.body).map((m) => m.ttl),
    ['1h', '1h', '5m'],
  )

  const shortFirst = await runCragHop(t, {
    compatibility: { cache_ttl: '1h', official_cc_passthrough: false },
    input: officialBody({
      tools: [{ name: 'Read', input_schema: { type: 'object' }, cache_control: control('5m') }],
      system: [text('Caller rules', undefined)],
      messages: [{ role: 'user', content: [text('Omitted after explicit 5m', undefined)] }],
    }),
  })
  assert.ok(listCacheMarkers(shortFirst.body).every((m) => m.ttl === '5m'))
})

unixTest('CRAG V3 keeps omitted caller TTLs untouched when official_cc_passthrough is enabled', async (t) => {
  const passthroughMessages = [{ role: 'user', content: [text('Inspect cache ttl', undefined)] }]
  const envelope = await runCragHop(t, {
    compatibility: { cache_ttl: '1h', official_cc_passthrough: true },
    input: officialBody({
      system: [
        text(officialBilling(passthroughMessages), null),
        text("You are Claude Code, Anthropic's official CLI for Claude.", undefined),
      ],
      messages: passthroughMessages,
    }),
  })
  assert.equal(envelope.preserve_cache_breakpoints, true)
  assert.equal(envelope.body.messages[0].content[0].cache_control.ttl, undefined)
})

unixTest(
  'CRAG V3 envelope cache_ttl respects caller crag_options.cache_ttl when body.cache_ttl is skipped',
  async (t) => {
    const envelope = await runCragHop(t, {
      compatibility: { cache_ttl: '1h', official_cc_passthrough: false },
      input: officialBody({ crag_options: { cache_ttl: '5m' } }),
    })
    assert.equal(envelope.body.cache_ttl, undefined)
    assert.equal(envelope.body.crag_options?.cache_ttl, '5m')
    assert.equal(envelope.cache_ttl, '5m')
  },
)
