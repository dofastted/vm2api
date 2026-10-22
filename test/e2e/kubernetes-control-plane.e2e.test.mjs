import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import { startGateway, api } from '../harness.mjs'

const mode = { VM2API_CONTROL_PLANE_MODE: 'kubernetes', KIN_BACKUP_DISABLED: '1' }

function exitOf(child) {
  if (child.exitCode != null) return Promise.resolve(child.exitCode)
  return new Promise((resolve) => child.once('exit', resolve))
}

async function slowMessages(gw) {
  const payload = Buffer.from(
    JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8,
      stream: true,
      messages: [{ role: 'user', content: 'finish the accepted request during shutdown' }],
    }),
  )
  let request
  const response = new Promise((resolve, reject) => {
    request = http.request(
      `${gw.baseUrl}/v1/messages`,
      {
        method: 'POST',
        agent: false,
        headers: {
          authorization: `Bearer ${gw.apiKey}`,
          'content-type': 'application/json',
          'content-length': payload.length,
        },
      },
      (res) => {
        let text = ''
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode, text }))
        res.on('error', reject)
      },
    )
    request.on('error', reject)
  })
  response.catch(() => {})
  request.flushHeaders()
  const split = Math.floor(payload.length / 2)
  request.write(payload.subarray(0, split))
  await new Promise((resolve) => setTimeout(resolve, 100))
  return { request, response, finish: () => request.end(payload.subarray(split)) }
}

test('Kubernetes control-plane lock rejects a second process before initialization and releases on exit', async () => {
  const first = await startGateway({ env: mode })
  const project = first.project
  let unexpectedSecond
  try {
    assert.equal((await fetch(`${first.baseUrl}/readyz`)).status, 200)
    await assert.rejects(async () => {
      unexpectedSecond = await startGateway({ project, env: mode })
    }, /control.plane.*(?:already|held|active|in.use)/i)
    assert.equal((await fetch(`${first.baseUrl}/readyz`)).status, 200)
  } finally {
    await unexpectedSecond?.stop()
    await first.stop()
  }
  const replacement = await startGateway({ project, env: mode })
  try {
    assert.equal((await fetch(`${replacement.baseUrl}/readyz`)).status, 200)
  } finally {
    await replacement.stop()
  }
})

test('Kubernetes panel sessions survive process replacement and logout revokes the stored token', async () => {
  let gw = await startGateway({ env: mode })
  const project = gw.project
  let cookie
  try {
    const login = await fetch(`${gw.baseUrl}/api/panel/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'testpass' }),
    })
    assert.equal(login.status, 200)
    cookie = login.headers.get('set-cookie').split(';')[0]
    assert.equal((await fetch(`${gw.baseUrl}/api/panel/me`, { headers: { cookie } })).status, 200)
    const token = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1))
    const stored = await gw.db.prepare('SELECT token_hash FROM panel_sessions WHERE username=$1').all('admin')
    assert.deepEqual(
      stored.map((row) => row.token_hash),
      [crypto.createHash('sha256').update(token).digest('hex')],
    )
  } finally {
    await gw.stop()
  }
  gw = await startGateway({ project, env: mode })
  try {
    assert.equal((await fetch(`${gw.baseUrl}/api/panel/me`, { headers: { cookie } })).status, 200)
    assert.equal((await fetch(`${gw.baseUrl}/api/panel/logout`, { method: 'POST', headers: { cookie } })).status, 200)
    assert.equal((await fetch(`${gw.baseUrl}/api/panel/me`, { headers: { cookie } })).status, 401)
  } finally {
    await gw.stop()
  }
})

test('readiness rejects backup maintenance while liveness and accepted SSE requests continue', async () => {
  const gw = await startGateway({ env: mode })
  let slow
  let backup
  try {
    slow = await slowMessages(gw)
    backup = api(gw, 'POST', '/api/panel/backups')
    const deadline = Date.now() + 3000
    let ready
    do {
      ready = await fetch(`${gw.baseUrl}/readyz`)
      if (ready.status === 503) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    } while (Date.now() < deadline)
    assert.equal(ready.status, 503)
    assert.equal((await fetch(`${gw.baseUrl}/healthz`)).status, 200)
    slow.finish()
    const streamed = await slow.response
    assert.equal(streamed.status, 200)
    assert.match(streamed.text, /message_stop/)
    assert.equal((await backup).status, 201)
    assert.equal((await fetch(`${gw.baseUrl}/readyz`)).status, 200)
  } finally {
    slow?.request.destroy()
    await backup?.catch(() => {})
    await gw.stop()
  }
})

test('SIGTERM waits for an accepted request to finish streaming and persist its log', async () => {
  const gw = await startGateway({ env: mode })
  let slow
  try {
    slow = await slowMessages(gw)
    const exit = exitOf(gw.child)
    gw.child.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 75))
    assert.equal(gw.child.exitCode, null)
    slow.finish()
    const streamed = await slow.response
    assert.equal(streamed.status, 200)
    assert.match(streamed.text, /message_stop/)
    assert.equal(await exit, 0)
    assert.equal((await gw.db.prepare('SELECT count(*) AS n FROM usage_logs WHERE status=200').get()).n, 1)
  } finally {
    slow?.request.destroy()
    await gw.stop()
  }
})

test('shutdown deadline interrupts an unfinished request and exits unsuccessfully', async () => {
  const gw = await startGateway({ env: { ...mode, VM2API_SHUTDOWN_TIMEOUT_MS: '300' } })
  let slow
  try {
    slow = await slowMessages(gw)
    const exit = exitOf(gw.child)
    const started = Date.now()
    gw.child.kill('SIGTERM')
    let timeout
    try {
      await Promise.race([
        (async () => {
          await assert.rejects(slow.response)
          assert.equal(await exit, 1)
        })(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('shutdown deadline was not enforced')), 6000)
        }),
      ])
    } finally {
      clearTimeout(timeout)
    }
    assert.ok(Date.now() - started < 6000, 'shutdown must have a bounded deadline')
  } finally {
    slow?.request.destroy()
    await gw.stop()
  }
})
