import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  isRetryableCodexTransport,
  runCodexKernelHop,
  handleCodexProtocol,
  codexFailureHold,
  codexFailoverBudget,
  applyCodexRebuildBody,
} from '../../src/lib/protocol/handle-codex.mjs'
import { persistCodexUsage, getVm } from '../../src/lib/vm/vm-registry.mjs'
import { StickyRouter } from '../../src/lib/pool/sticky-router.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'

beforeEach(() => resetOpenAIAccountRuntime())

test('502 upstream_transport is retryable before commit', () => {
  assert.equal(
    isRetryableCodexTransport({
      ok: false,
      status: 502,
      body: { error: { code: 'upstream_transport' } },
    }),
    true,
  )
  assert.equal(isRetryableCodexTransport({ ok: false, transportError: true, status: 0, committed: false }), true)
  assert.equal(
    isRetryableCodexTransport({
      ok: false,
      status: 502,
      committed: true,
      body: { error: { code: 'upstream_transport' } },
    }),
    false,
  )
  assert.equal(isRetryableCodexTransport({ ok: true, status: 200 }), false)
  assert.equal(isRetryableCodexTransport({ ok: false, status: 401, body: { error: { code: 'oauth_revoked' } } }), false)
})

test('runCodexKernelHop retries a silent first-hop 502 then succeeds', async () => {
  let n = 0
  const events = []
  const result = await runCodexKernelHop({
    hop: async ({ onEvent }) => {
      n += 1
      if (n === 1) return { ok: false, status: 502, body: { error: { code: 'upstream_transport' } } }
      await onEvent('data: {"type":"response.completed"}\n')
      return { ok: true, status: 200, terminalState: 'verified' }
    },
    onEvent: async (line) => events.push(line),
  })
  assert.equal(n, 2)
  assert.equal(result.ok, true)
  assert.equal(result.transport_retried, true)
  assert.equal(events.length, 1)
})

test('runCodexKernelHop does not retry after SSE has started', async () => {
  let n = 0
  const result = await runCodexKernelHop({
    hop: async ({ onEvent }) => {
      n += 1
      await onEvent('data: {"type":"response.created"}\n')
      return { ok: false, status: 502, body: { error: { code: 'upstream_transport' } } }
    },
  })
  assert.equal(n, 1)
  assert.equal(result.ok, false)
  assert.equal(result.transport_retried, undefined)
})

function writeGptVm(root, id) {
  const dir = path.join(root, 'vms')
  fs.mkdirSync(path.join(dir, id), { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      name: id,
      platform: 'openai',
      family: 'codex',
      schedulable: true,
      status: 'running',
      has_token: true,
    }),
  )
  fs.writeFileSync(
    path.join(dir, id, 'codex-credentials.json'),
    JSON.stringify({
      accounts: [{ id: `${id}-acc`, access_token: 'at', refresh_token: 'rt', chatgpt_account_id: id }],
    }),
  )
}

test('quota 429 hops the next GPT slot and records 5h/7d extra', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-hop-'))
  writeGptVm(root, 'vm-gpt-a')
  writeGptVm(root, 'vm-gpt-b')
  const seen = []
  const res = {
    headersSent: false,
    statusCode: 0,
    body: null,
    ended: false,
    write() {},
    end() {
      this.ended = true
    },
  }
  const logBag = {}
  const out = await handleCodexProtocol({
    req: { headers: {}, apiKeyKind: 'user' },
    res,
    protocol: 'openai.responses',
    ctx: { body: { model: 'gpt-5.4', input: 'hi', stream: false } },
    inbound: { stream: false },
    logBag,
    stats: { errors: 0, requests: 0, by_route: {} },
    json: (_res, status, body) => {
      res.statusCode = status
      res.body = body
      return body
    },
    writeSSEHeaders() {
      res.headersSent = true
    },
    routing: {},
    projectRoot: root,
    ops: {
      writeCodexKernelConfig() {},
      ensureCodexKernel: async () => ({ ok: true }),
      streamCodexKernel: async ({ exec }) => {
        seen.push(exec.vmId)
        if (exec.vmId === 'vm-gpt-a') {
          return {
            ok: false,
            status: 429,
            committed: false,
            headers: {
              'x-codex-primary-used-percent': '100',
              'x-codex-primary-window-minutes': '300',
              'x-codex-primary-reset-after-seconds': '60',
            },
            body: { error: { type: 'api_error', code: 'usage_limit_reached', message: '5h' } },
          }
        }
        return {
          ok: true,
          status: 200,
          terminalState: 'verified',
          headers: {
            'x-codex-primary-used-percent': '8',
            'x-codex-primary-window-minutes': '300',
            'x-codex-secondary-used-percent': '3',
            'x-codex-secondary-window-minutes': '10080',
          },
          body: { id: 'resp_ok' },
        }
      },
    },
  })
  assert.deepEqual(seen, ['vm-gpt-a', 'vm-gpt-b'])
  assert.equal(res.statusCode, 200)
  assert.equal(out.id, 'resp_ok')
  assert.equal(logBag.codex_failed_over, true)
  assert.equal(logBag.vm_id, 'vm-gpt-b')
  const spent = getVm(root, 'vm-gpt-a')
  assert.equal(spent.codex.extra.codex_primary_used_percent, 100)
  assert.ok(spent.codex.extra.codex_limited_until)
  assert.equal(spent.codex.usage.quota.utilization_5h, 1)
  assert.equal(spent.schedulable, true)
  assert.equal(spent.schedule_disabled_reason ?? null, null)
  assert.equal(spent.claude?.temp_unschedulable_reason || spent.temp_unschedulable_reason, 'quota_5h_header')
  assert.equal(spent.status, 'running')
  fs.rmSync(root, { recursive: true, force: true })
})

test('persistCodexUsage writes cluster 5h/7d quota', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-persist-'))
  writeGptVm(root, 'vm-gpt-a')
  const now = Date.parse('2026-09-17T00:00:00.000Z')
  persistCodexUsage(root, 'vm-gpt-a', {
    now,
    headers: {
      'x-codex-primary-used-percent': '25',
      'x-codex-primary-window-minutes': '300',
      'x-codex-secondary-used-percent': '10',
      'x-codex-secondary-window-minutes': '10080',
    },
  })
  const vm = getVm(root, 'vm-gpt-a')
  assert.equal(vm.codex.usage.quota.utilization_5h, 0.25)
  assert.equal(vm.codex.usage.quota.utilization_7d, 0.1)
  fs.rmSync(root, { recursive: true, force: true })
})

