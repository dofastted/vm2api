import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { ThinkingOwnerStore } from '../../src/lib/pool/thinking-owner.mjs'

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
    end() {},
    finish() {
      listeners.finish?.()
    },
  }
}

function protocolHarness(kernel, routing = { compatibility: {}, failover: {} }, interceptRules = []) {
  const finished = []
  const preparedCandidates = []
  const handler = createHandleProtocol({
    json: (res, status) => {
      res.statusCode = status
      return status
    },
    writeSSEHeaders(res) {
      res.headersSent = true
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

unixTest('debug log uses final CLI headers, hides internal events and never substitutes envelope headers', async () => {
  const kernel = await fakeKernel()
  const { handler, finished, request } = protocolHarness(kernel)
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
    async send(body, candidateHealth = staleHealth) {
      kernel.selected.exec.workerStatus = structuredClone(candidateHealth)
      const postedBefore = kernel.posted.length
      const finishedBefore = finished.length
      const requestsBefore = kernel.requests.length
      const response = fakeResponse()
      await handler.handleProtocol(request(body), response, 'anthropic.messages', '/v1/messages')
      response.finish()
      assert.equal(response.statusCode, 200)
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
      assert.deepEqual(extra.worker_envelope_headers, envelope.headers)
      assert.equal(Object.hasOwn(envelope.body, 'caller_cwd'), false)
      assert.equal(Object.hasOwn(extra, 'caller_cwd'), false)
      assert.equal(Object.hasOwn(extra.outbound_body, 'caller_cwd'), false)
      assert.equal(JSON.stringify(envelope).includes(publicCwd), false)
      assert.equal(JSON.stringify(extra.outbound_body).includes(publicCwd), false)
      return { envelope, extra }
    },
  }
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
