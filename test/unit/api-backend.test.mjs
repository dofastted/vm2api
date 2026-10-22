import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { StickyRouter } from '../../src/lib/pool/sticky-router.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { CRS_OFFICIAL_AGENT_PROMPT } from '../../src/lib/identity/crs-persona.mjs'
import { sessionIdFromOutboundBody } from '../../src/lib/identity/identity-rewrite.mjs'
import { DEFAULT_AGENT_STANDING } from '../../src/lib/identity/persona-template.mjs'
import {
  isOpenAIResponsesCommitEvent,
  resolveInferenceBackend,
  messagesUrl,
  runApiInference,
} from '../../src/lib/pool/api-protocol.mjs'
import { createClaudeMessageAssembler, applyClaudeSSELineToMessage } from '../../src/lib/protocol/convert.mjs'

const unixTest = process.platform === 'win32' ? test.skip : test

function fakeResponse() {
  return { headersSent: false, on() {}, once() {}, off() {}, write() {}, end() {} }
}

function messageStart() {
  return `data: ${JSON.stringify({
    type: 'message_start',
    message: { type: 'message', role: 'assistant', content: [], model: 'upstream-model' },
  })}\n\n`
}

function messageStop() {
  return `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`
}

function completeAnthropicSse(extraEvents = '') {
  return messageStart() + extraEvents + messageStop()
}

test('only a managed key explicitly marked api uses the Anthropic address path', () => {
  assert.equal(resolveInferenceBackend({ apiKeyKind: 'managed', apiKeyRecord: { category: 'api' } }), 'api')
  assert.equal(resolveInferenceBackend({ apiKeyKind: 'managed', apiKeyRecord: { category: ' API ' } }), 'api')
  assert.equal(resolveInferenceBackend({ apiKeyKind: 'managed', apiKeyRecord: { category: 'oauth' } }), 'oauth')
  assert.equal(resolveInferenceBackend({ apiKeyKind: 'managed', apiKeyRecord: {} }), 'oauth')
  assert.equal(resolveInferenceBackend({ apiKeyKind: 'master', headers: { 'x-kin-backend': 'api' } }), 'oauth')
  assert.equal(resolveInferenceBackend({ apiKeyKind: 'master', apiKeyRecord: { category: 'api' } }), 'oauth')
  assert.equal(resolveInferenceBackend({ headers: { 'x-kin-backend': 'api' } }), 'oauth')
})

test('tenant api-category keys cannot reach platform API endpoints', async () => {
  const response = fakeResponse()
  let picked = 0
  const handler = createHandleProtocol({
    json: (_res, status, body) => {
      response.status = status
      response.body = body
      return body
    },
    writeSSEHeaders() {},
    readBody: async () => ({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hello' }] }),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
      paths: { data: os.tmpdir() },
    },
    requestLog: { start: () => ({ request_id: 'api-tenant-test' }), finish() {} },
    stickyRouter: {},
    accountQuota: {},
    apiKeyStore: { acquire: () => ({ ok: true }), release() {}, users: { getById: () => ({ role: 'user' }) } },
    apiScheduler: {
      pick: () => {
        picked += 1
        return { ok: false }
      },
    },
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfig: { failover: {} },
    groupsRepo: { rateMultiplier: () => 1 },
  })
  const req = {
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: 'Bearer sk-vm-tenant', 'user-agent': 'test-client' },
    apiKeyKind: 'managed',
    apiKeyRecord: { category: 'api', user_id: 'u1' },
    once() {},
    off() {},
  }
  await handler.handleProtocol(req, response, 'anthropic.messages', '/v1/messages')
  assert.equal(response.status, 403)
  assert.equal(response.body.error.code, 'api_backend_forbidden')
  assert.equal(picked, 0)
})

test('messagesUrl appends /v1/messages?beta=true', () => {
  assert.equal(messagesUrl('https://api.example.com'), 'https://api.example.com/v1/messages?beta=true')
  assert.equal(messagesUrl('https://api.example.com/'), 'https://api.example.com/v1/messages?beta=true')
})