test('persistCodexUsage keeps switch on and clears restriction after the 5h window opens', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-restore-'))
  writeGptVm(root, 'vm-gpt-a')
  const now = Date.parse('2026-09-17T00:00:00.000Z')
  persistCodexUsage(root, 'vm-gpt-a', {
    now,
    headers: {
      'x-codex-primary-used-percent': '100',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-after-seconds': '60',
    },
  })
  const spent = getVm(root, 'vm-gpt-a')
  assert.equal(spent.schedulable, true)
  assert.equal(spent.claude?.temp_unschedulable_reason || spent.temp_unschedulable_reason, 'quota_5h_header')
  persistCodexUsage(root, 'vm-gpt-a', {
    now: now + 61_000,
    headers: {
      'x-codex-primary-used-percent': '12',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-after-seconds': '300',
    },
  })
  const restored = getVm(root, 'vm-gpt-a')
  assert.equal(restored.schedulable, true)
  assert.equal(restored.schedule_disabled_reason ?? null, null)
  assert.equal(restored.claude?.temp_unschedulable_reason, undefined)
  fs.rmSync(root, { recursive: true, force: true })
})

test('openai.chat GPT request is washed to Responses before the kernel hop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-wash-'))
  writeGptVm(root, 'vm-gpt-a')
  let hopBody = null
  const writes = []
  const res = {
    headersSent: false,
    write(chunk) {
      this.headersSent = true
      writes.push(String(chunk))
    },
    end() {},
  }
  const logBag = {}
  await handleCodexProtocol({
    req: { headers: { 'user-agent': 'cursor' } },
    res,
    protocol: 'openai.chat',
    ctx: {
      path: '/v1/chat/completions',
      body: {
        model: 'gpt-5.6-sol',
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hello' },
        ],
        stream: true,
        max_completion_tokens: 32,
      },
    },
    inbound: { stream: true },
    logBag,
    stats: { errors: 0, requests: 0, by_route: {} },
    json: (_res, status, body) => {
      res.statusCode = status
      res.body = body
      return body
    },
    writeSSEHeaders() {
      res.headersSent = true
    },
    routing: {},
    projectRoot: root,
    ops: {
      writeCodexKernelConfig() {},
      ensureCodexKernel: async () => ({ ok: true }),
      streamCodexKernel: async ({ body, envelope, onEvent }) => {
        hopBody = envelope?.body || body
        await onEvent('data: {"type":"response.output_text.delta","delta":"Hi"}')
        await onEvent('data: {"type":"response.completed"}')
        return { ok: true, status: 200, terminalState: 'verified' }
      },
    },
  })
  assert.ok(hopBody)
  assert.equal(Array.isArray(hopBody.input), true)
  assert.equal(hopBody.messages, undefined)
  assert.equal(hopBody.input[0].role, 'developer')
  assert.equal(logBag.protocol, 'openai.responses')
  assert.equal(logBag.path, '/v1/responses')
  assert.equal(logBag.hop_meta.inbound_path, '/v1/chat/completions')
  assert.equal(logBag.hop_meta.inbound_protocol, 'openai.chat')
  assert.match(writes.join(''), /chat\.completion\.chunk/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('GPT on anthropic.messages converts and pins a GPT slot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-anth-'))
  writeGptVm(root, 'vm-gpt-a')
  const writes = []
  const res = {
    headersSent: false,
    write(chunk) {
      this.headersSent = true
      writes.push(String(chunk))
    },
    end() {
      this.ended = true
    },
  }
  const logBag = {}
  await handleCodexProtocol({
    req: { headers: { 'user-agent': 'curl/8.0' } },
    res,
    protocol: 'anthropic.messages',
    ctx: {
      body: {
        model: 'gpt-6-astra',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      },
    },
    inbound: { stream: true },
    logBag,
    stats: { errors: 0, requests: 0, by_route: {} },
    json: (_res, status, body) => {
      res.statusCode = status
      res.body = body
      return body
    },
    writeSSEHeaders() {
      res.headersSent = true
    },
    routing: {
      codex: {
        protocols: { 'anthropic.messages': { mode: 'convert', enabled: true } },
        convert: { anthropic_to_codex: true },
        clients: { unknown: 'allow', openai_compatible: 'allow' },
      },
    },
    projectRoot: root,
    ops: {
      writeCodexKernelConfig() {},
      ensureCodexKernel: async () => ({ ok: true }),
      streamCodexKernel: async ({ onEvent }) => {
        await onEvent('data: {"type":"response.output_text.delta","delta":"Hi"}')
        await onEvent('data: {"type":"response.completed"}')
        return { ok: true, status: 200, terminalState: 'verified' }
      },
    },
  })
  assert.equal(logBag.vm_id, 'vm-gpt-a')
  assert.equal(logBag.error_code, undefined)
  assert.match(writes.join(''), /message_start/)
  assert.match(writes.join(''), /Hi/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('nested Responses cached_tokens reaches the request log cache column', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-cache-'))
  writeGptVm(root, 'vm-gpt-a')
  const res = {
    headersSent: false,
    write() {
      this.headersSent = true
    },
    end() {
      this.ended = true
    },
  }
  const logBag = {}
  await handleCodexProtocol({
    req: { headers: {} },
    res,
    protocol: 'openai.responses',
    ctx: { body: { model: 'gpt-5.4', input: [], stream: true } },
    inbound: { stream: true },
    logBag,
    stats: { errors: 0, requests: 0, by_route: {} },
    json: (_res, status, body) => {
      res.statusCode = status
      res.body = body
      return body
    },
    writeSSEHeaders() {
      res.headersSent = true
    },
    routing: {},
    projectRoot: root,
    ops: {
      writeCodexKernelConfig() {},
      ensureCodexKernel: async () => ({ ok: true }),
      streamCodexKernel: async ({ onEvent }) => {
        await onEvent('data: {"type":"response.completed"}')
        return {
          ok: true,
          status: 200,
          terminalState: 'verified',
          // merged trailer + SSE usage: totals flat, cache read nested
          usage: { input_tokens: 120, output_tokens: 9, input_tokens_details: { cached_tokens: 8 } },
        }
      },
    },
  })
  assert.equal(logBag.input_tokens, 112)
  assert.equal(logBag.output_tokens, 9)
  assert.equal(logBag.cache_read_tokens, 8)
  fs.rmSync(root, { recursive: true, force: true })
})

