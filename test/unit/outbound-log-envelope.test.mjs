import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { ThinkingOwnerStore } from '../../src/lib/pool/thinking-owner.mjs'
import { activateFixture, seedEncryptedPackage } from '../fixtures/crag-license.mjs'

// Unix socket 在 Windows 上不可用，和 go-worker-client.test.mjs 的 unixTest 保持一致。
const unixTest = process.platform === 'win32' ? test.skip : test

/**
 * 假槽位 kernel：/internal/health 报告就绪，推理路由记下收到的 envelope 并回一段完整 SSE。
 * Body remains the worker envelope; headers must come from the CLI send boundary.
 */
async function fakeKernel({ health = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-outbound-log-'))
  const runDir = path.join(root, 'vm-01', 'run')
  const homeDir = path.join(root, 'vm-01', 'cli-home')
  fs.mkdirSync(runDir, { recursive: true })
  fs.mkdirSync(homeDir, { recursive: true })
  const tokenFile = path.join(runDir, 'internal.token')
  fs.writeFileSync(tokenFile, 'internal-test\n', { mode: 0o600 })
  const socket = path.join(runDir, 'kernel.sock')
  const posted = []
  const requests = []
  let reportFinalHeaders = true
  const server = http.createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, token: req.headers['x-kin-internal-token'] })
    if (req.url === '/internal/health') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, engine: 'rust', healthy: true, ready_slots: 4, ...health }))
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    posted.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    res.setHeader('content-type', 'text/event-stream')
    const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    if (reportFinalHeaders) {
      send({ type: 'kin_outbound_headers', headers: { accept: 'superseded-attempt' } })
      send({
        type: 'kin_outbound_headers',
        headers: {
          accept: 'application/json, text/event-stream',
          'accept-encoding': 'gzip, br',
          'content-length': String(1000 + posted.length),
          authorization: 'Bearer must-not-be-logged',
        },
      })
    }
    send({
      type: 'message_start',
      message: {
        id: `msg_log_${posted.length}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5',
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    })
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })
    send({ type: 'content_block_stop', index: 0 })
    send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
    send({ type: 'message_stop' })
    res.end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, resolve)
  })
  const vm = {
    id: 'vm-01',
    dataplane: 'wrap',
    runtime: { worker_socket: socket, kernel_socket: socket, worker_run_dir: runDir, worker_token_file: tokenFile },
  }
  return {
    root,
    posted,
    requests,
    setReportFinalHeaders(value) {
      reportFinalHeaders = value
    },
    selected: { vmId: 'vm-01', accountId: 'account-a', vm, exec: { vmId: 'vm-01', homeDir, vm } },
    async close() {
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

function fakeResponse() {
  const listeners = {}
  const writes = []
  return {
    writes,
    headersSent: false,
    statusCode: 200,
    on(event, fn) {
      listeners[event] = fn
    },
    once() {},
    off() {},
    setHeader() {},
    writeHead(status) {
      this.statusCode = status
      this.headersSent = true
    },
    write(chunk) {
      writes.push(String(chunk))
      return true
    },
    end(chunk) {
      if (chunk != null) writes.push(String(chunk))
    },
    finish() {
      listeners.finish?.()
    },
  }
}

function protocolHarness(
  kernel,
  routing = { compatibility: {}, failover: {} },
  interceptRules = [],
  admitCragInference,
) {
  const finished = []
  const preparedCandidates = []
  const handler = createHandleProtocol({
    admitCragInference,
    json: (res, status, body) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(body))
      return status
    },
    writeSSEHeaders(res) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
    },
    readBody: async (req) => req.body,
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: interceptRules },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 5000, stream_idle_timeout_ms: 5000 },
      paths: { data: kernel.root, project: kernel.root },
    },
    requestLog: {
      start: () => ({ request_id: 'outbound-log', mode: 'debug', capture_outbound: true }),
      finish: (_ctx, extra) => finished.push(extra),
    },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: { ingestHeaders() {} },
    apiKeyStore: { acquire: () => ({ ok: true }), release() {} },
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: path.join(kernel.root, 'routing.json'),
    routingConfig: routing,
    groupsRepo: { rateMultiplier: () => 1 },
    thinkingOwners: new ThinkingOwnerStore({ db: new DatabaseSync(':memory:') }),
    failoverRunner: {
      async run(opts) {
        preparedCandidates.push(structuredClone(kernel.selected.exec.workerStatus))
        const prepared = await opts.applyAttempt(opts.canonicalBody, kernel.selected)
        const hop = await opts.callAttempt({
          candidate: kernel.selected,
          body: prepared.body,
          attemptMeta: prepared.meta,
          deliveryMode: 'realtime',
          signal: new AbortController().signal,
          onCommit() {},
        })
        return { ...hop, accountId: kernel.selected.accountId, vmId: kernel.selected.vmId }
      },
    },
  })
  const request = (body) => ({
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: 'Bearer sk-vm-x', 'user-agent': 'claude-cli/2.1.304 (external, cli)' },
    apiKeyKind: 'managed',
    apiKeyRecord: { id: 'key-1' },
    body,
    once() {},
    off() {},
  })
  return { handler, finished, preparedCandidates, request }
}

unixTest('public JSON and SSE requests reject before worker POST, then resume when admission recovers', async (t) => {
  const kernel = await fakeKernel({ health: { runtime_variant: 'crag-v2', ready_slots: 1 } })
  const previous = process.env.KIN_KERNEL_BIN
  t.after(async () => {
    if (previous === undefined) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = previous
    await kernel.close()
  })
  process.env.KIN_KERNEL_BIN = path.join(kernel.root, 'kin-kernel')
  seedEncryptedPackage(kernel.root)
  activateFixture(kernel.root, kernel.selected.vm)
  kernel.selected.exec.projectRoot = kernel.root
  const code = 'license_crag_host_over_quota'
  let overQuota = true
  const { handler } = protocolHarness(kernel, { inference: { engine: 'rust' }, failover: {} }, [], () =>
    overQuota
      ? {
          ok: false,
          status: 403,
          terminalState: 'rejected',
          upstreamExecutions: 0,
          committed: false,
          body: { type: 'error', error: { type: 'permission_error', code, message: 'CRAG host capacity exceeded' } },
        }
      : null,
  )
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    req.body = JSON.parse(Buffer.concat(chunks))
    req.apiKeyKind = 'managed'
    req.apiKeyRecord = { id: 'key-1' }
    await handler.handleProtocol(req, res, 'anthropic.messages', '/v1/messages')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const send = (stream) =>
    fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'claude-cli/2.1.304 (external, cli)' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 32,
        stream,
        messages: [{ role: 'user', content: 'pong' }],
      }),
    })
  for (const stream of [false, true]) {
    const response = await send(stream)
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error.code, code)
  }
  assert.equal(kernel.posted.length, 0)
  overQuota = false
  for (const stream of [false, true]) {
    const response = await send(stream)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /message/)
  }
  assert.equal(kernel.posted.length, 2)
})

unixTest('debug log uses final CLI headers, hides internal events and never substitutes envelope headers', async () => {
  const kernel = await fakeKernel({ health: { runtime_variant: 'cli-node', dataplane: 'wrap' } })
  const { handler, finished, request } = protocolHarness(kernel, {
    inference: { dataplane: 'wrap', health_ttl_ms: 0 },
    compatibility: {},
    failover: {},
  })
  // 路由只检查宿主 kernel 路径非空才放行这一跳；真正接请求的是上面的假 kernel socket。
  const prevKernelBin = process.env.KIN_KERNEL_BIN
  process.env.KIN_KERNEL_BIN = path.join(kernel.root, 'kin-kernel')
  try {
    // 非流式走 streamAndAssembleClaudeMessage，流式走 dispatchStreamInference，两条路都要记 envelope。
    for (const stream of [false, true, false, true]) {
      kernel.setReportFinalHeaders(finished.length < 2)
      const res = fakeResponse()
      await handler.handleProtocol(
        request({ model: 'claude-haiku-4-5', stream, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
        res,
        'anthropic.messages',
        '/v1/messages',
      )
      res.finish()
      assert.equal(res.writes.join('').includes('kin_outbound_headers'), false)
      assert.equal(res.writes.join('').includes('must-not-be-logged'), false)
    }
    assert.equal(
      kernel.posted.length,
      4,
      JSON.stringify(finished.map((f) => [f.status, f.error_code, f.error_message])),
    )
    assert.equal(finished.length, 4)
    for (const [i, extra] of finished.entries()) {
      const sent = kernel.posted[i]
      assert.deepEqual(JSON.parse(JSON.stringify(extra.outbound_body)), sent.body)
      // cli-hop 在传输层才补的字段：betas 与 cch 占位；billing 由 cli-hop 末段补上。
      assert.ok(Array.isArray(extra.outbound_body.betas))
      assert.match(extra.outbound_body.system[0].text, /^x-anthropic-billing-header: .*\bcch=00000;/)
      assert.deepEqual(extra.worker_envelope_headers, sent.headers)
      if (i < 2) {
        assert.deepEqual(extra.outbound_headers, {
          accept: 'application/json, text/event-stream',
          'accept-encoding': 'gzip, br',
          'content-length': String(1001 + i),
          authorization: '***REDACTED***',
        })
        assert.equal(extra.outbound_headers_source, 'cli_final')
      } else {
        assert.equal(extra.outbound_headers, null)
        assert.equal(extra.outbound_headers_source, 'unavailable')
      }
    }
  } finally {
    if (prevKernelBin === undefined) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = prevKernelBin
    await kernel.close()
  }
})

const printCapabilities = ['prompt_append', 'prompt_replace', 'model_directive', 'caller_cwd']
const printHealth = { runtime_variant: 'crag-v2', capabilities: printCapabilities }
const ordinaryHealth = { runtime_variant: 'cli-node', capabilities: [] }
const trustedCwd = '/synthetic/trusted-workspace'
const publicCwd = '/synthetic/public-cwd-must-not-win'
const cwdTag = (cwd) => `<cwd>\n${cwd}\n</cwd>`

async function protocolKernelFixture(t, { health, staleHealth, preset = 'official_full', interceptRules }) {
  const kernel = await fakeKernel({ health })
  const previous = process.env.KIN_KERNEL_BIN
  t.after(async () => {
    if (previous === undefined) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = previous
    await kernel.close()
  })
  if (health.runtime_variant === 'crag-v2') {
    seedEncryptedPackage(kernel.root)
    activateFixture(kernel.root, kernel.selected.vm)
    kernel.selected.exec.projectRoot = kernel.root
  }
  process.env.KIN_KERNEL_BIN = path.join(kernel.root, 'kin-kernel')
  kernel.setReportFinalHeaders(false)
  kernel.selected.exec.workerStatus = structuredClone(staleHealth)
  fs.writeFileSync(path.join(kernel.root, 'vm-01', 'run', 'kernel.json'), JSON.stringify(staleHealth))
  const routing = {
    inference: { engine: 'rust', health_ttl_ms: 0 },
    compatibility: {
      persona_preset: preset,
      crag_persona_preset: preset,
      overlay_preset: 'off',
      persona_env_presets: { [preset]: false },
    },
    failover: {},
  }
  fs.writeFileSync(path.join(kernel.root, 'routing.json'), JSON.stringify(routing))
  const { handler, finished, preparedCandidates, request } = protocolHarness(kernel, routing, interceptRules)
  return {
    async send(
      body,
      candidateHealth = staleHealth,
      { protocol = 'anthropic.messages', headers = {}, status = 200 } = {},
    ) {
      kernel.selected.exec.workerStatus = structuredClone(candidateHealth)
      const postedBefore = kernel.posted.length
      const finishedBefore = finished.length
      const requestsBefore = kernel.requests.length
      const response = fakeResponse()
      const req = request(body)
      Object.assign(req.headers, headers)
      if (protocol === 'openai.responses') req.url = '/v1/responses'
      if (protocol === 'openai.chat') req.url = '/v1/chat/completions'
      await handler.handleProtocol(req, response, protocol, req.url)
      response.finish()
      assert.equal(response.statusCode, status, response.writes.join(''))
      if (status !== 200) {
        assert.equal(kernel.posted.length, postedBefore)
        return JSON.parse(response.writes.join(''))
      }
      assert.deepEqual(preparedCandidates.at(-1), candidateHealth)
      assert.equal(kernel.posted.length, postedBefore + 1)
      assert.equal(finished.length, finishedBefore + 1)
      const requests = kernel.requests.slice(requestsBefore)
      assert.deepEqual(
        requests.map(({ method, url }) => ({ method, url })),
        [
          { method: 'GET', url: '/internal/health' },
          { method: 'POST', url: '/internal/v1/messages' },
        ],
      )
      assert.equal(requests[1].token, 'internal-test')
      const envelope = kernel.posted.at(-1)
      const extra = finished.at(-1)
      assert.deepEqual(JSON.parse(JSON.stringify(extra.outbound_body)), envelope.body)
      assert.deepEqual(extra.worker_envelope_headers, envelope.headers ?? null)
      assert.equal(Object.hasOwn(envelope.body, 'caller_cwd'), false)
      assert.equal(Object.hasOwn(extra, 'caller_cwd'), false)
      assert.equal(Object.hasOwn(extra.outbound_body, 'caller_cwd'), false)
      assert.equal(JSON.stringify(envelope).includes(publicCwd), false)
      assert.equal(JSON.stringify(extra.outbound_body).includes(publicCwd), false)
      return { envelope, extra }
    },
  }
}

unixTest('native CRAG receives caller tool names and structured system cache blocks', async (t) => {
  const fixture = await protocolKernelFixture(t, {
    health: {
      ...printHealth,
      capabilities: [...printCapabilities, 'generation_controls_v3', 'system_text_cache_v3', 'linux_tui_native_queue'],
    },
    staleHealth: ordinaryHealth,
  })
  const anchor = { type: 'ephemeral', ttl: '1h' }
  const system = [
    { type: 'text', text: 'Policy alpha', cache_control: anchor },
    { type: 'text', text: 'Policy beta', cache_control: anchor },
    { type: 'text', text: 'Supplementary policy' },
  ]
  const tools = ['lookup', 'mcp__lookup', 'mcp_legacy'].map((name) => ({
    name,
    input_schema: { type: 'object' },
  }))
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'Look up the entry' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fixture', name: 'lookup', input: {} }] },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_fixture', content: 'result' },
        { type: 'text', text: 'Summarize it', cache_control: { type: 'ephemeral' } },
      ],
    },
  ]
  const { envelope, extra } = await fixture.send({
    model: 'claude-sonnet-5-5',
    max_tokens: 32000,
    stream: true,
    system,
    tools,
    messages,
    tool_choice: { type: 'auto' },
  })
  assert.equal(Object.hasOwn(envelope, 'headers'), false)
  assert.equal(extra.worker_envelope_headers, null)
  assert.deepEqual(envelope.body.tools, tools)
  assert.deepEqual(envelope.body.system, system)
  assert.equal(envelope.body.crag_prompt, undefined)
  assert.deepEqual(envelope.body.messages, messages)
  assert.deepEqual(envelope.body.tool_choice, { type: 'auto' })
  assert.equal(envelope.body.max_tokens, 32000)
})

unixTest('zero CRAG sends mixed Responses tools and structured system to the capable worker', async (t) => {
  const fixture = await protocolKernelFixture(t, {
    health: {
      ...printHealth,
      capabilities: [
        ...printCapabilities,
        'generation_controls_v3',
        'provider_managed_tools_v1',
        'linux_tui_native_queue',
      ],
    },
    staleHealth: ordinaryHealth,
    preset: 'zero',
  })
  const search = { type: 'web_search_20260209', name: 'web_search', max_uses: 2, allowed_domains: ['example.org'] }
  const { envelope } = await fixture.send(
    {
      model: 'claude-sonnet-5-5',
      instructions: 'Caller policy',
      input: 'Sample',
      tools: [
        ...Array.from({ length: 47 }, (_, index) => ({
          type: 'function',
          name: `client_${index}`,
          parameters: { type: 'object' },
        })),
        search,
      ],
    },
    ordinaryHealth,
    { protocol: 'openai.responses' },
  )
  assert.equal(Object.hasOwn(envelope, 'headers'), false)
  assert.equal(envelope.body.tools.length, 48)
  assert.deepEqual(envelope.body.tools[47], search)
  assert.deepEqual(envelope.body.system, [{ type: 'text', text: 'Caller policy' }])
  assert.equal(envelope.body.crag_prompt, undefined)
})

for (const runtime of ['crag-v2', 'cli-node']) {
  unixTest(`Three protocol entrances send structured tool continuation before ${runtime} dispatch`, async (t) => {
    const health =
      runtime === 'crag-v2'
        ? { ...printHealth, capabilities: [...printCapabilities, 'generation_controls_v3', 'system_text_cache_v3'] }
        : ordinaryHealth
    const fixture = await protocolKernelFixture(t, { health, staleHealth: ordinaryHealth })
    const { envelope } = await fixture.send(
      {
        model: 'claude-sonnet-5-5',
        max_output_tokens: 32000,
        instructions: 'Caller policy',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Find it' }] },
          {
            type: 'additional_tools',
            role: 'developer',
            tools: [{ type: 'function', name: 'fixture_lookup', parameters: { type: 'object' } }],
          },
          {
            type: 'function_call',
            id: 'fc_different',
            call_id: 'call_existing',
            name: 'fixture_lookup',
            arguments: '{"file":"sample"}',
          },
          { type: 'function_call_output', call_id: 'call_existing', output: 'Here it is' },
        ],
      },
      ordinaryHealth,
      { protocol: 'openai.responses', headers: { 'user-agent': 'codex_cli_rs/0.0.0' } },
    )
    const expectedName = runtime === 'crag-v2' ? 'fixture_lookup' : 'mcp__fixture_lookup'
    assert.equal(envelope.body.tools[0].name, expectedName)
    assert.deepEqual(envelope.body.tools[0].input_schema, { type: 'object' })
    assert.equal(envelope.body.max_tokens, 32000)
    assert.equal(envelope.body.input, undefined)
    const blocks = envelope.body.messages.flatMap((message) => message.content)
    assert.deepEqual(
      blocks.find((block) => block.type === 'tool_use'),
      {
        type: 'tool_use',
        id: 'call_existing',
        name: expectedName,
        input: { file: 'sample' },
      },
    )
    const result = blocks.find((block) => block.type === 'tool_result')
    assert.equal(result.tool_use_id, 'call_existing')
    assert.deepEqual(result.content, [{ type: 'text', text: 'Here it is' }])

    const messages = [
      { role: 'user', content: 'Find it' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            type: 'function',
            id: 'call_existing',
            function: { name: 'fixture_lookup', arguments: '{"file":"sample"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_existing', content: 'Here it is' },
    ]
    const tools = [{ type: 'function', function: { name: 'fixture_lookup', parameters: { type: 'object' } } }]
    for (const protocol of ['anthropic.messages', 'openai.chat']) {
      const { envelope: converted } = await fixture.send(
        { model: 'claude-sonnet-5-5', max_tokens: 32000, messages, tools },
        ordinaryHealth,
        { protocol },
      )
      const name = converted.body.tools[0].name
      assert.match(name, /^(mcp__)?fixture_lookup$/)
      assert.deepEqual(converted.body.tools[0].input_schema, { type: 'object' })
      assert.ok(converted.body.messages.every((message) => message.role !== 'tool' && !message.tool_calls))
      const history = converted.body.messages.flatMap((message) => message.content)
      assert.deepEqual(
        history.find((block) => block.type === 'tool_use'),
        { ...blocks.find((block) => block.type === 'tool_use'), name },
      )
      assert.equal(history.find((block) => block.type === 'tool_result')?.tool_use_id, 'call_existing')
    }
    const invalid = await fixture.send(
      { model: 'claude-sonnet-5-5', messages: messages.slice(0, 2), tools },
      ordinaryHealth,
      { status: 400 },
    )
    assert.equal(invalid.error.code, 'invalid_messages_conversion')
    assert.equal(invalid.error.param, 'messages[1].tool_calls[0].id')
  })
}

function cwdRequest(stream, fields = {}) {
  return {
    model: 'claude-haiku-4-5',
    stream,
    max_tokens: 64,
    caller_cwd: publicCwd,
    messages: [{ role: 'user', content: 'hi' }],
    ...fields,
  }
}

for (const stream of [false, true]) {
  for (const [preset, mode] of [
    ['official_full', 'append'],
    ['zero', 'replace'],
  ]) {
    unixTest(
      `public handler ${stream ? 'stream' : 'nonstream'}: live CRAG overrides ordinary candidate (${mode})`,
      async (t) => {
        const fixture = await protocolKernelFixture(t, { health: printHealth, staleHealth: ordinaryHealth, preset })
        const { envelope, extra } = await fixture.send(
          cwdRequest(stream, {
            system: `${cwdTag(trustedCwd)}\ncaller guidance`,
          }),
        )
        assert.equal(envelope.caller_cwd, trustedCwd)
        assert.deepEqual(envelope.body.crag_prompt, { mode, text: 'caller guidance' })
        assert.equal(envelope.body.crag_model.id, 'claude-haiku-4-5-20251001')
        assert.equal(Object.hasOwn(envelope.body, 'system'), false)
        assert.equal(JSON.stringify(envelope.body).includes(trustedCwd), false)
        assert.equal(JSON.stringify(extra.outbound_body).includes(trustedCwd), false)
        assert.equal(extra.official_cc_inference, 'crag-print')
        assert.equal(extra.crag_print.prompt_mode, mode)
      },
    )

    unixTest(
      `public handler ${stream ? 'stream' : 'nonstream'}: CRAG preserves same-cwd lifted history (${mode})`,
      async (t) => {
        const fixture = await protocolKernelFixture(t, { health: printHealth, staleHealth: ordinaryHealth, preset })
        const history = `historical instructions\n${cwdTag(trustedCwd)}\nkeep this history verbatim`
        const { envelope, extra } = await fixture.send(
          cwdRequest(stream, {
            system: `${cwdTag(trustedCwd)}\ncaller guidance`,
            messages: [
              { role: 'system', content: history },
              { role: 'user', content: 'hi' },
            ],
          }),
        )
        assert.equal(envelope.caller_cwd, trustedCwd)
        assert.equal(envelope.body.crag_prompt.mode, mode)
        assert.ok(envelope.body.crag_prompt.text.includes(history))
        assert.equal(envelope.body.crag_prompt.text.split(trustedCwd).length - 1, 1)
        assert.ok(extra.outbound_body.crag_prompt.text.includes(history))
        assert.equal(Object.hasOwn(envelope.body, 'system'), false)
        assert.equal(
          envelope.body.messages.some((message) => message.role === 'system'),
          false,
        )
      },
    )

    unixTest(
      `public handler ${stream ? 'stream' : 'nonstream'}: old native CRAG omits unsupported fields (${mode})`,
      async (t) => {
        const fixture = await protocolKernelFixture(t, {
          health: { runtime_variant: 'crag-v2', capabilities: [] },
          staleHealth: printHealth,
          preset,
        })
        const { envelope, extra } = await fixture.send(
          cwdRequest(stream, {
            system: `${cwdTag(trustedCwd)}\ncaller guidance`,
          }),
        )
        assert.equal(extra.official_cc_inference, 'crag-print')
        assert.equal(extra.crag_print.prompt_mode, 'default')
        assert.equal(Object.hasOwn(envelope, 'caller_cwd'), false)
        for (const body of [envelope.body, extra.outbound_body]) {
          assert.equal(Object.hasOwn(body, 'crag_prompt'), false)
          assert.equal(Object.hasOwn(body, 'crag_model'), false)
          assert.equal(Object.hasOwn(body, 'system'), false)
          assert.equal(JSON.stringify(body).includes(trustedCwd), false)
        }
      },
    )
  }

  unixTest(
    `public handler ${stream ? 'stream' : 'nonstream'}: live ordinary overrides CRAG candidate without changing its body`,
    async (t) => {
      const fixture = await protocolKernelFixture(t, {
        health: ordinaryHealth,
        staleHealth: printHealth,
        preset: 'zero',
      })
      const body = cwdRequest(stream, { system: `${cwdTag(trustedCwd)}\ncaller guidance` })
      const baseline = await fixture.send(structuredClone(body), ordinaryHealth)
      const stale = await fixture.send(structuredClone(body))
      for (const { envelope, extra } of [baseline, stale]) {
        assert.equal(Object.hasOwn(envelope, 'caller_cwd'), false)
        assert.equal(Object.hasOwn(envelope.body, 'crag_prompt'), false)
        assert.equal(Object.hasOwn(envelope.body, 'crag_model'), false)
        assert.equal(extra.official_cc_inference, 'cli-hop')
        assert.equal(Object.hasOwn(extra, 'crag_print'), false)
        assert.ok(JSON.stringify(envelope.body.system).includes(trustedCwd))
        assert.ok(JSON.stringify(envelope.body.system).includes('caller guidance'))
      }
      const stableSystem = ({ envelope }) => {
        const [billing, ...system] = envelope.body.system
        const promptId = /\bcc_prompt_id=[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12};/
        assert.match(billing.text, promptId)
        return [{ ...billing, text: billing.text.replace(promptId, 'cc_prompt_id=<per-request>;') }, ...system]
      }
      assert.deepEqual(stableSystem(stale), stableSystem(baseline))
      assert.deepEqual(stale.envelope.body.messages, baseline.envelope.body.messages)
      assert.equal(stale.envelope.body.model, baseline.envelope.body.model)
      assert.deepEqual(stale.envelope.body.betas, baseline.envelope.body.betas)
    },
  )

  for (const [name, fields, preserved] of [
    ['absent system', {}, null],
    ['no declaration', { system: 'caller guidance' }, 'caller guidance'],
    ['inline declaration', { system: `<cwd>${trustedCwd}</cwd>\ncaller guidance` }, `<cwd>${trustedCwd}</cwd>`],
    ['relative path', { system: `${cwdTag('synthetic/relative')}\ncaller guidance` }, cwdTag('synthetic/relative')],
    ['duplicate declarations', { system: `${cwdTag(trustedCwd)}\n${cwdTag(trustedCwd)}` }, cwdTag(trustedCwd)],
    [
      'split declaration',
      {
        system: [
          { type: 'text', text: `<cwd>\n${trustedCwd}` },
          { type: 'text', text: '</cwd>\ncaller guidance' },
        ],
      },
      'caller guidance',
    ],
    [
      'lifted history only',
      {
        messages: [
          { role: 'system', content: `historical instructions\n${cwdTag(trustedCwd)}` },
          { role: 'user', content: 'hi' },
        ],
      },
      cwdTag(trustedCwd),
    ],
    ['user message only', { messages: [{ role: 'user', content: cwdTag(trustedCwd) }] }, null],
  ]) {
    unixTest(
      `public handler ${stream ? 'stream' : 'nonstream'}: CRAG does not infer cwd from ${name} or public caller_cwd`,
      async (t) => {
        const fixture = await protocolKernelFixture(t, { health: printHealth, staleHealth: ordinaryHealth })
        const { envelope, extra } = await fixture.send(cwdRequest(stream, fields))
        assert.equal(extra.official_cc_inference, 'crag-print')
        assert.equal(Object.hasOwn(envelope, 'caller_cwd'), false)
        if (preserved) {
          assert.equal(envelope.body.crag_prompt.mode, 'append')
          assert.ok(envelope.body.crag_prompt.text.includes(preserved))
        } else {
          assert.equal(Object.hasOwn(envelope.body, 'crag_prompt'), false)
        }
      },
    )
  }
}

for (const phase of ['before_convert', 'before_upstream']) {
  unixTest(`CRAG does not extract or remove declarations from ${phase} replacement blocks`, async (t) => {
    const replacementText = `${cwdTag(trustedCwd)}\nreplacement guidance`
    const replacement = cwdRequest(false, { system: [{ type: 'text', text: replacementText }] })
    const fixture = await protocolKernelFixture(t, {
      health: printHealth,
      staleHealth: ordinaryHealth,
      interceptRules: [{ phase, action: { replace_body_json: replacement } }],
    })
    const original = cwdRequest(false, { system: [{ type: 'text', text: replacementText }] })
    for (const [body, expectedCwd] of [
      [original, trustedCwd],
      [cwdRequest(false), undefined],
    ]) {
      const { envelope } = await fixture.send(body)
      assert.equal(envelope.caller_cwd, expectedCwd)
      assert.deepEqual(envelope.body.crag_prompt, { mode: 'append', text: replacementText })
    }
  })
}