test('API backend applies the global official_full persona setting', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-api-persona-'))
  const routingFile = path.join(root, 'routing.json')
  const socketPath = path.join(root, 'run', 'api-kernel.sock')
  fs.mkdirSync(path.dirname(socketPath), { recursive: true })
  fs.writeFileSync(
    routingFile,
    JSON.stringify({
      compatibility: {
        persona_preset: 'official_full',
        overlay_preset: 'off',
        agent_standing_presets: { official_full: true },
      },
    }),
  )
  let received = null
  const kernel = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      received = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(completeAnthropicSse())
    })
  })
  await new Promise((resolve, reject) => {
    kernel.once('error', reject)
    kernel.listen(socketPath, resolve)
  })
  const response = fakeResponse()
  const stats = { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 }
  const handler = createHandleProtocol({
    json: (_res, status, body) => {
      response.status = status
      response.body = body
      return body
    },
    writeSSEHeaders() {},
    readBody: async () => ({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hello' }] }),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
      paths: { data: root },
    },
    requestLog: { start: () => ({ request_id: 'api-persona-test' }), finish() {} },
    stickyRouter: {},
    accountQuota: {},
    apiKeyStore: { acquire: () => ({ ok: true }), release() {} },
    apiScheduler: {
      pick: () => ({
        ok: true,
        endpoint: { id: 'ep-test', kind: 'claude', protocol: 'anthropic', base_url: 'https://upstream.invalid' },
        upstream_model: 'claude-haiku-4-5',
        key: { id: 'key-test', api_key: 'secret' },
      }),
    },
    apiEndpointStore: {},
    stats,
    routingConfigPath: routingFile,
    routingConfig: {
      compatibility: {
        persona_preset: 'official_full',
        overlay_preset: 'off',
        agent_standing_presets: { official_full: true },
      },
      failover: {},
    },
    groupsRepo: { rateMultiplier: () => 1 },
  })
  const req = {
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: 'Bearer sk-vm-api', 'user-agent': 'test-client' },
    apiKeyKind: 'managed',
    apiKeyRecord: { category: 'api' },
    once() {},
    off() {},
  }
  try {
    await handler.handleProtocol(req, response, 'anthropic.messages', '/v1/messages')
    assert.equal(response.status, 200)
    assert.ok(received)
    const outbound = JSON.parse(received.body)
    assert.equal(outbound.system.length, 5)
    assert.ok(
      outbound.system.some((block) => String(block.text || '').includes(CRS_OFFICIAL_AGENT_PROMPT.slice(0, 80))),
    )
  } finally {
    await new Promise((resolve) => kernel.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('OAuth cli-hop applies the resolved Protocol custom persona template', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-slot-persona-'))
  const routingFile = path.join(root, 'routing.json')
  const compatibility = {
    persona_preset: 'custom',
    persona_inject: 'rewrite',
    persona_templates: {
      custom: [{ id: 'custom', type: 'text', text: 'CUSTOM_PERSONA {{timezone}}' }],
    },
  }
  fs.writeFileSync(routingFile, JSON.stringify({ compatibility }))
  const vm = { id: 'vm-01', claude: { mode: 'oauth' } }
  const selected = {
    vmId: vm.id,
    accountId: 'account-1',
    vm,
    exec: {
      vmId: vm.id,
      vm,
      homeDir: path.join(root, 'home'),
      oauth: { account_uuid: 'account-1' },
      timezone: 'UTC',
      locale: 'en_US.UTF-8',
    },
  }
  let prepared = null
  const response = fakeResponse()
  const stats = { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 }
  const handler = createHandleProtocol({
    json: (_res, status, body) => {
      response.status = status
      response.body = body
      return body
    },
    writeSSEHeaders() {},
    readBody: async () => ({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hello' }] }),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000, stream_idle_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    requestLog: { start: () => ({ request_id: 'slot-persona-test' }), finish() {} },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: {},
    apiKeyStore: {},
    apiScheduler: {},
    apiEndpointStore: {},
    stats,
    routingConfigPath: routingFile,
    routingConfig: { compatibility, failover: {} },
    failoverRunner: {
      async run(opts) {
        prepared = await opts.applyAttempt(opts.canonicalBody, selected)
        return {
          ok: false,
          status: 503,
          body: { error: { type: 'server_error', code: 'upstream_error', message: 'test stop' } },
          headers: {},
        }
      },
    },
    groupsRepo: { rateMultiplier: () => 1 },
  })
  const req = {
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: 'Bearer master', 'user-agent': 'Go-http-client/2.0' },
    apiKeyKind: 'master',
    once() {},
    off() {},
  }

  try {
    await handler.handleProtocol(req, response, 'anthropic.messages', '/v1/messages')
    assert.equal(response.status, 503)
    assert.ok(prepared?.body)
    assert.equal(prepared.body.system.length, 3)
    assert.ok(prepared.body.system.some((block) => String(block.text || '').includes('CUSTOM_PERSONA UTC')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('logs the session id actually sent upstream, not the caller one', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-outbound-session-'))
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify({ compatibility: {} }))
  const vm = { id: 'vm-01', claude: { mode: 'oauth' } }
  const selected = {
    vmId: vm.id,
    accountId: 'account-1',
    vm,
    exec: { vmId: vm.id, vm, homeDir: path.join(root, 'home'), oauth: { account_uuid: 'account-1' } },
  }
  let prepared = null
  let logged = null
  const response = { ...fakeResponse(), on: (event, fn) => event === 'finish' && (response.finish = fn) }
  const handler = createHandleProtocol({
    json: (_res, status, body) => {
      response.status = status
      return body
    },
    writeSSEHeaders() {},
    readBody: async () => ({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'hello' }],
      metadata: { user_id: JSON.stringify({ device_id: 'caller-dev', session_id: 'caller-sess' }) },
    }),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000, stream_idle_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    requestLog: {
      start: () => ({ request_id: 'outbound-session-test', mode: 'normal' }),
      finish: (_ctx, extra) => {
        logged = extra
      },
    },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: {},
    apiKeyStore: {},
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: { compatibility: {}, failover: {} },
    failoverRunner: {
      async run(opts) {
        prepared = await opts.applyAttempt(opts.canonicalBody, selected)
        return { ok: false, status: 503, body: { error: { type: 'server_error', code: 'x', message: 'stop' } } }
      },
    },
    groupsRepo: { rateMultiplier: () => 1 },
  })
  const req = {
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: 'Bearer master', 'user-agent': 'claude-cli/2.1.241 (external, cli)' },
    apiKeyKind: 'master',
    once() {},
    off() {},
  }
  try {
    await handler.handleProtocol(req, response, 'anthropic.messages', '/v1/messages')
    response.finish?.()
    const sent = sessionIdFromOutboundBody(prepared.body) || prepared.meta.sessionId
    assert.ok(sent)
    assert.equal(logged.session_id, 'caller-sess')
    assert.equal(logged.outbound_session_id, sent)
    assert.notEqual(logged.outbound_session_id, 'caller-sess')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

for (const previousVm of [null, 'vm-01']) {
  test(`queued OAuth turns reuse the outbound session ${previousVm ? 'after a VM move' : 'on first bind'}`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-queued-session-'))
    const routingFile = path.join(root, 'routing.json')
    fs.writeFileSync(routingFile, JSON.stringify({ compatibility: {} }))
    const sticky = new StickyRouter({ dataDir: path.join(root, 'data'), config: { sticky: { enabled: true } } })
    const key = sticky.canonicalSessionKey('queued-caller')
    if (previousVm) {
      sticky.bind(key, { accountId: 'account-1', vmId: previousVm, sessionId: 'previous-outbound' })
    }
    const vm = { id: 'vm-02', claude: { mode: 'oauth' } }
    const selected = {
      ok: true,
      vmId: vm.id,
      accountId: 'account-1',
      vm,
      exec: { vmId: vm.id, vm, homeDir: path.join(root, 'home'), oauth: { account_uuid: 'account-1' } },
    }
    const runner = new FailoverRunner({
      scheduler: { selectAndReserve: async () => selected, markSuccess() {} },
      stickyRouter: sticky,
    })
    let releaseFirst
    let enteredFirst
    let enteredSecond
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve
    })
    const firstReady = new Promise((resolve) => {
      enteredFirst = resolve
    })
    const secondReady = new Promise((resolve) => {
      enteredSecond = resolve
    })
    t.after(() => {
      releaseFirst()
      sticky.db.close()
      fs.rmSync(root, { recursive: true, force: true })
    })
    const sent = []
    const logged = []
    let runs = 0
    let requests = 0
    const handler = createHandleProtocol({
      json: (res, status, body) => {
        res.status = status
        return body
      },
      writeSSEHeaders() {},
      readBody: async () => ({
        model: 'claude-haiku-4-5',
        stream: false,
        max_tokens: 32,
        messages: [
          { role: 'user', content: 'Continue this diagnostic conversation with the same device and session.' },
        ],
        metadata: { user_id: JSON.stringify({ device_id: 'queued-device', session_id: 'queued-caller' }) },
      }),
      requireAuth: () => true,
      cfg: {
        rewrite: { enabled: false },
        intercept: { rules: [] },
        distill: { enabled: false },
        limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000, stream_idle_timeout_ms: 2000 },
        paths: { data: path.join(root, 'data'), project: root },
      },
      requestLog: {
        start: () => ({ request_id: `queued-${++requests}`, mode: 'normal', t0: Date.now() }),
        finish: (_ctx, extra) => logged.push(extra.outbound_session_id),
      },
      stickyRouter: sticky,
      accountQuota: {},
      apiKeyStore: {},
      apiScheduler: {},
      apiEndpointStore: {},
      stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
      routingConfigPath: routingFile,
      routingConfig: { compatibility: {}, failover: {} },
      groupsRepo: { rateMultiplier: () => 1 },
      failoverRunner: {
        async run(opts) {
          const index = ++runs
          if (index === 2) enteredSecond()
          return runner.run({
            ...opts,
            applyAttempt: async (body, candidate, extra) => {
              if (index === 1) {
                enteredFirst()
                await firstGate
              }
              return opts.applyAttempt(body, candidate, { ...extra, attemptStartedAt: index * 1000 })
            },
            callAttempt: async ({ body }) => {
              sent.push(sessionIdFromOutboundBody(body))
              return {
                ok: true,
                status: 200,
                terminalState: 'verified',
                body: {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'text', text: 'continued' }],
                  stop_reason: 'end_turn',
                },
              }
            },
          })
        },
      },
    })
    async function invoke() {
      const res = {
        ...fakeResponse(),
        on: (event, fn) => {
          if (event === 'finish') res.finish = fn
        },
      }
      const req = {
        method: 'POST',
        url: '/v1/messages',
        headers: { authorization: 'Bearer master', 'user-agent': 'claude-cli/2.1.293 (external, cli)' },
        apiKeyKind: 'master',
        once() {},
        off() {},
      }
      await handler.handleProtocol(req, res, 'anthropic.messages', '/v1/messages')
      res.finish?.()
      assert.equal(res.status, 200)
    }
    const first = invoke()
    await firstReady
    const second = invoke()
    await secondReady
    releaseFirst()
    await Promise.all([first, second])
    await invoke()
    assert.notEqual(sent[0], 'queued-caller')
    assert.notEqual(sent[0], 'previous-outbound')
    assert.deepEqual(sent, [sent[0], sent[0], sent[0]])
    assert.deepEqual(logged, [sent[0], sent[0], sent[0]])
    assert.equal(sticky.resolve(key).sessionId, sent[0])
    assert.equal(sticky.resolve(key).vmId, vm.id)
  })
}

