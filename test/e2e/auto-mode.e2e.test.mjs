import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { classifierFixture, parseClassifierXmlBlock } from '../fixtures/auto-mode.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { createRespond, readBody } from '../../src/lib/http/respond.mjs'
import { prepareClassifierBody } from '../../src/lib/protocol/request-purpose.mjs'
import { rememberRustHealth, clearRustHealthCache } from '../../src/lib/transport/kernel-router.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const cli = process.env.KIN_AUTOMODE_CLI || path.join(root, 'share/wrap-cli/cli-node')
const kernelBin = process.env.KIN_AUTOMODE_KERNEL || path.join(root, 'bin/kin-kernel')
const parseXmlBlock = parseClassifierXmlBlock

function unixRequest(socketPath, token, endpoint, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: endpoint,
        method: payload ? 'POST' : 'GET',
        headers: { 'x-internal-token': token, 'content-type': 'application/json' },
        timeout: 10000,
      },
      (res) => {
        let text = ''
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }))
      },
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('fixture socket timeout')))
    req.end(payload ? JSON.stringify(payload) : undefined)
  })
}

async function harness(t, layout = 'zero', cliPath = cli) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-automode-e2e-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const captured = []
  const capturedHeaders = []
  const pending = []
  const upstream = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    if (!req.url.startsWith('/v1/messages')) return res.writeHead(404).end()
    const body = JSON.parse(raw)
    captured.push(body)
    capturedHeaders.push({ ...req.headers })
    const marker = JSON.stringify(body.messages)
    const errorStatus = /CASE_HTTP_(\d+)/.exec(marker)?.[1]
    if (errorStatus) {
      const status = Number(errorStatus)
      res.writeHead(status, {
        'content-type': 'application/json',
        'request-id': 'req_classifier_error',
        'retry-after': '13',
      })
      return res.end(
        JSON.stringify({
          type: 'error',
          error: {
            type:
              status === 429 ? 'rate_limit_error' : status === 401 ? 'authentication_error' : 'invalid_request_error',
            code: 'fixture_error',
            message: 'classifier fixture rejected',
          },
        }),
      )
    }
    const emit = () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_classifier_fixture' })
      const legacy = body.tool_choice?.name === 'classify_result'
      const severity = JSON.stringify(body.system).includes('<severity>')
      const stopSequence = body.stop_sequences?.[0]
      const stop = marker.includes('CASE_MAX')
        ? 'max_tokens'
        : legacy
          ? 'tool_use'
          : stopSequence
            ? 'stop_sequence'
            : 'end_turn'
      const events = [
        {
          type: 'message_start',
          message: {
            id: 'msg_classifier_fixture',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 20,
              output_tokens: 0,
              cache_read_input_tokens: 7,
              cache_creation_input_tokens: 3,
              cache_creation: { ephemeral_1h_input_tokens: 3, ephemeral_5m_input_tokens: 0 },
            },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: legacy
            ? { type: 'tool_use', id: 'tool_fixture', name: 'classify_result', input: {} }
            : { type: 'text', text: '' },
        },
        ...(legacy
          ? [
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'input_json_delta', partial_json: '{"thinking":"checked",' },
              },
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'input_json_delta', partial_json: '"shouldBlock":false,"reason":"allowed"}' },
              },
            ]
          : [
              {
                type: 'content_block_delta',
                index: 0,
                delta: {
                  type: 'text_delta',
                  text: marker.includes('CASE_EMPTY')
                    ? ''
                    : marker.includes('CASE_BLOCK')
                      ? '<block>yes'
                      : severity
                        ? '<severity>3'
                        : '<block>no',
                },
              },
            ]),
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: stop, stop_sequence: stop === 'stop_sequence' ? stopSequence : null },
          usage: { output_tokens: 5 },
        },
        { type: 'message_stop' },
      ]
      if (marker.includes('CASE_THINKING')) {
        for (const event of events) if (event.index !== undefined) event.index++
        events.splice(
          1,
          0,
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'fixture reasoning' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'fixture_signature' } },
          { type: 'content_block_stop', index: 0 },
        )
      }
      if (marker.includes('CASE_SSE_ERROR'))
        events.splice(3, events.length, {
          type: 'error',
          error: {
            type: 'rate_limit_error',
            code: 'fixture_sse_error',
            message: 'classifier SSE rejected',
            status: 429,
            retry_after: '13',
          },
        })
      for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      res.end()
    }
    if (marker.includes('CASE_INTERRUPT')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_interrupted","content":[],"usage":{"input_tokens":1}}}\n\n',
      )
      setTimeout(() => res.destroy(), 20)
      return
    }
    if (marker.includes('CASE_CANCEL')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      return
    }
    if (marker.includes('CASE_CONCURRENT')) {
      pending.push(emit)
      if (pending.length === 2) pending.splice(0).forEach((fn) => fn())
      return
    }
    emit()
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    upstream.closeAllConnections()
    await new Promise((resolve) => upstream.close(resolve))
  })
  const socketPath = path.join(temp, 'kernel.sock')
  const token = 'local-classifier-token'
  const tokenPath = path.join(temp, 'internal.token')
  fs.writeFileSync(tokenPath, token)
  const homeDir = path.join(temp, 'cli-home')
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true })
  const credentialPath = path.join(homeDir, '.claude', 'credentials.json')
  fs.writeFileSync(credentialPath, JSON.stringify({ anthropicApiKey: { apiKey: 'local-fixture-key' } }))
  const configPath = path.join(temp, 'kernel.json')
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      vm_id: 'vm-01',
      socket_path: socketPath,
      credential_path: credentialPath,
      internal_token: token,
      provider: 'local_cli',
      claude_bin: cliPath,
      slots_per_worker: 2,
      system_layout: layout,
      timezone: 'America/New_York',
      test_endpoints: true,
      anthropic_base_url: `http://127.0.0.1:${upstream.address().port}`,
    }),
  )
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: temp,
    ANTHROPIC_API_KEY: 'local-fixture-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    NO_PROXY: '127.0.0.1,localhost',
    KIN_ENVELOPE_PATH: path.join(temp, 'no-envelope.json'),
  }
  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'KIN_SOCKS5',
    'KIN_HTTPS_PROXY',
    'KIN_CLAUDE_AI_OAUTH_JSON',
    'KIN_CLAUDE_CODE_OAUTH_TOKEN',
  ])
    delete env[key]
  const kernel = spawn(kernelBin, ['--gateway-worker', '--config', configPath], {
    cwd: temp,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const closed = once(kernel, 'close')
  let log = ''
  kernel.stdout.on('data', (c) => {
    log += c
  })
  kernel.stderr.on('data', (c) => {
    log += c
  })
  t.after(async () => {
    kernel.kill('SIGKILL')
    await closed
  })
  for (let i = 0; i < 100 && !fs.existsSync(socketPath) && kernel.exitCode == null; i++)
    await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(fs.existsSync(socketPath), log.slice(-1200))
  const health = JSON.parse((await unixRequest(socketPath, token, '/internal/health')).text)
  const vm = {
    id: 'vm-01',
    claude: { mode: 'api-key' },
    runtime: { kernel_socket: socketPath, worker_token_file: tokenPath, worker_run_dir: temp },
  }
  const exec = { vmId: vm.id, vm, homeDir, oauth: {}, timezone: 'UTC' }
  const routing = {
    inference: { engine: 'rust', health_ttl_ms: 60000 },
    compatibility: { persona_preset: 'official_full', min_max_tokens: 128, detect_proxied_official_cc: true },
    failover: { stream_keepalive_ms: 0 },
  }
  const routingPath = path.join(temp, 'routing.json')
  fs.writeFileSync(routingPath, JSON.stringify(routing))
  const previousKernelBin = process.env.KIN_KERNEL_BIN
  process.env.KIN_KERNEL_BIN = kernelBin
  t.after(() => {
    if (previousKernelBin === undefined) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = previousKernelBin
  })
  rememberRustHealth(exec, { ok: true, health })
  t.after(() => clearRustHealthCache(vm.id))
  let scheduled = 0
  const logs = []
  const cfg = {
    rewrite: { enabled: false },
    intercept: { rules: [] },
    distill: { enabled: false },
    limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 8000, stream_idle_timeout_ms: 8000 },
    paths: { project: temp, data: temp },
  }
  const respond = createRespond(cfg)
  const handler = createHandleProtocol({
    ...respond,
    readBody,
    cfg,
    requireAuth: () => true,
    requestLog: { start: () => ({ request_id: 'req_classifier_gateway' }), finish: (_ctx, bag) => logs.push(bag) },
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    groupsRepo: { rateMultiplier: () => 1 },
    routingConfigPath: routingPath,
    routingConfig: routing,
    apiKeyStore: {},
    accountQuota: {},
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    failoverRunner: {
      async run(opts) {
        scheduled++
        const candidate = { vmId: vm.id, accountId: 'fixture-account', vm, exec }
        const prepared = await opts.applyAttempt(opts.canonicalBody, candidate)
        return opts.callAttempt({
          candidate,
          body: prepared.body,
          attemptMeta: prepared.meta,
          signal: opts.signal,
          deliveryMode: opts.deliveryMode,
          onCommit() {},
        })
      },
    },
  })
  const gateway = http.createServer((req, res) => {
    req.apiKeyKind = 'master'
    handler.handleProtocol(req, res, 'anthropic.messages', '/v1/messages').catch((error) => {
      res.writeHead(500)
      res.end(String(error.stack))
    })
  })
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    gateway.closeAllConnections()
    await new Promise((resolve) => gateway.close(resolve))
  })
  const send = async (body, { billing = true, headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${gateway.address().port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'claude-cli/2.1.293 (external, sdk-cli)',
        ...headers,
      },
      body: JSON.stringify({
        ...body,
        metadata: { user_id: { device_id: 'fixture-device', session_id: 'fixture-session' } },
        system: [
          ...(billing
            ? [
                {
                  type: 'text',
                  text: 'x-anthropic-billing-header: cc_version=2.1.293; cc_entrypoint=sdk-cli; cch=00000;',
                },
              ]
            : []),
          ...body.system,
        ],
      }),
    })
    const text = await response.text()
    return { status: response.status, text, headers: response.headers }
  }
  return {
    captured,
    capturedHeaders,
    health,
    send,
    logs,
    scheduled: () => scheduled,
    getHealth: async () => JSON.parse((await unixRequest(socketPath, token, '/internal/health')).text),
    setHealth: (value) => rememberRustHealth(exec, { ok: true, health: value }),
    direct: (payload) => unixRequest(socketPath, token, '/internal/v1/messages', payload),
    cancel: (request_id) => unixRequest(socketPath, token, '/internal/v1/cancel', { request_id }),
  }
}

