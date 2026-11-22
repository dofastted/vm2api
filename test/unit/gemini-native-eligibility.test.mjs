import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { callGeminiHost, createGeminiPublicHandler } from '../../src/lib/gemini/routes.mjs'
import { createGeminiScheduler } from '../../src/lib/gemini/scheduler.mjs'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'

test('per-run CLI eligibility survives native failure, host transport and public HTTP', {
  timeout: 20_000,
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gemini-log-test-'))
  const previous = process.env.KIN_GEMINI_HOST_SOCKET
  process.env.KIN_GEMINI_HOST_SOCKET = path.join(directory, 'host.sock')
  const child = spawn(
    'python3',
    ['-B', new URL('./gemini-native-eligibility-fixture.py', import.meta.url).pathname, directory],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let diagnostics = ''
  child.stderr.on('data', (chunk) => {
    diagnostics += chunk.toString().slice(0, 4096 - diagnostics.length)
  })
  const exit = once(child, 'exit')
  const pool = new PoolScheduler()
  let clock = 1000
  pool.unitCircuit.now = () => clock
  pool.unitCircuit.configure({ failureThreshold: 1, openMs: 1000 })
  const accountId = 'gemini:gemini-log-fixture'
  pool.unitCircuit.recordFailure(accountId)
  clock = 2001
  const scheduler = createGeminiScheduler({
    callHost: callGeminiHost,
    resolveProxy: () => 'socks5h://192.0.2.1:1080',
    poolScheduler: pool,
  })
  const handler = createGeminiPublicHandler({
    scheduler,
    json: (res, status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    },
    readBody: async (req) => {
      let raw = ''
      for await (const chunk of req) raw += chunk
      return JSON.parse(raw)
    },
  })
  const server = http.createServer((req, res) => {
    req.apiKeyKind = 'managed'
    req.apiKeyRecord = { group_type: 'gemini' }
    Promise.resolve(handler(req, res)).catch((error) => {
      res.writeHead(500)
      res.end()
      diagnostics += error.name
    })
  })
  try {
    await Promise.race([
      once(child.stdout, 'data').then(([bytes]) => assert.equal(bytes.toString(), 'ready\n')),
      exit.then(() => {
        throw new Error(`fixture exited: ${diagnostics}`)
      }),
    ])
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-test', messages: [{ role: 'user', content: 'hello' }] }),
      signal: AbortSignal.timeout(10_000),
    })
    const body = await response.json()
    assert.equal(response.status, 403, diagnostics)
    assert.equal(body.error.code, 'gemini_location_unsupported')
    assert.doesNotMatch(
      JSON.stringify(body),
      /fixture-secret|fixture-private-prompt|server_oauth|not eligible for Antigravity/,
    )
    assert.deepEqual(pool.unitCircuit.inspect(accountId), { ok: true, state: 'half_open', probeAvailable: true })
    assert.equal(pool.inflight.size, 0)
  } finally {
    server.closeAllConnections()
    if (server.listening) await new Promise((resolve) => server.close(resolve))
    child.kill('SIGTERM')
    const kill = setTimeout(() => child.kill('SIGKILL'), 5000)
    await exit.finally(() => clearTimeout(kill))
    if (previous === undefined) delete process.env.KIN_GEMINI_HOST_SOCKET
    else process.env.KIN_GEMINI_HOST_SOCKET = previous
    await rm(directory, { recursive: true, force: true })
  }
})