async function runManagedKeyHop(root, result) {
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify({ compatibility: {} }))
  const vm = { id: 'vm-01', claude: { mode: 'oauth' } }
  const selected = {
    vmId: vm.id,
    accountId: 'account-1',
    vm,
    exec: { vmId: vm.id, vm, homeDir: path.join(root, 'home'), oauth: { account_uuid: 'account-1' } },
  }
  const charges = []
  const logged = []
  const response = { ...fakeResponse(), on: (event, fn) => event === 'finish' && (response.finish = fn) }
  const handler = createHandleProtocol({
    json: (_res, status, body) => {
      response.status = status
      return body
    },
    writeSSEHeaders() {},
    readBody: async () => ({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hello' }] }),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000, stream_idle_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    requestLog: { start: () => ({ request_id: 'key-billing', mode: 'normal' }), finish: (_c, row) => logged.push(row) },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: { ingestHeaders() {} },
    apiKeyStore: {
      acquire: () => ({ ok: true }),
      release() {},
      recordUsage: (key, usage, opts) => charges.push({ key, usage, opts }),
    },
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: { compatibility: {}, failover: {} },
    failoverRunner: {
      async run(opts) {
        await opts.applyAttempt(opts.canonicalBody, selected)
        return result
      },
    },
    groupsRepo: { rateMultiplier: () => 2 },
  })
  const req = {
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: 'Bearer sk-vm-x', 'user-agent': 'claude-cli/2.1.241 (external, cli)' },
    apiKeyKind: 'managed',
    apiKeyRecord: { id: 'key-1', group_id: 1 },
    once() {},
    off() {},
  }
  await handler.handleProtocol(req, response, 'anthropic.messages', '/v1/messages')
  response.finish?.()
  return { charges, logged }
}