test('request log first_token_ms uses firstTokenAt minus injected ingress t0', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-ttft-'))
  writeGptVm(root, 'vm-gpt-a')
  const res = {
    headersSent: false,
    write() {
      this.headersSent = true
    },
    end() {
      this.ended = true
    },
  }
  const t0 = 1_700_000_000_000
  const logBag = {}
  await handleCodexProtocol({
    req: { headers: {} },
    res,
    protocol: 'openai.responses',
    ctx: { body: { model: 'gpt-5.4', input: [], stream: true } },
    inbound: { stream: true },
    logBag,
    stats: { errors: 0, requests: 0, by_route: {} },
    json: (_res, status, body) => {
      res.statusCode = status
      res.body = body
      return body
    },
    writeSSEHeaders() {
      res.headersSent = true
    },
    routing: {},
    projectRoot: root,
    requestStartedAt: t0,
    ops: {
      writeCodexKernelConfig() {},
      ensureCodexKernel: async () => ({ ok: true }),
      streamCodexKernel: async () => ({
        ok: true,
        status: 200,
        terminalState: 'verified',
        ttftMs: 300,
        firstTokenAt: t0 + 1500,
        usage: { input_tokens: 4, output_tokens: 1 },
      }),
    },
  })
  assert.equal(logBag.first_token_ms, 1500)
  fs.rmSync(root, { recursive: true, force: true })
})

test('request log first_token_ms falls back to hop ttftMs without firstTokenAt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-ttft-fb-'))
  writeGptVm(root, 'vm-gpt-a')
  const res = {
    headersSent: false,
    write() {
      this.headersSent = true
    },
    end() {
      this.ended = true
    },
  }
  const logBag = {}
  await handleCodexProtocol({
    req: { headers: {} },
    res,
    protocol: 'openai.responses',
    ctx: { body: { model: 'gpt-5.4', input: [], stream: true } },
    inbound: { stream: true },
    logBag,
    stats: { errors: 0, requests: 0, by_route: {} },
    json: (_res, status, body) => {
      res.statusCode = status
      res.body = body
      return body
    },
    writeSSEHeaders() {
      res.headersSent = true
    },
    routing: {},
    projectRoot: root,
    requestStartedAt: 1_700_000_000_000,
    ops: {
      writeCodexKernelConfig() {},
      ensureCodexKernel: async () => ({ ok: true }),
      streamCodexKernel: async () => ({
        ok: true,
        status: 200,
        terminalState: 'verified',
        ttftMs: 300,
        usage: { input_tokens: 4, output_tokens: 1 },
      }),
    },
  })
  assert.equal(logBag.first_token_ms, 300)
  fs.rmSync(root, { recursive: true, force: true })
})

test('incomplete Responses stream still bills tokens from the completed event', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-bill-'))
  writeGptVm(root, 'vm-gpt-a')
  const res = {
    headersSent: false,
    write() {
      this.headersSent = true
    },
    end() {
      this.ended = true
    },
  }
  const logBag = {}
  const stats = { errors: 0, requests: 0, by_route: {} }
  await handleCodexProtocol({
    req: { headers: {} },
    res,
    protocol: 'openai.responses',
    ctx: { body: { model: 'gpt-5.5', input: [], stream: true } },
    inbound: { stream: true },
    logBag,
    stats,
    json: (_res, status, body) => {
      res.statusCode = status
      res.body = body
      return body
    },
    writeSSEHeaders() {
      res.headersSent = true
    },
    routing: {},
    projectRoot: root,
    ops: {
      writeCodexKernelConfig() {},
      ensureCodexKernel: async () => ({ ok: true }),
      streamCodexKernel: async ({ onEvent }) => {
        await onEvent('data: {"type":"response.output_text.delta","delta":"Hi"}')
        await onEvent(
          'data: {"type":"response.completed","response":{"service_tier":"priority","usage":{"input_tokens":40,"output_tokens":2,"input_tokens_details":{"cached_tokens":5}}}}',
        )
        return {
          ok: false,
          status: 200,
          terminalState: 'incomplete',
          usage: { input_tokens: 0, output_tokens: 0 },
        }
      },
    },
  })
  assert.equal(logBag.input_tokens, 35)
  assert.equal(logBag.output_tokens, 2)
  assert.equal(logBag.cache_read_tokens, 5)
  assert.equal(logBag.usage.service_tier, 'priority')
  assert.equal(logBag.error_code, undefined)
  assert.equal(logBag.final_state, 'verified')
  assert.equal(stats.errors, 0)
  fs.rmSync(root, { recursive: true, force: true })
})

test('panel allowed_models on the VM record rejects other GPT models before the hop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-allow-'))
  writeGptVm(root, 'vm-gpt-a')
  const file = path.join(root, 'vms', 'vm-gpt-a.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...raw, policy: { allowed_models: ['gpt-5.5'] } }))
  let hops = 0
  const run = (model) => {
    const res = { headersSent: false, write() {}, end() {} }
    return handleCodexProtocol({
      req: { headers: { 'user-agent': 'curl/8.0' } },
      res,
      protocol: 'openai.responses',
      ctx: { path: '/v1/responses', body: { model, input: 'hi', stream: false } },
      inbound: { stream: false },
      logBag: {},
      stats: { errors: 0, requests: 0, by_route: {} },
      json: (_res, status, body) => ({ status, body }),
      writeSSEHeaders() {},
      routing: {},
      projectRoot: root,
      ops: {
        writeCodexKernelConfig() {},
        ensureCodexKernel: async () => ({ ok: true }),
        streamCodexKernel: async ({ onEvent }) => {
          hops++
          await onEvent('data: {"type":"response.completed"}')
          return { ok: true, status: 200, terminalState: 'verified' }
        },
      },
    })
  }
  const denied = await run('gpt-5.4')
  assert.equal(denied.status, 400)
  assert.equal(denied.body.error.code, 'model_not_allowed')
  assert.equal(hops, 0)
  await run('gpt-5.5')
  assert.equal(hops, 1)
  fs.rmSync(root, { recursive: true, force: true })
})

