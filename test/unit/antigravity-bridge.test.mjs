import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import {
  antigravityCliEnv,
  antigravityUsageDelta,
  createAntigravitySessionPool,
  startAntigravityBridge,
} from '../../scripts/antigravity-bridge.mjs'
import {
  antigravityBridgePaths,
  callAntigravityBridge,
  closeAntigravityTextSession,
} from '../../src/lib/transport/antigravity-bridge-client.mjs'

function fixture(options = {}, dependencies = {}) {
  const children = []
  const calls = []
  const pool = createAntigravitySessionPool(
    {
      models: ['model-a', 'model-b'],
      workdir: '/slot/workspace',
      timeout_ms: 1000,
      ...options,
    },
    {
      now: dependencies.now,
      spawnImpl: (...args) => {
        calls.push(args)
        const child = new EventEmitter()
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.inputs = []
        child.signals = []
        child.stdin = new Writable({
          write(chunk, _encoding, done) {
            child.inputs.push(JSON.parse(String(chunk)))
            done()
          },
        })
        child.kill = (signal) => {
          child.signals.push(signal)
          return true
        }
        child.emitEvent = (event) => child.stdout.write(JSON.stringify(event) + '\n')
        child.init = (tools = []) =>
          child.emitEvent({
            event: 'init',
            conversation_id: 'conversation-1',
            init: { tools, model: 'model-a', agent: 'vm2api-text' },
          })
        child.delta = (text, step_type = 'agent_response') =>
          child.emitEvent({
            event: 'step_update',
            step_update: { conversation_id: 'conversation-1', step_type, text_delta: text },
          })
        child.result = (response, usage, status = 'SUCCESS') =>
          child.emitEvent({ event: 'result', result: { conversation_id: 'conversation-1', status, response, usage } })
        children.push(child)
        return child
      },
    },
  )
  return {
    pool,
    calls,
    children,
    ask: (extra = {}) => pool.infer({ model: 'model-a', prompt: 'hello', session_id: 'session-1', ...extra }),
  }
}

test('persistent tool-free process sends NDJSON only after init, streams only agent text and computes per-turn usage', async (t) => {
  const f = fixture()
  t.after(() => f.pool.close())
  const texts = []
  const first = f.ask({ onText: (text) => texts.push(text) })
  const child = f.children[0]
  assert.equal(child.inputs.length, 0)
  assert.equal(f.calls[0][2].shell, false)
  assert.deepEqual(f.calls[0][1], [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--model',
    'model-a',
    '--agent',
    'vm2api-text',
    '--sandbox',
  ])
  child.init()
  assert.deepEqual(child.inputs, [{ event: 'user', message: { content: 'hello' } }])
  child.delta('hidden', 'checkpoint')
  const line = Buffer.from(
    JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: '你好' } }) + '\n',
  )
  const split = line.indexOf(Buffer.from('你好')) + 1
  child.stdout.write(line.subarray(0, split))
  child.stdout.write(line.subarray(split))
  child.result('你好', { input_tokens: 10, output_tokens: 2, total_tokens: 12 })
  const a = await first
  assert.equal(a.ok, true)
  assert.deepEqual(texts, ['你好'])
  assert.deepEqual(a.usage, { input_tokens: 10, output_tokens: 2, total_tokens: 12 })
  const second = f.ask({ prompt: 'continue' })
  child.result('two', { input_tokens: 18, output_tokens: 5, total_tokens: 23 })
  const b = await second
  assert.equal(b.response, 'two')
  assert.equal(b.conversation_id, 'conversation-1')
  assert.deepEqual(b.usage, { input_tokens: 8, output_tokens: 3, total_tokens: 11 })
  assert.equal(f.children.length, 1)
  assert.equal(child.inputs.length, 2)
})

test('init with tools or omitted tools fails before prompt is sent', async () => {
  for (const tools of [['run_command'], null]) {
    const f = fixture()
    const pending = f.ask()
    f.children[0].init(tools)
    const result = await pending
    assert.equal(result.code, 'antigravity_tools_not_disabled')
    assert.equal(f.children[0].inputs.length, 0)
    assert.deepEqual(f.children[0].signals, ['SIGTERM'])
    assert.equal(f.pool.size, 0)
    f.pool.close()
  }
})