test('a managed key is charged exactly once for a hop billed inline', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-key-inline-'))
  try {
    const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000 }
    const { charges, logged } = await runManagedKeyHop(root, {
      ok: false,
      status: 503,
      accountId: 'account-1',
      usage,
      body: { error: { type: 'server_error', code: 'x', message: 'stop' } },
    })
    assert.equal(charges.length, 1)
    assert.equal(charges[0].opts.rateMultiplier, 2)
    assert.equal(charges[0].opts.officialCost, logged[0].total_cost)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('native mixed TTL usage is billed from upstream buckets rather than the panel default', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-key-mixed-cache-'))
  try {
    const usage = {
      input_tokens: 1000,
      output_tokens: 200,
      cache_creation_input_tokens: 400,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 300 },
    }
    const { charges, logged } = await runManagedKeyHop(root, {
      ok: false,
      status: 503,
      accountId: 'account-1',
      usage,
      body: { error: { type: 'server_error', code: 'x', message: 'stop' } },
    })
    assert.deepEqual(logged[0].usage.cache_creation, usage.cache_creation)
    assert.deepEqual(charges[0].usage.cache_creation, usage.cache_creation)
    // Haiku 4.5 writes: 100 × $1.25/M + 300 × $2/M, not 400 × $2/M.
    assert.ok(Math.abs(logged[0].cache_creation_cost - 0.000725) < 1e-12)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('OpenAI chat carrying claude-opus-4-8 uses the Claude pool', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-opus-platform-'))
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify({ compatibility: { persona_preset: 'zero' } }))
  let poolCalls = 0
  let requestedModel = null
  const response = fakeResponse()
  const handler = createHandleProtocol({
    json: (_res, status, body) => {
      response.status = status
      response.body = body
      return body
    },
    writeSSEHeaders() {},
    readBody: async () => ({
      model: 'claude-opus-4-8',
      stream: false,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hello' }],
    }),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000, stream_idle_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    requestLog: { start: () => ({ request_id: 'opus-platform-test' }), finish() {} },
    stickyRouter: { extractPoolKey: () => 'opus-session', collectPoolKeys: () => ['opus-session'] },
    accountQuota: {},
    apiKeyStore: {},
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: { compatibility: { persona_preset: 'zero' }, failover: {} },
    failoverRunner: {
      async run(opts) {
        poolCalls += 1
        requestedModel = opts.model
        return {
          ok: false,
          status: 503,
          body: { error: { type: 'server_error', code: 'pool_probe', message: 'Claude pool selected' } },
          headers: {},
        }
      },
    },
    groupsRepo: { rateMultiplier: () => 1 },
  })
  const req = {
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: 'Bearer master', 'user-agent': 'OpenAI/Node' },
    apiKeyKind: 'master',
    once() {},
    off() {},
  }

  try {
    await handler.handleProtocol(req, response, 'openai.chat', '/v1/chat/completions')
    assert.equal(poolCalls, 1)
    assert.equal(requestedModel, 'claude-opus-4-8')
    assert.equal(response.status, 503)
    assert.equal(response.body.error.message, 'Claude pool selected')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function companionHaikuBody(sessionId, deviceId = 'device-probe') {
  return {
    model: 'claude-haiku-4-5',
    stream: false,
    max_tokens: 64,
    tools: [],
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.280.e2f; cch=test' },
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
    ],
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Compress into one routing hint of at most 12 words: WHEN to use; WHEN NOT' }],
      },
    ],
    metadata: { user_id: JSON.stringify({ device_id: deviceId, session_id: sessionId }) },
  }
}

function protocolHarness({ body, stickyRouter, failoverRunner, apiKeyRecord = null, headers = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-protocol-seat-'))
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify({ compatibility: { persona_preset: 'zero' } }))
  const response = fakeResponse()
  const stats = { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 }
  const apiKeyCalls = { acquire: 0, release: 0 }
  const authCalls = { count: 0 }
  const handler = createHandleProtocol({
    json: (_res, status, payload) => {
      response.status = status
      response.body = payload
      return payload
    },
    writeSSEHeaders() {},
    readBody: async () => body,
    requireAuth: () => {
      authCalls.count += 1
      return true
    },
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000, stream_idle_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    requestLog: { start: () => ({ request_id: 'seat-probe-test' }), finish() {} },
    stickyRouter,
    accountQuota: {},
    apiKeyStore: {
      acquire: () => {
        apiKeyCalls.acquire += 1
        return { ok: true }
      },
      release: () => {
        apiKeyCalls.release += 1
      },
    },
    apiScheduler: {},
    apiEndpointStore: {},
    stats,
    routingConfigPath: routingFile,
    routingConfig: { compatibility: { persona_preset: 'zero' }, failover: {} },
    failoverRunner,
    groupsRepo: { rateMultiplier: () => 1 },
  })
  const req = {
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: 'Bearer test', 'user-agent': 'Go-http-client/2.0', ...headers },
    apiKeyKind: apiKeyRecord ? 'managed' : 'master',
    apiKeyRecord,
    once() {},
    off() {},
  }
  return { root, handler, req, response, stats, apiKeyCalls, authCalls }
}

test('companion Haiku probe clears session sticky and skips session seat', async () => {
  let runOpts = null
  const stickyCalls = { extract: 0, collect: 0, device: 0 }
  const stickyRouter = {
    extractPoolKey: () => {
      stickyCalls.extract += 1
      return 'session-key'
    },
    collectPoolKeys: () => {
      stickyCalls.collect += 1
      return ['session-key']
    },
    canonicalDeviceKey: (deviceId) => {
      stickyCalls.device += 1
      return `dev2:${deviceId}`
    },
  }
  const harness = protocolHarness({
    body: companionHaikuBody('probe-session', 'probe-device'),
    stickyRouter,
    apiKeyRecord: { id: 'managed-key-1', group_id: 1 },
    failoverRunner: {
      async run(opts) {
        runOpts = opts
        return {
          ok: false,
          status: 503,
          body: { error: { type: 'server_error', code: 'probe_stop', message: 'stop' } },
          headers: {},
        }
      },
    },
  })
  try {
    await harness.handler.handleProtocol(harness.req, harness.response, 'anthropic.messages', '/v1/messages')
    assert.equal(harness.authCalls.count, 1)
    assert.equal(harness.apiKeyCalls.acquire, 1)
    assert.equal(harness.apiKeyCalls.release, 1)
    assert.equal(stickyCalls.extract, 1)
    assert.equal(stickyCalls.collect, 1)
    assert.equal(stickyCalls.device, 1)
    assert.equal(runOpts.stickyKey, null)
    assert.deepEqual(runOpts.stickyKeys, [])
    assert.equal(runOpts.skipSessionSeat, true)
    assert.equal(runOpts.stickyDeviceId, 'probe-device')
    assert.equal(runOpts.deviceKey, 'dev2:probe-device')
    assert.equal(harness.response.status, 503)
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true })
  }
})