for (const layout of ['zero', 'identity'])
  test(`actual Node → kernel → CLI classifier wire and responses (${layout})`, { timeout: 30000 }, async (t) => {
    const h = await harness(t, layout)
    assert.equal(h.health.classifier_request_context, true)
    for (const [verdict, text] of [
      ['block', '<block>no'],
      ['severity', '<severity>3'],
    ])
      for (const stage of ['xml_s1', 'fast', 'xml_s2']) {
        const input = classifierFixture({ stage, verdict })
        const result = await h.send(input)
        assert.equal(result.status, 200, result.text)
        const response = JSON.parse(result.text)
        assert.equal(response.id, 'msg_classifier_fixture')
        assert.equal(response.content[0].text, text)
        assert.equal(response.stop_sequence, stage === 'xml_s1' ? input.stop_sequences[0] : null)
        const wire = h.captured.at(-1)
        assert.deepEqual(wire.thinking, { type: 'disabled' })
        assert.equal(wire.temperature, 0)
        assert.equal(wire.max_tokens, input.max_tokens)
        assert.deepEqual(wire.stop_sequences, input.stop_sequences)
        assert.equal(wire.output_config, undefined)
        assert.equal(wire.context_management, undefined)
        assert.deepEqual(
          wire.system.filter((b) => !b.text.startsWith('x-anthropic-billing-header:')),
          input.system,
        )
        assert.deepEqual(wire.messages, input.messages)
        assert.equal(wire.request_context, undefined)
        assert.equal(response.usage.cache_read_input_tokens, 7)
      }
    const stream = await h.send({ ...classifierFixture(), stream: true })
    assert.equal(stream.status, 200, stream.text)
    assert.match(stream.text, /"stop_sequence":"<\/block>"/)
    assert.match(stream.text, /message_stop/)
    const legacy = await h.send(classifierFixture({ format: 'tool' }))
    assert.equal(legacy.status, 200, legacy.text)
    assert.deepEqual(JSON.parse(legacy.text).content[0].input, {
      thinking: 'checked',
      shouldBlock: false,
      reason: 'allowed',
    })
    assert.deepEqual(h.captured.at(-1).tool_choice, { type: 'tool', name: 'classify_result' })
    const count = h.captured.length
    const incompatible = await h.send(classifierFixture({ model: 'claude-opus-5-5', format: 'tool' }))
    assert.equal(incompatible.status, 400, incompatible.text)
    assert.equal(JSON.parse(incompatible.text).error.code, 'classifier_model_incompatible')
    assert.equal(h.captured.length, count)
    const adaptive = await h.send(classifierFixture({ model: 'claude-sonnet-5-5' }))
    assert.equal(adaptive.status, 200, adaptive.text)
    assert.equal(h.captured.at(-1).max_tokens, 2112)
    assert.equal(h.captured.at(-1).model, 'claude-sonnet-5-5')
    assert.deepEqual(h.captured.at(-1).thinking, { type: 'adaptive' })
    assert.equal(h.captured.at(-1).temperature, undefined)
    const direct = await h.direct({
      body: prepareClassifierBody(classifierFixture()),
      request_context: { purpose: 'auto_mode_classifier', format: 'xml', stage: 'xml_s1' },
      stream: false,
    })
    assert.equal(direct.status, 200, direct.text)
    assert.equal(JSON.parse(direct.text).id, 'msg_classifier_fixture')
    assert.equal(JSON.parse(direct.text).stop_sequence, '</block>')
    const invalid = await h.direct({
      body: classifierFixture(),
      request_context: { purpose: 'auto_mode_classifier', format: 'unknown' },
    })
    assert.equal(invalid.status, 400, invalid.text)
    assert.equal(JSON.parse(invalid.text).error.code, 'invalid_request_context')
    assert.ok(h.logs.some((log) => log.classifier?.layer === 'node_object' && log.classifier?.before.max_tokens === 64))
    for (const [format, verdict] of [
      ['xml', 'block'],
      ['xml', 'severity'],
      ['tool', 'block'],
    ]) {
      const relayed = classifierFixture({ format, verdict })
      const result = await h.send(relayed, {
        billing: false,
        headers: { 'user-agent': 'Go-http-client/1.1', 'anthropic-beta': 'claude-code-20250219' },
      })
      assert.equal(result.status, 200, result.text)
      assert.equal(h.captured.at(-1).max_tokens, relayed.max_tokens)
      assert.deepEqual(
        h.captured.at(-1).system.filter((b) => !b.text.startsWith('x-anthropic-billing-header:')),
        relayed.system,
      )
    }
    // #220: 2.1.283 CLI sends severity classifiers without a billing line.
    const severity = classifierFixture({ verdict: 'severity' })
    severity.system.push({ type: 'text', text: '## Session Context\nCWD: /work' })
    const direct220 = await h.send(severity, {
      billing: false,
      headers: { 'user-agent': 'claude-cli/2.1.283 (external, cli)' },
    })
    assert.equal(direct220.status, 200, direct220.text)
    assert.equal(JSON.parse(direct220.text).stop_sequence, '</severity>')
    assert.equal(h.captured.at(-1).max_tokens, 64)
    assert.deepEqual(h.captured.at(-1).stop_sequences, ['</severity>'])
    assert.deepEqual(
      h.captured.at(-1).system.filter((b) => !b.text.startsWith('x-anthropic-billing-header:')),
      severity.system,
    )
  })

