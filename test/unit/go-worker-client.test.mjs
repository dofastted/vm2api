import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  callGoWorker,
  finalizeWorkerPayload,
  streamGoWorker,
  workerHealth,
  usageFromSseEvent,
  isDownstreamCommitEvent,
  restoreKernelErrorStatus,
  restoreUncommittedHop,
  semanticStatusForStreamError,
} from '../../src/lib/transport/go-worker-client.mjs'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'
import { callerAutoCompactWindow, defaultSeedPolicy, sanitizeInboundBody } from '../../src/lib/protocol/seed-policy.mjs'
import { extractOpenaiUsage } from '../../src/lib/protocol/openai-usage.mjs'
import { callRustKernel, rustKernelHealth } from '../../src/lib/transport/rust-kernel-client.mjs'
import { callCodexKernel, streamCodexKernel } from '../../src/lib/transport/codex-kernel-client.mjs'
import { forwardApi, readApiJson } from '../../src/lib/transport/api-kernel-client.mjs'
import { normalizeRedaction } from '../../src/lib/redaction/policy.mjs'
import { publishRedactionForTests } from '../../src/lib/redaction/runtime.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { classifyUpstreamResult } from '../../src/lib/pool/upstream-error-policy.mjs'

test('restoreUncommittedHop keeps a structured upstream code', () => {
  const restored = restoreUncommittedHop({
    ok: false,
    status: 200,
    committed: false,
    terminalState: 'incomplete',
    body: {
      type: 'error',
      error: { type: 'api_error', code: 'upstream_stream_incomplete', message: 'job idle timeout' },
    },
  })
  assert.equal(restored.body.error.code, 'upstream_stream_incomplete')
  assert.notEqual(restored.body.error.code, 'empty_response')
})

test('a coded kernel stream error keeps its code and the status it names', () => {
  const restored = restoreUncommittedHop({
    ok: false,
    status: 200,
    committed: false,
    terminalState: 'incomplete',
    headers: {},
    body: {
      type: 'error',
      error: {
        type: 'api_error',
        code: 'kernel_unavailable',
        status: 503,
        message: 'native cli host unavailable',
      },
    },
  })
  assert.equal(restored.status, 503)
  assert.equal(restored.body.error.code, 'kernel_unavailable')

  const limited = restoreUncommittedHop({
    ok: false,
    status: 200,
    committed: false,
    headers: {},
    body: {
      type: 'error',
      error: {
        type: 'rate_limit_error',
        code: 'upstream_rate_limit',
        status: 429,
        retry_after: '42',
        message: 'slow down',
      },
    },
  })
  assert.equal(limited.status, 429)
  assert.equal(limited.headers['retry-after'], '42')
})

test('semanticStatusForStreamError reads outer Codex status 500 instead of defaulting to 502', () => {
  assert.equal(
    semanticStatusForStreamError({
      type: 'error',
      status: 500,
      error: {
        type: 'server_error',
        code: 'server_error',
        message: 'An error occurred while processing your request...',
      },
    }),
    500,
  )
  assert.equal(
    semanticStatusForStreamError({
      type: 'error',
      error: { type: 'api_error', code: 'kernel_unavailable', status: 503, message: 'named' },
    }),
    503,
  )
  assert.equal(
    semanticStatusForStreamError({
      type: 'error',
      error: { type: 'server_error', code: 'server_error', message: 'no explicit status' },
    }),
    502,
  )
})
test('server overload errors map to 503 and preserve retry identity', () => {
  const body = {
    type: 'error',
    error: {
      type: 'service_unavailable_error',
      code: 'server_is_overloaded',
      message: 'Our servers are currently overloaded. Please try again later.',
    },
  }
  assert.equal(semanticStatusForStreamError(body), 503)
  const restored = restoreUncommittedHop({
    ok: false,
    status: 200,
    committed: false,
    terminalState: 'incomplete',
    headers: {},
    body,
  })
  assert.equal(restored.status, 503)
  assert.equal(restored.body.error.code, 'server_is_overloaded')
  assert.equal(restored.streamError, true)
})
test('kernel-wrapped server overload restores 503 but explicit status wins', () => {
  const body = {
    type: 'error',
    error: {
      type: 'service_unavailable_error',
      code: 'server_is_overloaded',
      message: 'overloaded',
    },
  }
  const restored = restoreKernelErrorStatus({ ok: false, status: 502, body })
  assert.equal(restored.status, 503)
  assert.equal(restored.body.error.code, 'server_is_overloaded')
  const explicit = restoreKernelErrorStatus({
    ok: false,
    status: 502,
    body: { ...body, error: { ...body.error, status: 502 } },
  })
  assert.equal(explicit.status, 502)
})

test('restoreUncommittedHop reports Codex outer status 500 rather than 502', () => {
  const restored = restoreUncommittedHop({
    ok: false,
    status: 200,
    committed: false,
    terminalState: 'incomplete',
    headers: {},
    body: {
      type: 'error',
      status: 500,
      error: {
        type: 'server_error',
        code: 'server_error',
        message: 'An error occurred while processing your request...',
      },
    },
  })
  assert.equal(restored.status, 500)
  assert.equal(restored.streamError, true)
  assert.equal(restored.terminalState, 'rejected')
  assert.equal(restored.body.error.code, 'server_error')
})

test('setup-token worker envelope is inference-only', () => {
  const out = finalizeWorkerPayload({
    body: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] },
    reqHeaders: { 'user-agent': 'kin-console-test/1.0' },
    exec: { homeDir: '', vm: { claude: { mode: 'setup-token', scope: 'user:inference' } } },
    identity: null,
  })
  assert.equal(out.headers['user-agent'], 'kin-inference/1.0')
  assert.doesNotMatch(String(out.headers['anthropic-beta'] || ''), /claude-code-20250219/)
  assert.match(String(out.headers['anthropic-beta'] || ''), /oauth-2025-04-20/)
})

test('worker canonicalizes passthrough bodies before either kernel', () => {
  const body = {
    model: 'claude-sonnet-5',
    settings: { theme: 'dark' },
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello', annotations: [{ type: 'client-only' }] }],
      },
    ],
    crag_prompt: { mode: 'append', text: 'caller tail' },
  }
  for (const cragPrint of [false, true]) {
    const out = finalizeWorkerPayload({
      body,
      reqHeaders: {},
      exec: {
        homeDir: '',
        vm: { claude: { mode: 'setup-token', scope: 'user:inference' } },
        workerStatus: { runtime_variant: 'crag-v2', capabilities: ['prompt_append'] },
      },
      identity: null,
      cliHop: true,
      cragPrint,
    })
    assert.equal(out.body.settings, undefined)
    assert.deepEqual(out.body.output_config?.format, { type: 'json_schema', schema: { type: 'object' } })
    assert.deepEqual(out.body.messages[0].content, [{ type: 'text', text: 'hello' }])
    assert.deepEqual(out.body.crag_prompt, cragPrint ? body.crag_prompt : undefined)
  }
})