test('ordinary Haiku with tools keeps session sticky and session seat', async () => {
  let runOpts = null
  const body = {
    ...companionHaikuBody('normal-session', 'normal-device'),
    tools: [{ name: 'Read', input_schema: { type: 'object', properties: {} } }],
  }
  const harness = protocolHarness({
    body,
    stickyRouter: {
      extractPoolKey: () => 'normal-sticky',
      collectPoolKeys: () => ['normal-sticky'],
      canonicalDeviceKey: (deviceId) => `dev2:${deviceId}`,
    },
    failoverRunner: {
      async run(opts) {
        runOpts = opts
        return {
          ok: false,
          status: 503,
          body: { error: { type: 'server_error', code: 'normal_stop', message: 'stop' } },
          headers: {},
        }
      },
    },
  })
  try {
    await harness.handler.handleProtocol(harness.req, harness.response, 'anthropic.messages', '/v1/messages')
    assert.equal(runOpts.stickyKey, 'normal-sticky')
    assert.deepEqual(runOpts.stickyKeys, ['normal-sticky'])
    assert.equal(runOpts.skipSessionSeat, false)
    assert.equal(runOpts.deviceKey, 'dev2:normal-device')
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true })
  }
})

async function captureRunOpts({ body, stickyRouter, apiKeyRecord, headers }) {
  let runOpts = null
  const harness = protocolHarness({
    body,
    stickyRouter,
    apiKeyRecord,
    headers,
    failoverRunner: {
      async run(opts) {
        runOpts = opts
        return {
          ok: false,
          status: 503,
          body: { error: { type: 'server_error', code: 'identity_stop', message: 'stop' } },
          headers: {},
        }
      },
    },
  })
  try {
    await harness.handler.handleProtocol(harness.req, harness.response, 'anthropic.messages', '/v1/messages')
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true })
  }
  return runOpts
}

function sessionBody(userId, extra = {}) {
  return {
    model: 'claude-sonnet-4-5',
    stream: false,
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hello' }],
    metadata: { user_id: typeof userId === 'string' ? userId : JSON.stringify(userId) },
    ...extra,
  }
}

function realStickyRouter() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-identity-sticky-'))
  return { dir, router: new StickyRouter({ dataDir: dir, config: { sticky: { enabled: true, ttl_seconds: 600 } } }) }
}