test('one session cannot overlap or change model; capacity is released by explicit close', async (t) => {
  const f = fixture()
  t.after(() => f.pool.close())
  const pending = f.ask()
  assert.equal((await f.ask()).code, 'antigravity_session_busy')
  assert.equal((await f.ask({ model: 'model-b' })).code, 'antigravity_session_model_mismatch')
  assert.equal((await f.ask({ session_id: 'other-session' })).status, 429)
  f.children[0].init()
  f.children[0].result('done', { input_tokens: 1, output_tokens: 1 })
  await pending
  assert.equal(f.pool.closeSession('session-1'), true)
  assert.equal(f.pool.size, 0)
  assert.equal((await f.ask()).code, 'antigravity_session_closed')
  const next = f.ask({ session_id: 'other-session' })
  f.children[1].init()
  f.children[1].result('new', { input_tokens: 1, output_tokens: 1 })
  assert.equal((await next).ok, true)
})

test('ERROR carries trustworthy cumulative usage but never becomes success', async () => {
  const f = fixture()
  const pending = f.ask()
  f.children[0].init()
  f.children[0].result('', { input_tokens: 12, output_tokens: 3 }, 'ERROR')
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.terminalState, 'rejected')
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 3 })
  assert.equal(f.pool.size, 0)
  f.pool.close()
})

test('unknown or missing usage invalidates the cumulative baseline until another terminal establishes it', async (t) => {
  const f = fixture()
  t.after(() => f.pool.close())
  const first = f.ask()
  const child = f.children[0]
  child.init()
  child.result('one')
  assert.equal((await first).usage, null)
  const second = f.ask()
  child.result('two', { input_tokens: 20, output_tokens: 4 })
  assert.equal((await second).usage, null)
  const third = f.ask()
  child.result('three', { input_tokens: 26, output_tokens: 7 })
  assert.deepEqual((await third).usage, { input_tokens: 6, output_tokens: 3 })
  assert.equal(
    antigravityUsageDelta({ input_tokens: 10, output_tokens: 5 }, { input_tokens: 8, output_tokens: 6 }).usage,
    null,
  )
  assert.equal(antigravityUsageDelta(null, { input_tokens: -1, output_tokens: 2 }).cumulative, null)
})

test('exit, timeout and client cancellation close incomplete sessions and never infer success from usage', async () => {
  const exited = fixture()
  const first = exited.ask()
  exited.children[0].init()
  exited.children[0].delta('partial')
  exited.children[0].emit('close', 0)
  const a = await first
  assert.equal(a.ok, false)
  assert.equal(a.output_committed, true)
  assert.equal(a.terminalState, 'incomplete')
  assert.equal(exited.pool.size, 0)
  exited.pool.close()

  const timed = fixture({ timeout_ms: 100 })
  assert.equal((await timed.ask()).status, 504)
  assert.equal(timed.pool.size, 0)
  timed.pool.close()

  const aborted = fixture()
  const controller = new AbortController()
  const third = aborted.ask({ signal: controller.signal })
  controller.abort()
  assert.equal((await third).status, 499)
  assert.equal(aborted.pool.size, 0)
  aborted.pool.close()
})

test('tool events, malformed NDJSON, conflicting final text and nonterminal statuses fail closed', async () => {
  const cases = [
    (child) => child.delta('command', 'tool'),
    (child) => child.stdout.write('{not-json}\n'),
    (child) => {
      child.delta('one')
      child.result('two', { input_tokens: 1, output_tokens: 1 })
    },
    (child) => child.result('unverified', { input_tokens: 1, output_tokens: 1 }, 'RUNNING'),
  ]
  for (const emit of cases) {
    const f = fixture()
    const pending = f.ask()
    f.children[0].init()
    emit(f.children[0])
    assert.equal((await pending).ok, false)
    assert.equal(f.pool.size, 0)
    f.pool.close()
  }
})