test('GPT slot at max concurrency queues until a seat frees instead of 503', async () => {
  const rt = await import('../../src/lib/pool/openai-account-runtime.mjs')
  rt.resetOpenAIAccountRuntime()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-queue-'))
  writeGptVm(root, 'vm-gpt-a')
  const file = path.join(root, 'vms', 'vm-gpt-a.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...raw, policy: { maxConcurrency: 1 } }))
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let hops = 0
  const run = (wait) =>
    handleCodexProtocol({
      req: { headers: { 'user-agent': 'curl/8.0' } },
      res: { headersSent: false, write() {}, end() {} },
      protocol: 'openai.responses',
      ctx: { path: '/v1/responses', body: { model: 'gpt-5.5', input: 'hi', stream: false } },
      inbound: { stream: false },
      logBag: {},
      stats: { errors: 0, requests: 0, by_route: {} },
      json: (_res, status, body) => ({ status, body }),
      writeSSEHeaders() {},
      routing: { pool: { fallback_wait_timeout_ms: 5000 } },
      projectRoot: root,
      ops: {
        writeCodexKernelConfig() {},
        ensureCodexKernel: async () => ({ ok: true }),
        streamCodexKernel: async ({ onEvent }) => {
          hops++
          if (wait) await gate
          await onEvent('data: {"type":"response.completed"}')
          return { ok: true, status: 200, terminalState: 'verified' }
        },
      },
    })
  const busy = run(true)
  await new Promise((resolve) => setImmediate(resolve))
  const queued = run(false)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(hops, 1)
  assert.equal(rt.openAIWaiterCount(), 1)
  release()
  const [a, b] = await Promise.all([busy, queued])
  assert.equal(a.status, 200)
  assert.equal(b.status, 200)
  assert.equal(hops, 2)
  rt.resetOpenAIAccountRuntime()
  fs.rmSync(root, { recursive: true, force: true })
})

function codexArgs(root, ops, extras = {}) {
  return {
    req: { headers: { 'user-agent': 'curl/8.0', ...(extras.headers || {}) }, apiKeyKind: 'user' },
    res: { headersSent: false, write() {}, end() {} },
    protocol: 'openai.responses',
    ctx: { path: '/v1/responses', body: extras.body || { model: 'gpt-5.5', input: 'hi', stream: false } },
    inbound: { stream: false },
    logBag: extras.logBag || {},
    stats: { errors: 0, requests: 0, by_route: {} },
    json: (_res, status, body) => ({ status, body }),
    writeSSEHeaders() {},
    routing: extras.routing || { pool: { fallback_wait_timeout_ms: 5000 } },
    projectRoot: root,
    stickyRouter: extras.stickyRouter || null,
    ops: { writeCodexKernelConfig() {}, ...ops },
  }
}

test('#A07: two admissions racing through kernel init never exceed a cap of 1', async () => {
  const rt = await import('../../src/lib/pool/openai-account-runtime.mjs')
  rt.resetOpenAIAccountRuntime()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-atomic-'))
  writeGptVm(root, 'vm-gpt-a')
  const file = path.join(root, 'vms', 'vm-gpt-a.json')
  fs.writeFileSync(
    file,
    JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), policy: { maxConcurrency: 1 } }),
  )
  let active = 0
  let maxActive = 0
  const ops = {
    ensureCodexKernel: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { ok: true }
    },
    streamCodexKernel: async ({ onEvent }) => {
      active += 1
      maxActive = Math.max(maxActive, active, rt.openAIRuntimeSignals('vm-gpt-a').inFlight)
      await new Promise((resolve) => setTimeout(resolve, 10))
      await onEvent('data: {"type":"response.completed"}')
      active -= 1
      return { ok: true, status: 200, terminalState: 'verified' }
    },
  }
  const [a, b] = await Promise.all([
    handleCodexProtocol(codexArgs(root, ops)),
    handleCodexProtocol(codexArgs(root, ops)),
  ])
  assert.equal(a.status, 200)
  assert.equal(b.status, 200)
  assert.equal(maxActive, 1)
  assert.equal(rt.openAIRuntimeSignals('vm-gpt-a').inFlight, 0)
  rt.resetOpenAIAccountRuntime()
  fs.rmSync(root, { recursive: true, force: true })
})

test('#A04: the fifth GPT slot is reached after four slots fail over', async () => {
  const rt = await import('../../src/lib/pool/openai-account-runtime.mjs')
  rt.resetOpenAIAccountRuntime()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-fifth-'))
  const ids = ['vm-gpt-a', 'vm-gpt-b', 'vm-gpt-c', 'vm-gpt-d', 'vm-gpt-e']
  for (const id of ids) writeGptVm(root, id)
  const seen = []
  const logBag = {}
  const out = await handleCodexProtocol(
    codexArgs(
      root,
      {
        ensureCodexKernel: async () => ({ ok: true }),
        streamCodexKernel: async ({ exec, onEvent }) => {
          seen.push(exec.vm.id)
          if (seen.length < 5) {
            return { ok: false, status: 429, body: { error: { code: 'rate_limit_exceeded', message: 'slow down' } } }
          }
          await onEvent('data: {"type":"response.completed"}')
          return { ok: true, status: 200, terminalState: 'verified' }
        },
      },
      { logBag, routing: { failover: { max_account_switches: 10 } } },
    ),
  )
  assert.equal(out.status, 200)
  assert.equal(seen.length, 5)
  assert.equal(new Set(seen).size, 5)
  assert.equal(logBag.attempt_count, 5)
  assert.equal(logBag.vm_id, seen[4])
  rt.resetOpenAIAccountRuntime()
  fs.rmSync(root, { recursive: true, force: true })
})

test('uncommitted 503 server_error fails over to the next GPT slot', async () => {
  const rt = await import('../../src/lib/pool/openai-account-runtime.mjs')
  rt.resetOpenAIAccountRuntime()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-503-'))
  for (const id of ['vm-gpt-a', 'vm-gpt-b']) writeGptVm(root, id)
  const seen = []
  const logBag = {}
  const out = await handleCodexProtocol(
    codexArgs(
      root,
      {
        ensureCodexKernel: async () => ({ ok: true }),
        streamCodexKernel: async ({ exec, onEvent }) => {
          seen.push(exec.vm.id)
          if (seen.length === 1) {
            return {
              ok: false,
              status: 503,
              committed: false,
              body: { error: { type: 'server_error', code: 'server_error', message: 'busy' } },
            }
          }
          await onEvent('data: {"type":"response.completed"}')
          return { ok: true, status: 200, terminalState: 'verified' }
        },
      },
      { logBag, routing: { failover: { max_same_account_retries: 0 } } },
    ),
  )
  assert.equal(out.status, 200)
  assert.equal(seen.length, 2)
  assert.notEqual(seen[0], seen[1])
  assert.equal(logBag.attempt_count, 2)
  rt.resetOpenAIAccountRuntime()
  fs.rmSync(root, { recursive: true, force: true })
})