test('cli-hop envelope keeps role=system turns that the VM betas do not declare', () => {
  const body = {
    model: 'claude-opus-5-5',
    system: [{ type: 'text', text: 'main prompt' }],
    messages: [
      { role: 'user', content: 'u1' },
      { role: 'system', content: 'reminder' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ],
  }
  const out = finalizeWorkerPayload({
    body,
    reqHeaders: {},
    // Request fields and their beta gates share the existing CLI body channel.
    exec: { homeDir: '', vm: { claude: { mode: 'setup-token', scope: 'user:inference' } } },
    identity: null,
    cliHop: true,
  })
  // 9ecee337: mid-conversation-system is GA in 2.1.303; role=system stays without the beta.
  assert.ok(!out.body.betas.includes('mid-conversation-system-2026-04-07'))
  assert.deepEqual(
    out.body.messages.map((message) => message.role),
    ['user', 'system', 'assistant', 'user'],
  )
  assert.deepEqual(out.body.system, body.system)
})

test('cli-hop keeps the caller compact window outside settings', () => {
  const inbound = {
    model: 'claude-opus-5-5',
    messages: [{ role: 'user', content: 'hi' }],
    settings: { theme: 'light', env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000', TZ: 'UTC' } },
  }
  const autoCompactWindow = callerAutoCompactWindow(inbound)
  const sanitized = sanitizeInboundBody(inbound, defaultSeedPolicy())
  assert.equal(callerAutoCompactWindow(sanitized), null)
  const prepared = prepareCliHopBody(sanitized, { autoCompactWindow })
  const out = finalizeWorkerPayload({
    body: prepared,
    reqHeaders: {},
    exec: { homeDir: '', vm: { claude: { mode: 'setup-token', scope: 'user:inference' } } },
    identity: null,
    cliHop: true,
  })
  assert.equal(sanitized.settings, undefined)
  assert.equal(out.body.settings, undefined)
  assert.equal(out.body.env, undefined)
  assert.equal(out.body.auto_compact_window, 1000000)
})

test('setup-token cli-hop summarizes hidden thinking by default and keeps updates when passthrough', () => {
  const exec = { homeDir: '', vm: { claude: { mode: 'setup-token', scope: 'user:inference' } } }
  const updates = finalizeWorkerPayload({
    body: {
      model: 'claude-opus-5-5',
      thinking: { type: 'adaptive', display: 'updates' },
      messages: [{ role: 'user', content: 'hi' }],
    },
    reqHeaders: {},
    exec,
    identity: null,
    cliHop: true,
  })
  assert.equal(updates.body.thinking.type, 'adaptive')
  assert.equal(updates.body.thinking.display, 'summarized')
  assert.ok(!updates.body.betas.includes('thinking-display-updates-2026-08-18'))
  assert.ok(!updates.body.betas.includes('claude-code-20250219'))
  const passed = finalizeWorkerPayload({
    body: {
      model: 'claude-opus-5-5',
      thinking: { type: 'adaptive', display: 'updates' },
      messages: [{ role: 'user', content: 'hi' }],
    },
    reqHeaders: {},
    exec,
    identity: null,
    routing: { compatibility: { thinking_display: 'passthrough' } },
    cliHop: true,
  })
  assert.equal(passed.body.thinking.display, 'updates')
  assert.ok(passed.body.betas.includes('thinking-display-updates-2026-08-18'))
})

test('cli-hop appends inline-tools when a message carries a tool_definition', () => {
  const block = {
    type: 'tool_addition',
    tool: {
      type: 'tool_definition',
      definition: { name: 'lookup', description: 'lookup', input_schema: { type: 'object' } },
    },
  }
  const out = finalizeWorkerPayload({
    body: {
      model: 'claude-opus-5-5',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: [{ type: 'text', text: 'note' }, block] },
      ],
    },
    reqHeaders: { 'anthropic-beta': 'inline-tools-2026-09-15' },
    exec: { homeDir: '', vm: { claude: { mode: 'setup-token', scope: 'user:inference' } } },
    identity: null,
    cliHop: true,
  })
  assert.ok(out.body.betas.includes('inline-tools-2026-09-15'))
  assert.equal(out.body.messages[1].content[1].tool.type, 'tool_definition')
  const plain = finalizeWorkerPayload({
    body: { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] },
    reqHeaders: { 'anthropic-beta': 'inline-tools-2026-09-15' },
    exec: { homeDir: '', vm: { claude: { mode: 'setup-token', scope: 'user:inference' } } },
    identity: null,
    cliHop: true,
  })
  assert.ok(!plain.body.betas.includes('inline-tools-2026-09-15'))
})

test('CRAG v2 receives the preset model boundary only from a worker that consumes it', () => {
  const body = { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] }
  const reqHeaders = {}
  const vm = { dataplane: 'crag', crag_kernel_version: 'v2', claude: { mode: 'setup-token', scope: 'user:inference' } }
  const crag = finalizeWorkerPayload({
    body,
    reqHeaders,
    exec: {
      homeDir: '',
      vm,
      workerStatus: { runtime_variant: 'crag-v2', capabilities: ['linux_tui_pty'] },
    },
    identity: null,
  })
  assert.equal(crag.body.crag_model.id, 'claude-haiku-4-5-20251001')
  assert.equal(crag.body.crag_model.capabilities.supports_context_management, false)
  assert.equal(crag.body.crag_model.capabilities.supports_effort, false)
  assert.equal(crag.body.crag_model.params.max_tokens_default, 8192)
  assert.equal(crag.body.crag_model.params.max_tokens_cap, 64000)
  assert.ok(crag.body.crag_model.betas.drop.includes('context-management-2025-06-27'))
  const forwarded = finalizeWorkerPayload({
    body: { ...body, crag_prompt: { mode: 'append', text: 'caller' }, crag_model: { id: 'leaked' } },
    reqHeaders,
    exec: { homeDir: '', vm, workerStatus: { runtime_variant: 'crag-v2', execution_mode: 'crag_slots' } },
    identity: null,
  })
  assert.equal(forwarded.body.crag_model, undefined)
  assert.equal(forwarded.body.crag_prompt, undefined)
  const wrap = finalizeWorkerPayload({
    body,
    reqHeaders,
    exec: { homeDir: '', vm: { dataplane: 'wrap', claude: { mode: 'setup-token', scope: 'user:inference' } } },
    identity: null,
  })
  assert.equal(wrap.body.crag_model, undefined)
})

test('a wrap VM does not inherit a global CRAG v2 route', () => {
  const body = {
    model: 'claude-haiku-4-5',
    crag_prompt: { mode: 'append', text: 'caller' },
    messages: [{ role: 'user', content: 'hi' }],
  }
  const wrap = finalizeWorkerPayload({
    body,
    reqHeaders: {},
    exec: { homeDir: '', vm: { dataplane: 'wrap' } },
    routing: { inference: { dataplane: 'crag', crag_kernel_version: 'v2' } },
    identity: null,
  })
  assert.equal(wrap.body.crag_model, undefined)
  assert.equal(wrap.body.crag_prompt, undefined)
  const forced = finalizeWorkerPayload({
    body,
    reqHeaders: {},
    exec: {
      homeDir: '',
      vm: { dataplane: 'wrap' },
      workerStatus: { runtime_variant: 'crag-v2', capabilities: ['linux_tui_pty'] },
    },
    identity: null,
    cragPrint: false,
  })
  assert.equal(forced.body.crag_model, undefined)
  // A live native worker can override stale VM metadata, but model support is not prompt support.
  const modelOnly = finalizeWorkerPayload({
    body,
    reqHeaders: {},
    exec: {
      homeDir: '',
      vm: { dataplane: 'wrap' },
      workerStatus: { runtime_variant: 'crag-v2', capabilities: ['model_directive'] },
    },
    identity: null,
  })
  assert.equal(modelOnly.body.crag_model.id, 'claude-haiku-4-5-20251001')
  assert.equal(Object.hasOwn(modelOnly.body, 'crag_prompt'), false)
})

const unix = process.platform !== 'win32'
const unixTest = unix ? test : test.skip

