import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { consumeResponsesResponse, runVmTestChat } from '../../src/lib/admin/vm-test-chat.mjs'
import { VmTestScheduleRunner, VM_TEST_SCHEDULE_PREFIX } from '../../src/lib/admin/vm-test-schedule.mjs'

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function sseResponse(events) {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder()
      for (const ev of events) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`))
      }
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

test('consumeResponsesResponse strict: non-streaming missing status fails', async () => {
  const res = await consumeResponsesResponse(
    await jsonResponse(200, { id: 'r1', output_text: 'hi', usage: { input_tokens: 1, output_tokens: 1 } }),
    { requireTerminal: true },
  )
  assert.equal(res.ok, false)
  assert.equal(res.body?.error?.code, 'no_terminal_event')
})

test('consumeResponsesResponse strict: non-streaming incomplete fails', async () => {
  const res = await consumeResponsesResponse(
    await jsonResponse(200, { id: 'r1', status: 'incomplete', output_text: 'partial' }),
    { requireTerminal: true },
  )
  assert.equal(res.ok, false)
  assert.equal(res.body?.error?.code, 'response_incomplete')
})

test('consumeResponsesResponse strict: non-streaming completed succeeds', async () => {
  const res = await consumeResponsesResponse(
    await jsonResponse(200, { id: 'r1', status: 'completed', output_text: 'ok' }),
    { requireTerminal: true },
  )
  assert.equal(res.ok, true)
  assert.equal(res.text, 'ok')
})

test('consumeResponsesResponse legacy: non-streaming without status still ok', async () => {
  const res = await consumeResponsesResponse(await jsonResponse(200, { id: 'r1', output_text: 'legacy' }), {
    requireTerminal: false,
  })
  assert.equal(res.ok, true)
})

test('consumeResponsesResponse strict: stream without completed fails', async () => {
  const res = await consumeResponsesResponse(sseResponse([{ type: 'response.output_text.delta', delta: 'x' }]), {
    requireTerminal: true,
  })
  assert.equal(res.ok, false)
  assert.equal(res.body?.error?.code, 'no_terminal_event')
})

test('consumeResponsesResponse strict: response.failed fails', async () => {
  const res = await consumeResponsesResponse(
    sseResponse([{ type: 'response.failed', error: { code: 'server_error', message: 'boom' } }]),
    { requireTerminal: true },
  )
  assert.equal(res.ok, false)
})

test('consumeResponsesResponse strict: response.incomplete fails', async () => {
  const res = await consumeResponsesResponse(
    sseResponse([
      { type: 'response.output_text.delta', delta: 'p' },
      { type: 'response.incomplete', response: { id: 'r2', status: 'incomplete' } },
    ]),
    { requireTerminal: true },
  )
  assert.equal(res.ok, false)
  assert.equal(res.body?.error?.code, 'response_incomplete')
})

test('consumeResponsesResponse strict: completed terminal succeeds', async () => {
  const res = await consumeResponsesResponse(
    sseResponse([
      { type: 'response.output_text.delta', delta: 'hi' },
      {
        type: 'response.completed',
        response: { id: 'r3', status: 'completed', output_text: 'hi', usage: { input_tokens: 2, output_tokens: 1 } },
      },
    ]),
    { requireTerminal: true },
  )
  assert.equal(res.ok, true)
  assert.equal(res.text, 'hi')
})

test('consumeResponsesResponse legacy: stream without completed still ok', async () => {
  const res = await consumeResponsesResponse(
    sseResponse([{ type: 'response.output_text.delta', delta: 'legacy-stream' }]),
    { requireTerminal: false },
  )
  assert.equal(res.ok, true)
  assert.equal(res.text, 'legacy-stream')
})

function seedCodexVm(root, id = 'vm-codex-terminal') {
  const vms = path.join(root, 'vms')
  fs.mkdirSync(path.join(vms, id), { recursive: true })
  fs.writeFileSync(
    path.join(vms, `${id}.json`),
    JSON.stringify({
      id,
      name: id,
      status: 'running',
      schedulable: true,
      platform: 'openai',
      family: 'codex',
      proxy_cli_enabled: true,
      proxy: { id: `proxy-${id}`, url: 'socks5h://127.0.0.1:1080', host: '127.0.0.1', port: 1080 },
      codex: { has_access: true },
    }),
  )
  fs.writeFileSync(
    path.join(vms, id, 'codex-credentials.json'),
    JSON.stringify({
      accounts: [{ access_token: 'codex-access', refresh_token: 'codex-refresh' }],
    }),
  )
}

async function startCodexLoopback(t, handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const reply = handler(req)
    if (reply.sse) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const ev of reply.sse) res.write(`data: ${JSON.stringify(ev)}\n\n`)
      res.end()
      return
    }
    res.writeHead(reply.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(reply.body))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}`
}

test('runVmTestChat requireCodexTerminal rejects 200 JSON without status', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-term-json-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  seedCodexVm(root)
  fs.mkdirSync(path.join(root, 'src', 'config'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'config', 'routing.json'), '{}')
  const baseUrl = await startCodexLoopback(t, () => ({
    status: 200,
    body: { id: 'x', output_text: 'no-status' },
  }))
  const strict = await runVmTestChat({
    projectRoot: root,
    vmId: 'vm-codex-terminal',
    model: 'gpt-5.4',
    prompt: 'hi',
    baseUrl,
    apiKey: 'key',
    requireCodexTerminal: true,
  })
  const loose = await runVmTestChat({
    projectRoot: root,
    vmId: 'vm-codex-terminal',
    model: 'gpt-5.4',
    prompt: 'hi',
    baseUrl,
    apiKey: 'key',
  })
  assert.equal(strict.ok, false)
  assert.equal(strict.error?.code, 'no_terminal_event')
  assert.equal(loose.ok, true)
})

test('VmTestScheduleRunner passes requireCodexTerminal for preheat only', async () => {
  const values = new Map()
  const settings = {
    get: (k, fb = null) => (values.has(k) ? structuredClone(values.get(k)) : fb),
    set: (k, v) => (values.set(k, structuredClone(v)), v),
    all: () => Object.fromEntries(values),
  }
  const codexVm = { id: 'vm-p', platform: 'openai', family: 'codex' }
  const preheat = {
    enabled: true,
    mode: 'preheat',
    frequency: 'daily',
    time: '09:00',
    timezone: 'UTC',
    model: 'gpt-5.4',
    prompt: 'p',
    reasoning_effort: 'medium',
  }
  const seen = []
  const schedule = new VmTestScheduleRunner({
    projectRoot: '/missing-project',
    settings: () => settings,
    list: () => [codexVm],
    runTest: async (_vmId, params) => {
      seen.push({ preheat: params.requireCodexTerminal === true })
      return { ok: true, duration_ms: 1 }
    },
    windowState: () => ({ hasCredential: true, schedulable: true, windowLive: false }),
  })
  const saved = schedule.save('vm-p', preheat)
  settings.set(`${VM_TEST_SCHEDULE_PREFIX}vm-p`, saved)
  schedule.started = true
  await schedule._run('vm-p')
  schedule.save('vm-p', { ...preheat, mode: 'test' })
  await schedule._run('vm-p')
  assert.deepEqual(seen, [{ preheat: true }, { preheat: false }])
})