test('uncommitted 500 server_error fails over to the next GPT slot', async () => {
  const rt = await import('../../src/lib/pool/openai-account-runtime.mjs')
  rt.resetOpenAIAccountRuntime()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-500-'))
  for (const id of ['vm-gpt-a', 'vm-gpt-b']) writeGptVm(root, id)
  const seen = []
  const out = await handleCodexProtocol(
    codexArgs(
      root,
      {
        ensureCodexKernel: async () => ({ ok: true }),
        streamCodexKernel: async ({ exec, onEvent }) => {
          seen.push(exec.vm.id)
          if (seen.length === 1) {
            return {
              ok: false,
              status: 500,
              committed: false,
              body: { error: { type: 'server_error', code: 'server_error', message: 'upstream' } },
            }
          }
          await onEvent('data: {"type":"response.completed"}')
          return { ok: true, status: 200, terminalState: 'verified' }
        },
      },
      { routing: { failover: { max_same_account_retries: 0 } } },
    ),
  )
  assert.equal(out.status, 200)
  assert.deepEqual(seen, ['vm-gpt-a', 'vm-gpt-b'])
  rt.resetOpenAIAccountRuntime()
  fs.rmSync(root, { recursive: true, force: true })
})

test('transient GPT failures retry the same account three times before switching', async () => {
  const rt = await import('../../src/lib/pool/openai-account-runtime.mjs')
  rt.resetOpenAIAccountRuntime()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-same-retry-'))
  for (const id of ['vm-gpt-a', 'vm-gpt-b']) writeGptVm(root, id)
  const seen = []
  const logBag = {}
  const out = await handleCodexProtocol(
    codexArgs(
      root,
      {
        ensureCodexKernel: async () => ({ ok: true }),
        streamCodexKernel: async ({ exec, onEvent }) => {
          seen.push(exec.vm.id)
          if (exec.vm.id === 'vm-gpt-a') {
            return {
              ok: false,
              status: 500,
              committed: false,
              body: { error: { type: 'server_error', code: 'server_error', message: 'upstream' } },
            }
          }
          await onEvent('data: {"type":"response.completed"}')
          return { ok: true, status: 200, terminalState: 'verified' }
        },
      },
      {
        logBag,
        routing: { failover: { max_total_attempts: 12, max_same_account_retries: 3, max_account_switches: 3 } },
      },
    ),
  )
  assert.equal(out.status, 200)
  assert.deepEqual(seen, ['vm-gpt-a', 'vm-gpt-a', 'vm-gpt-a', 'vm-gpt-a', 'vm-gpt-b'])
  assert.equal(logBag.attempt_count, 5)
  assert.equal(logBag.codex_same_account_retried, 3)
  rt.resetOpenAIAccountRuntime()
  fs.rmSync(root, { recursive: true, force: true })
})

test('same-account retry never replays after the first SSE event', async () => {
  const rt = await import('../../src/lib/pool/openai-account-runtime.mjs')
  rt.resetOpenAIAccountRuntime()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-same-emitted-'))
  for (const id of ['vm-gpt-a', 'vm-gpt-b']) writeGptVm(root, id)
  const seen = []
  const out = await handleCodexProtocol(
    codexArgs(root, {
      ensureCodexKernel: async () => ({ ok: true }),
      streamCodexKernel: async ({ exec, onEvent }) => {
        seen.push(exec.vm.id)
        await onEvent('data: {"type":"response.created"}')
        return { ok: false, status: 500, committed: false, body: { error: { code: 'server_error' } } }
      },
    }),
  )
  assert.equal(out, undefined)
  assert.deepEqual(seen, ['vm-gpt-a'])
  rt.resetOpenAIAccountRuntime()
  fs.rmSync(root, { recursive: true, force: true })
})

test('Codex failover stops at the configured attempt budget', async () => {
  const rt = await import('../../src/lib/pool/openai-account-runtime.mjs')
  rt.resetOpenAIAccountRuntime()
  assert.deepEqual(codexFailoverBudget({ failover: { max_total_attempts: 3, max_account_switches: 2 } }), {
    maxAttempts: 3,
    maxSwitches: 2,
    maxSameAccountRetries: 3,
  })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-budget-'))
  for (const id of ['vm-gpt-a', 'vm-gpt-b', 'vm-gpt-c']) writeGptVm(root, id)
  const seen = []
  const out = await handleCodexProtocol(
    codexArgs(
      root,
      {
        ensureCodexKernel: async () => ({ ok: true }),
        streamCodexKernel: async ({ exec }) => {
          seen.push(exec.vm.id)
          return { ok: false, status: 500, committed: false, body: { error: { code: 'server_error' } } }
        },
      },
      { routing: { failover: { max_total_attempts: 2, max_account_switches: 10 } } },
    ),
  )
  assert.equal(out.status, 500)
  assert.equal(seen.length, 2)
  rt.resetOpenAIAccountRuntime()
  fs.rmSync(root, { recursive: true, force: true })
})

test('a 401 parks the GPT slot so the next request skips it', async () => {
  const rt = await import('../../src/lib/pool/openai-account-runtime.mjs')
  rt.resetOpenAIAccountRuntime()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-401-'))
  for (const id of ['vm-gpt-a', 'vm-gpt-b']) writeGptVm(root, id)
  const seen = []
  const ops = {
    ensureCodexKernel: async () => ({ ok: true }),
    streamCodexKernel: async ({ exec, onEvent }) => {
      seen.push(exec.vm.id)
      if (exec.vm.id === 'vm-gpt-a') {
        return {
          ok: false,
          status: 401,
          committed: false,
          body: { error: { type: 'authentication_error', code: 'oauth_401', message: 'token expired' } },
        }
      }
      await onEvent('data: {"type":"response.completed"}')
      return { ok: true, status: 200, terminalState: 'verified' }
    },
  }
  const first = await handleCodexProtocol(codexArgs(root, ops))
  assert.equal(first.status, 200)
  assert.deepEqual(seen, ['vm-gpt-a', 'vm-gpt-b'])
  assert.ok(rt.openAIAccountHold('vm-gpt-a'))
  seen.length = 0
  const second = await handleCodexProtocol(codexArgs(root, ops))
  assert.equal(second.status, 200)
  assert.deepEqual(seen, ['vm-gpt-b'])
  rt.resetOpenAIAccountRuntime()
  fs.rmSync(root, { recursive: true, force: true })
})