async function fixture(handler) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-go-client-'))
  const slot = path.join(root, 'vm-01')
  const runDir = path.join(slot, 'run')
  const homeDir = path.join(slot, 'cli-home')
  fs.mkdirSync(runDir, { recursive: true })
  fs.mkdirSync(homeDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'internal.token'), 'internal-test\n', { mode: 0o600 })
  const socket = path.join(runDir, 'worker.sock')
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, resolve)
  })
  return {
    exec: {
      vmId: 'vm-01',
      homeDir,
      vm: {
        runtime: {
          worker_socket: socket,
          worker_run_dir: runDir,
          worker_token_file: path.join(runDir, 'internal.token'),
        },
      },
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

function writeData(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

function gate() {
  let release
  const ready = new Promise((resolve) => {
    release = resolve
  })
  return { ready, release }
}

unixTest('callGoWorker sends envelope over authenticated Unix socket', async () => {
  const fx = await fixture(async (req, res) => {
    assert.equal(req.headers['x-internal-token'], 'internal-test')
    assert.equal(req.headers['x-kin-internal-token'], 'internal-test')
    assert.equal(req.url, '/internal/v1/messages')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    assert.equal(envelope.body.model, 'claude-test')
    assert.equal(envelope.cache_ttl, '1h')
    assert.equal(envelope.preserve_cache_breakpoints, false)
    assert.equal(envelope.stream, false)
    assert.match(envelope.headers['user-agent'], /^claude-cli\//)
    res.setHeader('content-type', 'application/json')
    res.setHeader('x-terminal-state', 'verified')
    res.end(
      JSON.stringify({
        type: 'message',
        id: 'msg_test',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    )
  })
  try {
    const result = await callGoWorker({
      exec: fx.exec,
      body: { model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] },
      cacheTtl: '1h',
      reqHeaders: { 'user-agent': 'test-client' },
    })
    assert.equal(result.ok, true)
    assert.equal(result.terminalState, 'verified')
    assert.equal(result.body.content[0].text, 'ok')
  } finally {
    await fx.close()
  }
})

unixTest('callGoWorker puts caller cwd only in an authorized native Unix socket envelope', async () => {
  const posted = []
  const fx = await fixture(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    posted.push({
      method: req.method,
      url: req.url,
      token: req.headers['x-kin-internal-token'],
      envelope: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    })
    res.writeHead(200, { 'content-type': 'application/json', 'x-terminal-state': 'verified' })
    res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }))
  })
  const callerCwd = '/synthetic/work space/项目'
  const body = {
    model: 'claude-haiku-4-5',
    messages: [{ role: 'user', content: 'hi' }],
    crag_prompt: { mode: 'append', text: 'caller guidance' },
    caller_cwd: '/synthetic/forged-body-value',
  }
  try {
    for (const [name, variant, capabilities, cwd, cragPrint, expectCwd, expectPrompt] of [
      ['authorized', 'crag-v2', ['caller_cwd', 'prompt_append'], callerCwd, null, true, true],
      ['cwd only', 'crag-v2', ['caller_cwd'], callerCwd, null, true, false],
      ['append only', 'crag-v2', ['prompt_append'], callerCwd, null, false, true],
      ['not native', 'cli-node', ['caller_cwd', 'prompt_append'], callerCwd, null, false, false],
      ['print disabled', 'crag-v2', ['caller_cwd', 'prompt_append'], callerCwd, false, false, false],
      ['no trusted cwd', 'crag-v2', ['caller_cwd', 'prompt_append'], null, null, false, true],
    ]) {
      const result = await callGoWorker({
        exec: { ...fx.exec, workerStatus: { runtime_variant: variant, capabilities } },
        body,
        callerCwd: cwd,
        cragPrint,
        timeoutMs: 3000,
      })
      assert.equal(result.ok, true, name)
      assert.equal(posted.length, 1, name)
      const { method, url, token, envelope } = posted.pop()
      assert.deepEqual({ method, url, token }, { method: 'POST', url: '/internal/v1/messages', token: 'internal-test' })
      assert.equal(Object.hasOwn(envelope, 'caller_cwd'), expectCwd, name)
      if (expectCwd) assert.equal(envelope.caller_cwd, callerCwd, name)
      assert.equal(Object.hasOwn(envelope.body, 'caller_cwd'), false, name)
      assert.equal(JSON.stringify(envelope.body).includes(callerCwd), false, name)
      assert.equal(JSON.stringify(envelope).includes(body.caller_cwd), false, name)
      assert.deepEqual(envelope.body.crag_prompt, expectPrompt ? body.crag_prompt : undefined, name)
      assert.equal(Object.hasOwn(envelope.body, 'crag_model'), false, name)
    }
  } finally {
    await fx.close()
  }
})

unixTest('redaction masks caller cwd and omits it when the masked value is no longer absolute', async (t) => {
  const rawCwd = '/synthetic/private-workspace'
  const posted = []
  const fx = await fixture(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    posted.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    res.writeHead(200, { 'content-type': 'application/json', 'x-terminal-state': 'verified' })
    res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [] }))
  })
  t.after(async () => {
    publishRedactionForTests(null)
    await fx.close()
  })
  const policy = normalizeRedaction({ enabled: true, secrets: true, personal: false })
  const exec = { ...fx.exec, workerStatus: { runtime_variant: 'crag-v2', capabilities: ['caller_cwd'] } }
  const body = { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: rawCwd }] }
  for (const replacement of ['/synthetic/{{R_PATH_fixture}}', '{{R_PATH_fixture}}']) {
    publishRedactionForTests({
      enabled: true,
      ready: true,
      policy,
      client: {
        async mask({ body }) {
          return { body: body.replaceAll(rawCwd, replacement) }
        },
        async restore({ body }) {
          return { body }
        },
      },
    })
    const result = await callGoWorker({
      exec,
      body,
      callerCwd: rawCwd,
      routing: { redaction: policy },
      redactionPrincipal: 'fixture-principal',
      timeoutMs: 3000,
    })
    assert.equal(result.ok, true)
    assert.equal(posted.length, 1)
    const envelope = posted.pop()
    assert.equal(JSON.stringify(envelope).includes(rawCwd), false)
    assert.ok(JSON.stringify(envelope.body.messages).includes(replacement))
    assert.equal(envelope.caller_cwd, replacement.startsWith('/') ? replacement : undefined)
  }
})

unixTest('prebuilt call and stream envelopes cannot carry caller cwd', async (t) => {
  const posted = []
  const fx = await fixture(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    posted.push(envelope)
    if (envelope.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-terminal-state': 'verified' })
      writeData(res, { type: 'message_start', message: { id: 'msg_prebuilt' } })
      writeData(res, { type: 'message_stop' })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json', 'x-terminal-state': 'verified' })
    res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [] }))
  })
  t.after(() => fx.close())
  const callerCwd = '/synthetic/untrusted-prebuilt'
  const body = { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] }
  for (const [send, stream] of [
    [callGoWorker, false],
    [streamGoWorker, true],
  ]) {
    const result = await send({
      exec: { ...fx.exec, workerStatus: { runtime_variant: 'crag-v2', capabilities: ['caller_cwd'] } },
      envelope: { body: { ...body, caller_cwd: callerCwd }, caller_cwd: callerCwd, stream },
      timeoutMs: 3000,
    })
    assert.equal(result.ok, true)
    assert.equal(posted.length, 1)
    const sent = posted.pop()
    assert.equal(Object.hasOwn(sent, 'caller_cwd'), false)
    assert.equal(sent.body.caller_cwd, undefined)
    assert.deepEqual(sent.body.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
  }
})

unixTest('callGoWorker and streamGoWorker report exactly the envelope they post', async () => {
  const posted = []
  const fx = await fixture(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    posted.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    if (posted.length === 1) {
      res.setHeader('content-type', 'application/json')
      res.setHeader('x-terminal-state', 'verified')
      res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }))
      return
    }
    res.setHeader('content-type', 'text/event-stream')
    res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_env"}}\n\n')
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
    res.end()
  })
  try {
    const reported = []
    const body = {
      model: 'claude-opus-5-5',
      system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.296.abc; cc_entrypoint=sdk-cli;' }],
      messages: [{ role: 'user', content: 'hi' }],
    }
    await callGoWorker({ exec: fx.exec, body, cliHop: true, onEnvelope: (envelope) => reported.push(envelope) })
    await streamGoWorker({
      exec: fx.exec,
      body: { ...body, stream: true },
      cliHop: true,
      onEnvelope: (envelope) => reported.push(envelope),
    })
    assert.equal(reported.length, 2)
    for (const [i, envelope] of reported.entries()) {
      const { request_id: _id, ...sent } = posted[i]
      // 日志拿到的就是 POST 出去的那份：cli-hop 补上的 betas、补齐的 cch 都在里面。
      assert.deepEqual(JSON.parse(JSON.stringify(envelope)), sent)
      assert.ok(Array.isArray(envelope.body.betas))
      assert.match(envelope.body.system[0].text, /\bcch=[0-9a-f]{5};/)
    }
  } finally {
    await fx.close()
  }
})

unixTest('a throwing envelope observer does not fail the hop', async () => {
  const fx = await fixture(async (req, res) => {
    req.resume()
    await new Promise((resolve) => req.on('end', resolve))
    res.setHeader('content-type', 'application/json')
    res.setHeader('x-terminal-state', 'verified')
    res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }))
  })
  try {
    const result = await callGoWorker({
      exec: fx.exec,
      body: { model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] },
      onEnvelope: () => {
        throw new Error('observer broke')
      },
    })
    assert.equal(result.ok, true)
    assert.equal(result.body.content[0].text, 'ok')
  } finally {
    await fx.close()
  }
})

