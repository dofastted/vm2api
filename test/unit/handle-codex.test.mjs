import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  isRetryableCodexTransport,
  runCodexKernelHop,
  handleCodexProtocol,
} from '../../src/lib/protocol/handle-codex.mjs'
import { persistCodexUsage, getVm } from '../../src/lib/vm/vm-registry.mjs'

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
  assert.equal(logBag.input_tokens, 120)
  assert.equal(logBag.output_tokens, 9)
  assert.equal(logBag.cache_read_tokens, 8)
  fs.rmSync(root, { recursive: true, force: true })
})