test('inbound session and device keys match across API keys at the protocol entry', async () => {
  const { dir, router } = realStickyRouter()
  try {
    const body = sessionBody({ device_id: 'dev-cross', account_uuid: 'acct-a', session_id: 'sess-cross' })
    const a = await captureRunOpts({ body, stickyRouter: router, apiKeyRecord: { id: 'key-a', group_id: 1 } })
    const b = await captureRunOpts({
      body: sessionBody({ device_id: 'dev-cross', account_uuid: 'acct-b', session_id: 'sess-cross' }),
      stickyRouter: router,
      apiKeyRecord: { id: 'key-b', group_id: 1 },
    })
    assert.equal(a.stickyKey, 'sess:sess-cross')
    assert.equal(b.stickyKey, a.stickyKey)
    assert.deepEqual(b.stickyKeys, [a.stickyKey])
    assert.equal(a.deviceKey, 'dev2:dev-cross')
    assert.equal(b.deviceKey, a.deviceKey)
    for (const opts of [a, b]) {
      for (const key of [opts.stickyKey, ...opts.stickyKeys, opts.deviceKey, opts.familyKey]) {
        assert.doesNotMatch(String(key), /key-a|key-b|^k|:k/)
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the protocol entry hands the device seat key to the pool, independent of the API key', async () => {
  const { dir, router } = realStickyRouter()
  try {
    const turn = {
      messages: [{ role: 'user', content: 'please refactor the scheduler module and explain every single change' }],
    }
    const a = await captureRunOpts({
      body: sessionBody({ device_id: 'dev-seat', session_id: 'sess-seat' }, turn),
      stickyRouter: router,
      apiKeyRecord: { id: 'key-a', group_id: 1 },
    })
    const b = await captureRunOpts({
      body: sessionBody({ device_id: 'dev-seat', session_id: 'sess-other' }, turn),
      stickyRouter: router,
      apiKeyRecord: { id: 'key-b', group_id: 1 },
    })
    assert.equal(a.skipSessionSeat, false)
    assert.equal(a.seatKey, 'seat:dev:dev-seat')
    assert.equal(b.seatKey, a.seatKey)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('shared API key keeps different devices apart at the protocol entry', async () => {
  const { dir, router } = realStickyRouter()
  try {
    const apiKeyRecord = { id: 'shared-key', group_id: 1 }
    const a = await captureRunOpts({
      body: sessionBody({ device_id: 'dev-one', session_id: 'sess-one' }),
      stickyRouter: router,
      apiKeyRecord,
    })
    const b = await captureRunOpts({
      body: sessionBody({ device_id: 'dev-two', session_id: 'sess-two' }),
      stickyRouter: router,
      apiKeyRecord,
    })
    assert.notEqual(a.stickyKey, b.stickyKey)
    assert.notEqual(a.deviceKey, b.deviceKey)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('explicit body device_id is the fallback when metadata has no device', async () => {
  const { dir, router } = realStickyRouter()
  try {
    const opts = await captureRunOpts({
      body: sessionBody({ session_id: 'sess-fallback' }, { device_id: 'dev-explicit' }),
      stickyRouter: router,
      apiKeyRecord: { id: 'key-fallback', group_id: 1 },
    })
    assert.equal(opts.stickyKey, 'sess:sess-fallback')
    assert.equal(opts.stickyDeviceId, 'dev-explicit')
    assert.equal(opts.deviceKey, 'dev2:dev-explicit')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('legacy API-key-scoped session row migrates lazily at the protocol entry', async () => {
  const { dir, router } = realStickyRouter()
  try {
    const apiKeyRecord = { id: 'key-old', group_id: 1 }
    const legacyKey = 'p:anthropic:kkey-old:sess-legacy'
    router.bind(legacyKey, { accountId: 'acc-legacy', vmId: 'vm-legacy', sessionId: 'out-legacy', slotIndex: 1 })
    router.bind('p:anthropic:kkey-old:unrelated', { accountId: 'acc-x', vmId: 'vm-x' })
    const opts = await captureRunOpts({
      body: sessionBody({ device_id: 'dev-legacy', session_id: 'sess-legacy' }),
      stickyRouter: router,
      apiKeyRecord,
    })
    assert.equal(opts.stickyKey, 'sess:sess-legacy')
    assert.deepEqual(opts.stickyKeys, ['sess:sess-legacy', legacyKey])
    const hit = router.resolve('sess:sess-legacy')
    assert.equal(hit.vmId, 'vm-legacy')
    assert.equal(hit.accountId, 'acc-legacy')
    assert.equal(router.resolve('dev2:dev-legacy').vmId, 'vm-legacy')
    assert.equal(router.resolve(legacyKey).vmId, 'vm-legacy')
    assert.equal(router.resolve('p:anthropic:kkey-old:unrelated').vmId, 'vm-x')

    // A different API key now reaches the same session binding.
    const other = await captureRunOpts({
      body: sessionBody({ device_id: 'dev-legacy', session_id: 'sess-legacy' }),
      stickyRouter: router,
      apiKeyRecord: { id: 'key-new', group_id: 1 },
    })
    assert.equal(other.stickyKey, 'sess:sess-legacy')
    assert.deepEqual(other.stickyKeys, ['sess:sess-legacy'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('parent and child family key is shared across API keys and inherits a live legacy family', async () => {
  const { dir, router } = realStickyRouter()
  try {
    router.bind('p:anthropic:kkey-p:family:parent-sess', { accountId: 'acc-fam', vmId: 'vm-fam' })
    const parent = await captureRunOpts({
      body: sessionBody({ device_id: 'dev-fam', session_id: 'parent-sess' }),
      stickyRouter: router,
      apiKeyRecord: { id: 'key-p', group_id: 1 },
    })
    const child = await captureRunOpts({
      body: sessionBody({ device_id: 'dev-fam', session_id: 'child-sess', parent_session_id: 'parent-sess' }),
      stickyRouter: router,
      apiKeyRecord: { id: 'key-c', group_id: 1 },
    })
    assert.equal(parent.familyKey, 'family2:parent-sess')
    assert.equal(child.familyKey, parent.familyKey)
    assert.equal(parent.familyVmId, 'vm-fam')
    assert.equal(child.familyVmId, 'vm-fam')
    assert.notEqual(child.stickyKey, parent.stickyKey)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Claude Code sub-agent hops run as child sessions of the main session', async () => {
  const { dir, router } = realStickyRouter()
  try {
    const apiKeyRecord = { id: 'key-cc', group_id: 1 }
    const body = sessionBody({ device_id: 'dev-cc', session_id: 'main-sess' })
    const main = await captureRunOpts({ body, stickyRouter: router, apiKeyRecord })
    router.bind(main.stickyKey, { accountId: 'acc-cc', vmId: 'vm-cc', slotIndex: 0 })
    router.bind(main.familyKey, { accountId: 'acc-cc', vmId: 'vm-cc' })
    const agentHop = (agentId, parentAgentId) =>
      captureRunOpts({
        body,
        stickyRouter: router,
        apiKeyRecord,
        headers: {
          'x-claude-code-session-id': 'main-sess',
          'x-claude-code-agent-id': agentId,
          ...(parentAgentId ? { 'x-claude-code-parent-agent-id': parentAgentId } : {}),
        },
      })
    const a = await agentHop('agent-a')
    const aAgain = await agentHop('agent-a')
    const b = await agentHop('agent-b')
    const nested = await agentHop('agent-c', 'agent-a')

    assert.equal(main.stickyKey, 'sess:main-sess')
    // A one-shot short turn ('hello') holds no seat even with a device id.
    assert.equal(main.skipSessionSeat, true)
    assert.equal(main.seatKey, null)
    // Each agent queues on its own session, never behind the main one.
    const keys = [main.stickyKey, a.stickyKey, b.stickyKey, nested.stickyKey]
    assert.equal(new Set(keys).size, keys.length)
    assert.equal(aAgain.stickyKey, a.stickyKey)
    assert.deepEqual(a.stickyKeys, [a.stickyKey])
    for (const child of [a, b, nested]) {
      assert.match(child.stickyKey, /^sess:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      assert.equal(child.familyKey, 'family2:main-sess')
      assert.equal(child.familyVmId, 'vm-cc')
      assert.equal(child.deviceKey, main.deviceKey)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('request without trusted session id keeps the legacy scoped sticky key', async () => {
  const { dir, router } = realStickyRouter()
  try {
    const body = {
      model: 'claude-sonnet-4-5',
      stream: false,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'no identity here' }],
    }
    const opts = await captureRunOpts({ body, stickyRouter: router, apiKeyRecord: { id: 'key-anon', group_id: 1 } })
    assert.match(String(opts.stickyKey), /^p:anthropic:kkey-anon:ch:/)
    assert.equal(opts.deviceKey, null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('one-shot test call skips the session seat but keeps its sticky key', async () => {
  const { dir, router } = realStickyRouter()
  try {
    const probe = await captureRunOpts({
      body: sessionBody({ device_id: 'dev-probe', session_id: 'sess-probe' }, { max_tokens: 1024 }),
      stickyRouter: router,
    })
    assert.equal(probe.skipSessionSeat, true)
    assert.equal(probe.stickyKey, 'sess:sess-probe')
    const turn = await captureRunOpts({
      body: sessionBody(
        { device_id: 'dev-probe', session_id: 'sess-probe' },
        {
          messages: [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
            { role: 'user', content: 'go on' },
          ],
        },
      ),
      stickyRouter: router,
    })
    assert.equal(turn.skipSessionSeat, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Responses API backend keeps parallel done-only tools in one stream state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-api-tools-'))
  const socket = path.join(root, 'run', 'api-kernel.sock')
  fs.mkdirSync(path.dirname(socket), { recursive: true })
  const items = [0, 1].map((index) => ({
    type: 'function_call',
    id: `fc_${index}`,
    call_id: `call_${index}`,
    name: 'edit',
    arguments: JSON.stringify({ path: `${index}.txt` }),
  }))
  const events = [
    ...items.map((item, index) => ({
      type: 'response.output_item.added',
      output_index: index,
      item: { ...item, arguments: '' },
    })),
    ...items.map((item, index) => ({
      type: 'response.function_call_arguments.done',
      output_index: index,
      item_id: item.id,
      arguments: item.arguments,
    })),
    { type: 'response.completed', response: { output: items } },
  ]
  const kernel = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => kernel.listen(socket, resolve))
  let wire = ''
  const res = {
    headersSent: false,
    write: (chunk) => {
      wire += chunk
    },
  }
  try {
    const result = await runApiInference({
      cfg: { paths: { data: root } },
      res,
      protocol: 'openai.chat',
      clientStream: true,
      deliveryMode: 'verified',
      convertedBody: { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'edit' }] },
      inbound: {},
      converters: {
        writeSSEHeaders: () => {
          res.headersSent = true
        },
      },
      scheduler: {
        pick: () => ({
          ok: true,
          endpoint: { id: 'ep', kind: 'openai', protocol: 'openai', base_url: 'https://fixture.invalid' },
          key: { id: 'key', api_key: 'fixture' },
          upstream_model: 'gpt-5.4',
        }),
      },
    })
    assert.equal(result.ok, true)
    const chunks = wire
      .split('\n\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)))
    const calls = chunks.flatMap((chunk) => chunk.choices[0].delta.tool_calls || [])
    for (let index = 0; index < items.length; index++) {
      const tool = calls.filter((call) => call.index === index)
      assert.equal(tool.find((call) => call.id)?.id, items[index].call_id)
      assert.deepEqual(JSON.parse(tool.map((call) => call.function?.arguments || '').join('')), {
        path: `${index}.txt`,
      })
    }
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls')
    assert.equal(wire.split('data: [DONE]').length - 1, 1)
  } finally {
    kernel.closeAllConnections()
    await new Promise((resolve) => kernel.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('API Anthropic non-stream rejects message_start without message_stop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-api-incomplete-'))
  const socket = path.join(root, 'run', 'api-kernel.sock')
  fs.mkdirSync(path.dirname(socket), { recursive: true })
  const kernel = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(messageStart())
    })
  })
  await new Promise((resolve) => kernel.listen(socket, resolve))
  try {
    const result = await runApiInference({
      cfg: { paths: { data: root } },
      res: { headersSent: false, write: () => {} },
      protocol: 'anthropic.messages',
      clientStream: false,
      deliveryMode: 'verified',
      convertedBody: { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] },
      inbound: {},
      converters: { createClaudeMessageAssembler, applyClaudeSSELineToMessage },
      scheduler: {
        pick: () => ({
          ok: true,
          endpoint: { id: 'ep', kind: 'claude', protocol: 'anthropic', base_url: 'https://fixture.invalid' },
          key: { id: 'key', api_key: 'fixture' },
          upstream_model: 'claude-haiku-4-5',
        }),
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.terminalState, 'incomplete')
    assert.equal(result.sawMessageStop, false)
    assert.equal(result.body?.type, 'message')
  } finally {
    kernel.closeAllConnections()
    await new Promise((resolve) => kernel.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('API Anthropic non-stream rejects stop_reason and text without message_stop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-api-delta-no-stop-'))
  const socket = path.join(root, 'run', 'api-kernel.sock')
  fs.mkdirSync(path.dirname(socket), { recursive: true })
  const kernel = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const events = [
        {
          type: 'message_start',
          message: { type: 'message', role: 'assistant', content: [], model: 'claude-haiku-4-5' },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1 },
        },
      ]
      res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
    })
  })
  await new Promise((resolve) => kernel.listen(socket, resolve))
  try {
    const result = await runApiInference({
      cfg: { paths: { data: root } },
      res: { headersSent: false, write: () => {} },
      protocol: 'anthropic.messages',
      clientStream: false,
      deliveryMode: 'verified',
      convertedBody: { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] },
      inbound: {},
      converters: { createClaudeMessageAssembler, applyClaudeSSELineToMessage },
      scheduler: {
        pick: () => ({
          ok: true,
          endpoint: { id: 'ep', kind: 'claude', protocol: 'anthropic', base_url: 'https://fixture.invalid' },
          key: { id: 'key', api_key: 'fixture' },
          upstream_model: 'claude-haiku-4-5',
        }),
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.terminalState, 'incomplete')
    assert.equal(result.sawMessageStop, false)
    assert.equal(result.body?.content?.[0]?.text, 'hello')
  } finally {
    kernel.closeAllConnections()
    await new Promise((resolve) => kernel.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('API Anthropic non-stream accepts message_stop as terminal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-api-complete-'))
  const socket = path.join(root, 'run', 'api-kernel.sock')
  fs.mkdirSync(path.dirname(socket), { recursive: true })
  const kernel = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(completeAnthropicSse())
    })
  })
  await new Promise((resolve) => kernel.listen(socket, resolve))
  try {
    const result = await runApiInference({
      cfg: { paths: { data: root } },
      res: { headersSent: false, write: () => {} },
      protocol: 'anthropic.messages',
      clientStream: false,
      deliveryMode: 'verified',
      convertedBody: { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] },
      inbound: {},
      converters: { createClaudeMessageAssembler, applyClaudeSSELineToMessage },
      scheduler: {
        pick: () => ({
          ok: true,
          endpoint: { id: 'ep', kind: 'claude', protocol: 'anthropic', base_url: 'https://fixture.invalid' },
          key: { id: 'key', api_key: 'fixture' },
          upstream_model: 'claude-haiku-4-5',
        }),
      },
    })
    assert.equal(result.ok, true)
    assert.equal(result.terminalState, 'verified')
    assert.equal(result.sawMessageStop, true)
    assert.equal(result.body?.type, 'message')
  } finally {
    kernel.closeAllConnections()
    await new Promise((resolve) => kernel.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('API backend non-stream maps incomplete assistant hops to incomplete_response', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-api-incomplete-http-'))
  const routingFile = path.join(root, 'routing.json')
  const socketPath = path.join(root, 'run', 'api-kernel.sock')
  fs.mkdirSync(path.dirname(socketPath), { recursive: true })
  fs.writeFileSync(routingFile, JSON.stringify({ compatibility: { persona_preset: 'zero' } }))
  const kernel = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(messageStart())
    })
  })
  await new Promise((resolve) => kernel.listen(socketPath, resolve))
  const response = fakeResponse()
  const handler = createHandleProtocol({
    json: (_res, status, body) => {
      response.status = status
      response.body = body
      return body
    },
    writeSSEHeaders() {},
    readBody: async () => ({
      model: 'claude-haiku-4-5',
      stream: false,
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hello' }],
    }),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
      paths: { data: root },
    },
    requestLog: { start: () => ({ request_id: 'api-incomplete-test' }), finish() {} },
    stickyRouter: {},
    accountQuota: {},
    apiKeyStore: { acquire: () => ({ ok: true }), release() {} },
    apiScheduler: {
      pick: () => ({
        ok: true,
        endpoint: { id: 'ep-test', kind: 'claude', protocol: 'anthropic', base_url: 'https://upstream.invalid' },
        upstream_model: 'claude-haiku-4-5',
        key: { id: 'key-test', api_key: 'secret' },
      }),
    },
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: { compatibility: { persona_preset: 'zero' }, failover: {} },
    groupsRepo: { rateMultiplier: () => 1 },
  })
  const req = {
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: 'Bearer sk-vm-api', 'user-agent': 'test-client' },
    apiKeyKind: 'managed',
    apiKeyRecord: { category: 'api' },
    once() {},
    off() {},
  }
  try {
    await handler.handleProtocol(req, response, 'anthropic.messages', '/v1/messages')
    assert.equal(response.status, 502)
    assert.equal(response.body.error.code, 'incomplete_response')
  } finally {
    await new Promise((resolve) => kernel.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Responses API backend returns 502 for conflicting tool arguments when the client is not streaming', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-api-tools-ns-'))
  const socket = path.join(root, 'run', 'api-kernel.sock')
  fs.mkdirSync(path.dirname(socket), { recursive: true })
  const events = [
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'fc_0', call_id: 'call_0', name: 'edit', arguments: '' },
    },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_0', delta: '{"path":"a' },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_0', arguments: '{"path":"b.txt"}' },
    { type: 'response.completed', response: { output: [] } },
  ]
  const kernel = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => kernel.listen(socket, resolve))
  try {
    const result = await runApiInference({
      cfg: { paths: { data: root } },
      res: { headersSent: false, write: () => {} },
      protocol: 'anthropic.messages',
      clientStream: false,
      deliveryMode: 'verified',
      convertedBody: { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'edit' }] },
      inbound: {},
      converters: { writeSSEHeaders: () => {} },
      scheduler: {
        pick: () => ({
          ok: true,
          endpoint: { id: 'ep', kind: 'openai', protocol: 'openai', base_url: 'https://fixture.invalid' },
          key: { id: 'key', api_key: 'fixture' },
          upstream_model: 'gpt-5.4',
        }),
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.status, 502)
    assert.equal(result.body.error.code, 'tool_arguments_mismatch')
  } finally {
    kernel.closeAllConnections()
    await new Promise((resolve) => kernel.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
test('OpenAI Responses lifecycle metadata does not commit downstream output', () => {
  for (const type of [
    'response.created',
    'response.queued',
    'response.in_progress',
    'response.metadata',
    'keepalive',
  ]) {
    assert.equal(isOpenAIResponsesCommitEvent({ type }), false, type)
  }
  assert.equal(isOpenAIResponsesCommitEvent({ type: 'error', error: { code: 'server_is_overloaded' } }), false)
  assert.equal(isOpenAIResponsesCommitEvent({ type: 'response.failed' }), false)
  assert.equal(
    isOpenAIResponsesCommitEvent({ type: 'response.output_item.added', item: { type: 'reasoning', summary: [] } }),
    false,
  )
  assert.equal(isOpenAIResponsesCommitEvent({ type: 'response.output_text.delta', delta: 'hello' }), true)
})

async function runOpenAIResponsesFixture(events) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-openai-metadata-'))
  const socket = path.join(root, 'run', 'api-kernel.sock')
  fs.mkdirSync(path.dirname(socket), { recursive: true })
  const kernel = http.createServer((req, response) => {
    req.resume()
    req.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => kernel.listen(socket, resolve))
  let wire = ''
  const res = {
    headersSent: false,
    write(chunk) {
      wire += chunk
    },
  }
  try {
    const result = await runApiInference({
      cfg: { paths: { data: root } },
      res,
      protocol: 'openai.responses',
      clientStream: true,
      deliveryMode: 'verified',
      convertedBody: { model: 'gpt-5.4', messages: [{ role: 'user', content: 'hello' }] },
      inbound: {},
      converters: {
        writeSSEHeaders: () => {
          res.headersSent = true
        },
      },
      scheduler: {
        pick: () => ({
          ok: true,
          endpoint: { id: 'ep', kind: 'openai', protocol: 'openai', base_url: 'https://fixture.invalid' },
          key: { id: 'key', api_key: 'fixture' },
          upstream_model: 'gpt-5.4',
        }),
      },
    })
    return { result, wire, headersSent: res.headersSent }
  } finally {
    kernel.closeAllConnections()
    await new Promise((resolve) => kernel.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
}

unixTest('API OpenAI metadata followed by overload remains uncommitted for failover', async () => {
  const run = await runOpenAIResponsesFixture([
    { type: 'response.created', response: { id: 'resp_meta' } },
    { type: 'response.queued', response: { id: 'resp_meta' } },
    { type: 'response.metadata', response: { id: 'resp_meta' } },
    { type: 'error', error: { type: 'server_error', code: 'server_is_overloaded', status: 503, message: 'busy' } },
    {
      type: 'response.failed',
      response: { error: { type: 'server_error', code: 'server_is_overloaded', status: 503, message: 'busy' } },
    },
  ])
  assert.equal(run.result.ok, false)
  assert.equal(run.result.status, 503)
  assert.equal(run.result.committed, false)
  assert.equal(run.headersSent, false)
  assert.equal(run.wire, '')
})

unixTest('API OpenAI flushes buffered metadata with the first real output', async () => {
  const run = await runOpenAIResponsesFixture([
    { type: 'response.created', response: { id: 'resp_ok' } },
    { type: 'response.queued', response: { id: 'resp_ok' } },
    { type: 'response.output_text.delta', delta: 'hello' },
    { type: 'response.completed', response: { id: 'resp_ok', output: [] } },
  ])
  assert.equal(run.result.ok, true)
  assert.equal(run.result.committed, true)
  assert.equal(run.result.terminalState, 'verified')
  assert.match(run.wire, /response\.created/)
  assert.match(run.wire, /response\.queued/)
  assert.match(run.wire, /response\.output_text\.delta/)
  assert.match(run.wire, /response\.completed/)
})