unixTest('Rust health and inference authenticate with the namespaced kernel header', async () => {
  const fx = await fixture(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.headers['x-kin-internal-token'] !== 'internal-test') {
      res.writeHead(401).end(JSON.stringify({ ok: false, error: { code: 'internal_auth_failed' } }))
      return
    }
    if (req.url === '/internal/health') {
      res.end(JSON.stringify({ ok: true, engine: 'rust', healthy: true, ready_slots: 20 }))
      return
    }
    for await (const _chunk of req) {
    }
    res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }))
  })
  try {
    fx.exec.vm.runtime.kernel_socket = fx.exec.vm.runtime.worker_socket
    const health = await rustKernelHealth(fx.exec)
    assert.equal(health.status, 200)
    assert.equal(health.ok, true)
    const result = await callRustKernel({
      exec: fx.exec,
      body: { model: 'claude-test', messages: [{ role: 'user', content: 'hello' }] },
    })
    assert.equal(result.ok, true)
    assert.equal(result.body.content[0].text, 'ok')
  } finally {
    await fx.close()
  }
})

unixTest('API kernel forwarding uses the header required by its Go authorize handler', async () => {
  const fx = await fixture(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.headers['x-kin-internal-token'] !== 'internal-test') {
      res.writeHead(401).end(JSON.stringify({ ok: false, error: { code: 'internal_auth_failed' } }))
      return
    }
    assert.equal(req.url, '/internal/forward')
    for await (const _chunk of req) {
    }
    res.end(JSON.stringify({ ok: true }))
  })
  const previousSocket = process.env.KIN_API_KERNEL_SOCK
  const previousToken = process.env.KIN_API_KERNEL_TOKEN
  try {
    process.env.KIN_API_KERNEL_SOCK = fx.exec.vm.runtime.worker_socket
    process.env.KIN_API_KERNEL_TOKEN = fx.exec.vm.runtime.worker_token_file
    const response = await forwardApi({ cfg: {}, url: 'https://api.example.test/v1/messages', body: {} })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(await readApiJson(response), { ok: true })
  } finally {
    if (previousSocket == null) delete process.env.KIN_API_KERNEL_SOCK
    else process.env.KIN_API_KERNEL_SOCK = previousSocket
    if (previousToken == null) delete process.env.KIN_API_KERNEL_TOKEN
    else process.env.KIN_API_KERNEL_TOKEN = previousToken
    await fx.close()
  }
})

unixTest('callGoWorker marks null TTL as client-owned cache breakpoints', async () => {
  const fx = await fixture(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    assert.equal(envelope.cache_ttl, null)
    assert.equal(envelope.preserve_cache_breakpoints, true)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }))
  })
  try {
    const result = await callGoWorker({
      exec: fx.exec,
      body: { model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] },
      cacheTtl: null,
    })
    assert.equal(result.ok, true)
  } finally {
    await fx.close()
  }
})

unixTest('streamGoWorker accepts message_stop before delayed EOF', async () => {
  const fx = await fixture((req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.setHeader('trailer', 'x-terminal-state')
    res.write('event: message_start\ndata: {"type":"message_start","message":{}}\n\n')
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
    res.addTrailers({ 'x-terminal-state': 'verified' })
    setTimeout(() => res.end(), 50)
  })
  try {
    const lines = []
    const result = await streamGoWorker({
      exec: fx.exec,
      body: { model: 'claude-test', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      onEvent: (line) => lines.push(line),
    })
    assert.equal(result.ok, true)
    assert.equal(result.terminalState, 'verified')
    assert.equal(result.committed, true)
    assert.ok(lines.some((line) => line.includes('message_stop')))
  } finally {
    await fx.close()
  }
})

unixTest('fragmented final-header diagnostics do not start idle timing, commit, or reach downstream', async () => {
  const fx = await fixture((req, res) => {
    req.resume()
    res.setHeader('content-type', 'text/event-stream')
    res.write('event: kin_outbound_head')
    setImmediate(() => res.write('ers\ndata: {"type":"kin_outbound_headers","headers":{"content-length":"123"}}\n\n'))
    setTimeout(() => res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n'), 1200)
  })
  try {
    const lines = []
    const snapshots = []
    const result = await streamGoWorker({
      exec: fx.exec,
      body: { model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] },
      timeoutMs: 5000,
      idleTimeoutMs: 10,
      onOutboundHeaders: (headers) => snapshots.push(headers),
      onEvent: (line) => lines.push(line),
    })
    assert.equal(result.ok, true)
    assert.equal(result.ttftMs, null)
    assert.deepEqual(snapshots, [{ 'content-length': '123' }])
    assert.doesNotMatch(lines.join('\n'), /kin_outbound_headers|content-length/)
  } finally {
    await fx.close()
  }
})

unixTest('final headers survive an upstream error without becoming a downstream commit', async () => {
  const fx = await fixture((req, res) => {
    req.resume()
    res.setHeader('content-type', 'text/event-stream')
    res.write(
      'event: kin_outbound_headers\ndata: {"type":"kin_outbound_headers","headers":{"x-stainless-retry-count":"1"}}\n\n',
    )
    res.end('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n')
  })
  try {
    const snapshots = []
    const result = await streamGoWorker({
      exec: fx.exec,
      body: { model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] },
      onOutboundHeaders: (headers) => snapshots.push(headers),
    })
    assert.equal(result.ok, false)
    assert.equal(result.committed, false)
    assert.deepEqual(snapshots, [{ 'x-stainless-retry-count': '1' }])
  } finally {
    await fx.close()
  }
})

unixTest('a reported final body is capped at 10000 tokens and stays off the caller stream', async () => {
  const fx = await fixture((req, res) => {
    req.resume()
    res.setHeader('content-type', 'text/event-stream')
    const body = '汉'.repeat(10_050)
    res.write(
      `event: kin_outbound_headers\ndata: ${JSON.stringify({
        type: 'kin_outbound_headers',
        headers: { 'user-agent': 'claude-cli/2.1.317 (external, cli)', authorization: 'Bearer secret' },
        body,
        body_truncated: false,
      })}\n\n`,
    )
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  })
  try {
    const lines = []
    const snapshots = []
    const result = await streamGoWorker({
      exec: fx.exec,
      body: { model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] },
      onOutboundHeaders: (headers, extra) => snapshots.push({ headers, extra }),
      onEvent: (line) => lines.push(line),
    })
    assert.equal(result.ok, true)
    assert.equal(snapshots[0].headers['user-agent'], 'claude-cli/2.1.317 (external, cli)')
    assert.equal(snapshots[0].extra.body.length, 10_000)
    assert.equal(snapshots[0].extra.body_truncated, true)
    assert.doesNotMatch(lines.join('\n'), /kin_outbound_headers|2\.1\.317/)
  } finally {
    await fx.close()
  }
})

unixTest('streamGoWorker names the aborted hop to the kernel cancel route', async () => {
  let hopId = null
  let cancelled = null
  const sawCancel = new Promise((resolve) => {
    cancelled = resolve
  })
  const fx = await fixture(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (req.url === '/internal/v1/cancel') {
      res.setHeader('content-type', 'application/json')
      res.end('{"ok":true,"cancelled":true}')
      cancelled(payload.request_id)
      return
    }
    hopId = payload.request_id
    res.setHeader('content-type', 'text/event-stream')
    res.write('event: message_start\ndata: {"type":"message_start","message":{}}\n\n')
  })
  try {
    const controller = new AbortController()
    const pending = streamGoWorker({
      exec: fx.exec,
      body: { model: 'claude-test', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      signal: controller.signal,
    })
    while (!hopId) await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort()
    const result = await pending
    assert.equal(result.body.error.code, 'client_cancelled')
    assert.equal(await sawCancel, hopId)
  } finally {
    await fx.close()
  }
})