test('failure holds ignore committed streams and request-shaped 400s', () => {
  const now = 1_700_000_000_000
  assert.equal(codexFailureHold({ ok: false, status: 401, committed: true }, now), null)
  assert.equal(
    codexFailureHold({ ok: false, status: 400, body: { error: { code: 'invalid_request_error' } } }, now),
    null,
  )
  assert.deepEqual(codexFailureHold({ ok: false, status: 401, committed: false }, now), {
    until: now + 5 * 60_000,
    reason: 'oauth_401',
  })
  assert.equal(
    codexFailureHold(
      { ok: false, status: 401, body: { error: { code: 'invalid_request', message: 'token expired' } } },
      now,
    ).reason,
    'oauth_401',
  )
  assert.equal(
    codexFailureHold(
      { ok: false, status: 403, body: { error: { code: 'content_policy_violation', message: 'blocked' } } },
      now,
    ),
    null,
  )
})

test('#A11: an OpenAI pool that stays full answers 429 pool_overloaded', async () => {
  const rt = await import('../../src/lib/pool/openai-account-runtime.mjs')
  rt.resetOpenAIAccountRuntime()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-full-'))
  const vmId = 'vm-gpt-full'
  writeGptVm(root, vmId)
  const file = path.join(root, 'vms', `${vmId}.json`)
  fs.writeFileSync(
    file,
    JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), policy: { maxConcurrency: 1 } }),
  )
  const held = rt.tryAcquireOpenAISlot(vmId, { concurrency: 1 })
  const args = codexArgs(root, { ensureCodexKernel: async () => ({ ok: true }) })
  args.routing = { pool: { fallback_wait_timeout_ms: 1000 } }
  const headers = {}
  args.res.setHeader = (name, value) => {
    headers[name] = value
  }
  // Waiter timers are unref'd so a systemd process can idle-exit. Keep one
  // ref'd handle so this isolated file cannot drain before the 1s deadline.
  const keepAlive = setTimeout(() => {}, 15_000)
  try {
    const out = await handleCodexProtocol(args)
    assert.equal(out.status, 429)
    assert.equal(out.body.error.code, 'pool_overloaded')
    assert.equal(out.body.error.message, '号池负载过高，稍后再试')
    assert.ok(Number(headers['retry-after']) >= 1)
  } finally {
    clearTimeout(keepAlive)
    held.release()
    rt.resetOpenAIAccountRuntime()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an all-rest OpenAI pool answers 503 with Retry-After for the next window', async () => {
  const rt = await import('../../src/lib/pool/openai-account-runtime.mjs')
  rt.resetOpenAIAccountRuntime()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-rest-'))
  const vmId = 'vm-gpt-rest'
  writeGptVm(root, vmId)
  const file = path.join(root, 'vms', `${vmId}.json`)
  // A UTC window opening 2–3h from now: `now` is always outside.
  const pad = (n) => String(n).padStart(2, '0')
  const hour = new Date().getUTCHours()
  const active_hours = { start: `${pad((hour + 3) % 24)}:00`, end: `${pad((hour + 5) % 24)}:00`, timezone: 'UTC' }
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), policy: { active_hours } }))
  const args = codexArgs(root, { ensureCodexKernel: async () => ({ ok: true }) })
  const headers = {}
  args.res.setHeader = (name, value) => {
    headers[name] = value
  }
  try {
    const out = await handleCodexProtocol(args)
    assert.equal(out.status, 503)
    assert.equal(out.body.error.code, 'pool_unavailable')
    assert.equal(out.body.error.details.reason, 'pool_resting')
    const secs = Number(headers['retry-after'])
    assert.ok(secs > 2 * 3600 && secs <= 3 * 3600, `retry-after=${secs}`)
  } finally {
    rt.resetOpenAIAccountRuntime()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function emptyCodexRes() {
  return { headersSent: false, write() {}, end() {} }
}

async function hopCodex({ root, stickyRouter, routing = {}, headers = {}, body, onHop }) {
  const envelopes = []
  const res = emptyCodexRes()
  const out = await handleCodexProtocol({
    req: { headers, apiKeyKind: 'user' },
    res,
    protocol: 'openai.responses',
    ctx: { body },
    inbound: { stream: false },
    logBag: {},
    stats: { errors: 0, requests: 0, by_route: {} },
    json: (_res, status, payload) => {
      res.statusCode = status
      res.body = payload
      return payload
    },
    writeSSEHeaders() {
      res.headersSent = true
    },
    routing,
    projectRoot: root,
    stickyRouter,
    ops: {
      writeCodexKernelConfig() {},
      ensureCodexKernel: async () => ({ ok: true }),
      streamCodexKernel: async (args) => {
        envelopes.push(args.envelope)
        if (onHop) return onHop(args)
        return { ok: true, status: 200, terminalState: 'verified', body: { id: 'resp_ok' } }
      },
    },
  })
  return { out, envelopes, res }
}

test('codex rebuild outbound session is not the inbound session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-sess-'))
  const sticky = new StickyRouter({ dataDir: path.join(root, 'data'), config: { sticky: { enabled: true } } })
  writeGptVm(root, 'vm-gpt-a')
  const inbound = '11111111-1111-4111-8111-111111111111'
  const { envelopes } = await hopCodex({
    root,
    stickyRouter: sticky,
    headers: { 'x-session-id': inbound },
    body: {
      model: 'gpt-5.4',
      input: 'hi',
      stream: false,
      prompt_cache_key: inbound,
      conversation_id: inbound,
      session_id: inbound,
      previous_response_id: 'resp_keep',
    },
  })
  const session = envelopes[0].session
  assert.notEqual(session.session_id, inbound)
  assert.match(session.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(session.previous_response_id, 'resp_keep')
  assert.equal(envelopes[0].body.prompt_cache_key, session.session_id)
  assert.equal(envelopes[0].body.conversation_id, undefined)
  assert.equal(envelopes[0].body.session_id, undefined)
  sticky.db?.close?.()
  fs.rmSync(root, { recursive: true, force: true })
})