function withCase(body, marker) {
  const input = structuredClone(body)
  input.messages[0].content[2].text = `WebSearch {"query":"${marker}"}\n`
  return input
}

test('classifier terminal/error/cancel/concurrency boundaries through actual ELF', { timeout: 30000 }, async (t) => {
  const h = await harness(t)
  const context = { purpose: 'auto_mode_classifier', format: 'xml', stage: 'xml_s1' }
  for (const marker of ['CASE_BLOCK', 'CASE_EMPTY', 'CASE_MAX']) {
    const count = h.captured.length
    const result = await h.send(withCase(classifierFixture(), marker))
    assert.equal(result.status, 200, result.text)
    const body = JSON.parse(result.text)
    assert.equal(
      body.content[0].text,
      marker === 'CASE_EMPTY' ? '' : marker === 'CASE_BLOCK' ? '<block>yes' : '<block>no',
    )
    assert.equal(parseXmlBlock(body.content[0].text), marker === 'CASE_EMPTY' ? null : marker === 'CASE_BLOCK')
    assert.equal(body.stop_reason, marker === 'CASE_MAX' ? 'max_tokens' : 'stop_sequence')
    assert.equal(body.usage.output_tokens, 5)
    assert.equal(h.captured.length, count + 1)
  }
  for (const status of [400, 401, 403, 429, 500, 529]) {
    const count = h.captured.length
    const result = await h.direct({
      body: withCase(classifierFixture(), `CASE_HTTP_${status}`),
      request_context: context,
      stream: false,
    })
    assert.equal(result.status, status, result.text)
    assert.match(result.text, /classifier fixture rejected/)
    assert.equal(result.headers['retry-after'], '13')
    assert.equal(result.headers['request-id'], 'req_classifier_error')
    assert.equal(JSON.parse(result.text).error.upstream_code, 'fixture_error')
    assert.equal(h.captured.length, count + 1)
  }
  const error = await h.direct({
    body: withCase(classifierFixture(), 'CASE_SSE_ERROR'),
    request_context: context,
    stream: false,
  })
  assert.equal(error.status, 429, error.text)
  assert.match(error.text, /classifier SSE rejected/)
  assert.equal(error.headers['retry-after'], '13')
  assert.equal(JSON.parse(error.text).error.upstream_code, 'fixture_sse_error')
  const interrupted = await h.direct({
    body: withCase(classifierFixture(), 'CASE_INTERRUPT'),
    request_context: context,
    stream: false,
  })
  assert.equal(interrupted.status, 502, interrupted.text)
  assert.equal(JSON.parse(interrupted.text).error.code, 'upstream_stream_interrupted')
  const thinking = await h.send(
    withCase(classifierFixture({ stage: 'xml_s2', model: 'claude-sonnet-5-5' }), 'CASE_THINKING'),
  )
  assert.equal(thinking.status, 200, thinking.text)
  assert.deepEqual(JSON.parse(thinking.text).content[0], {
    type: 'thinking',
    thinking: 'fixture reasoning',
    signature: 'fixture_signature',
  })
  assert.equal(parseXmlBlock('<thinking><block>yes</block></thinking><block>no'), false)
  const first = withCase(classifierFixture(), 'CASE_CONCURRENT_A')
  first.system[0].cache_control.ttl = '5m'
  first.messages[0].content[2].cache_control.ttl = '5m'
  const second = withCase(classifierFixture({ model: 'claude-sonnet-5-5' }), 'CASE_CONCURRENT_B')
  const results = await Promise.all([h.send(first), h.send(second)])
  for (const result of results) assert.equal(result.status, 200, result.text)
  const a = h.captured.find((b) => JSON.stringify(b.messages).includes('CASE_CONCURRENT_A'))
  const b = h.captured.find((b) => JSON.stringify(b.messages).includes('CASE_CONCURRENT_B'))
  assert.deepEqual(a.thinking, { type: 'disabled' })
  assert.equal(a.max_tokens, 64)
  assert.equal(a.system.at(-1).cache_control.ttl, '5m')
  assert.deepEqual(b.thinking, { type: 'adaptive' })
  assert.equal(b.max_tokens, 2112)
  assert.equal(b.system.at(-1).cache_control.ttl, '1h')
  const running = h.direct({
    body: withCase(classifierFixture(), 'CASE_CANCEL'),
    request_context: context,
    stream: true,
    request_id: 'cancel-classifier',
  })
  for (let i = 0; i < 100 && !h.captured.some((b) => JSON.stringify(b.messages).includes('CASE_CANCEL')); i++)
    await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(JSON.parse((await h.cancel('cancel-classifier')).text).cancelled, true)
  await running
  for (let i = 0; i < 100 && (await h.getHealth()).ready_slots !== 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal((await h.getHealth()).ready_slots, 2)
  const reused = await h.send(classifierFixture())
  assert.equal(reused.status, 200, reused.text)
  const mixed = await Promise.all([
    h.send(withCase(classifierFixture(), 'CASE_CONCURRENT_CLASSIFIER')),
    h.send({
      model: 'claude-sonnet-5-5',
      max_tokens: 64,
      thinking: { type: 'disabled' },
      system: [{ type: 'text', text: 'Ordinary concurrent prompt' }],
      messages: [{ role: 'user', content: 'CASE_CONCURRENT_ORDINARY' }],
    }),
  ])
  for (const result of mixed) assert.equal(result.status, 200, result.text)
  assert.equal(h.captured.find((b) => JSON.stringify(b.messages).includes('CASE_CONCURRENT_CLASSIFIER')).max_tokens, 64)
  assert.equal(h.captured.find((b) => JSON.stringify(b.messages).includes('CASE_CONCURRENT_ORDINARY')).max_tokens, 128)
  const ordinary = await h.send({
    model: 'claude-sonnet-5-5',
    max_tokens: 64,
    thinking: { type: 'disabled' },
    system: [{ type: 'text', text: 'Ordinary caller prompt' }],
    messages: [{ role: 'user', content: 'hello' }],
    request_context: context,
  })
  assert.equal(ordinary.status, 200, ordinary.text)
  const wire = h.captured.at(-1)
  assert.equal(wire.max_tokens, 128)
  assert.deepEqual(wire.thinking, { type: 'adaptive', display: 'summarized' })
  assert.equal(wire.request_context, undefined)
  assert.equal(wire.system.at(-1).text, 'Ordinary caller prompt')
  assert.equal(wire.messages.at(-1).role, 'user')
  h.setHealth({ ...h.health, classifier_request_context: false })
  const count = h.captured.length
  const unsupported = await h.send(classifierFixture())
  assert.equal(unsupported.status, 400, unsupported.text)
  assert.equal(JSON.parse(unsupported.text).error.code, 'classifier_runtime_unsupported')
  assert.equal(h.captured.length, count)
})

test('actual kernel+CLI ELF keeps per-message effort and top-level high', { timeout: 30000 }, async (t) => {
  const h = await harness(t)
  const beta = 'mid-conversation-output-config-2026-07-01'
  const hasBeta = (wire, headers) =>
    (Array.isArray(wire?.betas) && wire.betas.includes(beta)) ||
    String(headers?.['anthropic-beta'] || '').includes(beta)
  const efforts = (wire) =>
    (wire.messages || [])
      .filter((message) => message?.output_config?.effort)
      .map((message) => message.output_config.effort)
  const roles = (wire) => (wire.messages || []).map((message) => message.role)
  const cases = [
    {
      name: 'control_after_new_user',
      turns: [
        { role: 'user', content: 'Reply OK.' },
        { role: 'assistant', content: 'OK.' },
        { role: 'user', content: 'Reply OK again.' },
        { role: 'system', content: [], output_config: { effort: 'medium' } },
      ],
      wantEfforts: ['medium'],
    },
    {
      name: 'control_before_new_user',
      turns: [
        { role: 'user', content: 'Reply OK.' },
        { role: 'assistant', content: 'OK.' },
        { role: 'system', content: [], output_config: { effort: 'medium' } },
        { role: 'user', content: 'Reply OK again.' },
      ],
      wantEfforts: ['medium'],
    },
    {
      name: 'historical',
      turns: [
        { role: 'user', content: 'one' },
        { role: 'system', content: [], output_config: { effort: 'low' } },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'two' },
      ],
      wantEfforts: ['low'],
    },
    {
      name: 'repeated',
      turns: [
        { role: 'user', content: 'one' },
        { role: 'system', content: [], output_config: { effort: 'low' } },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'two' },
        { role: 'system', content: [], output_config: { effort: 'max' } },
        { role: 'assistant', content: 'ok2' },
        { role: 'user', content: 'three' },
        { role: 'system', content: [], output_config: { effort: 'medium' } },
      ],
      wantEfforts: ['low', 'max', 'medium'],
    },
  ]
  for (const item of cases) {
    const result = await h.send({
      model: 'claude-opus-5-5',
      max_tokens: 64,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: [{ type: 'text', text: 'Ordinary caller prompt' }],
      messages: item.turns,
    })
    assert.equal(result.status, 200, `${item.name}: ${result.text}`)
    const wire = h.captured.at(-1)
    const headers = h.capturedHeaders.at(-1)
    assert.equal(wire.output_config.effort, 'high', item.name)
    assert.deepEqual(roles(wire), roles({ messages: item.turns }), item.name)
    assert.deepEqual(efforts(wire), item.wantEfforts, `${item.name} ${JSON.stringify(roles(wire))}`)
    assert.ok(
      hasBeta(wire, headers),
      `${item.name} missing ${beta} body.betas=${JSON.stringify(wire.betas)} header=${headers?.['anthropic-beta']}`,
    )
  }
})
test('actual kernel+CLI ELF drops thinking without a usable signature on final wire', { timeout: 30000 }, async (t) => {
  const h = await harness(t)
  const result = await h.send({
    model: 'claude-opus-5-5',
    max_tokens: 256,
    thinking: { type: 'adaptive' },
    system: [{ type: 'text', text: 'Drop thinking blocks that have no usable signature.' }],
    messages: [
      { role: 'user', content: 'Continue the prior turn.' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'existing thinking', signature: 'existing-signature-0123456789' },
          { type: 'thinking', thinking: 'missing signature' },
          { type: 'thinking', thinking: '', signature: 'empty-thinking-signature' },
          { type: 'redacted_thinking', data: 'redacted-thinking' },
          { type: 'text', text: 'previous answer' },
        ],
      },
      { role: 'user', content: 'Now answer.' },
    ],
  })
  assert.equal(result.status, 200, result.text)
  const wireMessage = h.captured.at(-1).messages.find((message) => message.role === 'assistant')
  assert.ok(wireMessage)
  assert.deepEqual(wireMessage.content, [
    { type: 'thinking', thinking: 'existing thinking', signature: 'existing-signature-0123456789' },
    { type: 'thinking', thinking: '', signature: 'empty-thinking-signature' },
    { type: 'redacted_thinking', data: 'redacted-thinking' },
    { type: 'text', text: 'previous answer' },
  ])
})

test('new kernel refuses classifier context against actual old CLI', {
  timeout: 15000,
  skip: !process.env.KIN_AUTOMODE_OLD_CLI,
}, async (t) => {
  const h = await harness(t, 'zero', process.env.KIN_AUTOMODE_OLD_CLI)
  assert.equal(h.health.classifier_request_context, false)
  const ordinary = await h.direct({ body: classifierFixture(), stream: false })
  assert.equal(ordinary.status, 200, ordinary.text)
  const count = h.captured.length
  const classified = await h.direct({
    body: classifierFixture(),
    request_context: { purpose: 'auto_mode_classifier', format: 'xml' },
  })
  assert.equal(classified.status, 400, classified.text)
  assert.equal(JSON.parse(classified.text).error.code, 'classifier_runtime_unsupported')
  assert.equal(h.captured.length, count)
})