unixTest('streamGoWorker accepts message_stop with usage trailers', async () => {
  const fx = await fixture((req, res) => {
    assert.equal(req.headers.te, 'trailers')
    res.setHeader('content-type', 'text/event-stream')
    res.setHeader('trailer', 'x-terminal-state, x-usage, x-model, x-stop-reason')
    res.write('data: {"type":"message_start","message":{"model":"claude-haiku-4-5-20251001"}}\n\n')
    res.write('data: {"type":"message_stop"}\n\n')
    res.addTrailers({
      'x-terminal-state': 'verified',
      'x-usage': JSON.stringify({ input_tokens: 12, output_tokens: 0 }),
      'x-model': 'claude-haiku-4-5-20251001',
      'x-stop-reason': 'end_turn',
    })
    res.end()
  })
  try {
    const result = await streamGoWorker({
      exec: fx.exec,
      body: { model: 'claude-haiku-4-5-20251001', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      onEvent: () => {},
    })
    assert.equal(result.ok, true)
    assert.equal(result.terminalState, 'verified')
    assert.equal(result.usage.input_tokens, 12)
    assert.equal(result.model, 'claude-haiku-4-5-20251001')
    assert.equal(result.stopReason, 'end_turn')
    assert.equal(result.ttftMs, null)
    assert.equal(result.firstTokenAt, null)
  } finally {
    await fx.close()
  }
})

unixTest('streamGoWorker does not stamp TTFT on metadata-only Responses complete', async () => {
  const fx = await fixture((req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.setHeader('trailer', 'x-terminal-state, x-usage, x-model, x-stop-reason')
    writeData(res, { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.4' } })
    writeData(res, { type: 'response.in_progress', response: { id: 'resp_1' } })
    writeData(res, {
      type: 'response.completed',
      response: { id: 'resp_1', model: 'gpt-5.4', usage: { input_tokens: 12, output_tokens: 0 } },
    })
    res.addTrailers({
      'x-terminal-state': 'verified',
      'x-usage': JSON.stringify({ input_tokens: 12, output_tokens: 0 }),
      'x-model': 'gpt-5.4',
      'x-stop-reason': 'completed',
    })
    res.end()
  })
  try {
    const result = await streamGoWorker({
      exec: fx.exec,
      envelope: { body: { model: 'gpt-5.4', input: [] }, stream: true },
      requestPath: '/internal/v1/codex/responses',
      onEvent: () => {},
    })
    assert.equal(result.usage.input_tokens, 12)
    assert.equal(result.model, 'gpt-5.4')
    assert.equal(result.stopReason, 'completed')
    assert.equal(result.ttftMs, null)
    assert.equal(result.firstTokenAt, null)
  } finally {
    await fx.close()
  }
})

unixTest('streamGoWorker stamps TTFT on a name-only tool_use with no parameter delta', async () => {
  const fx = await fixture((req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    writeData(res, { type: 'message_start', message: { model: 'claude-haiku-4-5-20251001' } })
    writeData(res, {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
    })
    writeData(res, { type: 'content_block_stop', index: 0 })
    writeData(res, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } })
    writeData(res, { type: 'message_stop' })
    res.end()
  })
  try {
    const result = await streamGoWorker({
      exec: fx.exec,
      body: { model: 'claude-haiku-4-5-20251001', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      onEvent: () => {},
    })
    assert.equal(result.ok, true)
    assert.equal(result.stopReason, 'tool_use')
    assert.ok(result.ttftMs != null && result.ttftMs >= 0)
    assert.ok(Number.isFinite(result.firstTokenAt) && result.firstTokenAt > 1_000_000_000_000)
  } finally {
    await fx.close()
  }
})

unixTest('streamGoWorker stamps TTFT on a Responses function name, not response.created', async () => {
  const fx = await fixture((req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.setHeader('trailer', 'x-terminal-state, x-model')
    writeData(res, { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.4' } })
    writeData(res, {
      type: 'response.output_item.added',
      item: { type: 'function_call', name: 'Read', arguments: '', call_id: 'c1' },
    })
    writeData(res, { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-5.4' } })
    res.addTrailers({ 'x-terminal-state': 'verified', 'x-model': 'gpt-5.4' })
    res.end()
  })
  try {
    const result = await streamGoWorker({
      exec: fx.exec,
      envelope: { body: { model: 'gpt-5.4', input: [] }, stream: true },
      requestPath: '/internal/v1/codex/responses',
      onEvent: () => {},
    })
    assert.ok(result.ttftMs != null && result.ttftMs >= 0)
    assert.ok(Number.isFinite(result.firstTokenAt) && result.firstTokenAt > 1_000_000_000_000)
  } finally {
    await fx.close()
  }
})

unixTest('streamGoWorker stamps firstTokenAt on the emitted tool name, not later args', async () => {
  const sawName = gate()
  let argsWrittenAt = null
  const fx = await fixture(async (req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    writeData(res, { type: 'message_start', message: { model: 'claude-haiku-4-5-20251001' } })
    writeData(res, {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
    })
    await sawName.ready
    argsWrittenAt = Date.now()
    writeData(res, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' },
    })
    writeData(res, { type: 'message_delta', delta: { stop_reason: 'tool_use' } })
    writeData(res, { type: 'message_stop' })
    res.end()
  })
  try {
    let nameSeenAt = null
    const result = await streamGoWorker({
      exec: fx.exec,
      body: { model: 'claude-haiku-4-5-20251001', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      onEvent: (line) => {
        if (nameSeenAt == null && line.includes('"name":"Read"')) {
          nameSeenAt = Date.now()
          sawName.release()
        }
      },
    })
    assert.ok(result.ttftMs != null && result.ttftMs >= 0)
    assert.ok(Number.isFinite(result.firstTokenAt))
    assert.ok(result.firstTokenAt <= nameSeenAt)
    assert.ok(result.firstTokenAt <= argsWrittenAt)
  } finally {
    await fx.close()
  }
})

unixTest('streamGoWorker stamps TTFT on text and thinking deltas', async () => {
  for (const delta of [
    { type: 'text_delta', text: 'hello' },
    { type: 'thinking_delta', thinking: 'hmm' },
  ]) {
    const fx = await fixture((req, res) => {
      res.setHeader('content-type', 'text/event-stream')
      writeData(res, { type: 'message_start', message: { model: 'claude-haiku-4-5-20251001' } })
      writeData(res, {
        type: 'content_block_start',
        index: 0,
        content_block: { type: delta.text != null ? 'text' : 'thinking', text: '', thinking: '' },
      })
      writeData(res, { type: 'content_block_delta', index: 0, delta })
      writeData(res, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
      writeData(res, { type: 'message_stop' })
      res.end()
    })
    try {
      const result = await streamGoWorker({
        exec: fx.exec,
        body: { model: 'claude-haiku-4-5-20251001', stream: true, messages: [{ role: 'user', content: 'hi' }] },
        onEvent: () => {},
      })
      assert.equal(result.ok, true, delta.type)
      assert.ok(result.ttftMs != null && result.ttftMs >= 0, delta.type)
      assert.ok(Number.isFinite(result.firstTokenAt), delta.type)
    } finally {
      await fx.close()
    }
  }
})

unixTest('streamGoWorker stamps TTFT on omitted thinking progress before visible output', async (t) => {
  let now = 1_000
  t.mock.method(Date, 'now', () => now)
  const sawProgress = gate()
  const fx = await fixture(async (req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    writeData(res, { type: 'message_start', message: { model: 'claude-test' } })
    writeData(res, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
    writeData(res, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: '', estimated_tokens: 0 },
    })
    // Empty progress is intentionally held before commit. Advance the server
    // clock rather than waiting for that uncommitted frame downstream.
    now = 2_000
    writeData(res, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: '', estimated_tokens: 50 },
    })
    await sawProgress.ready
    writeData(res, { type: 'content_block_stop', index: 0 })
    writeData(res, { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })
    writeData(res, { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ok' } })
    writeData(res, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 52 } })
    writeData(res, { type: 'message_stop' })
    res.end()
  })
  try {
    const result = await streamGoWorker({
      exec: fx.exec,
      body: {
        model: 'claude-test',
        stream: true,
        thinking: { type: 'adaptive', display: 'omitted' },
        messages: [{ role: 'user', content: 'hi' }],
      },
      onEvent: (line) => {
        if (line.includes('"estimated_tokens":50')) {
          now = 5_000
          sawProgress.release()
        }
      },
    })
    assert.equal(result.ok, true)
    assert.equal(result.ttftMs, 1_000)
    assert.equal(result.firstTokenAt, 2_000)
    assert.equal(result.usage.output_tokens, 52)
  } finally {
    await fx.close()
    t.mock.restoreAll()
  }
})

unixTest('streamGoWorker does not stamp TTFT on no-op or invalid thinking progress', async () => {
  const fx = await fixture((req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    writeData(res, { type: 'message_start', message: { model: 'claude-test' } })
    writeData(res, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
    for (const estimated_tokens of [undefined, null, 0, -1, '50', true, NaN, Infinity]) {
      writeData(res, {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '', estimated_tokens },
      })
    }
    writeData(res, { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'fixture' } })
    writeData(res, { type: 'content_block_stop', index: 0 })
    writeData(res, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } })
    writeData(res, { type: 'message_stop' })
    res.end()
  })
  try {
    const result = await streamGoWorker({
      exec: fx.exec,
      body: { model: 'claude-test', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      onEvent: () => {},
    })
    assert.equal(result.ok, true)
    assert.equal(result.ttftMs, null)
    assert.equal(result.firstTokenAt, null)
  } finally {
    await fx.close()
  }
})

unixTest('streamGoWorker keeps observed firstTokenAt when the client cancels', async () => {
  const sawText = gate()
  const fx = await fixture(async (req, res) => {
    if (req.url === '/internal/v1/cancel') {
      res.setHeader('content-type', 'application/json')
      res.end('{"ok":true,"cancelled":true}')
      return
    }
    res.setHeader('content-type', 'text/event-stream')
    writeData(res, { type: 'message_start', message: {} })
    writeData(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } })
    await sawText.ready
  })
  try {
    const controller = new AbortController()
    const pending = streamGoWorker({
      exec: fx.exec,
      body: { model: 'claude-test', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      signal: controller.signal,
      onEvent: (line) => {
        if (String(line).includes('text_delta')) sawText.release()
      },
    })
    await sawText.ready
    controller.abort()
    const result = await pending
    assert.equal(result.body.error.code, 'client_cancelled')
    assert.ok(result.ttftMs != null && result.ttftMs >= 0)
    assert.ok(Number.isFinite(result.firstTokenAt))
  } finally {
    await fx.close()
  }
})

unixTest('streamGoWorker keeps observed firstTokenAt when a later error ends the hop', async () => {
  const fx = await fixture((req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    writeData(res, { type: 'message_start', message: { model: 'claude-haiku-4-5-20251001' } })
    writeData(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } })
    writeData(res, { type: 'error', error: { type: 'api_error', message: 'upstream failed' } })
    res.end()
  })
  try {
    const result = await streamGoWorker({
      exec: fx.exec,
      body: { model: 'claude-haiku-4-5-20251001', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      onEvent: () => {},
    })
    assert.equal(result.ok, false)
    assert.ok(result.ttftMs != null && result.ttftMs >= 0)
    assert.ok(Number.isFinite(result.firstTokenAt))
  } finally {
    await fx.close()
  }
})