test('idle TTL removes the CLI process and disabled models never spawn', async (t) => {
  let time = 0
  const f = fixture({ models: [{ id: 'model-a', enabled: false }] })
  t.after(() => f.pool.close())
  assert.equal((await f.ask()).code, 'model_not_supported')
  assert.equal(f.calls.length, 0)
  const idle = fixture({ idle_ttl_seconds: 1 }, { now: () => time })
  t.after(() => idle.pool.close())
  const first = idle.ask()
  idle.children[0].init()
  idle.children[0].result('first', { input_tokens: 1, output_tokens: 1 })
  await first
  time = 1001
  assert.equal((await idle.ask()).code, 'antigravity_session_closed')
  const second = idle.ask({ session_id: 'new-session' })
  assert.deepEqual(idle.children[0].signals, ['SIGTERM'])
  assert.equal(idle.children.length, 2)
  idle.children[1].init()
  idle.children[1].result('second', { input_tokens: 1, output_tokens: 1 })
  assert.equal((await second).ok, true)
})

test('CLI inherits no proxy or provider API credentials from the control plane', () => {
  assert.deepEqual(
    antigravityCliEnv({
      HOME: '/slot',
      PATH: '/bin',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      HTTPS_PROXY: 'secret',
      ALL_PROXY: 'secret',
      ANTHROPIC_API_KEY: 'secret',
      OPENAI_API_KEY: 'secret',
      KIN_INTERNAL_TOKEN: 'secret',
    }),
    { HOME: '/slot', PATH: '/slot/.local/bin:/bin', LANG: 'en_US.UTF-8', LC_ALL: 'C' },
  )
})

test('UDS bridge authenticates, bounds bodies, streams UTF8 and closes sessions without spawning on probe', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vm = { id: 'vm-ag' }
  assert.deepEqual(await closeAntigravityTextSession({ projectRoot: root, vm, sessionId: 'absent' }), {
    ok: true,
    closed: false,
  })
  const paths = antigravityBridgePaths(root, vm)
  fs.mkdirSync(paths.runDir, { recursive: true })
  fs.writeFileSync(paths.tokenPath, 'test-secret')
  const f = fixture()
  t.after(() => f.pool.close())
  const bridge = await startAntigravityBridge(
    { socket_path: paths.socketPath, internal_token: 'test-secret' },
    { pool: f.pool },
  )
  t.after(() => bridge.close())
  assert.equal(fs.statSync(paths.socketPath).mode & 0o777, 0o600)
  assert.equal((await callAntigravityBridge({ projectRoot: root, vm })).authenticated, null)
  assert.equal(f.calls.length, 0)
  const text = []
  const pending = callAntigravityBridge({
    projectRoot: root,
    vm,
    requestPath: '/text',
    body: { prompt: '你好', model: 'model-a', session_id: 'session-1' },
    onText: (value) => text.push(value),
  })
  while (!f.children.length) await new Promise((resolve) => setImmediate(resolve))
  f.children[0].init()
  assert.equal(f.children[0].inputs[0].message.content, '你好')
  f.children[0].delta('世界')
  f.children[0].result('世界', { input_tokens: 2, output_tokens: 2 })
  assert.equal((await pending).response, '世界')
  assert.deepEqual(text, ['世界'])
  assert.equal((await closeAntigravityTextSession({ projectRoot: root, vm, sessionId: 'session-1' })).closed, true)
  fs.writeFileSync(paths.tokenPath, 'wrong-secret')
  assert.equal((await callAntigravityBridge({ projectRoot: root, vm })).status, 401)
  fs.writeFileSync(paths.tokenPath, 'test-secret')
  const large = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: paths.socketPath,
        agent: false,
        method: 'POST',
        path: '/text',
        headers: { authorization: 'Bearer test-secret' },
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      },
    )
    req.on('error', reject)
    req.end(JSON.stringify({ prompt: 'x'.repeat(140 * 1024) }))
  })
  assert.equal(large, 413)
})