test('codex kernel envelope preserves official routing headers without client auth', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-routing-headers-'))
  const sticky = new StickyRouter({ dataDir: path.join(root, 'data'), config: { sticky: { enabled: true } } })
  writeGptVm(root, 'vm-gpt-a')
  const { envelopes } = await hopCodex({
    root,
    stickyRouter: sticky,
    headers: {
      authorization: 'Bearer sub2api-key',
      originator: 'Codex Desktop',
      'openai-beta': 'responses_websockets=2026-02-06',
      'session-id': 'session:t',
      'thread-id': 'thread:t',
      'x-client-request-id': 'request:t',
      'x-codex-beta-features': 'remote_compaction_v2',
      'x-codex-turn-metadata': '{"thread_id":"t"}',
      'x-codex-window-id': 'window:2',
      'x-openai-internal-codex-responses-lite': 'true',
    },
    body: { model: 'gpt-6.1-sol', input: 'hi', stream: false, service_tier: 'fast' },
  })
  const session = envelopes[0].session
  assert.deepEqual(envelopes[0].headers, {
    originator: 'Codex Desktop',
    'openai-beta': 'responses_websockets=2026-02-06',
    'session-id': session.session_id,
    'thread-id': 'thread:t',
    'x-client-request-id': 'request:t',
    'x-codex-beta-features': 'remote_compaction_v2',
    'x-codex-turn-metadata': '{"thread_id":"t"}',
    'x-codex-window-id': 'window:2',
    'x-openai-internal-codex-responses-lite': 'true',
    'x-codex-routing-hint': 'model=gpt-6.1-sol;tier=priority',
  })
  assert.notEqual(envelopes[0].headers['session-id'], 'session:t')
  assert.equal(envelopes[0].headers['session-id'], session.session_id)
  assert.equal(envelopes[0].headers.authorization, undefined)
  assert.equal(envelopes[0].body.service_tier, 'priority')
  sticky.db?.close?.()
  fs.rmSync(root, { recursive: true, force: true })
})

test('codex rebuild outbound session is stable on the same slot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-stable-'))
  const sticky = new StickyRouter({ dataDir: path.join(root, 'data'), config: { sticky: { enabled: true } } })
  writeGptVm(root, 'vm-gpt-a')
  const inbound = 'sess-stable'
  const first = await hopCodex({
    root,
    stickyRouter: sticky,
    headers: { 'x-session-id': inbound },
    body: { model: 'gpt-5.4', input: 'hi', stream: false },
  })
  const second = await hopCodex({
    root,
    stickyRouter: sticky,
    headers: { 'x-session-id': inbound },
    body: { model: 'gpt-5.4', input: 'hi again', stream: false },
  })
  assert.equal(first.envelopes[0].session.session_id, second.envelopes[0].session.session_id)
  sticky.db?.close?.()
  fs.rmSync(root, { recursive: true, force: true })
})

test('codex rebuild remints session after failover to another slot', async () => {
  const rt = await import('../../src/lib/pool/openai-account-runtime.mjs')
  rt.resetOpenAIAccountRuntime()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-fail-'))
  const sticky = new StickyRouter({ dataDir: path.join(root, 'data'), config: { sticky: { enabled: true } } })
  writeGptVm(root, 'vm-gpt-a')
  writeGptVm(root, 'vm-gpt-b')
  const inbound = 'sess-fail'
  const seen = []
  const envelopes = []
  const res = emptyCodexRes()
  await handleCodexProtocol({
    req: { headers: { 'x-session-id': inbound }, apiKeyKind: 'user' },
    res,
    protocol: 'openai.responses',
    ctx: { body: { model: 'gpt-5.4', input: 'hi', stream: false } },
    inbound: { stream: false },
    logBag: {},
    stats: { errors: 0, requests: 0, by_route: {} },
    json: (_res, status, payload) => {
      res.statusCode = status
      return payload
    },
    writeSSEHeaders() {
      res.headersSent = true
    },
    routing: {},
    projectRoot: root,
    stickyRouter: sticky,
    ops: {
      writeCodexKernelConfig() {},
      ensureCodexKernel: async () => ({ ok: true }),
      streamCodexKernel: async ({ exec, envelope }) => {
        seen.push(exec.vmId)
        envelopes.push(envelope)
        if (exec.vmId === 'vm-gpt-a') {
          return {
            ok: false,
            status: 429,
            committed: false,
            headers: {
              'x-codex-primary-used-percent': '100',
              'x-codex-primary-window-minutes': '300',
              'x-codex-primary-reset-after-seconds': '60',
            },
            body: { error: { type: 'api_error', code: 'usage_limit_reached', message: '5h' } },
          }
        }
        return { ok: true, status: 200, terminalState: 'verified', body: { id: 'resp_ok' } }
      },
    },
  })
  assert.deepEqual(seen, ['vm-gpt-a', 'vm-gpt-b'])
  assert.equal(envelopes.length, 2)
  assert.notEqual(envelopes[0].session.session_id, inbound)
  assert.notEqual(envelopes[1].session.session_id, inbound)
  assert.notEqual(envelopes[0].session.session_id, envelopes[1].session.session_id)
  rt.resetOpenAIAccountRuntime()
  sticky.db?.close?.()
  fs.rmSync(root, { recursive: true, force: true })
})

test('codex passthrough keeps the inbound session and cache key', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-pass-'))
  const sticky = new StickyRouter({ dataDir: path.join(root, 'data'), config: { sticky: { enabled: true } } })
  writeGptVm(root, 'vm-gpt-a')
  const inbound = 'sess-pass'
  const { envelopes } = await hopCodex({
    root,
    stickyRouter: sticky,
    routing: { sticky: { outbound_session: 'passthrough' } },
    headers: { 'x-session-id': inbound },
    body: {
      model: 'gpt-5.4',
      input: 'hi',
      stream: false,
      prompt_cache_key: 'cache-pass',
      conversation_id: inbound,
    },
  })
  assert.equal(envelopes[0].session.session_id, inbound)
  assert.equal(envelopes[0].body.prompt_cache_key, 'cache-pass')
  assert.equal(envelopes[0].body.conversation_id, inbound)
  sticky.db?.close?.()
  fs.rmSync(root, { recursive: true, force: true })
})

test('codex passthrough without an inbound session derives a stable fallback session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-pass-fallback-'))
  const sticky = new StickyRouter({ dataDir: path.join(root, 'data'), config: { sticky: { enabled: true } } })
  writeGptVm(root, 'vm-gpt-a')
  const opener = (question) => ({
    model: 'gpt-5.4',
    stream: false,
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '<system-reminder>Today: 2026-10-04; cwd: /work/demo</system-reminder>' },
          { type: 'input_text', text: question },
        ],
      },
    ],
  })
  const routing = { sticky: { outbound_session: 'passthrough' } }
  const first = await hopCodex({ root, stickyRouter: sticky, routing, body: opener('会话 A 的问题') })
  const again = await hopCodex({ root, stickyRouter: sticky, routing, body: opener('会话 A 的问题') })
  const other = await hopCodex({ root, stickyRouter: sticky, routing, body: opener('会话 B 的问题') })
  const sessionId = first.envelopes[0].session.session_id
  assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(again.envelopes[0].session.session_id, sessionId)
  assert.notEqual(other.envelopes[0].session.session_id, sessionId)
  sticky.db?.close?.()
  fs.rmSync(root, { recursive: true, force: true })
})