unixTest('streamGoWorker keeps rate-limit trailers after message_stop', async () => {
  const fx = await fixture((req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.setHeader('trailer', 'x-terminal-state, x-rate-limit-headers')
    res.write('data: {"type":"message_start","message":{}}\n\n')
    res.write('data: {"type":"message_stop"}\n\n')
    res.addTrailers({
      'x-terminal-state': 'verified',
      'x-rate-limit-headers': JSON.stringify({
        'anthropic-ratelimit-unified-5h-utilization': '0.81',
        'set-cookie': 'nope',
      }),
    })
    res.end()
  })
  try {
    const result = await streamGoWorker({
      exec: fx.exec,
      body: { model: 'claude-sonnet-5', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      onEvent: () => {},
    })
    assert.equal(result.ok, true)
    assert.equal(result.terminalState, 'verified')
    assert.equal(result.headers['anthropic-ratelimit-unified-5h-utilization'], '0.81')
    assert.equal(result.headers['set-cookie'], undefined)
  } finally {
    await fx.close()
  }
})

unixTest('streamGoWorker restores a streamed plan-limit error to 429 with a parsed reset', async () => {
  // Kernel cli-hop: HTTP 200, then `event: error` (sub2api sseStreamErrorEventError).
  const fx = await fixture((req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.write('event: message_start\ndata: {"type":"message_start","message":{"content":[]}}\n\n')
    res.write(
      'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"provider error: You\'ve hit your limit · resets 11am (America/New_York)"}}\n\n',
    )
    res.end()
  })
  try {
    const lines = []
    const result = await streamGoWorker({
      exec: fx.exec,
      body: { model: 'claude-haiku-4-5', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      onEvent: (line) => lines.push(line),
    })
    assert.equal(result.ok, false)
    assert.equal(result.committed, false)
    assert.equal(result.status, 429)
    assert.equal(result.terminalState, 'rejected')
    assert.equal(result.streamError, true)
    assert.equal(result.headers['anthropic-ratelimit-unified-5h-status'], 'rejected')
    assert.ok(Number(result.headers['anthropic-ratelimit-unified-5h-reset']) * 1000 > Date.now())
    assert.equal(lines.length, 0)
  } finally {
    await fx.close()
  }
})

unixTest('streamGoWorker restores a streamed overloaded_error to 529', async () => {
  const fx = await fixture((req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.write('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n')
    res.end()
  })
  try {
    const result = await streamGoWorker({
      exec: fx.exec,
      body: { model: 'claude-haiku-4-5', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      onEvent: () => {},
    })
    assert.equal(result.status, 529)
    assert.equal(result.terminalState, 'rejected')
  } finally {
    await fx.close()
  }
})

unixTest('streamGoWorker accepts an empty message_stop terminal', async () => {
  const fx = await fixture((req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.write('data: {"type":"message_start","message":{"content":[]}}\n\n')
    res.write('data: {"type":"message_stop"}\n\n')
    res.end()
  })
  try {
    const result = await streamGoWorker({
      exec: fx.exec,
      body: { model: 'claude-haiku-4-5', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      onEvent: () => {},
    })
    assert.equal(result.ok, true)
    assert.equal(result.terminalState, 'verified')
    assert.equal(result.sawMessageStop, true)
  } finally {
    await fx.close()
  }
})

unixTest('streamGoWorker does not turn a generic stream error into HTTP 502', async () => {
  const fx = await fixture((req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.write('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"provider error"}}\n\n')
    res.end()
  })
  try {
    const result = await streamGoWorker({
      exec: fx.exec,
      body: { model: 'claude-haiku-4-5', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      onEvent: () => {},
    })
    assert.equal(result.status, 200)
    assert.equal(result.body.error.code, 'empty_response')
    assert.equal(result.terminalState, 'incomplete')
  } finally {
    await fx.close()
  }
})

unixTest('streamGoWorker preserves organization permission denial before downstream commit', async () => {
  const message =
    'provider error: provider error: Your organization does not have access to Claude. Please login again or contact your administrator.'
  const fx = await fixture((req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.setHeader('trailer', 'x-terminal-state')
    res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`)
    res.addTrailers({ 'x-terminal-state': 'incomplete' })
    res.end()
  })
  try {
    const result = await streamGoWorker({
      exec: fx.exec,
      body: { model: 'claude-haiku-4-5', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      onCommit: () => assert.fail('permission denial must not commit the downstream'),
      onEvent: () => {},
    })
    assert.equal(result.status, 403)
    assert.equal(result.body.error.message, message)
    assert.equal(result.terminalState, 'rejected')
    assert.equal(result.committed, false)
  } finally {
    await fx.close()
  }
})

unixTest('callGoWorker restores organization permission denial from a kernel provider error', async () => {
  const message =
    'provider error: Your organization does not have access to Claude. Please login again or contact your administrator.'
  const fx = await fixture((req, res) => {
    res.statusCode = 502
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ type: 'error', error: { type: 'worker_error', code: 'provider_error', message } }))
  })
  try {
    const result = await callGoWorker({
      exec: fx.exec,
      body: { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(result.status, 403)
    assert.equal(result.body.error.message, message)
    assert.equal(result.terminalState, 'rejected')
  } finally {
    await fx.close()
  }
})

unixTest('callGoWorker restores a kernel 502 provider_error plan limit to 429', async () => {
  const fx = await fixture((req, res) => {
    res.statusCode = 502
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        type: 'error',
        error: { type: 'worker_error', code: 'provider_error', message: "provider error: You've hit your limit" },
      }),
    )
  })
  try {
    const result = await callGoWorker({
      exec: fx.exec,
      body: { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(result.status, 429)
    assert.equal(result.headers['anthropic-ratelimit-unified-5h-status'], 'rejected')
  } finally {
    await fx.close()
  }
})

unixTest('streamGoWorker scrapes usage from SSE when trailers are missing', async () => {
  const fx = await fixture((req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.write(
      'data: {"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":80,"cache_read_input_tokens":20}}}\n\n',
    )
    res.write('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"ok"}}\n\n')

    res.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":6}}\n\n')
    res.write('data: {"type":"message_stop"}\n\n')
    res.end()
  })
  try {
    const result = await streamGoWorker({
      exec: fx.exec,
      body: { model: 'claude-sonnet-5', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      onEvent: () => {},
    })
    assert.equal(result.usage.input_tokens, 80)
    assert.equal(result.usage.output_tokens, 6)
    assert.equal(result.usage.cache_read_input_tokens, 20)
    assert.equal(result.model, 'claude-sonnet-5')
    assert.equal(result.stopReason, 'end_turn')
  } finally {
    await fx.close()
  }
})

unixTest('streamGoWorker merges SSE cache details into a totals-only usage trailer', async () => {
  const fx = await fixture((req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.setHeader('trailer', 'x-terminal-state, x-usage')
    res.write('data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.4"}}\n\n')
    res.write('data: {"type":"response.output_text.delta","delta":"hi"}\n\n')
    res.write(
      'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.4","usage":{"input_tokens":120,"output_tokens":9,"total_tokens":129,"input_tokens_details":{"cached_tokens":8}}}}\n\n',
    )
    res.addTrailers({
      'x-terminal-state': 'verified',
      'x-usage': JSON.stringify({ input_tokens: 120, output_tokens: 9 }),
    })
    res.end()
  })
  try {
    const result = await streamGoWorker({
      exec: fx.exec,
      envelope: { body: { model: 'gpt-5.4', input: [] }, stream: true },
      requestPath: '/internal/v1/codex/responses',
      onEvent: () => {},
    })
    assert.equal(result.usage.input_tokens, 120)
    assert.equal(result.usage.output_tokens, 9)
    assert.equal(result.usage.input_tokens_details.cached_tokens, 8)
    assert.equal(extractOpenaiUsage(result.usage).cached_tokens, 8)
  } finally {
    await fx.close()
  }
})

test('terminal metadata and empty blocks are not downstream commits', () => {
  assert.equal(isDownstreamCommitEvent({ type: 'message_start', message: {} }), false)
  assert.equal(isDownstreamCommitEvent({ type: 'error', error: { message: 'Connection error' } }), false)
  assert.equal(isDownstreamCommitEvent({ type: 'message_stop' }), false)
  assert.equal(isDownstreamCommitEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }), false)
  assert.equal(isDownstreamCommitEvent({ type: 'message_delta', delta: {} }), false)
  assert.equal(
    isDownstreamCommitEvent({ type: 'content_block_start', content_block: { type: 'text', text: '' } }),
    false,
  )
  assert.equal(
    isDownstreamCommitEvent({ type: 'content_block_start', content_block: { type: 'thinking', thinking: '' } }),
    false,
  )
  assert.equal(
    isDownstreamCommitEvent({ type: 'content_block_delta', delta: { type: 'thinking_delta', estimated_tokens: 1 } }),
    true,
  )
  assert.equal(
    isDownstreamCommitEvent({ type: 'content_block_start', content_block: { type: 'redacted_thinking', data: '' } }),
    false,
  )
  assert.equal(
    isDownstreamCommitEvent({ type: 'content_block_start', content_block: { type: 'redacted_thinking', data: 'x' } }),
    true,
  )
  assert.equal(
    isDownstreamCommitEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }),
    true,
  )
  assert.equal(
    isDownstreamCommitEvent({
      type: 'content_block_start',
      content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search' },
    }),
    true,
  )
})

unixTest('streamGoWorker assembles text+stop_reason even without message_stop', async () => {
  const fx = await fixture((req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.write('data: {"type":"message_start","message":{"type":"message","role":"assistant","content":[]}}\n\n')
    res.write('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n')
    res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n')
    res.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n')
    res.end()
  })
  try {
    const lines = []
    const result = await streamGoWorker({
      exec: fx.exec,
      body: { model: 'claude-sonnet-5', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      onEvent: (line) => lines.push(line),
    })
    assert.equal(result.ok, true)
    assert.equal(result.committed, true)
    assert.equal(result.terminalState, 'verified')
    assert.equal(result.stopReason, 'end_turn')
    assert.equal(result.body.content[0].text, 'hello')
    assert.ok(lines.some((line) => line.includes('text_delta')))
  } finally {
    await fx.close()
  }
})

unixTest('streamGoWorker does not commit or forward a Connection error after message_start', async () => {
  const fx = await fixture((req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.write('data: {"type":"message_start","message":{}}\n\n')
    res.write(
      'data: {"type":"error","error":{"type":"api_error","message":"provider error: provider error: Connection error."}}\n\n',
    )
    res.end()
  })
  try {
    const lines = []
    const result = await streamGoWorker({
      exec: fx.exec,
      body: { model: 'claude-haiku-4-5', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      onEvent: (line) => lines.push(line),
    })
    assert.equal(result.committed, false)
    assert.equal(result.ok, false)
    assert.match(String(result.body?.error?.message || ''), /Connection error/)
    assert.equal(lines.length, 0)
  } finally {
    await fx.close()
  }
})

test('usageFromSseEvent reads Anthropic message_start and message_delta', () => {
  assert.deepEqual(
    usageFromSseEvent({ type: 'message_start', message: { usage: { input_tokens: 80, cache_read_input_tokens: 20 } } }),
    { input_tokens: 80, cache_read_input_tokens: 20 },
  )
  assert.deepEqual(usageFromSseEvent({ type: 'message_delta', usage: { output_tokens: 6 } }), { output_tokens: 6 })
  assert.equal(usageFromSseEvent({ type: 'content_block_delta' }), null)
})

test('usageFromSseEvent reads OpenAI Responses nested usage', () => {
  assert.deepEqual(
    usageFromSseEvent({
      type: 'response.completed',
      response: { usage: { input_tokens: 41, output_tokens: 12, input_tokens_details: { cached_tokens: 8 } } },
    }),
    { input_tokens: 41, output_tokens: 12, input_tokens_details: { cached_tokens: 8 } },
  )
})

test('workerHealth fails closed when socket is absent', async () => {
  const result = await workerHealth(
    {
      homeDir: '/tmp/not-present/cli-home',
      vm: { runtime: { worker_socket: '/tmp/not-present/worker.sock' } },
    },
    { timeoutMs: 20 },
  )
  assert.equal(result.ok, false)
})

for (const call of [callGoWorker, streamGoWorker]) {
  unixTest(`${call.name} maps plain-text kernel 413 without losing structured errors`, async () => {
    for (const structured of [false, true]) {
      const upstream = {
        error: { type: 'invalid_request_error', code: 'context_length_exceeded', message: 'specific limit' },
      }
      const fx = await fixture((req, res) => {
        req.resume()
        res.writeHead(413, { 'content-type': structured ? 'application/json' : 'text/plain' })
        res.end(structured ? JSON.stringify(upstream) : 'Failed to buffer the request body: length limit exceeded')
      })
      try {
        const result = await call({
          exec: fx.exec,
          envelope: { body: { input: 'hi' } },
          requestPath: '/internal/v1/codex/responses',
        })
        assert.equal(result.status, 413)
        assert.equal(result.ok, false)
        assert.equal(result.transportError, false)
        if (structured) assert.deepEqual(result.body, upstream)
        else {
          assert.equal(result.body.error.code, 'body_too_large')
          assert.equal(result.body.error.type, 'invalid_request_error')
          assert.equal(result.body.error.details.retryable, false)
        }
      } finally {
        await fx.close()
      }
    }
  })

  unixTest(`${call.name} limits the exact UTF-8 envelope including request_id`, async () => {
    let requests = 0
    const envelope = { body: { input: '你好' }, headers: { 'session-id': 'example' } }
    const bytes = Buffer.byteLength(JSON.stringify({ ...envelope, request_id: 'x'.repeat(36) }))
    const fx = await fixture(async (req, res) => {
      requests++
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      assert.equal(Buffer.concat(chunks).length, bytes)
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'fixture_reached' } }))
    })
    try {
      const oversized = await call({
        exec: fx.exec,
        envelope,
        maxRequestBytes: bytes - 1,
        requestPath: '/internal/v1/codex/responses',
      })
      assert.equal(oversized.status, 413)
      assert.equal(oversized.body.error.code, 'body_too_large')
      assert.equal(oversized.body.error.details.retryable, false)
      assert.equal(oversized.transportError, false)
      assert.equal(requests, 0)
      const exact = await call({
        exec: fx.exec,
        envelope,
        maxRequestBytes: bytes,
        requestPath: '/internal/v1/codex/responses',
      })
      assert.equal(exact.status, 400)
      assert.equal(exact.body.error.code, 'fixture_reached')
      assert.equal(requests, 1)
    } finally {
      await fx.close()
    }
  })
}

for (const mode of ['first-byte', 'idle']) {
  unixTest(`streamGoWorker enforces ${mode} timeout after kernel headers`, async () => {
    const fx = await fixture((req, res) => {
      req.resume()
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.flushHeaders()
      if (mode === 'idle') writeData(res, { type: 'response.output_text.delta', delta: 'hello' })
    })
    const controller = new AbortController()
    const safety = setTimeout(() => controller.abort(), 5000)
    try {
      const result = await streamGoWorker({
        exec: fx.exec,
        envelope: { body: { input: 'hi' } },
        requestPath: '/internal/v1/codex/responses',
        timeoutMs: mode === 'first-byte' ? 20 : 4000,
        idleTimeoutMs: 20,
        signal: controller.signal,
      })
      assert.equal(result.body.error.code, 'worker_timeout')
      assert.match(result.body.error.message, new RegExp(mode))
      assert.equal(result.committed, mode === 'idle')
    } finally {
      clearTimeout(safety)
      controller.abort()
      await fx.close()
    }
  })
}

unixTest('Codex clients enforce the panel limit on their serialized envelope', async () => {
  let requests = 0
  const fx = await fixture((req, res) => {
    requests++
    req.resume()
    res.writeHead(400).end('{}')
  })
  try {
    fx.exec.vm.runtime.codex_kernel_socket = fx.exec.vm.runtime.worker_socket
    const envelope = { body: { input: 'x'.repeat(8 * 1024 * 1024) } }
    for (const call of [callCodexKernel, streamCodexKernel]) {
      const result = await call({ exec: fx.exec, envelope, routing: { failover: { max_request_mib: 8 } } })
      assert.equal(result.status, 413)
      assert.equal(result.body.error.code, 'body_too_large')
      assert.equal(result.transportError, false)
    }
    assert.equal(requests, 0)
  } finally {
    await fx.close()
  }
})

unixTest('redaction 413 stops failover before any worker dispatch for call and stream clients', async (t) => {
  let requests = 0
  const fx = await fixture((req, res) => {
    requests++
    req.resume()
    res.writeHead(500).end('{}')
  })
  t.after(async () => {
    publishRedactionForTests(null)
    await fx.close()
  })
  fx.exec.vm.runtime.codex_kernel_socket = fx.exec.vm.runtime.worker_socket
  const policy = normalizeRedaction({ enabled: true, secrets: true, personal: false })
  let masks = 0
  publishRedactionForTests({
    enabled: true,
    ready: true,
    policy,
    client: {
      async mask({ maxBodyBytes }) {
        masks++
        assert.equal(maxBodyBytes, 64 * 1024 * 1024)
        throw Object.assign(new Error('redaction body exceeds the configured request body limit'), {
          code: 'redaction_body_too_large',
          status: 413,
          details: { retryable: false },
        })
      },
    },
  })
  for (const call of [callGoWorker, streamGoWorker, callCodexKernel, streamCodexKernel]) {
    const body =
      call === callCodexKernel || call === streamCodexKernel
        ? { input: 'fixture' }
        : { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'fixture' }] }
    let selections = 0
    const runner = new FailoverRunner({
      scheduler: {
        async selectAndReserve() {
          selections++
          assert.equal(selections, 1, 'a local size error must not select another account')
          return { ok: true, accountId: 'fixture', vmId: 'vm-fixture', release() {} }
        },
        markCooldown() {
          assert.fail('a local size error must not cool down an account')
        },
      },
    })
    const result = await runner.run({
      requestId: `redaction-size-${call.name}`,
      model: 'fixture-model',
      canonicalBody: body,
      callAttempt: () =>
        call({
          exec: fx.exec,
          envelope: { body },
          routing: { redaction: policy, failover: { max_request_mib: 64 } },
          redactionPrincipal: 'fixture-principal',
        }),
    })
    assert.equal(result.status, 413, call.name)
    assert.equal(result.body.error.code, 'redaction_body_too_large')
    assert.equal(result.body.error.type, 'invalid_request_error')
    assert.equal(result.body.error.details.retryable, false)
    assert.equal(result.transportError, false)
    assert.equal(result.attemptCount, 0)
    assert.equal(selections, 1)
  }
  assert.equal(masks, 4)
  assert.equal(requests, 0)
})

unixTest('invalid Messages are rejected before either kernel accepts a turn', async (t) => {
  let requests = 0
  const fx = await fixture((req, res) => {
    requests++
    req.resume()
    res.writeHead(500).end('{}')
  })
  t.after(() => fx.close())
  for (const runtime_variant of ['cli-node', 'crag-v2']) {
    const exec = { ...fx.exec, workerStatus: { runtime_variant } }
    for (const send of [callGoWorker, streamGoWorker]) {
      for (const prebuilt of [false, true]) {
        for (const messages of [
          [],
          [{ role: 'user', content: ' \n\t' }],
          [{ role: 'user', content: 42 }],
          [{ role: 'user', content: [{ type: 'tool_result', content: 'result' }] }],
        ]) {
          const body = { model: 'claude-sonnet-5', messages }
          const result = await send({ exec, ...(prebuilt ? { envelope: { body } } : { body }) })
          assert.equal(result.status, 400)
          assert.equal(result.body.error.code, 'invalid_kernel_request')
          assert.equal(result.transportError, false)
          assert.equal(result.upstreamExecutions, 0)
          assert.equal(result.committed, false)
          const policy = classifyUpstreamResult(result)
          assert.equal(policy.scope, 'request')
          assert.equal(policy.action, 'stop')
        }
      }
    }
  }
  assert.equal(requests, 0)
})

unixTest('kernel preparation isolates controls without rewriting tool continuation history', async (t) => {
  const history = [
    { role: 'user', content: [{ type: 'text', text: 'read the file' }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'plan', signature: 'signed-history-12345678901234567890' },
        { type: 'tool_use', id: 'tool_history_1', name: 'Read', input: { path: '/synthetic/file' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tool_history_1', content: 'file content' },
        { type: 'text', text: 'continue' },
      ],
    },
  ]
  const fx = await fixture(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const sent = JSON.parse(Buffer.concat(chunks))
    assert.deepEqual(sent.body.messages, history)
    for (const key of ['request_context', 'gateway_policy', 'kin_outbound_shape', 'request_id', 'delivery_mode']) {
      assert.equal(Object.hasOwn(sent.body, key), false)
    }
    assert.deepEqual(sent.body.safeguards, { synthetic_extension: true })
    if (sent.body.crag_prompt) {
      assert.deepEqual(sent.body.crag_options, { effort: 'high' })
      assert.equal(sent.body.auto_compact_window, undefined)
    } else {
      assert.equal(sent.body.crag_model, undefined)
      assert.equal(sent.body.crag_options, undefined)
      assert.equal(sent.body.auto_compact_window, 200000)
    }
    res.writeHead(409, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'tool_result replayed' } }),
    )
  })
  t.after(() => fx.close())
  for (const runtime_variant of ['cli-node', 'crag-v2']) {
    const exec = { ...fx.exec, workerStatus: { runtime_variant, capabilities: ['prompt_append', 'model_directive'] } }
    for (const prebuilt of [false, true]) {
      const body = {
        model: 'claude-sonnet-5',
        max_tokens: 128,
        messages: structuredClone(history),
        request_context: { purpose: 'untrusted' },
        gateway_policy: {},
        kin_outbound_shape: 'lean',
        request_id: 'untrusted',
        delivery_mode: 'untrusted',
        crag_prompt: { mode: 'append', text: 'caller instruction' },
        crag_options: { transport: 'print', effort: 'high' },
        auto_compact_window: 200000,
        safeguards: { synthetic_extension: true },
      }
      const result = await callGoWorker({ exec, cliHop: true, ...(prebuilt ? { envelope: { body } } : { body }) })
      assert.equal(result.status, 409)
      assert.equal(result.transportError, false)
    }
  }
})