test('official Codex passthrough keeps native content and rebuilds session plus cache key', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-official-pass-'))
  const sticky = new StickyRouter({ dataDir: path.join(root, 'data'), config: { sticky: { enabled: true } } })
  writeGptVm(root, 'vm-gpt-a')
  const inbound = 'sess-official-pass'
  const body = {
    model: 'gpt-5.5',
    instructions: 'You are Codex, a coding agent.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    stream: false,
    prompt_cache_key: 'cache-official-pass',
    conversation_id: inbound,
    session_id: inbound,
    max_output_tokens: 8192,
    temperature: 0.2,
    reasoning: { effort: 'high' },
  }
  const { envelopes } = await hopCodex({
    root,
    stickyRouter: sticky,
    routing: { codex: { official_passthrough: true } },
    headers: {
      'user-agent': 'codex_cli_rs/0.160.0 (linux x86_64)',
      originator: 'codex_cli_rs',
      'session-id': inbound,
    },
    body,
  })
  const sent = envelopes[0]
  assert.deepEqual(sent.body.instructions, body.instructions)
  assert.deepEqual(sent.body.input, body.input)
  assert.equal(sent.body.prompt_cache_key, sent.session.session_id)
  assert.notEqual(sent.body.prompt_cache_key, 'cache-official-pass')
  assert.equal(sent.body.conversation_id, undefined)
  assert.equal(sent.body.session_id, undefined)
  assert.equal(sent.body.max_output_tokens, 8192)
  assert.equal(sent.body.temperature, 0.2)
  assert.notEqual(sent.session.session_id, inbound)
  assert.match(sent.session.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  sticky.db?.close?.()
  fs.rmSync(root, { recursive: true, force: true })
})

test('openai.responses stream names each kernel SSE frame after its payload type', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-sse-names-'))
  writeGptVm(root, 'vm-gpt-a')
  const writes = []
  const res = {
    headersSent: false,
    write(chunk) {
      this.headersSent = true
      writes.push(String(chunk))
    },
    end() {},
  }
  await handleCodexProtocol({
    req: { headers: {} },
    res,
    protocol: 'openai.responses',
    ctx: { path: '/v1/responses', body: { model: 'gpt-5.5', input: 'hi', stream: true } },
    inbound: { stream: true },
    logBag: {},
    stats: { errors: 0, requests: 0, by_route: {} },
    json: (_res, status, body) => {
      res.statusCode = status
      res.body = body
      return body
    },
    writeSSEHeaders() {
      res.headersSent = true
    },
    routing: {},
    projectRoot: root,
    ops: {
      writeCodexKernelConfig() {},
      ensureCodexKernel: async () => ({ ok: true }),
      streamCodexKernel: async ({ onEvent }) => {
        // kin-codex-kernel labels every frame "event: response"
        for (const line of [
          'event: response',
          'data: {"type":"response.created","response":{"id":"resp_1"}}',
          '',
          'event: response',
          'data: {"type":"response.output_text.delta","delta":"pong"}',
          '',
          'event: response',
          'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}',
          '',
        ]) {
          await onEvent(line)
        }
        return { ok: true, status: 200, terminalState: 'verified' }
      },
    },
  })
  const out = writes.join('')
  assert.doesNotMatch(out, /^event: response$/m)
  assert.match(out, /^event: response\.created\ndata: \{"type":"response\.created"/m)
  assert.match(out, /^event: response\.output_text\.delta\ndata: /m)
  assert.match(out, /^event: response\.completed\ndata: /m)
  fs.rmSync(root, { recursive: true, force: true })
})

test('tool argument disagreement terminates the client stream instead of recording token usage as success', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-args-'))
  writeGptVm(root, 'vm-gpt-tools')
  let wire = ''
  const res = {
    headersSent: false,
    write: (chunk) => {
      wire += chunk
    },
    end() {},
  }
  const stats = { errors: 0, requests: 0, by_route: {} }
  const logBag = {}
  try {
    await handleCodexProtocol({
      req: { headers: {}, apiKeyKind: 'user' },
      res,
      protocol: 'openai.chat',
      ctx: { body: { model: 'gpt-5.4', messages: [{ role: 'user', content: 'edit' }], stream: true } },
      inbound: { stream: true },
      logBag,
      stats,
      projectRoot: root,
      routing: {},
      json: (_res, status, body) => {
        throw new Error(`Unexpected JSON ${status}: ${JSON.stringify(body)}`)
      },
      writeSSEHeaders: () => {
        res.headersSent = true
      },
      ops: {
        writeCodexKernelConfig() {},
        ensureCodexKernel: async () => ({ ok: true }),
        streamCodexKernel: async ({ onEvent }) => {
          for (const event of [
            {
              type: 'response.output_item.added',
              output_index: 0,
              item: { type: 'function_call', call_id: 'call_a', id: 'fc_a', name: 'edit', arguments: '' },
            },
            { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":' },
            { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"other":true}' },
            { type: 'response.completed', response: { usage: { input_tokens: 20, output_tokens: 3 } } },
          ])
            await onEvent(`data: ${JSON.stringify(event)}`)
          return { ok: true, status: 200, usage: { input_tokens: 20, output_tokens: 3 }, terminalState: 'verified' }
        },
      },
    })
    assert.match(wire, /"code":"tool_arguments_mismatch"/)
    assert.doesNotMatch(wire, /"finish_reason":"tool_calls"/)
    assert.equal(stats.errors, 1)
    assert.equal(logBag.error_code, 'tool_arguments_mismatch')
    assert.equal(logBag.upstream_status, 502)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Codex passthrough leaves prompt_cache_key/conversation/session untouched', () => {
  const body = {
    model: 'gpt-5.5',
    input: [],
    prompt_cache_key: 'caller-key',
    conversation_id: 'conv',
    session_id: 'sess',
  }
  assert.deepEqual(applyCodexRebuildBody(body, 'proxy-session', 'passthrough'), body)
  const rebuilt = applyCodexRebuildBody(body, 'proxy-session', 'rebuild')
  assert.equal(rebuilt.prompt_cache_key, 'proxy-session')
  assert.equal(rebuilt.conversation_id, undefined)
  assert.equal(rebuilt.session_id, undefined)
})
